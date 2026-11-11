/**
 * The host's record of long jobs (see `jobRecord.ts`), kept in the same kind
 * of storage as Missions so it survives a reload.
 *
 * Rules:
 * - a job is recorded as `starting` before its supervisor is launched, so a
 *   reload at any moment leaves a record, never an unknown process;
 * - an approval binds one exact job (scope, command, Mission, spec);
 * - the host never starts a job twice: while a job with the same command and
 *   Mission is live or uncertain, a new one is refused;
 * - after a reload a live job is attached (it is still running), closed (its
 *   supervisor recorded a result), or marked `uncertain`;
 * - only the user stops a job or settles an uncertain one.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  isFinalJob,
  jobApprovalDigest,
  type JobRecord,
  jobSpecDigest,
  MAX_RUNNING_JOBS_PER_SCOPE,
  MAX_STORED_JOBS,
  parseJobRecord,
  reconcileJob,
  type JobSpec,
  validateJobSpec,
} from './jobRecord.js';
import { launchJob, probeJob, readJobLogTail, requestJobStop, type SupervisorOptions } from './jobRunner.js';

export const JOB_STATE_KEY = 'rame.jobs.v1';

/** Job folders live next to the shared state (outside every project), or in the temp folder. */
export function defaultJobsRoot(sharedStateDir: string | undefined): string {
  // Without a state folder (tests), one folder per user: its siblings (programmes, references) never land in the shared temp folder itself.
  return sharedStateDir ? path.join(sharedStateDir, '..', 'jobs') : path.join(os.tmpdir(), `rame-code-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`, 'jobs');
}

/** Run a job's cleanup (e.g. `docker rm -f <its unique name>`); resolves with its exit code. */
function runCleanup(cleanup: { executable: string; argv: string[] }): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cleanup.executable, cleanup.argv, { shell: false, stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(() => (child.kill('SIGKILL'), resolve(null)), 20_000);
      child.once('error', () => (clearTimeout(timer), resolve(null)));
      child.once('exit', (code) => (clearTimeout(timer), resolve(code)));
    } catch {
      resolve(null);
    }
  });
}

export interface JobBackend {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
}

export type JobResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface JobStoreOptions extends SupervisorOptions {
  now?: () => number;
  launch?: typeof launchJob;
  probe?: typeof probeJob;
}

export interface NewJob {
  scopeId: string;
  label: string;
  missionId: string | null;
  spec: JobSpec;
}

const isLive = (job: JobRecord): boolean => job.status === 'starting' || job.status === 'running';

export class JobStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: JobBackend,
    private readonly jobsRoot: string,
    private readonly options: JobStoreOptions = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The folder that holds every job's folder (outside every project). */
  get root(): string {
    return this.jobsRoot;
  }

  list(): JobRecord[] {
    const raw = this.backend.get(JOB_STATE_KEY) as { jobs?: unknown } | undefined;
    const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
    return jobs.map((entry) => parseJobRecord(entry, this.jobsRoot)).filter((job): job is JobRecord => job !== null);
  }

  get(id: string): JobRecord | null {
    return this.list().find((job) => job.id === id) ?? null;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = () => this.backend.exclusive ? this.backend.exclusive(work) : work();
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async save(jobs: JobRecord[]): Promise<void> {
    await this.backend.update(JOB_STATE_KEY, { version: 1, jobs });
  }

  private change(id: string, mutate: (job: JobRecord) => JobResult<JobRecord>): Promise<JobResult<JobRecord>> {
    return this.serial(async () => {
      const jobs = this.list();
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0) {
        return { ok: false, error: 'RAME Code has no record of this job.' };
      }
      const draft = structuredClone(jobs[index] as JobRecord);
      const result = mutate(draft);
      if (!result.ok) {
        return result;
      }
      result.value.revision += 1;
      result.value.updatedAt = this.now();
      jobs[index] = result.value;
      await this.save(jobs);
      return result;
    });
  }

  /** Start one approved job. The record is written before anything runs. */
  start(input: NewJob, approvedDigest: string): Promise<JobResult<JobRecord>> {
    return this.serial(async () => {
      const checked = validateJobSpec(input.spec);
      if (!checked.ok) {
        return { ok: false, error: `This job is not valid: ${checked.error}. Nothing was started.` };
      }
      const job = { ...input, spec: checked.spec };
      if (jobApprovalDigest(job) !== approvedDigest) {
        return { ok: false, error: 'This approval does not match the job. Nothing was started.' };
      }
      const jobs = this.list();
      const same = jobs.find((entry) => !isFinalJob(entry.status) && entry.scopeId === job.scopeId && entry.label === job.label && entry.missionId === job.missionId);
      if (same !== undefined) {
        return {
          ok: false,
          error:
            same.status === 'uncertain'
              ? `The job ${same.label} has an unknown result (${same.id}); decide about it first. Nothing was started.`
              : `The job ${same.label} is already ${same.status} (${same.id}). Nothing was started.`,
        };
      }
      if (jobs.filter((entry) => !isFinalJob(entry.status) && entry.scopeId === job.scopeId).length >= MAX_RUNNING_JOBS_PER_SCOPE) {
        return { ok: false, error: `At most ${MAX_RUNNING_JOBS_PER_SCOPE} jobs can be live or unsettled in one project. Nothing was started.` };
      }
      const id = randomUUID();
      const now = this.now();
      const record: JobRecord = {
        id,
        scopeId: job.scopeId,
        label: job.label.slice(0, 128),
        missionId: job.missionId,
        spec: job.spec,
        specDigest: jobSpecDigest(job.spec),
        dir: path.join(path.resolve(this.jobsRoot), id),
        status: 'starting',
        createdAt: now,
        updatedAt: now,
        revision: 1,
        supervisorPid: null,
        childPid: null,
        exit: null,
        cancelRequested: false,
        note: `The job ${job.label} is starting.`,
      };
      const kept = [...jobs, record];
      while (kept.length > MAX_STORED_JOBS) {
        const oldest = kept.findIndex((entry) => isFinalJob(entry.status));
        if (oldest < 0) {
          break;
        }
        kept.splice(oldest, 1);
      }
      await this.save(kept);
      try {
        await (this.options.launch ?? launchJob)(record.dir, record.spec, this.options);
      } catch (error) {
        const reason = String((error as Error)?.message ?? error).slice(0, 300);
        const failed = this.list();
        const index = failed.findIndex((entry) => entry.id === id);
        if (index >= 0) {
          Object.assign(failed[index] as JobRecord, { status: 'refused', note: `The job ${record.label} did not run: its supervisor could not start (${reason}).`, revision: record.revision + 1, updatedAt: this.now() });
          await this.save(failed);
        }
        return { ok: false, error: `The job ${record.label} did not run: its supervisor could not start (${reason}).` };
      }
      return { ok: true, value: record };
    });
  }

  /** Observe a live job and record what changed; settled jobs are returned as they are. */
  async refresh(id: string): Promise<JobResult<JobRecord>> {
    const job = this.get(id);
    if (job === null) {
      return { ok: false, error: 'RAME Code has no record of this job.' };
    }
    if (!isLive(job)) {
      return { ok: true, value: job };
    }
    return this.observe(job);
  }

  private async observe(job: JobRecord): Promise<JobResult<JobRecord>> {
    const seen = reconcileJob(job, await (this.options.probe ?? probeJob)(job.dir, this.now()));
    if (seen.status === job.status && seen.supervisorPid === job.supervisorPid && seen.childPid === job.childPid && (seen.exit === null) === (job.exit === null)) {
      return { ok: true, value: { ...job, note: seen.note } };
    }
    return this.change(job.id, (draft) => {
      if (draft.status !== job.status) {
        // Another window settled it meanwhile; keep what it recorded.
        return { ok: true, value: draft };
      }
      Object.assign(draft, { status: seen.status, note: seen.note, exit: seen.exit, supervisorPid: seen.supervisorPid, childPid: seen.childPid });
      return { ok: true, value: draft };
    });
  }

  /** After a reload: attach, close or mark uncertain every live job. Nothing is started. */
  async recover(): Promise<{ running: number; settled: number; uncertain: number }> {
    const counts = { running: 0, settled: 0, uncertain: 0 };
    for (const job of this.list().filter(isLive)) {
      const result = await this.observe(job);
      const after = result.ok ? result.value : job;
      if (isLive(after)) {
        counts.running += 1;
      } else if (after.status === 'uncertain') {
        counts.uncertain += 1;
      } else {
        counts.settled += 1;
      }
    }
    return counts;
  }

  /** Follow a job until it is no longer live (settled or uncertain). */
  async waitFor(id: string, options: { pollMs?: number; signal?: AbortSignal } = {}): Promise<JobResult<JobRecord>> {
    for (;;) {
      const result = await this.refresh(id);
      if (!result.ok || !isLive(result.value) || options.signal?.aborted === true) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1000));
    }
  }

  /** The user's request to stop a live job; its supervisor stops the whole command. */
  async cancel(id: string): Promise<JobResult<JobRecord>> {
    const job = this.get(id);
    if (job === null) {
      return { ok: false, error: 'RAME Code has no record of this job.' };
    }
    if (job.status === 'uncertain' && job.spec.cleanup) {
      // A container has a unique name: removing it can never hit an unrelated process.
      const code = await runCleanup(job.spec.cleanup);
      if (code !== 0) {
        return { ok: false, error: `RAME Code could not run the cleanup of the job ${job.label} (${job.spec.cleanup.executable} ${job.spec.cleanup.argv.join(' ')}); check it yourself, then abandon the job.` };
      }
      return this.change(id, (draft) => {
        if (draft.status !== 'uncertain') {
          return { ok: false, error: `The job ${draft.label} is ${draft.status}, not uncertain.` };
        }
        draft.status = 'cancelled';
        draft.cancelRequested = true;
        draft.note = `Stopped by the user after RAME Code lost track of the job ${draft.label} (its cleanup ran); its result is unknown and it does not count as a result.`;
        return { ok: true, value: draft };
      });
    }
    if (job.status === 'uncertain') {
      return {
        ok: false,
        error: `RAME Code has no live supervisor for the job ${job.label}, so it cannot stop it safely${job.childPid !== null ? ` (its command had pid ${job.childPid}; that number may now belong to another process)` : ''}. Check it yourself, then abandon the job.`,
      };
    }
    if (!isLive(job)) {
      return { ok: false, error: `The job ${job.label} is already ${job.status}.` };
    }
    await requestJobStop(job.dir);
    return this.change(id, (draft) => {
      draft.cancelRequested = true;
      draft.note = `The user asked to stop the job ${draft.label}; waiting for it to stop.`;
      return { ok: true, value: draft };
    });
  }

  /** The user's decision about an uncertain job. */
  async decide(id: string, decision: 'check-again' | 'abandon'): Promise<JobResult<JobRecord>> {
    const job = this.get(id);
    if (job === null) {
      return { ok: false, error: 'RAME Code has no record of this job.' };
    }
    if (job.status !== 'uncertain') {
      return { ok: false, error: `The job ${job.label} is ${job.status}, not uncertain.` };
    }
    if (decision === 'check-again') {
      return this.observe(job);
    }
    return this.change(id, (draft) => {
      if (draft.status !== 'uncertain') {
        return { ok: false, error: `The job ${draft.label} is ${draft.status}, not uncertain.` };
      }
      draft.status = 'abandoned';
      draft.note = `Abandoned by the user: the result of the job ${draft.label} is unknown, it was not restarted and it does not count as a result.`;
      return { ok: true, value: draft };
    });
  }

  tail(id: string, maxBytes = 4096): Promise<string> {
    const job = this.get(id);
    return job === null ? Promise.resolve('') : readJobLogTail(job.dir, maxBytes);
  }
}

/** Bounded, model-facing summary of one job: its state and the end of its output. */
export function describeJob(job: JobRecord, tail: string, maxTail = 2000): string {
  const end = tail.length > maxTail ? tail.slice(tail.length - maxTail) : tail;
  return `job ${job.label} (${job.id}): ${job.status}. ${job.note}${end.length > 0 ? `\nLast output:\n${end}` : ''}`;
}
