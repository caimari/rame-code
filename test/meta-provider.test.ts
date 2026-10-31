import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMissionPlan,
  META_API_ENDPOINT,
  META_MODEL,
  validateMissionPlan,
} from '../src/meta-provider.js';

test('sends a bounded official chat-completions request', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;

  const plan = await createMissionPlan({
    apiKey: 'dummy-test-key',
    goal: 'Add a verified greeting command to the extension.',
    fetchImpl: async (input, init) => {
      capturedUrl = input.toString();
      capturedInit = init;
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
    },
  });

  assert.equal(capturedUrl, META_API_ENDPOINT);
  assert.equal(capturedInit?.method, 'POST');
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer dummy-test-key');

  const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, META_MODEL);
  assert.equal('mode' in body, false);
  assert.equal(body.store, false);
  assert.equal(
    (body.response_format as { type: string }).type,
    'json_schema',
  );
  assert.equal(plan.steps[0]?.id, 'step-1');
});

test('rejects malformed mission plans', () => {
  assert.throws(
    () =>
      validateMissionPlan({
        goal: 'Incomplete plan',
        assumptions: [],
        steps: [],
        risks: [],
      }),
    /invalid shape/,
  );

  assert.throws(
    () =>
      validateMissionPlan({
        goal: 'A goal',
        assumptions: [],
        steps: [
          { id: '', title: 'A step', successCriterion: 'A result' },
        ],
        risks: [],
      }),
    /invalid step/,
  );
});

test('does not expose the API key when the provider returns an error', async () => {
  await assert.rejects(
    createMissionPlan({
      apiKey: 'secret-that-must-not-appear',
      goal: 'Create a mission that deliberately receives an API error.',
      fetchImpl: async () =>
        Response.json(
          { error: { message: 'Request rejected.' } },
          { status: 400 },
        ),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 400/);
      assert.doesNotMatch(error.message, /secret-that-must-not-appear/);
      return true;
    },
  );
});

test('preserves the HTTP status when an error body is not JSON', async () => {
  await assert.rejects(
    createMissionPlan({
      apiKey: 'dummy-test-key',
      goal: 'Create a mission that receives a non-JSON gateway response.',
      fetchImpl: async () =>
        new Response('<html>gateway error</html>', { status: 502 }),
    }),
    /HTTP 502/,
  );
});

test('reports invalid JSON returned as successful model content', async () => {
  await assert.rejects(
    createMissionPlan({
      apiKey: 'dummy-test-key',
      goal: 'Create a mission whose completion is deliberately malformed.',
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: 'not-json' } }],
        }),
    }),
    /invalid JSON mission plan/,
  );
});
