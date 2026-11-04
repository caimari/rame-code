import assert from 'node:assert/strict';
import test from 'node:test';

import { rankLexically } from '../src/lexicalRetrieval.js';

test('normalization, morphology and small cross-language concepts retrieve without embeddings', () => {
  const docs = [
    { id: 1, text: 'El programa debe funcionar sin Internet.' },
    { id: 2, text: 'Ajustamos colores y botones.' },
  ];
  const hits = rankLexically('compatible with completely disconnected environments', docs);
  assert.equal(hits[0]?.id, 1);
  assert.equal(hits[0]?.match, 'expanded');
  assert.equal(rankLexically('validaciones ejecutadas', [{ id: 3, text: 'validar las pruebas' }])[0]?.id, 3);
  assert.equal(rankLexically('autorizacion', [{ id: 4, text: 'Autorización aprobada' }])[0]?.id, 4);
});

test('exact paths and entities outrank generic matches', () => {
  const hits = rankLexically('src/offline-sync.ts', [
    { id: 1, text: 'Read a file in src/ui.ts.' },
    { id: 2, text: 'Changed src/offline-sync.ts after the check.' },
  ]);
  assert.equal(hits[0]?.id, 2);
  assert.equal(hits[0]?.match, 'exact');
});
