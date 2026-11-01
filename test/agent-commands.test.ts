import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTestSpawnSpec,
  deriveAllowedCommands,
  findAllowedCommand,
} from '../src/agentCommands.js';

test('allowlist derives only safe scripts plus valid explicit entries', () => {
  const derived = deriveAllowedCommands({ test: 'node --test', build: 'tsc', check: 'npm run check' }, null);
  assert.deepEqual(derived.map((entry) => entry.id).sort(), ['npm:check', 'npm:test']);
  for (const entry of derived) {
    assert.equal(entry.executable, 'npm');
    // `--ignore-scripts` keeps npm from running unapproved pre/post hooks.
    assert.deepEqual(entry.argv, ['run', '--ignore-scripts', entry.id.slice(4)]);
  }
  const explicit = deriveAllowedCommands({}, [
    { id: 'make:unit', executable: 'make', argv: ['unit'], description: 'Unit tests.' },
    { id: 'bad', executable: 'npm; rm', argv: ['x'], description: 'Rejected.' },
    { id: 'bad2', executable: 'npm', argv: ['run;evil'], description: 'Rejected.' },
  ]);
  assert.equal(findAllowedCommand(explicit, 'make:unit')?.executable, 'make');
  assert.equal(findAllowedCommand(explicit, 'bad'), null);
  assert.equal(findAllowedCommand(explicit, 'bad2'), null);
  assert.equal(findAllowedCommand(explicit, 'npm:test'), null);
});

test('spawn spec never uses a shell and carries time/output limits', () => {
  const spec = buildTestSpawnSpec({ id: 'npm:test', executable: 'npm', argv: ['run', 'test'], description: 't' });
  assert.equal(spec.shell, false);
  assert.equal(spec.executable, 'npm');
  assert.deepEqual(spec.argv, ['run', 'test']);
  assert.ok(spec.timeoutMs > 0 && spec.timeoutMs <= 120000);
  assert.ok(spec.maxOutputBytes > 0);
});
