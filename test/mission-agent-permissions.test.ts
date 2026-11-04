/**
 * Mission and Agent permissions are independent. The Agent selector (Ask,
 * Safe auto, Workspace full) governs Agent messages only; a Mission is
 * governed by its own authorization card:
 *   - Supervised: reads run, every write and test waits for its card;
 *   - Autonomous workspace: the writes and tests of its grant run on their
 *     own; anything outside it (move, delete, chmod, memory...) waits for a
 *     card. The Agent profile neither narrows nor widens it.
 * An empty-project Mission still needs its second (verification)
 * authorization whatever the profile (mission-bootstrap*.test.ts).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const EMPTY = sha('');
const PLAN = { goal: 'Make check.test.js pass.', assumptions: [], steps: [{ id: 't1', title: 'Write final into a.txt', successCriterion: 'npm:test passes' }], risks: [] };
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord);
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });

async function mission(profile: string): Promise<{ h: HostHarness; record: MissionRecord }> {
  const h = new HostHarness();
  await h.start({ agentProfile: profile, mode: 'mission' });
  await h.writeFile('package.json', JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node check.test.js' } }));
  await h.writeFile('check.test.js', "require('node:assert').equal(require('node:fs').readFileSync('a.txt', 'utf8'), 'final');\n");
  await h.writeFile('old.txt', 'x');
  h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: PLAN }]) });
  await h.provider.sendMessage('Make check.test.js pass by writing final into a.txt.', 'mission', 'local');
  return { h, record: stored(h) };
}

/** Run the Mission, approving every card, and say which tools needed one. */
async function drive(h: HostHarness, run: Promise<void>): Promise<string[]> {
  const cards: string[] = [];
  let seen = '';
  let done = false;
  void run.then(() => (done = true), () => (done = true));
  const deadline = Date.now() + 20000;
  while (!done && Date.now() < deadline) {
    const pending = h.last()?.agentPending as PostedState['agentPending'];
    if (pending && pending.actionId !== seen) {
      seen = pending.actionId;
      cards.push(pending.tool);
      await h.provider.approveAgentAction(pending.actionId, pending.digest);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await run;
  return cards;
}

const script = (h: HostHarness) =>
  h.model.enqueue(
    tool('r', 'read_file', { path: 'check.test.js', maxBytes: 4096 }),
    tool('w', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: 'final' }] }),
    tool('t', 'run_tests', { commandId: 'npm:test' }),
    tool('m', 'move_file', { source: 'old.txt', destination: 'archive.txt', expectedHash: sha('x') }),
    tool('t2', 'run_tests', { commandId: 'npm:test' }),
    { kind: 'json', body: assistantText('Done. Files changed: a.txt, archive.txt.') },
  );

for (const profile of ['ask', 'safe-auto', 'workspace-full']) {
  test(`Agent profile ${profile} + Supervised Mission: reads run, every write and test asks (the Agent profile does not widen it)`, async () => {
    const { h, record } = await mission(profile);
    try {
      script(h);
      const cards = await drive(h, h.provider.startMission(record.id, record.revision, 'supervised', null));
      assert.deepEqual(cards, ['apply_patch', 'run_tests', 'move_file', 'run_tests'], `${profile}: writes and tests asked; the read did not`);
    } finally {
      h.provider.cancelRequest();
      await h.dispose();
    }
  });

  test(`Agent profile ${profile} + Autonomous workspace: the grant's writes and tests run alone; a move outside it still asks (the profile neither narrows nor widens it)`, async () => {
    const { h, record } = await mission(profile);
    try {
      script(h);
      const cards = await drive(h, h.provider.startMission(record.id, record.revision, 'autonomous-workspace', null, true));
      assert.deepEqual(cards, ['move_file'], `${profile}: only the action outside the grant asked`);
      // Model evidence names the Mission grant, not the Agent profile, for what the grant allowed.
      type Call = { tool: string; action: { approval: string | null } | null };
      const evidence = h.last().modelEvidence as { decisive: Array<{ toolCalls: Call[] }>; other: Array<{ toolCalls: Call[] }> };
      const approvals = [...evidence.decisive, ...evidence.other].flatMap((entry) => entry.toolCalls).filter((call) => call.tool === 'apply_patch' || call.tool === 'read_file').map((call) => call.action?.approval);
      assert.ok(approvals.length > 0 && approvals.every((approval) => approval === 'mission-grant'), JSON.stringify(approvals));
    } finally {
      h.provider.cancelRequest();
      await h.dispose();
    }
  });
}

test('an internal Mission run is recorded as Mission, so the thread never says "Mode changed to Agent"', async () => {
  const { h, record } = await mission('safe-auto');
  try {
    h.model.enqueue(
      tool('w', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: 'final' }] }),
      tool('t', 'run_tests', { commandId: 'npm:test' }),
      { kind: 'json', body: assistantText('Done. Files changed: a.txt.') },
    );
    await drive(h, h.provider.startMission(record.id, record.revision, 'autonomous-workspace', null, true));
    const turns = h.last().turns as Array<{ kind: string; mode?: string; host?: boolean }>;
    const internal = turns.filter((turn) => turn.kind === 'user' && turn.host === true);
    assert.ok(internal.length > 0);
    assert.ok(internal.every((turn) => turn.mode === 'mission'), JSON.stringify(internal.map((turn) => turn.mode)));
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('the view: in a Mission thread the permission chip shows the Mission permission and cannot be used; a new authorization card opens with web and Meta OFF', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  type Node = { hidden: boolean; disabled: boolean; checked: boolean; value: string; textContent: string; attributes: Record<string, string> };
  const nodes: Record<string, Node> = {};
  const node = (): Node => Object.assign({ hidden: false, disabled: false, checked: false, value: '', textContent: '', attributes: {} as Record<string, string> }, {
    dataset: {}, firstChild: null, options: [], classList: { add() {}, remove() {}, contains: () => false },
    setAttribute(this: Node, name: string, value: string) { this.attributes[name] = value; },
    getAttribute(this: Node, name: string) { return this.attributes[name] ?? null; },
    hasAttribute: () => false, removeAttribute() {}, addEventListener() {}, scrollIntoView() {}, focus() {}, appendChild() {}, removeChild() {}, querySelectorAll: () => [], closest: () => null,
  });
  const context = { window: {} as Record<string, unknown>, document: { getElementById: (id: string) => (nodes[id] ??= node()), createElement: () => node(), addEventListener() {}, querySelectorAll: () => [] }, setTimeout, clearTimeout };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/localServersUx.js', 'utf8'), context);
  const remote = context.window.RAME_REMOTE as { init(h: unknown): void; render(data: unknown): void };
  const t = (text: string) => text;
  const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), text);
  remote.init({ vscode: { postMessage() {} }, t, tf, tHost: t, markPending: () => true, hold() {} });
  const base = { activeThreadId: 't', connection: 'ready', escalation: { pending: false, reason: '' }, remote: { consult: null, delegation: null, delegationFailure: null, localIssue: null, runtime: { local: 'connected', cloud: 'configured', selected: 'local' } } };
  const render = async (data: unknown) => {
    remote.render(data);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  // A new authorization card: whatever was ticked on an earlier card, web and Meta start OFF.
  nodes.missionWebEnabled = node();
  nodes.missionWebEnabled.checked = true;
  nodes.missionConsults = node();
  nodes.missionConsults.value = '2';
  nodes.missionSetup = node();
  await render({ ...base, missionLive: { threadId: 't', missionId: 'mis_1', grant: null, setup: { bootstrap: false, awaitingVerification: false } } });
  assert.equal(nodes.missionWebEnabled.checked, false);
  assert.equal(nodes.missionConsults.value, '0');
  assert.equal(nodes.permissionChip.textContent, 'Mission: not authorized yet');
  // The user may then choose them on this card: they are not reset again for the same card.
  nodes.missionWebEnabled.checked = true;
  await render({ ...base, missionLive: { threadId: 't', missionId: 'mis_1', grant: null, setup: { bootstrap: false, awaitingVerification: false } } });
  assert.equal(nodes.missionWebEnabled.checked, true);
  // Authorized: the chip shows the Mission's permission and the Agent selector cannot be used there.
  nodes.missionSetup.hidden = true;
  await render({ ...base, missionLive: { threadId: 't', missionId: 'mis_1', grant: 'autonomous-workspace', setup: null } });
  assert.equal(nodes.permissionChip.textContent, 'Mission: autonomous');
  assert.equal(nodes.permissionBtn.disabled, true);
  assert.match(nodes.permissionBtn.attributes.title ?? '', /its own authorization/);
  // Leaving the Mission thread gives the selector back to Agent.
  await render({ ...base, missionLive: null });
  assert.equal(nodes.permissionBtn.disabled, false);
});
