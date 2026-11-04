import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { clearEmbeddingCapabilityCache, retrieveLocalSemanticScores } from '../src/localEmbeddings.js';

test('reserved embedding client is loopback-only and opt-in', async () => {
  clearEmbeddingCapabilityCache();
  let called = false;
  const external = await retrieveLocalSemanticScores({
    endpoint: 'https://example.com', model: 'x', query: 'q', candidates: [{ id: 1, text: 'x' }],
    fetchImpl: async () => { called = true; return new Response(); },
  });
  assert.equal(external.status, 'unavailable');
  assert.equal(called, false);
});

test('reserved client returns exact candidate ids from a compatible local response', async () => {
  const result = await retrieveLocalSemanticScores({
    endpoint: 'http://127.0.0.1:9911', model: 'optional', query: 'offline', candidates: [{ id: 7, text: 'without Internet' }],
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [0.9, 0.1] }] }), { status: 200 }),
  });
  assert.equal(result.status, 'used');
  assert.ok((result.scores.get(7) ?? 0) > 0.9);
});

test('v0.2 runtime entry paths do not import the reserved embedding architecture', () => {
  for (const file of [
    'src/agentEngine.ts',
    'src/generationController.ts',
    'src/requestBuilder.ts',
    'src/missionCoordinator.ts',
    'src/mainProvider.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\/(?:localEmbeddings|semanticContinuity)\.js['"]/, file);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: unknown; optionalDependencies?: unknown };
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.optionalDependencies ?? {}, {});
});
