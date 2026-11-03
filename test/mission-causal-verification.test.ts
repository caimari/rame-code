/**
 * Causal verification: a test command that failed blocks the task until
 * that same command passes after the last change, under the same manifest.
 * Another passing test never clears it; the host re-runs it itself under an
 * autonomous grant; a recovery that fails again is invalidated, not erased.
 * Plus the preventive modularity rules (prompt and dependency check).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { buildAgentSystemPrompt } from '../src/agentModel.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { parseBlockingVerifiers, parseVerifierRecoveries, updateVerifiers } from '../src/missionVerifiers.js';
import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
type Message = { role: string; content: string | null };
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const text = (body: string) => ({ kind: 'json' as const, body: assistantText(body) });
const write = (id: string, content: string, before: string | null) =>
  tool(id, 'apply_patch', { files: [{ path: 'a.txt', expectedHash: before === null ? sha('') : sha(before), newContent: content }] });
const run = (id: string, commandId: string) => tool(id, 'run_tests', { commandId });
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;
const notesOf = (h: HostHarness): string => stored(h).evidence.map((entry) => entry.text).join('\n');
const lastUser = (h: HostHarness, index: number): string =>
  String(((h.model.requests[index]?.messages ?? []) as Message[]).filter((m) => m.role === 'user').pop()?.content ?? '');

// ----- The pure rule -----

test('a failing command blocks until that same command passes after the last change, under the same manifest', () => {
  const opened = updateVerifiers([], [], [{ commandId: 'npm:check', exitCode: 1, afterLastWrite: true }], 'pkg1', 1, 'agent');
  assert.deepEqual(opened.blockers, [{ commandId: 'npm:check', conditions: 'pkg1', sinceRun: 1, failures: 1 }]);
  assert.match(opened.notes[0] as string, /^verifier npm:check failed \(exit 1\) in internal run 1/);
  // Another passing test does not clear it.
  const other = updateVerifiers(opened.blockers, [], [{ commandId: 'npm:test', exitCode: 0, afterLastWrite: true }], 'pkg1', 2, 'agent');
  assert.equal(other.blockers.length, 1);
  // The same command passing before a later change does not clear it.
  const early = updateVerifiers(opened.blockers, [], [{ commandId: 'npm:check', exitCode: 0, afterLastWrite: false }], 'pkg1', 2, 'agent');
  assert.equal(early.blockers.length, 1);
  assert.match(early.notes[0] as string, /must pass after the last change/);
  // Passing under another manifest does not count.
  const moved = updateVerifiers(opened.blockers, [], [{ commandId: 'npm:check', exitCode: 0, afterLastWrite: true }], 'pkg2', 2, 'agent');
  assert.equal(moved.blockers.length, 1);
  assert.match(moved.notes[0] as string, /package\.json changed since it failed; that does not count/);
  // The last result of a command in the run is what counts.
  const flaky = updateVerifiers(opened.blockers, [], [
    { commandId: 'npm:check', exitCode: 0, afterLastWrite: true },
    { commandId: 'npm:check', exitCode: 1, afterLastWrite: true },
  ], 'pkg1', 2, 'agent');
  assert.equal(flaky.blockers[0]?.failures, 2);
  // Recovery, then the same failure again: the recovery is invalidated, not erased.
  const recovered = updateVerifiers(opened.blockers, [], [{ commandId: 'npm:check', exitCode: 0, afterLastWrite: true }], 'pkg1', 3, 'host');
  assert.equal(recovered.blockers.length, 0);
  assert.match(recovered.notes[0] as string, /^verifier npm:check recovered in internal run 3 \(re-run by the host\): it passed after the last change under the conditions it failed in \(blocking since run 1\)/);
  const again = updateVerifiers([], recovered.recoveries, [{ commandId: 'npm:check', exitCode: 2, afterLastWrite: true }], 'pkg1', 5, 'agent');
  assert.equal(again.blockers.length, 1);
  assert.deepEqual(again.recoveries, [{ commandId: 'npm:check', conditions: 'pkg1', run: 3, invalidatedInRun: 5 }]);
  assert.match(again.notes.join('\n'), /failed again after its recovery in internal run 3: that recovery is invalidated/);
  // Persisted state round-trips; malformed state is refused, never guessed.
  assert.deepEqual(parseBlockingVerifiers(JSON.parse(JSON.stringify(again.blockers))), again.blockers);
  assert.deepEqual(parseVerifierRecoveries(JSON.parse(JSON.stringify(again.recoveries))), again.recoveries);
  assert.deepEqual(parseBlockingVerifiers(undefined), [], 'records from before this change load as no blockers');
  assert.equal(parseBlockingVerifiers([{ commandId: 'rm -rf /', conditions: '', sinceRun: 1, failures: 1 }]), undefined);
  assert.equal(parseVerifierRecoveries([{ commandId: 'npm:check', conditions: '', run: -1, invalidatedInRun: null }]), undefined);
});

// ----- In a Mission -----

const SCRIPTS = { test: 'node t.js', check: 'node c.js' };

async function withMission(body: (h: HostHarness, mission: MissionRecord) => Promise<void>, plan = 1): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: SCRIPTS }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await h.writeFile('c.js', "process.exit(require('node:fs').existsSync('a.txt') && require('node:fs').readFileSync('a.txt', 'utf8') === 'final' ? 0 : 1);\n");
    const steps = Array.from({ length: plan }, (_, index) => ({ id: `t${index + 1}`, title: `Task ${index + 1}`, successCriterion: 'npm:check passes' }));
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: { goal: 'Make npm:check pass.', assumptions: [], steps, risks: [] } }]) });
    await h.provider.sendMessage('Make npm:check pass.', 'mission', 'local');
    h.model.requests.length = 0;
    await body(h, stored(h));
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

test('a premature return is refused: npm:check failed, npm:test passing does not accept the task, and the host re-runs npm:check itself', async () => {
  await withMission(async (h, mission) => {
    h.model.enqueue(
      // Run 1: the blocker appears.
      write('w1', 'draft', null), run('c1', 'npm:check'), text('Done.'),
      // Run 2: another test passes; the host re-runs npm:check, which still fails.
      run('t2', 'npm:test'), text('Done, tests pass.'),
      // Run 3: the real fix, verified with npm:test only; the host's re-run of npm:check accepts it.
      write('w3', 'final', 'draft'), run('t3', 'npm:test'), text('Done.'),
    );
    const started = Date.now();
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const record = stored(h);
    assert.equal(record.status, 'completed', record.note);
    assert.equal(record.auto?.runs, 3, 'run 2 was not accepted on npm:test alone');
    const notes = notesOf(h);
    assert.match(notes, /verifier npm:check failed \(exit 1\) in internal run 1: tasks are accepted only after npm:check itself passes after the last change/);
    assert.match(notes, /internal run 2 \(done\): npm:test exit=0; blocking: npm:check/);
    assert.match(notes, /• run_tests npm:check → exit=1 \(re-run by the host: blocking verifier\)/);
    assert.match(notes, /• run_tests npm:check → exit=0 \(re-run by the host: blocking verifier\)/);
    assert.match(notes, /verifier npm:check recovered in internal run 3 \(re-run by the host\)/);
    assert.deepEqual(record.auto?.blockers, []);
    // Run 3 was told which verifier blocks.
    assert.match(lastUser(h, 5), /BLOCKING VERIFIER: npm:check \(failing since internal run 1\)\. The host accepts this task only after each of them passes after your last change; another passing test does not count\./);
    // Cost: no remote consultation; two host re-runs of npm:check.
    assert.equal(record.grant?.escalation, null);
    assert.equal((notes.match(/re-run by the host: blocking verifier/g) ?? []).length, 2);
    assert.ok(Date.now() - started < 30_000);
  });
});

test('a correct return: the agent fixes the cause and runs the failing verifier itself; no host re-run is needed', async () => {
  await withMission(async (h, mission) => {
    h.model.enqueue(
      write('w1', 'draft', null), run('c1', 'npm:check'), text('Done.'),
      write('w2', 'final', 'draft'), run('c2', 'npm:check'), text('Fixed; npm:check passes.'),
    );
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const record = stored(h);
    assert.equal(record.status, 'completed', record.note);
    assert.equal(record.auto?.runs, 2);
    const notes = notesOf(h);
    assert.match(notes, /verifier npm:check recovered in internal run 2: it passed after the last change/);
    assert.ok(!/re-run by the host/.test(notes));
  });
});

test('a recovered verifier that fails again in a later task is reopened, and its earlier recovery is invalidated, not erased', async () => {
  await withMission(async (h, mission) => {
    h.model.enqueue(
      // Task 1: fail, then recover.
      write('w1', 'draft', null), run('c1', 'npm:check'), text('Done.'),
      write('w2', 'final', 'draft'), run('c2', 'npm:check'), text('Fixed.'),
      // Task 2: the agent breaks it again, then repairs it.
      write('w3', 'broken', 'final'), run('c3', 'npm:check'), text('Done with task 2.'),
      write('w4', 'final', 'broken'), run('c4', 'npm:check'), text('Fixed again.'),
    );
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const record = stored(h);
    assert.equal(record.status, 'completed', record.note);
    assert.deepEqual(record.tasks.map((task) => task.status), ['completed', 'completed']);
    const notes = notesOf(h);
    assert.match(notes, /verifier npm:check failed again after its recovery in internal run 2: that recovery is invalidated/);
    assert.deepEqual(record.auto?.recoveries.map((entry) => [entry.run, entry.invalidatedInRun]), [[2, 3], [4, null]]);
  }, 2);
});

test('a supervised Mission never lets the host run a verifier on its own: the blocker stays until the agent runs it with approval', async () => {
  await withMission(async (h, mission) => {
    h.model.enqueue(
      write('w1', 'draft', null), run('c1', 'npm:check'), text('Done.'),
      run('t2', 'npm:test'), text('Done, tests pass.'),
      { kind: 'hang' },
    );
    const started = h.provider.startMission(mission.id, mission.revision, 'supervised', null, false);
    const approved: string[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !/internal run 2 \(/.test(notesOf(h))) {
      const pending = (h.last() as PostedState).agentPending as { actionId: string; digest: string; tool: string } | null;
      if (pending && !approved.includes(pending.actionId)) {
        approved.push(pending.actionId);
        h.send({ type: 'approveAgentAction', actionId: pending.actionId, digest: pending.digest });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await h.provider.stopMission(mission.id, 'cancel');
    await started;
    const notes = notesOf(h);
    assert.match(notes, /internal run 2 \(done\): npm:test exit=0; blocking: npm:check/);
    assert.ok(!/re-run by the host/.test(notes), 'no test ran without approval');
    assert.notEqual(stored(h).status, 'completed');
  });
});

test('after the agent changes package.json, the host does not re-run the verifier on its own: the grant no longer covers that script', async () => {
  await withMission(async (h, mission) => {
    const original = await h.readFile('package.json');
    const changed = JSON.stringify({ name: 'm', private: true, scripts: { ...SCRIPTS, check: 'node -e "process.exit(0)"' } });
    h.model.enqueue(
      write('w1', 'draft', null), run('c1', 'npm:check'), text('Done.'),
      // Run 2: rewrite the check itself, then a test that now needs approval.
      tool('p2', 'apply_patch', { files: [{ path: 'package.json', expectedHash: sha(original), newContent: changed }] }), run('t2', 'npm:test'), text('Done.'),
      { kind: 'hang' },
    );
    const started = h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const approved: string[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !/internal run 2 \(/.test(notesOf(h))) {
      const pending = (h.last() as PostedState).agentPending as { actionId: string; digest: string } | null;
      if (pending && !approved.includes(pending.actionId)) {
        approved.push(pending.actionId);
        h.send({ type: 'approveAgentAction', actionId: pending.actionId, digest: pending.digest });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await h.provider.stopMission(mission.id, 'cancel');
    await started;
    const notes = notesOf(h);
    assert.match(notes, /internal run 2 \(done\): changed package\.json; npm:test exit=0; blocking: npm:check/);
    assert.ok(!/re-run by the host/.test(notes), 'the modified npm:check never ran without approval');
    assert.deepEqual(stored(h).auto?.blockers.map((blocker) => blocker.commandId), ['npm:check']);
  });
});

// ----- Preventive modularity -----

test('the Agent is told to keep code modular, and the build refuses cyclic imports', () => {
  assert.match(buildAgentSystemPrompt('ws'), /Keep code modular: one clear responsibility per file and narrow interfaces; before a file grows large, split it along a responsibility boundary instead of waiting for a size limit\./);
  const script = path.resolve('scripts/check-module-deps.js');
  assert.match(execFileSync(process.execPath, [script], { encoding: 'utf8' }), /^Module dependency policy passed \(\d+ source files, no cyclic imports\)\./);
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-deps-'));
  mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.ts'), "import { b } from './feature/b.js';\nexport const a = b;\n");
  writeFileSync(path.join(root, 'src', 'feature', 'b.ts'), "import type { A } from '../a.js';\nexport const b = 1;\nexport type B = A;\n");
  let failed = '';
  try {
    execFileSync(process.execPath, [script, root], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    failed = String((error as { stderr?: string }).stderr ?? '');
  }
  assert.match(failed, /Module dependency policy failed: cyclic imports are not allowed\.\n- src\/a\.ts -> src\/feature\/b\.ts -> src\/a\.ts/, 'a type-only import closing a cycle is refused too');
});
