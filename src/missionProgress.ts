/**
 * What counts as progress in an autonomous Mission (P5h, the user's decision
 * of 08-11-2026): a demonstrable improvement, never a different choice of
 * tests or files edited back and forth.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * A run makes progress only when, at once:
 *   - a test command passes that did not pass at its last result in this
 *     Mission (or had never run), or a blocking verifier recovered; and
 *   - the files reach a state no run of this Mission reached before.
 * Running other tests, the same tests again, or returning to an earlier file
 * state with the same results is not progress, so the Mission blocks after
 * a few such runs instead of looping (and spending paid tokens).
 */

import { createHash } from 'node:crypto';

/** Bounds of the progress memory kept in the checkpoint. */
export const MAX_TRACKED_FILES = 200;
export const MAX_SEEN_STATES = 64;
export const MAX_TRACKED_TESTS = 50;

export interface ProgressMemory {
  /** The hash of each file the Mission's runs wrote (null = deleted). */
  fileState: Record<string, string | null>;
  /** Signatures of every file state already reached. */
  seenStates: string[];
  /** The last result of each test command (true = passed). */
  lastResults: Record<string, boolean>;
}

interface Observed {
  writes: Array<{ path: string; hash: string | null }>;
  lastTest: { commandId: string; exitCode: number | null } | null;
  verifiers?: Array<{ commandId: string; exitCode: number | null }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The host's measure of one run against what the Mission already reached:
 * whether a test command passes now that did not pass at its last result
 * (or had never run), and whether the files are in a state not reached
 * before (a run that writes nothing keeps the current state, new only once).
 */
export function measureProgress(previous: Partial<ProgressMemory> | null | undefined, observation: Observed): { improved: boolean; newState: boolean; memory: ProgressMemory } {
  const fileState: Record<string, string | null> = { ...(previous?.fileState ?? {}) };
  for (const write of observation.writes) {
    fileState[write.path] = write.hash;
  }
  const paths = Object.keys(fileState).sort().slice(0, MAX_TRACKED_FILES);
  const bounded = Object.fromEntries(paths.map((file) => [file, fileState[file] ?? null]));
  const state = createHash('sha256').update(JSON.stringify(paths.map((file) => [file, bounded[file]]))).digest('hex').slice(0, 32);
  const seen = previous?.seenStates ?? [];
  const newState = !seen.includes(state);
  const lastResults: Record<string, boolean> = { ...(previous?.lastResults ?? {}) };
  const results = observation.verifiers && observation.verifiers.length > 0
    ? observation.verifiers.map((entry) => ({ commandId: entry.commandId, pass: entry.exitCode === 0 }))
    : observation.lastTest !== null ? [{ commandId: observation.lastTest.commandId, pass: observation.lastTest.exitCode === 0 }] : [];
  let improved = false;
  for (const result of results) {
    if (result.pass && lastResults[result.commandId] !== true) {
      improved = true;
    }
    lastResults[result.commandId] = result.pass;
  }
  const tests = Object.keys(lastResults).slice(-MAX_TRACKED_TESTS);
  return {
    improved,
    newState,
    memory: {
      fileState: bounded,
      seenStates: (newState ? [...seen, state] : seen).slice(-MAX_SEEN_STATES),
      lastResults: Object.fromEntries(tests.map((name) => [name, lastResults[name] as boolean])),
    },
  };
}

/** The progress memory of a stored checkpoint; a malformed part is left out (and starts again). */
export function parseProgressMemory(raw: Record<string, unknown>): Partial<ProgressMemory> {
  const out: Partial<ProgressMemory> = {};
  if (isRecord(raw.fileState) && Object.keys(raw.fileState).length <= MAX_TRACKED_FILES && Object.entries(raw.fileState).every(([file, hash]) => file.length <= 512 && (hash === null || (typeof hash === 'string' && hash.length <= 128)))) {
    out.fileState = raw.fileState as Record<string, string | null>;
  }
  if (Array.isArray(raw.seenStates) && raw.seenStates.length <= MAX_SEEN_STATES && raw.seenStates.every((entry) => typeof entry === 'string' && entry.length <= 64)) {
    out.seenStates = [...(raw.seenStates as string[])];
  }
  if (isRecord(raw.lastResults) && Object.keys(raw.lastResults).length <= MAX_TRACKED_TESTS && Object.values(raw.lastResults).every((value) => typeof value === 'boolean')) {
    out.lastResults = raw.lastResults as Record<string, boolean>;
  }
  return out;
}

/** Internal runs per task the user may choose for an autonomous Mission. */
export const MIN_RUNS_PER_TASK = 1;
export const MAX_RUNS_PER_TASK = 8;
/** The ceiling of chained runs of one autonomous Mission. */
const MAX_MISSION_RUNS = 40;

export function validRunsPerTask(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_RUNS_PER_TASK && (value as number) <= MAX_RUNS_PER_TASK;
}

/**
 * The run budget of a Mission being authorized. The user's choice (1 to 8
 * runs per task) is used exactly and never raised, also when the Mission is
 * authorized again without a new choice; with no choice, an autonomous
 * Mission gets the safety ceiling of 8 runs per task.
 */
export function runBudget(input: { mode: 'supervised' | 'autonomous-workspace'; chosen?: number; stored?: number; tasks: number; current: number }): { ok: true; maxTaskRuns: number; runsPerTask?: number } | { ok: false; error: string } {
  if (input.chosen !== undefined && !validRunsPerTask(input.chosen)) {
    return { ok: false, error: `Choose ${MIN_RUNS_PER_TASK} to ${MAX_RUNS_PER_TASK} internal runs per task.` };
  }
  const perTask = input.chosen ?? input.stored;
  if (input.mode !== 'autonomous-workspace') {
    return { ok: true, maxTaskRuns: input.current, ...(perTask !== undefined ? { runsPerTask: perTask } : {}) };
  }
  if (perTask !== undefined) {
    return { ok: true, maxTaskRuns: Math.min(MAX_MISSION_RUNS, input.tasks * perTask), runsPerTask: perTask };
  }
  return { ok: true, maxTaskRuns: Math.max(input.current, Math.min(MAX_MISSION_RUNS, input.tasks * MAX_RUNS_PER_TASK)) };
}

/** The run budget the user chose on a Mission's authorization card, kept until that Mission is authorized. */
const runRequests = new WeakMap<object, Map<string, number>>();

export function recordMissionRunsRequest(host: object, missionId: string, runsPerTask: number): void {
  const byMission = runRequests.get(host) ?? new Map<string, number>();
  byMission.set(missionId, runsPerTask);
  runRequests.set(host, byMission);
}

export function takeMissionRunsRequest(host: object, missionId: string): number | null {
  const byMission = runRequests.get(host);
  const chosen = byMission?.get(missionId) ?? null;
  byMission?.delete(missionId);
  return chosen;
}
