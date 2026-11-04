/**
 * Disclosure governance toward Meta, with simulated servers only and
 * fictitious markers: every check reads the complete request body the fake
 * Meta API received, not the plan for it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOUD_DISCLOSURE_KEY, loadDisclosure, planDisclosure, threadDisclosure, type DisclosureRequest } from '../src/cloudDisclosure.js';
import type { AuthorizedDecisionSummary } from '../src/continuityCheckpoint.js';
import { CloudEgressBlocked, guardCloudMessages, redactSecrets } from '../src/cloudEgress.js';
import { handleSendError } from '../src/generationController.js';
import { buildViewHtml } from '../src/viewHtml.js';
import { appendAssistantTurn, appendUserTurn, createThread, type ChatThread } from '../src/threadStore.js';
import { assistantText, fakeCloud, HostHarness, type PostedState } from './helpers/hostHarness.js';

const KEY = 'fake-meta-key-GOVERNANCE-4e2f';
type Card = { digest: string; askToolResults: boolean; messages: Array<{ text: string; hostRecord: string[] }>; decisions: Array<{ key: string; value: unknown }> };
const cardOf = (state: PostedState): Card | null => (state.remote as { disclosure: Card | null }).disclosure;
const sharingOf = (state: PostedState) => (state.remote as { sharing: { messages: number; decisions: string | null; toolResults: boolean | null } | null }).sharing;
const bodies = (from = 0): string => JSON.stringify(fakeCloud.requests.slice(from).map((request) => request.body));
const ok = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
const toolCall = (id: string, name: string, args: unknown) =>
  Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });

async function withHarness(body: (h: HostHarness) => Promise<void>, settings: Record<string, unknown> = {}): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true, ...settings });
  h.secretValues.set('rameCode.metaModelApiKey', KEY);
  fakeCloud.requests.length = 0;
  fakeCloud.handler = ok;
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node t.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await body(h);
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function local(h: HostHarness, text: string, mode: 'chat' | 'agent' = 'chat'): Promise<void> {
  h.model.enqueue({ kind: 'json', body: assistantText(`local reply: ${text}`) });
  await h.provider.sendMessage(text, mode, 'local');
}

/** Send to Meta; answer a card if one appears. Returns the card that was shown, if any. */
async function meta(h: HostHarness, text: string, mode: 'chat' | 'agent', choice: 'include' | 'withhold' | 'none' = 'include', toolResults?: boolean): Promise<Card | null> {
  const before = fakeCloud.requests.length;
  await h.provider.sendMessage(text, mode, 'cloud');
  const card = cardOf(h.last());
  if (card && choice !== 'none') {
    h.send({ type: 'disclosureDecide', digest: card.digest, choice, ...(toolResults === undefined ? {} : { toolResults }) });
    await h.waitFor((state) => fakeCloud.requests.length > before && !state.running, 8000);
  }
  return card;
}

async function decide(h: HostHarness, key: string, value: string, approve = true): Promise<void> {
  h.send({ type: 'navigate', screen: 'settings' });
  h.send({ type: 'proposeDecision', key, valueType: 'string', value });
  const shown = await h.waitFor((state) => ((state.memory as { pending: { text: string } | null }).pending?.text ?? '').includes(value));
  if (approve) {
    const card = (shown.memory as { pending: { actionId: string; digest: string } }).pending;
    h.send({ type: 'approveMemoryChange', actionId: card.actionId, digest: card.digest });
    await h.waitFor((state) => (state.memory as { pending: unknown }).pending === null && /^Saved /.test(state.status));
  }
  h.send({ type: 'navigate', screen: 'chat' });
}

// ----- What reaches Meta beyond the card -----

test('the project folder\'s absolute path never reaches Meta, in any message, with either answer', async () => {
  for (const choice of ['withhold', 'include'] as const) {
    await withHarness(async (h) => {
      await local(h, 'A local note.', 'agent');
      await meta(h, 'Agent request.', 'agent', choice, false);
      await meta(h, 'Chat request.', 'chat', choice);
      assert.ok(fakeCloud.requests.length >= 2);
      assert.equal(bodies().includes(h.workspace), false, choice);
      assert.equal(bodies().includes(h.root), false, choice);
      assert.match(bodies(), /PROJECT SCOPE: ws\./, 'only the folder name');
    });
  }
});

test('approved decisions reach Meta exactly as shown: never pending proposals, file bindings, or provenance', async () => {
  await withHarness(async (h) => {
    await decide(h, 'billing.currency', 'MK-APPROVED-VALUE');
    await decide(h, 'billing.next', 'MK-PENDING-VALUE', false);
    await local(h, 'A local note.', 'agent');
    let n = 0;
    fakeCloud.handler = () => (++n === 1 ? toolCall('d1', 'read_decisions', {}) : ok());
    const card = await meta(h, 'Agent request.', 'agent', 'include', false);
    assert.deepEqual(card?.decisions.map((entry) => [entry.key, entry.value]), [['billing.currency', 'MK-APPROVED-VALUE']]);
    const sent = bodies();
    assert.match(sent, /billing\.currency = \\"MK-APPROVED-VALUE\\" \(v1\)/);
    for (const unseen of ['MK-PENDING-VALUE', 'PENDING PROPOSALS', 'VERIFIED FILES', 'proposed by the user', 'approved by the user']) {
      assert.equal(sent.includes(unseen), false, unseen);
    }
    // The tool result of read_decisions is the same shared view, not the full snapshot.
    const toolMessage = (fakeCloud.requests[1]?.body.messages as Array<{ role: string; content: string }>).find((message) => message.role === 'tool');
    assert.ok(toolMessage);
  });
});

test('Meta is never told the local model id', async () => {
  await withHarness(async (h) => {
    h.provider.settings = { ...h.provider.settings, local: { ...h.provider.settings.local, modelId: 'glimmer-private-build-42' } };
    await local(h, 'A local note.');
    await meta(h, 'To Meta.', 'chat', 'include');
    assert.equal(bodies().includes('glimmer-private-build-42'), false);
    assert.match(bodies(), /previous replies came from a local model/);
  });
});

// ----- Agent tool results: session scope, redaction, revocation -----

test('Agent with Meta asks about tool results per session; without consent the results never leave', async () => {
  await withHarness(async (h) => {
    await h.writeFile('data.txt', 'MK-FILE-CONTENT\n');
    let n = 0;
    fakeCloud.handler = () => (++n % 2 === 1 ? toolCall(`r${n}`, 'read_file', { path: 'data.txt', maxBytes: 4096 }) : ok());
    const card = await meta(h, 'Read data.txt.', 'agent', 'include', false);
    assert.equal(card?.askToolResults, true, 'the first Agent run with Meta asks, even with nothing else to show');
    assert.equal(bodies().includes('MK-FILE-CONTENT'), false);
    assert.match(bodies(), /Withheld by RAME Code: the user has not allowed tool results/);
    assert.ok(h.last().agentLog.some((entry) => entry.tool === 'meta_privacy' && /withheld 1 tool result/.test(entry.result)));
    // The answer holds for the session: no new card, still withheld.
    const before = fakeCloud.requests.length;
    assert.equal(await meta(h, 'Read it again.', 'agent'), null);
    assert.equal(bodies(before).includes('MK-FILE-CONTENT'), false);
    // A reload is a new session: asked again.
    const threadId = h.last().activeThreadId as string;
    h.createProvider();
    h.send({ type: 'openThread', threadId });
    await h.waitFor((state) => state.activeThreadId === threadId);
    const again = await meta(h, 'And after a reload.', 'agent', 'include', true);
    assert.equal(again?.askToolResults, true);
    assert.ok(bodies().includes('MK-FILE-CONTENT'), 'allowed now');
  });
});

test('allowed tool results are sent with secret-like values redacted, and Activity says so once', async () => {
  await withHarness(async (h) => {
    const secrets = [
      'AWS_ACCESS=AKIAABCDEFGHIJKLMNOP',
      'OPENAI=sk-ZZZZZZZZZZZZZZZZZZZZZZZZ',
      'DB_PASSWORD=hunter2hunter2',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl',
    ];
    await h.writeFile('config.txt', `name=demo\n${secrets.join('\n')}\n`);
    let n = 0;
    fakeCloud.handler = () => (++n <= 2 ? toolCall(`r${n}`, 'read_file', { path: 'config.txt', maxBytes: 4096 }) : ok());
    await meta(h, 'Read config.txt twice.', 'agent', 'include', true);
    const sent = bodies();
    assert.match(sent, /name=demo/, 'the rest of the result is sent');
    for (const value of ['AKIAABCDEFGHIJKLMNOP', 'sk-ZZZZZZZZZZZZZZZZZZZZZZZZ', 'hunter2hunter2', 'MIIEvQIBADANBg', 'c2lnbmF0dXJlLXZhbHVl']) {
      assert.equal(sent.includes(value), false, value);
    }
    const notes = h.last().agentLog.filter((entry) => entry.tool === 'meta_privacy');
    assert.equal(notes.length, 1, 'one note, not one per model step');
    assert.match(notes[0]?.result ?? '', /redacted \d+ value\(s\) that look like secrets/);
    assert.deepEqual(redactSecrets('no secrets here').found, []);
  });
});

test('a delegated run\'s own approval covers its tool results; redaction still applies', async () => {
  await withHarness(async (h) => {
    await h.writeFile('config.txt', 'API_KEY=sk-DELEGATEDDELEGATEDDELEGATED\nplain=MK-PLAIN\n');
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.sendMessage('Read config.txt.', 'agent', 'local');
    let n = 0;
    fakeCloud.handler = () => (++n === 1 ? toolCall('r1', 'read_file', { path: 'config.txt', maxBytes: 4096 }) : ok());
    await h.provider.approveEscalation((h.last().remote as { delegation: { digest: string } }).delegation.digest);
    await h.waitFor((state) => !state.running && fakeCloud.requests.length >= 2, 8000);
    assert.equal(cardOf(h.last()), null, 'no second card: the delegation card listed tool output');
    assert.match(bodies(), /MK-PLAIN/);
    assert.equal(bodies().includes('sk-DELEGATEDDELEGATEDDELEGATED'), false);
  });
});

test('"Stop sharing with Meta" withdraws every answer: nothing more is sent until approved again', async () => {
  await withHarness(async (h) => {
    await local(h, 'MK-SHARED-ONCE local note.');
    await meta(h, 'To Meta.', 'chat', 'include');
    assert.deepEqual(sharingOf(h.last()), { messages: 2, decisions: null, toolResults: null });
    h.send({ type: 'disclosureStop' });
    await h.waitFor((state) => /^Stopped sharing this thread with Meta/.test(state.status));
    assert.match(h.last().status, /What Meta already received cannot be recalled\./);
    assert.equal(sharingOf(h.last()), null);
    const before = fakeCloud.requests.length;
    const card = await meta(h, 'Again.', 'chat', 'withhold');
    assert.ok(card?.messages.some((entry) => entry.text.includes('MK-SHARED-ONCE')), 'asked again');
    assert.equal(bodies(before).includes('MK-SHARED-ONCE'), false, 'not sent after the withdrawal');
    assert.equal((h.memento.get(CLOUD_DISCLOSURE_KEY) as { version: number }).version, 4);
  });
});

// ----- The check on the request actually built -----

test('the egress check stops a request that would carry undisclosed local text, and says nothing was sent', async () => {
  await withHarness(async (h) => {
    await local(h, 'MK-UNDISCLOSED a long enough local sentence to be recognised anywhere in a request.');
    await local(h, 'Another local note.');
    const threadId = h.last().activeThreadId as string;
    const leak = [{ role: 'system', content: 'Context: MK-UNDISCLOSED a long enough local sentence to be recognised anywhere in a request.' }, { role: 'user', content: 'Next.' }];
    assert.throws(() => guardCloudMessages(h.provider, threadId, 'Next.', leak), CloudEgressBlocked);
    assert.ok(h.last().agentLog.length === 0 || h.provider.agentLogView.some((entry) => entry.tool === 'meta_privacy'));
    // Disclosed text, Meta's own text, and the request pass; paths are replaced.
    const clean = guardCloudMessages(h.provider, threadId, 'Next.', [{ role: 'user', content: `Next. See ${h.workspace}/src/a.ts` }]);
    assert.equal(clean[0]?.content, 'Next. See <project folder>/src/a.ts');
    // A blocked request is reported as stopped by RAME, with nothing to retry or delegate.
    await handleSendError(h.provider, threadId, 'cloud', new CloudEgressBlocked('RAME Code stopped this request before sending it: test. Nothing was sent.'));
    await h.provider.postState();
    assert.match(h.last().status, /^RAME Code stopped this request before sending it/);
    assert.equal((h.last().remote as { delegation: unknown }).delegation, null);
    assert.equal(fakeCloud.requests.length, 0);
  });
});

test('the authorization digest binds the recipient, model, mode, delegation, roles, content, decisions, and the tool question', () => {
  let thread: ChatThread = createThread('Local one.', { now: 1, id: 't-digest', mode: 'chat' });
  thread = appendAssistantTurn(thread, 'Local two.', 2, undefined, { provider: 'local', model: 'g' });
  thread = appendUserTurn(thread, 'Now Meta.', 3);
  const record = threadDisclosure(loadDisclosure(undefined), 't-digest', { processing: 'standard', credential: 'none' });
  const none: { scopeId: string; list: AuthorizedDecisionSummary[] } = { scopeId: '', list: [] };
  const base: DisclosureRequest = { model: 'muse-spark-1.3', mode: 'chat', delegated: false, askToolResults: false };
  const digest = (overrides: Partial<DisclosureRequest>, t: ChatThread = thread, decisions = none) => planDisclosure(t, 'Now Meta.', record, decisions, { ...base, ...overrides }).digest;
  const original = digest({});
  assert.notEqual(digest({ model: 'muse-wonder-1.0' }), original);
  assert.notEqual(digest({ mode: 'agent' }), original);
  assert.notEqual(digest({ delegated: true }), original);
  assert.notEqual(digest({ askToolResults: true }), original);
  const roleChanged: ChatThread = { ...thread, turns: thread.turns.map((turn, index) => (index === 1 ? { kind: 'user', text: 'Local two.', timestamp: 2 } : turn)) };
  assert.notEqual(digest({}, roleChanged), original);
  assert.notEqual(digest({}, thread, { scopeId: 's', list: [{ key: 'k', version: 1, value: 'v', createdAt: 1 }] }), original);
  assert.equal(digest({}), original, 'deterministic');
  // Stored answers from an older format, or for another recipient, disclose nothing.
  assert.deepEqual(loadDisclosure({ version: 4, threads: [{ threadId: 't', recipient: 'other', processing: 'standard', credential: 'none', disclosed: [], withheld: [], decisions: null, updatedAt: 1 }] }).threads, []);
});

// ----- Coherence: notes, tools, memory position, accumulation, model switches -----

test('host notes are never offered or sent; retrieval statistics do not accumulate in later requests', async () => {
  await withHarness(async (h) => {
    await local(h, 'A local note.');
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.sendMessage('Delegate this.', 'agent', 'local');
    await h.provider.approveEscalation((h.last().remote as { delegation: { digest: string } }).delegation.digest);
    const first = cardOf(h.last()) as Card;
    h.send({ type: 'disclosureDecide', digest: first.digest, choice: 'withhold' });
    await h.waitFor((state) => !state.running && fakeCloud.requests.length >= 1, 8000);
    const before = fakeCloud.requests.length;
    const card = await meta(h, 'Chat after the delegated run.', 'chat', 'none');
    assert.equal(card, null, 'the delegation record is a host note: no card for it');
    assert.equal(bodies(before).includes('Delegated run approved'), false);
    assert.equal(bodies().includes('context_continuity'), false, 'RAME\'s retrieval statistics are never resent');
  });
});

test('Meta is offered only tools it can use, the last-step instruction matches, and memory precedes the request', async () => {
  await withHarness(async (h) => {
    await meta(h, 'Hello.', 'agent', 'include', false);
    const body = fakeCloud.requests[0]?.body as { tools: Array<{ function: { name: string } }>; tool_choice: string; messages: Array<{ role: string; content: string }> };
    assert.equal(body.tools.some((tool) => tool.function.name === 'search_history'), false);
    assert.equal(body.tool_choice, 'auto');
    const memoryAt = body.messages.findIndex((message) => /^Project memory:/.test(message.content ?? ''));
    const requestAt = body.messages.findIndex((message) => message.role === 'user' && message.content === 'Hello.');
    assert.ok(memoryAt > 0 && memoryAt < requestAt, `memory ${memoryAt}, request ${requestAt}`);
    assert.equal(body.messages.at(-1)?.content, 'Hello.', 'the request is the last message');
  });
});

test('Spark → Wonder → Spark reuses the answers (no card) and never widens them; new local content asks again', async () => {
  await withHarness(async (h) => {
    await h.writeFile('data.txt', 'MK-FILE\n');
    await local(h, 'MK-BATCH-ONE.');
    await meta(h, 'Spark, agent.', 'agent', 'include', false);
    for (const model of ['muse-wonder-1.0', 'muse-spark-1.3', 'muse-wonder-1.0']) {
      await h.provider.selectCloudModel(model);
      assert.equal(await meta(h, `To ${model}.`, 'agent'), null, model);
    }
    await local(h, 'MK-BATCH-TWO.');
    await h.provider.selectCloudModel('muse-spark-1.3');
    const card = await meta(h, 'Spark again.', 'chat', 'withhold');
    assert.deepEqual(card?.messages.map((entry) => entry.text), ['MK-BATCH-TWO.', 'local reply: MK-BATCH-TWO.']);
    assert.equal(bodies().includes('MK-BATCH-TWO'), false);
    assert.ok(bodies().includes('MK-BATCH-ONE'));
  });
});

test('the card and the sharing line: a session checkbox for tool results and a way to stop sharing', () => {
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js' });
  assert.match(html, /<label id="disclosureToolsRow" class="checkbox-row" hidden><input id="disclosureTools" type="checkbox">/);
  assert.match(html, /<p id="disclosureSharing" class="hint" hidden><span id="disclosureSharingText"><\/span> <button id="disclosureStop" type="button">Stop sharing with Meta<\/button><\/p>/);
});

test('approvals never accumulate: one request carries at most the bounded window, and the card lists every local message it sends', async () => {
  await withHarness(async (h) => {
    for (let index = 0; index < 10; index++) {
      await local(h, `MK-FIRST-${index} local note.`);
    }
    await meta(h, 'First to Meta.', 'chat', 'include');
    for (let index = 0; index < 6; index++) {
      await local(h, `MK-SECOND-${index} local note.`);
    }
    const before = fakeCloud.requests.length;
    const card = await meta(h, 'Second to Meta.', 'chat', 'include') as Card & { earlier: Array<{ text: string }> };
    assert.equal(card.messages.length, 12, 'the six new exchanges');
    assert.equal(card.messages.length + card.earlier.length, 20, 'new and earlier together stay within the bound');
    assert.ok(card.earlier.every((entry) => /MK-FIRST-[2-9]/.test(entry.text)), 'the earlier messages it lists are the ones it sends again');
    const sent = bodies(before);
    const localSent = (sent.match(/MK-(FIRST|SECOND)-\d/g) ?? []).length;
    assert.ok(localSent <= 40, `${localSent}`);
    assert.equal(/MK-FIRST-[01] /.test(sent), false, 'the oldest approvals fall out of the window: never resent');
    const listed = new Set([...card.messages, ...card.earlier].map((entry) => entry.text));
    for (const match of sent.matchAll(/(local reply: )?MK-(FIRST|SECOND)-\d local note\./g)) {
      assert.ok(listed.has(match[0]), `sent but not on the card: ${match[0]}`);
    }
  });
});

test('every displayed field is bound: a changed time voids a pending card and an earlier inclusion', () => {
  let thread: ChatThread = createThread('Local one.', { now: 1, id: 't-time', mode: 'chat' });
  thread = appendUserTurn(thread, 'Now Meta.', 3);
  const state = loadDisclosure(undefined);
  const request: DisclosureRequest = { model: 'muse-spark-1.3', mode: 'chat', delegated: false, askToolResults: false };
  const none = { scopeId: '', list: [] as AuthorizedDecisionSummary[] };
  const plan = planDisclosure(thread, 'Now Meta.', threadDisclosure(state, 't-time', { processing: 'standard', credential: 'none' }), none, request);
  const retimed: ChatThread = { ...thread, turns: thread.turns.map((turn, index) => (index === 0 ? { ...turn, timestamp: 2 } : turn)) };
  assert.notEqual(planDisclosure(retimed, 'Now Meta.', threadDisclosure(state, 't-time', { processing: 'standard', credential: 'none' }), none, request).digest, plan.digest);
});
