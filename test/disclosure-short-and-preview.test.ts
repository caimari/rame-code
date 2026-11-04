/**
 * Two disclosure checks the final egress check cannot make on its own, with
 * simulated servers and fictitious markers only; every assertion reads the
 * complete request bodies the fake Meta API received.
 *
 * - Short local texts: the final check recognises local text of 24
 *   characters or more. Shorter local messages must stay out by
 *   construction on every path (Chat, Agent, its tools, a delegated run, a
 *   Mission plan, project memory).
 * - The Agent card previews earlier messages as Agent sends them (shortened
 *   past 4,000 characters), so it never shows more than Meta receives.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { agentSentText, AGENT_HISTORY_TEXT_LIMIT, historyText } from '../src/agentHistoryText.js';
import { assistantText, fakeCloud, HostHarness, type PostedState } from './helpers/hostHarness.js';

const KEY = 'fake-meta-key-SHORT-PREVIEW-7a1c';
type Card = { digest: string; mode: string; messages: Array<{ text: string }>; earlier: Array<{ text: string }>; chars: number };
const cardOf = (state: PostedState): Card | null => (state.remote as { disclosure: Card | null }).disclosure;
const bodies = (from = 0): string => JSON.stringify(fakeCloud.requests.slice(from).map((request) => request.body));
const contents = (from = 0): string[] =>
  fakeCloud.requests.slice(from).flatMap((request) => ((request.body as { messages?: Array<{ content: unknown }> }).messages ?? []).map((message) => String(message.content)));
const ok = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
const toolCall = (id: string, name: string, args: unknown) =>
  Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });

async function withHarness(body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true });
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
  h.model.enqueue({ kind: 'json', body: assistantText(`ok ${text}`) });
  await h.provider.sendMessage(text, mode, 'local');
}

/** Wait for the request to settle, answering "withhold" for local messages to any card shown. */
async function settleWithholding(h: HostHarness, before: number, toolResults = false): Promise<Card[]> {
  const cards: Card[] = [];
  for (let round = 0; round < 3; round += 1) {
    const state = await h.waitFor((s) => !s.running || cardOf(s) !== null, 8000);
    const card = cardOf(state);
    if (card === null) {
      break;
    }
    cards.push(card);
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'withhold', toolResults });
    await h.waitFor((s) => cardOf(s)?.digest !== card.digest && (fakeCloud.requests.length > before || !s.running), 8000);
  }
  await h.waitFor((s) => !s.running, 8000);
  return cards;
}

test('local texts shorter than the final check\'s window never reach Meta on any path', async () => {
  await withHarness(async (h) => {
    // Every local text below is under 24 characters, replies included ("ok …").
    const markers = ['MK-SA1', 'MK-SA2', 'MK-SA3', 'MK-SB1', 'MK-SC1'];
    await local(h, 'pin MK-SA1');
    await local(h, 'code MK-SA2', 'agent');
    // A proposed, unapproved decision with a short value.
    h.send({ type: 'navigate', screen: 'settings' });
    h.send({ type: 'proposeDecision', key: 'billing.currency', valueType: 'string', value: 'MK-SB1' });
    await h.waitFor((state) => ((state.memory as { pending: { text: string } | null }).pending?.text ?? '').includes('MK-SB1'));
    h.send({ type: 'navigate', screen: 'chat' });

    // Chat with Meta, withheld.
    let before = fakeCloud.requests.length;
    await h.provider.selectCloudModel('muse-spark-1.3');
    await h.provider.sendMessage('Chat to Meta.', 'chat', 'cloud');
    const cards = await settleWithholding(h, before);
    assert.ok(fakeCloud.requests.length > before, 'Chat reached Meta');
    assert.ok(cards[0]?.messages.some((entry) => entry.text === 'pin MK-SA1'), 'the short local message was offered on the card');

    // Agent with Meta: it asks for history and for files; neither returns the short local texts.
    await local(h, 'note MK-SA3');
    let n = 0;
    const offeredTools: string[][] = [];
    fakeCloud.handler = (body) => {
      n += 1;
      const tools = ((body as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map((tool) => tool.function.name);
      offeredTools.push(tools);
      if (n === 1 && tools.includes('search_history')) {
        return toolCall('h1', 'search_history', { queries: ['pin', 'code', 'note'], limit: 5 });
      }
      if (n <= 2) {
        return toolCall('d1', 'read_decisions', {});
      }
      return ok();
    };
    before = fakeCloud.requests.length;
    await h.provider.sendMessage('Agent to Meta.', 'agent', 'cloud');
    // Tool results allowed: read_decisions answers, and still carries only approved decisions.
    await settleWithholding(h, before, true);
    fakeCloud.handler = ok;
    assert.ok(fakeCloud.requests.length - before >= 2, 'Agent ran a tool step with Meta');
    assert.ok(offeredTools.length > 0 && offeredTools.every((tools) => tools.length > 0 && !tools.includes('search_history')), 'search_history is never offered to Meta');
    assert.ok(contents(before).some((content) => content.includes('decision')), 'the read_decisions result reached Meta');

    // A delegated run after a local Agent failure.
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.sendMessage('Retry MK-SC1', 'agent', 'local');
    const delegation = (h.last().remote as { delegation: { digest: string } | null }).delegation;
    before = fakeCloud.requests.length;
    assert.ok(delegation, 'delegation offered after the local failure');
    await h.provider.approveEscalation(delegation.digest);
    await settleWithholding(h, before);
    assert.ok(fakeCloud.requests.length > before, 'the delegated run reached Meta');

    // A Mission plan with Meta.
    before = fakeCloud.requests.length;
    await h.provider.sendMessage('Plan a small cleanup.', 'mission', 'cloud');
    await settleWithholding(h, before);
    assert.ok(fakeCloud.requests.length > before, 'the Mission plan request reached Meta');

    const sent = bodies();
    assert.ok(fakeCloud.requests.length >= 3, `Meta was reached on several paths (${fakeCloud.requests.length} requests)`);
    for (const marker of markers.filter((entry) => entry !== 'MK-SC1')) {
      assert.equal(sent.includes(marker), false, `${marker} reached Meta`);
    }
    // The delegated request itself is what the user delegated: it may carry its own text, nothing else short and local.
    assert.equal(contents().some((content) => content.includes('MK-SA') || content.includes('MK-SB')), false);
  });
});

test('the Agent card shows earlier messages exactly as Agent sends them, shortened past 4,000 characters', async () => {
  await withHarness(async (h) => {
    const long = `MK-LONG-HEAD ${'lorem ipsum '.repeat(400)} MK-LONG-TAIL`;
    assert.ok(long.length > AGENT_HISTORY_TEXT_LIMIT && long.length < 8000);
    await local(h, long);
    await h.provider.selectCloudModel('muse-spark-1.3');
    const before = fakeCloud.requests.length;
    await h.provider.sendMessage('Agent with a long earlier message.', 'agent', 'cloud');
    const card = cardOf(h.last()) as Card;
    assert.ok(card, 'a card');
    const shown = card.messages.map((entry) => entry.text);
    assert.ok(shown.length >= 2);
    for (const text of shown) {
      assert.equal(text.includes('MK-LONG-TAIL'), false, 'the card does not show what Agent leaves out');
      assert.match(text, /…\[RAME Code shortened this earlier message: \d+ characters left out\]$/);
    }
    assert.equal(card.chars, shown.reduce((sum, text) => sum + text.length, 0), 'the size on the card is the size shown');
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'include', toolResults: false });
    await h.waitFor((state) => fakeCloud.requests.length > before && !state.running, 8000);
    const sent = contents(before);
    for (const text of shown) {
      assert.ok(sent.includes(text), 'each previewed message is sent byte for byte');
    }
    assert.equal(bodies(before).includes('MK-LONG-TAIL'), false);
  });
});

test('the Chat card shows and sends the whole message: no shortening there', async () => {
  await withHarness(async (h) => {
    const long = `MK-CHAT-HEAD ${'lorem ipsum '.repeat(400)} MK-CHAT-TAIL`;
    await local(h, long);
    await h.provider.selectCloudModel('muse-spark-1.3');
    const before = fakeCloud.requests.length;
    await h.provider.sendMessage('Chat with a long earlier message.', 'chat', 'cloud');
    const card = cardOf(h.last()) as Card;
    assert.ok(card.messages.some((entry) => entry.text === long));
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'include' });
    await h.waitFor((state) => fakeCloud.requests.length > before && !state.running, 8000);
    assert.ok(contents(before).some((content) => content.includes(long)));
  });
});

test('Agent preview text: user messages and reply prose are shortened as sent; plan entries are not Agent history', () => {
  const long = 'x'.repeat(AGENT_HISTORY_TEXT_LIMIT + 10);
  assert.equal(agentSentText('user', 'short'), 'short');
  assert.equal(agentSentText('user', long), historyText(long));
  assert.match(historyText(long), /10 characters left out\]$/);
  assert.equal(agentSentText('assistant', long), historyText(long));
  assert.equal(agentSentText('plan', 'goal\nstep'), null);
});
