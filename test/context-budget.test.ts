import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextSelectionBudget,
  selectNewestByCharacterBudget,
} from '../src/contextBudget.js';

test('known model windows expand recent context beyond twenty turns but remain capped', () => {
  const local = contextSelectionBudget(32_768);
  const cloud = contextSelectionBudget(1_048_576);
  const unknown = contextSelectionBudget(null);
  assert.ok(local.recentTurns > 20);
  assert.ok(local.recentChars > unknown.recentChars);
  assert.equal(cloud.recentChars, 120_000);
  assert.equal(unknown.source, 'conservative-default');
});

test('character selection keeps newest complete entries and never silently slices one', () => {
  const selected = selectNewestByCharacterBudget(['old', 'middle-long', 'new'], (value) => value, 12, 10);
  assert.deepEqual(selected, ['new']);
  assert.deepEqual(selectNewestByCharacterBudget(['too-long'], (value) => value, 3, 10), []);
});
