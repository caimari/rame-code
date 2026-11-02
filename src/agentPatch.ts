/**
 * Patch integrity for Agent `apply_patch`.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * Uses a structured patch representation (path + expected hash + full new
 * content) rather than an ambiguous diff string: every target's current
 * bytes are snapshotted/hashed and the preconditions must still match.
 * Application is two-phase (validate everything, then write); on
 * interruption or failure the originals are restored and success is never
 * reported.
 */

import { createHash } from 'node:crypto';

import { checkAgentRelPath, MAX_PATCH_BYTES, MAX_PATCH_FILES } from './agentPolicy.js';
import type { PatchFileInput } from './agentTools.js';

/** SHA-256 hex of UTF-8 text. Host and tests share this digest. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface PatchTargetSnapshot {
  rel: string;
  exists: boolean;
  currentHash: string;
  currentBytes: string;
}

export interface PatchHost {
  /**
   * Read one target. Must not follow symlinks: report `isSymlink` instead.
   * `kind` distinguishes files from directories/special files.
   */
  inspect(
    rel: string,
  ): { kind: 'file' | 'dir' | 'symlink' | 'missing' | 'other'; bytes: string };
  /** Write full UTF-8 content; may throw on interruption/failure. */
  write(rel: string, content: string): void;
  /**
   * Bounded rollback-only delete for a file created by the exact pending
   * patch. The applier calls it only for `rel`s in the current plan whose
   * snapshot was `missing` and that were written before the failure.
   * Implementations must not expose this as a general delete tool.
   */
  remove?(rel: string): void;
}

export interface AppliedFileMeta {
  path: string;
  oldHash: string;
  newHash: string;
  bytes: number;
}

export type PatchApplyResult =
  | { ok: true; files: AppliedFileMeta[] }
  | { ok: false; error: string; restored: boolean };

function checkOpsShape(files: PatchFileInput[]): string | null {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_PATCH_FILES) {
    return 'The patch is invalid.';
  }
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (
      typeof file.path !== 'string' ||
      typeof file.expectedHash !== 'string' ||
      typeof file.newContent !== 'string'
    ) {
      return 'The patch is invalid.';
    }
    if (!/^[0-9a-f]{64}$/.test(file.expectedHash)) {
      return 'The patch is invalid.';
    }
    if (file.newContent.length > MAX_PATCH_BYTES) {
      return 'The patch is too large.';
    }
    total += file.newContent.length;
    if (total > MAX_PATCH_BYTES) {
      return 'The patch is too large.';
    }
    const gate = checkAgentRelPath(file.path);
    if (!gate.ok) {
      return gate.error;
    }
    const rel = (gate as { ok: true; rel: string }).rel;
    if (rel === '') {
      return 'The patch cannot target the workspace root.';
    }
    if (seen.has(rel)) {
      return 'The patch targets a file twice.';
    }
    seen.add(rel);
    // Encoding gate: lone surrogates would corrupt UTF-8 writes.
    try {
      // eslint-disable-next-line no-unused-expressions
      new TextEncoder().encode(file.newContent);
    } catch {
      return 'The patch is invalid.';
    }
  }
  return null;
}

/**
 * Validate every operation first, snapshot originals, then write. On write
 * failure, interruption, or post-write verification failure every original
 * file is restored and every newly-created file from this exact plan is
 * removed via the bounded `host.remove`. `restored: true` is returned only
 * when re-inspection confirms that original state; otherwise
 * `restored: false`. Changed-file/digest metadata is produced only after
 * the host writes verify (re-hash of the written content).
 */
interface PlannedPatchItem {
  rel: string;
  expectedHash: string;
  newContent: string;
  originalBytes: string | null;
  originalKind: string;
}

/**
 * Roll back exactly the planned items listed in `written`: restore original
 * bytes for pre-existing files and remove newly-created files through the
 * bounded `host.remove`. Returns true only when re-inspection confirms the
 * original state (originals match, new files are missing).
 */
function rollbackPlanned(host: PatchHost, planned: PlannedPatchItem[], written: string[]): boolean {
  try {
    for (const item of planned) {
      if (!written.includes(item.rel)) {
        continue;
      }
      if (item.originalBytes === null) {
        if (!host.remove) {
          return false;
        }
        host.remove(item.rel);
      } else {
        host.write(item.rel, item.originalBytes);
      }
    }
  } catch {
    return false;
  }
  try {
    for (const item of planned) {
      if (!written.includes(item.rel)) {
        continue;
      }
      const after = host.inspect(item.rel);
      if (item.originalBytes === null) {
        if (after.kind !== 'missing') {
          return false;
        }
      } else {
        if (after.kind !== 'file' || hashContent(after.bytes) !== hashContent(item.originalBytes)) {
          return false;
        }
      }
    }
  } catch {
    return false;
  }
  return true;
}

export function applyPatchAtomically(
  files: PatchFileInput[],
  host: PatchHost,
): PatchApplyResult {
  const shapeError = checkOpsShape(files);
  if (shapeError) {
    return { ok: false, error: shapeError, restored: true };
  }
  // Phase 1: resolve + policy + precondition check for every target.
  const planned: Array<{
    rel: string;
    expectedHash: string;
    newContent: string;
    originalBytes: string | null;
    originalKind: string;
  }> = [];
  for (const file of files) {
    const gate = checkAgentRelPath(file.path);
    if (!gate.ok) {
      return { ok: false, error: gate.error, restored: true };
    }
    const rel = (gate as { ok: true; rel: string }).rel;
    let inspected: { kind: string; bytes: string };
    try {
      inspected = host.inspect(rel);
    } catch {
      return { ok: false, error: 'The workspace changed; re-read before patching.', restored: true };
    }
    if (inspected.kind === 'symlink') {
      return { ok: false, error: 'The patch cannot follow symlinks.', restored: true };
    }
    if (inspected.kind === 'dir' || inspected.kind === 'other') {
      return { ok: false, error: 'The patch cannot target directories or special files.', restored: true };
    }
    const currentBytes = inspected.kind === 'file' ? inspected.bytes : '';
    const currentHash = hashContent(currentBytes);
    if (currentHash !== file.expectedHash) {
      return { ok: false, error: 'A target changed since it was read; re-read before patching.', restored: true };
    }
    planned.push({
      rel,
      expectedHash: file.expectedHash,
      newContent: file.newContent,
      originalBytes: inspected.kind === 'file' ? inspected.bytes : null,
      originalKind: inspected.kind,
    });
  }
  // Phase 2: write all targets; roll back on any failure.
  const written: string[] = [];
  try {
    for (const item of planned) {
      host.write(item.rel, item.newContent);
      written.push(item.rel);
    }
  } catch {
    const restored = rollbackPlanned(host, planned, written);
    return {
      ok: false,
      error: restored
        ? 'The patch was interrupted; originals were restored.'
        : 'The patch was interrupted; restore could not be verified.',
      restored,
    };
  }
  // Phase 3: host verification (re-hash written content).
  const metas: AppliedFileMeta[] = [];
  try {
    for (const item of planned) {
      const after = host.inspect(item.rel);
      if (after.kind !== 'file') {
        throw new Error('verification failed');
      }
      const newHash = hashContent(after.bytes);
      const wantHash = hashContent(item.newContent);
      if (newHash !== wantHash) {
        throw new Error('verification failed');
      }
      metas.push({
        path: item.rel,
        oldHash: item.expectedHash,
        newHash,
        bytes: after.bytes.length,
      });
    }
  } catch {
    const restored = rollbackPlanned(host, planned, planned.map((item) => item.rel));
    return {
      ok: false,
      error: restored
        ? 'Patch verification failed; originals were restored.'
        : 'Patch verification failed.',
      restored,
    };
  }
  return { ok: true, files: metas };
}
