/**
 * One host re-measurement of an inconclusive measured acceptance check
 * (2026-11-08). Under load, the host's measurement of a correct, fast fix
 * could come out inconclusive (one run of three hit a busy machine) and
 * the Mission went back to the agent with "ACCEPTANCE FAILED". Now the
 * host measures again ONCE, by itself, with the same criteria, repeats and
 * spread; only the second measurement is judged, both are recorded, and
 * inconclusive twice blocks the Mission (never a pass). A failed, invalid
 * or unverifiable measurement is never repeated; Pause and Cancel stop it.
 *
 * The first part uses a stand-in for the protected run; the second, a real
 * host with a frozen check whose numbers this test controls (SIMULATED
 * model replies; the checks, cases and measurements run for real).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { type CheckResult, type MetricSpec } from '../src/metricAcceptance.js';
import { runMeasuredAcceptance } from '../src/metricRun.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { acceptanceState } from '../src/missionPhase.js';
import { evidenceView } from '../src/modelEvidenceRecorder.js';
import { createProgramme, type ProgrammeHost, reopenPhase, startMissionPhase } from '../src/programmeHost.js';
import { fingerprintOf } from '../src/programmeRecord.js';
import { snapshotProject } from '../src/projectSnapshot.js';
import type { ProviderHost } from '../src/providerTypes.js';
import type { MissionLiveView } from '../src/viewMessages.js';
import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const P95 = { metric: 'p95_ms', op: '<=' as const, value: 50 };
const ERR = { metric: 'errors', op: '<=' as const, value: 0 };
const SPEC: MetricSpec = { criteria: [P95, ERR], repeats: 3, maxSpreadPct: 15 };
const NOISY = [10, 45, 12]; // every run meets 50, but they disagree by 70% of it: inconclusive
const STABLE = [20, 20, 20];
const SLOW = [80, 81, 79];

// ---- The host part, with a stand-in for the protected run ----

type Step = { p95: number; errors?: number; run?: CheckResult };
async function measure(steps: Step[], options: { spec?: MetricSpec; stopped?: () => boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-remeasure-root-'));
  writeFileSync(path.join(root, 'package.json'), '{}');
  let runs = 0;
  try {
    const spec = options.spec ?? SPEC;
    const frozenSpec = JSON.stringify(spec);
    const result = await runMeasuredAcceptance(
      spec,
      root,
      ['package.json'],
      async () => {
        runs += 1;
        const step = steps[runs - 1];
        assert.ok(step, `no more than ${steps.length} check runs`);
        if (step.run) {
          return step.run;
        }
        return { passed: true, summary: 'npm:check exit=0 with every frozen file intact; reinforced level: 3 host-compared case(s) passed', output: 'exit=0', tampered: false, hostMetrics: { p95_ms: step.p95, errors: step.errors ?? 0 } as unknown as CheckResult['hostMetrics'] };
      },
      options.stopped ? { stopped: options.stopped } : {},
    );
    assert.equal(JSON.stringify(spec), frozenSpec, 'the criteria, repeats and spread are never changed');
    return { result, runs };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const steps = (...values: number[]): Step[] => values.map((p95) => ({ p95 }));

test('inconclusive, then a valid second measurement that meets every criterion: a pass, judged on the second measurement only, with both recorded', async () => {
  const { result, runs } = await measure(steps(...NOISY, ...STABLE));
  assert.equal(runs, 6, 'one more full measurement of 3 check runs, no more');
  assert.equal(result.passed, true);
  assert.equal(result.inconclusive, undefined);
  assert.match(result.summary, /^metrics judged by the host: second measurement \(the first was inconclusive\): p95_ms median 20 \(20–20, spread 0%\) <= 50: met \[declared by the project — .*\]; errors median 0 \(0–0, spread 0%\) <= 0: met \[declared by the project — .*\]; npm:check exit=0 with every frozen file intact; reinforced level: /);
  assert.match(result.remeasured ?? '', /^p95_ms median 12 \(10–45, spread 70%\) <= 50: inconclusive \[declared by the project — .*\]; errors median 0 \(0–0, spread 0%\) <= 0: met \[declared by the project — .*\]$/);
  assert.match(result.output, /First measurement by the host \(inconclusive; measured again once\):\np95_ms median 12 \(10–45, spread 70%\) <= 50: inconclusive/);
  assert.match(result.output, /Metrics judged by the host \(including project-declared values\) \(3 run\(s\), second measurement\):\np95_ms median 20/);
});

test('inconclusive, then a valid second measurement that misses a criterion: not a pass', async () => {
  const slow = await measure(steps(...NOISY, ...SLOW));
  assert.equal(slow.runs, 6);
  assert.equal(slow.result.passed, false);
  assert.match(slow.result.summary, /^metrics NOT met: second measurement \(the first was inconclusive\): p95_ms median 80 \(79–81, spread 3%\) <= 50: NOT met/);
  // Fast but with errors: one criterion of two missed is not a pass.
  const errors = await measure([...steps(...NOISY), ...STABLE.map((p95) => ({ p95, errors: 2 }))]);
  assert.equal(errors.result.passed, false);
  assert.match(errors.result.summary, /^metrics NOT met: second measurement \(the first was inconclusive\): p95_ms median 20 .* met \[declared by the project — .*\]; errors median 2 \(2–2, spread 0%\) <= 0: NOT met \[declared by the project — .*\]$/);
});

test('inconclusive twice: never a pass, marked inconclusive, both measurements in the summary; no third measurement', async () => {
  const { result, runs } = await measure(steps(...NOISY, 12, 44, 10));
  assert.equal(runs, 6, 'no third measurement');
  assert.equal(result.passed, false);
  assert.equal(result.inconclusive, true);
  assert.equal(result.unverifiable, undefined);
  assert.match(result.summary, /^metrics inconclusive twice \(the runs disagree more than 15% in both measurements; not counted\): second: p95_ms median 12 \(10–44, spread 68%\) <= 50: inconclusive \[declared by the project — .*\]; errors .*; first: p95_ms median 12 \(10–45, spread 70%\) <= 50: inconclusive \[declared by the project — .*\]; /);
});

test('a first measurement that fails, is invalid, or whose protected run does not pass is never repeated', async () => {
  const slow = await measure(steps(...SLOW));
  assert.equal(slow.runs, 3);
  assert.match(slow.result.summary, /^metrics NOT met: p95_ms median 80/);
  assert.equal(slow.result.remeasured, undefined);
  // Noisy, but every run misses: a clear miss, not inconclusive.
  const noisyMiss = await measure(steps(80, 200, 60));
  assert.equal(noisyMiss.runs, 3);
  assert.match(noisyMiss.result.summary, /^metrics NOT met: /);
  const unverifiable = await measure([{ p95: 10 }, { p95: 0, run: { passed: false, summary: 'not verifiable: files changed outside the scope you authorized: x.js', output: '', tampered: false, unverifiable: true } }]);
  assert.equal(unverifiable.runs, 2);
  assert.equal(unverifiable.result.unverifiable, true);
  assert.equal(unverifiable.result.remeasured, undefined);
  const failedRun = await measure([{ p95: 0, run: { passed: false, summary: 'npm:check exit=1 with every frozen file intact', output: '', tampered: false } }]);
  assert.equal(failedRun.runs, 1);
  assert.match(failedRun.result.summary, /^measured run 1\/3: npm:check exit=1/);
});

test('a first measurement that passes is not repeated', async () => {
  const { result, runs } = await measure(steps(...STABLE));
  assert.equal(runs, 3);
  assert.equal(result.passed, true);
  assert.equal(result.remeasured, undefined);
  assert.match(result.summary, /^metrics judged by the host: p95_ms median 20 /);
  assert.doesNotMatch(result.output, /second measurement|First measurement/);
});

test('stopped before the second measurement: no new run starts; stopped during it: nothing after that run, and never a pass', async () => {
  // Pressed while the first measurement ran: the host asks only once it is over, before measuring again.
  let asked = 0;
  const before = await measure(steps(...NOISY, ...STABLE), { stopped: () => (asked += 1) > 0 });
  assert.equal(asked, 1);
  assert.equal(before.runs, 3, 'no run of the second measurement started');
  assert.equal(before.result.passed, false);
  assert.equal(before.result.interrupted, true);
  assert.match(before.result.summary, /^stopped before the host measured again \(the first measurement was inconclusive: p95_ms median 12 /);
  const during = await measure([...steps(...NOISY, 20), { p95: 0, run: { passed: false, summary: 'npm:check was stopped before it finished', output: '', tampered: false, interrupted: true } }, { p95: 20 }]);
  assert.equal(during.runs, 5, 'nothing ran after the stopped run');
  assert.equal(during.result.passed, false);
  assert.equal(during.result.interrupted, true);
  assert.match(during.result.summary, /^second measurement, measured run 2\/3: npm:check was stopped before it finished$/);
  assert.match(during.result.remeasured ?? '', /^p95_ms median 12 /);
});

// ---- A whole Mission, with the real host and a scripted model ----

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const call = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });
const stored = (h: HostHarness): MissionRecord => (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;
const notes = (mission: MissionRecord): string => mission.evidence.map((entry) => entry.text).join('\n');
const APP = 'function double(n) {\n  return n + n;\n}\nmodule.exports = { double };\n';
const APP_FIXED = 'function double(n) {\n  return 2 * n;\n}\nmodule.exports = { double };\n';
// Expected values the agent must never see.
const CASES = JSON.stringify({ rameCases: 1, module: 'app.js', cases: [[2, 4], [21, 42], [777, 1554]].map(([n, expect]) => ({ call: 'double', args: [n], expect })) });

/** The check performs host-timed delays selected by a writable project
 * counter. The counter is test state, never an official metric source. */
const bench = (plan: Array<{ sleepMs: number }>): string =>
  "const fs = require('node:fs');\n" +
  "const { double } = require('../app.js');\n" +
  `const plan = ${JSON.stringify(plan)};\n` +
  "let n = Number(fs.readFileSync('counter.js', 'utf8')) + 1; fs.writeFileSync('counter.js', String(n));\n" +
  'const step = plan[Math.min(n - 1, plan.length - 1)];\n' +
  'if (step.sleepMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.sleepMs);\n' +
  'if (double(21) !== 42) process.exit(1);\n';

type Plan = Array<{ p95: number; sleepMs?: number }>;
interface Run {
  h: HostHarness;
  mission: { id: string; revision: number };
  count: () => number;
  /** What was true when the host started measuring: model requests, task runs, Meta use. */
  atFirstMeasure: () => { requests: number; runs: number; streak: number; escalation: string } | null;
}

async function withPlannedMission(plan: Plan, body: (run: Run) => Promise<void>): Promise<void> {
  const delays = plan.map((step) => ({ sleepMs: step.sleepMs ?? (step.p95 >= 70 ? 1200 : step.p95 >= 40 ? 900 : 0) }));
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  const count = (): number => awaitableReadCount(h);
  let seen: ReturnType<Run['atFirstMeasure']> = null;
  const watch = setInterval(() => {
    if (seen === null && count() >= 1) {
      const record = stored(h);
      seen = { requests: h.model.requests.length, runs: record.tasks[0]?.runs ?? -1, streak: record.auto?.noProgressStreak ?? -1, escalation: JSON.stringify(record.grant?.escalation ?? null) };
    }
  }, 5);
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'remeasure', private: true, scripts: { test: 'node t.js', check: 'node acceptance/bench.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await h.writeFile('app.js', APP);
    await h.writeFile('counter.js', '0');
    await h.writeFile('acceptance/bench.js', bench(delays));
    await h.writeFile('acceptance/app.rame-cases.json', CASES);
    const steps = [{ id: 't1', title: 'Simplify app.js', successCriterion: 'the host measures wall_ms <= 2000 and its cases pass' }];
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: { goal: 'Simplify app.js, same results.', assumptions: [], steps, risks: [] } }]) });
    await h.provider.sendMessage('Simplify app.js, same results, p95 at most 50 ms.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const shown = (await h.waitFor((state: PostedState) => (state.memory as { mission: unknown } | undefined)?.mission != null)).memory as { mission: { id: string; revision: number } };
    h.model.requests.length = 0;
    await body({ h, mission: shown.mission, count, atFirstMeasure: () => seen });
  } finally {
    clearInterval(watch);
    h.provider.cancelRequest();
    await h.dispose();
  }
}

function awaitableReadCount(h: HostHarness): number {
  try { return Number(readFileSync(path.join(h.workspace, 'counter.js'), 'utf8')); } catch { return 0; }
}

// Protected verifier startup is intentionally substantial (Landlock +
// seccomp + a fresh process per case).  Keep the pass threshold above that
// fixed host overhead; the first batch is still noisy because of its added
// 900/1200 ms delays, while the second stable batch remains comfortably met.
const HOST_SPEC = { criteria: [{ metric: 'wall_ms', op: '<=' as const, value: 2000 }], repeats: 3, maxSpreadPct: 15 };
const GRANT = { commandId: 'npm:check', files: ['acceptance/bench.js', 'acceptance/app.rame-cases.json'], metrics: HOST_SPEC };
const agentRun = () => [
  call('peek', 'read_file', { path: 'acceptance/app.rame-cases.json', maxBytes: 4096 }),
  call('fix', 'apply_patch', { files: [{ path: 'app.js', expectedHash: sha(APP), newContent: APP_FIXED }] }),
  say('Done: simpler.'),
  say('Done, no test needed.'),
];
const nothingHidden = (h: HostHarness): void => {
  const sent = JSON.stringify(h.model.requests);
  assert.doesNotMatch(sent, /1554|"expect"/, 'the expected values never reached the agent');
  assert.doesNotMatch(sent, /rame-metrics-|rame-remeasure-control/, 'nor a private host results path');
  assert.doesNotMatch(sent, /re-measured by the host|second measurement|First measurement/, 'the re-measurement involves no model');
};

test('Mission: the host measures again by itself after an inconclusive measurement; the second, valid one completes the Mission; no model call, no task run, nothing hidden revealed', async () => {
  await withPlannedMission([...NOISY, ...STABLE].map((p95) => ({ p95 })), async ({ h, mission, count, atFirstMeasure }) => {
    h.model.enqueue(...agentRun(), say('Unexpected extra model call.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, GRANT);
    const record = stored(h);
    assert.equal(record.status, 'completed', record.note);
    assert.equal(count(), 6, 'two measurements of 3 host runs, no more');
    const first = atFirstMeasure();
    assert.ok(first !== null);
    assert.equal(h.model.requests.length, first.requests, 'no model request from the first host run to the end');
    assert.equal(record.tasks[0]?.runs, first.runs, 'no task run used');
    assert.equal(JSON.stringify(record.grant?.escalation ?? null), first.escalation, 'no Meta consultation, no token budget used');
    const text = notes(record);
    assert.match(text, /acceptance re-measured by the host \(no model involved; same criteria\): the first measurement was inconclusive \(wall_ms median .*: inconclusive/);
    assert.match(text, /acceptance \(run by the host\): metrics measured by the host: second measurement \(the first was inconclusive\): wall_ms median .*: met \[observed by the host\]; npm:check exit=0 with every frozen file intact; reinforced level: /);
    assert.doesNotMatch(JSON.stringify(h.model.requests), /ACCEPTANCE FAILED/, 'the agent was never told it failed');
    assert.match(String((h.model.requests as Array<{ messages?: Array<{ content: string | null; tool_call_id?: string }> }>).flatMap((r) => r.messages ?? []).find((m) => m.tool_call_id === 'peek')?.content ?? ''), /^The tool did not run: That file holds the expected values/);
    nothingHidden(h);
  });
});

test('Mission: inconclusive twice blocks the Mission for review; it is never completed, the agent is not asked to fix noise, and nothing else is measured or sent', async () => {
  await withPlannedMission([...NOISY, 12, 44, 10].map((p95) => ({ p95 })), async ({ h, mission, count, atFirstMeasure }) => {
    h.model.enqueue(...agentRun(), say('Unexpected extra model call.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, GRANT);
    const record = stored(h);
    assert.equal(record.status, 'blocked', record.note);
    assert.match(record.note, /^Blocked: NOT COUNTED: the host measured the acceptance check twice and both measurements were inconclusive/);
    assert.equal(count(), 6, 'no third measurement');
    const first = atFirstMeasure();
    assert.ok(first !== null);
    assert.equal(h.model.requests.length, first.requests, 'no model request after the host started measuring (no advice, no new run)');
    assert.equal(record.tasks[0]?.runs, first.runs);
    assert.equal(record.auto?.noProgressStreak, first.streak, 'not counted as a run without progress');
    assert.equal(JSON.stringify(record.grant?.escalation ?? null), first.escalation);
    const text = notes(record);
    assert.match(text, /acceptance re-measured by the host \(no model involved; same criteria\): the first measurement was inconclusive/);
    assert.match(text, /acceptance \(run by the host\): metrics inconclusive twice \(the runs disagree more than 15% in both measurements; not counted\): second: wall_ms median/);
    assert.doesNotMatch(text, /acceptance \(run by the host\): metrics measured by the host:/, 'no measured pass anywhere in the record');
    assert.doesNotMatch(JSON.stringify(h.model.requests), /ACCEPTANCE FAILED/);
    // What the user sees: inconclusive, not failed, on the Mission card and in the model evidence.
    assert.equal(acceptanceState(record).state, 'inconclusive');
    const live = (h.last().missionLive ?? null) as MissionLiveView | null;
    assert.equal(live?.acceptance?.state, 'inconclusive', 'the Mission card says inconclusive');
    assert.match(live?.acceptance?.summary ?? '', /^metrics inconclusive twice /);
    assert.equal(evidenceView(h.provider as unknown as ProviderHost, record.threadId, 'idle', true).mission?.acceptance, 'inconclusive', 'and so does the model evidence');
    nothingHidden(h);
  });
});

test('Programme: a phase whose Mission was blocked by two inconclusive measurements is inconclusive, not failed, and can be reopened', async () => {
  // Other tests exercise real baseline jobs. Here a host baseline is seeded so
  // this test isolates how a twice-inconclusive Mission settles its phase.
  await withPlannedMission([...NOISY, 12, 44, 10].map((p95) => ({ p95 })), async ({ h, count }) => {
    const ph = h.provider as unknown as ProgrammeHost;
    const created = await createProgramme(ph, {
      goal: 'Twice as fast, same results.',
      check: { commandId: 'npm:check', files: GRANT.files, metrics: ['wall_ms'], repeats: 3, maxSpreadPct: 15 },
      phases: [
        { title: 'Measure the baseline', kind: 'measure' },
        { title: 'Faster', kind: 'mission', relative: [{ metric: 'wall_ms', op: '<=', factor: 0.7 }] },
      ],
    });
    assert.ok(created.ok, created.ok ? '' : created.error);
    const snapshot = await snapshotProject(h.workspace);
    assert.ok(snapshot.ok);
    const fingerprint = fingerprintOf(new Map([...snapshot.files].map(([name, value]) => [name, value.print])));
    const seeded = await h.provider.programmes.update(created.value.id, (draft) => {
      draft.baseline = { values: { wall_ms: { median: 1600, low: 1590, high: 1610, spreadPct: 2 } }, projectFingerprint: fingerprint, measuredAt: Date.now() };
      Object.assign(draft.phases[0]!, { status: 'verified', fingerprint, note: 'Baseline measured by the host and frozen.' });
      draft.phases[1]!.status = 'open';
      return { ok: true, value: draft };
    });
    assert.ok(seeded.ok);
    const mission = stored(h);
    h.model.enqueue(...agentRun(), say('Unexpected extra model call.'));
    const after = await startMissionPhase(ph, created.value.id, 1, mission.id, mission.revision);
    assert.ok(after.ok, after.ok ? '' : after.error);
    assert.equal(count(), 6, 'two measurements of the Mission');
    assert.equal(stored(h).status, 'blocked', stored(h).note);
    const phase = after.value.phases[1];
    assert.equal(phase?.status, 'inconclusive', phase?.note);
    assert.match(phase?.note ?? '', /^Inconclusive, not a failure: the host measured its Mission's check twice and both measurements were unreliable \(Blocked: NOT COUNTED/);
    assert.notEqual(after.value.status, 'completed');
    const reopened = await reopenPhase(ph, created.value.id, 1);
    assert.ok(reopened.ok && reopened.value.phases[1]?.status === 'open', reopened.ok ? '' : reopened.error);
  });
});

for (const kind of ['cancel', 'pause'] as const) {
  test(`Mission: ${kind} pressed during the host's second measurement stops it; no later run, never a pass`, async () => {
    const plan: Plan = [...NOISY.map((p95) => ({ p95 })), { p95: 20, sleepMs: 2_000 }, { p95: 20 }, { p95: 20 }];
    await withPlannedMission(plan, async ({ h, mission, count }) => {
      h.model.enqueue(...agentRun(), say('Unexpected extra model call.'));
      const ran = h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, GRANT);
      const deadline = Date.now() + 60_000;
      while (count() < 4 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(count(), 4, 'the second measurement started');
      await h.provider.stopMission(mission.id, kind);
      await ran;
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(count(), 4, 'no run after the stop');
      const record = stored(h);
      assert.equal(record.status, kind === 'cancel' ? 'cancelled' : 'paused', record.note);
      assert.doesNotMatch(notes(record), /metrics measured by the host:/);
      nothingHidden(h);
    });
  });
}
