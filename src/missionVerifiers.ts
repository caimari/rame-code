/**
 * Causal verification for Mission tasks. A test command that failed is a
 * blocking verifier: no task is accepted until that same command passes
 * after the last change, under the conditions it failed in (the project
 * manifest it ran against). Another passing test never clears it. A
 * recovery that fails again later is marked invalidated, never erased.
 *
 * Pure and free of the Mission store, so it can be tested on its own.
 */

/** The last result of one test command in a run. */
export interface VerifierResult {
  commandId: string;
  exitCode: number | null;
  /** No file was written after this result in the run. */
  afterLastWrite: boolean;
}

export interface BlockingVerifier {
  commandId: string;
  /** Hash of the manifest the command failed against. */
  conditions: string;
  sinceRun: number;
  failures: number;
}

export interface VerifierRecovery {
  commandId: string;
  conditions: string;
  run: number;
  /** The run in which the same command failed again, if it did. */
  invalidatedInRun: number | null;
}

export interface VerifierUpdate {
  blockers: BlockingVerifier[];
  recoveries: VerifierRecovery[];
  notes: string[];
}

export const MAX_BLOCKING_VERIFIERS = 8;
export const MAX_VERIFIER_RECOVERIES = 20;

/** The last result of each command, in the order the commands first ran. */
function lastResults(results: readonly VerifierResult[]): VerifierResult[] {
  const last = new Map<string, VerifierResult>();
  for (const result of results) {
    last.set(result.commandId, result);
  }
  return [...last.values()];
}

/**
 * Apply one run's (or one host re-run's) test results to the open blockers.
 * `run` is the internal run the results belong to.
 */
export function updateVerifiers(
  blockers: readonly BlockingVerifier[],
  recoveries: readonly VerifierRecovery[],
  results: readonly VerifierResult[],
  conditions: string,
  run: number,
  source: 'agent' | 'host',
): VerifierUpdate {
  const open = new Map(blockers.map((blocker) => [blocker.commandId, { ...blocker }]));
  const kept = recoveries.map((recovery) => ({ ...recovery }));
  const notes: string[] = [];
  for (const result of lastResults(results)) {
    const blocker = open.get(result.commandId);
    if (result.exitCode !== 0) {
      if (blocker !== undefined) {
        blocker.failures += 1;
        continue;
      }
      open.set(result.commandId, { commandId: result.commandId, conditions, sinceRun: run, failures: 1 });
      notes.push(
        `verifier ${result.commandId} failed (exit ${result.exitCode ?? 'unknown'}) in internal run ${run}: tasks are accepted only after ${result.commandId} itself passes after the last change`,
      );
      for (const recovery of kept) {
        if (recovery.commandId === result.commandId && recovery.invalidatedInRun === null) {
          recovery.invalidatedInRun = run;
          notes.push(`verifier ${result.commandId} failed again after its recovery in internal run ${recovery.run}: that recovery is invalidated`);
        }
      }
    } else if (blocker !== undefined) {
      if (!result.afterLastWrite) {
        notes.push(`verifier ${result.commandId} passed before a later change in internal run ${run}; it must pass after the last change`);
      } else if (blocker.conditions !== conditions) {
        notes.push(`verifier ${result.commandId} passed, but package.json changed since it failed; that does not count as its recovery`);
      } else {
        open.delete(result.commandId);
        kept.push({ commandId: result.commandId, conditions, run, invalidatedInRun: null });
        notes.push(
          `verifier ${result.commandId} recovered in internal run ${run}${source === 'host' ? ' (re-run by the host)' : ''}: it passed after the last change under the conditions it failed in (blocking since run ${blocker.sinceRun})`,
        );
      }
    }
  }
  return {
    blockers: [...open.values()].slice(0, MAX_BLOCKING_VERIFIERS),
    recoveries: kept.slice(-MAX_VERIFIER_RECOVERIES),
    notes,
  };
}

/** The prompt line for the next internal run while a verifier blocks. */
export function blockingVerifierPrompt(blockers: readonly BlockingVerifier[]): string {
  if (blockers.length === 0) {
    return '';
  }
  const names = blockers.map((blocker) => `${blocker.commandId} (failing since internal run ${blocker.sinceRun})`).join(', ');
  return (
    `BLOCKING VERIFIER: ${names}. The host accepts this task only after each of them passes after your last change; another passing test does not count. ` +
    `Fix the cause, then run ${(blockers[0] as BlockingVerifier).commandId}.`
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const COMMAND_ID = /^[a-z]+:[A-Za-z0-9._-]{1,64}$/;

/** Parse persisted blockers; anything malformed is refused (undefined). */
export function parseBlockingVerifiers(raw: unknown): BlockingVerifier[] | undefined {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_BLOCKING_VERIFIERS) {
    return undefined;
  }
  const parsed: BlockingVerifier[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.commandId !== 'string' || !COMMAND_ID.test(entry.commandId) || typeof entry.conditions !== 'string' || entry.conditions.length > 128 || !isCount(entry.sinceRun) || !isCount(entry.failures)) {
      return undefined;
    }
    parsed.push({ commandId: entry.commandId, conditions: entry.conditions, sinceRun: entry.sinceRun, failures: entry.failures });
  }
  return parsed;
}

/** Parse persisted recoveries; anything malformed is refused (undefined). */
export function parseVerifierRecoveries(raw: unknown): VerifierRecovery[] | undefined {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_VERIFIER_RECOVERIES) {
    return undefined;
  }
  const parsed: VerifierRecovery[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.commandId !== 'string' ||
      !COMMAND_ID.test(entry.commandId) ||
      typeof entry.conditions !== 'string' ||
      entry.conditions.length > 128 ||
      !isCount(entry.run) ||
      !(entry.invalidatedInRun === null || isCount(entry.invalidatedInRun))
    ) {
      return undefined;
    }
    parsed.push({ commandId: entry.commandId, conditions: entry.conditions, run: entry.run, invalidatedInRun: entry.invalidatedInRun });
  }
  return parsed;
}
