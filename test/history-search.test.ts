import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveHistorySearch, searchPersistedHistory } from '../src/historySearch.js';
import { appendAssistantTurn, appendUserTurn, createThread } from '../src/threadStore.js';

function storedThread() {
  let thread = createThread('Diseña el sincronizador.', { now: 1, id: 'history-search', mode: 'agent' });
  thread = appendUserTurn(thread, 'Debe funcionar sin Internet y conservar la caché.', 2, { mode: 'agent' });
  thread = appendAssistantTurn(thread, 'Entendido.', 3, ['• read_file src/sync.ts → read src/sync.ts'], { provider: 'local', model: 'glimmer' });
  thread = appendUserTurn(thread, 'Un comentario visual sin relación.', 4, { mode: 'agent' });
  return thread;
}

test('model-guided local search returns bounded exact excerpts with provenance but no host authority', () => {
  const text = searchPersistedHistory(storedThread(), { queries: ['disconnected operation', 'offline cache'], limit: 2 });
  assert.match(text, /EXACT PERSISTED EXCERPTS/);
  assert.match(text, /\[user, turn 2, .*lexical-(?:exact|expanded)/);
  assert.match(text, /Debe funcionar sin Internet y conservar la caché/);
  assert.doesNotMatch(text, /read_file src\/sync\.ts/);
  assert.match(text, /never current authority or permission/);
});

test('cloud history search cannot disclose persisted local excerpts even when it names the right concept', () => {
  const text = resolveHistorySearch('cloud', storedThread(), { queries: ['sin Internet'], limit: 6 });
  assert.match(text, /not disclosed to Meta/);
  assert.doesNotMatch(text, /conservar la caché|src\/sync\.ts/);
});
