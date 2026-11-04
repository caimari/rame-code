/**
 * An approval card never traps the user (human validation of e383ea4: the
 * card was cut off, "+" seemed blocked, and leaving the thread and coming
 * back left everything stuck):
 *   - the card's details scroll inside it, and its Approve / Reject /
 *     Cancel run buttons stay in the card at any panel width or height;
 *   - Cancel run stops the run at once: nothing is done, the conversation is
 *     kept, and the message box is free to send the next message;
 *   - leaving a card's thread ("+", the list, another thread) voids that
 *     card and nothing runs (security invariant, local-servers-hardening);
 *     "+" is never blocked by it. A card the model asks again meanwhile
 *     waits in its own thread: the other threads say where, with a way
 *     back, and opening that thread shows it whole and approvable (before,
 *     opening it voided it again and the run stayed stuck).
 * Simulated model only; no network.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { buildViewHtml } from '../src/viewHtml.js';
import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

type Pending = NonNullable<PostedState['agentPending']>;
type Waiting = { threadId: string; title: string } | null;
const waitingOf = (state: PostedState): Waiting => (state.remote as { waitingElsewhere?: Waiting }).waitingElsewhere ?? null;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const ORIGINAL = `export const label = 'Your words';\n${'// filler line to make the change long\n'.repeat(200)}`;

async function withHarness(body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto' });
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

/** A run waiting on a long replace_in_file card. */
async function longCard(h: HostHarness, text: string): Promise<{ run: Promise<void>; pending: Pending; threadId: string }> {
  await h.writeFile('label.js', ORIGINAL);
  h.model.enqueue({
    kind: 'json',
    body: toolCallReply([{ id: 'r1', name: 'replace_in_file', args: { path: 'label.js', expectedHash: sha(ORIGINAL), oldText: ORIGINAL, newText: ORIGINAL.replace('Your words', 'Tus palabras') } }]),
  });
  const run = h.provider.sendMessage(text, 'agent', 'local');
  const state = await h.waitFor((s) => s.agentPending !== null, 8000);
  return { run, pending: state.agentPending as Pending, threadId: state.activeThreadId as string };
}

test('Cancel run on a long card frees the message box at once: nothing is done and the conversation is kept', async () => {
  await withHarness(async (h) => {
    const { run, pending, threadId } = await longCard(h, 'Translate the label in label.js.');
    assert.ok(pending.bodyPreview.length > 2000, `a long card (${pending.bodyPreview.length} characters shown)`);
    assert.equal(h.last().running, true, 'the message box is held while the card waits');
    h.send({ type: 'cancel' });
    await run;
    const state = h.last();
    assert.equal(state.running, false, 'the message box is free');
    assert.equal(state.agentPending, null);
    assert.equal(state.connection, 'cancelled');
    assert.equal(await h.readFile('label.js'), ORIGINAL, 'the action was not done');
    assert.equal(h.model.requests.length, 1, 'nothing more was asked of the model');
    assert.equal(state.activeThreadId, threadId);
    assert.ok(state.turns.some((turn) => turn.text === 'Translate the label in label.js.'), 'the user message is kept');
    assert.equal(state.turns.at(-1)?.message, 'Request cancelled.');
    // The next message goes through normally, in the same thread.
    h.model.enqueue({ kind: 'json', body: assistantText('Here is a summary instead.') });
    await h.provider.sendMessage('Just summarise label.js.', 'agent', 'local');
    assert.equal(h.last().running, false);
    assert.match(h.last().turns.at(-1)?.text ?? '', /summary instead/);
    assert.equal(h.last().activeThreadId, threadId);
  });
});

test('"+" while a card waits: the card is voided, nothing runs; a card asked again waits in its thread, is announced elsewhere, and is whole and approvable on return', async () => {
  await withHarness(async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText('first thread reply') });
    await h.provider.sendMessage('First thread.', 'agent', 'local');
    const firstThread = h.last().activeThreadId as string;
    await h.provider.newThread();
    const { run, pending, threadId } = await longCard(h, 'Translate the label please.');
    assert.notEqual(threadId, firstThread);
    // The model asks again for the same change after the first card is voided.
    const again = toolCallReply([{ id: 'r2', name: 'replace_in_file', args: { path: 'label.js', expectedHash: sha(ORIGINAL), oldText: ORIGINAL, newText: ORIGINAL.replace('Your words', 'Tus palabras') } }]);
    h.model.enqueue({ kind: 'json', body: again });

    // "+" is not blocked: a new thread opens, the first card is voided and nothing ran.
    h.send({ type: 'newThread' });
    const away = await h.waitFor((s) => s.activeThreadId === null && waitingOf(s) !== null, 8000);
    assert.equal(away.agentPending, null, 'no card is shown outside its thread');
    assert.equal(await h.readFile('label.js'), ORIGINAL, 'the voided card did nothing');
    const second = h.provider.agentPending as unknown as Pending;
    assert.ok(second && second.actionId !== pending.actionId, 'the model asked again: a new card');
    assert.deepEqual(waitingOf(away), { threadId, title: (away.threads as Array<{ id: string; title: string }>).find((entry) => entry.id === threadId)?.title }, 'the new thread says where a run waits');

    // "Open that thread": the card is shown whole and not voided again (that loop left the run stuck).
    h.send({ type: 'openThread', threadId });
    const back = await h.waitFor((s) => s.activeThreadId === threadId && s.agentPending !== null, 4000);
    assert.equal(back.agentPending?.actionId, second.actionId);
    assert.ok((back.agentPending?.bodyPreview.length ?? 0) > 2000, 'the long body is offered');
    assert.equal(waitingOf(back), null);
    h.model.enqueue({ kind: 'json', body: assistantText('Changed the label. Files changed: label.js.') });
    await h.provider.approveAgentAction(back.agentPending?.actionId as string, back.agentPending?.digest as string);
    await run;
    assert.equal(await h.readFile('label.js'), ORIGINAL.replace('Your words', 'Tus palabras'));
    assert.equal(h.last().running, false, 'the message box is free');
    assert.match(JSON.stringify(h.last().turns), /active thread changed/, 'the voided first card is on record');
  });
});

test('a waiting card cannot be approved with a forged binding, and opening another thread voids it: nothing runs', async () => {
  await withHarness(async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText('first thread reply') });
    await h.provider.sendMessage('First thread.', 'agent', 'local');
    const firstThread = h.last().activeThreadId as string;
    await h.provider.newThread();
    const { run, pending } = await longCard(h, 'Translate the label please.');
    await h.provider.approveAgentAction(pending.actionId, 'f'.repeat(64));
    assert.equal(h.provider.agentPending?.actionId, pending.actionId, 'a forged digest changes nothing');
    h.model.enqueue({ kind: 'json', body: assistantText('Okay, not changed.') });
    await h.provider.openThread(firstThread);
    await run;
    assert.equal(h.last().running, false);
    assert.equal(await h.readFile('label.js'), ORIGINAL);
  });
});

function document(): string {
  return buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js' });
}

test('long card, narrow panel: the details scroll inside the card and the three buttons stay in it', () => {
  const html = document();
  const card = html.slice(html.indexOf('<section id="agentBox"'), html.indexOf('</section>', html.indexOf('<section id="agentBox"')));
  // Details first, in their own scroller; the buttons after it, outside the scroller.
  assert.match(card, /<div id="pendingDetails">\s*<p id="pendingTool"[^]*<p id="pendingBody"[^]*<p id="pendingMeta"[^]*<\/div>\s*<div class="row" id="pendingActions">/);
  const buttons = card.slice(card.indexOf('<div class="row" id="pendingActions">'));
  assert.match(buttons, /id="pendingApprove"/);
  assert.match(buttons, /id="pendingReject"/);
  assert.match(buttons, /id="pendingCancel"[^>]*>Cancel run</);
  for (const source of [html, readFileSync('media/main.css', 'utf8')]) {
    // The scrolling conversation never squeezes a card below its content (that clipped it).
    assert.match(source, /#conversationSection > \*\s*\{\s*flex-shrink:\s*0;?\s*\}/);
    assert.match(source, /#agentBox\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*max-height:\s*max\(14em,\s*70vh\)/);
    assert.match(source, /#pendingDetails\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0[^}]*overflow-y:\s*auto[^}]*overflow-x:\s*hidden/);
    assert.match(source, /#agentBox > h3,\s*#agentBox > \.row\s*\{\s*flex:\s*0 0 auto;?\s*\}/);
    assert.match(source, /#pendingTargets,\s*#pendingMeta\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*overflow-y:\s*auto/);
    // Below ~280 px the composer toolbar cut off Send / Stop: the mode moves to a second row.
    assert.match(source, /@media \(max-width: 300px\) \{\s*(?:\/\*[^*]*\*\/\s*)?#composerToolbar\s*\{\s*grid-template-columns:\s*32px auto minmax\(0, 1fr\) 32px;?\s*\}\s*#modeSelect\s*\{\s*grid-column:\s*1 \/ 4;\s*grid-row:\s*2;\s*max-width:\s*none;?\s*\}/);
    // Buttons wrap on a narrow panel instead of running off the side.
    assert.match(source, /section\[role="dialog"\] \.row\s*\{\s*flex-wrap:\s*wrap;?\s*\}/);
  }
  // The way back to a waiting run sits with the message box, always in view.
  assert.match(html, /<footer id="composer-wrap">\s*<p id="waitingElsewhere" role="status" hidden><span id="waitingElsewhereText"><\/span> <button id="waitingElsewhereOpen" type="button">Open that thread<\/button><\/p>/);
});

test('the card view: Cancel run posts cancel, a new card is scrolled into view, and the way back opens the waiting thread (EN/ES)', async () => {
  type Node = { hidden: boolean; disabled: boolean; textContent: string; attributes: Record<string, string>; listeners: Array<() => void>; scrolled: number; dataset: Record<string, string>; classList: { add(): void; remove(): void } };
  const nodes: Record<string, Node> = {};
  const node = (): Node => ({
    hidden: false, disabled: false, textContent: '', attributes: {}, listeners: [], scrolled: 0, dataset: {}, classList: { add() {}, remove() {} },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    getAttribute(name: string) { return this.attributes[name] ?? null; },
    addEventListener(_type: string, listener: () => void) { this.listeners.push(listener); },
    scrollIntoView() { this.scrolled += 1; },
  } as Node);
  const context = {
    window: {} as { RAME_REMOTE?: { init(h: unknown): void; render(data: unknown): void }; RAME_I18N?: { translate(language: string, text: string): string } },
    document: { getElementById: (id: string) => (nodes[id] ??= node()), createElement: () => node(), querySelectorAll: () => [] },
  };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  const posted: unknown[] = [];
  const sent = () => JSON.parse(JSON.stringify(posted)) as unknown[];
  let language: 'en' | 'es' = 'en';
  const t = (text: string) => (language === 'en' ? text : (context.window.RAME_I18N?.translate('es', text) ?? text));
  const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), t(text));
  const markPending = (btn: Node) => { if (btn.disabled) return false; btn.disabled = true; return true; };
  context.window.RAME_REMOTE?.init({ vscode: { postMessage: (message: unknown) => posted.push(message) }, t, tf, tHost: t, markPending, hold() {} });
  const base = { connection: 'working', escalation: { pending: false, reason: '' } };
  const remote = (waitingElsewhere: Waiting) => ({ consult: null, delegation: null, delegationFailure: null, localIssue: null, runtime: { local: 'running', cloud: 'configured', selected: 'local' }, waitingElsewhere });
  const render = async (data: unknown) => {
    context.window.RAME_REMOTE?.render(data);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  await render({ ...base, activeThreadId: 't1', agentPending: { actionId: 'act_1' }, remote: remote(null) });
  assert.equal(nodes.agentBox.scrolled, 1, 'a new card is brought into view');
  assert.equal(nodes.pendingActions.scrolled, 1, 'and its buttons, even when the card is taller than the panel');
  assert.equal(nodes.pendingCancel.disabled, false);
  await render({ ...base, activeThreadId: 't1', agentPending: { actionId: 'act_1' }, remote: remote(null) });
  assert.equal(nodes.agentBox.scrolled, 1, 'the same card does not keep pulling the view');
  nodes.pendingCancel.listeners.forEach((listener) => listener());
  assert.deepEqual(sent(), [{ type: 'cancel' }]);
  nodes.pendingCancel.listeners.forEach((listener) => listener());
  assert.equal(posted.length, 1, 'one cancel per click while it is pending');

  await render({ ...base, activeThreadId: null, agentPending: null, remote: remote({ threadId: 't1', title: 'Translate the label' }) });
  assert.equal(nodes.waitingElsewhere.hidden, false);
  assert.equal(nodes.waitingElsewhereText.textContent, 'A run is waiting for your decision in "Translate the label". Its card is shown in that thread.');
  nodes.waitingElsewhereOpen.listeners.forEach((listener) => listener());
  assert.deepEqual(sent().at(-1), { type: 'openThread', threadId: 't1' });
  language = 'es';
  await render({ ...base, activeThreadId: null, agentPending: null, remote: remote({ threadId: 't1', title: 'Traducir la etiqueta' }) });
  assert.equal(nodes.waitingElsewhereText.textContent, 'Una ejecución espera tu decisión en «Traducir la etiqueta». Su tarjeta se muestra en ese hilo.');
  assert.equal(t('Cancel run'), 'Cancelar ejecución');
  assert.equal(t('Open that thread'), 'Abrir ese hilo');
  await render({ ...base, activeThreadId: 't1', agentPending: null, remote: remote(null) });
  assert.equal(nodes.waitingElsewhere.hidden, true);
  assert.equal(nodes.pendingCancel.disabled, true, 'nothing to cancel without a card');
});
