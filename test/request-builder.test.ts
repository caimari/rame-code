import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRequestMessages,
  CHAT_SYSTEM_PROMPT,
  MAX_HISTORY_CHARS,
  MISSION_SYSTEM_PROMPT,
  selectActiveThreadHistory,
} from '../src/requestBuilder.js';
import type { ChatThread } from '../src/threadStore.js';

function user(text: string, timestamp: number) {
  return { kind: 'user' as const, text, timestamp };
}

function assistant(text: string, timestamp: number) {
  return { kind: 'assistant' as const, text, timestamp };
}

function threadWith(turns: ChatThread['turns']): ChatThread {
  return { id: 't-active', title: 'Active', createdAt: 1, updatedAt: 99, turns };
}

test('Mission sends only the new message, never thread history', () => {
  const active = threadWith([
    user('Earlier mission about billing reports.', 1),
    assistant('Earlier assistant reply.', 2),
  ]);
  const built = buildRequestMessages({
    mode: 'mission',
    activeThread: active,
    currentText: '  Build the export dialog.  ',
  });
  assert.equal(built.mode, 'mission');
  assert.equal(built.messages.length, 2);
  assert.equal(built.messages[0]?.role, 'system');
  assert.equal(built.messages[0]?.content, MISSION_SYSTEM_PROMPT);
  assert.deepEqual(built.messages[1], {
    role: 'user',
    content: 'Build the export dialog.',
  });
  const serialized = JSON.stringify(built.messages);
  assert.doesNotMatch(serialized, /billing reports/);
});

test('Chat sends bounded active-thread history plus the new message', () => {
  const active = threadWith([
    user('What is a closure?', 1),
    assistant('A function capturing scope.', 2),
  ]);
  const built = buildRequestMessages({
    mode: 'chat',
    activeThread: active,
    currentText: 'Give an example.',
  });
  assert.equal(built.mode, 'chat');
  assert.equal(built.messages[0]?.content, CHAT_SYSTEM_PROMPT);
  assert.deepEqual(built.messages[built.messages.length - 1], {
    role: 'user',
    content: 'Give an example.',
  });
  const roles = built.messages.map((message) => message.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);
});

test('the user message persisted before generation is sent only once', () => {
  const active = threadWith([
    user('Earlier question.', 1),
    assistant('Earlier answer.', 2),
    user('Current question.', 3),
  ]);
  const built = buildRequestMessages({
    mode: 'chat',
    activeThread: active,
    currentText: 'Current question.',
  });
  assert.equal(
    built.messages.filter((message) => message.role === 'user' && message.content === 'Current question.').length,
    1,
  );
});

test('history uses only the active thread and stays within bounds', () => {
  const otherText = 'Other-thread secret topic marsupial.';
  void otherText;
  const active = threadWith([user('Active topic: closures.', 1)]);
  const history = selectActiveThreadHistory(active);
  assert.equal(history.length, 1);
  assert.doesNotMatch(JSON.stringify(history), /marsupial/);

  // Turn-count bound: only the most recent turns survive.
  const many = threadWith(
    Array.from({ length: 30 }, (_, index) =>
      user(`History message number ${index}.`, index + 1),
    ),
  );
  const bounded = selectActiveThreadHistory(many);
  assert.ok(bounded.length <= 20);
  assert.match(bounded[bounded.length - 1]?.content ?? '', /number 29/);

  // Character bound: history never exceeds the budget.
  const long = threadWith([user(`x${'y'.repeat(MAX_HISTORY_CHARS + 500)}`, 1)]);
  const trimmed = selectActiveThreadHistory(long);
  const chars = trimmed.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(chars <= MAX_HISTORY_CHARS);
  assert.equal(trimmed.length, 0, 'an over-budget old turn is omitted whole, never silently sliced');

  // Error notes are skipped; plan turns contribute goal text.
  const mixed = selectActiveThreadHistory(
    threadWith([
      { kind: 'error', message: 'Planning failed.', timestamp: 1 },
      {
        kind: 'plan',
        plan: {
          goal: 'Ship dialog',
          assumptions: [],
          steps: [{ id: 's1', title: 'Build it', successCriterion: 'Done.' }],
          risks: [],
        },
        timestamp: 2,
      },
    ]),
  );
  assert.equal(mixed.length, 1);
  assert.match(mixed[0]?.content ?? '', /Ship dialog/);
});
