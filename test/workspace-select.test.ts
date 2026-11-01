import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWorkspacePickItems,
  normalizeOpenFolders,
  NO_WORKSPACE_MESSAGE,
  validateChosenWorkspace,
  workspaceCountPolicy,
  workspaceDisplayLabel,
  WORKSPACE_PICK_CANCELLED,
} from '../src/workspaceSelect.js';

test('no folders is an empty state, one folder auto-uses, multi requires choice', () => {
  assert.equal(workspaceCountPolicy(undefined), 'none');
  assert.equal(workspaceCountPolicy([]), 'none');
  assert.equal(
    workspaceCountPolicy([{ name: 'only', path: '/ws' }]),
    'single',
  );
  assert.equal(
    workspaceCountPolicy([
      { name: 'a', path: '/a' },
      { name: 'b', path: '/b' },
    ]),
    'multi',
  );
});

test('QuickPick items show folder name and full filesystem path', () => {
  const items = buildWorkspacePickItems([
    { name: 'alpha', path: '/work/alpha' },
    { name: 'beta', path: '/work/beta/' },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.label, 'alpha');
  assert.equal(items[0]?.description, '/work/alpha');
  assert.equal(items[0]?.detail, '/work/alpha');
  assert.equal(items[1]?.description, '/work/beta');
});

test('only an exactly open folder validates; model/webview paths never validate', () => {
  const open = normalizeOpenFolders([
    { name: 'a', path: '/a' },
    { name: 'b', path: '/b' },
  ]);
  assert.equal(validateChosenWorkspace('/a', open), '/a');
  assert.equal(validateChosenWorkspace('/b/', open), '/b');
  assert.equal(validateChosenWorkspace('/c', open), null);
  assert.equal(validateChosenWorkspace('', open), null);
  assert.equal(validateChosenWorkspace(undefined, open), null);
  assert.equal(validateChosenWorkspace('/a/../b', open), null);
  // Never silently normalize to the first folder.
  assert.notEqual(validateChosenWorkspace('/unknown', open), '/a');
});

test('display label stays compact and verifiable; cancel/empty messages are concise', () => {
  assert.equal(
    workspaceDisplayLabel({ name: 'alpha', path: '/work/alpha' }),
    'alpha — /work/alpha',
  );
  assert.equal(workspaceDisplayLabel({ name: '', path: '/ws' }), '/ws');
  assert.equal(workspaceDisplayLabel(null), null);
  assert.match(NO_WORKSPACE_MESSAGE, /No workspace folder is open/);
  assert.match(NO_WORKSPACE_MESSAGE, /Open a folder/);
  assert.match(WORKSPACE_PICK_CANCELLED, /cancelled/i);
  assert.doesNotMatch(WORKSPACE_PICK_CANCELLED, /error/i);
});
