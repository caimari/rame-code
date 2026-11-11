/**
 * The process side of long jobs (see `jobRecord.ts`): start the detached
 * supervisor, observe a job directory, ask a job to stop, and read the end of
 * its log. Free of the `vscode` API.
 */

import { spawn } from 'node:child_process';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { canonicalJobSpec, type JobProbe, type JobSpec, jobSpecDigest, parseJobExit } from './jobRecord.js';

export const JOB_SUPERVISOR = path.join(__dirname, '..', '..', 'runtime', 'rame-job-supervisor.cjs');

export interface SupervisorOptions {
  /** Node (or Electron run as Node) that runs the supervisor; default `process.execPath`. */
  nodePath?: string;
  supervisor?: string;
}

/**
 * Write the approved spec and start its supervisor, detached and unreferenced
 * so it outlives this process. Resolves once the supervisor process exists.
 */
export async function launchJob(dir: string, spec: JobSpec, options: SupervisorOptions = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'spec.json'), canonicalJobSpec(spec), { flag: 'wx' });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.nodePath ?? process.execPath, [options.supervisor ?? JOB_SUPERVISOR, dir, jobSpecDigest(spec)], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

/** Signal 0: does the pid exist? A reused pid also answers, so this is a hint. */
export function pidAnswers(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function probeJob(dir: string, now: number = Date.now()): Promise<JobProbe> {
  const exit = parseJobExit(await readJson(path.join(dir, 'exit.json')));
  const rawStarted = await readJson(path.join(dir, 'supervisor.json'));
  const started =
    typeof rawStarted === 'object' && rawStarted !== null && Number.isInteger((rawStarted as { pid?: unknown }).pid)
      ? {
          pid: (rawStarted as { pid: number }).pid,
          childPid: Number.isInteger((rawStarted as { childPid?: unknown }).childPid) ? (rawStarted as { childPid: number }).childPid : null,
          startedAt: Number((rawStarted as { startedAt?: unknown }).startedAt) || now,
        }
      : null;
  const heartbeatAt = await readHeartbeat(path.join(dir, 'heartbeat'));
  return { now, exit, started, heartbeatAt, childAlive: started?.childPid != null && exit === null ? pidAnswers(started.childPid) : null };
}

/** How often, and how far apart, a heartbeat found empty or unreadable as a number is read again. */
const HEARTBEAT_REREADS = 3;
const HEARTBEAT_REREAD_MS = 20;

/**
 * The supervisor's last sign of life, or null. A file that exists but holds
 * no valid time was caught mid-write (a supervisor that rewrites it in place:
 * an older one, or one where a rename failed): it is read again a few times
 * before it counts as no sign of life, because one torn read would otherwise
 * mark a healthy job uncertain for good. A missing file is answered at once.
 */
async function readHeartbeat(file: string): Promise<number | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = Number((await readFile(file, 'utf8')).trim());
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    } catch {
      return null;
    }
    if (attempt >= HEARTBEAT_REREADS) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_REREAD_MS));
  }
}

/** Ask the supervisor to stop the job (it checks at each heartbeat). */
export async function requestJobStop(dir: string): Promise<void> {
  await writeFile(path.join(dir, 'cancel'), String(Date.now()));
}

/** The last `maxBytes` of the job's output (across the rotated pair). */
export async function readJobLogTail(dir: string, maxBytes: number): Promise<string> {
  let cut = false;
  const tailOf = async (name: string, budget: number): Promise<Buffer> => {
    if (budget <= 0) {
      return Buffer.alloc(0);
    }
    let handle;
    try {
      const file = path.join(dir, name);
      const size = (await stat(file)).size;
      const length = Math.min(size, budget);
      cut ||= length < size;
      handle = await open(file, 'r');
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer;
    } catch {
      return Buffer.alloc(0);
    } finally {
      await handle?.close();
    }
  };
  const latest = await tailOf('log.txt', maxBytes);
  const earlier = await tailOf('log.1.txt', maxBytes - latest.length);
  if (latest.length >= maxBytes && (await stat(path.join(dir, 'log.1.txt')).then(() => true, () => false))) {
    cut = true;
  }
  const text = Buffer.concat([earlier, latest]).toString('utf8');
  // A cut tail starts at the next whole line.
  const start = cut ? text.indexOf('\n') + 1 : 0;
  return start > 0 && start < text.length ? text.slice(start) : text.replace(/^\uFFFD+/, '');
}
