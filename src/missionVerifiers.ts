/**
 * Causal verification for Mission tasks. A test command that failed is a
 * blocking verifier with a stable id: no task is accepted until that same
 * command passes after the last change, under the conditions it failed in
 * (the project manifest it ran against). Another passing test never clears
 * it. A recovery that fails again later is marked invalidated, never erased.
 * Advisory consultations are counted on the blocker that motivated them;
 * an answer from Meta never recovers anything by itself.
 *
 * Pure and free of the Mission store, so it can be tested on its own.
 */

import { createHash } from 'node:crypto';

/** The last result of one test command in a run. */
export interface VerifierResult {
  commandId: string;
  exitCode: number | null;
  /** No file was written after this result in the run. */
  afterLastWrite: boolean;
}

/** open: it can recover. conditions-changed: package.json differs from when it failed. unrecoverable: it can no longer run. */
export type BlockerState = 'open' | 'conditions-changed' | 'unrecoverable';

export interface BlockingVerifier {
  /** Stable id: the same failure keeps it across runs and reloads. */
  id: string;
  commandId: string;
  /** Hash of the manifest the command failed against. */
  conditions: string;
  sinceRun: number;
  failures: number;
  /** Exit code of the failure that opened it. */
  originalExit: number | null;
  state: BlockerState;
  stateReason: string;
  /** Advisory consultations sent for this blocker, and the valid answers among them. */
  advisoryAttempts: number;
  validResponses: number;
}

export interface VerifierRecovery {
  blockerId: string;
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

/** The stable id of a blocker: its command, conditions, and the run it first failed in. */
export function blockerId(commandId: string, conditions: string, sinceRun: number, missionId = ''): string {
  return `blk_${createHash('sha256').update(`${missionId}|${commandId}|${conditions}|${sinceRun}`, 'utf8').digest('hex').slice(0, 16)}`;
}

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
  missionId = '',
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
      const id = blockerId(result.commandId, conditions, run, missionId);
      open.set(result.commandId, {
        id,
        commandId: result.commandId,
        conditions,
        sinceRun: run,
        failures: 1,
        originalExit: result.exitCode,
        state: 'open',
        stateReason: '',
        advisoryAttempts: 0,
        validResponses: 0,
      });
      notes.push(
        `verifier ${result.commandId} failed (exit ${result.exitCode ?? 'unknown'}) in internal run ${run} [${id}]: tasks are accepted only after ${result.commandId} itself passes after the last change`,
      );
      for (const recovery of kept) {
        if (recovery.commandId === result.commandId && recovery.invalidatedInRun === null) {
          recovery.invalidatedInRun = run;
          notes.push(`verifier ${result.commandId} failed again after its recovery in internal run ${recovery.run} [${recovery.blockerId}]: that recovery is invalidated`);
        }
      }
    } else if (blocker !== undefined) {
      if (blocker.state === 'unrecoverable') {
        continue;
      }
      if (!result.afterLastWrite) {
        notes.push(`verifier ${result.commandId} passed before a later change in internal run ${run}; it must pass after the last change`);
      } else if (blocker.conditions !== conditions) {
        blocker.state = 'conditions-changed';
        blocker.stateReason = 'package.json changed since it failed';
        notes.push(`verifier ${result.commandId} passed, but package.json changed since it failed [${blocker.id}]; that does not count as its recovery`);
      } else {
        open.delete(result.commandId);
        kept.push({ blockerId: blocker.id, commandId: result.commandId, conditions, run, invalidatedInRun: null });
        notes.push(
          `verifier ${result.commandId} recovered in internal run ${run}${source === 'host' ? ' (re-run by the host)' : ''} [${blocker.id}]: it passed after the last change under the conditions it failed in (blocking since run ${blocker.sinceRun})`,
        );
      }
    }
  }
  for (const blocker of open.values()) {
    if (blocker.state === 'conditions-changed' && blocker.conditions === conditions) {
      blocker.state = 'open';
      blocker.stateReason = '';
    }
  }
  return {
    blockers: [...open.values()].slice(0, MAX_BLOCKING_VERIFIERS),
    recoveries: kept.slice(-MAX_VERIFIER_RECOVERIES),
    notes,
  };
}

/**
 * Blockers whose command is no longer an allowed test can never recover:
 * mark them unrecoverable (shown, never dropped). Returns the notes.
 */
export function markUnrecoverable(blockers: BlockingVerifier[], allowedCommandIds: readonly string[]): string[] {
  const notes: string[] = [];
  for (const blocker of blockers) {
    if (blocker.state !== 'unrecoverable' && !allowedCommandIds.includes(blocker.commandId)) {
      blocker.state = 'unrecoverable';
      blocker.stateReason = `${blocker.commandId} is no longer an allowed test of this project`;
      notes.push(`verifier ${blocker.commandId} [${blocker.id}] can no longer run (${blocker.stateReason}): its recovery is blocked`);
    }
  }
  return notes;
}

/** The prompt line for the next internal run while a verifier blocks. */
export function blockingVerifierPrompt(blockers: readonly BlockingVerifier[]): string {
  if (blockers.length === 0) {
    return '';
  }
  const names = blockers
    .map((blocker) => `${blocker.commandId} (failing since internal run ${blocker.sinceRun}${blocker.state === 'conditions-changed' ? '; package.json changed since then, restore it' : ''})`)
    .join(', ');
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
const BLOCKER_ID = /^blk_[0-9a-f]{16}$/;
const STATES: readonly BlockerState[] = ['open', 'conditions-changed', 'unrecoverable'];

/** Parse persisted blockers; anything malformed is refused (undefined). Older records get stable defaults. */
export function parseBlockingVerifiers(raw: unknown): BlockingVerifier[] | undefined {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_BLOCKING_VERIFIERS) {
    return undefined;
  }
  const parsed: BlockingVerifier[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.commandId !== 'string' ||
      !COMMAND_ID.test(entry.commandId) ||
      typeof entry.conditions !== 'string' ||
      entry.conditions.length > 128 ||
      !isCount(entry.sinceRun) ||
      !isCount(entry.failures) ||
      (entry.id !== undefined && (typeof entry.id !== 'string' || !BLOCKER_ID.test(entry.id))) ||
      (entry.originalExit !== undefined && entry.originalExit !== null && !Number.isInteger(entry.originalExit)) ||
      (entry.state !== undefined && !STATES.includes(entry.state as BlockerState)) ||
      (entry.stateReason !== undefined && (typeof entry.stateReason !== 'string' || entry.stateReason.length > 200)) ||
      (entry.advisoryAttempts !== undefined && !isCount(entry.advisoryAttempts)) ||
      (entry.validResponses !== undefined && !isCount(entry.validResponses))
    ) {
      return undefined;
    }
    parsed.push({
      id: typeof entry.id === 'string' ? entry.id : blockerId(entry.commandId, entry.conditions, entry.sinceRun),
      commandId: entry.commandId,
      conditions: entry.conditions,
      sinceRun: entry.sinceRun,
      failures: entry.failures,
      originalExit: typeof entry.originalExit === 'number' ? entry.originalExit : null,
      state: (entry.state as BlockerState | undefined) ?? 'open',
      stateReason: typeof entry.stateReason === 'string' ? entry.stateReason : '',
      advisoryAttempts: isCount(entry.advisoryAttempts) ? entry.advisoryAttempts : 0,
      validResponses: isCount(entry.validResponses) ? entry.validResponses : 0,
    });
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
      !(entry.invalidatedInRun === null || isCount(entry.invalidatedInRun)) ||
      (entry.blockerId !== undefined && (typeof entry.blockerId !== 'string' || !BLOCKER_ID.test(entry.blockerId)))
    ) {
      return undefined;
    }
    parsed.push({
      blockerId: typeof entry.blockerId === 'string' ? entry.blockerId : blockerId(entry.commandId, entry.conditions, entry.run),
      commandId: entry.commandId,
      conditions: entry.conditions,
      run: entry.run,
      invalidatedInRun: entry.invalidatedInRun,
    });
  }
  return parsed;
}
