import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatCompletion, createMissionPlanWithUsage } from '../src/meta-provider.js';
import { createLocalChatCompletion } from '../src/localProvider.js';
import type { GenerationRequest } from '../src/generationSettings.js';

const LOCAL_GEN: GenerationRequest = { maxCompletionTokens: 4096, reasoning: null, reasoningParam: null };
import { ChatRunner } from '../src/chatRunner.js';
import {
  CHAT_MODES,
  CHAT_MODELS,
  isSupportedMode,
  isSupportedModel,
} from '../src/modes.js';

function planPayload() {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            goal: 'Add a greeting command',
            assumptions: [],
            steps: [
              {
                id: 'step-1',
                title: 'Define the command',
                successCriterion: 'The command is registered and tested.',
              },
            ],
            risks: [],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
  };
}

test('modes offer Agent, Chat only, and Mission with their models', () => {
  assert.deepEqual(CHAT_MODES.map((mode) => mode.id), ['agent', 'chat', 'mission']);
  assert.deepEqual(CHAT_MODELS.map((model) => model.id), [
    'muse-spark-1.3',
    'local-glimmer',
  ]);
  assert.equal(isSupportedMode('chat'), true);
  assert.equal(isSupportedMode('mission'), true);
  assert.equal(isSupportedMode('agent'), true);
  assert.equal(isSupportedModel('muse-spark-1.3'), true);
  assert.equal(isSupportedModel('local-glimmer'), true);
  assert.equal(isSupportedModel('other'), false);
});

test('cloud Chat returns prose plus usage from the active-thread messages', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const result = await createChatCompletion({
    apiKey: 'dummy-test-key',
    goal: 'Explain closures.',
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Explain closures.' },
    ],
    fetchImpl: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [{ message: { content: 'A closure captures scope.' } }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      });
    },
  });
  assert.equal(result.text, 'A closure captures scope.');
  assert.equal(result.usage.totalTokens, 28);
  assert.equal((capturedBody?.messages as unknown[]).length, 2);
  assert.equal('response_format' in (capturedBody ?? {}), false);
});

test('cloud Mission keeps the strict plan result and reports usage', async () => {
  const { plan, usage } = await createMissionPlanWithUsage({
    apiKey: 'dummy-test-key',
    goal: 'Add a verified greeting command to the extension.',
    fetchImpl: async () => Response.json(planPayload()),
  });
  assert.equal(plan.steps[0]?.id, 'step-1');
  assert.equal(usage.totalTokens, 42);
});

test('local chat uses the OpenAI-compatible loopback endpoint', async () => {
  let capturedUrl = '';
  const result = await createLocalChatCompletion({
    endpoint: 'http://127.0.0.1:8775',
    model: 'local-glimmer',
    messages: [{ role: 'user', content: 'Hi there.' }],
    generation: LOCAL_GEN,
    fetchImpl: async (input, init) => {
      capturedUrl = input.toString();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.model, 'local-glimmer');
      assert.equal(body.stream, false);
      return Response.json({
        choices: [{ message: { content: 'Hello from local.' } }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      });
    },
  });
  assert.equal(result.text, 'Hello from local.');
  assert.equal(result.usage.totalTokens, 9);
  assert.equal(capturedUrl, 'http://127.0.0.1:8775/v1/chat/completions');
});

test('local chat refuses non-loopback endpoints and empty replies', async () => {
  await assert.rejects(
    createLocalChatCompletion({
      endpoint: 'http://192.168.1.10:8775',
      model: 'local-glimmer',
      messages: [{ role: 'user', content: 'Hi there.' }],
      generation: LOCAL_GEN,
    }),
    /loopback/,
  );
  await assert.rejects(
    createLocalChatCompletion({
      endpoint: 'http://127.0.0.1:8775',
      model: 'local-glimmer',
      messages: [{ role: 'user', content: 'Hi there.' }],
      generation: LOCAL_GEN,
      fetchImpl: async () =>
        Response.json({ choices: [{ message: { content: '' } }] }),
    }),
    /no assistant reply/,
  );
});

test('chat runner prevents concurrent calls and supports cancel', async () => {
  const runner = new ChatRunner();
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const first = runner.start(() => gate);
  assert.equal(runner.isRunning, true);
  await assert.rejects(runner.start(async () => 'second'), /already running/);
  release('first reply');
  assert.equal(await first, 'first reply');
  assert.equal(runner.isRunning, false);
  assert.equal(runner.cancel(), false);
});
