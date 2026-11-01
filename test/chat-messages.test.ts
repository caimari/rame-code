import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChatsStateMessage,
  CHATS_SCOPE_NOTICE,
  parseChatInboundMessage,
  selectMissionGoalForSend,
} from '../src/chatMessages.js';

const PROBE = 'probe-secret-value-xyz-123';

test('parses every valid Chats inbound message shape', () => {
  assert.deepEqual(parseChatInboundMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseChatInboundMessage({ type: 'newThread' }), { type: 'newThread' });
  assert.deepEqual(parseChatInboundMessage({ type: 'refreshThreads' }), {
    type: 'refreshThreads',
  });
  assert.deepEqual(parseChatInboundMessage({ type: 'openThread', threadId: 't-abc' }), {
    type: 'openThread',
    threadId: 't-abc',
  });
  assert.deepEqual(
    parseChatInboundMessage({
      type: 'sendMessage',
      text: 'Ship the thing safely.',
      mode: 'mission',
      model: 'muse-spark-1.3',
    }),
    {
      type: 'sendMessage',
      text: 'Ship the thing safely.',
      mode: 'mission',
      model: 'muse-spark-1.3',
    },
  );
  assert.deepEqual(parseChatInboundMessage({ type: 'cancelMission' }), {
    type: 'cancelMission',
  });
  assert.deepEqual(parseChatInboundMessage({ type: 'openSettings' }), {
    type: 'openSettings',
  });
});

test('rejects Chats messages with extra fields without echoing values', () => {
  const invalidPayloads: unknown[] = [
    null,
    undefined,
    'ready',
    42,
    [],
    {},
    { type: 'unknown-type' },
    { type: 'unknown-type', text: PROBE },
    { type: 'ready', extra: PROBE },
    { type: 'newThread', extra: PROBE },
    { type: 'refreshThreads', extra: PROBE },
    { type: 'cancelMission', extra: PROBE },
    { type: 'openSettings', extra: PROBE },
    { type: 'openThread' },
    { type: 'openThread', threadId: 42 },
    { type: 'openThread', threadId: 't-1', extra: PROBE },
    { type: 'sendMessage', text: 'hi', mode: 'mission', model: 'muse-spark-1.3', extra: PROBE },
    { type: 'sendMessage', text: 42, mode: 'mission', model: 'muse-spark-1.3' },
    { type: 'sendMessage', text: 'hi', mode: 'mission' },
    { type: 'sendMessage', text: PROBE, mode: 'mission', model: 'muse-spark-1.3', apiKey: PROBE },
  ];

  for (const raw of invalidPayloads) {
    assert.throws(
      () => parseChatInboundMessage(raw),
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

test('Chats outbound state carries only a hasKey boolean, never key material', () => {
  const message = buildChatsStateMessage({
    hasKey: true,
    running: false,
    status: 'Ready.',
    connection: 'ready',
    threads: [
      {
        id: 't-1',
        title: 'First',
        createdAt: 10,
        updatedAt: 10,
        turns: [{ kind: 'user', text: 'Hello mission.', timestamp: 10 }],
      },
    ],
    activeThreadId: 't-1',
    turns: [{ kind: 'user', text: 'Hello mission.', timestamp: 10 }],
  });
  assert.equal(message.type, 'state');
  assert.equal(message.hasKey, true);
  assert.ok(!('apiKey' in message));
  assert.ok(!('apiKey' in JSON.parse(JSON.stringify(message))));
  assert.doesNotMatch(JSON.stringify(message), /probe-secret-value/);
  assert.match(message.notice, /Only the current message is sent/);
  assert.match(CHATS_SCOPE_NOTICE, /not sent as context yet/);
});

test('each send selects only the current composer text, never thread history', () => {
  const earlier = 'Earlier thread mission about billing reports.';
  const current = '  Build the new export dialog.  ';
  const goal = selectMissionGoalForSend(current);
  assert.equal(goal, 'Build the new export dialog.');
  assert.doesNotMatch(goal, /billing reports/);
  assert.ok(!goal.includes(earlier));
});
