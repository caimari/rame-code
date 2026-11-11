/**
 * Long jobs (piece C of the long-Mission plan): commands that run for minutes
 * or hours, outlive a reload of the window that started them, and are never
 * started twice by the host.
 *
 * This module is pure: the record, its approval digest, and the decision the
 * host takes after a reload from what it can observe of a job. The process
 * side is `jobRunner.ts` and `runtime/rame-job-supervisor.cjs`.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const MAX_JOB_DURATION_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_JOB_LOG_BYTES = 256 * 1024;
export const MAX_JOB_LOG_BYTES = 4 * 1024 * 1024;
export const DEFAULT_JOB_HEARTBEAT_MS = 1000;
export const MAX_RUNNING_JOBS_PER_SCOPE = 2;
export const MAX_STORED_JOBS = 50;

/**
 * `starting`/`running` are live; `uncertain` waits for the user; the rest are
 * final. A final job is never changed again and never restarted.
 */
export type JobStatus = 'starting' | 'running' | 'uncertain' | 'finished' | 'cancelled' | 'timed_out' | 'refused' | 'abandoned';
const STATUSES: readonly JobStatus[] = ['starting', 'running', 'uncertain', 'finished', 'cancelled', 'timed_out', 'refused', 'abandoned'];
const FINAL: readonly JobStatus[] = ['finished', 'cancelled', 'timed_out', 'refused', 'abandoned'];

export const isFinalJob = (status: JobStatus): boolean => FINAL.includes(status);

/** Exactly what the supervisor runs; its sha256 is what the user approved. */
export interface JobSpec {
  executable: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  maxLogBytes: number;
  heartbeatMs: number;
  env: Record<string, string>;
  keepElectronRunAsNode: boolean;
  /** Run by the supervisor when it stops the job and when the job ends (e.g. remove its container). */
  cleanup?: { executable: string; argv: string[] } | null;
}

/** What the supervisor writes last, in `exit.json`. */
export interface JobExit {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  refused?: string;
  endedAt: number;
}

export interface JobRecord {
  id: string;
  scopeId: string;
  /** Allowlisted command id, e.g. `npm:bench`. */
  label: string;
  missionId: string | null;
  spec: JobSpec;
  /** sha256 of the canonical spec, the bytes of `spec.json`. */
  specDigest: string;
  dir: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  revision: number;
  supervisorPid: number | null;
  childPid: number | null;
  exit: JobExit | null;
  cancelRequested: boolean;
  /** Plain explanation of the latest state change. */
  note: string;
}

/** What the host can observe of a job directory. */
export interface JobProbe {
  now: number;
  exit: JobExit | null;
  started: { pid: number; childPid: number | null; startedAt: number } | null;
  heartbeatAt: number | null;
  /** Whether the command's pid answers a signal 0 (informative only: pids are reused). */
  childAlive: boolean | null;
}

/** The canonical bytes of a spec, in a fixed key order. */
export function canonicalJobSpec(spec: JobSpec): string {
  const env: Record<string, string> = {};
  for (const key of Object.keys(spec.env).sort()) {
    env[key] = spec.env[key] as string;
  }
  return JSON.stringify({
    executable: spec.executable,
    argv: [...spec.argv],
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
    maxLogBytes: spec.maxLogBytes,
    heartbeatMs: spec.heartbeatMs,
    env,
    keepElectronRunAsNode: spec.keepElectronRunAsNode,
    cleanup: spec.cleanup ? { executable: spec.cleanup.executable, argv: [...spec.cleanup.argv] } : null,
  });
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export const jobSpecDigest = (spec: JobSpec): string => sha256(canonicalJobSpec(spec));

/** The digest an approval binds: where it runs, for whom, and exactly what. */
export function jobApprovalDigest(input: { scopeId: string; label: string; missionId: string | null; spec: JobSpec }): string {
  return sha256(JSON.stringify({ scopeId: input.scopeId, label: input.label, missionId: input.missionId, spec: jobSpecDigest(input.spec) }));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((part) => typeof part === 'string');
const isPid = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

/** Validate a spec before it is approved or after it is read back. */
export function validateJobSpec(raw: unknown): { ok: true; spec: JobSpec } | { ok: false; error: string } {
  if (!isRecord(raw) || typeof raw.executable !== 'string' || raw.executable.length === 0 || raw.executable.length > 256) {
    return { ok: false, error: 'a job needs an executable' };
  }
  if (!isStrings(raw.argv) || raw.argv.length > 96 || raw.argv.some((part) => part.length > 1024 || part.includes('\0'))) {
    return { ok: false, error: 'a job needs a bounded list of arguments' };
  }
  if (typeof raw.cwd !== 'string' || !path.isAbsolute(raw.cwd)) {
    return { ok: false, error: 'a job needs an absolute working folder' };
  }
  if (!Number.isInteger(raw.timeoutMs) || (raw.timeoutMs as number) < 1000 || (raw.timeoutMs as number) > MAX_JOB_DURATION_MS) {
    return { ok: false, error: `a job's time limit must be 1 s to ${MAX_JOB_DURATION_MS / 3_600_000} h` };
  }
  if (!Number.isInteger(raw.maxLogBytes) || (raw.maxLogBytes as number) < 1024 || (raw.maxLogBytes as number) > MAX_JOB_LOG_BYTES) {
    return { ok: false, error: 'a job needs a bounded log size' };
  }
  if (!Number.isInteger(raw.heartbeatMs) || (raw.heartbeatMs as number) < 50 || (raw.heartbeatMs as number) > 10_000) {
    return { ok: false, error: 'a job needs a heartbeat of 50 ms to 10 s' };
  }
  if (!isRecord(raw.env) || Object.keys(raw.env).length > 32 || !Object.values(raw.env).every((value) => typeof value === 'string')) {
    return { ok: false, error: 'a job needs a small set of extra environment variables' };
  }
  if (typeof raw.keepElectronRunAsNode !== 'boolean') {
    return { ok: false, error: 'a job spec is incomplete' };
  }
  const cleanup = raw.cleanup ?? null;
  if (cleanup !== null && (!isRecord(cleanup) || typeof cleanup.executable !== 'string' || cleanup.executable.length === 0 || !isStrings(cleanup.argv) || cleanup.argv.length > 16)) {
    return { ok: false, error: 'a job cleanup must be an executable with a few arguments' };
  }
  return {
    ok: true,
    spec: {
      executable: raw.executable,
      argv: [...raw.argv],
      cwd: raw.cwd,
      timeoutMs: raw.timeoutMs as number,
      maxLogBytes: raw.maxLogBytes as number,
      heartbeatMs: raw.heartbeatMs as number,
      env: { ...(raw.env as Record<string, string>) },
      keepElectronRunAsNode: raw.keepElectronRunAsNode,
      cleanup: cleanup === null ? null : { executable: cleanup.executable as string, argv: [...(cleanup.argv as string[])] },
    },
  };
}

export function parseJobExit(raw: unknown): JobExit | null {
  if (!isRecord(raw) || typeof raw.endedAt !== 'number' || typeof raw.timedOut !== 'boolean' || typeof raw.cancelled !== 'boolean') {
    return null;
  }
  if (!(raw.exitCode === null || Number.isInteger(raw.exitCode)) || !(raw.signal === null || typeof raw.signal === 'string')) {
    return null;
  }
  return {
    exitCode: raw.exitCode as number | null,
    signal: raw.signal as string | null,
    timedOut: raw.timedOut,
    cancelled: raw.cancelled,
    ...(typeof raw.refused === 'string' ? { refused: raw.refused.slice(0, 400) } : {}),
    endedAt: raw.endedAt,
  };
}

/** A stored record; `null` when damaged or when its folder is outside `jobsRoot`. */
export function parseJobRecord(raw: unknown, jobsRoot: string): JobRecord | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !/^[a-z0-9-]{8,64}$/.test(raw.id)) {
    return null;
  }
  const spec = validateJobSpec(raw.spec);
  if (!spec.ok || typeof raw.specDigest !== 'string' || raw.specDigest !== jobSpecDigest(spec.spec)) {
    return null;
  }
  if (typeof raw.dir !== 'string' || path.resolve(raw.dir) !== path.join(path.resolve(jobsRoot), raw.id)) {
    return null;
  }
  if (!STATUSES.includes(raw.status as JobStatus) || typeof raw.scopeId !== 'string' || typeof raw.label !== 'string') {
    return null;
  }
  if (typeof raw.createdAt !== 'number' || typeof raw.updatedAt !== 'number' || !Number.isInteger(raw.revision)) {
    return null;
  }
  return {
    id: raw.id,
    scopeId: raw.scopeId,
    label: raw.label.slice(0, 128),
    missionId: typeof raw.missionId === 'string' ? raw.missionId : null,
    spec: spec.spec,
    specDigest: raw.specDigest,
    dir: raw.dir,
    status: raw.status as JobStatus,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    revision: raw.revision as number,
    supervisorPid: isPid(raw.supervisorPid) ? raw.supervisorPid : null,
    childPid: isPid(raw.childPid) ? raw.childPid : null,
    exit: parseJobExit(raw.exit),
    cancelRequested: raw.cancelRequested === true,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 600) : '',
  };
}

/** After this long without a heartbeat, a live job is no longer assumed alive. */
export const jobStaleAfterMs = (spec: JobSpec): number => spec.heartbeatMs * 5 + 2000;

const seconds = (ms: number): string => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

export interface JobReconciliation {
  status: JobStatus;
  note: string;
  exit: JobExit | null;
  supervisorPid: number | null;
  childPid: number | null;
}

/**
 * What a live (`starting`/`running`) or uncertain job is now, from what the
 * host can observe. Only a result the supervisor wrote ends a job; a fresh
 * heartbeat means it is still running (attach); anything else is uncertain,
 * and an uncertain job is never restarted: the user decides.
 */
export function reconcileJob(record: JobRecord, probe: JobProbe): JobReconciliation {
  const supervisorPid = probe.started?.pid ?? record.supervisorPid;
  const childPid = probe.started?.childPid ?? record.childPid;
  const base = { exit: record.exit, supervisorPid, childPid };
  if (isFinalJob(record.status)) {
    return { ...base, status: record.status, note: record.note };
  }
  const exit = probe.exit;
  if (exit !== null) {
    if (exit.refused !== undefined) {
      return { ...base, exit, status: 'refused', note: `The job ${record.label} did not run: ${exit.refused}.` };
    }
    if (exit.cancelled) {
      return { ...base, exit, status: 'cancelled', note: `The job ${record.label} was stopped at the user's request.` };
    }
    if (exit.timedOut) {
      return { ...base, exit, status: 'timed_out', note: `The job ${record.label} was stopped at its approved limit of ${seconds(record.spec.timeoutMs)}; it did not finish.` };
    }
    const how = exit.exitCode !== null ? `exit ${exit.exitCode}` : `signal ${exit.signal ?? 'unknown'}`;
    return { ...base, exit, status: 'finished', note: `The job ${record.label} finished (${how}) after ${seconds(Math.max(0, exit.endedAt - record.createdAt))}.` };
  }
  const stale = jobStaleAfterMs(record.spec);
  if (probe.heartbeatAt !== null && probe.now - probe.heartbeatAt <= stale) {
    return {
      ...base,
      status: probe.started !== null ? 'running' : 'starting',
      // An absolute time: the stored note stays true however long it is kept.
      note: probe.started !== null ? `The job ${record.label} is running (started at ${new Date(probe.started.startedAt).toISOString()}).` : `The job ${record.label} is starting.`,
    };
  }
  if (record.status === 'starting' && probe.heartbeatAt === null && probe.now - record.createdAt <= stale) {
    return { ...base, status: 'starting', note: `The job ${record.label} is starting.` };
  }
  const nothing = 'Nothing was restarted. Check the workspace, then decide: check again, or abandon it.';
  if (probe.started === null) {
    return {
      ...base,
      status: 'uncertain',
      note: `RAME Code lost track of the job ${record.label} while it was starting; it may or may not have started. ${nothing}`,
    };
  }
  const silent = probe.heartbeatAt !== null ? ` (last sign of life ${seconds(Math.max(0, probe.now - probe.heartbeatAt))} ago)` : '';
  const container = record.spec.cleanup ? ` Its cleanup (${record.spec.cleanup.executable} ${record.spec.cleanup.argv.join(' ')}) has not run: Stop runs it.` : '';
  const command = childPid === null
    ? container
    : probe.childAlive === true
      ? ` Its command (pid ${childPid}) may still be running; RAME Code does not stop it on its own.${container}`
      : probe.childAlive === false
        ? ` Its command (pid ${childPid}) is no longer running.${container}`
        : container;
  return {
    ...base,
    status: 'uncertain',
    note: `The job ${record.label} stopped reporting without recording a result${silent}.${command} ${nothing}`,
  };
}
