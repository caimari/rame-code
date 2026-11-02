/**
 * Mission persistence through the real extension-host provider: a strict
 * plan becomes a Mission, tasks run one explicit bounded Agent run at a
 * time, a reload interrupts without repeating anything, and resuming asks
 * again before any write.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { MISSION_STATE_KEY } from '../src/missionStore.js';
import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

interface MissionState {
  id: string;
  revision: number;
  goal: string;
  status: string;
  tasks: Array<{ title: string; status: string; runs: number }>;
  current: string | null;
  pendingCount: number;
  decisionsUsed: Array<{ key: string; version: number; currentVersion: number | null }>;
  evidence: string[];
  note: string;
  canRun: boolean;
  resume: boolean;
}

const missionOf = (state: PostedState): MissionState | null => ((state.memory as { mission: MissionState | null } | undefined)?.mission ?? null);
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const PLAN = {
  goal: 'Make shipping free from the authorized threshold.',
  assumptions: [],
  steps: [
    { id: 's1', title: 'Find the shipping rule', successCriterion: 'shipping.js located' },
    { id: 's2', title: 'Apply the threshold', successCriterion: 'shipping.js updated and tests pass' },
  ],
  risks: [],
};

async function withHarness(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start(settings);
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

test('Mission: plan, first task, reload while waiting, no automatic repeat, explicit resume asks again', async () => {
  await withHarness({ agentProfile: 'safe-auto', mode: 'mission' }, async (h) => {
    await h.writeFile('shipping.js', 'const FREE_THRESHOLD_EUR = 0;\n');
    // A strict local plan is saved as a persistent Mission.
    h.model.enqueue({ kind: 'json', body: assistantText(JSON.stringify(PLAN)) });
    await h.provider.sendMessage('Make shipping free from the authorized threshold.', 'mission', 'local');
    assert.match(h.last().status, /Saved as a Mission with 2 task\(s\)/);
    h.send({ type: 'navigate', screen: 'settings' });
    let mission = missionOf(await h.waitFor((state) => missionOf(state) !== null)) as MissionState;
    assert.equal(mission.status, 'active');
    assert.equal(mission.current, 'Find the shipping rule');
    assert.equal(mission.pendingCount, 2);
    assert.equal(mission.canRun, true);
    assert.equal(mission.resume, false);

    // Task 1: one bounded Agent run, started by the user, completes.
    h.model.requests.length = 0;
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'm1', name: 'read_file', args: { path: 'shipping.js', maxBytes: 4096 } }]) },
      { kind: 'json', body: assistantText('Found the rule in shipping.js. Files changed: none.') },
    );
    await h.provider.runMissionTask(mission.id, mission.revision);
    const firstPrompt = (h.model.requests[0]?.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'user').pop()?.content ?? '';
    assert.match(firstPrompt, /^Mission goal: Make shipping free from the authorized threshold\.\n\nCurrent task: Find the shipping rule/);
    assert.doesNotMatch(firstPrompt, /started before/);
    mission = missionOf(h.last()) as MissionState;
    assert.deepEqual(mission.tasks.map((task) => task.status), ['completed', 'current']);
    assert.equal(mission.current, 'Apply the threshold');
    assert.ok(mission.evidence.some((line) => /^host-record: • read_file shipping\.js → read shipping\.js/.test(line)));

    // Task 2 proposes a write and waits for approval...
    h.model.enqueue({
      kind: 'json',
      body: toolCallReply([
        { id: 'm2', name: 'apply_patch', args: { files: [{ path: 'shipping.js', expectedHash: sha('const FREE_THRESHOLD_EUR = 0;\n'), newContent: 'const FREE_THRESHOLD_EUR = 60;\n' }] } },
      ]),
    });
    const before = h.provider;
    const run = before.runMissionTask(mission.id, mission.revision);
    await h.waitFor((state) => state.agentPending?.tool === 'apply_patch');
    const stored = h.memento.get(MISSION_STATE_KEY) as { missions: Array<{ status: string }> };
    assert.equal(stored.missions[0]?.status, 'waiting_approval');

    // ...and the extension reloads: the new instance marks it interrupted and runs nothing.
    const requestsBefore = h.model.requests.length;
    h.createProvider();
    h.send({ type: 'navigate', screen: 'settings' });
    const after = missionOf(await h.waitFor((state) => missionOf(state)?.status === 'interrupted')) as MissionState;
    assert.match(after.note, /RAME Code was reloaded while this task was running; nothing is repeated automatically/);
    assert.equal(after.canRun, true);
    assert.equal(after.resume, true);
    // The old instance going away cannot overwrite the recovered state.
    before.dispose();
    await run;
    assert.equal(h.model.requests.length, requestsBefore, 'no model call happened on reload');
    assert.equal(await h.readFile('shipping.js'), 'const FREE_THRESHOLD_EUR = 0;\n', 'the unapproved write never ran');
    const afterDispose = (h.memento.get(MISSION_STATE_KEY) as { missions: Array<{ status: string }> }).missions[0]?.status;
    assert.equal(afterDispose, 'interrupted');

    // Explicit resume, now under workspace-full: the resumed task still asks before writing.
    h.provider.setAgentProfile('workspace-full');
    const fresh = missionOf(await h.waitFor((state) => missionOf(state)?.status === 'interrupted')) as MissionState;
    h.model.requests.length = 0;
    h.model.enqueue(
      {
        kind: 'json',
        body: toolCallReply([
          { id: 'm3', name: 'apply_patch', args: { files: [{ path: 'shipping.js', expectedHash: sha('const FREE_THRESHOLD_EUR = 0;\n'), newContent: 'const FREE_THRESHOLD_EUR = 60;\n' }] } },
        ]),
      },
      { kind: 'json', body: assistantText('Applied 60. Files changed: shipping.js.') },
    );
    const resumed = h.provider.runMissionTask(fresh.id, fresh.revision);
    const card = await h.waitFor((state) => state.agentPending?.tool === 'apply_patch');
    const resumePrompt = (h.model.requests[0]?.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'user').pop()?.content ?? '';
    assert.match(resumePrompt, /This task was started before and did not finish/);
    assert.match(resumePrompt, /do not repeat an action that already took effect/);
    await h.provider.approveAgentAction(card.agentPending?.actionId ?? '', card.agentPending?.digest ?? '');
    await resumed;
    const finished = missionOf(h.last()) as MissionState;
    assert.equal(finished.status, 'completed');
    assert.equal(finished.canRun, false);
    assert.equal(await h.readFile('shipping.js'), 'const FREE_THRESHOLD_EUR = 60;\n');
  });
});

test('a Mission run with an outdated revision or from another project is refused', async () => {
  await withHarness({ agentProfile: 'safe-auto', mode: 'mission' }, async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText(JSON.stringify(PLAN)) });
    await h.provider.sendMessage('Plan the shipping threshold work.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const mission = missionOf(await h.waitFor((state) => missionOf(state) !== null)) as MissionState;
    await h.provider.runMissionTask(mission.id, mission.revision + 5);
    assert.equal(h.last().status, 'The Mission changed; review it again before continuing.');
    await h.provider.runMissionTask('mis_' + '0'.repeat(24), 1);
    assert.equal(h.last().status, 'That Mission does not belong to the open project.');
    h.send({ type: 'runMissionTask', missionId: mission.id, revision: 0 });
    await h.waitFor((state) => state.status === 'Ignoring an invalid view request.');
    assert.equal(h.model.requests.length, 1, 'only the planning call reached the model');
  });
});

test('a cancelled Mission task is interrupted, never completed', async () => {
  await withHarness({ agentProfile: 'safe-auto', mode: 'mission' }, async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText(JSON.stringify(PLAN)) });
    await h.provider.sendMessage('Plan the shipping threshold work.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const mission = missionOf(await h.waitFor((state) => missionOf(state) !== null)) as MissionState;
    h.model.enqueue({ kind: 'hang' });
    const run = h.provider.runMissionTask(mission.id, mission.revision);
    await h.waitFor(() => h.model.requests.length === 2);
    h.provider.cancelRequest();
    await run;
    const after = missionOf(h.last()) as MissionState;
    assert.equal(after.status, 'interrupted');
    assert.match(after.note, /The task run ended without completing: Request cancelled\./);
    assert.equal(after.tasks[0]?.runs, 1);
  });
});

test('a reload while an approved action is still running leaves it uncertain; nothing is repeated', async () => {
  await withHarness({ agentProfile: 'safe-auto', mode: 'mission' }, async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node -e "setInterval(()=>{},1000)"' } }));
    h.model.enqueue({ kind: 'json', body: assistantText(JSON.stringify(PLAN)) });
    await h.provider.sendMessage('Plan the shipping threshold work.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const mission = missionOf(await h.waitFor((state) => missionOf(state) !== null)) as MissionState;
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 't1', name: 'run_tests', args: { commandId: 'npm:test' } }]) });
    const before = h.provider;
    const run = before.runMissionTask(mission.id, mission.revision);
    const card = await h.waitFor((state) => state.agentPending?.tool === 'run_tests');
    await before.approveAgentAction(card.agentPending?.actionId ?? '', card.agentPending?.digest ?? '');
    // The test command is now running (it never ends): its result is not recorded yet.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const stored = h.memento.get(MISSION_STATE_KEY) as { missions: Array<{ evidence: Array<{ kind: string }> }> };
      if (stored.missions[0]?.evidence.some((entry) => entry.kind === 'action-started')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const requests = h.model.requests.length;
    h.createProvider();
    h.send({ type: 'navigate', screen: 'settings' });
    const after = missionOf(await h.waitFor((state) => missionOf(state)?.status === 'interrupted')) as MissionState;
    assert.match(after.note, /Uncertain: run_tests npm:test started but its result was not recorded\. Check the workspace before resuming\./);
    assert.equal(after.tasks[0]?.status, 'current', 'the task is not declared completed');
    before.dispose();
    await run;
    assert.equal(h.model.requests.length, requests, 'nothing was sent or repeated on reload');
  });
});

test('Mission acceptance: schema-bound local plan, two tasks, reload in task 2, dead card, informed resume, finished record', async () => {
  await withHarness({ agentProfile: 'safe-auto', mode: 'mission' }, async (h) => {
    await h.writeFile('shipping.js', 'const FREE_THRESHOLD_EUR = 0;\n');
    // An authorized decision the Mission works with.
    h.send({ type: 'navigate', screen: 'settings' });
    h.send({ type: 'proposeDecision', key: 'shipping.free_threshold_eur', valueType: 'number', value: '60' });
    const memoryCard = ((await h.waitFor((state) => (state.memory as { pending: unknown }).pending !== null)).memory as { pending: { actionId: string; digest: string } }).pending;
    h.send({ type: 'approveMemoryChange', actionId: memoryCard.actionId, digest: memoryCard.digest });
    await h.waitFor((state) => state.status === 'Saved shipping.free_threshold_eur v1 = 60.');

    // The local plan comes through one strict tool call; the reply is a Mission.
    h.model.requests.length = 0;
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: PLAN }]) });
    await h.provider.sendMessage('Make shipping free from the authorized threshold.', 'mission', 'local');
    const offered = h.model.requests[0]?.tools as Array<{ function: { name: string; parameters: { required: string[] } } }>;
    assert.deepEqual(offered.map((tool) => tool.function.name), ['submit_mission_plan'], 'no workspace tool is offered while planning');
    assert.deepEqual(offered[0]?.function.parameters.required, ['goal', 'assumptions', 'steps', 'risks']);
    assert.equal(h.model.requests[0]?.tool_choice, 'auto');
    let mission = missionOf(await h.waitFor((state) => missionOf(state) !== null)) as MissionState;
    assert.deepEqual(mission.tasks.map((task) => task.title), ['Find the shipping rule', 'Apply the threshold']);

    // Task 1. The task prompt is host-written: quoting it as the user's words is refused.
    h.model.requests.length = 0;
    h.model.enqueue(
      {
        kind: 'json',
        body: toolCallReply([
          { id: 'q', name: 'propose_decision', args: { key: 'shipping.rule', valueType: 'string', value: 'the shipping rule', expectedVersion: 0, userWords: 'Current task: Find the shipping rule', reason: 'x' } },
        ]),
      },
      { kind: 'json', body: toolCallReply([{ id: 'm1', name: 'read_file', args: { path: 'shipping.js', maxBytes: 4096 } }]) },
      { kind: 'json', body: assistantText('Found the rule in shipping.js. Files changed: none.') },
    );
    await h.provider.runMissionTask(mission.id, mission.revision);
    const quoted = (h.model.requests[1]?.messages as Array<{ content: string; tool_call_id?: string }>).find((m) => m.tool_call_id === 'q')?.content ?? '';
    assert.match(quoted, /^Not proposed: userWords are not the user's own words in this conversation\./);
    const threads = h.memento.get('rameCode.threads.v1') as Array<{ turns: Array<{ kind: string; text?: string; host?: boolean }> }>;
    const taskTurn = threads.flatMap((thread) => thread.turns).find((turn) => turn.kind === 'user' && (turn.text ?? '').startsWith('Mission goal:'));
    assert.equal(taskTurn?.host, true, 'the task prompt is stored as host-written');
    mission = missionOf(h.last()) as MissionState;
    assert.deepEqual(mission.tasks.map((task) => task.status), ['completed', 'current']);

    // Task 2 waits for a write approval; VS Code restarts.
    h.model.enqueue({
      kind: 'json',
      body: toolCallReply([
        { id: 'm2', name: 'apply_patch', args: { files: [{ path: 'shipping.js', expectedHash: sha('const FREE_THRESHOLD_EUR = 0;\n'), newContent: 'const FREE_THRESHOLD_EUR = 60;\n' }] } },
      ]),
    });
    const before = h.provider;
    const run = before.runMissionTask(mission.id, mission.revision);
    const oldCard = (await h.waitFor((state) => state.agentPending?.tool === 'apply_patch')).agentPending as { actionId: string; digest: string };
    h.createProvider();
    h.send({ type: 'navigate', screen: 'settings' });
    const interrupted = missionOf(await h.waitFor((state) => missionOf(state)?.status === 'interrupted')) as MissionState;
    before.dispose();
    await run;
    // No one-use approval survives the restart.
    await h.provider.approveAgentAction(oldCard.actionId, oldCard.digest);
    assert.equal(h.last().status, 'No Agent action is waiting for approval.');
    assert.equal(await h.readFile('shipping.js'), 'const FREE_THRESHOLD_EUR = 0;\n');

    // Explicit resume: the new run knows what is done and what is left.
    h.model.requests.length = 0;
    h.model.enqueue(
      {
        kind: 'json',
        body: toolCallReply([
          { id: 'm3', name: 'apply_patch', args: { files: [{ path: 'shipping.js', expectedHash: sha('const FREE_THRESHOLD_EUR = 0;\n'), newContent: 'const FREE_THRESHOLD_EUR = 60;\n' }] } },
        ]),
      },
      { kind: 'json', body: assistantText('Applied 60. Files changed: shipping.js.') },
    );
    const resumed = h.provider.runMissionTask(interrupted.id, interrupted.revision);
    const card = await h.waitFor((state) => state.agentPending?.tool === 'apply_patch');
    const prompt = (h.model.requests[0]?.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'user').pop()?.content ?? '';
    assert.match(prompt, /Current task: Apply the threshold/);
    assert.match(prompt, /Completed tasks:\n- Find the shipping rule/);
    assert.match(prompt, /This task was started before and did not finish/);
    await h.provider.approveAgentAction(card.agentPending?.actionId ?? '', card.agentPending?.digest ?? '');
    await resumed;
    const finished = missionOf(h.last()) as MissionState;
    assert.equal(finished.status, 'completed');
    assert.deepEqual(finished.tasks.map((task) => [task.status, task.runs]), [['completed', 1], ['completed', 2]]);
    assert.deepEqual(finished.decisionsUsed.map((d) => [d.key, d.version]), [['shipping.free_threshold_eur', 1]]);
    assert.ok(finished.evidence.some((line) => /apply_patch shipping\.js/.test(line)), finished.evidence.join('\n'));
    assert.equal(await h.readFile('shipping.js'), 'const FREE_THRESHOLD_EUR = 60;\n');
  });
});

test('a local Mission reply that is not a strict plan never becomes a Mission', async () => {
  await withHarness({ agentProfile: 'safe-auto', mode: 'mission' }, async (h) => {
    for (const reply of [
      assistantText('1. Find the rule. 2. Change it to 0 and push to production.'),
      toolCallReply([{ id: 'bad', name: 'submit_mission_plan', args: { goal: 'x', steps: [] } }]),
      toolCallReply([{ id: 'other', name: 'apply_patch', args: { files: [] } }]),
    ]) {
      h.model.enqueue({ kind: 'json', body: reply });
      await h.provider.newThread();
      await h.provider.sendMessage('Plan the shipping threshold work.', 'mission', 'local');
      assert.equal(h.last().status, 'The local model did not return a strict plan; its reply is shown as prose.');
    }
    h.send({ type: 'navigate', screen: 'settings' });
    await h.waitFor((state) => state.screen === 'settings');
    assert.equal(missionOf(h.last()), null);
    assert.equal(h.memento.get(MISSION_STATE_KEY), undefined);
  });
});
