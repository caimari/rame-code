import assert from 'node:assert/strict';
import test from 'node:test';

import { publicEvidenceHasPrivateMaterial, type PublicEvidenceEnvironment } from '../src/publicEvidenceGuard.js';

const env: PublicEvidenceEnvironment = {
  homeDir: '/home/runner',
  tempDir: '/tmp',
  repositoryRoot: '/work/rame-code',
  username: 'runner',
};

test('the GitHub account name runner is allowed in ordinary evidence prose', () => {
  assert.equal(publicEvidenceHasPrivateMaterial('The reinforced case runner rejected forged output.', env), false);
  assert.equal(publicEvidenceHasPrivateMaterial('The test runner completed 44 cases.', env), false);
});

test('public evidence still refuses local paths, structured account names and key material', () => {
  for (const value of [
    'read /home/runner/project/file.js',
    'temporary output: /tmp/private.json',
    'repository: /work/rame-code',
    'username: runner',
    'owner="runner"',
    'C:\\Users\\runner\\project',
    'sk-1234567890abcdef',
    '-----BEGIN PRIVATE KEY-----',
  ]) {
    assert.equal(publicEvidenceHasPrivateMaterial(value, env), true, value);
  }
});
