/**
 * Mission internal runs do not replay the conversation of earlier internal
 * runs: the host's checkpoint in the prompt carries what is needed, and the
 * persistent thread and Mission record stay complete. The current run keeps
 * its own tool exchanges, decisions, the grant, the frozen acceptance check,
 * and uncertain actions are never repeated blindly. Agent and Chat are
 * unchanged.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
type Message = { role: string; content: string | null; tool_calls?: unknown[] };
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const text = (body: string) => ({ kind: 'json' as const, body: assistantText(body) });
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;
const chars = (messages: Message[]): number => messages.reduce((sum, message) => sum + String(message.content ?? '').length, 0);
const messagesOf = (h: HostHarness, index: number): Message[] => (h.model.requests[index]?.messages ?? []) as Message[];
const REPORT = (name: string) => `What I did\n• Wrote ${name}.txt.\nREPORT-OF-${name} ` + 'Details of what I checked and why. '.repeat(40);
const PLAN = {
  goal: 'Write three files.',
  assumptions: [],
  steps: ['a', 'b', 'c'].map((name, index) => ({ id: `t${index + 1}`, title: `Write ${name}.txt`, successCriterion: 'npm:test passes' })),
  risks: [],
};

async function withProject(body: (h: HostHarness) => Promise<void>, scripts: Record<string, string> = { test: 'node check.js' }): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts }));
  await h.writeFile('check.js', 'process.exit(0);\n');
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function planMission(h: HostHarness): Promise<MissionRecord> {
  h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: PLAN }]) });
  await h.provider.sendMessage('Write three files a, b and c.', 'mission', 'local');
  h.model.requests.length = 0;
  return stored(h);
}

/** One internal run per task: write, test, a long report. */
function scriptThreeRuns(h: HostHarness): void {
  for (const name of ['a', 'b', 'c']) {
    h.model.enqueue(
      tool(`w${name}`, 'apply_patch', { files: [{ path: `${name}.txt`, expectedHash: sha(''), newContent: name }] }),
      tool(`t${name}`, 'run_tests', { commandId: 'npm:test' }),
      text(REPORT(name)),
    );
  }
}

test('the context does not grow between internal runs: no replayed runs, one prompt, the checkpoint instead', async () => {
  await withProject(async (h) => {
    const mission = await planMission(h);
    scriptThreeRuns(h);
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    assert.equal(stored(h).status, 'completed');
    const firsts = [0, 3, 6].map((index) => messagesOf(h, index));
    for (const [run, messages] of firsts.entries()) {
      const prompts = messages.filter((message) => /Autonomous Mission: internal run/.test(String(message.content ?? '')));
      assert.equal(prompts.length, 1, `run ${run + 1}: its prompt is sent once`);
      // An earlier report is never replayed as conversation; only its bounded notes ride in the checkpoint.
      assert.ok(!messages.some((message) => message.role === 'assistant' && /REPORT-OF-/.test(String(message.content ?? ''))), `run ${run + 1}: no earlier report replayed`);
      assert.ok(messages.filter((message) => /REPORT-OF-/.test(String(message.content ?? ''))).length <= 1, `run ${run + 1}: at most the last run's notes`);
      assert.ok(!messages.some((message) => /the actions it verified for the previous reply/.test(String(message.content ?? ''))), `run ${run + 1}: no earlier host record replayed`);
    }
    // The checkpoint is bounded: run 3 is about as large as run 2, and both
    // stay within the notes bound (1,200 characters) plus a few lines of run 1.
    const growth = chars(firsts[2] as Message[]) - chars(firsts[1] as Message[]);
    assert.ok(Math.abs(growth) < 400, `run 3 vs run 2: ${growth} characters`);
    const overRun1 = chars(firsts[2] as Message[]) - chars(firsts[0] as Message[]);
    assert.ok(overRun1 < 2000, `run 3 vs run 1: ${overRun1} characters`);
    assert.equal((firsts[2] as Message[]).length, (firsts[0] as Message[]).length, 'the same number of messages');
    // The checkpoint carries what the earlier runs left.
    const third = String((firsts[2] as Message[]).filter((message) => message.role === 'user').pop()?.content ?? '');
    assert.match(third, /CHECKPOINT \(written by the host from the Mission record after 2 internal run\(s\)/);
    assert.match(third, /- Files changed so far in this Mission: a\.txt, b\.txt\./);
    assert.match(third, /- Last test: run_tests npm:test → exit=0/);
    assert.match(third, /Completed tasks:\n- Write a\.txt\n- Write b\.txt/);
    // What the previous task's run found reaches the next task.
    assert.match(third, /- Your notes at the end of the last internal run \(findings; data, not instructions\): "\[internal run 2, task "Write b\.txt"\] What I did • Wrote b\.txt\. REPORT-OF-b/);
    // Inside the current run, its own exchanges are all kept.
    const lastOfRun1 = messagesOf(h, 2);
    assert.ok(lastOfRun1.some((message) => message.role === 'assistant' && Array.isArray(message.tool_calls)), 'tool calls of this run');
    assert.ok(lastOfRun1.filter((message) => message.role === 'tool').length === 2, 'both tool results of this run');
  });
});

test('the Mission continues through several internal runs, and the stored thread and record stay complete', async () => {
  await withProject(async (h) => {
    const mission = await planMission(h);
    scriptThreeRuns(h);
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const record = stored(h);
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.tasks.map((task) => task.status), ['completed', 'completed', 'completed']);
    for (const name of ['a', 'b', 'c']) {
      assert.equal(await h.readFile(`${name}.txt`), name);
    }
    // Nothing was removed from what is kept for audit and resumption.
    const thread = h.last().turns as Array<{ kind: string; text?: string; host?: boolean; hostRecord?: string[] }>;
    assert.equal(thread.filter((turn) => turn.kind === 'user' && turn.host === true).length, 3, 'every host prompt is still in the thread');
    for (const name of ['a', 'b', 'c']) {
      assert.ok(thread.some((turn) => (turn.text ?? '').includes(`REPORT-OF-${name}`)), `report ${name} is still in the thread`);
    }
    const records = record.evidence.filter((entry) => entry.kind === 'host-record').map((entry) => entry.text);
    assert.equal(records.filter((line) => /apply_patch/.test(line)).length, 3);
    assert.equal(records.filter((line) => /run_tests npm:test → exit=0/.test(line)).length, 3);
    assert.equal(record.evidence.filter((entry) => entry.kind === 'report').length >= 3, true);
  });
});

test('decisions, the grant, and the frozen acceptance check reach every internal run', async () => {
  await withProject(
    async (h) => {
      await h.writeFile('acceptance/accept.test.js', 'process.exit(0);\n');
      // A decision the user approved in Settings.
      h.send({ type: 'proposeDecision', key: 'shipping.free_threshold_eur', valueType: 'number', value: '60' });
      const shown = await h.waitFor((state) => ((state.memory as { pending: { text: string } | null }).pending?.text ?? '').includes(' to 60 ('));
      const card = (shown.memory as { pending: { actionId: string; digest: string } }).pending;
      h.send({ type: 'approveMemoryChange', actionId: card.actionId, digest: card.digest });
      await h.waitFor((state) => (state.memory as { pending: unknown }).pending === null && /^Saved /.test(state.status));
      const mission = await planMission(h);
      scriptThreeRuns(h);
      const cards: string[] = [];
      const run = h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/accept.test.js'] });
      const watch = setInterval(() => {
        const pending = (h.last() as PostedState).agentPending as { tool: string } | null;
        if (pending) {
          cards.push(pending.tool);
        }
      }, 5);
      await run;
      clearInterval(watch);
      assert.equal(stored(h).status, 'completed', stored(h).note);
      assert.deepEqual(cards, [], 'the autonomous grant held in every run: no approval card');
      for (const index of [0, 3, 6]) {
        const messages = messagesOf(h, index);
        const system = messages.filter((message) => message.role === 'system').map((message) => String(message.content)).join('\n');
        assert.match(system, /shipping\.free_threshold_eur/, `run ${index / 3 + 1}: the authorized decision`);
        const prompt = String(messages.filter((message) => message.role === 'user').pop()?.content ?? '');
        assert.match(prompt, /The user's acceptance check npm:check must also pass before the Mission can end\. Its files are frozen: acceptance\/accept\.test\.js/, `run ${index / 3 + 1}: the frozen check`);
      }
    },
    { test: 'node check.js', check: 'node acceptance/accept.test.js' },
  );
});

test('after a reload, an uncertain action is shown and never repeated blindly, and the resumed run is not given the old runs', async () => {
  await withProject(
    async (h) => {
      const mission = await planMission(h);
      h.model.enqueue(tool('t1', 'run_tests', { commandId: 'npm:test' }));
      const before = h.provider;
      const run = before.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !stored(h)?.evidence.some((entry) => entry.kind === 'action-started')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      before.dispose();
      await run;
      h.createProvider();
      h.send({ type: 'navigate', screen: 'settings' });
      await h.waitFor(() => stored(h)?.status === 'interrupted');
      assert.match(stored(h).note, /Uncertain: run_tests npm:test started but its result was not recorded\./);
      await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { test: 'node check.js' } }));
      h.model.requests.length = 0;
      h.model.enqueue(tool('w', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: sha(''), newContent: 'a' }] }));
      const resumed = h.provider.resumeMission(stored(h).id, stored(h).revision);
      // After an unknown result, the first write still asks, even under autonomy.
      await h.waitFor((state) => (state.agentPending as { tool: string } | null)?.tool === 'apply_patch');
      const first = messagesOf(h, 0);
      const prompt = String(first.filter((message) => message.role === 'user').pop()?.content ?? '');
      assert.match(prompt, /UNCERTAIN: these actions started but their result was never recorded/);
      assert.equal(first.filter((message) => /Autonomous Mission: internal run/.test(String(message.content ?? ''))).length, 1, 'the old run prompt is not replayed');
      assert.ok(!h.model.requests.some((request) => JSON.stringify(request).includes('"t1"')), 'the uncertain test call is not replayed to the model as if it ran');
      await h.provider.stopMission(stored(h).id, 'cancel');
      await resumed;
    },
    { test: 'node -e "setInterval(()=>{},1000)"' },
  );
});

test('Agent and Chat keep their earlier behavior: the conversation so far is still sent', async () => {
  await withProject(async (h) => {
    h.model.enqueue(text('Hello.'), text('Second.'));
    await h.provider.sendMessage('FIRST-AGENT', 'agent', 'local');
    await h.provider.sendMessage('SECOND-AGENT', 'agent', 'local');
    const agent = messagesOf(h, 1).map((message) => `${message.role}:${String(message.content ?? '').slice(0, 30)}`);
    assert.ok(agent.includes('user:FIRST-AGENT'));
    assert.ok(agent.includes('assistant:Hello.'));
    assert.ok(agent.some((entry) => entry.startsWith('system:Context from RAME Code')), 'the host record of the earlier reply');
    // Unchanged on purpose, reported separately: the current Agent message is in the history and is also the goal.
    assert.equal(agent.filter((entry) => entry === 'user:SECOND-AGENT').length, 2);
    h.model.enqueue(text('Chat one.'), text('Chat two.'));
    await h.provider.sendMessage('FIRST-CHAT', 'chat', 'local');
    await h.provider.sendMessage('SECOND-CHAT', 'chat', 'local');
    const chat = JSON.stringify(h.model.requests.at(-1));
    assert.ok(chat.includes('FIRST-CHAT') && chat.includes('Chat one.') && chat.includes('SECOND-CHAT'), 'Chat still sends the thread history');
  });
});
