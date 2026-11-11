/**
 * P4 of the long-Mission plan: two chained phases. Phase 1: the host
 * measures the baseline itself (host jobs) and freezes it. Phase 2: a Mission
 * whose measured criteria are fixed from that baseline ("at least twice as
 * fast") must beat it. Sabotage: phase 2 without a verified phase 1, a
 * changed check or project after the baseline, and a "done" without the
 * host's measurement never count. SIMULATED model replies; the jobs and the
 * host checks run for real.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import type { MissionRecord } from '../src/missionStore.js';
import { createProgramme, type NewProgramme, type ProgrammeHost, refreshProgramme, runMeasurePhase, startMissionPhase } from '../src/programmeHost.js';
import { canStartPhase, missionPhaseVerified, newPhases, type ProgrammeRecord, resolveCriteria, validatePhases } from '../src/programmeRecord.js';
import { PROGRAMME_STATE_KEY, ProgrammeStore } from '../src/programmeStore.js';
import { SharedJsonFileBackend } from '../src/sharedStateFile.js';
import { assistantText, HostHarness, type PostedState, toolCallReply } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const BENCH =
  "const { latencyMs } = require('../app.js');\n" +
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, latencyMs);\n';
// The waits dominate the start-up cost of a check run, so "twice as fast" is decided by the code, not by the
// machine. CI evidence (2026-11-11, ubuntu-latest): the frozen check's acceptance runs carry RAME's trace hooks,
// the baseline jobs do not, and start-up there cost ~360-540 ms for the baseline but ~800-950 ms for acceptance; with
// a 1200 ms wait even latency 0 missed "<= half" (806.7 vs 778.5), and another acceptance run took up to 1133 ms
// with no wait at all. With 3200 ms the fast code meets "<= half" up to ~1800 ms of start-up. The criterion is
// unchanged (factor 0.5); the partial fix stays at 75% of SLOW, so it can never meet it, whatever the start-up cost.
const SLOW = 'module.exports = { latencyMs: 3200 };\n';
const FAST = 'module.exports = { latencyMs: 0 };\n';
const LITTLE = 'module.exports = { latencyMs: 2400 };\n';
const PHASES = [
  { title: 'Measure the baseline', kind: 'measure' },
  { title: 'Make it at least twice as fast', kind: 'mission', relative: [{ metric: 'wall_ms', op: '<=', factor: 0.5 }] },
];
const PROGRAMME: NewProgramme = { goal: 'Make app.js at least twice as fast as it is now.', check: { commandId: 'npm:check', files: ['acceptance/bench.js'], metrics: ['wall_ms'], repeats: 3, maxSpreadPct: 30 }, phases: PHASES };
const patch = (id: string, file: string, before: string, after: string) => ({ kind: 'json' as const, body: toolCallReply([{ id, name: 'apply_patch', args: { files: [{ path: file, expectedHash: sha(before), newContent: after }] } }]) });
const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });
const host = (h: HostHarness): ProgrammeHost => h.provider as unknown as ProgrammeHost;
const execFileAsync = promisify(execFile);

test('two windows update programmes under the shared exclusive section without losing either change', async () => {
  let state: unknown = { version: 1, programmes: [
    { id: `prg_${'a'.repeat(24)}`, scopeId: 'one', root: '/one', phases: [], check: {}, status: 'active', revision: 1, note: 'one' },
    { id: `prg_${'b'.repeat(24)}`, scopeId: 'two', root: '/two', phases: [], check: {}, status: 'active', revision: 1, note: 'two' },
  ] };
  let lock: Promise<unknown> = Promise.resolve();
  const backend = {
    get: (key: string) => key === PROGRAMME_STATE_KEY ? structuredClone(state) : undefined,
    update: async (_key: string, value: unknown) => { await new Promise((resolve) => setTimeout(resolve, 20)); state = structuredClone(value); },
    exclusive: <T>(work: () => Promise<T>): Promise<T> => {
      const next = lock.then(work, work);
      lock = next.then(() => undefined, () => undefined);
      return next;
    },
  };
  const one = new ProgrammeStore(backend);
  const two = new ProgrammeStore(backend);
  await Promise.all([
    one.update(`prg_${'a'.repeat(24)}`, (draft) => (draft.note = 'changed one', { ok: true, value: draft })),
    two.update(`prg_${'b'.repeat(24)}`, (draft) => (draft.note = 'changed two', { ok: true, value: draft })),
  ]);
  assert.deepEqual(new ProgrammeStore(backend).list().map((entry) => entry.note), ['changed one', 'changed two']);
  const revision = one.get(`prg_${'a'.repeat(24)}`)?.revision as number;
  const competing = await Promise.all([
    one.update(`prg_${'a'.repeat(24)}`, (draft) => (draft.note = 'winner one', { ok: true, value: draft }), revision),
    two.update(`prg_${'a'.repeat(24)}`, (draft) => (draft.note = 'winner two', { ok: true, value: draft }), revision),
  ]);
  assert.equal(competing.filter((result) => result.ok).length, 1, 'a stale window cannot replace a phase decision made by another one');
});

test('phase lease: one live owner, expiry recovery, and fencing of every late write', async () => {
  let state: unknown;
  let lock: Promise<unknown> = Promise.resolve();
  const backend = {
    get: (key: string) => key === PROGRAMME_STATE_KEY ? structuredClone(state) : undefined,
    update: async (_key: string, value: unknown) => { state = structuredClone(value); },
    exclusive: <T>(work: () => Promise<T>): Promise<T> => {
      const next = lock.then(work, work);
      lock = next.then(() => undefined, () => undefined);
      return next;
    },
  };
  const first = new ProgrammeStore(backend);
  const second = new ProgrammeStore(backend);
  const record = {
    id: `prg_${'c'.repeat(24)}`, scopeId: 'scope', root: '/project', goal: 'g',
    check: { commandId: 'npm:test', files: [], packageJsonHash: 'p', metrics: ['wall_ms'], repeats: 1, maxSpreadPct: 100 },
    phases: [], baseline: null, lease: null, nextFence: 0, status: 'active', revision: 1,
    createdAt: 1, updatedAt: 1, note: '',
  } as unknown as ProgrammeRecord;
  assert.ok((await first.create(record)).ok);
  const one = await first.acquirePhase(record.id, 0, 'owner-one', 1_000, 100);
  assert.ok(one.ok);
  const busy = await second.acquirePhase(record.id, 0, 'owner-two', 1_050, 100);
  assert.equal(busy.ok, false, 'a second process/window cannot direct the live phase');
  const two = await second.acquirePhase(record.id, 0, 'owner-two', 1_101, 100);
  assert.ok(two.ok, two.ok ? '' : two.error);
  assert.ok(two.value.lease.fence > one.value.lease.fence, 'recovery receives a later fencing token');
  const lateUpdate = await first.updateLeased(record.id, one.value.lease, (draft) => ({ ok: true, value: draft }), 1_102);
  assert.equal(lateUpdate.ok, false);
  assert.match(lateUpdate.ok ? '' : lateUpdate.error, /late result was rejected/);
  const lateRelease = await first.releasePhase(record.id, one.value.lease, 1_102);
  assert.equal(lateRelease.ok, false, 'the old owner cannot release the recovered owner');
  const current = await second.updateLeased(record.id, two.value.lease, (draft) => { draft.note = 'winner'; return { ok: true, value: draft }; }, 1_102);
  assert.ok(current.ok && current.value.note === 'winner');
});

test('phase lease is enforced by the machine-wide backend across independent Node processes', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rame-phase-process-'));
  const id = `prg_${'d'.repeat(24)}`;
  try {
    const backend = new SharedJsonFileBackend(dir);
    const store = new ProgrammeStore(backend);
    const record = {
      id, scopeId: 'scope', root: '/project', goal: 'g',
      check: { commandId: 'npm:test', files: [], packageJsonHash: 'p', metrics: ['wall_ms'], repeats: 1, maxSpreadPct: 100 },
      phases: [], baseline: null, lease: null, nextFence: 0, status: 'active', revision: 1,
      createdAt: 1, updatedAt: 1, note: '',
    } as unknown as ProgrammeRecord;
    assert.ok((await store.create(record)).ok);
    const shared = path.join(__dirname, '..', 'src', 'sharedStateFile.js');
    const programme = path.join(__dirname, '..', 'src', 'programmeStore.js');
    const child = `const {SharedJsonFileBackend}=require(process.argv[1]); const {ProgrammeStore}=require(process.argv[2]); (async()=>{const s=new ProgrammeStore(new SharedJsonFileBackend(process.argv[3])); const r=await s.acquirePhase(process.argv[4],0,process.argv[5],Date.now(),Number(process.argv[6])); process.stdout.write(JSON.stringify(r));})().catch(e=>{console.error(e);process.exit(2)});`;
    const acquire = async (owner: string, ttl: number) => JSON.parse((await execFileAsync(process.execPath, ['-e', child, shared, programme, dir, id, owner, String(ttl)])).stdout) as { ok: boolean; error?: string; value?: { lease: { fence: number } } };
    const one = await acquire('process-owner-one', 250);
    assert.equal(one.ok, true);
    const busy = await acquire('process-owner-two', 250);
    assert.equal(busy.ok, false);
    assert.match(busy.error ?? '', /another live RAME Code window/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const recovered = await acquire('process-owner-two', 250);
    assert.equal(recovered.ok, true);
    assert.ok((recovered.value?.lease.fence ?? 0) > (one.value?.lease.fence ?? 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withProject(body: (h: HostHarness) => Promise<void>, bench = BENCH): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'measured', private: true, scripts: { test: 'node t.js', check: 'node acceptance/bench.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await h.writeFile('app.js', SLOW);
    await h.writeFile('acceptance/bench.js', bench);
    await body(h);
  } finally {
    for (const job of h.provider.jobs.list()) {
      if (job.status === 'running' || job.status === 'starting') {
        await h.provider.jobs.cancel(job.id);
        await h.provider.jobs.waitFor(job.id, { pollMs: 100 });
      }
      rmSync(job.dir, { recursive: true, force: true });
    }
    for (const programme of h.provider.programmes.list()) {
      rmSync(path.join(h.provider.jobs.root, '..', 'programmes', programme.id), { recursive: true, force: true });
    }
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function planMission(h: HostHarness): Promise<{ id: string; revision: number }> {
  const plan = { goal: 'Make app.js at least twice as fast.', assumptions: [], steps: [{ id: 't1', title: 'Speed up app.js', successCriterion: 'the host measures p95 at most half the baseline' }], risks: [] };
  h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: plan }]) });
  await h.provider.sendMessage('Make app.js at least twice as fast as the baseline.', 'mission', 'local');
  h.send({ type: 'navigate', screen: 'settings' });
  const shown = (await h.waitFor((state: PostedState) => (state.memory as { mission: unknown } | undefined)?.mission != null)).memory as { mission: { id: string; revision: number } };
  return shown.mission;
}

async function created(h: HostHarness, input: NewProgramme = PROGRAMME): Promise<ProgrammeRecord> {
  const result = await createProgramme(host(h), input);
  assert.ok(result.ok, result.ok ? '' : result.error);
  return result.value;
}

// ----- Rules (pure) -----

test('phases: a measurement first, then Missions with measured criteria on metrics the baseline records', () => {
  assert.ok(validatePhases(PHASES, ['wall_ms']).ok);
  for (const [phases, why] of [
    [[PHASES[1], PHASES[0]], /first phase must measure the baseline/],
    [[PHASES[0]], /2 to 8 phases/],
    [[PHASES[0], { title: 'x', kind: 'mission' }], /needs at least one measured criterion/],
    [[PHASES[0], { title: 'x', kind: 'mission', relative: [{ metric: 'rps', op: '>=', factor: 2 }] }], /rps is not measured by the baseline/],
    [[PHASES[0], { title: 'x', kind: 'mission', relative: [{ metric: 'wall_ms', op: '<=', factor: 0 }] }], /factor must be a number above 0/],
    [[{ ...PHASES[0], absolute: [{ metric: 'wall_ms', op: '<=', value: 1 }] }, PHASES[1]], /a measurement has no criteria of its own/],
  ] as const) {
    const checked = validatePhases(phases, ['wall_ms']);
    assert.equal(checked.ok, false);
    assert.match(checked.ok ? '' : checked.error, why);
  }
  const phases = newPhases((validatePhases(PHASES, ["wall_ms"]) as unknown as { phases: never }).phases);
  const resolved = resolveCriteria(phases[1]!, { values: { wall_ms: { median: 800, low: 790, high: 810, spreadPct: 2 } }, projectFingerprint: 'x', measuredAt: 0 });
  assert.deepEqual(resolved, { ok: true, criteria: [{ metric: 'wall_ms', op: '<=', value: 400 }] });
  assert.equal(resolveCriteria(phases[1]!, null).ok, false, 'no baseline, no criteria');
});

test('a Mission phase counts only from the host record: completed, the programme\'s check, its exact criteria, a measured pass', () => {
  const phases = newPhases((validatePhases(PHASES, ["wall_ms"]) as unknown as { phases: never }).phases);
  const criteria = [{ metric: 'wall_ms', op: '<=' as const, value: 640 }];
  const programme = { status: 'active', check: { commandId: 'npm:check', files: [{ path: 'acceptance/bench.js', hash: 'h1' }], packageJsonHash: 'p1', metrics: ['wall_ms'], repeats: 3, maxSpreadPct: 30 }, phases } as unknown as ProgrammeRecord;
  const phase = { ...phases[1]!, resolved: criteria };
  const mission = (over: Record<string, unknown> = {}, note = 'acceptance (run by the host): metrics measured by the host: wall_ms median 100 (100–100, spread 0%) <= 640: met') =>
    ({ status: 'completed', grant: { acceptance: { commandId: 'npm:check', packageJsonHash: 'p1', files: [{ path: 'acceptance/bench.js', hash: 'h1' }], metrics: { criteria, repeats: 3, maxSpreadPct: 15 } } }, evidence: [{ kind: 'note', text: note }], ...over }) as unknown as MissionRecord;
  assert.equal(missionPhaseVerified(programme, phase, mission()).verified, true);
  assert.match(missionPhaseVerified(programme, phase, mission({ status: 'active' })).reason, /its Mission is active/);
  assert.match(missionPhaseVerified(programme, phase, mission({}, 'acceptance (run by the host): npm:check exit=0 with every frozen file intact')).reason, /did not record a measured pass/, 'a pass without the measurement does not count');
  assert.match(missionPhaseVerified(programme, phase, mission({ grant: { acceptance: { commandId: 'npm:check', packageJsonHash: 'p1', files: [{ path: 'acceptance/bench.js', hash: 'h1' }] } } })).reason, /not authorized with this phase's measured criteria/);
  assert.match(missionPhaseVerified(programme, phase, mission({ grant: { acceptance: { commandId: 'npm:check', packageJsonHash: 'p1', files: [{ path: 'acceptance/bench.js', hash: 'h2' }], metrics: { criteria, repeats: 3, maxSpreadPct: 15 } } } })).reason, /froze different check files/);
  assert.match(missionPhaseVerified(programme, phase, mission({ evidence: [] })).reason, /did not record a measured pass/);
  assert.match(missionPhaseVerified(programme, { ...phase, resolved: [{ metric: 'wall_ms', op: '<=', value: 600 }] }, mission()).reason, /not authorized with this phase's measured criteria/, 'looser criteria than the phase\'s do not count');
  assert.match((canStartPhase(programme, 1, 'mission') as { error: string }).error, /phase 1 \(Measure the baseline\) is open, not verified by the host/);
});

// ----- The whole programme -----

test('P4: the host measures the baseline, then a Mission must beat it by its fixed criteria; only then is the programme complete', async () => {
  await withProject(async (h) => {
    const programme = await created(h);
    const mission = await planMission(h);
    // Sabotage: phase 2 before phase 1 is verified.
    const early = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
    assert.match(early.ok ? '' : early.error, /Phase 2 cannot open: phase 1 \(Measure the baseline\) is open, not verified by the host/);
    assert.equal(h.provider.missions.get(mission.id)?.grant, null, 'nothing was authorized');
    // Phase 1: three host jobs, results outside the project, frozen medians.
    const measured = await runMeasurePhase(host(h), programme.id);
    assert.ok(measured.ok, measured.ok ? '' : measured.error);
    assert.equal(measured.value.phases[0]?.status, 'verified', measured.value.phases[0]?.note);
    assert.match(measured.value.phases[0]?.note ?? '', /^Baseline judged and frozen \(verification: protected\): wall_ms median \d+(?:\.\d+)? \(\d+(?:\.\d+)?–\d+(?:\.\d+)?\) \[observed by the host\]\.$/);
    assert.equal(measured.value.phases[1]?.status, 'open');
    const jobs = h.provider.jobs.list().filter((job) => job.missionId === programme.id);
    assert.deepEqual(jobs.map((job) => [job.label, job.status, job.exit?.exitCode]), [1, 2, 3].map((n) => [`npm:check (baseline ${n}/3; protected verification)`, 'finished', 0]));
    assert.ok(jobs.every((job) => job.spec.executable === 'python3' && job.spec.argv.includes('--write')), 'baseline jobs use the selected Project isolation');
    assert.equal(existsSync(path.join(h.workspace, 'results.json')), false);
    // Phase 2: criteria fixed from the host-observed baseline, frozen in the Mission grant.
    h.model.requests.length = 0;
    h.model.enqueue(
      // First a change that is not enough (70 ms), then the real fix (20 ms).
      patch('little', 'app.js', SLOW, LITTLE),
      say('Done: a bit faster.'),
      say('Done, no test needed.'),
      patch('fix', 'app.js', LITTLE, FAST),
      say('Done: much faster.'),
      say('Done, no test needed.'),
    );
    const finished = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
    assert.ok(finished.ok, finished.ok ? '' : finished.error);
    const record = h.provider.missions.get(mission.id) as MissionRecord;
    assert.equal(record.grant?.acceptance?.metrics?.criteria[0]?.metric, 'wall_ms');
    assert.match(JSON.stringify(h.model.requests[0]), /The host judges: wall_ms <=/);
    const text = record.evidence.map((entry) => entry.text).join('\n');
    assert.match(text, /acceptance \(run by the host\): metrics NOT met: wall_ms median .*: NOT met/, 'beating the baseline by a little is not enough');
    assert.equal(record.status, 'completed', record.note);
    assert.equal(finished.value.phases[1]?.status, 'verified', finished.value.phases[1]?.note);
    assert.match(finished.value.phases[1]?.note ?? '', /^Verified by the host: metrics measured by the host: wall_ms median .*: met \[observed by the host\]/);
    assert.equal(finished.value.status, 'completed');
    // A reload keeps every phase as it is.
    h.createProvider();
    assert.deepEqual(h.provider.programmes.get(programme.id)?.phases.map((phase) => phase.status), ['verified', 'verified']);
  });
});

test('P4 sabotage: the check or the project changed after the baseline → the next phase does not open', async () => {
  await withProject(async (h) => {
    const programme = await created(h);
    assert.ok((await runMeasurePhase(host(h), programme.id)).ok);
    const mission = await planMission(h);
    await h.writeFile('app.js', LITTLE);
    const moved = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
    assert.match(moved.ok ? '' : moved.error, /The project changed since the baseline was measured, so the baseline no longer describes the starting point\. Measure it again\. Nothing was authorized\./);
    await h.writeFile('app.js', SLOW);
    await h.writeFile('acceptance/bench.js', BENCH.replace('latencyMs', 'latencyMs * 4'));
    const retouched = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
    assert.match(retouched.ok ? '' : retouched.error, /The baseline is no longer valid: acceptance\/bench\.js changed since the programme was authorized\. Nothing was authorized\./);
    assert.equal(h.provider.missions.get(mission.id)?.grant, null);
    assert.equal(h.provider.programmes.get(programme.id)?.phases[1]?.status, 'open');
  });
});

test('P4 sabotage: a Mission that says "done" without the host\'s measured pass does not verify its phase', async () => {
  await withProject(async (h) => {
    const programme = await created(h);
    assert.ok((await runMeasurePhase(host(h), programme.id)).ok);
    const mission = await planMission(h);
    // The agent writes good numbers of its own and keeps saying it is done; the code stays slow.
    h.model.enqueue(patch('fake', 'results.json', '', JSON.stringify({ p95_ms: 5, errors: 0 })), say('Done: results.json shows p95 5 ms.'), say('Done, no test needed.'));
    const after = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
    assert.ok(after.ok, after.ok ? '' : after.error);
    const record = h.provider.missions.get(mission.id) as MissionRecord;
    assert.notEqual(record.status, 'completed');
    assert.equal(record.status, 'blocked', record.note);
    assert.match(record.note, /acceptance check kept failing \(metrics NOT met: wall_ms median .*: NOT met/, 'the host measured the slow code, whatever results.json said')
    const phase = after.value.phases[1];
    assert.equal(phase?.status, 'failed', phase?.note);
    assert.match(phase?.note ?? '', /^Not verified: its Mission is blocked/);
    assert.equal(after.value.status, 'active', 'the programme is not complete');
    const again = await refreshProgramme(host(h), programme.id);
    assert.ok(again.ok && again.value.phases[1]?.status !== 'verified');
  });
});

test('a baseline whose runs disagree is inconclusive and not frozen; a bench that writes into the project is not verifiable', async () => {
  // The host-owned scratch path identifies the repeat without letting the
  // project report a metric.  Unlike PID modulo arithmetic, this guarantees
  // three disagreeing timings on every machine.
  const noisy = "const repeat = Number(/scratch-run(\\d+)/.exec(process.env.TMPDIR || '')?.[1] || 1); const delay = [0, 500, 1000][repeat - 1]; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);\n";
  await withProject(async (h) => {
    const programme = await created(h);
    const measured = await runMeasurePhase(host(h), programme.id);
    assert.ok(measured.ok);
    assert.equal(measured.value.phases[0]?.status, 'inconclusive');
    assert.match(measured.value.phases[0]?.note ?? '', /The baseline is inconclusive: wall_ms varied more than 30% between runs\. It was not frozen; measure again\./);
    assert.equal(measured.value.baseline, null);
    const mission = await planMission(h);
    const refused = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
    assert.match(refused.ok ? '' : refused.error, /phase 1 \(Measure the baseline\) is inconclusive, not verified by the host/);
  }, noisy);
  await withProject(async (h) => {
    const programme = await created(h);
    const measured = await runMeasurePhase(host(h), programme.id);
    assert.ok(measured.ok);
    assert.equal(measured.value.phases[0]?.status, 'failed');
    assert.match(measured.value.phases[0]?.note ?? '', /Run 1 of the baseline did not pass/, 'protected verification prevents the project write before it can affect the baseline');
  }, `${BENCH}fs.appendFileSync('bench.log', 'ran\\n');\n`);
});

test('a reload while the baseline is measured: the new window follows the jobs already started and never starts one twice', async () => {
  const slow = `${BENCH.replace("const fs = require('node:fs');\n", "const fs = require('node:fs');\nconst until = Date.now() + 1200; while (Date.now() < until) {}\n")}`;
  await withProject(async (h) => {
    const programme = await created(h);
    const reload = new AbortController();
    const old = runMeasurePhase(host(h), programme.id, { signal: reload.signal });
    // Wait until run 1 has a job, then the window goes away.
    for (let i = 0; i < 100 && (h.provider.programmes.get(programme.id)?.phases[0]?.jobIds.length ?? 0) === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    reload.abort();
    const stopped = await old;
    assert.ok(stopped.ok && stopped.value.phases[0]?.status === 'running', stopped.ok ? stopped.value.phases[0]?.note : stopped.error);
    h.createProvider();
    assert.equal(h.provider.programmes.get(programme.id)?.phases[0]?.status, 'running', 'nothing settled it in the meantime');
    const resumed = await runMeasurePhase(host(h), programme.id);
    assert.ok(resumed.ok && resumed.value.phases[0]?.status === 'verified', resumed.ok ? resumed.value.phases[0]?.note : resumed.error);
    const jobs = h.provider.jobs.list().filter((job) => job.missionId === programme.id);
    assert.equal(jobs.length, 3, 'one job per run: the first was followed, not started again');
    assert.deepEqual(resumed.value.phases[0]?.jobIds, jobs.map((job) => job.id));
  }, slow);
});
