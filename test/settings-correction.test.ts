import assert from 'node:assert/strict';
import test from 'node:test';

import { buildViewHtml } from '../src/viewHtml.js';
import {
  agentScopeNotice,
  buildViewStateMessage,
  parseViewInboundMessage,
  runtimeLabel,
  runtimeStatusLabel,
  scopeNoticeForMode,
} from '../src/viewMessages.js';
import {
  CLOUD_MODEL_FALLBACK,
  cloudModelLabel,
  fallbackCatalog,
  isCompatibleModelId,
  isContributorModelId,
  parseMetaModelsPayload,
  refreshCompatibleModels,
  sanitizeCatalogError,
  validateCloudModelSelection,
} from '../src/metaCatalog.js';
import { suggestedLocalSettings, validateSettings } from '../src/settingsStore.js';
import { EMPTY_USAGE } from '../src/usage.js';
import { readFileSync } from 'node:fs';

const PROBE = 'probe-secret-value-xyz-123';

function viewDocument(): string {
  return buildViewHtml({
    cspSource: 'vscode-webview://test',
    scriptUri: 'vscode-webview://test/main.js',
    styleUri: 'vscode-webview://test/main.css',
    nonce: 'test-nonce-123',
  });
}

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

test('conditional sections: provider-level selector with hideable Cloud/Local blocks', () => {
  const html = viewDocument();
  // Provider-level only.
  assert.ok(html.includes('value="cloud"'));
  assert.ok(html.includes('value="local"'));
  assert.ok(html.includes('Meta Model API — Cloud'));
  assert.ok(html.includes('Muse Glimmer — Local'));
  // Entire sections can be hidden.
  assert.ok(html.includes('id="cloudSection"'));
  assert.ok(html.includes('id="localSection"'));
  assert.ok(html.includes('id="escalationSection"'));
  // The API key input lives inside the Cloud section so Local mode hides it.
  const cloudAt = html.indexOf('id="cloudSection"');
  const keyAt = html.indexOf('id="apiKey"');
  const localAt = html.indexOf('id="localSection"');
  assert.ok(cloudAt >= 0 && keyAt > cloudAt && localAt > keyAt);
  // Single provider choice plus a subordinate cloud-only catalog choice.
  assert.ok(html.includes('id="cloudModelSelect"'));
  assert.ok(html.includes('id="refreshModels"'));
  assert.ok(html.includes('Available compatible Meta models'));
  assert.ok(!html.includes('id="providerSelect"'));
  assert.ok(!html.includes('id="modelSelect"'));
  assert.equal(runtimeLabel('cloud'), 'Meta Model API — Cloud');
  assert.equal(runtimeLabel('local'), 'Muse Glimmer — Local');
  assert.match(runtimeStatusLabel('cloud', 'muse-wonder-1.0'), /muse-wonder-1\.0/);
});

test('outbound state carries bounded localSettings with a revision (detected-settings fix)', () => {
  const suggestions = suggestedLocalSettings();
  const state = buildViewStateMessage({
    ...baseState(),
    localSettings: { ...suggestions },
    localSettingsRev: 7,
  });
  // Every local field is populated (this failed before: no localSettings).
  assert.equal(state.localSettings.executablePath, suggestions.executablePath);
  assert.equal(state.localSettings.modelPath, suggestions.modelPath);
  assert.equal(state.localSettings.projectorPath, suggestions.projectorPath);
  assert.equal(state.localSettings.draftModelPath, suggestions.draftModelPath);
  assert.equal(state.localSettings.modelId, suggestions.modelId);
  assert.equal(state.localSettings.contextSize, suggestions.contextSize);
  assert.equal(state.localSettings.port, suggestions.port);
  assert.equal(state.localSettings.idleTimeoutSec, suggestions.idleTimeoutSec);
  assert.equal(state.localSettingsRev, 7);
  // No secret material in the snapshot.
  assert.ok(!('apiKey' in state));
  assert.doesNotMatch(JSON.stringify(state), /probe-secret-value/);
});

test('atomic start carries the exact visible settings in one message', () => {
  const settings = {
    type: 'startLocal',
    executablePath: '/bin/llama-server',
    modelPath: '/models/a.gguf',
    projectorPath: '',
    draftModelPath: '',
    modelId: 'local-glimmer',
    contextSize: 32768,
    port: 8775,
    idleTimeoutSec: 600,
  } as const;
  const parsed = parseViewInboundMessage({ ...settings });
  assert.equal(parsed.type, 'startLocal');
  if (parsed.type === 'startLocal') {
    assert.equal(parsed.executablePath, '/bin/llama-server');
    assert.equal(parsed.port, 8775);
  }
  // The old empty race (`updateLocalSettings` then bare `startLocal`) is rejected.
  assert.throws(() => parseViewInboundMessage({ type: 'startLocal' }), /Invalid/);
  assert.throws(
    () => parseViewInboundMessage({ ...settings, shell: PROBE }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /probe-secret-value/);
      return true;
    },
  );
});

test('local timeout is displayed in minutes and sent to the host in seconds', () => {
  const script = readFileSync('media/main.js', 'utf8');
  assert.match(script, /idleTimeoutEl\.value = String\(settings\.idleTimeoutSec \/ 60\)/);
  assert.match(script, /idleTimeoutSec: idleTimeoutEl \? Number\(idleTimeoutEl\.value\) \* 60 : NaN/);
});

test('catalog parsing is bounded, redacted, filtered, and ordered', () => {
  const payload = JSON.stringify({
    object: 'list',
    data: [
      { id: 'muse-wonder-1.0', created: 200 },
      { id: 'muse-spark-1.3', created: 100 },
      { id: 'muse-spark-1.3-contributor', created: 300 },
      { id: 'meta-image-1.0', created: 400 },
      { id: 'voice-model-1', created: 500 },
      { id: 'sam-2', created: 600 },
      { id: 'gpt-4', created: 700 },
      { id: 42, created: 800 },
    ],
  });
  const models = parseMetaModelsPayload(payload);
  const ids = models.map((entry) => entry.id);
  // Compatible only, newest-first as returned (API order preserved).
  assert.deepEqual(ids, [
    'muse-wonder-1.0',
    'muse-spark-1.3',
    'muse-spark-1.3-contributor',
  ]);
  assert.ok(!ids.some((id) => /image|voice|sam|gpt/i.test(id)));
  // Contributor labeling.
  const contributor = models.find((entry) => entry.id.includes('contributor'));
  assert.ok(contributor?.contributor);
  assert.match(contributor?.label ?? '', /Contributor/);
  assert.match(cloudModelLabel('muse-spark-1.3-contributor-x'), /Contributor.*data may be used/);
  assert.ok(!isContributorModelId('muse-spark-1.3'));
  // Bounds: oversized payloads and non-list shapes are rejected.
  assert.throws(() => parseMetaModelsPayload('x'.repeat(300000)), /too large/);
  assert.throws(() => parseMetaModelsPayload('{}'), /invalid/);
  assert.throws(() => parseMetaModelsPayload('not-json'), /invalid/);
  // Compatibility filter.
  assert.equal(isCompatibleModelId('muse-spark-1.2'), true);
  assert.equal(isCompatibleModelId('muse-wonder-1.0'), true);
  assert.equal(isCompatibleModelId('muse-spark-1.3-contributor'), true);
  assert.equal(isCompatibleModelId('meta-image-1'), false);
  assert.equal(isCompatibleModelId('gpt-4'), false);
  assert.equal(isCompatibleModelId(''), false);
});

test('invalid and arbitrary cloud models fall back safely, never silently to Contributor', () => {
  const catalog = fallbackCatalog();
  assert.equal(validateCloudModelSelection('muse-spark-1.2', catalog), 'muse-spark-1.2');
  assert.equal(validateCloudModelSelection('muse-wonder-1.0', catalog), 'muse-wonder-1.0');
  assert.equal(validateCloudModelSelection('gpt-4', catalog), CLOUD_MODEL_FALLBACK);
  assert.equal(validateCloudModelSelection('', catalog), CLOUD_MODEL_FALLBACK);
  assert.equal(validateCloudModelSelection(42, catalog), CLOUD_MODEL_FALLBACK);
  assert.equal(
    validateCloudModelSelection('muse-spark-1.3; rm -rf /', catalog),
    CLOUD_MODEL_FALLBACK,
  );
  // A contributor id not in the catalog is not auto-selected.
  assert.equal(
    validateCloudModelSelection('muse-spark-9.9-contributor', catalog),
    CLOUD_MODEL_FALLBACK,
  );
  // Persisted arbitrary values fall back too.
  assert.equal(validateSettings({ cloudModel: 'gpt-4' }).cloudModel, 'muse-spark-1.3');
  // Arbitrary webview selections pass shape checks but the host falls
  // back safely without echoing values.
  const arbitraryShape = parseViewInboundMessage({ type: 'selectCloudModel', model: PROBE });
  assert.equal(arbitraryShape.type, 'selectCloudModel');
  assert.equal(validateCloudModelSelection(PROBE, fallbackCatalog()), CLOUD_MODEL_FALLBACK);
});

test('selected cloud model reaches outbound state and agent wording is not hardcoded', () => {
  const state = buildViewStateMessage({ ...baseState(), cloudModel: 'muse-wonder-1.0' });
  assert.equal(state.cloudModel, 'muse-wonder-1.0');
  assert.equal(state.model, 'muse-wonder-1.0');
  assert.match(scopeNoticeForMode('agent', 'muse-wonder-1.0'), /muse-wonder-1\.0/);
  assert.match(agentScopeNotice('muse-wonder-1.0'), /muse-wonder-1\.0/);
  assert.doesNotMatch(agentScopeNotice('muse-wonder-1.0'), /muse-spark-1\.3/);
  // Fallback catalog is distinguishable from live results.
  const fallback = buildViewStateMessage(baseState());
  assert.equal(fallback.cloudCatalogSource, 'fallback');
  const live = buildViewStateMessage({
    ...baseState(),
    cloudCatalog: [{ id: 'muse-wonder-1.0', label: 'muse-wonder-1.0', contributor: false }],
    cloudCatalogSource: 'live',
  });
  assert.equal(live.cloudCatalogSource, 'live');
  assert.equal(live.cloudCatalog[0]?.id, 'muse-wonder-1.0');
});

test('catalog refresh failures keep a safe fallback with a sanitized error', async () => {
  const failing = await refreshCompatibleModels({
    apiKey: 'secret-that-must-not-appear',
    fetchImpl: async () => Response.json({ error: { message: 'nope' } }, { status: 401 }),
  });
  assert.equal(failing.source, 'fallback');
  assert.ok(failing.models.length > 0);
  assert.doesNotMatch(JSON.stringify(failing), /secret-that-must-not-appear/);
  assert.doesNotMatch(failing.status, /secret-that-must-not-appear/);
  assert.match(failing.status, /fallback/i);

  const throwing = await refreshCompatibleModels({
    apiKey: 'secret-that-must-not-appear',
    fetchImpl: async () => {
      throw new Error('boom secret-that-must-not-appear');
    },
  });
  assert.equal(throwing.source, 'fallback');
  assert.doesNotMatch(throwing.status, /secret-that-must-not-appear/);
  assert.equal(sanitizeCatalogError(new Error('x secret-that-must-not-appear')), 'Could not refresh models. Using fallback catalog.');
});

test('no API key material in outbound state or validation errors', () => {
  const state = buildViewStateMessage(baseState());
  assert.equal(state.hasKey, true);
  assert.ok(!('apiKey' in state));
  assert.ok(!('apiKey' in JSON.parse(JSON.stringify(state))));
  const invalid: unknown[] = [
    { type: 'saveKey', apiKey: PROBE, extra: 1 },
    { type: 'updateSettings', runtime: 'cloud', mode: 'chat', allowCloudEscalation: false, apiKey: PROBE },
    { type: 'startLocal', extra: PROBE },
  ];
  for (const raw of invalid) {
    assert.throws(
      () => parseViewInboundMessage(raw),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /probe-secret-value/);
        return true;
      },
    );
  }
});
