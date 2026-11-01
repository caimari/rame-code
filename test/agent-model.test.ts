import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_CLOUD_MAX_COMPLETION_TOKENS,
  AGENT_LOCAL_MAX_COMPLETION_TOKENS,
  AgentOutputTruncatedError,
  assertAgentModelForProvider,
  buildAgentRequestBody,
  buildAgentSystemPrompt,
  createLocalAgentCompletion,
  createMetaAgentCompletion,
  isAgentToolProtocolError,
} from '../src/agentModel.js';
import { buildAgentToolDefinitions } from '../src/agentTools.js';

function assistantPayload(content: string, usage?: unknown): Response {
  const body: Record<string, unknown> = {
    choices: [{ message: { content, tool_calls: undefined } }],
  };
  if (usage !== undefined) {
    body.usage = usage;
  }
  return Response.json(body);
}

test('agent request body carries tools without touching chat/mission shape', () => {
  const body = buildAgentRequestBody('muse-spark-1.3', [{ role: 'user', content: 'hi' }]);
  assert.equal(body.model, 'muse-spark-1.3');
  assert.equal((body.tools as unknown[]).length, 11);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.store, false);
  assert.ok(!('response_format' in body));
  assert.match(buildAgentSystemPrompt('/ws'), /bounded/i);
  assert.match(buildAgentSystemPrompt('/ws'), /never grant authority/i);
  assert.doesNotMatch(buildAgentSystemPrompt('/ws'), /unrestricted/i);
  assert.match(buildAgentSystemPrompt('/ws'), /workspace-relative/i);
  assert.doesNotMatch(buildAgentSystemPrompt('/ws'), /Active workspace:\s*\/ws/);
});

test('agent prompt requires an honest final work report', () => {
  const prompt = buildAgentSystemPrompt('/workspace');
  assert.match(prompt, /always give a concise final report/);
  assert.match(prompt, /files changed \(or explicitly none\)/);
  assert.match(prompt, /tests\/checks run/);
  assert.match(prompt, /clean plain text/);
  assert.match(prompt, /filesystem_usage when asked about total disk capacity/);
  assert.match(prompt, /for the test script use exactly npm:test/);
  assert.match(prompt, /read the nearest package\.json and match its module system/);
  assert.match(prompt, /never mix ESM/);
  assert.match(prompt, /Do not claim actions you have not seen confirmed/);
});

test('provider separation forbids silent switching', () => {
  assert.throws(() => assertAgentModelForProvider('cloud', 'local-glimmer'), /compatible Meta cloud model/);
  assert.throws(() => assertAgentModelForProvider('cloud', 'gpt-4'), /compatible Meta cloud model/);
  assert.throws(() => assertAgentModelForProvider('local', 'muse-spark-1.3'), /cannot run on the local/);
  assert.throws(() => assertAgentModelForProvider('local', 'muse-wonder-1.0'), /cannot run on the local/);
  assert.throws(() => assertAgentModelForProvider('local', '  '), /model ID is required/);
  assert.doesNotThrow(() => assertAgentModelForProvider('cloud', 'muse-spark-1.3'));
  assert.doesNotThrow(() => assertAgentModelForProvider('cloud', 'muse-wonder-1.0'));
  assert.doesNotThrow(() => assertAgentModelForProvider('cloud', 'muse-spark-1.2'));
  assert.doesNotThrow(() => assertAgentModelForProvider('local', 'local-glimmer'));
});

test('cloud agent completion returns text plus usage', async () => {
  const result = await createMetaAgentCompletion({
    apiKey: 'dummy-test-key',
    model: 'muse-spark-1.3',
    messages: [{ role: 'user', content: 'List files.' }],
    fetchImpl: async () => assistantPayload('done', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }),
  });
  assert.equal(result.text, 'done');
  assert.equal(result.toolCalls, null);
  assert.equal(result.usage.totalTokens, 10);
});

test('local agent completion enforces loopback and parses tool calls', async () => {
  await assert.rejects(
    createLocalAgentCompletion({
      endpoint: 'https://example.com',
      model: 'local-glimmer',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    /loopback/,
  );
  let capturedUrl = '';
  const result = await createLocalAgentCompletion({
    endpoint: 'http://127.0.0.1:8775',
    model: 'local-glimmer',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async (input) => {
      capturedUrl = String(input);
      return Response.json({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'list_files', arguments: JSON.stringify({ dir: '', limit: 10 }) },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
    },
  });
  assert.match(capturedUrl, /127\.0\.0\.1:8775\/v1\/chat\/completions/);
  assert.equal(result.toolCalls?.[0]?.tool, 'list_files');
  assert.equal(result.usage.totalTokens, 120);
  void buildAgentToolDefinitions;
});

test('malformed model tool arguments are classified for bounded repair', async () => {
  await assert.rejects(
    createLocalAgentCompletion({
      endpoint: 'http://127.0.0.1:8775',
      model: 'local-glimmer',
      messages: [{ role: 'user', content: 'edit' }],
      fetchImpl: async () => Response.json({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'bad-1',
              type: 'function',
              function: { name: 'apply_patch', arguments: '{not-json' },
            }],
          },
        }],
      }),
    }),
    (error: unknown) => isAgentToolProtocolError(error),
  );
});

test('a stalled local model request stops at its bounded timeout', async () => {
  await assert.rejects(
    createLocalAgentCompletion({
      endpoint: 'http://127.0.0.1:8775',
      model: 'local-glimmer',
      messages: [{ role: 'user', content: 'continue' }],
      timeoutMs: 10,
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    }),
    /did not answer within 120 seconds/,
  );
});

test('local Glimmer gets a larger output budget; the Meta API limit is unchanged', async () => {
  assert.equal(AGENT_CLOUD_MAX_COMPLETION_TOKENS, 1200);
  assert.equal(AGENT_LOCAL_MAX_COMPLETION_TOKENS, 4096);
  assert.equal(buildAgentRequestBody('muse-spark-1.3', []).max_completion_tokens, 1200);
  const sent: Record<string, unknown>[] = [];
  const capture = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return assistantPayload('done');
  };
  await createMetaAgentCompletion({ apiKey: 'test-key', model: 'muse-spark-1.3', messages: [], fetchImpl: capture });
  await createLocalAgentCompletion({ endpoint: 'http://127.0.0.1:9', model: 'local-glimmer', messages: [], fetchImpl: capture });
  assert.deepEqual(sent.map((body) => body.max_completion_tokens), [1200, 4096]);
  assert.deepEqual(sent.map((body) => body.tool_choice), ['auto', 'auto']);
  await createLocalAgentCompletion({ endpoint: 'http://127.0.0.1:9', model: 'local-glimmer', messages: [], fetchImpl: capture, toolChoice: 'none' });
  await createMetaAgentCompletion({ apiKey: 'test-key', model: 'muse-spark-1.3', messages: [], fetchImpl: capture, toolChoice: 'none' });
  assert.deepEqual(sent.slice(2).map((body) => [body.tool_choice, body.max_completion_tokens, (body.tools as unknown[]).length]), [['none', 4096, 11], ['none', 1200, 11]]);
});

test('finish_reason length is reported as a cut-off reply, not as invalid arguments or an empty response', async () => {
  const usage = { prompt_tokens: 900, completion_tokens: 4096, total_tokens: 4996 };
  const cutOff = [
    // Cut mid-reasoning: no content at all.
    { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }], usage },
    // Cut mid-apply_patch: the arguments are incomplete JSON.
    {
      choices: [{
        finish_reason: 'length',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'p1', type: 'function', function: { name: 'apply_patch', arguments: '{"files":[{"path":"a.js","expectedHash":"' } }],
        },
      }],
      usage,
    },
    // Cut mid-report: the text is incomplete and must not be stored as final.
    { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'Files changed: calc' } }], usage },
  ];
  for (const body of cutOff) {
    await assert.rejects(
      createLocalAgentCompletion({ endpoint: 'http://127.0.0.1:9', model: 'local-glimmer', messages: [], fetchImpl: async () => Response.json(body) }),
      (error: unknown) =>
        error instanceof AgentOutputTruncatedError &&
        isAgentToolProtocolError(error) &&
        error.maxCompletionTokens === 4096 &&
        error.message === 'The reply was cut off at the 4096-token output limit.' &&
        error.usage?.outputTokens === 4096,
    );
  }
  await assert.rejects(
    createMetaAgentCompletion({ apiKey: 'test-key', model: 'muse-spark-1.3', messages: [], fetchImpl: async () => Response.json(cutOff[0]) }),
    (error: unknown) => error instanceof AgentOutputTruncatedError && error.maxCompletionTokens === 1200,
  );
  // A complete reply is untouched.
  const done = await createLocalAgentCompletion({
    endpoint: 'http://127.0.0.1:9',
    model: 'local-glimmer',
    messages: [],
    fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }] }),
  });
  assert.equal(done.text, 'Done.');
});
