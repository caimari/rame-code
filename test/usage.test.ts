import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addUsage,
  EMPTY_USAGE,
  ESTIMATE_RATES,
  estimateCostUsd,
  parseUsage,
} from '../src/usage.js';

test('parses OpenAI-style usage fields defensively', () => {
  assert.deepEqual(
    parseUsage({
      usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
        total_tokens: 165,
      },
    }),
    { inputTokens: 120, outputTokens: 45, cachedTokens: 0, totalTokens: 165 },
  );
  // Vendor variants and nested cached details.
  assert.deepEqual(
    parseUsage({
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    }),
    { inputTokens: 10, outputTokens: 4, cachedTokens: 3, totalTokens: 14 },
  );
});

test('missing or malformed usage counts as zero without throwing', () => {
  assert.deepEqual(parseUsage({}), EMPTY_USAGE);
  assert.deepEqual(parseUsage(null), EMPTY_USAGE);
  assert.deepEqual(parseUsage({ usage: null }), EMPTY_USAGE);
  assert.deepEqual(
    parseUsage({ usage: { prompt_tokens: 'many', total_tokens: -5 } }),
    EMPTY_USAGE,
  );
  // Never mutates the shared empty record.
  const parsed = parseUsage({ usage: { prompt_tokens: 7 } });
  assert.equal(EMPTY_USAGE.inputTokens, 0);
  assert.equal(parsed.inputTokens, 7);
});

test('accounting adds per-call usage into separated totals', () => {
  const call = {
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 10,
    totalTokens: 150,
  };
  const total = addUsage(
    { inputTokens: 1000, outputTokens: 200, cachedTokens: 0, totalTokens: 1200 },
    call,
  );
  assert.deepEqual(total, {
    inputTokens: 1100,
    outputTokens: 250,
    cachedTokens: 10,
    totalTokens: 1350,
  });
});

test('monetary figures are labeled estimates from named dated rates', () => {
  assert.equal(ESTIMATE_RATES.ratesDated, '2026-11-01');
  const cost = estimateCostUsd(
    { inputTokens: 1_000_000, outputTokens: 500_000, cachedTokens: 0, totalTokens: 1_500_000 },
    { inputPerMillionUsd: 2, outputPerMillionUsd: 8, ratesDated: '2026-11-01' },
  );
  assert.equal(cost, 6);
  assert.equal(
    estimateCostUsd({ inputTokens: 10, outputTokens: 10, cachedTokens: 0, totalTokens: 20 }),
    0,
  );
});
