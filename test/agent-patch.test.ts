import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPatchAtomically, hashContent, type PatchHost } from '../src/agentPatch.js';
import type { PatchFileInput } from '../src/agentTools.js';

function memoryHost(
  files: Record<string, string>,
  special: Record<string, 'dir' | 'symlink' | 'other'> = {},
  failOnWrite: string[] = [],
): { host: PatchHost; written: string[] } {
  const store = new Map(Object.entries(files));
  const written: string[] = [];
  const host: PatchHost = {
    inspect(rel: string) {
      if (special[rel] === 'dir') {
        return { kind: 'dir', bytes: '' };
      }
      if (special[rel] === 'symlink') {
        return { kind: 'symlink', bytes: '' };
      }
      if (special[rel] === 'other') {
        return { kind: 'other', bytes: '' };
      }
      if (!store.has(rel)) {
        return { kind: 'missing', bytes: '' };
      }
      return { kind: 'file', bytes: store.get(rel) as string };
    },
    write(rel: string, content: string) {
      if (failOnWrite.includes(rel)) {
        throw new Error('interrupted');
      }
      written.push(rel);
      store.set(rel, content);
    },
  };
  return { host, written };
}

function op(path: string, current: string, next: string): PatchFileInput {
  return { path, expectedHash: hashContent(current), newContent: next };
}

test('patch applies atomically and returns verified digests', () => {
  const { host } = memoryHost({ 'a.ts': 'old', 'b.ts': 'keep' });
  const result = applyPatchAtomically([op('a.ts', 'old', 'new')], host);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]?.path, 'a.ts');
    assert.equal(result.files[0]?.oldHash, hashContent('old'));
    assert.equal(result.files[0]?.newHash, hashContent('new'));
    assert.equal(host.inspect('a.ts').bytes, 'new');
  }
});

test('stale preconditions, dirs, symlinks, and escapes are rejected', () => {
  const { host } = memoryHost({ 'a.ts': 'changed' });
  const stale = applyPatchAtomically([op('a.ts', 'old', 'new')], host);
  assert.equal(stale.ok, false);
  assert.equal(host.inspect('a.ts').bytes, 'changed');

  const dirHost = memoryHost({}, { 'docs': 'dir' });
  assert.equal(applyPatchAtomically([op('docs', '', 'x')], dirHost.host).ok, false);

  const linkHost = memoryHost({ 'link': 'x' }, { 'link': 'symlink' });
  assert.equal(applyPatchAtomically([op('link', 'x', 'y')], linkHost.host).ok, false);

  const { host: escHost } = memoryHost({ 'a.ts': 'x' });
  assert.equal(
    applyPatchAtomically([{ path: '../escape', expectedHash: 'a'.repeat(64), newContent: 'x' }], escHost).ok,
    false,
  );
  assert.equal(
    applyPatchAtomically([{ path: '.git/config', expectedHash: 'a'.repeat(64), newContent: 'x' }], escHost).ok,
    false,
  );
});

test('interrupted writes restore originals and never report success', () => {
  const { host } = memoryHost(
    { 'a.ts': 'A', 'b.ts': 'B' },
    {},
    ['b.ts'],
  );
  const first: PatchFileInput = op('a.ts', 'A', 'A2');
  const second: PatchFileInput = op('b.ts', 'B', 'B2');
  const result = applyPatchAtomically([first, second], host);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /interrupted|restored/i);
  }
  assert.equal(host.inspect('a.ts').bytes, 'A');
});

test('patch bounds reject oversized and duplicate operations', () => {
  const { host } = memoryHost({ 'a.ts': 'x' });
  const big: PatchFileInput = { path: 'a.ts', expectedHash: hashContent('x'), newContent: 'y'.repeat(200 * 1024) };
  assert.equal(applyPatchAtomically([big], host).ok, false);
  const dup = [op('a.ts', 'x', 'y'), op('a.ts', 'x', 'z')];
  assert.equal(applyPatchAtomically(dup, host).ok, false);
  assert.equal(applyPatchAtomically([], host).ok, false);
});
