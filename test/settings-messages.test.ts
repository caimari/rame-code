import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSettingsStateMessage,
  parseSettingsInboundMessage,
} from '../src/settingsMessages.js';

const PROBE = 'probe-secret-value-xyz-123';

test('parses every valid Settings inbound message shape', () => {
  assert.deepEqual(parseSettingsInboundMessage({ type: 'ready' }), {
    type: 'ready',
  });
  assert.deepEqual(parseSettingsInboundMessage({ type: 'saveKey', apiKey: ' k ' }), {
    type: 'saveKey',
    apiKey: ' k ',
  });
  assert.deepEqual(parseSettingsInboundMessage({ type: 'clearKey' }), {
    type: 'clearKey',
  });
});

test('rejects Settings messages with extra fields without echoing values', () => {
  const invalidPayloads: unknown[] = [
    null,
    undefined,
    'saveKey',
    42,
    [],
    {},
    { type: 'unknown-type' },
    { type: 'unknown-type', apiKey: PROBE },
    { type: 'saveKey' },
    { type: 'saveKey', apiKey: 42 },
    { type: 'saveKey', apiKey: null },
    { type: 'saveKey', apiKey: ' k ', extra: PROBE },
    { type: 'clearKey', extra: PROBE },
    { type: 'ready', extra: PROBE },
  ];

  for (const raw of invalidPayloads) {
    assert.throws(
      () => parseSettingsInboundMessage(raw),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid|Unknown/);
        assert.doesNotMatch(error.message, /probe-secret-value/);
        return true;
      },
      `payload should be rejected: ${JSON.stringify(raw)}`,
    );
  }
});

test('Settings outbound state carries only a hasKey boolean, never key material', () => {
  const message = buildSettingsStateMessage({
    hasKey: false,
    connection: 'missing-key',
    status: 'No key.',
  });
  assert.equal(message.type, 'state');
  assert.equal(message.hasKey, false);
  assert.ok(!('apiKey' in message));
  assert.ok(!('apiKey' in JSON.parse(JSON.stringify(message))));
  assert.doesNotMatch(JSON.stringify(message), /probe-secret-value/);
});
