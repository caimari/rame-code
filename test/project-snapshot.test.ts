/**
 * The host's own record of the project files (projectSnapshot.ts): content
 * prints from the bytes, read in blocks; kernel stamps that show a file
 * changed and restored between two records; and every way a file can fail
 * to be checked, which must never read as intact.
 */

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { changeTimesTrusted, foldersTouched, MAX_SNAPSHOT_FILES, printsOf, snapshotProject, touchedBetween, type Snapshot } from '../src/projectSnapshot.js';

type Ok = Snapshot & { ok: true };
const ok = (snapshot: Snapshot): Ok => {
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  return snapshot as Ok;
};

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-snapshot-'));
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('every file outside node_modules and .git gets a SHA-256 of its bytes; folders, links and other entries are told apart', { skip: process.platform === 'win32' ? 'symbolic links need privileges on Windows' : false }, async () => {
  await withRoot(async (root) => {
    mkdirSync(path.join(root, 'lib'));
    mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    mkdirSync(path.join(root, '.git'));
    writeFileSync(path.join(root, 'lib', 'sum.js'), 'a');
    writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'c');
    writeFileSync(path.join(root, '.git', 'HEAD'), 'd');
    symlinkSync('lib/sum.js', path.join(root, 'link.js'));
    const snapshot = ok(await snapshotProject(root));
    assert.deepEqual([...snapshot.files.keys()], ['link.js', 'lib/sum.js']);
    assert.equal(snapshot.files.get('lib/sum.js')?.print, 'sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb:1');
    assert.match(snapshot.files.get('link.js')?.print ?? '', /^symlink:[0-9a-f]{64}$/, 'a link is recorded by its target, never followed');
    assert.deepEqual([...snapshot.folders.keys()], ['', 'lib']);
    assert.deepEqual(snapshot.unreadable, []);
  });
});

test('two different contents of the same size never share a print, also above 8 MiB (no size-only fingerprint)', async () => {
  await withRoot(async (root) => {
    const size = 9 * 1024 * 1024;
    const first = Buffer.alloc(size, 0x61);
    writeFileSync(path.join(root, 'big.bin'), first);
    writeFileSync(path.join(root, 'small.txt'), 'abcd');
    const before = ok(await snapshotProject(root));
    const second = Buffer.from(first);
    second[size - 1] = 0x62; // one byte, at the very end
    writeFileSync(path.join(root, 'big.bin'), second);
    writeFileSync(path.join(root, 'small.txt'), 'abce');
    const after = ok(await snapshotProject(root));
    assert.equal(statSync(path.join(root, 'big.bin')).size, size);
    assert.notEqual(after.files.get('big.bin')?.print, before.files.get('big.bin')?.print);
    assert.notEqual(after.files.get('small.txt')?.print, before.files.get('small.txt')?.print);
    assert.equal(after.bytes, size + 4, 'every byte was read');
  });
});

test('a file that cannot be read is reported, never recorded as intact', { skip: process.platform === 'win32' ? 'chmod does not block reads on Windows' : process.getuid?.() === 0 ? 'root reads every file' : false }, async () => {
  await withRoot(async (root) => {
    writeFileSync(path.join(root, 'secret.txt'), 'x');
    chmodSync(path.join(root, 'secret.txt'), 0o000);
    try {
      const snapshot = ok(await snapshotProject(root));
      assert.deepEqual(snapshot.unreadable, ['secret.txt']);
      assert.equal(snapshot.files.get('secret.txt')?.print, 'unreadable');
    } finally {
      chmodSync(path.join(root, 'secret.txt'), 0o600);
    }
  });
});

test('limits: too many files, too many bytes, or a stop: no partial record', async () => {
  await withRoot(async (root) => {
    writeFileSync(path.join(root, 'a.txt'), 'aaaa');
    writeFileSync(path.join(root, 'b.txt'), 'bbbb');
    assert.deepEqual(await snapshotProject(root, { maxFiles: 1 }), { ok: false, reason: 'too-many-files', detail: 'more than 1 files' });
    assert.equal((await snapshotProject(root, { maxBytes: 5 })).ok, false);
    assert.equal(((await snapshotProject(root, { maxBytes: 5 })) as { reason: string }).reason, 'too-large');
    const controller = new AbortController();
    controller.abort();
    assert.equal(((await snapshotProject(root, { signal: controller.signal })) as { reason: string }).reason, 'aborted');
    assert.equal(((await snapshotProject(path.join(root, 'missing'))) as { reason: string }).reason, 'unreadable-root');
    assert.equal(MAX_SNAPSHOT_FILES, 2000);
  });
});

test('guarantee B: a file changed and restored between two records is seen by its kernel stamp, even with its old content and mtime', { skip: changeTimesTrusted() ? false : 'change times are not trusted on this platform' }, async () => {
  await withRoot(async (root) => {
    mkdirSync(path.join(root, 'acceptance'));
    writeFileSync(path.join(root, 'data.txt'), '5');
    writeFileSync(path.join(root, 'acceptance', 'cases.json'), '[]');
    const old = statSync(path.join(root, 'data.txt'));
    const before = ok(await snapshotProject(root));
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(path.join(root, 'data.txt'), '0');
    writeFileSync(path.join(root, 'data.txt'), '5');
    utimesSync(path.join(root, 'data.txt'), old.atime, old.mtime); // even the modification time is put back
    writeFileSync(path.join(root, 'acceptance', 'extra.json'), '{}');
    rmSync(path.join(root, 'acceptance', 'extra.json'));
    const after = ok(await snapshotProject(root));
    assert.equal(after.files.get('data.txt')?.print, before.files.get('data.txt')?.print, 'same content at start and end (guarantee A alone sees nothing)');
    assert.deepEqual(touchedBetween(before, after), ['data.txt'], 'the change time shows it');
    assert.deepEqual(foldersTouched(before, after, ['acceptance']), ['acceptance'], 'a file added and removed in a folder changes the folder');
    assert.deepEqual(touchedBetween(after, ok(await snapshotProject(root))), [], 'reading changes nothing');
    assert.deepEqual([...printsOf(after).keys()].sort(), ['acceptance/cases.json', 'data.txt']);
  });
});

test('Windows: change times are not trusted, so only the start and end state is claimed there', () => {
  assert.equal(changeTimesTrusted('win32'), false);
  assert.equal(changeTimesTrusted('linux'), true);
  assert.equal(changeTimesTrusted('darwin'), true);
});

test('a file that changes while it is being hashed is unreadable, never a mixed print', async () => {
  await withRoot(async (root) => {
    const file = path.join(root, 'big.bin');
    writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 0x61)); // three blocks
    const snapshot = ok(await snapshotProject(root, { afterFirstBlock: () => appendFileSync(file, 'b') }));
    assert.deepEqual(snapshot.unreadable, ['big.bin']);
    assert.equal(snapshot.files.get('big.bin')?.print, 'unreadable');
  });
});
