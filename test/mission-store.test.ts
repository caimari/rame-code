import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MISSION_STATE_KEY,
  MissionStore,
  buildTaskPrompt,
  canRunTask,
  completeTask,
  currentTask,
  interrupt,
  journalAction,
  setWaiting,
  startTaskRun,
  uncertainActions,
  type MissionBackend,
} from '../src/missionStore.js';

class FakeBackend implements MissionBackend {
  readonly data = new Map<string, unknown>();
  writes = 0;
  get(key: string): unknown {
    const value = this.data.get(key);
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
  }
  update(key: string, value: unknown): Promise<void> {
    this.writes += 1;
    this.data.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    return Promise.resolve();
  }
}

const STEPS = [
  { id: 's1', title: 'Read the shipping rule', successCriterion: 'Rule located' },
  { id: 's2', title: 'Apply the threshold', successCriterion: 'Tests pass' },
];

async function created(store: MissionStore) {
  const result = await store.create({
    scopeId: 'ws_abc',
    scopeLabel: 'shop',
    threadId: 'thread-1',
    goal: 'Ship free from the authorized threshold.',
    steps: STEPS,
    decisions: [{ key: 'shipping.free_threshold_eur', version: 2 }],
  });
  assert.ok(result.ok);
  return result.value;
}

test('a Mission tracks goal, current task, pending work, decisions, and evidence', async () => {
  const store = new MissionStore(new FakeBackend());
  const mission = await created(store);
  assert.equal(mission.status, 'active');
  assert.equal(currentTask(mission)?.title, 'Read the shipping rule');
  assert.equal(mission.maxTaskRuns, 4);
  const running = await store.update(mission.id, mission.revision, (draft) => startTaskRun(draft, [{ key: 'shipping.free_threshold_eur', version: 2 }], 1));
  assert.ok(running.ok);
  assert.equal(running.value.taskRunsUsed, 1);
  const waiting = await store.update(running.value.id, running.value.revision, (draft) => setWaiting(draft, true));
  assert.ok(waiting.ok);
  assert.equal(waiting.value.status, 'waiting_approval');
  assert.match(canRunTask(waiting.value).ok ? '' : (canRunTask(waiting.value) as { error: string }).error, /waiting for an approval/);
  const back = await store.update(waiting.value.id, waiting.value.revision, (draft) => setWaiting(draft, false));
  assert.ok(back.ok);
  const done = await store.update(back.value.id, back.value.revision, (draft) => completeTask(draft, ['• read_file shipping.js → read shipping.js'], 'Found it.', 2));
  assert.ok(done.ok);
  assert.equal(currentTask(done.value)?.title, 'Apply the threshold');
  assert.deepEqual(done.value.tasks.map((task) => task.status), ['completed', 'current']);
  assert.deepEqual(done.value.evidence.map((entry) => entry.kind), ['host-record', 'report']);
  assert.match(done.value.note, /Next: "Apply the threshold"/);
});

test('an outdated revision is rejected (two windows)', async () => {
  const backend = new FakeBackend();
  const windowA = new MissionStore(backend);
  const windowB = new MissionStore(backend);
  const mission = await created(windowA);
  const fromB = await windowB.update(mission.id, mission.revision, (draft) => startTaskRun(draft, [], 1));
  assert.ok(fromB.ok);
  const fromA = await windowA.update(mission.id, mission.revision, (draft) => completeTask(draft, [], 'x', 1));
  assert.deepEqual(fromA, { ok: false, error: 'The Mission changed in another window; review it again before continuing.' });
  assert.equal(windowA.get(mission.id)?.tasks[0]?.status, 'current');
});

test('after a reload a running task is interrupted, never re-run; a ready Mission stays ready', async () => {
  const backend = new FakeBackend();
  const store = new MissionStore(backend);
  const mission = await created(store);
  // Not started yet: nothing to recover.
  assert.equal(await new MissionStore(backend).recoverInterrupted(), 0);
  assert.equal(store.get(mission.id)?.status, 'active');
  const running = await store.update(mission.id, mission.revision, (draft) => startTaskRun(draft, [], 1));
  assert.ok(running.ok);
  await store.update(running.value.id, running.value.revision, (draft) => setWaiting(draft, true));
  const writes = backend.writes;
  assert.equal(await new MissionStore(backend).recoverInterrupted(), 1);
  const recovered = store.get(mission.id);
  assert.equal(recovered?.status, 'interrupted');
  assert.match(recovered?.note ?? '', /nothing is repeated automatically/);
  assert.equal(backend.writes, writes + 1, 'recovery only records the interruption');
  // The resume prompt says what happened and forbids repeating it.
  const prompt = buildTaskPrompt(recovered!);
  assert.match(prompt, /This task was started before and did not finish/);
  assert.match(prompt, /do not repeat an action that already took effect/);
  assert.match(prompt, /Later tasks \(do not start them now\):\n- Apply the threshold/);
});

test('the run budget stops a Mission instead of looping', async () => {
  const store = new MissionStore(new FakeBackend());
  let mission = await created(store);
  for (let run = 0; run < mission.maxTaskRuns; run++) {
    const started = await store.update(mission.id, mission.revision, (draft) => startTaskRun(draft, [], run));
    assert.ok(started.ok);
    const stopped = await store.update(started.value.id, started.value.revision, (draft) => interrupt(draft, 'Agent stopped at its step budget.', run));
    assert.ok(stopped.ok);
    mission = stopped.value;
  }
  assert.equal(mission.status, 'failed');
  assert.match(mission.note, /used all 4 task runs of its budget/);
  const again = await store.update(mission.id, mission.revision, (draft) => startTaskRun(draft, [], 9));
  assert.equal(again.ok, false);
});

test('unreadable or tampered Mission state is never overwritten or used', async () => {
  const backend = new FakeBackend();
  backend.data.set(MISSION_STATE_KEY, { schema: 7 });
  const store = new MissionStore(backend);
  assert.equal(store.isReadable(), false);
  const refused = await store.create({ scopeId: 'ws_abc', scopeLabel: 'shop', threadId: 't', goal: 'g', steps: STEPS, decisions: [] });
  assert.match(refused.ok ? '' : refused.error, /could not be read/);
  assert.deepEqual(backend.get(MISSION_STATE_KEY), { schema: 7 });
  // One tampered entry (two current tasks) is skipped; others still load.
  const good = new FakeBackend();
  const goodStore = new MissionStore(good);
  const first = await created(goodStore);
  const second = await created(goodStore);
  const raw = good.get(MISSION_STATE_KEY) as { missions: Array<{ id: string; tasks: Array<{ status: string }> }> };
  raw.missions[0]!.tasks[1]!.status = 'current';
  await good.update(MISSION_STATE_KEY, raw);
  assert.deepEqual(goodStore.list().map((mission) => mission.id), [second.id]);
  assert.equal(goodStore.get(first.id), null);
  const blocked = await goodStore.update(first.id, first.revision, (draft) => startTaskRun(draft, [], 1));
  assert.match(blocked.ok ? '' : blocked.error, /no longer exists or could not be read/);
});

test('a Mission needs between 1 and 20 tasks', async () => {
  const store = new MissionStore(new FakeBackend());
  const none = await store.create({ scopeId: 'ws_abc', scopeLabel: 'shop', threadId: 't', goal: 'g', steps: [], decisions: [] });
  assert.equal(none.ok, false);
  const many = await store.create({
    scopeId: 'ws_abc',
    scopeLabel: 'shop',
    threadId: 't',
    goal: 'g',
    steps: Array.from({ length: 21 }, (_, index) => ({ id: `s${index}`, title: 't', successCriterion: 'c' })),
    decisions: [],
  });
  assert.equal(many.ok, false);
});

test('an action that started but never recorded a result is reported as uncertain, never as done', async () => {
  const backend = new FakeBackend();
  const store = new MissionStore(backend);
  const mission = await created(store);
  const running = await store.update(mission.id, mission.revision, (draft) => startTaskRun(draft, [], 1));
  assert.ok(running.ok);
  const done = await store.update(running.value.id, running.value.revision, (draft) => journalAction(draft, 'started', 'act-aaa', 'read_file shipping.js', 2));
  assert.ok(done.ok);
  const closed = await store.update(done.value.id, done.value.revision, (draft) => journalAction(draft, 'finished', 'act-aaa', 'read shipping.js', 3));
  assert.ok(closed.ok);
  const open = await store.update(closed.value.id, closed.value.revision, (draft) => journalAction(draft, 'started', 'act-bbb', 'apply_patch shipping.js', 4));
  assert.ok(open.ok);
  assert.deepEqual(uncertainActions(open.value), ['apply_patch shipping.js']);
  // Reload: interrupted, with the uncertainty spelled out.
  assert.equal(await new MissionStore(backend).recoverInterrupted(), 1);
  const recovered = store.get(mission.id)!;
  assert.equal(recovered.status, 'interrupted');
  assert.match(recovered.note, /Uncertain: apply_patch shipping\.js started but its result was not recorded\. Check the workspace before resuming\./);
  assert.match(buildTaskPrompt(recovered), /UNCERTAIN: these actions started but their result was never recorded[\s\S]*- apply_patch shipping\.js/);
  // Resuming closes it as unknown (not done) and keeps the record.
  const resumed = await store.update(recovered.id, recovered.revision, (draft) => startTaskRun(draft, [], 5));
  assert.ok(resumed.ok);
  assert.deepEqual(uncertainActions(resumed.value), []);
  assert.ok(resumed.value.evidence.some((entry) => entry.kind === 'action-finished' && /^act-bbb result unknown \(interrupted before it was recorded; carried into run 2\)$/.test(entry.text)));
  assert.equal(currentTask(resumed.value)?.status, 'current', 'the task is not declared completed');
});
