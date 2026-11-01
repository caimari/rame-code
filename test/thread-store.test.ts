import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendErrorTurn,
  appendPlanTurn,
  appendUserTurn,
  createThread,
  deriveTitle,
  loadThreads,
  MAX_THREADS,
  THREAD_STORE_KEY,
  ThreadStore,
  upsertThread,
  validateThreadRecord,
} from '../src/threadStore.js';
import type { MissionPlan } from '../src/types.js';

const PLAN: MissionPlan = {
  goal: 'Add a greeting command',
  assumptions: ['Runs locally.'],
  steps: [
    {
      id: 'step-1',
      title: 'Define the command',
      successCriterion: 'Registered and tested.',
    },
  ],
  risks: [],
};

function makeThread(id: string, updatedAt: number, title = `Thread ${id}`) {
  return {
    id,
    title,
    createdAt: Math.max(0, updatedAt - 10),
    updatedAt,
    turns: [{ kind: 'user', text: 'A valid mission goal text.', timestamp: updatedAt } as const],
  };
}

test('thread store uses a versioned globalState key and bounds history', () => {
  assert.equal(THREAD_STORE_KEY, 'rameCode.threads.v1');
  assert.equal(MAX_THREADS, 50);
});

test('deriveTitle uses the first line, collapses whitespace, and bounds length', () => {
  assert.equal(deriveTitle('Add a verified greeting command'), 'Add a verified greeting command');
  assert.equal(deriveTitle('  First line  with   gaps\nSecond line'), 'First line with gaps');
  assert.equal(deriveTitle(''), 'New thread');
  assert.equal(deriveTitle('   \n  '), 'New thread');
  const long = `x${'y'.repeat(200)}`;
  const title = deriveTitle(long);
  assert.ok(title.length <= 60);
  assert.match(title, /…$/);
});

test('validateThreadRecord accepts a valid record and rejects key material', () => {
  const valid = {
    id: 't-abc123',
    title: 'Greeting work',
    createdAt: 1000,
    updatedAt: 2000,
    turns: [{ kind: 'user', text: 'A valid mission goal text.', timestamp: 1000 }],
  };
  const parsed = validateThreadRecord(valid);
  assert.ok(parsed);
  assert.equal(parsed?.title, 'Greeting work');

  // Any extra field — including an apiKey — rejects the whole record.
  assert.equal(
    validateThreadRecord({ ...valid, apiKey: 'secret-that-must-not-appear' }),
    null,
  );
  assert.equal(validateThreadRecord({ ...valid, extra: 1 }), null);
  assert.equal(validateThreadRecord({ ...valid, turns: [] }), null);
  assert.equal(validateThreadRecord({ ...valid, id: '' }), null);
  assert.equal(validateThreadRecord(null), null);
  assert.equal(validateThreadRecord([]), null);
});

test('validateThreadRecord migrates a missing title and drops invalid turns', () => {
  const migrated = validateThreadRecord({
    id: 't-migrate1',
    createdAt: 1000,
    updatedAt: 2000,
    turns: [
      { kind: 'user', text: 'Build the report view first please.', timestamp: 1000 },
      { kind: 'user', text: '', timestamp: 1001 },
      { kind: 'plan', plan: { goal: 'x' }, timestamp: 1002 },
    ],
  });
  assert.ok(migrated);
  assert.equal(migrated?.title, 'Build the report view first please.');
  assert.equal(migrated?.turns.length, 1);

  // A blank stored title is re-derived rather than kept.
  const blank = validateThreadRecord({
    id: 't-blank1',
    title: '   ',
    createdAt: 1000,
    updatedAt: 2000,
    turns: [{ kind: 'user', text: 'Rebuild the sync worker safely.', timestamp: 1000 }],
  });
  assert.equal(blank?.title, 'Rebuild the sync worker safely.');
});

test('loadThreads validates, sorts most-recent-first, and bounds to 50', () => {
  const threads = [];
  for (let i = 0; i < 60; i++) {
    threads.push(makeThread(`t-${i}`, 1000 + i));
  }
  const loaded = loadThreads([
    ...threads,
    { id: 't-evil', title: 'Evil', createdAt: 1, updatedAt: 2, apiKey: 'k', turns: [] },
  ]);
  assert.equal(loaded.length, 50);
  assert.equal(loaded[0]?.id, 't-59');
  assert.ok(loaded.every((thread) => thread.id !== 't-evil'));

  // Accepts the { threads: [...] } wrapper and rejects non-lists.
  assert.equal(loadThreads({ threads: [makeThread('t-a', 5)] }).length, 1);
  assert.deepEqual(loadThreads(undefined), []);
  assert.deepEqual(loadThreads('hostile'), []);
});

test('create/append/upsert keep threads independent and bounded', () => {
  const thread = createThread('  Ship the onboarding flow.  ', { now: 5000, id: 't-new1' });
  assert.equal(thread.id, 't-new1');
  assert.equal(thread.title, 'Ship the onboarding flow.');
  assert.equal(thread.turns.length, 1);

  const withSecond = appendUserTurn(thread, 'A second independent mission.', 6000);
  assert.equal(withSecond.turns.length, 2);
  assert.equal(thread.turns.length, 1);

  const withPlan = appendPlanTurn(thread, PLAN, 7000);
  assert.equal(withPlan.turns.length, 2);
  assert.equal(withPlan.turns[1]?.kind, 'plan');

  const withError = appendErrorTurn(thread, 'Planning failed.', 8000);
  assert.equal(withError.turns[1]?.kind, 'error');

  const list = upsertThread([makeThread('t-old', 100)], withSecond);
  assert.equal(list[0]?.id, withSecond.id);
});

test('ThreadStore persists only thread records, never the API key', () => {
  let saved: unknown;
  const storage = {
    get: (_key: string) => undefined,
    update: (_key: string, value: unknown) => {
      saved = value;
    },
  };
  const store = new ThreadStore(storage, () => 9000);
  const created = store.create('Persist this mission goal text.');
  assert.equal(store.list().length, 1);
  assert.equal(store.get(created.id)?.title, 'Persist this mission goal text.');
  assert.doesNotMatch(JSON.stringify(saved), /apiKey/);

  // Untrusted stored data is validated on load: hostile records are dropped.
  const hostile = {
    get: (_key: string) => [
      {
        id: 't-good',
        title: 'Good thread',
        createdAt: 1,
        updatedAt: 2,
        turns: [{ kind: 'user', text: 'A valid mission goal text.', timestamp: 1 }],
      },
      { id: 't-bad', title: 'Bad', createdAt: 1, updatedAt: 2, apiKey: 'k', turns: [] },
    ],
    update: () => {},
  };
  const second = new ThreadStore(hostile);
  assert.equal(second.load().length, 1);
  assert.equal(second.load()[0]?.id, 't-good');
});

test('ThreadStore deletes exactly one existing thread and persists', () => {
  let stored: unknown;
  const storage = {
    get: () => stored,
    update: (_key: string, value: unknown) => {
      stored = value;
    },
  };
  const store = new ThreadStore(storage, () => 1000);
  const first = store.create('First task');
  const second = store.create('Second task');
  assert.equal(store.delete(first.id), true);
  assert.equal(store.get(first.id), undefined);
  assert.equal(store.get(second.id)?.id, second.id);
  assert.equal(store.delete(first.id), false);
  assert.deepEqual(stored, [second]);
});
