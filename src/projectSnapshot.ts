/**
 * The host's own record of a project's files, read straight from disk.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * For every file outside `node_modules` and `.git` (at most `MAX_SNAPSHOT_FILES`
 * files and `MAX_SNAPSHOT_BYTES` bytes in all), the snapshot keeps:
 *   - `print`: the SHA-256 of the file's bytes, read in 1 MiB blocks (a large
 *     file is never held in memory) plus its size. Size alone is never used;
 *   - `stamp`: what the kernel reports about the file (device, inode, size,
 *     modification and status-change times, in nanoseconds).
 *
 * The print answers "is the content the same?". The stamp answers "was the
 * file written, replaced or touched in between?": on Linux and macOS the
 * status-change time (ctime) is set by the kernel on every write, rename or
 * metadata change, and no ordinary process can set it back. Comparing stamps
 * taken just before and just after a run therefore shows a file changed and
 * restored during it, without relying on file-system events that can be
 * lost. On Windows the change time can be set by programs, so it is not
 * trusted there (see `changeTimesTrusted`).
 *
 * A file that cannot be read, or that changed while it was being hashed, is
 * reported as such: callers treat it as not verifiable, never as intact.
 */

import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp, type BigIntStats } from 'node:fs';
import * as path from 'node:path';

/** Stored with every manifest: a print made by another method is never compared with this one. */
export const FINGERPRINT_VERSION = 'sha256-bytes-v2';
export const MAX_SNAPSHOT_FILES = 2_000;
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024 * 1024;
const BLOCK_BYTES = 1024 * 1024;
const SKIPPED_FOLDERS = new Set(['node_modules', '.git']);

export interface FileState {
  /** `sha256:<hex>:<size>`, `symlink:<sha256 of the target>`, `other`, or `unreadable`. */
  print: string;
  stamp: string;
}

export type Snapshot =
  | {
      ok: true;
      files: Map<string, FileState>;
      /** Folder stamps: a file added or removed in a folder changes its stamp. */
      folders: Map<string, string>;
      /** Files that could not be read, or changed while they were read. */
      unreadable: string[];
      bytes: number;
    }
  | { ok: false; reason: 'too-many-files' | 'too-large' | 'aborted' | 'unreadable-root'; detail: string };

/** Whether kernel change times show a change made and undone between two snapshots (not on Windows). */
export function changeTimesTrusted(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}

const stampOf = (st: BigIntStats): string => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const code = (error: unknown): string => String((error as { code?: unknown })?.code ?? '');

class Stop extends Error {
  constructor(readonly reason: 'too-large' | 'aborted') {
    super(reason);
  }
}

/** SHA-256 of a file's bytes in fixed-size blocks; throws `Stop` on the byte budget or an abort. */
async function hashFile(absolute: string, budget: { left: number }, signal?: AbortSignal, afterBlock?: () => void): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(absolute, { highWaterMark: BLOCK_BYTES });
  let first = true;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (first) {
        first = false;
        afterBlock?.();
      }
      if (signal?.aborted) {
        throw new Stop('aborted');
      }
      budget.left -= chunk.length;
      if (budget.left < 0) {
        throw new Stop('too-large');
      }
      hash.update(chunk);
    }
  } finally {
    stream.destroy();
  }
  return hash.digest('hex');
}

export async function snapshotProject(
  root: string,
  /** `afterFirstBlock`: test seam, called once per file after its first block is read. */
  options: { signal?: AbortSignal; maxFiles?: number; maxBytes?: number; afterFirstBlock?: (rel: string) => void } = {},
): Promise<Snapshot> {
  const maxFiles = options.maxFiles ?? MAX_SNAPSHOT_FILES;
  const maxBytes = options.maxBytes ?? MAX_SNAPSHOT_BYTES;
  const budget = { left: maxBytes };
  const files = new Map<string, FileState>();
  const folders = new Map<string, string>();
  const unreadable: string[] = [];
  const queue = [''];
  try {
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      const absoluteDir = dir === '' ? root : path.join(root, dir);
      let entries: Array<{ name: string }>;
      try {
        folders.set(dir, stampOf(await fsp.lstat(absoluteDir, { bigint: true })));
        entries = (await fsp.readdir(absoluteDir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch (error) {
        if (dir === '') {
          return { ok: false, reason: 'unreadable-root', detail: code(error) || 'the project folder cannot be read' };
        }
        if (code(error) !== 'ENOENT') {
          unreadable.push(dir);
        }
        continue;
      }
      for (const entry of entries) {
        if (options.signal?.aborted) {
          return { ok: false, reason: 'aborted', detail: 'stopped' };
        }
        const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
        const absolute = path.join(root, rel);
        let st: BigIntStats;
        try {
          st = await fsp.lstat(absolute, { bigint: true });
        } catch (error) {
          if (code(error) !== 'ENOENT') {
            unreadable.push(rel);
            files.set(rel, { print: 'unreadable', stamp: '' });
          }
          continue;
        }
        if (st.isDirectory()) {
          if (!SKIPPED_FOLDERS.has(entry.name.toLowerCase())) {
            queue.push(rel);
          }
          continue;
        }
        if (files.size >= maxFiles) {
          return { ok: false, reason: 'too-many-files', detail: `more than ${maxFiles} files` };
        }
        if (st.isSymbolicLink()) {
          let target = '';
          try {
            target = await fsp.readlink(absolute);
          } catch {
            unreadable.push(rel);
          }
          files.set(rel, { print: `symlink:${createHash('sha256').update(target).digest('hex')}`, stamp: stampOf(st) });
          continue;
        }
        if (!st.isFile()) {
          files.set(rel, { print: 'other', stamp: stampOf(st) });
          continue;
        }
        let digest: string;
        try {
          digest = await hashFile(absolute, budget, options.signal, options.afterFirstBlock ? () => options.afterFirstBlock?.(rel) : undefined);
        } catch (error) {
          if (error instanceof Stop) {
            return error.reason === 'aborted'
              ? { ok: false, reason: 'aborted', detail: 'stopped' }
              : { ok: false, reason: 'too-large', detail: `more than ${Math.round(maxBytes / 1024 / 1024)} MiB of files` };
          }
          if (code(error) !== 'ENOENT') {
            unreadable.push(rel);
            files.set(rel, { print: 'unreadable', stamp: stampOf(st) });
          }
          continue;
        }
        // The same file, unchanged while it was read? Otherwise the print may mix two contents.
        let after: BigIntStats | null = null;
        try {
          after = await fsp.lstat(absolute, { bigint: true });
        } catch {
          after = null;
        }
        if (after === null || stampOf(after) !== stampOf(st)) {
          unreadable.push(rel);
          files.set(rel, { print: 'unreadable', stamp: after === null ? '' : stampOf(after) });
          continue;
        }
        files.set(rel, { print: `sha256:${digest}:${st.size}`, stamp: stampOf(st) });
      }
    }
  } catch (error) {
    if (error instanceof Stop) {
      return { ok: false, reason: error.reason, detail: error.reason };
    }
    throw error;
  }
  return { ok: true, files, folders, unreadable: [...new Set(unreadable)].sort(), bytes: maxBytes - budget.left };
}

/** The content prints of a snapshot, as stored in a grant. */
export function printsOf(snapshot: { files: ReadonlyMap<string, FileState> }): Map<string, string> {
  return new Map([...snapshot.files].map(([file, state]) => [file, state.print]));
}

/**
 * Files written, replaced, created or removed between two snapshots, even
 * when their content is the same again: by stamp (kernel times and inode).
 * Only meaningful where `changeTimesTrusted()`.
 */
export function touchedBetween(before: { files: ReadonlyMap<string, FileState> }, after: { files: ReadonlyMap<string, FileState> }): string[] {
  const touched = new Set<string>();
  for (const [file, state] of before.files) {
    const now = after.files.get(file);
    if (now === undefined || now.stamp !== state.stamp || now.print !== state.print) {
      touched.add(file);
    }
  }
  for (const file of after.files.keys()) {
    if (!before.files.has(file)) {
      touched.add(file);
    }
  }
  return [...touched].sort();
}

/** Folders among `watched` whose stamp changed between two snapshots: a file was added, removed or renamed in them. */
export function foldersTouched(before: { folders: ReadonlyMap<string, string> }, after: { folders: ReadonlyMap<string, string> }, watched: readonly string[]): string[] {
  return watched.filter((dir) => before.folders.get(dir) !== after.folders.get(dir)).sort();
}
