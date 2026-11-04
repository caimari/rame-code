/**
 * Governed memory: proposing or confirming the value of a decision never
 * saves it. Only the human act on the memory card saves it, bound to the
 * exact key, value and version (human validation of the 0.2.0 candidate:
 * "Confirm audio.process_locally = true. Propose this exact decision for my
 * approval" ended with the decision saved, and the user did not recognise
 * the generic "Approve action" card as the one that saves it).
 *
 * Reproduced with the simulated local model in a disposable folder, in each
 * permission profile: textual confirmations, no click, Reject, Cancel run,
 * a change of thread, and the explicit approval.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const KEY = 'audio.process_locally';
const FIRST = 'Propose a persistent project decision: all audio files must be processed locally. Do not modify any files. Wait for my approval.';
const SECOND = 'Confirm audio.process_locally = true. Propose this exact decision for my approval. Do not modify any files.';
type Decision = { key: string; value: string; version: number };
type Pending = NonNullable<PostedState['agentPending']>;

const propose = (id: string, userWords: string) => ({
  kind: 'json' as const,
  body: toolCallReply([{ id, name: 'propose_decision', args: { key: KEY, valueType: 'boolean', value: 'true', expectedVersion: 0, userWords, reason: 'The user asked to process audio locally.' } }]),
});

async function withProfile(profile: string, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: profile });
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function decisions(h: HostHarness): Promise<Decision[]> {
  h.send({ type: 'navigate', screen: 'settings' });
  const state = await h.waitFor((s) => s.screen === 'settings', 4000);
  h.send({ type: 'navigate', screen: 'chat' });
  await h.waitFor((s) => s.screen === 'chat', 4000);
  return ((state.memory as { decisions?: Decision[] }).decisions ?? []).filter((d) => d.key === KEY);
}

/** The user's two messages; returns the run waiting on the memory card. */
async function reachMemoryCard(h: HostHarness): Promise<{ run: Promise<void>; pending: Pending; threadId: string }> {
  // 1. The first request has no explicit true/false: the host refuses before any card.
  h.model.enqueue(propose('p1', 'all audio files must be processed locally'), { kind: 'json', body: assistantText('Please confirm: true or false?') });
  await h.provider.sendMessage(FIRST, 'agent', 'local');
  assert.equal(h.last().agentPending, null);
  assert.match(JSON.stringify(h.last().turns), /not proposed: the user's words do not state true or false explicitly/);
  assert.deepEqual(await decisions(h), [], 'nothing saved after the first message');
  // 2. The textual confirmation lets the model propose: a card, and still nothing saved.
  h.model.enqueue(propose('p2', 'Confirm audio.process_locally = true'));
  const run = h.provider.sendMessage(SECOND, 'agent', 'local');
  const state = await h.waitFor((s) => s.agentPending !== null, 8000);
  assert.deepEqual(await decisions(h), [], 'a confirmation in the conversation saves nothing');
  return { run, pending: state.agentPending as Pending, threadId: state.activeThreadId as string };
}

for (const profile of ['ask', 'safe-auto', 'workspace-full']) {
  test(`${profile}: a textual confirmation never saves; the memory card says it saves, and only its approval does`, async () => {
    await withProfile(profile, async (h) => {
      const { run, pending } = await reachMemoryCard(h);
      assert.equal(pending.tool, 'propose_decision');
      // The card names what approving does, with the exact key, value and version.
      assert.match(pending.bodyPreview, /\(v1\)\. Project: ws\. Proposed by the local model\.[^\n]*\nApproving saves this decision in the project's persistent memory\. Proposing it saved nothing\.\nProposal mem_/);
      assert.match(pending.bodyPreview, /Set audio\.process_locally from not set \(v0\) to true \(v1\)\./);
      assert.match(pending.bodyPreview, /Your words: "Confirm audio\.process_locally = true"/);
      h.model.enqueue({ kind: 'json', body: assistantText('Saved: audio.process_locally = true (v1). Files changed: none.') });
      await h.provider.approveAgentAction(pending.actionId, pending.digest);
      await run;
      const saved = await decisions(h);
      assert.deepEqual(saved.map((d) => [d.value, d.version]), [['true', 1]]);
      assert.match(JSON.stringify(h.last().turns), /committed audio\.process_locally v1 = true \(approved by you\)\. Saved: already approved and saved/);
      // The model is told it is saved, so it does not ask for approval again.
      const told = JSON.stringify(h.model.requests.at(-1)?.messages ?? []);
      assert.match(told, /already approved and saved, do not ask the user to approve it again/);
    });
  });

  test(`${profile}: Reject, Cancel run or another thread leaves memory unchanged`, async () => {
    await withProfile(profile, async (h) => {
      const rejected = await reachMemoryCard(h);
      await h.provider.rejectAgentAction(rejected.pending.actionId, rejected.pending.digest);
      await rejected.run;
      assert.deepEqual(await decisions(h), [], 'Reject');

      await h.provider.newThread();
      const cancelled = await reachMemoryCard(h);
      h.send({ type: 'cancel' });
      await cancelled.run;
      assert.deepEqual(await decisions(h), [], 'Cancel run');
      assert.equal(h.last().running, false, 'the message box is free');

      await h.provider.newThread();
      const moved = await reachMemoryCard(h);
      h.model.enqueue({ kind: 'json', body: assistantText('Not saved.') });
      await h.provider.newThread();
      await moved.run;
      assert.deepEqual(await decisions(h), [], 'a change of thread voids the card');
      // An approval sent after the card was voided authorizes nothing.
      await h.provider.approveAgentAction(moved.pending.actionId, moved.pending.digest);
      assert.deepEqual(await decisions(h), []);
    });
  });
}

test('a forged or replayed binding never saves, even with the exact card open', async () => {
  await withProfile('workspace-full', async (h) => {
    const { run, pending } = await reachMemoryCard(h);
    await h.provider.approveAgentAction(pending.actionId, 'f'.repeat(64));
    await h.provider.approveAgentAction('act_forged', pending.digest);
    assert.deepEqual(await decisions(h), []);
    assert.equal(h.provider.agentPending?.actionId, pending.actionId, 'the real card is still waiting');
    h.send({ type: 'cancel' });
    await run;
    assert.deepEqual(await decisions(h), []);
  });
});

test('the view: a memory card names what approving does (EN/ES); other cards keep their usual labels', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  type Node = { textContent: string; attributes: Record<string, string>; classes: Set<string> };
  const nodes: Record<string, Node> = {};
  const node = (): Node => {
    const made: Node = { textContent: '', attributes: {}, classes: new Set() };
    return Object.assign(made, {
      hidden: false, disabled: false, firstChild: null, dataset: {},
      classList: { add: (n: string) => made.classes.add(n), remove: (n: string) => made.classes.delete(n), contains: (n: string) => made.classes.has(n) },
      setAttribute(name: string, value: string) { made.attributes[name] = value; },
      getAttribute(name: string) { return made.attributes[name] ?? null; },
      addEventListener() {},
      appendChild() {},
      removeChild() {},
    });
  };
  const context = { window: {} as Record<string, unknown>, document: { getElementById: (id: string) => (nodes[id] ??= node()), createElement: () => node(), querySelectorAll: () => [] } };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  const remote = context.window.RAME_REMOTE as { init(h: unknown): void; render(data: unknown): void };
  const i18n = context.window.RAME_I18N as { translate(language: string, text: string): string };
  let language = 'en';
  const t = (text: string) => (language === 'en' ? text : i18n.translate('es', text));
  const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), t(text));
  remote.init({ vscode: { postMessage() {} }, t, tf, tHost: t, markPending: () => true, hold() {} });
  const show = async (tool: string | null) => {
    remote.render({ connection: 'working', escalation: { pending: false, reason: '' }, activeThreadId: 't', agentPending: tool ? { actionId: `act_${tool}`, tool } : null, remote: { consult: null, delegation: null, delegationFailure: null, localIssue: null, runtime: { local: 'running', cloud: 'configured', selected: 'local' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return [nodes['agent-pending-heading'].textContent, nodes.pendingApprove.textContent, nodes.pendingReject.textContent, nodes.agentBox.attributes['data-kind']];
  };
  assert.deepEqual(await show('propose_decision'), ['Save to project memory? — review the exact change', 'Save this decision', "Don't save", 'memory']);
  assert.deepEqual(await show('bind_artifact'), ['Save to project memory? — review the exact change', 'Save this verification', "Don't save", 'memory']);
  assert.deepEqual(await show('apply_patch'), ['Pending approval — review exact action', 'Approve action', 'Reject', 'action']);
  language = 'es';
  assert.deepEqual(await show('propose_decision'), ['¿Guardar en la memoria del proyecto? — revisa el cambio exacto', 'Guardar esta decisión', 'No guardar', 'memory']);
  const css = readFileSync('media/main.css', 'utf8');
  assert.match(css, /#agentBox\[data-kind="memory"\] \{\s*border-color:/);
});
