import assert from 'node:assert/strict';
import test from 'node:test';

import { MissionRunner } from '../src/missionRunner.js';

function planResponse(): Response {
  return Response.json({
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
  });
}

test('prevents concurrent missions', async () => {
  const runner = new MissionRunner();
  let release!: (value: Response) => void;
  const gate = new Promise<Response>((resolve) => {
    release = resolve;
  });

  const first = runner.start({
    apiKey: 'dummy-test-key',
    goal: 'Add a verified greeting command to the extension.',
    fetchImpl: () => gate,
  });
  assert.equal(runner.isRunning, true);

  await assert.rejects(
    runner.start({
      apiKey: 'dummy-test-key',
      goal: 'A second mission that must wait its turn.',
    }),
    /already running/,
  );

  release(planResponse());
  const plan = await first;
  assert.equal(plan.steps[0]?.id, 'step-1');
  assert.equal(runner.isRunning, false);
});

test('cancellation aborts the in-flight request', async () => {
  const runner = new MissionRunner();
  const pending = runner.start({
    apiKey: 'dummy-test-key',
    goal: 'Add a verified greeting command to the extension.',
    fetchImpl: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
  });

  assert.equal(runner.isRunning, true);
  assert.equal(runner.cancel(), true);
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(runner.isRunning, false);
  assert.equal(runner.cancel(), false);
});
