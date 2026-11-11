/**
 * Where each workspace's Autonomy & Permissions live: the same store as
 * Missions (a file every VS Code window of this machine reads afresh, or
 * `globalState` in tests), under one key, by execution environment and
 * workspace scope. Every read goes to the store, so a revocation in one
 * window holds in the others at their next check. Changes are queued in
 * this window and, when the backend offers it, run in its machine-wide
 * exclusive section.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Bound to the environment: the policy of a workspace is kept per
 * environment (`autonomyEnv.ts`), so one given on this computer is never
 * read on a Remote SSH server or another machine that shares the folder.
 *
 * Sealed: each policy is stored with an HMAC-SHA256 over its slot and
 * content, with a random key kept outside this file (VS Code's
 * SecretStorage in the extension). A policy changed by anything else, such
 * as a command writing to this file, does not verify and reads as Ask
 * always with nothing pre-authorized. Without the key nothing is in force.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { AUTONOMY_STATE_KEY, MAX_LOG_ENTRIES, parseWorkspaceAutonomy, type WorkspaceAutonomy } from './autonomyPolicy.js';
import { liveExecEnv, type ExecEnv } from './autonomyEnv.js';

export interface AutonomyBackend {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
}

/** Where this host runs and the key that seals its policies (null while it loads). */
export interface AutonomyRuntime {
  env(): ExecEnv;
  key(): Buffer | null;
  /** RAME Code's own state folders on this machine: a command that names one keeps its card under Full Access. */
  statePaths?: readonly string[];
  /** Resolves once the key has been loaded (or could not be). */
  ready?: () => Promise<void>;
}

const MAX_WORKSPACES = 64;
const PROCESS_KEY = randomBytes(32);

/** For a host without SecretStorage (tests): this machine, and a key that lives as long as the process. */
export const processRuntime = (): AutonomyRuntime => ({ env: liveExecEnv(undefined, undefined), key: () => PROCESS_KEY });

export class AutonomyStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: AutonomyBackend,
    readonly runtime: AutonomyRuntime = processRuntime(),
  ) {}

  env(): ExecEnv {
    return this.runtime.env();
  }

  private slot(scopeId: string): string {
    return `${this.env().id}/${scopeId}`;
  }

  private all(): Record<string, unknown> {
    const raw = this.backend.get(AUTONOMY_STATE_KEY) as { version?: unknown; workspaces?: unknown } | undefined;
    const workspaces = raw && typeof raw === 'object' && raw.version === 2 ? raw.workspaces : undefined;
    return workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces) ? { ...(workspaces as Record<string, unknown>) } : {};
  }

  private mac(slot: string, policy: unknown): string | null {
    const key = this.runtime.key();
    return key === null ? null : createHmac('sha256', key).update(`rame-autonomy:v2\n${slot}\n${JSON.stringify(policy)}`, 'utf8').digest('hex');
  }

  /** The stored content of a slot when its seal verifies; otherwise undefined (read as nothing pre-authorized). */
  private open(slot: string, record: unknown): unknown {
    if (typeof record !== 'object' || record === null || typeof (record as { mac?: unknown }).mac !== 'string') {
      return undefined;
    }
    const { policy, mac } = record as { policy: unknown; mac: string };
    const expected = this.mac(slot, policy);
    if (expected === null || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return undefined;
    }
    return policy;
  }

  /** The policy of one workspace in this environment, read now from the store. */
  get(scopeId: string): WorkspaceAutonomy {
    const slot = this.slot(scopeId);
    return parseWorkspaceAutonomy(this.open(slot, this.all()[slot]), scopeId, this.env().id);
  }

  /** A sealed record for one slot (the store's own writes, and test fixtures). */
  seal(scopeId: string, policy: WorkspaceAutonomy): { slot: string; record: { policy: WorkspaceAutonomy; mac: string } } {
    const slot = this.slot(scopeId);
    const plain = JSON.parse(JSON.stringify(policy)) as WorkspaceAutonomy;
    const mac = this.mac(slot, plain);
    if (mac === null) {
      throw new Error('Autonomy & Permissions are not ready yet: their key is still loading. Nothing was changed.');
    }
    return { slot, record: { policy: plain, mac } };
  }

  /** Read, change and write one workspace's policy; the change sees the latest stored value. */
  change<T>(scopeId: string, work: (policy: WorkspaceAutonomy) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const workspaces = this.all();
      const slot = this.slot(scopeId);
      const policy = parseWorkspaceAutonomy(this.open(slot, workspaces[slot]), scopeId, this.env().id);
      const result = work(policy);
      policy.log = policy.log.slice(-MAX_LOG_ENTRIES);
      workspaces[slot] = this.seal(scopeId, policy).record;
      const keys = Object.keys(workspaces);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_WORKSPACES))) {
        if (key !== slot) {
          delete workspaces[key];
        }
      }
      await this.backend.update(AUTONOMY_STATE_KEY, { version: 2, workspaces });
      return result;
    };
    const exclusive = this.backend.exclusive?.bind(this.backend);
    const next = this.queue.then(async () => {
      await this.runtime.ready?.();
      return exclusive ? exclusive(run) : run();
    });
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}
