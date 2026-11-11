/**
 * The agent's read-only copy of the original (I-16).
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * When a Mission with a differential reference is authorized, the host makes
 * two copies of the original files: its own frozen reference (see
 * `referenceCheck.ts`, the only one the checks ever run) and, in a different
 * folder, this copy the agent may read through `read_original`. They share
 * no folder, so nothing done to one changes the other.
 *
 * The visible copy holds only the original source files the reference names:
 * never the reference description (its generators and edge values), the
 * host's records, seeds or reserved inputs, which live with the host's copy.
 * Its files are read-only on disk (its folders are not, so the copy can
 * always be removed), their hashes are kept in the grant, and every read
 * checks the hash first and follows no link: a copy that changed is not
 * shown. Only the listed files can be read, by their project path; the
 * folder's location is never shown to the agent.
 *
 * What this does not do: it is not a sandbox. The code under test runs with
 * the user's permissions and could read or change files outside the
 * project; read-only modes stop accidents and RAME's own tools, not a
 * determined process. The host's checks never read this copy, so changing it
 * can only make `read_original` refuse.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface VisibleOriginal {
  dir: string;
  files: Array<{ path: string; hash: string }>;
}

const MAX_SHOWN_CHARS = 60_000;
/** Every refusal of read_original starts with one of these; none has a side effect. */
export const ORIGINAL_REFUSALS = ['Only the original files can be read with read_original', "RAME's read-only copy of ", 'This Mission has no read-only copy of the original.'] as const;
const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const projectPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !/^[a-z]:/i.test(value);

/** Remove a visible copy (its files are read-only; its folders are not, so it can always be removed). */
export async function removeReadOnlyTree(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Copy `files` (project paths, already hashed by the caller) into `dir`, read-only. */
export async function makeVisibleCopy(root: string, files: ReadonlyArray<{ path: string; hash: string }>, dir: string): Promise<{ ok: true; visible: VisibleOriginal } | { ok: false; error: string }> {
  const made: Array<{ path: string; hash: string }> = [];
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const bytes = await readFile(path.join(root, ...file.path.split('/')));
      if (sha256(bytes) !== file.hash) {
        throw new Error(`${file.path} changed while it was being frozen`);
      }
      const target = path.join(dir, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o444, flag: 'wx' });
      made.push({ path: file.path, hash: file.hash });
    }
    return { ok: true, visible: { dir, files: made } };
  } catch (error) {
    await removeReadOnlyTree(dir);
    return { ok: false, error: `RAME could not make the read-only copy of the original: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function parseVisibleOriginal(raw: unknown): VisibleOriginal | undefined | null {
  if (raw === undefined) {
    return undefined;
  }
  if (
    !isRecord(raw) ||
    typeof raw.dir !== 'string' ||
    !path.isAbsolute(raw.dir) ||
    raw.dir.length > 1024 ||
    !Array.isArray(raw.files) ||
    raw.files.length === 0 ||
    raw.files.length > 16 ||
    !raw.files.every((file) => isRecord(file) && projectPath(file.path) && typeof file.hash === 'string' && /^[0-9a-f]{64}$/.test(file.hash))
  ) {
    return null;
  }
  return { dir: raw.dir, files: (raw.files as Array<{ path: string; hash: string }>).map((file) => ({ path: file.path, hash: file.hash })) };
}

/** The project path the agent asked for, in the form the copy lists it. */
function normalize(requested: string): string {
  return requested.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^original\//, '');
}

/**
 * Read one file of the visible copies (or list them when `requested` is
 * empty). Never reads anything that is not a listed file, follows no link,
 * and shows nothing whose hash changed.
 */
export async function readVisibleOriginal(copies: readonly VisibleOriginal[], requested: string): Promise<string> {
  const listed = new Map<string, { copy: VisibleOriginal; hash: string }>();
  for (const copy of copies) {
    for (const file of copy.files) {
      if (!listed.has(file.path)) {
        listed.set(file.path, { copy, hash: file.hash });
      }
    }
  }
  if (listed.size === 0) {
    throw new Error('This Mission has no read-only copy of the original.');
  }
  const names = [...listed.keys()];
  if (requested.trim().length === 0) {
    return [
      'READ-ONLY COPY OF THE ORIGINAL, as it was when the Mission was authorized (not the files you edit; the host checks never read this copy):',
      ...names.map((name) => `- ${name}`),
      'Read one with read_original and its path.',
    ].join('\n');
  }
  const name = normalize(requested);
  const entry = listed.get(name);
  if (entry === undefined) {
    throw new Error(`Only the original files can be read with read_original: ${names.join(', ')}.`);
  }
  const target = path.join(entry.copy.dir, ...name.split('/'));
  let bytes: Buffer;
  try {
    const [base, real] = await Promise.all([realpath(entry.copy.dir), realpath(target)]);
    if (!real.startsWith(base + path.sep)) {
      throw new Error('outside');
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await handle.stat()).isFile()) {
        throw new Error('not a file');
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(`RAME's read-only copy of ${name} is missing or is no longer a plain file, so it is not shown. The host's own check does not use this copy.`);
  }
  if (sha256(bytes) !== entry.hash) {
    throw new Error(`RAME's read-only copy of ${name} changed after the Mission was authorized, so it is not shown. The host's own check does not use this copy.`);
  }
  const text = bytes.toString('utf8');
  const shown = text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS)}\n… (cut at ${MAX_SHOWN_CHARS} characters)` : text;
  return `original: ${name} (read-only, sha256 ${entry.hash.slice(0, 12)}…, as it was when the Mission was authorized)\n${shown}`;
}
