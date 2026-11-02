import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentCompletion } from '../src/agentModel.js';
import { LocalAgentModelProvider, MetaAgentModelProvider, type AgentModelRequest } from '../src/modelProviders/agentProvider.js';

const completion: AgentCompletion = {
  text: 'ok',
  toolCalls: null,
  usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3 },
};

function request(): AgentModelRequest {
  return {
    model: 'model-id',
    messages: [{ role: 'user', content: 'hello' }],
    generation: { maxCompletionTokens: 128, reasoning: null, reasoningParam: null },
    tools: [],
    signal: new AbortController().signal,
    toolChoice: 'none',
  };
}

test('Meta Agent provider binds the key and never forwards undocumented local tool_choice', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const provider = new MetaAgentModelProvider('secret-key', async (options) => {
    calls.push(options as unknown as Record<string, unknown>);
    return completion;
  });
  assert.equal(provider.id, 'cloud');
  assert.equal(await provider.complete(request()), completion);
  assert.equal(calls[0]?.apiKey, 'secret-key');
  assert.equal('toolChoice' in (calls[0] ?? {}), false);
});

test('local Agent provider binds one endpoint and forwards the explicit tool choice', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const provider = new LocalAgentModelProvider('http://127.0.0.1:8775', async (options) => {
    calls.push(options as unknown as Record<string, unknown>);
    return completion;
  });
  assert.equal(provider.id, 'local');
  assert.equal(await provider.complete(request()), completion);
  assert.equal(calls[0]?.endpoint, 'http://127.0.0.1:8775');
  assert.equal(calls[0]?.toolChoice, 'none');
  assert.equal('apiKey' in (calls[0] ?? {}), false);
});
