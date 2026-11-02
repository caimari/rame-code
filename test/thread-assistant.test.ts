import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendAssistantTurn,
  createThread,
  ThreadStore,
  validateThreadRecord,
} from '../src/threadStore.js';

test('assistant turns validate, persist, and render alongside user turns', () => {
  const thread = createThread('Explain closures conversationally.', {
    now: 1000,
    id: 't-chat1',
  });
  const withReply = appendAssistantTurn(thread, 'A closure captures scope.', 2000);
  assert.equal(withReply.turns.length, 2);
  assert.equal(withReply.turns[0]?.kind, 'user');
  assert.equal(withReply.turns[1]?.kind, 'assistant');
  // The original record is untouched; the user turn survives revalidation.
  assert.equal(thread.turns.length, 1);
  const parsed = validateThreadRecord(JSON.parse(JSON.stringify(withReply)));
  assert.ok(parsed);
  assert.equal(parsed?.turns.length, 2);

  // Empty or hostile assistant text is rejected without echoing content.
  assert.equal(
    validateThreadRecord({
      id: 't-hostile',
      title: 'Hostile',
      createdAt: 1,
      updatedAt: 2,
      turns: [
        { kind: 'user', text: 'A valid message text.', timestamp: 1 },
        { kind: 'assistant', text: '   ', timestamp: 2 },
      ],
    })?.turns.length,
    1,
  );
  assert.equal(
    validateThreadRecord({
      id: 't-evil',
      title: 'Evil',
      createdAt: 1,
      updatedAt: 2,
      turns: [
        {
          kind: 'assistant',
          text: 'x',
          timestamp: 2,
          apiKey: 'secret-that-must-not-appear',
        },
      ],
    }),
    null,
  );
});

test('assistant replies persist through the store without key material', () => {
  let saved: unknown;
  const store = new ThreadStore(
    {
      get: () => undefined,
      update: (_key: string, value: unknown) => {
        saved = value;
      },
    },
    () => 5000,
  );
  const created = store.create('Explain closures conversationally.');
  store.save(appendAssistantTurn(created, 'A closure captures scope.', 6000));
  const reloaded = store.get(created.id);
  assert.equal(reloaded?.turns.length, 2);
  assert.doesNotMatch(JSON.stringify(saved), /apiKey/);
});
