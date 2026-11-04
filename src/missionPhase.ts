/**
 * What the view says about a Mission, derived only from host data: the
 * phase label, the state of the user's acceptance check, and the final
 * report. Pure, so the wording can never claim more than the record shows
 * (a plan that was only created is never "completed").
 */

import type { MissionRecord } from './missionStore.js';

export type MissionPhase =
  | 'planning'
  | 'plan_ready'
  | 'authorizing'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'failed';

export const MISSION_PHASES: readonly MissionPhase[] = [
  'planning',
  'plan_ready',
  'authorizing',
  'running',
  'waiting_approval',
  'paused',
  'blocked',
  'completed',
  'cancelled',
  'interrupted',
  'failed',
];

/** What this window knows right now that the stored record does not say. */
export interface MissionLiveFacts {
  /** This window's autonomous loop drives the Mission. */
  driving: boolean;
  /** A start request for this Mission is being authorized. */
  authorizing: boolean;
  /** A supervised task run of this Mission is in progress here. */
  manualTask: boolean;
  /** Another live window holds the Mission's lease. */
  runningElsewhere: boolean;
}

export function missionPhase(mission: MissionRecord, live: MissionLiveFacts): MissionPhase {
  if (live.authorizing) {
    return 'authorizing';
  }
  if (mission.status === 'waiting_approval') {
    return 'waiting_approval';
  }
  if (live.driving || live.manualTask || live.runningElsewhere) {
    return 'running';
  }
  switch (mission.status) {
    case 'completed':
    case 'cancelled':
    case 'failed':
    case 'paused':
    case 'blocked':
    case 'interrupted':
      return mission.status;
    default:
      // An active Mission nobody drives: never authorized is a plan waiting
      // for the user; authorized but not running was cut short.
      return mission.grant === null ? 'plan_ready' : 'interrupted';
  }
}

export type AcceptanceState = 'none' | 'not_run' | 'passed' | 'failed' | 'tampered';

const ACCEPTANCE_PREFIX = 'acceptance (run by the host): ';
// A pass ends here or continues with its level ("; reinforced: …"); ", but …" is a failure.
const ACCEPTANCE_PASSED = /exit=0 with every frozen file intact(?:$|; )/;

/** The latest host run of the user's frozen acceptance check, if any. */
export function acceptanceState(mission: MissionRecord): { state: AcceptanceState; summary: string } {
  if (mission.grant?.acceptance == null) {
    return { state: 'none', summary: '' };
  }
  if (mission.status === 'blocked' && mission.note.includes('the acceptance check can no longer be trusted')) {
    return { state: 'tampered', summary: mission.note };
  }
  const last = [...mission.evidence].reverse().find((entry) => entry.text.startsWith(ACCEPTANCE_PREFIX));
  if (last === undefined) {
    return { state: 'not_run', summary: '' };
  }
  const summary = last.text.slice(ACCEPTANCE_PREFIX.length);
  return { state: ACCEPTANCE_PASSED.test(summary) ? 'passed' : 'failed', summary };
}

export interface MissionFinalReport {
  tasks: string[];
  files: string[];
  tests: string[];
  acceptance: string;
  internalRuns: number;
  minutes: number;
  models: string[];
  metaConsultations: string;
}

const MAX_REPORT_LINES = 12;

/** Files the host recorded as written by a tool of this Mission. */
export function missionChangedFiles(mission: MissionRecord): string[] {
  const changed = new Set<string>();
  for (const entry of mission.evidence) {
    const match = /^•?\s*(?:apply_patch|replace_in_file|create_directory) ([^→]+) →/.exec(entry.text);
    if (match) {
      (match[1] as string).split(',').map((part) => part.trim()).filter(Boolean).forEach((file) => changed.add(file));
    }
  }
  return [...changed];
}

/** Test runs the host recorded, each with its exit code. */
export function missionTestRuns(mission: MissionRecord): string[] {
  return mission.evidence
    .filter((entry) => entry.kind === 'host-record' && /^•?\s*run_tests /.test(entry.text))
    .map((entry) => entry.text.replace(/^•\s*/, ''));
}

/** Granted test commands (and the acceptance check) that never ran in this Mission. */
export function missionTestsNotRun(mission: MissionRecord): string[] {
  const granted = new Set<string>([...(mission.grant?.tests?.commandIds ?? []), ...(mission.grant?.acceptance ? [mission.grant.acceptance.commandId] : [])]);
  const ran = new Set<string>();
  for (const line of missionTestRuns(mission)) {
    const match = /^run_tests (\S+)/.exec(line);
    if (match) {
      ran.add(match[1] as string);
    }
  }
  if (mission.evidence.some((entry) => entry.text.startsWith(ACCEPTANCE_PREFIX)) && mission.grant?.acceptance) {
    ran.add(mission.grant.acceptance.commandId);
  }
  return [...granted].filter((command) => !ran.has(command));
}

/**
 * The final report exists only for a completed Mission and, when the user
 * froze an acceptance check, only after the host's own run of it exited 0.
 */
export function missionFinalReport(mission: MissionRecord): MissionFinalReport | null {
  if (mission.status !== 'completed') {
    return null;
  }
  const acceptance = acceptanceState(mission);
  if (acceptance.state !== 'none' && acceptance.state !== 'passed') {
    return null;
  }
  const grant = mission.grant;
  const escalation = grant?.escalation ?? null;
  const models = [`${grant?.model ?? 'local model'} (Muse Glimmer — Local)`];
  if (escalation !== null && escalation.used > 0) {
    models.push(`${escalation.model} (Meta Model API — Cloud, advice only)`);
  }
  const startedAt = grant?.grantedAt ?? mission.createdAt;
  return {
    tasks: mission.tasks.filter((task) => task.status === 'completed').map((task) => task.title),
    files: missionChangedFiles(mission).slice(0, MAX_REPORT_LINES),
    tests: missionTestRuns(mission).slice(-MAX_REPORT_LINES),
    acceptance:
      grant?.acceptance != null
        ? `${grant.acceptance.commandId} — ${acceptance.summary} (frozen: ${grant.acceptance.files.map((file) => file.path).join(', ')}, package.json)`
        : '',
    internalRuns: mission.taskRunsUsed,
    minutes: Math.max(0, Math.round((mission.updatedAt - startedAt) / 6000) / 10),
    models,
    metaConsultations: escalation === null ? 'none allowed' : `${escalation.used} of ${escalation.maxConsultations} (${escalation.model})`,
  };
}
