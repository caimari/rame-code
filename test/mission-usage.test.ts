import assert from 'node:assert/strict';
import test from 'node:test';

import { MissionRunner } from '../src/missionRunner.js';

function planPayload(usage?: unknown): Response {
  const body: Record<string, unknown> = {
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
  };
  if (usage !== undefined) {
    body.usage = usage;
  }
  return Response.json(body);
}

test('startWithUsage returns real plan plus parsed usage', async () => {
  const runner = new MissionRunner();
  const result = await runner.startWithUsage({
    apiKey: 'dummy-test-key',
    goal: 'Add a verified greeting command to the extension.',
    fetchImpl: async () =>
      planPayload({ prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }),
  });
  assert.equal(result.plan.steps[0]?.id, 'step-1');
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 34);
  assert.equal(result.usage.totalTokens, 46);
  assert.equal(runner.isRunning, false);
});

test('startWithUsage treats missing usage as zeros', async () => {
  const runner = new MissionRunner();
  const result = await runner.startWithUsage({
    apiKey: 'dummy-test-key',
    goal: 'Add a verified greeting command to the extension.',
    fetchImpl: async () => planPayload(),
  });
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
  });
});

test('legacy start stays compatible and returns the plan', async () => {
  const runner = new MissionRunner();
  const plan = await runner.start({
    apiKey: 'dummy-test-key',
    goal: 'Add a verified greeting command to the extension.',
    fetchImpl: async () =>
      planPayload({ prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }),
  });
  assert.equal(plan.steps[0]?.id, 'step-1');
  assert.equal(runner.isRunning, false);
});

test('startWithUsage prevents concurrent runs and supports cancel', async () => {
  const runner = new MissionRunner();
  let release!: (value: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const first = runner.startWithUsage({
    apiKey: 'dummy-test-key',
    goal: 'First mission holds the slot.',
    fetchImpl: () => gate,
  });
  assert.equal(runner.isRunning, true);
  await assert.rejects(
    runner.startWithUsage({
      apiKey: 'dummy-test-key',
      goal: 'Second mission must wait.',
    }),
    /already running/,
  );
  // Legacy entry shares the same slot.
  await assert.rejects(
    runner.start({
      apiKey: 'dummy-test-key',
      goal: 'Legacy entry also waits.',
    }),
    /already running/,
  );
  release(planPayload({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }));
  const done = await first;
  assert.equal(done.usage.totalTokens, 3);
  assert.equal(runner.isRunning, false);

  const pending = runner.startWithUsage({
    apiKey: 'dummy-test-key',
    goal: 'Cancellable mission.',
    fetchImpl: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
  });
  assert.equal(runner.cancel(), true);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(runner.isRunning, false);
  assert.equal(runner.cancel(), false);
});
