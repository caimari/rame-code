/**
 * The limits of a Mission's Advisory grant, with a simulated Meta only:
 * fixed at authorization, checked before anything is sent, never raised,
 * shown with what is used and what remains, and kept across a reload.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { MAX_AGENT_STEPS } from '../src/agentPolicy.js';
import { buildViewHtml } from '../src/viewHtml.js';
import { consultForMission } from '../src/missionAdvice.js';
import {
  checkAdvisoryLimits,
  chooseAdvisoryLimits,
  defaultAdvisoryLimits,
  refuseOverLimit,
  storedAdvisoryLimits,
  type AdvisoryLimits,
} from '../src/missionAdvisoryLimits.js';
import { missionRemoteView } from '../src/missionRemote.js';
import { MISSION_STATE_KEY, MissionStore, type MissionRecord } from '../src/missionStore.js';
import { updateVerifiers } from '../src/missionVerifiers.js';
import type { ProviderHost } from '../src/providerTypes.js';
import { parseViewInboundMessage, type MissionLiveView } from '../src/viewMessages.js';
import { assistantText, fakeCloud, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const API_KEY_SECRET = 'rameCode.metaModelApiKey';
const KEY = 'fake-meta-key-LIMITS-3e7a';
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const ADVICE = { diagnosis: 'a.txt must say final.', steps: ['Write final into a.txt.'], checks: ['npm:check passes.'] };
const advice = () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(ADVICE) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const text = (body: string) => ({ kind: 'json' as const, body: assistantText(body) });
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;
const notesOf = (h: HostHarness): string => stored(h).evidence.map((entry) => entry.text).join('\n');
const liveOf = (state: PostedState): MissionLiveView | null => (state.missionLive as MissionLiveView | null) ?? null;
const bodyBytes = (body: Record<string, unknown>): number => Buffer.byteLength(JSON.stringify(body), 'utf8');

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

/** Run 1 is stuck and consults; run 2 fixes the cause and the host's verifier passes. */
function stuckThenFixed(h: HostHarness): void {
  stuckRun(h, 1);
  h.model.enqueue(tool('w', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: sha(''), newContent: 'final' }] }), tool('c2', 'run_tests', { commandId: 'npm:check' }), text('Done.'));
}

test('limits: defaults per consultation, ranges, coherence, and back-compatible stored grants', () => {
  assert.deepEqual(defaultAdvisoryLimits(3), { maxRequestBytes: 12000, maxTotalBytes: 36000, maxOutputTokens: 2048, maxTotalTokens: 42144 });
  assert.equal(checkAdvisoryLimits(defaultAdvisoryLimits(5)), null);
  assert.deepEqual(chooseAdvisoryLimits(2, { maxRequestBytes: 5000, maxTotalBytes: null, maxOutputTokens: 512, maxTotalTokens: null }), { ...defaultAdvisoryLimits(2), maxRequestBytes: 5000, maxOutputTokens: 512 });
  for (const bad of [
    { maxRequestBytes: 999 },
    { maxRequestBytes: 24001 },
    { maxOutputTokens: 9000 },
    { maxTotalTokens: 500 },
    { maxRequestBytes: 20000, maxTotalBytes: 10000 },
    { maxOutputTokens: 4096, maxTotalTokens: 2000 },
    { maxTotalBytes: 1.5 },
  ] as Array<Partial<AdvisoryLimits>>) {
    assert.notEqual(checkAdvisoryLimits({ ...defaultAdvisoryLimits(1), ...bad }), null, JSON.stringify(bad));
  }
  // A grant stored before these limits existed keeps its output cap and gets the defaults.
  assert.deepEqual(storedAdvisoryLimits({ maxOutputTokens: 2048 }, 2), defaultAdvisoryLimits(2));
  assert.equal(storedAdvisoryLimits({ maxOutputTokens: 2048, maxTotalBytes: -1 }, 2), null);
});

test('each limit refuses before sending, with the limit it would exceed', () => {
  const limits: AdvisoryLimits = { maxRequestBytes: 8000, maxTotalBytes: 12000, maxOutputTokens: 1000, maxTotalTokens: 20000 };
  const usage = { maxConsultations: 3, used: 1, sentBytes: 5000, usedTokens: 6000 };
  assert.equal(refuseOverLimit(limits, usage, 7000), null);
  assert.match(refuseOverLimit(limits, { ...usage, used: 3 }, 100) ?? '', /consultation limit \(3\/3\) is reached/);
  assert.match(refuseOverLimit(limits, usage, 8001) ?? '', /the request is 8001 bytes and the limit per request is 8000/);
  assert.match(refuseOverLimit(limits, usage, 7001) ?? '', /would bring the total sent to 12001 of 12000 bytes/);
  assert.match(refuseOverLimit(limits, { ...usage, usedTokens: 12001 }, 7000) ?? '', /could use up to 8000 tokens and only 7999 of the 20000-token remote budget remain/);
  assert.equal(refuseOverLimit(limits, { ...usage, usedTokens: 12000 }, 7000), null, '12000 + 7000 + 1000 is exactly the budget');
});

test('a request over the per-request limit is not sent, not counted, and the limit is not raised', async () => {
  await withMission(async (h, mission) => {
    fakeCloud.handler = advice;
    stuckThenFixed(h);
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 2, limits: { maxRequestBytes: 1000, maxTotalBytes: null, maxOutputTokens: null, maxTotalTokens: null } }, true);
    const record = stored(h);
    assert.equal(record.status, 'completed', record.note);
    assert.equal(fakeCloud.requests.length, 0, 'nothing reached Meta');
    const escalation = record.grant?.escalation;
    assert.equal(escalation?.used, 0);
    assert.equal(escalation?.sentBytes, 0);
    assert.equal(escalation?.usedTokens, 0);
    assert.equal(escalation?.maxRequestBytes, 1000, 'the limit stays as the user set it');
    assert.equal(record.auto?.blockers[0]?.advisoryAttempts ?? 0, 0);
    assert.match(notesOf(h), /remote advice for npm:check \[blk_[0-9a-f]{16}\]: not sent, because the request is \d+ bytes and the limit per request is 1000; not counted, and the limit is not raised/);
  });
});

test('a sent request counts its exact bytes, and the reported tokens replace the upper bound', async () => {
  await withMission(async (h, mission) => {
    fakeCloud.handler = advice;
    stuckThenFixed(h);
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 2, limits: { maxRequestBytes: 20000, maxTotalBytes: 30000, maxOutputTokens: 1024, maxTotalTokens: 50000 } }, true);
    const record = stored(h);
    assert.equal(record.status, 'completed', record.note);
    assert.equal(fakeCloud.requests.length, 1);
    const sent = bodyBytes(fakeCloud.requests[0].body);
    assert.equal(fakeCloud.requests[0].body.max_completion_tokens, 1024, 'the output cap is what was sent');
    assert.deepEqual(
      { used: record.grant?.escalation?.used, validResponses: record.grant?.escalation?.validResponses, sentBytes: record.grant?.escalation?.sentBytes, usedTokens: record.grant?.escalation?.usedTokens },
      { used: 1, validResponses: 1, sentBytes: sent, usedTokens: 50 },
    );
    // The card shows the limits with what is used.
    assert.deepEqual(missionRemoteView(record)?.limits, { maxRequestBytes: 20000, maxTotalBytes: 30000, sentBytes: sent, maxOutputTokens: 1024, maxTotalTokens: 50000, usedTokens: 50 });
  });
});

test('the total limits refuse a request before sending; a budget already used up stays used up', async () => {
  const memory = new Map<string, unknown>();
  const missions = new MissionStore({ get: (key) => memory.get(key), update: async (key, value) => void memory.set(key, JSON.parse(JSON.stringify(value))) });
  const created = await missions.create({ scopeId: 'ws_1', scopeLabel: 'p', threadId: 't1', goal: 'G', steps: [{ id: 't1', title: 'T', successCriterion: 'npm:check' }], decisions: [] });
  assert.ok(created.ok);
  const id = created.value.id;
  const seed = async (sentBytes: number, usedTokens: number) => {
    const current = missions.get(id) as MissionRecord;
    const seeded = await missions.update(id, current.revision, (draft) => {
      draft.grant = { missionId: id, scopeId: 'ws_1', provider: 'local', model: 'local-glimmer', mode: 'supervised', grantedAt: 1, escalation: { model: 'muse-spark-1.3', maxConsultations: 3, ...defaultAdvisoryLimits(3), used: 1, validResponses: 1, dataClasses: [], sentBytes, usedTokens }, tests: null, acceptance: null };
      draft.auto = { runs: 1, startedAt: 1, noProgressStreak: 0, lastSignature: '', lastProgress: '', needsVerification: true, pendingAdvice: '', acceptanceFeedback: '', lastRunNotes: '', userGuidance: '', blockers: updateVerifiers([], [], [{ commandId: 'npm:check', exitCode: 1, afterLastWrite: true }], 'c', 1, 'agent', id).blockers, recoveries: [] };
      return { ok: true, value: draft };
    });
    assert.ok(seeded.ok);
  };
  const host = {
    missions,
    settings: { allowCloudEscalation: true },
    missionAuto: null,
    getApiKey: async () => KEY,
    memory: { listCurrentDecisions: () => [] },
    chatRunner: { start: (work: (context: { signal: AbortSignal }) => Promise<unknown>) => work({ signal: new AbortController().signal }) },
    recordUsage: () => {},
    updateActiveMission: async (change: (mission: MissionRecord) => { ok: boolean }) => {
      const current = missions.get(id) as MissionRecord;
      return (await missions.update(id, current.revision, change as never)).ok;
    },
  } as unknown as ProviderHost;
  fakeCloud.requests.length = 0;
  fakeCloud.handler = advice;
  try {
    // Total bytes: 35,990 of 36,000 already sent.
    await seed(35990, 0);
    await consultForMission(host, id, 'stuck', [], 'ws_1');
    assert.match(missions.get(id)?.evidence.at(-1)?.text ?? '', /not sent, because the request \(\d+ bytes\) would bring the total sent to \d+ of 36000 bytes; not counted, and the limit is not raised/);
    // Remote budget: only 100 tokens of 42,144 remain.
    await seed(0, 42044);
    await consultForMission(host, id, 'stuck', [], 'ws_1');
    assert.match(missions.get(id)?.evidence.at(-1)?.text ?? '', /not sent, because the request could use up to \d+ tokens and only 100 of the 42144-token remote budget remain/);
    assert.equal(fakeCloud.requests.length, 0, 'nothing was sent');
    const escalation = missions.get(id)?.grant?.escalation;
    assert.deepEqual({ used: escalation?.used, maxTotalBytes: escalation?.maxTotalBytes, maxTotalTokens: escalation?.maxTotalTokens, usedTokens: escalation?.usedTokens }, { used: 1, maxTotalBytes: 36000, maxTotalTokens: 42144, usedTokens: 42044 });
  } finally {
    fakeCloud.handler = null;
  }
});

test('a limit out of range authorizes nothing; malformed limits are refused at the message boundary', async () => {
  await withMission(async (h, mission) => {
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 2, limits: { maxRequestBytes: 30000, maxTotalBytes: null, maxOutputTokens: null, maxTotalTokens: null } }, true);
    assert.equal(stored(h).grant, null);
    assert.equal(fakeCloud.requests.length, 0);
  });
  const base = { type: 'missionStart', missionId: `mis_${'a'.repeat(24)}`, revision: 1, mode: 'supervised', maxConsultations: 1, trustedProject: false, acceptanceCommand: '', acceptanceFiles: [] };
  assert.equal(parseViewInboundMessage(base).type, 'missionStart');
  const limits = { maxRequestBytes: 5000, maxTotalBytes: null, maxOutputTokens: 512, maxTotalTokens: null };
  assert.deepEqual((parseViewInboundMessage({ ...base, advisoryLimits: limits }) as { advisoryLimits?: unknown }).advisoryLimits, limits);
  for (const bad of [{ maxRequestBytes: 5000 }, { ...limits, extra: 1 }, { ...limits, maxRequestBytes: '5000' }, { ...limits, maxOutputTokens: 1.5 }, [1, 2]]) {
    assert.throws(() => parseViewInboundMessage({ ...base, advisoryLimits: bad }), JSON.stringify(bad));
  }
  assert.throws(() => parseViewInboundMessage({ ...base, unknownKey: true }));
});

test('after a reload, the authorized grant and usage are unchanged; an eligible new Mission visibly defaults to one consultation', async () => {
  await withMission(async (h, mission) => {
    fakeCloud.handler = advice;
    stuckThenFixed(h);
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 2, limits: { maxRequestBytes: 20000, maxTotalBytes: 30000, maxOutputTokens: 1024, maxTotalTokens: 50000 } }, true);
    const before = stored(h);
    assert.equal(before.grant?.escalation?.validResponses, 1);
    h.provider.dispose();
    h.createProvider();
    h.send({ type: 'openThread', threadId: before.threadId });
    const state = await h.waitFor((posted) => liveOf(posted)?.remote?.limits !== null && liveOf(posted)?.remote?.limits !== undefined, 10000);
    const after = stored(h);
    assert.deepEqual(after.grant, before.grant, 'the grant is exactly the one authorized');
    const remote = liveOf(state)?.remote;
    assert.deepEqual(
      { attempts: remote?.attempts, max: remote?.maxConsultations, valid: remote?.validResponses, limits: remote?.limits },
      { attempts: 1, max: 2, valid: 1, limits: missionRemoteView(before)?.limits },
    );
    assert.equal(fakeCloud.requests.length, 1, 'nothing was resent after the reload');
  });
  // The visible grant defaults to one bounded consultation. It is still not
  // authorized until the user presses Authorize and start.
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js' });
  assert.match(html, /<select id="missionConsults" aria-label="Maximum Meta consultations">[\s\S]*?<option value="1" selected>1<\/option>/);
  for (const id of ['missionLimitRequestBytes', 'missionLimitTotalBytes', 'missionLimitOutputTokens', 'missionLimitTotalTokens']) {
    assert.match(html, new RegExp(`<input id="${id}" type="number"[^>]*>`));
    assert.equal(new RegExp(`<input id="${id}"[^>]* value=`).test(html), false, `${id} has no preset value`);
  }
});
