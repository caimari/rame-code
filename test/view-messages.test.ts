import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildViewStateMessage,
  CHAT_SCOPE_NOTICE,
  MISSION_SCOPE_NOTICE,
  parseViewInboundMessage,
  runtimeLabel,
  scopeNoticeForMode,
  toThreadSummaries,
  viewConnectionLabel,
} from '../src/viewMessages.js';
import { EMPTY_USAGE } from '../src/usage.js';

const PROBE = 'probe-secret-value-xyz-123';

function baseState() {
  return {
    screen: 'chat' as const,
    hasKey: true,
    running: false,
    status: 'Ready.',
    connection: 'ready' as const,
    provider: 'cloud' as const,
    mode: 'chat' as const,
    model: 'muse-spark-1.3',
    threads: [],
    activeThreadId: null,
    turns: [],
    usageLast: { ...EMPTY_USAGE },
    usageCloud: { ...EMPTY_USAGE },
    usageLocal: { ...EMPTY_USAGE },
    local: { lifecycle: 'stopped' as const, owned: false, endpoint: null, diagnostics: '' },
    escalation: { pending: false, reason: '' },
    allowCloudEscalation: false,
    externalLocalEndpoint: '',
  };
}

test('parses every valid unified inbound message shape', () => {
  assert.deepEqual(parseViewInboundMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseViewInboundMessage({ type: 'navigate', screen: 'chat' }), {
    type: 'navigate',
    screen: 'chat',
  });
  assert.deepEqual(parseViewInboundMessage({ type: 'navigate', screen: 'settings' }), {
    type: 'navigate',
    screen: 'settings',
  });
  assert.deepEqual(parseViewInboundMessage({ type: 'newThread' }), { type: 'newThread' });
  assert.deepEqual(parseViewInboundMessage({ type: 'refresh' }), { type: 'refresh' });
  assert.deepEqual(
    parseViewInboundMessage({ type: 'openThread', threadId: 't-abc' }),
    { type: 'openThread', threadId: 't-abc' },
  );
  assert.deepEqual(
    parseViewInboundMessage({ type: 'deleteThread', threadId: 't-abc' }),
    { type: 'deleteThread', threadId: 't-abc' },
  );
  assert.deepEqual(
    parseViewInboundMessage({
      type: 'sendMessage',
      text: 'Explain closures.',
      mode: 'chat',
      runtime: 'cloud',
    }),
    {
      type: 'sendMessage',
      text: 'Explain closures.',
      mode: 'chat',
      runtime: 'cloud',
    },
  );
  assert.deepEqual(
    parseViewInboundMessage({
      type: 'sendMessage',
      text: 'Explain closures.',
      mode: 'agent',
      runtime: 'local',
    }),
    {
      type: 'sendMessage',
      text: 'Explain closures.',
      mode: 'agent',
      runtime: 'local',
    },
  );
  assert.deepEqual(parseViewInboundMessage({ type: 'cancel' }), { type: 'cancel' });
  assert.deepEqual(parseViewInboundMessage({ type: 'saveKey', apiKey: ' k ' }), {
    type: 'saveKey',
    apiKey: ' k ',
  });
  assert.deepEqual(parseViewInboundMessage({ type: 'clearKey' }), { type: 'clearKey' });
  assert.deepEqual(
    parseViewInboundMessage({
      type: 'updateSettings',
      runtime: 'local',
      mode: 'mission',
      allowCloudEscalation: true,
    }),
    {
      type: 'updateSettings',
      runtime: 'local',
      mode: 'mission',
      allowCloudEscalation: true,
    },
  );
  assert.deepEqual(
    parseViewInboundMessage({
      type: 'updateLocalSettings',
      executablePath: '/bin/llama-server',
      modelPath: '/models/a.gguf',
      projectorPath: '',
      draftModelPath: '',
      modelId: 'local-glimmer',
      contextSize: 32768,
      port: 8775,
      idleTimeoutSec: 600,
    }).type,
    'updateLocalSettings',
  );
  assert.deepEqual(parseViewInboundMessage({ type: 'useSuggestions' }), {
    type: 'useSuggestions',
  });
  assert.deepEqual(
    parseViewInboundMessage({ type: 'selectCloudModel', model: 'muse-spark-1.2' }),
    { type: 'selectCloudModel', model: 'muse-spark-1.2' },
  );
  assert.deepEqual(parseViewInboundMessage({ type: 'refreshModels' }), {
    type: 'refreshModels',
  });
  assert.deepEqual(
    parseViewInboundMessage({
      type: 'startLocal',
      executablePath: '/bin/llama-server',
      modelPath: '/models/a.gguf',
      projectorPath: '',
      draftModelPath: '',
      modelId: 'local-glimmer',
      contextSize: 32768,
      port: 8775,
      idleTimeoutSec: 600,
    }).type,
    'startLocal',
  );
  assert.deepEqual(parseViewInboundMessage({ type: 'stopLocal' }), { type: 'stopLocal' });
  assert.deepEqual(
    parseViewInboundMessage({ type: 'selectExternalEndpoint', endpoint: 'http://127.0.0.1:8775' }),
    { type: 'selectExternalEndpoint', endpoint: 'http://127.0.0.1:8775' },
  );
  assert.deepEqual(parseViewInboundMessage({ type: 'clearExternalEndpoint' }), {
    type: 'clearExternalEndpoint',
  });
  assert.deepEqual(parseViewInboundMessage({ type: 'escalateApprove' }), {
    type: 'escalateApprove',
  });
  assert.deepEqual(parseViewInboundMessage({ type: 'escalateDismiss' }), {
    type: 'escalateDismiss',
  });
});

test('rejects unified messages with extra fields without echoing values', () => {
  const invalidPayloads: unknown[] = [
    null,
    undefined,
    'ready',
    42,
    [],
    {},
    { type: 'unknown-type' },
    { type: 'navigate' },
    { type: 'navigate', screen: 'elsewhere' },
    { type: 'navigate', screen: 'chat', extra: PROBE },
    { type: 'ready', extra: PROBE },
    { type: 'newThread', extra: PROBE },
    { type: 'refresh', extra: PROBE },
    { type: 'openThread' },
    { type: 'openThread', threadId: '' },
    { type: 'openThread', threadId: 't-1', extra: PROBE },
    { type: 'deleteThread' },
    { type: 'deleteThread', threadId: '' },
    { type: 'deleteThread', threadId: 't-1', extra: PROBE },
    {
      type: 'sendMessage',
      text: PROBE,
      mode: 'chat',
      runtime: 'cloud',
      apiKey: PROBE,
    },
    { type: 'sendMessage', text: 'hi', mode: 'chat' },
    { type: 'sendMessage', text: 'hi', mode: 'chat', runtime: 'cloud:muse-spark-1.3' },
    { type: 'sendMessage', text: 'hi', mode: 'chat', runtime: 'local:local-glimmer' },
    { type: 'sendMessage', text: 'hi', mode: 'chat', runtime: 'muse-spark-1.3' },
    { type: 'sendMessage', text: 'hi', mode: 'chat', runtime: 'local-glimmer' },
    {
      type: 'sendMessage',
      text: 'hi',
      mode: 'chat',
      runtime: 'cloud',
      provider: 'cloud',
    },
    {
      type: 'sendMessage',
      text: 'hi',
      mode: 'chat',
      runtime: 'cloud',
      model: 'muse-spark-1.3',
    },
    { type: 'cancel', extra: PROBE },
    { type: 'saveKey' },
    { type: 'saveKey', apiKey: 42 },
    { type: 'saveKey', apiKey: ' k ', extra: PROBE },
    { type: 'clearKey', extra: PROBE },
    {
      type: 'updateSettings',
      runtime: 'cloud',
      mode: 'chat',
      allowCloudEscalation: false,
      apiKey: PROBE,
    },
    {
      type: 'updateSettings',
      runtime: 'cloud:muse-spark-1.3',
      mode: 'chat',
      allowCloudEscalation: false,
    },
    {
      type: 'updateSettings',
      runtime: 'local:local-glimmer',
      mode: 'chat',
      allowCloudEscalation: false,
    },
    {
      type: 'updateSettings',
      provider: 'cloud',
      mode: 'chat',
      model: 'muse-spark-1.3',
      allowCloudEscalation: false,
    },
    { type: 'selectCloudModel', model: '' },
    { type: 'selectCloudModel', model: 'muse-spark-1.3', extra: PROBE },
    { type: 'refreshModels', extra: PROBE },
    { type: 'startLocal' },
    {
      type: 'updateLocalSettings',
      executablePath: '/x',
      modelPath: '/y',
      projectorPath: '',
      draftModelPath: '',
      modelId: 'm',
      contextSize: 1024,
      port: 80,
      idleTimeoutSec: 0,
      shell: PROBE,
    },
    { type: 'startLocal', extra: PROBE },
    { type: 'stopLocal', extra: PROBE },
    { type: 'selectExternalEndpoint' },
    { type: 'selectExternalEndpoint', endpoint: 42 },
    { type: 'escalateApprove', extra: PROBE },
    { type: 'escalateDismiss', extra: PROBE },
  ];

  for (const raw of invalidPayloads) {
    assert.throws(
      () => parseViewInboundMessage(raw),
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

test('internal navigation preserves threads and transcript in state', () => {
  const thread = {
    id: 't-1',
    title: 'Closures',
    createdAt: 10,
    updatedAt: 20,
    turns: [
      { kind: 'user', text: 'Explain closures.', timestamp: 10 },
      { kind: 'assistant', text: 'A closure captures scope.', timestamp: 20 },
    ] as const,
  };
  const chatState = buildViewStateMessage({
    ...baseState(),
    screen: 'chat',
    threads: [{ ...thread, turns: [...thread.turns] }],
    activeThreadId: 't-1',
    turns: [...thread.turns],
  });
  // Navigating to Settings flips only the screen flag.
  const settingsState = buildViewStateMessage({
    ...baseState(),
    screen: 'settings',
    threads: [{ ...thread, turns: [...thread.turns] }],
    activeThreadId: 't-1',
    turns: [...thread.turns],
  });
  assert.equal(settingsState.screen, 'settings');
  assert.deepEqual(settingsState.threads, chatState.threads);
  assert.deepEqual(settingsState.turns, chatState.turns);
  assert.equal(settingsState.activeThreadId, 't-1');
  // Both the user turn and the assistant result are present for rendering.
  assert.equal(settingsState.turns.length, 2);
  assert.equal(settingsState.turns[0]?.kind, 'user');
  assert.equal(settingsState.turns[1]?.kind, 'assistant');
});

test('state carries summaries, scope notice, usage, and no key material', () => {
  const message = buildViewStateMessage(baseState());
  assert.equal(message.type, 'state');
  assert.ok(!('apiKey' in message));
  assert.ok(!('apiKey' in JSON.parse(JSON.stringify(message))));
  assert.doesNotMatch(JSON.stringify(message), /probe-secret-value/);
  assert.equal(message.notice, CHAT_SCOPE_NOTICE);
  assert.equal(scopeNoticeForMode('mission'), MISSION_SCOPE_NOTICE);
  assert.match(CHAT_SCOPE_NOTICE, /active thread/);
  assert.match(MISSION_SCOPE_NOTICE, /only your new message/);
  assert.deepEqual(toThreadSummaries([]), []);
  const summaries = toThreadSummaries([
    {
      id: 't-9',
      title: 'Ninth',
      createdAt: 1,
      updatedAt: 2,
      turns: [{ kind: 'user', text: 'A valid thread message.', timestamp: 1 }],
    },
  ]);
  assert.deepEqual(summaries, [{ id: 't-9', title: 'Ninth', updatedAt: 2 }]);
  assert.equal(viewConnectionLabel('verified'), 'Connected — verified');
});

test('runtime is one provider choice with a subordinate cloud model', () => {
  assert.equal(runtimeLabel('cloud'), 'Meta Model API — Cloud');
  assert.equal(runtimeLabel('local'), 'Muse Glimmer — Local');
  const cloud = buildViewStateMessage(baseState());
  assert.equal(cloud.runtime, 'cloud');
  assert.equal(cloud.provider, 'cloud');
  assert.equal(cloud.model, 'muse-spark-1.3');
  assert.equal(cloud.cloudModel, 'muse-spark-1.3');
  const local = buildViewStateMessage({
    ...baseState(),
    provider: 'local',
    model: 'local-glimmer',
    runtime: 'local',
  });
  assert.equal(local.runtime, 'local');
  assert.equal(local.provider, 'local');
  assert.equal(local.model, 'local-glimmer');
  // A subordinate wonder selection flows through; arbitrary ids fall back.
  const wonder = buildViewStateMessage({
    ...baseState(),
    cloudModel: 'muse-wonder-1.0',
  });
  assert.equal(wonder.cloudModel, 'muse-wonder-1.0');
  assert.equal(wonder.model, 'muse-wonder-1.0');
  const forced = buildViewStateMessage({
    ...baseState(),
    provider: 'cloud',
    model: 'gpt-4',
    cloudModel: 'gpt-4',
    runtime: 'cloud',
  });
  assert.equal(forced.provider, 'cloud');
  assert.equal(forced.model, 'muse-spark-1.3');
  assert.equal(forced.cloudModel, 'muse-spark-1.3');
});
