/**
 * Isolation of the Agent's terminal commands (`run_command`).
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Three levels, chosen in Settings → Security → Terminal commands and
 * independent of the autonomy mode (Ask, Supervised or Full Access only
 * decide whether a command asks first; the level decides what the system
 * lets it do):
 *   - `total`: no isolation. The command runs with the user's permissions.
 *   - `project` (default): writes only in the project folder, the temporary
 *     folder and the package caches (npm, pip and similar); it may read the
 *     disk and use the network, so installs into the project still work.
 *   - `closed`: like `project`, and no TCP connections at all.
 * On Linux this is Landlock with no_new_privs (runtime/rame-isolate.py), so
 * sudo and setuid programs cannot gain rights either. Where it cannot be
 * applied (no Landlock, no python3, Windows, macOS), a `project` or
 * `closed` command is not run: it never runs unprotected in silence.
 *
 * Limits, said wherever the level is shown: files the user can read stay
 * readable (as in Codex's sandbox), UDP (so DNS) is not blocked, and
 * processes that already run (a dev server, Docker, the SSH agent) keep
 * their own rights.
 */

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CommandIsolation } from './settingsStore.js';

export const ISOLATION_LAUNCHER = path.join(__dirname, '..', '..', 'runtime', 'rame-isolate.py');

/** Package caches a `project` command may write to (skipped when absent). */
export const CACHE_FOLDERS = ['.npm', '.cache', '.yarn', '.bun', '.local/share/pnpm', '.cargo/registry', '.cargo/git'];

export const ISOLATION_WORDS: Record<CommandIsolation, string> = {
  total: 'no isolation: the command runs with your permissions',
  project: 'isolated: writes only in the project, temporary and package-cache folders; network allowed',
  closed: 'isolated and closed: writes only in the project, temporary and package-cache folders; no network',
};

export type IsolationSupport = { ok: true; abi: number; seccomp?: boolean } | { ok: false; reason: string };
export type VerificationMode = { kind: 'protected'; reason: '' } | { kind: 'unprotected'; reason: string };

export const UNPROTECTED_VERIFICATION_WARNING = 'This environment has no protected isolation: the acceptance check will run without isolation. Code under test could read hidden cases and alter its results.';

export interface IsolationProbe {
  platform: NodeJS.Platform;
  /** Runs the launcher's probe; resolves its standard output, or rejects. */
  run: (python: string, launcher: string) => Promise<string>;
}

export interface ProtectedInvocationAccess {
  /** Exact regular files the verifier may read. */
  readFiles: readonly string[];
  /** Trees with no protected material (runtime code, dependencies, private scratch). */
  readTrees?: readonly string[];
  /** Directory names may be listed/traversed, but their files are not thereby readable. */
  readDirs?: readonly string[];
  /** Trees the verifier may modify; this does not grant read access in protected mode. */
  writeTrees?: readonly string[];
}

const defaultProbe: IsolationProbe = {
  platform: process.platform,
  run: (python, launcher) =>
    new Promise((resolve, reject) => {
      execFile(python, ['-I', launcher, '--probe'], { timeout: 5000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
    }),
};

let cached: Promise<IsolationSupport> | null = null;
let settled: IsolationSupport | null = null;
let hostProbe: IsolationProbe = defaultProbe;

/** Replace this host's check (tests, or a diagnostic run); null restores the real one. The next check runs again. */
export function setIsolationProbe(probe: IsolationProbe | null): void {
  hostProbe = probe ?? defaultProbe;
  cached = null;
  settled = null;
}

/** The result of this host's check, once it finished (null before). */
export function settledIsolationSupport(): IsolationSupport | null {
  return settled;
}

/** Whether this system can isolate commands (checked once per extension host). */
export function isolationSupport(probe?: IsolationProbe): Promise<IsolationSupport> {
  if (probe !== undefined) {
    return checkSupport(probe);
  }
  if (cached !== null) {
    return cached;
  }
  const result = checkSupport(hostProbe);
  cached = result;
  void result.then((support) => {
    if (cached === result) {
      settled = support;
    }
  });
  return result;
}

async function checkSupport(probe: IsolationProbe): Promise<IsolationSupport> {
  if (probe.platform !== 'linux') {
    return { ok: false, reason: `RAME isolates commands only on Linux for now (this is ${probe.platform === 'win32' ? 'Windows' : probe.platform === 'darwin' ? 'macOS' : probe.platform})` };
  }
  let out: string;
  try {
    out = await probe.run('python3', ISOLATION_LAUNCHER);
  } catch {
    return { ok: false, reason: 'python3, which RAME uses to apply the isolation, could not be run on this system' };
  }
  const abi = Number(/landlock-abi=(\d+)/.exec(out)?.[1] ?? 0);
  const seccomp = !/\bseccomp=0\b/.test(out);
  return abi >= 1 ? { ok: true, abi, seccomp } : { ok: false, reason: 'this Linux kernel has no Landlock (5.13 or newer, enabled)' };
}

/** Why `level` cannot be applied with this support (null when it can, or when no isolation was asked). */
export function isolationRefusal(level: CommandIsolation, support: IsolationSupport): string | null {
  if (level === 'total') {
    return null;
  }
  if (!support.ok) {
    return support.reason;
  }
  if (level === 'closed' && support.abi < 4) {
    return `this kernel's Landlock (version ${support.abi}) cannot block the network; it needs Linux 6.7 or newer`;
  }
  return null;
}

/** Protected verification always needs read confinement and no TCP, independently of the user's terminal level. */
export function protectedVerificationRefusal(support: IsolationSupport): string | null {
  if (!support.ok) {
    return support.reason;
  }
  if (support.abi < 4) {
    return `this kernel's Landlock (version ${support.abi}) cannot close TCP; protected verification needs version 4 or newer`;
  }
  return support.seccomp === false ? 'libseccomp.so.2 is unavailable, so protected verification cannot deny every socket family and cross-process inspection' : null;
}

/** Protected when every defense is available; otherwise explicit unprotected verification, never a silent fallback. */
export function verificationMode(support: IsolationSupport): VerificationMode {
  const reason = protectedVerificationRefusal(support);
  return reason === null ? { kind: 'protected', reason: '' } : { kind: 'unprotected', reason };
}

export async function currentVerificationMode(): Promise<VerificationMode> {
  return verificationMode(await isolationSupport());
}

export function verificationLabel(mode: VerificationMode): string {
  return mode.kind === 'protected' ? 'verification: protected' : `verification: unprotected — ${mode.reason}`;
}

/** The folders a `project` or `closed` command may write to: the project first. */
export function writableFolders(root: string, home: string = os.homedir(), tmp: string = os.tmpdir(), extra: readonly string[] = []): string[] {
  return [...new Set([root, tmp, '/dev/shm', ...CACHE_FOLDERS.map((folder) => path.join(home, folder)), ...extra.map((folder) => path.resolve(folder))])];
}

/** The program and arguments that run `executable argv` at `level` (unchanged for `total`). */
export function isolatedInvocation(level: CommandIsolation, executable: string, argv: string[], root: string, home?: string, tmp?: string, extraWrites: readonly string[] = []): { executable: string; argv: string[] } {
  if (level === 'total') {
    return { executable, argv };
  }
  const writes = writableFolders(root, home, tmp, extraWrites).flatMap((folder) => ['--write', folder]);
  return { executable: 'python3', argv: ['-I', ISOLATION_LAUNCHER, ...(level === 'closed' ? ['--no-net'] : []), ...writes, '--', executable, ...argv] };
}

/**
 * A verifier process with no ambient filesystem reads. Unlike terminal
 * isolation, this is mandatory and does not become weaker when the user
 * chooses Total or Full Access.
 */
export function protectedVerifierInvocation(executable: string, argv: string[], access: ProtectedInvocationAccess): { executable: string; argv: string[] } {
  const unique = (items: readonly string[] = []): string[] => [...new Set(items.map((item) => path.resolve(item)))];
  const flags = [
    '--protect-reads',
    '--no-net',
    ...unique(access.readDirs).flatMap((item) => ['--read-dir', item]),
    ...unique(access.readTrees).flatMap((item) => ['--read-tree', item]),
    // A bare command is resolved through the retained PATH inside the
    // already-allowed system runtime trees. Treating "node" or "python3" as
    // a path relative to the extension cwd would both be wrong and fail
    // closed for the wrong reason.
    ...unique([...(path.isAbsolute(executable) ? [executable] : []), ...access.readFiles]).flatMap((item) => ['--read-file', item]),
    ...unique(access.writeTrees).flatMap((item) => ['--write', item]),
  ];
  return { executable: 'python3', argv: ['-I', ISOLATION_LAUNCHER, ...flags, '--', executable, ...argv] };
}

/** What the model and the user are told when a command is not run because it cannot be isolated. */
export function notIsolatedText(level: CommandIsolation, reason: string): string {
  return `Not run: terminal commands are set to "${level === 'closed' ? 'Closed' : 'Project'}" isolation, and ${reason}. RAME does not run a command without the protection chosen. The user can choose "Total" (no isolation) in Settings → Security → Terminal commands.`;
}

/** Fail-closed wording shared by tests, jobs and installs. */
export function isolationUnavailableText(kind: string, level: CommandIsolation, reason: string): string {
  return `Not run: ${kind} are set to "${level === 'closed' ? 'Closed' : 'Project'}" isolation, and ${reason}. RAME does not run them without the protection chosen. The user can choose "Total" (no isolation) in Settings → Security.`;
}
