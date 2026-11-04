/**
 * External model servers (SIMULATED HTTP): where a server may be, how
 * Ollama, LM Studio and a plain OpenAI-compatible server are told apart and
 * what RAME learns about each model, and the tool-call shape Ollama sends.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateOneToolCall } from '../src/agentTools.js';
import { classifyEndpoint, endpointUsable, isLocalOrPrivateUrl, modelFitness, scanLocalServer } from '../src/localServers.js';
import { parseLocalSourceMessage, sanitizeLocalSourceView } from '../src/localSourceView.js';

test('a model server may be on this computer, or on the private network with the user\'s confirmation; never public', () => {
  assert.deepEqual(classifyEndpoint('http://127.0.0.1:11434/v1/'), { ok: true, endpoint: 'http://127.0.0.1:11434', scope: 'loopback' });
  assert.deepEqual(classifyEndpoint('http://localhost:1234'), { ok: true, endpoint: 'http://localhost:1234', scope: 'loopback' });
  for (const lan of ['http://192.168.50.42:1235', 'http://10.0.0.42:1235', 'http://172.20.0.5:8080', 'http://[fd12::1]:1234']) {
    assert.equal((classifyEndpoint(lan) as { scope?: string }).scope, 'private', lan);
  }
  for (const bad of ['http://studio.local:1234', 'http://box.lan:1234', 'http://router.home.arpa', 'http://10.0.0.1.nip.io:1234', 'http://my-server:1234', 'http://8.8.8.8:1234', 'https://example.com', 'http://172.32.0.1:1', 'http://192.169.1.1', 'ftp://127.0.0.1', 'http://user:pw@127.0.0.1:1234', 'not a url', 'http://300.1.1.1']) {
    assert.equal(classifyEndpoint(bad).ok, false, bad);
  }
  assert.equal(endpointUsable('http://192.168.50.42:1235', false), false, 'private without the confirmation: not used');
  assert.equal(endpointUsable('http://192.168.50.42:1235', true), true);
  assert.equal(endpointUsable('http://127.0.0.1:11434', false), true);
  assert.equal(endpointUsable('https://example.com', true), false, 'public: never, whatever was confirmed');
  assert.equal(isLocalOrPrivateUrl('https://example.com'), false);
});

type Route = (method: string, url: string, body?: string) => unknown;
function fakeFetch(route: Route) {
  return async (input: string, init?: { method?: string; body?: string }) => {
    const url = new URL(input);
    const answer = route(init?.method ?? 'GET', url.pathname, init?.body);
    if (answer === undefined) {
      return { ok: false, status: 404, text: async () => 'Not Found' };
    }
    return { ok: true, status: 200, text: async () => (typeof answer === 'string' ? answer : JSON.stringify(answer)) };
  };
}

test('Ollama: version, models, tool and vision capabilities, and the context it actually loaded', async () => {
  const fetch = fakeFetch((method, url, body) => {
    if (url === '/api/version') return { version: '0.32.5' };
    if (url === '/api/tags') return { models: [{ name: 'llama3.1:8b' }, { name: 'nomic-embed-text:latest' }, { name: 'gemma3:1b' }, { name: 'bad name!' }] };
    if (url === '/api/ps') return { models: [{ name: 'llama3.1:8b', context_length: 4096 }] };
    if (url === '/api/show' && method === 'POST') {
      const model = JSON.parse(body ?? '{}').model;
      if (model === 'llama3.1:8b') return { capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 131072 } };
      if (model === 'nomic-embed-text:latest') return { capabilities: ['embedding'] };
      return { capabilities: ['completion', 'vision'], model_info: { 'gemma3.context_length': 32768 } };
    }
    return undefined;
  });
  const result = await scanLocalServer('http://127.0.0.1:11434', fetch);
  assert.equal(result.ok, true);
  const scan = (result as { scan: import('../src/localServers.js').LocalServerScan }).scan;
  assert.equal(scan.kind, 'ollama');
  assert.equal(scan.version, '0.32.5');
  assert.deepEqual(scan.models, [
    { id: 'llama3.1:8b', tools: true, vision: false, loadedContext: 4096, maxContext: 131072, loaded: true },
    { id: 'gemma3:1b', tools: false, vision: true, loadedContext: null, maxContext: 32768, loaded: false },
  ], 'the embedding model and an invalid name are left out');
  assert.match(modelFitness(scan.models[0]!, 'ollama').note, /^Supports tool calls: Chat, Agent and Mission\. It is loaded with a 4096-token context; Agent needs about 16384 \(start Ollama with OLLAMA_CONTEXT_LENGTH=32768/);
  assert.deepEqual(modelFitness(scan.models[1]!, 'ollama').agent, false);
  assert.match(modelFitness(scan.models[1]!, 'ollama').note, /does not support tool calls: use it in Chat only/);
});

test('LM Studio (it answers 200 with an error to Ollama\'s paths): chat models with tool use and loaded context; no embeddings or DFlash drafts', async () => {
  const fetch = fakeFetch((_method, url) => {
    if (url === '/api/version' || url === '/api/tags') return { error: 'Unexpected endpoint or method. (GET /api/version)' };
    if (url === '/api/v0/models') {
      return {
        data: [
          { id: 'muse-glimmer-30b', type: 'vlm', arch: 'muse-glimmer', state: 'loaded', max_context_length: 131072, loaded_context_length: 32768, capabilities: ['tool_use'] },
          { id: 'lmstudio-community/muse-glimmer-30b-gguf/dflash-muse-glimmer-30b-q4_k_m.gguf', type: 'llm', arch: 'dflash', state: 'not-loaded', max_context_length: 131072 },
          { id: 'text-embedding-nomic-embed-text-v1.5', type: 'embeddings', arch: 'nomic-bert', state: 'not-loaded' },
          { id: 'qwen3-4b-toolcalling-codex', type: 'llm', arch: 'qwen3', state: 'not-loaded', max_context_length: 262144, capabilities: null },
        ],
      };
    }
    return undefined;
  });
  const result = await scanLocalServer('http://192.168.50.42:1235', fetch);
  const scan = (result as { scan: import('../src/localServers.js').LocalServerScan }).scan;
  assert.equal(scan.kind, 'lmstudio');
  assert.equal(scan.scope, 'private');
  assert.deepEqual(scan.models.map((model) => [model.id, model.tools, model.vision, model.loadedContext, model.loaded]), [
    ['muse-glimmer-30b', true, true, 32768, true],
    ['qwen3-4b-toolcalling-codex', null, false, null, false],
  ]);
  assert.match(modelFitness(scan.models[1]!, 'lmstudio').note, /does not say whether this model supports tool calls/);
});

test('llama-server and other OpenAI-compatible servers; nothing answering is a clear error; public addresses are never scanned', async () => {
  const llama = await scanLocalServer('http://127.0.0.1:8080', fakeFetch((_m, url) => (url === '/v1/models' ? { data: [{ id: 'glimmer' }] } : url === '/props' ? { default_generation_settings: { n_ctx: 32768 } } : undefined)));
  assert.equal((llama as { scan: { kind: string } }).scan.kind, 'llama-server');
  assert.deepEqual((llama as { scan: { models: unknown[] } }).scan.models, [{ id: 'glimmer', tools: null, vision: null, loadedContext: 32768, maxContext: null, loaded: true }]);
  const generic = await scanLocalServer('http://127.0.0.1:9000', fakeFetch((_m, url) => (url === '/v1/models' ? { data: [{ id: 'x' }] } : undefined)));
  assert.equal((generic as { scan: { kind: string } }).scan.kind, 'openai-compatible');
  const none = await scanLocalServer('http://127.0.0.1:9', fakeFetch(() => undefined));
  assert.match((none as { error: string }).error, /^No model server answered at http:\/\/127\.0\.0\.1:9/);
  let called = false;
  const refused = await scanLocalServer('https://example.com', async () => {
    called = true;
    return { ok: true, status: 200, text: async () => '{}' };
  });
  assert.equal(refused.ok, false);
  assert.equal(called, false, 'not even a metadata request to a public address');
});

test('Ollama sends a numeric index with each tool call: accepted; any other extra field is still refused', () => {
  const call = { id: 'call_cxjd0sx7', index: 0, type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md","maxBytes":4096}' } };
  assert.equal(validateOneToolCall(call).tool, 'read_file');
  assert.throws(() => validateOneToolCall({ ...call, index: 'x' }), /Invalid tool call/);
  assert.throws(() => validateOneToolCall({ ...call, extra: 1 }), /Invalid tool call/);
});

test('view messages and state for model servers and web access are validated', () => {
  assert.deepEqual(parseLocalSourceMessage({ type: 'localServerUse', endpoint: 'http://127.0.0.1:1234', model: 'muse-glimmer-30b', lan: false }), { type: 'localServerUse', endpoint: 'http://127.0.0.1:1234', model: 'muse-glimmer-30b', lan: false });
  assert.throws(() => parseLocalSourceMessage({ type: 'localServerUse', endpoint: 'http://127.0.0.1:1234', model: 'bad model', lan: false }));
  assert.throws(() => parseLocalSourceMessage({ type: 'webAccessSet', enabled: 'yes', search: 'duckduckgo', searxngUrl: '' }));
  assert.equal(parseLocalSourceMessage({ type: 'other' }), null);
  const view = sanitizeLocalSourceView({ endpoint: 'http://127.0.0.1:1234', model: 'm', kind: 'evil', lan: 1, scan: { kind: 'ollama', models: [{ id: 'ok:1', note: 'x' }, { id: '<script>' }] }, web: { enabled: true, search: 'other' } });
  assert.equal(view?.kind, '');
  assert.equal(view?.lan, false);
  assert.deepEqual(view?.scan?.models.map((model) => model.id), ['ok:1']);
  assert.deepEqual(view?.web, { enabled: true, search: 'duckduckgo', searxngUrl: '' });
});

test('LM Studio sends "tool_calls": [] with a plain answer: no calls, not an invalid list', async () => {
  const { parseAssistantToolCalls, parseAssistantText } = await import('../src/agentTools.js');
  const payload = { choices: [{ message: { role: 'assistant', content: 'This project is a tiny calculator library.', tool_calls: [] } }] };
  assert.equal(parseAssistantToolCalls(payload), null);
  assert.equal(parseAssistantText(payload), 'This project is a tiny calculator library.');
  assert.throws(() => parseAssistantToolCalls({ choices: [{ message: { tool_calls: [{ id: 'x' }] } }] }), /Invalid tool call/, 'a malformed call is still refused');
});
