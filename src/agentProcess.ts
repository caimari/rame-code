/**
 * Bounded child-process execution for allowlisted test commands.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * Always `shell: false` with an executable plus argv. On POSIX the command
 * runs in its own process group so a timeout or cancellation terminates the
 * whole tree (npm -> sh -> node --test), not only the direct child; a
 * surviving grandchild would otherwise hold stdout open and the run would
 * never finish. Windows has no process groups here, so the tree is ended
 * with `taskkill /T /F` while the direct child is still alive. The result
 * settles even if a stray process keeps a pipe.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

export interface BoundedProcessSpec {
  executable: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}

export interface BoundedProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const DEFAULT_KILL_GRACE_MS = 2000;
/** How long to wait for stdio to drain after the child exits. */
const CLOSE_GRACE_MS = 500;

/**
 * The `taskkill` invocation that ends `pid` and every descendant. Absolute
 * System32 path, never a PATH lookup that could find a workspace binary.
 */
export function windowsTreeKillCommand(
  pid: number,
  systemRoot: string | undefined,
): { executable: string; argv: string[] } {
  const root = systemRoot && /^[A-Za-z]:[\\/]/.test(systemRoot) ? systemRoot : 'C:\\Windows';
  return {
    executable: path.win32.join(root, 'System32', 'taskkill.exe'),
    argv: ['/PID', String(pid), '/T', '/F'],
  };
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    // A pid that already exited may be reused by an unrelated process, and
    // taskkill cannot find the descendants of a gone parent anyway.
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const command = windowsTreeKillCommand(child.pid, process.env.SystemRoot);
    try {
      const killer = spawn(command.executable, command.argv, {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {
        try {
          child.kill(signal);
        } catch {
          // Already exited.
        }
      });
      return;
    } catch {
      // Fall back to the direct child below.
    }
  } else {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone; fall back to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

/**
 * Run one command with time/output limits. Rejects with an AbortError when
 * `signal` aborts (after the tree has been signalled); resolves with
 * `timedOut: true` when the deadline kills it.
 */
export function runBoundedProcess(spec: BoundedProcessSpec, signal?: AbortSignal): Promise<BoundedProcessResult> {
  return new Promise<BoundedProcessResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(spec.executable, spec.argv, {
        shell: false,
        cwd: spec.cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Could not start the test command.'));
      return;
    }
    const grace = spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exit: { code: number | null; signal: string | null } | null = null;
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const terminate = (): void => {
      killTree(child, 'SIGTERM');
      timers.push(setTimeout(() => killTree(child, 'SIGKILL'), grace));
    };
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      signal?.removeEventListener('abort', onAbort);
      // Leftover members of the group (daemons, watchers) never outlive the run.
      killTree(child, 'SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      resolve({ exitCode: exit?.code ?? null, signal: exit?.signal ?? null, timedOut, stdout, stderr });
    };
    const onAbort = (): void => {
      aborted = true;
      terminate();
      // Never wait on a process that ignores every signal.
      timers.push(setTimeout(finish, grace + CLOSE_GRACE_MS));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timers.push(
      setTimeout(() => {
        timedOut = true;
        terminate();
        timers.push(setTimeout(finish, grace + CLOSE_GRACE_MS));
      }, spec.timeoutMs),
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < spec.maxOutputBytes) {
        stdout = (stdout + chunk.toString('utf8')).slice(0, spec.maxOutputBytes);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < spec.maxOutputBytes) {
        stderr = (stderr + chunk.toString('utf8')).slice(0, spec.maxOutputBytes);
      }
    });
    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      signal?.removeEventListener('abort', onAbort);
      reject(aborted ? new DOMException('Aborted', 'AbortError') : error);
    });
    child.on('exit', (code: number | null, exitSignal: NodeJS.Signals | null) => {
      exit = { code, signal: exitSignal };
      // A grandchild may still hold stdout/stderr open: settle shortly anyway.
      timers.push(setTimeout(finish, CLOSE_GRACE_MS));
    });
    child.on('close', () => {
      finish();
    });
  });
}

/** Model/transcript-facing summary; a timeout is never reported as a pass. */
export function formatProcessResult(result: BoundedProcessResult, timeoutMs: number, maxStdout: number): string {
  const head = result.timedOut
    ? `exit=timeout (stopped after ${Math.round(timeoutMs / 1000)} s; the tests did not finish)\n`
    : `exit=${result.exitCode === null ? 'signal' : result.exitCode}\n`;
  return `${head}stdout:\n${result.stdout.slice(0, maxStdout)}\nstderr:\n${result.stderr.slice(0, 4000)}`;
}
