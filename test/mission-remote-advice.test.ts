/**
 * Mission Advisory with a simulated Meta: only for a reproducible blocker,
 * counted on that blocker, never a recovery by itself, bounded, safe across
 * failures, cancellations, and reloads. Authority comes back only when the
 * host's run of the original verifier passes.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { MAX_AGENT_STEPS } from '../src/agentPolicy.js';
import { consultForMission } from '../src/missionAdvice.js';
import { defaultAdvisoryLimits } from '../src/missionAdvisoryLimits.js';
import { MISSION_STATE_KEY, MissionStore, type MissionRecord } from '../src/missionStore.js';
import { markUnrecoverable, updateVerifiers } from '../src/missionVerifiers.js';
import type { ProviderHost } from '../src/providerTypes.js';
import type { MissionLiveView } from '../src/viewMessages.js';
import { assistantText, fakeCloud, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const API_KEY_SECRET = 'rameCode.metaModelApiKey';
const KEY = 'fake-meta-key-MISSION-91c2';
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const ADVICE = { diagnosis: 'a.txt must say final.', steps: ['Write final into a.txt.'], checks: ['npm:check passes.'] };
const advice = () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(ADVICE) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });
const metaError = (status: number, message: string) => Response.json({ error: { message } }, { status });
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const text = (body: string) => ({ kind: 'json' as const, body: assistantText(body) });
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;
const notesOf = (h: HostHarness): string => stored(h).evidence.map((entry) => entry.text).join('\n');
const liveOf = (state: PostedState): MissionLiveView | null => (state.missionLive as MissionLiveView | null) ?? null;

async function withMission(body: (h: HostHarness, mission: MissionRecord) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission', allowCloudEscalation: true });
  h.secretValues.set(API_KEY_SECRET, KEY);
  fakeCloud.requests.length = 0;
  fakeCloud.handler = null;
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { test: 'node t.js', check: 'node c.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await h.writeFile('c.js', "process.exit(require('node:fs').existsSync('a.txt') && require('node:fs').readFileSync('a.txt', 'utf8') === 'final' ? 0 : 1);\n");
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: { goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'Fix a.txt', successCriterion: 'npm:check passes' }], risks: [] } }]) });
    await h.provider.sendMessage('Make npm:check pass.', 'mission', 'local');
    h.model.requests.length = 0;
    await body(h, stored(h));
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

/** One internal run that hits the blocker and stops for capability. */
function stuckRun(h: HostHarness, run: number): void {
  h.model.enqueue(tool(`c${run}`, 'run_tests', { commandId: 'npm:check' }));
  for (let step = 1; step < MAX_AGENT_STEPS; step++) {
    h.model.enqueue(tool(`r${run}-${step}`, 'read_file', { path: 'c.js', maxBytes: 4096 }));
  }
}

test('a failed Mission consultation keeps the blocker, recovers nothing, counts the attempt but no valid answer, and Glimmer continues safely', async () => {
  await withMission(async (h, mission) => {
    fakeCloud.handler = () => metaError(402, `payment required for key ${KEY}`);
    stuckRun(h, 1);
    // Run 2: the local agent fixes the cause and runs the original verifier itself.
    h.model.enqueue(tool('w', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: sha(''), newContent: 'final' }] }), tool('c2', 'run_tests', { commandId: 'npm:check' }), text('Done.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 2 }, true);
    const record = stored(h);
    assert.equal(record.status, 'completed', record.note);
    assert.equal(fakeCloud.requests.length, 1, 'one attempt, no automatic retry');
    assert.equal(record.grant?.escalation?.used, 1, 'the attempt was sent, so it counts');
    assert.equal(record.grant?.escalation?.validResponses, 0, 'a failure is never a valid answer');
    const notes = notesOf(h);
    assert.match(notes, /remote advice for npm:check \[blk_[0-9a-f]{16}\]: attempt 1\/2 failed: credit, balance, or quota exhausted \(HTTP 402\): .*no advice used, not retried, and the blocker is unchanged/);
    // The failure did not recover it: the host's own passing run of npm:check did, later.
    const failedAt = notes.indexOf('attempt 1/2 failed');
    const recoveredAt = notes.indexOf('verifier npm:check recovered in internal run 2');
    assert.ok(failedAt > 0 && recoveredAt > failedAt);
    assert.equal(notes.includes(KEY), false, 'the key never reaches the evidence');
    assert.equal(JSON.stringify(h.memento.get(MISSION_STATE_KEY)).includes(KEY), false);
  });
});

test('Meta failing on every attempt: the budget bounds the attempts, no loop, and the Mission ends blocked without progress', async () => {
  await withMission(async (h, mission) => {
    fakeCloud.handler = () => metaError(429, 'Too many requests');
    for (let run = 1; run <= 8; run++) {
      stuckRun(h, run);
    }
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 2 }, true);
    const record = stored(h);
    assert.equal(record.status, 'blocked', record.note);
    assert.equal(fakeCloud.requests.length, 2, 'never more than the 2 authorized attempts');
    assert.equal(record.grant?.escalation?.used, 2);
    assert.equal(record.grant?.escalation?.validResponses, 0);
    assert.equal(record.auto?.blockers[0]?.advisoryAttempts, 2);
    assert.equal(record.auto?.blockers[0]?.state, 'open');
    assert.equal((record.auto?.recoveries ?? []).length, 0, 'no false recovery');
  });
});

test('no consultation without a reproducible blocker: nothing is sent and nothing is counted', async () => {
  await withMission(async (h, mission) => {
    fakeCloud.handler = advice;
    for (let i = 0; i < MAX_AGENT_STEPS * 4; i++) {
      h.model.enqueue(tool(`r${i}`, 'read_file', { path: 'c.js', maxBytes: 4096 }));
    }
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 2 }, true);
    assert.equal(fakeCloud.requests.length, 0);
    assert.equal(stored(h).grant?.escalation?.used, 0);
    assert.match(notesOf(h), /remote advice not requested: no failing allowed test \(blocking verifier\) justifies a consultation/);
  });
});

test('after advice, authority stays restricted: another passing test does not recover it; the original verifier, run by the host, does', async () => {
  await withMission(async (h, mission) => {
    fakeCloud.handler = advice;
    stuckRun(h, 1);
    // Run 2: npm:test passes but nothing was fixed: the host's own re-run of npm:check still fails.
    h.model.enqueue(tool('t2', 'run_tests', { commandId: 'npm:test' }), text('Done.'));
    // Run 3: the real fix; the host re-runs npm:check itself and it passes.
    h.model.enqueue(tool('w3', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: sha(''), newContent: 'final' }] }), tool('t3', 'run_tests', { commandId: 'npm:test' }), text('Done.'));
    const states: Array<MissionLiveView['remote']> = [];
    const watch = setInterval(() => {
      const live = liveOf(h.last());
      if (live?.remote) {
        states.push(live.remote);
      }
    }, 5);
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 1 }, true);
    clearInterval(watch);
    const record = stored(h);
    assert.equal(record.status, 'completed', record.note);
    assert.equal(record.auto?.runs, 3, 'run 2 was not accepted on npm:test alone');
    const notes = notesOf(h);
    assert.match(notes, /remote advice for npm:check \[blk_[0-9a-f]{16}\]: attempt 1\/1, a valid answer from Meta muse-spark-1\.3/);
    assert.match(notes, /• run_tests npm:check → exit=1 \(re-run by the host: blocking verifier\)/);
    assert.match(notes, /verifier npm:check recovered in internal run 3 \(re-run by the host\) \[blk_/);
    assert.equal(record.grant?.escalation?.validResponses, 1);
    assert.equal(record.auto?.recoveries[0]?.blockerId, record.evidence.find((entry) => /attempt 1\/1/.test(entry.text))?.text.match(/\[(blk_[0-9a-f]{16})\]/)?.[1]);
    // The causal state: restricted after the advice, normal once the original verifier passed.
    assert.ok(states.some((remote) => remote?.causalState === 'restricted' && remote.blocker?.commandId === 'npm:check'), 'restricted after the advice');
    const final = liveOf(h.last())?.remote;
    assert.equal(final?.causalState, 'normal');
    assert.equal(final?.validResponses, 1);
  });
});

test('a blocking verifier that can no longer run is shown as unrecoverable and blocks the Mission', async () => {
  await withMission(async (h, mission) => {
    const pkg = await h.readFile('package.json');
    h.model.enqueue(
      tool('c1', 'run_tests', { commandId: 'npm:check' }),
      tool('p1', 'apply_patch', { files: [{ path: 'package.json', expectedHash: sha(pkg), newContent: JSON.stringify({ name: 'm', private: true, scripts: { test: 'node t.js' } }) }] }),
      text('Done.'),
    );
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const record = stored(h);
    assert.equal(record.status, 'blocked');
    assert.match(record.note, /verifier npm:check \[blk_[0-9a-f]{16}\] can no longer run \(npm:check is no longer an allowed test of this project\): its recovery is blocked/);
    assert.equal(record.auto?.blockers[0]?.state, 'unrecoverable');
    assert.equal(liveOf(h.last())?.remote?.causalState, 'unrecoverable');
  });
  // Pure: a marked blocker never recovers, even if the command passes again.
  const opened = updateVerifiers([], [], [{ commandId: 'npm:check', exitCode: 1, afterLastWrite: true }], 'c', 1, 'agent').blockers;
  assert.match(markUnrecoverable(opened, ['npm:test'])[0] as string, /can no longer run/);
  assert.equal(updateVerifiers(opened, [], [{ commandId: 'npm:check', exitCode: 0, afterLastWrite: true }], 'c', 2, 'host').blockers.length, 1);
});

test('a reload during a consultation keeps the attempt counted, no answer, the blocker open, and never resends by itself', async () => {
  await withMission(async (h, mission) => {
    fakeCloud.handler = () => new Promise<Response>(() => {}) as unknown as Response;
    stuckRun(h, 1);
    const before = h.provider;
    const run = before.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 2 }, true);
    await h.waitFor(() => fakeCloud.requests.length === 1, 20000);
    before.dispose();
    await run;
    h.createProvider();
    h.send({ type: 'navigate', screen: 'settings' });
    await h.waitFor(() => stored(h).status === 'interrupted', 10000);
    const record = stored(h);
    assert.equal(record.grant?.escalation?.used, 1, 'the attempt was sent before the reload');
    assert.equal(record.grant?.escalation?.validResponses, 0);
    assert.equal(record.auto?.blockers[0]?.state, 'open');
    assert.equal(record.auto?.pendingAdvice, '', 'no advice is invented');
    assert.equal(fakeCloud.requests.length, 1, 'nothing was resent');
  });
});

test('a Mission internal run is never offered for delegated execution', async () => {
  await withMission(async (h, mission) => {
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 2 }, true);
    assert.equal(h.last().escalation.pending, false);
    assert.equal((h.last().remote as { delegation: unknown }).delegation, null);
    assert.equal(h.provider.localIssue?.delegation, 'internal', 'a Mission run never shows a delegated run, not even disabled');
    assert.equal(fakeCloud.requests.length, 0);
  });
});

test('cancelled before sending is not counted; cancelled after sending is', async () => {
  const memory = new Map<string, unknown>();
  const missions = new MissionStore({ get: (key) => memory.get(key), update: async (key, value) => void memory.set(key, JSON.parse(JSON.stringify(value))) });
  const created = await missions.create({ scopeId: 'ws_1', scopeLabel: 'p', threadId: 't1', goal: 'G', steps: [{ id: 't1', title: 'T', successCriterion: 'npm:check' }], decisions: [] });
  assert.ok(created.ok);
  const id = created.value.id;
  const seeded = await missions.update(id, created.value.revision, (draft) => {
    draft.grant = { missionId: id, scopeId: 'ws_1', provider: 'local', model: 'local-glimmer', mode: 'supervised', grantedAt: 1, escalation: { model: 'muse-spark-1.3', maxConsultations: 2, ...defaultAdvisoryLimits(2), used: 0, validResponses: 0, dataClasses: [], sentBytes: 0, usedTokens: 0 }, tests: null, acceptance: null };
    draft.auto = { runs: 1, startedAt: 1, noProgressStreak: 0, lastSignature: '', lastProgress: '', needsVerification: true, pendingAdvice: '', acceptanceFeedback: '', lastRunNotes: '', userGuidance: '', blockers: updateVerifiers([], [], [{ commandId: 'npm:check', exitCode: 1, afterLastWrite: true }], 'c', 1, 'agent', id).blockers, recoveries: [] };
    return { ok: true, value: draft };
  });
  assert.ok(seeded.ok);
  let start: (work: (context: { signal: AbortSignal }) => Promise<unknown>) => Promise<unknown> = async () => {
    throw new DOMException('Aborted', 'AbortError');
  };
  const host = {
    missions,
    settings: { allowCloudEscalation: true },
    missionAuto: null,
    getApiKey: async () => KEY,
    memory: { listCurrentDecisions: () => [] },
    chatRunner: { start: (work: (context: { signal: AbortSignal }) => Promise<unknown>) => start(work) },
    recordUsage: () => {},
    updateActiveMission: async (change: (mission: MissionRecord) => { ok: boolean }) => {
      const current = missions.get(id) as MissionRecord;
      return (await missions.update(id, current.revision, change as never)).ok;
    },
  } as unknown as ProviderHost;
  // Cancelled before anything was sent.
  await consultForMission(host, id, 'stuck', [], 'ws_1');
  assert.equal(missions.get(id)?.grant?.escalation?.used, 0);
  assert.equal(missions.get(id)?.auto?.blockers[0]?.advisoryAttempts, 0);
  assert.match(missions.get(id)?.evidence.at(-1)?.text ?? '', /cancelled before sending; not counted/);
  // Cancelled after it was sent.
  fakeCloud.requests.length = 0;
  fakeCloud.handler = () => {
    throw new DOMException('Aborted', 'AbortError');
  };
  start = (work) => work({ signal: new AbortController().signal });
  await consultForMission(host, id, 'stuck', [], 'ws_1');
  fakeCloud.handler = null;
  assert.equal(fakeCloud.requests.length, 1);
  assert.equal(missions.get(id)?.grant?.escalation?.used, 1);
  assert.equal(missions.get(id)?.auto?.blockers[0]?.advisoryAttempts, 1);
  assert.match(missions.get(id)?.evidence.at(-1)?.text ?? '', /attempt 1\/2 failed: cancelled/);
});
