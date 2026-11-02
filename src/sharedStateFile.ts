/**
 * Project memory and Missions kept in JSON files that every VS Code window
 * of this machine shares (the extension's global storage folder), instead
 * of `globalState`, whose per-window cache can be stale.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * - Every read goes to the file, so a window always sees what another
 *   window committed.
 * - A write replaces the file atomically (temporary file + rename).
 * - A commit (read, check version, write) runs under an exclusive lock
 *   shared by all processes on this machine: two windows can never both
 *   commit against the same version.
 * - A file that cannot be parsed is reported as unreadable and is never
 *   overwritten.
 *
 * Limits: the lock is per machine. Windows of different machines (for
 * example a local and a remote window) do not share it.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
/** A lock older than this whose owner cannot be confirmed alive is broken. */
export const DEFAULT_STALE_LOCK_MS = 30000;
export const LOCK_BUSY_MESSAGE = 'Project memory is being changed in another VS Code window; try again in a moment.';

/** Marker returned for a file that exists but cannot be parsed. */
export const UNREADABLE_FILE = Object.freeze({ unreadableFile: true });

interface LockOwner {
  pid: number;
  token: string;
  at: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class SharedJsonFileBackend {
  private readonly lockDir: string;

  constructor(
    private readonly dir: string,
    private readonly options: { lockTimeoutMs?: number; staleLockMs?: number; now?: () => number } = {},
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.lockDir = path.join(dir, '.lock');
  }

  private fileFor(key: string): string {
    return path.join(this.dir, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The stored value; undefined when absent; UNREADABLE_FILE when damaged. */
  get(key: string): unknown {
    let text: string;
    try {
      text = fs.readFileSync(this.fileFor(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      return UNREADABLE_FILE;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return UNREADABLE_FILE;
    }
  }

  /** Replace the stored value atomically. */
  async update(key: string, value: unknown): Promise<void> {
    const target = this.fileFor(key);
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  private readOwner(dir: string): LockOwner | null {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')) as LockOwner;
      return typeof owner.pid === 'number' && typeof owner.token === 'string' && typeof owner.at === 'number' ? owner : null;
    } catch {
      return null;
    }
  }

  private tryAcquire(token: string): boolean {
    try {
      fs.mkdirSync(this.lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
    fs.writeFileSync(path.join(this.lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token, at: this.now() }));
    return true;
  }

  /**
   * Break a lock whose owner is gone (dead process) or that is older than
   * the stale limit. The lock is first moved aside and its owner checked
   * again, so a lock taken meanwhile by a live window is put back.
   */
  private breakIfStale(): void {
    const owner = this.readOwner(this.lockDir);
    const staleMs = this.options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    const dead = owner !== null && owner.pid !== process.pid && !isProcessAlive(owner.pid);
    const old = owner === null ? this.lockAgeMs() > staleMs : this.now() - owner.at > staleMs;
    if (!dead && !old) {
      return;
    }
    const aside = `${this.lockDir}.stale.${randomBytes(6).toString('hex')}`;
    try {
      fs.renameSync(this.lockDir, aside);
    } catch {
      return;
    }
    const moved = this.readOwner(aside);
    if (owner !== null && moved !== null && moved.token !== owner.token) {
      // Another window took the lock between the check and the move.
      try {
        fs.renameSync(aside, this.lockDir);
        return;
      } catch {
        // A third window holds it now; the moved lock is simply dropped.
      }
    }
    fs.rmSync(aside, { recursive: true, force: true });
  }

  private lockAgeMs(): number {
    try {
      return this.now() - fs.statSync(this.lockDir).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Run `work` while holding the machine-wide lock of this folder. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const token = randomBytes(12).toString('hex');
    const deadline = this.now() + (this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    while (!this.tryAcquire(token)) {
      this.breakIfStale();
      if (this.now() > deadline) {
        throw new Error(LOCK_BUSY_MESSAGE);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    try {
      return await work();
    } finally {
      const owner = this.readOwner(this.lockDir);
      if (owner !== null && owner.token === token) {
        fs.rmSync(this.lockDir, { recursive: true, force: true });
      }
    }
  }
}
