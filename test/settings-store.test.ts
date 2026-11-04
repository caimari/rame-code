import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultSettings,
  defaultUsageTotals,
  RAME_SETTINGS_KEY,
  RAME_USAGE_KEY,
  SETTINGS_VERSION,
  suggestedLocalSettings,
  validateSettings,
  validateUsageTotals,
} from '../src/settingsStore.js';

test('settings use versioned keys and safe defaults with escalation OFF', () => {
  assert.equal(RAME_SETTINGS_KEY, 'rameCode.settings.v1');
  assert.equal(RAME_USAGE_KEY, 'rameCode.usage.v1');
  assert.equal(SETTINGS_VERSION, 2);

  const defaults = defaultSettings();
  assert.equal(defaults.provider, 'cloud');
  assert.equal(defaults.mode, 'agent');
  assert.equal(defaults.allowCloudEscalation, false);
  assert.equal(defaults.local.idleTimeoutSec, 15 * 60);

  // Unknown input collapses to the same safe defaults.
  const validated = validateSettings(undefined);
  assert.equal(validated.allowCloudEscalation, false);
  assert.equal(validated.provider, 'cloud');
  assert.equal(validated.mode, 'agent');

  // Escalation must be explicitly true; truthy lookalikes stay OFF.
  assert.equal(validateSettings({ allowCloudEscalation: 1 }).allowCloudEscalation, false);
  assert.equal(
    validateSettings({ allowCloudEscalation: true }).allowCloudEscalation,
    true,
  );
});

test('v1 ten-minute default migrates once, but a v2 ten-minute choice is preserved', () => {
  const local = { ...suggestedLocalSettings(), idleTimeoutSec: 600 };
  assert.equal(validateSettings({ version: 1, local }).local.idleTimeoutSec, 900);
  assert.equal(validateSettings({ version: 2, local }).local.idleTimeoutSec, 600);
});

test('settings validation keeps valid choices and drops unknown fields', () => {
  const validated = validateSettings({
    provider: 'local',
    mode: 'mission',
    model: 'local-glimmer',
    allowCloudEscalation: true,
    apiKey: 'secret-that-must-not-persist',
    extra: 1,
  });
  assert.equal(validated.provider, 'local');
  assert.equal(validated.mode, 'mission');
  assert.equal(validated.model, 'local-glimmer');
  assert.ok(!('apiKey' in validated));
  assert.ok(!('extra' in validated));

  assert.equal(validateSettings({ provider: 'remote' }).provider, 'cloud');
  assert.equal(validateSettings({ mode: 'agent' }).mode, 'agent');
  // Suggestions are never forced in: invalid local settings reset to blank.
  assert.equal(validateSettings({}).local.executablePath, '');
});

test('runtime pairing forbids mismatched provider and model', () => {
  // A persisted provider-level runtime id wins; the cloud model is separate.
  const cloud = validateSettings({ runtime: 'cloud' });
  assert.equal(cloud.provider, 'cloud');
  assert.equal(cloud.model, 'muse-spark-1.3');
  assert.equal(cloud.cloudModel, 'muse-spark-1.3');
  const local = validateSettings({ runtime: 'local' });
  assert.equal(local.provider, 'local');
  assert.equal(local.model, 'local-glimmer');
  // Legacy `cloud:<model>` values migrate to the provider choice.
  const legacyCloud = validateSettings({ runtime: 'cloud:muse-spark-1.3' });
  assert.equal(legacyCloud.provider, 'cloud');
  // A subordinate wonder selection persists; arbitrary ids fall back.
  const wonder = validateSettings({ cloudModel: 'muse-wonder-1.0' });
  assert.equal(wonder.cloudModel, 'muse-wonder-1.0');
  assert.equal(wonder.model, 'muse-wonder-1.0');
  const mismatch = validateSettings({ provider: 'cloud', model: 'local-glimmer' });
  assert.equal(mismatch.provider, 'cloud');
  assert.equal(mismatch.model, 'muse-spark-1.3');
  const arbitrary = validateSettings({ cloudModel: 'gpt-4' });
  assert.equal(arbitrary.cloudModel, 'muse-spark-1.3');
  assert.equal(arbitrary.model, 'muse-spark-1.3');
  const mismatchLocal = validateSettings({ provider: 'local', model: 'muse-spark-1.3' });
  assert.equal(mismatchLocal.provider, 'local');
  assert.equal(mismatchLocal.model, 'local-glimmer');
  // Invalid runtime values fall back to the safe cloud pair.
  const invalid = validateSettings({ runtime: 'cloud:other' });
  assert.equal(invalid.provider, 'cloud');
  assert.equal(invalid.model, 'muse-spark-1.3');
});

test('suggestions are offered separately from stored defaults', () => {
  const suggestions = suggestedLocalSettings();
  assert.match(suggestions.executablePath, /llama-server/);
  assert.equal(suggestions.port, 8775);
  assert.equal(suggestions.idleTimeoutSec, 15 * 60);
  // Mutating the suggestion copy never affects later calls.
  suggestions.port = 1;
  assert.equal(suggestedLocalSettings().port, 8775);
});

test('usage totals validate defensively and never carry secrets', () => {
  assert.deepEqual(defaultUsageTotals(), {
    cloud: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 },
    local: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 },
  });
  const validated = validateUsageTotals({
    cloud: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15 },
    local: 'corrupt',
  });
  assert.equal(validated.cloud.totalTokens, 15);
  assert.equal(validated.local.totalTokens, 0);
  assert.deepEqual(validateUsageTotals(null), defaultUsageTotals());
  assert.doesNotMatch(JSON.stringify(validated), /apiKey/);
});
