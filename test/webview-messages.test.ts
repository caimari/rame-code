import assert from 'node:assert/strict';
import test from 'node:test';

import { initialPanelState, toWebviewStateMessage } from '../src/panelState.js';
import {
  parseInboundMessage,
  redactKeyFromText,
  validateApiKeyInput,
  validateGoalInput,
} from '../src/webviewMessages.js';

const PROBE_KEY = 'probe-secret-key-xyz-123';

test('parses every valid inbound message shape', () => {
  assert.deepEqual(parseInboundMessage({ type: 'saveKey', apiKey: ' k ' }), {
    type: 'saveKey',
    apiKey: ' k ',
  });
  assert.deepEqual(parseInboundMessage({ type: 'clearKey' }), {
    type: 'clearKey',
  });
  assert.deepEqual(
    parseInboundMessage({ type: 'startMission', goal: 'Ship the thing.' }),
    { type: 'startMission', goal: 'Ship the thing.' },
  );
  assert.deepEqual(parseInboundMessage({ type: 'cancelMission' }), {
    type: 'cancelMission',
  });
  assert.deepEqual(parseInboundMessage({ type: 'ready' }), {
    type: 'ready',
  });
});

test('rejects invalid inbound messages without echoing values', () => {
  const invalidPayloads: unknown[] = [
    null,
    undefined,
    'saveKey',
    42,
    [],
    {},
    { type: 'unknown-type' },
    { type: 'unknown-type', apiKey: PROBE_KEY },
    { type: 'saveKey' },
    { type: 'saveKey', apiKey: 42 },
    { type: 'saveKey', apiKey: null },
    { type: 'startMission' },
    { type: 'startMission', goal: 42 },
    { type: 'clearKey', extra: PROBE_KEY },
    { type: 'saveKey', apiKey: ' k ', extra: PROBE_KEY },
    { type: 'startMission', goal: 'Ship the thing.', extra: PROBE_KEY },
    { type: 'cancelMission', extra: PROBE_KEY },
    { type: 'ready', extra: PROBE_KEY },
  ];

  for (const raw of invalidPayloads) {
    assert.throws(
      () => parseInboundMessage(raw),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid|Unknown/);
        assert.doesNotMatch(error.message, /probe-secret-key/);
        return true;
      },
      `payload should be rejected: ${JSON.stringify(raw)}`,
    );
  }
});

test('validates API key input without echoing it', () => {
  assert.deepEqual(validateApiKeyInput('  abc  '), {
    ok: true,
    apiKey: 'abc',
  });
  for (const bad of ['', '   ', 42, null, undefined, 'x'.repeat(5000)]) {
    const result = validateApiKeyInput(bad);
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.doesNotMatch(
      result.error,
      /probe-secret-key/,
      'error text must never echo input',
    );
  }
  const rejected = validateApiKeyInput(PROBE_KEY);
  assert.equal(rejected.ok, true);
});

test('validates mission goal input', () => {
  assert.deepEqual(validateGoalInput('  Add a verified greeting.  '), {
    ok: true,
    goal: 'Add a verified greeting.',
  });
  // Boundary: exactly 10 characters is accepted.
  assert.equal(validateGoalInput('0123456789').ok, true);
  assert.equal(validateGoalInput('too short').ok, false);
  assert.equal(validateGoalInput('').ok, false);
  assert.equal(validateGoalInput(42).ok, false);
  assert.equal(validateGoalInput('x'.repeat(9000)).ok, false);
});

test('redacts the key from error text', () => {
  assert.equal(
    redactKeyFromText(`denied for ${PROBE_KEY} twice ${PROBE_KEY}`, PROBE_KEY),
    'denied for [redacted] twice [redacted]',
  );
  assert.equal(redactKeyFromText('unchanged', ''), 'unchanged');
  assert.equal(redactKeyFromText('nothing secret here', PROBE_KEY), 'nothing secret here');
  assert.doesNotMatch(redactKeyFromText(`oops ${PROBE_KEY}`, PROBE_KEY), /probe-secret-key/);
});

test('outbound state exposes only a boolean hasKey flag', () => {
  const message = toWebviewStateMessage(initialPanelState(true));
  assert.equal(message.type, 'state');
  assert.equal(message.hasKey, true);
  assert.ok(!('apiKey' in message));
  assert.ok(!('apiKey' in JSON.parse(JSON.stringify(message))));
  assert.doesNotMatch(JSON.stringify(message), /probe-secret-key/);
});
