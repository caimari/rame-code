/**
 * The shape of local requests (found while diagnosing the LM Studio
 * "No models loaded" report of 2026-11-05):
 *   - adjacent system messages go as one: the Muse Glimmer chat template
 *     writes the whole tool list after every system message, so two system
 *     messages repeated it in the prompt;
 *   - a server chosen as LM Studio or Ollama is not asked llama-server's
 *     `/props` (LM Studio logged it as an error and answered 200; Ollama
 *     answers 404); its model list says it answers instead.
 * Simulated local server only; no network, no GPU.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeAdjacentSystemMessages, type AgentChatMessage } from '../src/agentModel.js';
import { assistantText, HostHarness, type PostedState } from './helpers/hostHarness.js';

type Message = { role: string; content: string | null };
const messagesOf = (request: unknown): Message[] => (request as { messages: Message[] }).messages;
const leadingSystems = (request: unknown): Message[] => {
  const all = messagesOf(request);
  const firstOther = all.findIndex((message) => message.role !== 'system');
  return all.slice(0, firstOther === -1 ? all.length : firstOther);
};
const WEB = { enabled: true, search: 'duckduckgo', searxngUrl: '' };

async function withHarness(folders: number, settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness({ folders });
  await h.start({ agentProfile: 'safe-auto', ...settings });
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

test('adjacent system messages are joined in order; a later one stays apart; nothing is dropped', () => {
  const input: AgentChatMessage[] = [
    { role: 'system', content: 'A' },
    { role: 'system', content: 'B' },
    { role: 'user', content: 'question' },
    { role: 'system', content: 'C' },
    { role: 'system', content: 'D' },
    { role: 'assistant', content: 'answer' },
  ];
  const merged = mergeAdjacentSystemMessages(input);
  assert.deepEqual(merged, [
    { role: 'system', content: 'A\n\nB' },
    { role: 'user', content: 'question' },
    { role: 'system', content: 'C\n\nD' },
    { role: 'assistant', content: 'answer' },
  ]);
  assert.equal(input.length, 6, 'the input is not changed');
  assert.deepEqual(mergeAdjacentSystemMessages([{ role: 'user', content: 'x' }]), [{ role: 'user', content: 'x' }]);
});

test('Agent without a folder: one system message carries the mode rules and the RAME prompt (the tool list is written once)', async () => {
  await withHarness(0, { web: WEB }, async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText('I have no access to your folders.') });
    await h.provider.sendMessage('tienes acceso a las carpetas de mi pc?', 'agent', 'local');
    const systems = leadingSystems(h.model.requests[0]);
    assert.equal(systems.length, 1);
    assert.match(systems[0]?.content ?? '', /^Agent without a project folder/);
    assert.match(systems[0]?.content ?? '', /\n\nYou are RAME Code/);
    assert.equal(messagesOf(h.model.requests[0]).filter((m) => m.role === 'system').length, 1);
  });
});

test('Agent with a folder and Chat with web: one leading system message too', async () => {
  await withHarness(1, {}, async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText('Hello.') });
    await h.provider.sendMessage('What is in this project?', 'agent', 'local');
    assert.equal(leadingSystems(h.model.requests[0]).length, 1, 'base prompt, memory rules and continuity joined');
  });
  await withHarness(1, { web: WEB, mode: 'chat' }, async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText('Hello.') });
    await h.provider.sendMessage('Hello?', 'chat', 'local');
    assert.equal(leadingSystems(h.model.requests[0]).length, 1);
    assert.match(leadingSystems(h.model.requests[0])[0]?.content ?? '', /^Web access for this reply \(Chat\)/);
  });
});

for (const kind of ['lmstudio', 'ollama'] as const) {
  test(`a server chosen as ${kind}: no /props; its model list confirms it answers`, async () => {
    const seen: string[] = [];
    await withHarness(1, { externalLocal: { model: 'muse-glimmer', kind, tools: true, context: 32768, lan: false } }, async (h) => {
      h.model.metadata = (method, url) => {
        if (method !== 'GET') return undefined;
        seen.push(url);
        return url === '/v1/models' ? { object: 'list', data: [{ id: 'muse-glimmer', object: 'model' }] } : { error: 'Unexpected endpoint' };
      };
      h.model.enqueue({ kind: 'json', body: assistantText('Hello.') });
      await h.provider.sendMessage('Hello?', 'chat', 'local');
      assert.equal(h.model.propsRequests, 0, 'llama-server /props is not asked');
      assert.ok(seen.includes('/v1/models'), seen.join(','));
      const state: PostedState = h.last();
      assert.equal((state.remote as { runtime: { local: string } }).runtime.local, 'connected');
    });
  });
}

test('a server not chosen as LM Studio or Ollama (or RAME llama-server) is still asked /props, as before', async () => {
  await withHarness(1, {}, async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText('Hello.') });
    await h.provider.sendMessage('Hello?', 'chat', 'local');
    assert.ok(h.model.propsRequests >= 1);
  });
});
