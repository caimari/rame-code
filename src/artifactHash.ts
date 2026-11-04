/**
 * SHA-256 of a model file RAME reads itself: the GGUF it passes to the
 * llama-server it launches. Free of the `vscode` API.
 *
 * The file is read in 4 MiB blocks (never loaded whole), the work can be
 * cancelled, and a file that changes while it is read is refused. The result
 * is bound to the file's size and modification time: when either changes,
 * the earlier hash no longer applies and must be computed again. (A rewrite
 * that keeps both identical is not detected without hashing again; that
 * limit is stated wherever the hash is shown.)
 *
 * This proves which bytes are in that file on this computer. It does not by
 * itself prove what an external server runs, and nothing here is computed
 * from a model name.
 */

import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';

export const ARTIFACT_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ArtifactHash {
  /** File name only: evidence never keeps the directory. */
  file: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  computedAt: number;
}

export interface FileStatLike {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
}

export interface ArtifactFs {
  stat(path: string): Promise<FileStatLike>;
  open(path: string, flags: 'r'): Promise<{ read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>; close(): Promise<void> }>;
}

const nodeFs: ArtifactFs = {
  stat: (path) => fsp.stat(path),
  open: (path, flags) => fsp.open(path, flags),
};

/** A read failure, without the path (which may name the user's folders). */
export class ArtifactReadError extends Error {
  constructor(code: string) {
    super(`The model file could not be read (${code}).`);
    this.name = 'ArtifactReadError';
  }
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,24}$/.test(code) ? code : 'read error';
}

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || 'model file';
}

/**
 * Hash `path` block by block. `onProgress` gets bytes read so far. Rejects
 * with an AbortError when cancelled, an ArtifactReadError when the file
 * cannot be read or changes while it is read.
 */
export async function hashArtifact(
  path: string,
  options: { signal?: AbortSignal; onProgress?: (read: number, total: number) => void; fs?: ArtifactFs; chunkBytes?: number; now?: () => number } = {},
): Promise<ArtifactHash> {
  const fs = options.fs ?? nodeFs;
  const chunk = options.chunkBytes ?? ARTIFACT_CHUNK_BYTES;
  const abort = () => {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
  };
  abort();
  let before: FileStatLike;
  try {
    before = await fs.stat(path);
  } catch (error) {
    throw new ArtifactReadError(codeOf(error));
  }
  if (!before.isFile()) {
    throw new ArtifactReadError('not a file');
  }
  let handle: Awaited<ReturnType<ArtifactFs['open']>>;
  try {
    handle = await fs.open(path, 'r');
  } catch (error) {
    throw new ArtifactReadError(codeOf(error));
  }
  const hash = createHash('sha256');
  const buffer = new Uint8Array(chunk);
  let position = 0;
  try {
    for (;;) {
      abort();
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, chunk, position));
      } catch (error) {
        throw new ArtifactReadError(codeOf(error));
      }
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      options.onProgress?.(position, before.size);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  let after: FileStatLike;
  try {
    after = await fs.stat(path);
  } catch (error) {
    throw new ArtifactReadError(codeOf(error));
  }
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || position !== before.size) {
    throw new ArtifactReadError('the file changed while it was read');
  }
  return { file: fileNameOf(path), size: before.size, mtimeMs: before.mtimeMs, sha256: hash.digest('hex'), computedAt: (options.now ?? Date.now)() };
}

/** Whether an earlier hash still applies to the file as it is now. */
export function artifactStillMatches(hash: ArtifactHash, path: string, stat: FileStatLike | null): { ok: true } | { ok: false; reason: string } {
  if (fileNameOf(path) !== hash.file) {
    return { ok: false, reason: 'another model file is configured now' };
  }
  if (stat === null) {
    return { ok: false, reason: 'the model file can no longer be read' };
  }
  if (stat.size !== hash.size || stat.mtimeMs !== hash.mtimeMs) {
    return { ok: false, reason: 'the model file changed after it was hashed' };
  }
  return { ok: true };
}
