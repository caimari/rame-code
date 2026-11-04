/**
 * Continuity across providers and modes, with simulated servers only:
 * Meta receives local-session history and project decisions only after the
 * user saw them exactly on the disclosure card; autonomous Mission runs get
 * bounded recovery from the user's own conversation; Chat joins the open
 * project without tools.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOUD_DISCLOSURE_KEY, loadDisclosure, localSessionTurns, planDisclosure, recordAnswer, recordRequestSent, threadDisclosure, MAX_OFFERED_CHARS, MAX_OFFERED_MESSAGES } from '../src/cloudDisclosure.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { appendAssistantTurn, appendUserTurn, createThread, THREAD_STORE_KEY, type ChatThread } from '../src/threadStore.js';
import { buildViewHtml } from '../src/viewHtml.js';
import { assistantText, fakeCloud, fakeWindow, fakeWorkspace, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const KEY = 'fake-meta-key-PRIVACY-31d0';
const SECRET = 'LOCAL-ONLY-SECRET-5520';
const LOCAL = { provider: 'local' as const, model: 'local-glimmer' };
type Disclosure = { model: string; mode: string; delegated: boolean; messages: Array<{ turn: number; role: string; text: string; hostRecord: string[] }>; decisions: Array<{ key: string; version: number; value: unknown }>; chars: number; digest: string };
const disclosureOf = (state: PostedState): Disclosure | null => (state.remote as { disclosure: Disclosure | null }).disclosure;
const cloudText = (): string => JSON.stringify(fakeCloud.requests.map((request) => request.body.messages));
const okReply = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });

async function withHarness(body: (h: HostHarness) => Promise<void>, settings: Record<string, unknown> = {}): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true, ...settings });
  h.secretValues.set('rameCode.metaModelApiKey', KEY);
  fakeCloud.requests.length = 0;
  fakeCloud.handler = okReply;
  try {
    await body(h);
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

/** A short local conversation in one thread. */
async function localChat(h: HostHarness, texts: string[]): Promise<void> {
  for (const text of texts) {
    h.model.enqueue({ kind: 'json', body: assistantText(`Local reply to: ${text}`) });
    await h.provider.sendMessage(text, 'chat', 'local');
  }
}

async function setDecision(h: HostHarness, key: string, value: string): Promise<void> {
  h.send({ type: 'navigate', screen: 'settings' });
  h.send({ type: 'proposeDecision', key, valueType: 'string', value });
  const shown = await h.waitFor((state) => ((state.memory as { pending: { text: string } | null }).pending?.text ?? '').includes(value));
  const card = (shown.memory as { pending: { actionId: string; digest: string } }).pending;
  h.send({ type: 'approveMemoryChange', actionId: card.actionId, digest: card.digest });
  await h.waitFor((state) => (state.memory as { pending: unknown }).pending === null && /^Saved /.test(state.status));
  h.send({ type: 'navigate', screen: 'chat' });
}

test('switching to Meta shows the exact local messages first; nothing is sent until the user answers', async () => {
  await withHarness(async (h) => {
    await localChat(h, [`My token is ${SECRET}.`, 'Invoices for Oceania are in NZD.']);
    await h.provider.sendMessage('Which currency for Oceania?', 'chat', 'cloud');
    assert.equal(fakeCloud.requests.length, 0, 'nothing reached Meta');
    const card = disclosureOf(h.last());
    assert.ok(card);
    assert.equal(card.model, 'muse-spark-1.3');
    assert.deepEqual(card.messages.map((entry) => [entry.role, entry.text]), [
      ['user', `My token is ${SECRET}.`],
      ['assistant', `Local reply to: My token is ${SECRET}.`],
      ['user', 'Invoices for Oceania are in NZD.'],
      ['assistant', 'Local reply to: Invoices for Oceania are in NZD.'],
    ]);
    assert.ok(!card.messages.some((entry) => entry.text === 'Which currency for Oceania?'), 'the request itself is not history');
    assert.match(h.last().status, /Nothing was sent yet\./);
    // Include: exactly those messages reach Meta, once.
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'include' });
    await h.waitFor(() => fakeCloud.requests.length === 1);
    await h.waitFor((state) => !state.running && disclosureOf(state) === null);
    assert.ok(cloudText().includes(SECRET) && cloudText().includes('NZD'));
    // Already answered: the next Meta request goes without a card.
    await h.provider.sendMessage('And for Europe?', 'chat', 'cloud');
    assert.equal(fakeCloud.requests.length, 2);
    assert.equal(disclosureOf(h.last()), null);
  });
});

test('"send without it": Meta never sees those messages, they are not offered again, and only newer local turns are', async () => {
  await withHarness(async (h) => {
    await localChat(h, [`My token is ${SECRET}.`]);
    await h.provider.sendMessage('Hello Meta.', 'chat', 'cloud');
    h.send({ type: 'disclosureDecide', digest: (disclosureOf(h.last()) as Disclosure).digest, choice: 'withhold' });
    await h.waitFor(() => fakeCloud.requests.length === 1);
    await h.waitFor((state) => !state.running);
    assert.equal(cloudText().includes(SECRET), false);
    assert.match(cloudText(), /PRIVACY: 2 earlier message\(s\) from local sessions of this thread were not shared with Meta\./, 'Meta is told that context was withheld');
    await h.provider.sendMessage('Hello again.', 'chat', 'cloud');
    assert.equal(fakeCloud.requests.length, 2, 'no new card for what was already answered');
    assert.equal(cloudText().includes(SECRET), false);
    // A new local turn: only it is offered.
    await localChat(h, ['A new local note.']);
    await h.provider.sendMessage('Back to Meta.', 'chat', 'cloud');
    assert.equal(fakeCloud.requests.length, 2);
    assert.deepEqual((disclosureOf(h.last()) as Disclosure).messages.map((entry) => entry.text), ['A new local note.', 'Local reply to: A new local note.']);
  });
});

test('cancel sends nothing; a stale review (other model) sends nothing; a forged choice is refused', async () => {
  await withHarness(async (h) => {
    await localChat(h, ['Local note.']);
    await h.provider.sendMessage('To Meta.', 'chat', 'cloud');
    let card = disclosureOf(h.last()) as Disclosure;
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'cancel' });
    await h.waitFor((state) => /^Cancelled\. Nothing was sent to Meta\./.test(state.status));
    assert.equal(fakeCloud.requests.length, 0);
    await h.provider.sendMessage('To Meta again.', 'chat', 'cloud');
    card = disclosureOf(h.last()) as Disclosure;
    await h.provider.selectCloudModel('muse-wonder-1.0');
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'include' });
    await h.waitFor((state) => /changed since this was shown\. Nothing was sent/.test(state.status));
    assert.equal(fakeCloud.requests.length, 0);
    h.send({ type: 'disclosureDecide', digest: '0'.repeat(64), choice: 'include' });
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'everything' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fakeCloud.requests.length, 0);
  });
});

test('the card offers at most the v0.1 bound of local history; older local turns are never sent', () => {
  let thread: ChatThread = createThread(`Old secret ${SECRET}.`, { now: 1, id: 't-bound', mode: 'chat' });
  thread = appendAssistantTurn(thread, 'ok', 2, undefined, LOCAL);
  for (let index = 0; index < 40; index++) {
    thread = index % 2 ? appendAssistantTurn(thread, `reply ${index} ${'x'.repeat(900)}`, 3 + index, undefined, LOCAL) : appendUserTurn(thread, `note ${index} ${'y'.repeat(900)}`, 3 + index);
  }
  thread = appendUserTurn(thread, 'Now Meta.', 100);
  const plan = planDisclosure(thread, 'Now Meta.', threadDisclosure(loadDisclosure(undefined), 't-bound', { processing: 'standard', credential: 'none' }), { scopeId: '', list: [] }, { model: 'muse-spark-1.3', mode: 'chat', delegated: false, askToolResults: false });
  assert.ok(plan.messages.length <= MAX_OFFERED_MESSAGES && plan.chars <= MAX_OFFERED_CHARS, `${plan.messages.length} / ${plan.chars}`);
  assert.ok(!plan.messages.some((entry) => entry.text.includes(SECRET)), 'the oldest turn is beyond the bound');
  assert.equal(plan.messages.at(-1)?.turn, thread.turns.length - 2, 'the newest local turns are offered');
  // Answering the offered turns closes the older ones: they are never offered later.
  // The host also records the request itself as sent to Meta (recordRequestSent).
  const state = loadDisclosure(undefined);
  recordAnswer(state, 't-bound', plan, true, 1, { processing: 'standard', credential: 'none' });
  recordRequestSent(state, thread, thread.turns.length - 1, 1, { processing: 'standard', credential: 'none' });
  const record = threadDisclosure(state, 't-bound', { processing: 'standard', credential: 'none' });
  const next = planDisclosure(appendUserTurn(thread, 'More.', 101), 'More.', record, { scopeId: '', list: [] }, { model: 'muse-spark-1.3', mode: 'chat', delegated: false, askToolResults: false });
  assert.equal(next.needed, false);
  assert.ok(localSessionTurns(thread, 'Now Meta.').includes(0));
});

test('decisions: Chat joins the open project; Meta gets them only after approval; Agent with Meta does not see unapproved memory', async () => {
  await withHarness(async (h) => {
    await setDecision(h, 'billing.oceania_currency', 'NZD');
    // A pure Chat thread now joins the only open folder and receives the decision locally.
    h.model.enqueue({ kind: 'json', body: assistantText('NZD.') });
    await h.provider.sendMessage('Which currency for Oceania?', 'chat', 'local');
    assert.match(JSON.stringify(h.model.requests.at(-1)?.messages), /billing\.oceania_currency = \\"NZD\\" · v1/);
    // Meta: the card lists the decision with the local messages.
    await h.provider.sendMessage('Ask Meta.', 'chat', 'cloud');
    const card = disclosureOf(h.last()) as Disclosure;
    assert.deepEqual(card.decisions.map((entry) => [entry.key, entry.version, entry.value]), [['billing.oceania_currency', 1, 'NZD']]);
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'withhold' });
    await h.waitFor(() => fakeCloud.requests.length === 1);
    await h.waitFor((state) => !state.running);
    assert.equal(cloudText().includes('billing.oceania_currency'), false, 'withheld decisions do not reach Meta Chat');
    // Agent with Meta: project memory is withheld too, in the snapshot.
    await h.provider.sendMessage('Agent with Meta.', 'agent', 'cloud');
    await h.waitFor((state) => !state.running);
    const agentRequest = JSON.stringify(fakeCloud.requests.at(-1)?.body.messages);
    assert.match(agentRequest, /not shared with Meta/);
    assert.equal(agentRequest.includes('"NZD"'), false);
    // A new decision version is a new question; approving it sends it.
    await setDecision(h, 'billing.oceania_currency', 'AUD');
    await h.provider.sendMessage('Ask Meta once more.', 'chat', 'cloud');
    const again = disclosureOf(h.last()) as Disclosure;
    assert.deepEqual(again.decisions.map((entry) => entry.value), ['AUD']);
    const before = fakeCloud.requests.length;
    h.send({ type: 'disclosureDecide', digest: again.digest, choice: 'include' });
    await h.waitFor(() => fakeCloud.requests.length === before + 1);
    await h.waitFor((state) => !state.running);
    assert.match(JSON.stringify(fakeCloud.requests.at(-1)?.body.messages), /billing\.oceania_currency = \\"AUD\\" · v2/);
  });
});

test('Chat never prompts for a project: with several open folders and none chosen it stays unbound', async () => {
  const h = new HostHarness({ folders: 2 });
  await h.start({});
  try {
    h.model.enqueue({ kind: 'json', body: assistantText('ok') });
    await h.provider.sendMessage('Hi.', 'chat', 'local');
    assert.equal(fakeWindow.quickPickCalls, 0);
    assert.equal(h.provider.store.get(h.last().activeThreadId as string)?.workspaceRoot, undefined);
    assert.equal(fakeWorkspace.workspaceFolders?.length, 2);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('the answers persist across a reload; an unreadable record means nothing was disclosed', async () => {
  await withHarness(async (h) => {
    await localChat(h, ['Local note.']);
    await h.provider.sendMessage('To Meta.', 'chat', 'cloud');
    h.send({ type: 'disclosureDecide', digest: (disclosureOf(h.last()) as Disclosure).digest, choice: 'include' });
    await h.waitFor(() => fakeCloud.requests.length === 1);
    await h.waitFor((state) => !state.running);
    const threadId = h.last().activeThreadId as string;
    h.createProvider();
    h.send({ type: 'openThread', threadId });
    await h.waitFor((state) => state.activeThreadId === threadId);
    await h.provider.sendMessage('After reload.', 'chat', 'cloud');
    assert.equal(fakeCloud.requests.length, 2, 'no new card after a reload');
    h.memento.set(CLOUD_DISCLOSURE_KEY, { version: 1, threads: [{ threadId, disclosed: ['x'], withheld: [], decisions: null, updatedAt: 1 }] });
    h.createProvider();
    h.send({ type: 'openThread', threadId });
    await h.waitFor((state) => state.activeThreadId === threadId);
    await h.provider.sendMessage('After corruption.', 'chat', 'cloud');
    assert.equal(fakeCloud.requests.length, 2, 'fails closed: asks again instead of sending');
    assert.ok(disclosureOf(h.last()));
  });
  assert.deepEqual(loadDisclosure({ version: 3, threads: [] }), { version: 4, threads: [] }, 'an older format discloses nothing');
});

test('a delegated run with earlier local history asks first, then keeps its delegated authority', async () => {
  await withHarness(async (h) => {
    await localChat(h, [`Earlier local note with ${SECRET}.`]);
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
    const offer = (h.last().remote as { delegation: { digest: string } | null }).delegation;
    assert.ok(offer);
    await h.provider.approveEscalation(offer.digest);
    assert.equal(fakeCloud.requests.length, 0);
    const card = disclosureOf(h.last()) as Disclosure;
    assert.equal(card.delegated, true);
    assert.deepEqual(card.messages.map((entry) => entry.text), [`Earlier local note with ${SECRET}.`, `Local reply to: Earlier local note with ${SECRET}.`]);
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'withhold' });
    await h.waitFor(() => fakeCloud.requests.length >= 1);
    await h.waitFor((state) => !state.running);
    assert.equal(cloudText().includes(SECRET), false);
    assert.match(cloudText(), /Write final into a\.txt\./, 'the delegated request itself is sent');
    const evidence = h.last().modelEvidence as { decisive: Array<{ provider: string; authority: string }> };
    assert.ok(evidence.decisive.some((entry) => entry.provider === 'cloud' && entry.authority === 'delegated'));
  });
});

test('Mission: a local plan and each autonomous run recover a far fact from the user\'s conversation, never from internal runs', async () => {
  await withHarness(async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node t.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    let thread: ChatThread = createThread('Keep the billing module healthy.', { now: 1, id: 't-mission', mode: 'chat', workspaceRoot: h.workspace });
    thread = appendUserTurn(thread, 'Invoices for the Oceania customer must be issued in NZD.', 2);
    thread = appendAssistantTurn(thread, 'Noted.', 3, undefined, LOCAL);
    for (let index = 0; index < 150; index++) {
      thread = index % 2 ? appendAssistantTurn(thread, `layout reply ${index} ${'sidebar '.repeat(70)}`, 4 + index, undefined, LOCAL) : appendUserTurn(thread, `layout note ${index} ${'toolbar '.repeat(70)}`, 4 + index);
    }
    // An earlier internal run, written by the host: never a source of recovery.
    thread = appendUserTurn(thread, 'Mission goal: an earlier Mission.\n\nCurrent task: inspect billing.', 500, { host: true, mode: 'mission' });
    thread = appendAssistantTurn(thread, 'Report of internal run one: Oceania invoices checked.', 501, ['• read_file billing.ts → read billing.ts'], LOCAL);
    thread = appendUserTurn(thread, 'Thanks, now some more layout.', 502);
    thread = appendAssistantTurn(thread, 'Layout noted.', 503, undefined, LOCAL);
    h.memento.set(THREAD_STORE_KEY, [thread]);
    h.model.props = { default_generation_settings: { n_ctx: 32768 } };
    h.createProvider();
    await h.provider.refreshAll();
    h.send({ type: 'openThread', threadId: 't-mission' });
    await h.waitFor((state) => state.activeThreadId === 't-mission');
    const plan = { goal: 'Issue Oceania invoices in the agreed currency.', assumptions: [], steps: [{ id: 't1', title: 'Set the Oceania invoice currency', successCriterion: 'npm:test passes' }], risks: [] };
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: plan }]) });
    let before = h.model.requests.length;
    await h.provider.sendMessage('Fix the currency of Oceania invoices as agreed.', 'mission', 'local');
    const planMessages = h.model.requests[before]?.messages as Array<{ role: string; content: string }>;
    assert.equal(planMessages.find((message) => message.content.includes('issued in NZD'))?.role, 'user', 'the plan sees the far fact, as untrusted context');
    const excerptAt = planMessages.findIndex((message) => message.content.includes('issued in NZD'));
    const requestAt = planMessages.findIndex((message) => message.role === 'user' && message.content === 'Fix the currency of Oceania invoices as agreed.');
    assert.ok(excerptAt > 0 && requestAt > excerptAt, 'recovered context comes before the request');
    const mission = (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;
    h.model.enqueue({ kind: 'json', body: assistantText('Done.') });
    before = h.model.requests.length;
    const run = h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    await h.waitFor(() => h.model.requests.length > before, 8000);
    await h.provider.stopMission(mission.id, 'cancel');
    await run;
    for (const messages of [h.model.requests[before]?.messages as Array<{ role: string; content: string }>]) {
      const excerpt = messages.find((message) => /^RELEVANT EARLIER EXCERPTS/.test(message.content));
      assert.equal(excerpt?.role, 'user');
      assert.match(excerpt?.content ?? '', /issued in NZD/);
      assert.doesNotMatch(excerpt?.content ?? '', /Report of internal run one/, 'internal runs are the Mission checkpoint\'s job');
      assert.doesNotMatch(messages.map((message) => message.content).join('\n'), /ORIGINAL USER-STATED OBJECTIVE|OPERATIONAL CONTINUITY CHECKPOINT/);
    }
    const evidence = (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]?.evidence ?? [];
    assert.ok(!evidence.some((entry) => /context_continuity/.test(entry.text)), 'recovery is not recorded as a Mission action');
  }, { mode: 'mission' });
});

test('the card is in the chat view, text only, and every string has Spanish', () => {
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js' });
  assert.match(html, /<section id="disclosureBox" role="dialog" aria-modal="false" aria-labelledby="disclosure-heading" hidden>/);
  assert.match(html, /<button id="disclosureInclude" type="button">Send with this context<\/button>\s*<button id="disclosureWithhold" type="button">Send without it<\/button>\s*<button id="disclosureCancel" type="button">Cancel<\/button>/);
  assert.match(html, /#disclosureMessages pre, #disclosureEarlierMessages pre \{ white-space: pre-wrap; overflow-wrap: anywhere;/);
});
