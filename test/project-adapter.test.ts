import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentFs, AgentFsEntry } from '../src/agentHost.js';
import {
  ACCEPTANCE_ENVIRONMENT_FILES,
  listAcceptanceCandidates,
  npmProjectAdapter,
} from '../src/projectAdapters/npmProjectAdapter.js';

function treeFs(tree: Record<string, AgentFsEntry[]>): AgentFs {
  return {
    async listEntries(rel) {
      const entries = tree[rel];
      if (!entries) {
        throw new Error('missing');
      }
      return entries;
    },
    async readText() {
      throw new Error('not used');
    },
    async stat() {
      return { kind: 'missing' };
    },
    async writeText() {
      throw new Error('not used');
    },
  };
}

const file = (name: string): AgentFsEntry => ({ name, isFile: true, isDir: false, isSymlink: false });
const dir = (name: string): AgentFsEntry => ({ name, isFile: false, isDir: true, isSymlink: false });
const link = (name: string): AgentFsEntry => ({ name, isFile: false, isDir: false, isSymlink: true });

test('npm project adapter exposes its stable environment boundary', () => {
  assert.equal(npmProjectAdapter.id, 'npm');
  assert.deepEqual(npmProjectAdapter.acceptanceEnvironmentFiles, ACCEPTANCE_ENVIRONMENT_FILES);
  assert.deepEqual(ACCEPTANCE_ENVIRONMENT_FILES, ['package-lock.json', 'npm-shrinkwrap.json', 'tsconfig.json', '.npmrc']);
});

test('acceptance discovery is bounded to test-like files and skips dependencies, output, and links', async () => {
  const fs = treeFs({
    '': [dir('test'), dir('acceptance'), dir('src'), dir('node_modules'), dir('out'), link('linked-tests'), file('root.test.ts'), file('README.md')],
    test: [file('unit.ts'), file('fixture.txt')],
    acceptance: [file('contract.js')],
    src: [file('feature.spec.ts'), file('feature.ts')],
  });
  assert.deepEqual(await listAcceptanceCandidates(fs), [
    'acceptance/contract.js',
    'root.test.ts',
    'src/feature.spec.ts',
    'test/unit.ts',
  ]);
});
