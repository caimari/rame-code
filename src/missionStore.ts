/**
 * Persistent Mission state: one goal split into tasks, worked through by
 * bounded Agent runs the user starts explicitly.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Rules:
 * - A Mission runs only after the user starts it. Each internal run is an
 *   ordinary bounded Agent run (12 model steps, approvals). Under a Mission
 *   grant the host chains internal runs by itself (see the autonomy helpers
 *   below) until the goal is verified, an approval is needed, the user
 *   pauses or cancels, or the host sees no progress.
 * - The number of task runs is budgeted; when it is spent the Mission fails
 *   instead of looping.
 * - A reload or crash during a run leaves the Mission `interrupted`; nothing
 *   is repeated automatically. Resuming starts a new run of the current
 *   task that is told what already ran.
 * - Every update names the revision it read (optimistic concurrency), so
 *   two windows cannot silently overwrite each other.
 * - Unreadable stored state is never overwritten.
 */

import { describeScopedFile, MAX_FINITE_CONSULTATIONS, parseMetaBinding, type MetaBinding } from './autonomyPolicy.js';
import { copyManifest, parseAcceptanceManifest, type AcceptanceManifest } from './acceptanceManifest.js';
import { copyMetricSpec, parseMetricSpec, type MetricSpec } from './metricAcceptance.js';
import { copyFrozenReferences, parseFrozenReferences, type FrozenReference } from './referenceCheck.js';
import { describeMissionWeb, parseMissionWebGrant, type MissionWebGrant } from './missionWeb.js';
import { createHash, randomBytes } from 'node:crypto';
import { measureProgress, parseProgressMemory, runBudget, validRunsPerTask, type ProgressMemory } from './missionProgress.js';

import { ADVISORY_DATA_CLASSES } from './remoteAuthority.js';
import { checkAdvisoryLimits, storedAdvisoryLimits, type AdvisoryLimits } from './missionAdvisoryLimits.js';
import { parseMissionAcceptanceReview, type MissionAcceptanceReview } from './missionAcceptanceReview.js';
import {
  blockingVerifierPrompt,
  parseBlockingVerifiers,
  parseVerifierRecoveries,
  updateVerifiers,
  type BlockingVerifier,
  type VerifierRecovery,
  type VerifierResult,
  type VerifierUpdate,
} from './missionVerifiers.js';

export const MISSION_STATE_KEY = 'rameCode.missions.v1';
export const MISSION_SCHEMA = 1;
export const MAX_MISSIONS = 50;
export const MAX_MISSION_TASKS = 20;
export const MAX_MISSION_EVIDENCE = 200;
export const MAX_EVIDENCE_TEXT = 300;
export const MAX_GOAL_LENGTH = 2000;
/** Runs allowed per task on average; the whole Mission is capped below. */
export const TASK_RUNS_PER_TASK = 2;
export const MAX_TASK_RUNS = 30;

export type MissionStatus = 'active' | 'waiting_approval' | 'interrupted' | 'completed' | 'failed' | 'paused' | 'cancelled' | 'blocked';

/** Internal runs with no host-verified progress in a row before `blocked`. */
export const MAX_NO_PROGRESS_RUNS = 3;
/** Safety ceiling for internal runs of one task under autonomy (never the normal stop). */
export const MAX_AUTO_RUNS_PER_TASK = 8;
/** Safety ceiling for internal runs of a whole autonomous Mission. */
export const MAX_AUTO_MISSION_RUNS = 40;

/**
 * What the user authorized for one Mission, bound to it: the Mission id,
 * its project, the provider and model, and the mode. It is never reused for
 * another Mission, project, provider, or model.
 */
export interface MissionGrant {
  missionId: string;
  scopeId: string;
  /** The main model's provider: it does the Mission's work (Glimmer or another local model, or Meta). Never switched during the Mission. */
  provider: 'local' | 'cloud';
  model: string;
  /** supervised: every write and test still asks. autonomous-workspace: see AUTONOMOUS_TOOLS. */
  mode: 'supervised' | 'autonomous-workspace';
  grantedAt: number;
  /** Optional advice from Meta when a run stops for a capability reason; null = none. */
  /**
   * Advisory consultations only ("used" counts attempts that were sent),
   * the valid answers received, and the data classes they may carry. It
   * never authorizes a delegated run.
   */
  /** Advisory only; its limits are fixed at authorization (missionAdvisoryLimits.ts). */
  /** `preauth`: the workspace pre-authorization it was given under (Autonomy & Permissions); without it nothing is sent without a card. */
  escalation: ({ model: string; maxConsultations: number | null; used: number; validResponses: number; dataClasses: string[]; sentBytes: number; usedTokens: number; preauth?: MetaBinding | null } & AdvisoryLimits) | null;
  /**
   * Autonomous only: the user marked this project as trusted, and the test
   * commands it may run without a card, bound to the package.json they come
   * from. A different package.json (even one the agent edited) voids it.
   * Test scripts run with the user's permissions: RAME's path checks are not
   * an operating-system sandbox.
   */
  tests: { trustedProject: true; packageJsonHash: string; commandIds: string[] } | null;
  /**
   * The user's acceptance check, frozen when the Mission is authorized: one
   * allowlisted command and the files that define it, by hash, plus the
   * package.json it is declared in. The agent may read and run them but never
   * change them; the host itself runs the check before `completed`.
   */
  acceptance: { commandId: string; packageJsonHash: string; files: Array<{ path: string; hash: string }>; scope?: AcceptanceManifest; metrics?: MetricSpec; references?: FrozenReference[] } | null;
  /** Web access for this Mission's runs (budget, domains, used); absent = off. See missionWeb.ts. */
  web?: MissionWebGrant;
  /**
   * First stage for an empty project. It may scaffold files, but it has no
   * test grant and can never complete a task. The host stops it as soon as
   * it can present newly created tests for a second, explicit authorization.
   */
  bootstrap?: true;
}

/** Tools an autonomous-workspace grant runs without a card. Never delete, move, chmod, or memory writes. */
export const AUTONOMOUS_TOOLS: readonly string[] = [
  'list_files',
  'inspect_workspace',
  'filesystem_usage',
  'search_history',
  'search_text',
  'read_file',
  'read_decisions',
  'read_original',
  'create_directory',
  'apply_patch',
  'replace_in_file',
  'run_tests',
];

/** Checkpoint of the autonomous loop, persisted after every internal run. */
export interface MissionAutoState {
  /** Internal runs since the user last started or resumed the Mission. */
  runs: number;
  startedAt: number;
  noProgressStreak: number;
  /** Host-derived signature of the workspace state after the last run. */
  lastSignature: string;
  /** Latest host evidence of progress, for the view. */
  lastProgress: string;
  /** The current task changed files and no passing test ran after the last change. */
  needsVerification: boolean;
  /** Advice (untrusted) to quote in the next internal run, if any. */
  pendingAdvice: string;
  /** The host's last failed acceptance check, shown to the next internal run. */
  acceptanceFeedback: string;
  /** The agent's own final report of the last internal run (its findings), quoted to the next one. */
  lastRunNotes: string;
  /** Guidance the user typed when retrying a blocked Mission, quoted to the next runs. */
  userGuidance: string;
  /** Test commands that failed and must pass again before a task is accepted. */
  blockers: BlockingVerifier[];
  /** Recoveries of blocking verifiers, kept (and invalidated) as evidence. */
  recoveries: VerifierRecovery[];
  /** What "progress" is measured against (missionProgress.ts); absent in older records. */
  fileState?: ProgressMemory['fileState'];
  seenStates?: ProgressMemory['seenStates'];
  lastResults?: ProgressMemory['lastResults'];
}


export const MAX_RUN_NOTES = 1200;
export const MAX_USER_GUIDANCE = 1000;

/** One window drives a Mission at a time. */
export interface MissionLease {
  pid: number;
  token: string;
  at: number;
}
export type MissionTaskStatus = 'pending' | 'current' | 'completed';

export interface MissionTask {
  id: string;
  title: string;
  successCriterion: string;
  status: MissionTaskStatus;
  runs: number;
}

export interface MissionEvidence {
  taskId: string;
  /**
   * `action-started` is written before a tool runs and `action-finished`
   * after; a started action with no finished entry has an unknown result.
   */
  kind: 'host-record' | 'report' | 'interruption' | 'note' | 'action-started' | 'action-finished';
  text: string;
  at: number;
}

export interface MissionDecisionRef {
  key: string;
  version: number;
}

export interface MissionRecord {
  id: string;
  scopeId: string;
  scopeLabel: string;
  threadId: string;
  goal: string;
  status: MissionStatus;
  tasks: MissionTask[];
  /** Decisions in force (key, version) when each task run started. */
  decisionsUsed: MissionDecisionRef[];
  evidence: MissionEvidence[];
  taskRunsUsed: number;
  maxTaskRuns: number;
  /** Runs per task the user chose (missionProgress.ts runBudget); never raised. */
  runsPerTask?: number;
  createdAt: number;
  updatedAt: number;
  revision: number;
  /** Plain explanation of the latest state change. */
  note: string;
  grant: MissionGrant | null;
  auto: MissionAutoState | null;
  lease: MissionLease | null;
  /** The scaffold exists; nothing runs until the user reviews and authorizes its tests. */
  awaitingVerification?: true;
  /** Optional Meta review of the proposed bootstrap acceptance; advice only. */
  acceptanceReview?: MissionAcceptanceReview;
}

export type MissionResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface MissionBackend {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
  /** Optional machine-wide exclusive section for read-check-write updates. */
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
}

const STATUSES: readonly MissionStatus[] = ['active', 'waiting_approval', 'interrupted', 'completed', 'failed', 'paused', 'cancelled', 'blocked'];
const TASK_STATUSES: readonly MissionTaskStatus[] = ['pending', 'current', 'completed'];
const ID_PATTERN = /^mis_[0-9a-f]{24}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clean(text: string, max: number): string {
  return text.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseTask(raw: unknown): MissionTask | null {
  if (
    !isRecord(raw) ||
    !isBoundedString(raw.id, 64) ||
    raw.id.length === 0 ||
    !isBoundedString(raw.title, 300) ||
    !isBoundedString(raw.successCriterion, 300) ||
    !TASK_STATUSES.includes(raw.status as MissionTaskStatus) ||
    !isCount(raw.runs)
  ) {
    return null;
  }
  return { id: raw.id, title: raw.title, successCriterion: raw.successCriterion, status: raw.status as MissionTaskStatus, runs: raw.runs };
}

function parseGrant(raw: unknown, missionId: string, scopeId: string): MissionGrant | null | undefined {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (
    !isRecord(raw) ||
    raw.missionId !== missionId ||
    raw.scopeId !== scopeId ||
    (raw.provider !== 'local' && raw.provider !== 'cloud') ||
    !isBoundedString(raw.model, 128) ||
    (raw.mode !== 'supervised' && raw.mode !== 'autonomous-workspace') ||
    !isCount(raw.grantedAt) ||
    (raw.bootstrap !== undefined && raw.bootstrap !== true)
  ) {
    return undefined;
  }
  let escalation: MissionGrant['escalation'] = null;
  if (raw.escalation !== null && raw.escalation !== undefined) {
    const e = raw.escalation;
    if (
      !isRecord(e) ||
      !isBoundedString(e.model, 128) ||
      !(e.maxConsultations === null || (isCount(e.maxConsultations) && e.maxConsultations <= MAX_FINITE_CONSULTATIONS)) ||
      !isCount(e.maxOutputTokens) ||
      e.maxOutputTokens > 32768 ||
      storedAdvisoryLimits(e, e.maxConsultations) === null ||
      (e.sentBytes !== undefined && !isCount(e.sentBytes)) ||
      (e.usedTokens !== undefined && !isCount(e.usedTokens)) ||
      !isCount(e.used) ||
      (e.maxConsultations !== null && e.used > e.maxConsultations) ||
      (e.validResponses !== undefined && (!isCount(e.validResponses) || e.validResponses > e.used)) ||
      (e.dataClasses !== undefined && (!Array.isArray(e.dataClasses) || e.dataClasses.length > 8 || e.dataClasses.some((entry) => !isBoundedString(entry, 160)))) ||
      parseMetaBinding(e.preauth) === undefined
    ) {
      return undefined;
    }
    escalation = {
      model: e.model,
      maxConsultations: e.maxConsultations,
      ...(storedAdvisoryLimits(e, e.maxConsultations) as AdvisoryLimits),
      sentBytes: isCount(e.sentBytes) ? e.sentBytes : 0,
      usedTokens: isCount(e.usedTokens) ? e.usedTokens : 0,
      used: e.used,
      validResponses: isCount(e.validResponses) ? e.validResponses : 0,
      dataClasses: Array.isArray(e.dataClasses) ? (e.dataClasses as string[]) : [...ADVISORY_DATA_CLASSES],
      preauth: parseMetaBinding(e.preauth) ?? null,
    };
  }
  let tests: MissionGrant['tests'] = null;
  if (raw.tests !== null && raw.tests !== undefined) {
    const t = raw.tests;
    if (
      !isRecord(t) ||
      t.trustedProject !== true ||
      typeof t.packageJsonHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(t.packageJsonHash) ||
      !Array.isArray(t.commandIds) ||
      t.commandIds.length > 16 ||
      t.commandIds.some((id) => !isBoundedString(id, 128))
    ) {
      return undefined;
    }
    tests = { trustedProject: true, packageJsonHash: t.packageJsonHash, commandIds: [...(t.commandIds as string[])] };
  }
  const bootstrap = raw.bootstrap === true;
  if (raw.mode === 'autonomous-workspace' && tests === null && !bootstrap) {
    return undefined;
  }
  let acceptance: MissionGrant['acceptance'] = null;
  if (raw.acceptance !== null && raw.acceptance !== undefined) {
    const a = raw.acceptance;
    if (
      !isRecord(a) ||
      !isBoundedString(a.commandId, 128) ||
      a.commandId.length === 0 ||
      typeof a.packageJsonHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(a.packageJsonHash) ||
      !Array.isArray(a.files) ||
      a.files.length === 0 ||
      a.files.length > 20 ||
      a.files.some((f) => !isRecord(f) || !isBoundedString(f.path, 512) || typeof f.hash !== 'string' || !/^[0-9a-f]{64}$/.test(f.hash))
    ) {
      return undefined;
    }
    const scope = a.scope === undefined ? null : parseAcceptanceManifest(a.scope);
    const metrics = a.metrics === undefined ? null : parseMetricSpec(a.metrics);
    const references = a.references === undefined ? null : parseFrozenReferences(a.references);
    if (scope === undefined || metrics === undefined || references === undefined) {
      return undefined;
    }
    acceptance = {
      commandId: a.commandId,
      packageJsonHash: a.packageJsonHash,
      files: (a.files as Array<{ path: string; hash: string }>).map((f) => ({ path: f.path, hash: f.hash })),
      ...(scope === null ? {} : { scope }),
      ...(metrics === null ? {} : { metrics }),
      ...(references === null ? {} : { references }),
    };
  }
  if (bootstrap && acceptance !== null) {
    return undefined;
  }
  const web = parseMissionWebGrant(raw.web);
  if (web === undefined) {
    return undefined;
  }
  return {
    ...(web === null ? {} : { web }),
    missionId,
    scopeId,
    provider: raw.provider,
    model: raw.model,
    mode: raw.mode,
    grantedAt: raw.grantedAt,
    escalation,
    tests,
    acceptance,
    ...(bootstrap ? { bootstrap: true as const } : {}),
  };
}

function parseAuto(raw: unknown): MissionAutoState | null | undefined {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (
    !isRecord(raw) ||
    !isCount(raw.runs) ||
    !isCount(raw.startedAt) ||
    !isCount(raw.noProgressStreak) ||
    !isBoundedString(raw.lastSignature, 128) ||
    !isBoundedString(raw.lastProgress, MAX_EVIDENCE_TEXT) ||
    typeof raw.needsVerification !== 'boolean' ||
    !isBoundedString(raw.pendingAdvice, 4000) ||
    (raw.acceptanceFeedback !== undefined && !isBoundedString(raw.acceptanceFeedback, 2000)) ||
    (raw.lastRunNotes !== undefined && !isBoundedString(raw.lastRunNotes, MAX_RUN_NOTES)) ||
    (raw.userGuidance !== undefined && !isBoundedString(raw.userGuidance, MAX_USER_GUIDANCE))
  ) {
    return undefined;
  }
  const blockers = parseBlockingVerifiers(raw.blockers);
  const recoveries = parseVerifierRecoveries(raw.recoveries);
  if (blockers === undefined || recoveries === undefined) {
    return undefined;
  }
  return {
    runs: raw.runs,
    startedAt: raw.startedAt,
    noProgressStreak: raw.noProgressStreak,
    lastSignature: raw.lastSignature,
    lastProgress: raw.lastProgress,
    needsVerification: raw.needsVerification,
    pendingAdvice: raw.pendingAdvice,
    acceptanceFeedback: typeof raw.acceptanceFeedback === 'string' ? raw.acceptanceFeedback : '',
    lastRunNotes: typeof raw.lastRunNotes === 'string' ? raw.lastRunNotes : '',
    userGuidance: typeof raw.userGuidance === 'string' ? raw.userGuidance : '',
    ...parseProgressMemory(raw),
    blockers,
    recoveries,
  };
}

function parseLease(raw: unknown): MissionLease | null | undefined {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (!isRecord(raw) || !isCount(raw.pid) || !isBoundedString(raw.token, 64) || !isCount(raw.at)) {
    return undefined;
  }
  return { pid: raw.pid, token: raw.token, at: raw.at };
}

function parseMission(raw: unknown): MissionRecord | null {
  if (
    !isRecord(raw) ||
    typeof raw.id !== 'string' ||
    !ID_PATTERN.test(raw.id) ||
    !isBoundedString(raw.scopeId, 64) ||
    !isBoundedString(raw.scopeLabel, 128) ||
    !isBoundedString(raw.threadId, 128) ||
    !isBoundedString(raw.goal, MAX_GOAL_LENGTH) ||
    !STATUSES.includes(raw.status as MissionStatus) ||
    !Array.isArray(raw.tasks) ||
    raw.tasks.length === 0 ||
    raw.tasks.length > MAX_MISSION_TASKS ||
    !Array.isArray(raw.decisionsUsed) ||
    !Array.isArray(raw.evidence) ||
    !isCount(raw.taskRunsUsed) ||
    !isCount(raw.maxTaskRuns) ||
    !isCount(raw.createdAt) ||
    !isCount(raw.updatedAt) ||
    !isCount(raw.revision) ||
    !isBoundedString(raw.note, 500)
  ) {
    return null;
  }
  const tasks = raw.tasks.map(parseTask);
  if (tasks.some((task) => task === null)) {
    return null;
  }
  const current = (tasks as MissionTask[]).filter((task) => task.status === 'current').length;
  // Exactly one current task until every task is completed.
  const allDone = (tasks as MissionTask[]).every((task) => task.status === 'completed');
  if ((allDone && current !== 0) || (!allDone && current !== 1)) {
    return null;
  }
  const decisionsUsed: MissionDecisionRef[] = [];
  for (const entry of raw.decisionsUsed) {
    if (!isRecord(entry) || !isBoundedString(entry.key, 128) || !isCount(entry.version)) {
      return null;
    }
    decisionsUsed.push({ key: entry.key, version: entry.version });
  }
  const evidence: MissionEvidence[] = [];
  for (const entry of raw.evidence) {
    if (
      !isRecord(entry) ||
      !isBoundedString(entry.taskId, 64) ||
      !['host-record', 'report', 'interruption', 'note', 'action-started', 'action-finished'].includes(entry.kind as string) ||
      !isBoundedString(entry.text, MAX_EVIDENCE_TEXT) ||
      !isCount(entry.at)
    ) {
      return null;
    }
    evidence.push({ taskId: entry.taskId, kind: entry.kind as MissionEvidence['kind'], text: entry.text, at: entry.at });
  }
  // Optional R9 fields: absent in older Missions; present but invalid → unusable.
  const grant = parseGrant(raw.grant, raw.id, raw.scopeId);
  const auto = parseAuto(raw.auto);
  const lease = parseLease(raw.lease);
  const acceptanceReview = parseMissionAcceptanceReview(raw.acceptanceReview, raw.id, raw.scopeId);
  if (grant === undefined || auto === undefined || lease === undefined || acceptanceReview === undefined || (raw.awaitingVerification !== undefined && raw.awaitingVerification !== true)) {
    return null;
  }
  return {
    id: raw.id,
    scopeId: raw.scopeId,
    scopeLabel: raw.scopeLabel,
    threadId: raw.threadId,
    goal: raw.goal,
    status: raw.status as MissionStatus,
    tasks: tasks as MissionTask[],
    decisionsUsed,
    evidence,
    taskRunsUsed: raw.taskRunsUsed,
    maxTaskRuns: raw.maxTaskRuns,
    ...(validRunsPerTask(raw.runsPerTask) ? { runsPerTask: raw.runsPerTask } : {}),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    revision: raw.revision,
    note: raw.note,
    grant,
    auto,
    lease,
    ...(raw.awaitingVerification === true ? { awaitingVerification: true as const } : {}),
    ...(acceptanceReview === null ? {} : { acceptanceReview }),
  };
}

interface StoredMissions {
  schema: number;
  missions: unknown[];
}

export class MissionStore {
  constructor(
    private readonly backend: MissionBackend,
    private readonly now: () => number = Date.now,
  ) {}

  /** Raw list, or null when the stored blob is present but unreadable. */
  private readRaw(): StoredMissions | null {
    const raw = this.backend.get(MISSION_STATE_KEY);
    if (raw === undefined || raw === null) {
      return { schema: MISSION_SCHEMA, missions: [] };
    }
    if (!isRecord(raw) || raw.schema !== MISSION_SCHEMA || !Array.isArray(raw.missions)) {
      return null;
    }
    return { schema: MISSION_SCHEMA, missions: raw.missions };
  }

  isReadable(): boolean {
    return this.readRaw() !== null;
  }

  /** Readable missions (unreadable entries are skipped, never shown or used). */
  list(): MissionRecord[] {
    const state = this.readRaw();
    if (state === null) {
      return [];
    }
    return state.missions.map(parseMission).filter((mission): mission is MissionRecord => mission !== null);
  }

  get(id: string): MissionRecord | null {
    return this.list().find((mission) => mission.id === id) ?? null;
  }

  /** The newest Mission of a project that is not completed. */
  latestOpen(scopeId: string): MissionRecord | null {
    const open = this.list().filter((mission) => mission.scopeId === scopeId && mission.status !== 'completed');
    return open.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }

  private async locked<T>(work: () => Promise<MissionResult<T>>): Promise<MissionResult<T>> {
    if (!this.backend.exclusive) {
      return work();
    }
    try {
      return await this.backend.exclusive(work);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Missions are busy; try again.' };
    }
  }

  async create(options: {
    scopeId: string;
    scopeLabel: string;
    threadId: string;
    goal: string;
    steps: Array<{ id: string; title: string; successCriterion: string }>;
    decisions: MissionDecisionRef[];
  }): Promise<MissionResult<MissionRecord>> {
    return this.locked(() => this.createUnlocked(options));
  }

  private async createUnlocked(options: {
    scopeId: string;
    scopeLabel: string;
    threadId: string;
    goal: string;
    steps: Array<{ id: string; title: string; successCriterion: string }>;
    decisions: MissionDecisionRef[];
  }): Promise<MissionResult<MissionRecord>> {
    const state = this.readRaw();
    if (state === null) {
      return { ok: false, error: 'Stored Missions could not be read, so RAME Code will not write to them.' };
    }
    if (options.steps.length === 0 || options.steps.length > MAX_MISSION_TASKS) {
      return { ok: false, error: `A Mission needs 1 to ${MAX_MISSION_TASKS} tasks.` };
    }
    const now = this.now();
    const tasks: MissionTask[] = options.steps.map((step, index) => ({
      id: clean(step.id, 64) || `task-${index + 1}`,
      title: clean(step.title, 300),
      successCriterion: clean(step.successCriterion, 300),
      status: index === 0 ? 'current' : 'pending',
      runs: 0,
    }));
    const record: MissionRecord = {
      id: `mis_${randomBytes(12).toString('hex')}`,
      scopeId: options.scopeId.slice(0, 64),
      scopeLabel: options.scopeLabel.slice(0, 128),
      threadId: options.threadId.slice(0, 128),
      goal: clean(options.goal, MAX_GOAL_LENGTH),
      status: 'active',
      tasks,
      decisionsUsed: options.decisions.slice(0, 64).map((entry) => ({ key: entry.key, version: entry.version })),
      evidence: [],
      taskRunsUsed: 0,
      maxTaskRuns: Math.min(MAX_TASK_RUNS, tasks.length * TASK_RUNS_PER_TASK),
      createdAt: now,
      updatedAt: now,
      revision: 1,
      note: 'Mission created. Start the first task when you are ready.',
      grant: null,
      auto: null,
      lease: null,
    };
    // Keep the newest missions; unreadable entries are preserved as stored.
    const missions = [...state.missions, record].slice(-MAX_MISSIONS);
    await this.backend.update(MISSION_STATE_KEY, { schema: MISSION_SCHEMA, missions });
    return { ok: true, value: record };
  }

  /**
   * Apply one change to the Mission read at `expectedRevision`. Fails when
   * another window changed it meanwhile.
   */
  async update(
    id: string,
    expectedRevision: number,
    change: (mission: MissionRecord) => MissionResult<MissionRecord>,
  ): Promise<MissionResult<MissionRecord>> {
    return this.locked(() => this.updateUnlocked(id, expectedRevision, change));
  }

  private async updateUnlocked(
    id: string,
    expectedRevision: number,
    change: (mission: MissionRecord) => MissionResult<MissionRecord>,
  ): Promise<MissionResult<MissionRecord>> {
    const state = this.readRaw();
    if (state === null) {
      return { ok: false, error: 'Stored Missions could not be read, so RAME Code will not write to them.' };
    }
    const index = state.missions.findIndex((entry) => isRecord(entry) && entry.id === id);
    const current = index >= 0 ? parseMission(state.missions[index]) : null;
    if (current === null) {
      return { ok: false, error: 'That Mission no longer exists or could not be read.' };
    }
    if (current.revision !== expectedRevision) {
      return { ok: false, error: 'The Mission changed in another window; review it again before continuing.' };
    }
    const changed = change(structuredClone(current));
    if (!changed.ok) {
      return changed;
    }
    const next: MissionRecord = {
      ...changed.value,
      id: current.id,
      evidence: changed.value.evidence.slice(-MAX_MISSION_EVIDENCE),
      revision: current.revision + 1,
      updatedAt: this.now(),
    };
    const missions = [...state.missions];
    missions[index] = next;
    await this.backend.update(MISSION_STATE_KEY, { schema: MISSION_SCHEMA, missions });
    return { ok: true, value: next };
  }

  /**
   * After a reload: a Mission left `active` or `waiting_approval` belonged
   * to a run that is gone. Mark it interrupted; never re-run anything.
   */
  async recoverInterrupted(isLeaseAlive: (lease: MissionLease) => boolean = () => false): Promise<number> {
    let count = 0;
    for (const mission of this.list()) {
      if (mission.status !== 'active' && mission.status !== 'waiting_approval') {
        continue;
      }
      // A bootstrap Mission deliberately waits here for a second user
      // authorization. Reloading cannot turn that safe pause into a crash.
      if (mission.awaitingVerification === true) {
        continue;
      }
      // Another live window is driving it: that run is not lost.
      if (mission.lease !== null && isLeaseAlive(mission.lease)) {
        continue;
      }
      // Only a current task whose run had started lost a run; a Mission
      // waiting for the user to start its next task has nothing to recover.
      const started = (currentTask(mission)?.runs ?? 0) > 0;
      if (!started) {
        continue;
      }
      const uncertain = uncertainActions(mission);
      const reason =
        'RAME Code was reloaded while this task was running; nothing is repeated automatically.' +
        (uncertain.length > 0
          ? ` Uncertain: ${uncertain.join('; ')} started but its result was not recorded. Check the workspace before resuming.`
          : ' Review what ran, then resume the task.');
      const result = await this.update(mission.id, mission.revision, (draft) => interrupt(draft, reason, this.now()));
      if (result.ok) {
        count += 1;
      }
    }
    return count;
  }
}

/** Record that an action of the current task is about to run, or has finished. */
export function journalAction(
  mission: MissionRecord,
  phase: 'started' | 'finished',
  actionId: string,
  text: string,
  now: number,
): MissionResult<MissionRecord> {
  const task = currentTask(mission);
  if (task === null) {
    return { ok: false, error: 'This Mission has no current task.' };
  }
  mission.evidence.push(evidence(task.id, phase === 'started' ? 'action-started' : 'action-finished', `${actionId} ${text}`, now));
  return { ok: true, value: mission };
}

/** Actions of the current task that started but never recorded a result. */
export function uncertainActions(mission: MissionRecord): string[] {
  const task = currentTask(mission);
  if (task === null) {
    return [];
  }
  const entries = mission.evidence.filter((entry) => entry.taskId === task.id);
  const finished = new Set(
    entries.filter((entry) => entry.kind === 'action-finished').map((entry) => entry.text.split(' ')[0]),
  );
  return entries
    .filter((entry) => entry.kind === 'action-started' && !finished.has(entry.text.split(' ')[0]))
    .map((entry) => entry.text.split(' ').slice(1).join(' '));
}

export function currentTask(mission: MissionRecord): MissionTask | null {
  return mission.tasks.find((task) => task.status === 'current') ?? null;
}

/** Can the user start (or resume) a run of the current task now? */
export function canRunTask(mission: MissionRecord): MissionResult<MissionTask> {
  const task = currentTask(mission);
  if (mission.status === 'completed' || task === null) {
    return { ok: false, error: 'This Mission is completed.' };
  }
  if (mission.status === 'cancelled') {
    return { ok: false, error: 'This Mission was cancelled; create a new Mission to continue.' };
  }
  if (mission.status === 'failed') {
    return { ok: false, error: 'This Mission failed; create a new Mission to continue.' };
  }
  if (mission.status === 'waiting_approval') {
    return { ok: false, error: 'This Mission is waiting for an approval in its current run.' };
  }
  if (mission.awaitingVerification === true) {
    return { ok: false, error: 'Review the scaffolded project and authorize its verification stage before this Mission continues.' };
  }
  if (mission.taskRunsUsed >= mission.maxTaskRuns) {
    return { ok: false, error: `This Mission used all ${mission.maxTaskRuns} task runs of its budget.` };
  }
  return { ok: true, value: task };
}

export const ACCEPTANCE_CONTINUED = 'acceptance (continued): ';

/** Split a host note at spaces into evidence-sized parts (at most 4); rejoin with a space. */
export function splitHostNote(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0 && parts.length < 4) {
    const room = MAX_EVIDENCE_TEXT - (parts.length === 0 ? 0 : ACCEPTANCE_CONTINUED.length);
    if (rest.length <= room) {
      parts.push(rest);
      break;
    }
    const cut = rest.lastIndexOf(' ', room);
    const at = cut > room / 2 ? cut : room;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  return parts;
}

function evidence(taskId: string, kind: MissionEvidence['kind'], text: string, at: number): MissionEvidence {
  return { taskId, kind, text: clean(text, MAX_EVIDENCE_TEXT), at };
}

/** A run of the current task starts (counts against the budget). */
export function startTaskRun(mission: MissionRecord, decisions: MissionDecisionRef[], now: number): MissionResult<MissionRecord> {
  const allowed = canRunTask(mission);
  if (!allowed.ok) {
    return allowed;
  }
  const task = allowed.value;
  // Uncertain actions of an earlier run stay visible as such: they are
  // closed as "unknown", never as done, and the new run is told about them.
  for (const pending of mission.evidence.filter((entry) => entry.taskId === task.id && entry.kind === 'action-started')) {
    const id = pending.text.split(' ')[0] as string;
    const closed = mission.evidence.some((entry) => entry.kind === 'action-finished' && entry.text.split(' ')[0] === id);
    if (!closed) {
      mission.evidence.push(evidence(task.id, 'action-finished', `${id} result unknown (interrupted before it was recorded; carried into run ${task.runs + 1})`, now));
    }
  }
  task.runs += 1;
  mission.taskRunsUsed += 1;
  mission.status = 'active';
  const known = new Set(mission.decisionsUsed.map((entry) => `${entry.key}@${entry.version}`));
  for (const entry of decisions) {
    if (!known.has(`${entry.key}@${entry.version}`)) {
      mission.decisionsUsed.push({ key: entry.key, version: entry.version });
    }
  }
  mission.decisionsUsed = mission.decisionsUsed.slice(-64);
  mission.note = `Running task "${task.title}" (run ${task.runs}; ${mission.taskRunsUsed} of ${mission.maxTaskRuns} Mission runs used).`;
  return { ok: true, value: mission };
}

export function setWaiting(mission: MissionRecord, waiting: boolean): MissionResult<MissionRecord> {
  if (mission.status !== 'active' && mission.status !== 'waiting_approval') {
    return { ok: false, error: 'The Mission is not running.' };
  }
  mission.status = waiting ? 'waiting_approval' : 'active';
  return { ok: true, value: mission };
}

/** The run of the current task finished with a report: the task is done. */
export function completeTask(mission: MissionRecord, record: string[], report: string, now: number): MissionResult<MissionRecord> {
  const task = currentTask(mission);
  if (task === null) {
    return { ok: false, error: 'This Mission has no current task.' };
  }
  task.status = 'completed';
  for (const line of record.slice(0, 12)) {
    mission.evidence.push(evidence(task.id, 'host-record', line, now));
  }
  mission.evidence.push(evidence(task.id, 'report', report, now));
  const next = mission.tasks.find((entry) => entry.status === 'pending');
  if (mission.auto !== null) {
    // Each task needs its own passing test; the no-progress count restarts.
    mission.auto.needsVerification = true;
    mission.auto.noProgressStreak = 0;
    mission.auto.pendingAdvice = '';
    mission.auto.acceptanceFeedback = '';
    // lastRunNotes stay: they are labeled with their task, and the next task
    // needs what the last run found, since earlier runs are not replayed.
  }
  if (next) {
    next.status = 'current';
    mission.status = 'active';
    mission.note = `Task "${task.title}" completed. Next: "${next.title}". Start it when you are ready.`;
  } else {
    mission.status = 'completed';
    mission.note = `All ${mission.tasks.length} tasks completed.`;
  }
  return { ok: true, value: mission };
}

/** The run ended without completing the task (cancel, reject, stop, error). */
export function interrupt(mission: MissionRecord, reason: string, now: number, record: string[] = []): MissionResult<MissionRecord> {
  const task = currentTask(mission);
  if (task === null) {
    return { ok: false, error: 'This Mission has no current task.' };
  }
  for (const line of record.slice(0, 12)) {
    mission.evidence.push(evidence(task.id, 'host-record', line, now));
  }
  mission.evidence.push(evidence(task.id, 'interruption', reason, now));
  if (mission.taskRunsUsed >= mission.maxTaskRuns) {
    mission.status = 'failed';
    mission.note = `${clean(reason, 200)} The Mission used all ${mission.maxTaskRuns} task runs of its budget, so it stopped.`;
  } else {
    mission.status = 'interrupted';
    mission.note = clean(reason, 300);
  }
  return { ok: true, value: mission };
}

/** Prompt for one task run: goal, progress, evidence, and the resume rule. */
export function buildTaskPrompt(mission: MissionRecord, options: { autonomous?: boolean } = {}): string {
  const task = currentTask(mission);
  const done = mission.tasks.filter((entry) => entry.status === 'completed').map((entry) => `- ${entry.title}`);
  const pending = mission.tasks.filter((entry) => entry.status === 'pending').map((entry) => `- ${entry.title}`);
  const earlier = mission.evidence.filter((entry) => entry.taskId === task?.id).slice(-12).map((entry) => `- ${entry.text}`);
  const resumed = task !== null && task.runs > 0;
  const parts = [
    `Mission goal: ${mission.goal}`,
    `Current task: ${task?.title ?? '(none)'}`,
    `Done when: ${task?.successCriterion ?? ''}`,
    `Completed tasks:\n${done.length > 0 ? done.join('\n') : '- none'}`,
    `Later tasks (do not start them now):\n${pending.length > 0 ? pending.join('\n') : '- none'}`,
  ];
  const uncertain = uncertainActions(mission);
  if (uncertain.length > 0) {
    parts.push(
      'UNCERTAIN: these actions started but their result was never recorded, so they may or may not have taken effect:\n' +
        uncertain.map((entry) => `- ${entry}`).join('\n') +
        '\nCheck the current state of every affected file before doing anything else.',
    );
  }
  if (resumed && options.autonomous === true) {
    // Autonomous runs after a run without progress get the host's
    // operational summary instead; telling them to inspect again only
    // repeated the exploration.
    if ((mission.auto?.noProgressStreak ?? 0) === 0) {
      parts.push(
        'This task was started before and did not finish. What RAME Code recorded for it:\n' +
          (earlier.length > 0 ? earlier.join('\n') : '- nothing recorded') +
          '\nContinue from there and do not repeat an action that already took effect. To change a file, read only that file for its exact current text and sha256.',
      );
    }
  } else if (resumed) {
    parts.push(
      'This task was started before and did not finish. What RAME Code recorded for it:\n' +
        (earlier.length > 0 ? earlier.join('\n') : '- nothing recorded') +
        '\nInspect the current files before changing anything, and do not repeat an action that already took effect.',
    );
  }
  parts.push('Work only on the current task, then give the required final report.');
  return parts.join('\n\n').slice(0, 7500);
}

// ----- Autonomy (R9): grant, controls, progress, and verification -----

/** The user authorizes this Mission once; a new grant replaces the old one. */
export function grantMission(
  mission: MissionRecord,
  grant: {
    /** Omitted: local (records before Meta could be a Mission's main model). */
    provider?: MissionGrant['provider'];
    model: string;
    mode: MissionGrant['mode'];
    escalation: ({ model: string; maxConsultations: number | null; preauth?: MetaBinding | null } & AdvisoryLimits) | null;
    /** Autonomous only: the user marked the project trusted; the test commands and the package.json they come from. */
    tests: { trustedProject: boolean; packageJsonHash: string; commandIds: string[] } | null;
    /** The user's frozen acceptance check, or null for none. */
    acceptance?: { commandId: string; packageJsonHash: string; files: Array<{ path: string; hash: string }>; scope?: AcceptanceManifest; metrics?: MetricSpec; references?: FrozenReference[] } | null;
    /** Empty-project first stage; never carries tests or frozen acceptance. */
    bootstrap?: boolean;
    /** Runs per task chosen by the user (1 to 8). */
    runsPerTask?: number;
    /** Web access the user chose for this Mission, validated (null = off). */
    web?: MissionWebGrant | null;
  },
  now: number,
): MissionResult<MissionRecord> {
  if (mission.status === 'completed' || mission.status === 'cancelled' || mission.status === 'failed') {
    return { ok: false, error: 'This Mission has ended; create a new Mission to continue.' };
  }
  if (grant.model.length === 0 || grant.model.length > 128) {
    return { ok: false, error: 'The Mission grant needs the local model id.' };
  }
  const bootstrap = grant.bootstrap === true;
  if (grant.mode === 'autonomous-workspace' && (grant.tests === null || grant.tests.trustedProject !== true)) {
    return {
      ok: false,
      error: 'Autonomous workspace is only for a project you mark as trusted: its test scripts run with your permissions and RAME Code is not an operating-system sandbox.',
    };
  }
  if (!bootstrap && grant.tests !== null && !/^[0-9a-f]{64}$/.test(grant.tests.packageJsonHash)) {
    return { ok: false, error: 'Autonomous workspace needs a readable package.json to bind its test commands to.' };
  }
  const acceptance = grant.acceptance ?? null;
  if (bootstrap && acceptance !== null) {
    return { ok: false, error: 'A bootstrap Mission cannot freeze tests that do not exist yet. Review and authorize them in the second stage.' };
  }
  if (
    acceptance !== null &&
    (acceptance.commandId.length === 0 ||
      !/^[0-9a-f]{64}$/.test(acceptance.packageJsonHash) ||
      acceptance.files.length === 0 ||
      acceptance.files.length > 20 ||
      acceptance.files.some((file) => !/^[0-9a-f]{64}$/.test(file.hash)))
  ) {
    return { ok: false, error: 'The acceptance check needs an allowlisted command and 1 to 20 existing files to freeze.' };
  }
  if (acceptance?.metrics !== undefined && parseMetricSpec(acceptance.metrics) === undefined) {
    return { ok: false, error: 'The metric criteria of the acceptance check are not valid.' };
  }
  const escalation = grant.escalation;
  if (escalation !== null && escalation.maxConsultations === null && !escalation.preauth) {
    return { ok: false, error: 'A Mission without a count limit on Meta consultations needs a Meta pre-authorization that allows it.' };
  }
  if (escalation !== null && escalation.maxConsultations !== null && (escalation.maxConsultations < 1 || escalation.maxConsultations > MAX_FINITE_CONSULTATIONS)) {
    return { ok: false, error: `Mission escalation allows 1 to ${MAX_FINITE_CONSULTATIONS} consultations, or no count limit under a pre-authorization.` };
  }
  if (escalation !== null && grant.provider === 'cloud' && escalation.model === grant.model) {
    return { ok: false, error: 'The advisor cannot be the Mission\'s main model itself.' };
  }
  const limitError = escalation === null ? null : checkAdvisoryLimits(escalation);
  if (limitError !== null) {
    return { ok: false, error: limitError };
  }
  mission.grant = {
    missionId: mission.id,
    scopeId: mission.scopeId,
    provider: grant.provider ?? 'local',
    model: grant.model,
    mode: grant.mode,
    grantedAt: now,
    escalation:
      escalation === null
        ? null
        : { ...escalation, used: 0, validResponses: 0, dataClasses: [...ADVISORY_DATA_CLASSES, ...(escalation.preauth?.files.length ? [`files you chose: ${escalation.preauth.files.map(describeScopedFile).join(', ')}`.slice(0, 160)] : [])], sentBytes: 0, usedTokens: 0 },
    tests:
      !bootstrap && grant.mode === 'autonomous-workspace' && grant.tests !== null
        ? { trustedProject: true, packageJsonHash: grant.tests.packageJsonHash, commandIds: grant.tests.commandIds.slice(0, 16) }
        : null,
    acceptance:
      acceptance === null
        ? null
        : {
            commandId: acceptance.commandId,
            packageJsonHash: acceptance.packageJsonHash,
            files: acceptance.files.map((file) => ({ path: file.path, hash: file.hash })),
            ...(acceptance.scope ? { scope: copyManifest(acceptance.scope) } : {}),
            ...(acceptance.metrics ? { metrics: copyMetricSpec(acceptance.metrics) } : {}),
            ...(acceptance.references ? { references: copyFrozenReferences(acceptance.references) } : {}),
          },
    ...(bootstrap ? { bootstrap: true as const } : {}),
    ...(grant.web ? { web: { ...grant.web, domains: [...grant.web.domains], searches: 0, fetches: 0 } } : {}),
  };
  delete mission.awaitingVerification;
  // Keep the review as evidence of what the user considered, but it cannot
  // alter the grant or the hashes frozen below.
  const budget = runBudget({ mode: grant.mode, chosen: grant.runsPerTask, stored: mission.runsPerTask, tasks: mission.tasks.length, current: mission.maxTaskRuns });
  if (!budget.ok) {
    return { ok: false, error: budget.error };
  }
  mission.maxTaskRuns = budget.maxTaskRuns;
  if (budget.runsPerTask !== undefined) {
    mission.runsPerTask = budget.runsPerTask;
  }
  mission.auto = {
    runs: 0,
    startedAt: now,
    noProgressStreak: 0,
    lastSignature: mission.auto?.lastSignature ?? '',
    lastProgress: mission.auto?.lastProgress ?? '',
    needsVerification: mission.auto?.needsVerification ?? true,
    pendingAdvice: '',
    acceptanceFeedback: '',
    lastRunNotes: '',
    userGuidance: '',
    blockers: mission.auto?.blockers ?? [],
    recoveries: mission.auto?.recoveries ?? [],
    fileState: { ...(mission.auto?.fileState ?? {}) },
    seenStates: [...(mission.auto?.seenStates ?? [])],
    lastResults: { ...(mission.auto?.lastResults ?? {}) },
  };
  mission.note = bootstrap
    ? `Bootstrap stage authorized (${grant.mode === 'autonomous-workspace' ? 'autonomous workspace' : 'supervised'}, ${grant.provider === 'cloud' ? 'Meta' : 'local'} ${grant.model}). RAME Code may scaffold the project, but it cannot run tests or complete the Mission before a second authorization.`
    : `Mission authorized (${grant.mode === 'autonomous-workspace' ? 'autonomous workspace' : 'supervised'}, ${grant.provider === 'cloud' ? 'Meta' : 'local'} ${grant.model}${escalation ? (escalation.maxConsultations === null ? ', Meta consultations with no count limit' : `, up to ${escalation.maxConsultations} Meta consultation(s)`) : ', no escalation'}; ${describeMissionWeb(grant.web)}).`;
  return { ok: true, value: mission };
}

/** Why a test does not run in an empty-project Mission's first stage (shown to the model, the host record and the user). */
export const BOOTSTRAP_TESTS_WAIT = 'tests wait for the verification stage: this Mission started in an empty project, so you review the new test command and test files and authorize them before any test runs.';

/**
 * The first stage cannot continue usefully: a test was asked for but the
 * scaffold is not yet reviewable. Stop and say exactly what is missing,
 * instead of spending more internal runs. Nothing is authorized here.
 */
export function bootstrapNeedsUser(mission: MissionRecord, missing: { testScript: boolean; testFile: boolean }, now: number): MissionResult<MissionRecord> {
  const what = [
    missing.testScript ? 'a "test" script in package.json' : '',
    missing.testFile ? 'a test file RAME can show you for review (named like *.test.js or test_*.js, inside test/, or named by the "test" script)' : '',
  ].filter(Boolean).join(' and ');
  return blockMission(
    mission,
    `The scaffold is not ready for review: it still needs ${what || 'its test files'}. Tests only run after you review and authorize them, so the Mission stopped instead of retrying. Add what is missing (or ask Agent to), then resume.`,
    now,
  );
}

/**
 * End an empty-project bootstrap as soon as verifiable tests exist. The
 * first grant is revoked; the newly created files are not trusted or frozen
 * until the user explicitly authorizes the second stage.
 */
export function awaitBootstrapVerification(
  mission: MissionRecord,
  testCommands: readonly string[],
  candidates: readonly string[],
  now: number,
): MissionResult<MissionRecord> {
  if (mission.grant?.bootstrap !== true) {
    return { ok: false, error: 'This Mission is not in its bootstrap stage.' };
  }
  if (testCommands.length === 0 || candidates.length === 0) {
    return { ok: false, error: 'The bootstrap stage has not produced both an allowlisted test command and a reviewable test file.' };
  }
  const task = currentTask(mission);
  if (task === null) {
    return { ok: false, error: 'This Mission has no current task.' };
  }
  mission.evidence.push(
    evidence(
      task.id,
      'note',
      `bootstrap scaffold ready: review ${testCommands.slice(0, 4).join(', ')} and ${candidates.slice(0, 6).join(', ')} before verification authorization`,
      now,
    ),
  );
  mission.grant = null;
  mission.awaitingVerification = true;
  delete mission.acceptanceReview;
  mission.status = 'active';
  mission.note = 'Scaffold created. Review the new test command and files, then authorize the verification stage. Nothing runs until you do.';
  return { ok: true, value: mission };
}

/**
 * Whether this Mission's grant runs `tool` without a card. The grant must be
 * autonomous and bound to this very Mission, project, provider, and model.
 */
export function grantAllows(
  mission: MissionRecord | null,
  context: { missionId: string; scopeId: string; provider: string; model: string },
  tool: string,
  test?: { commandId: string; packageJsonHash: string },
): boolean {
  const grant = mission?.grant;
  if (tool === 'run_tests') {
    // Only the exact commands granted, and only while package.json is the one granted.
    const tests = grant?.tests ?? null;
    if (tests === null || test === undefined || !tests.commandIds.includes(test.commandId) || tests.packageJsonHash !== test.packageJsonHash) {
      return false;
    }
  }
  return (
    mission !== null &&
    grant !== null &&
    grant !== undefined &&
    grant.mode === 'autonomous-workspace' &&
    grant.missionId === mission.id &&
    mission.id === context.missionId &&
    grant.scopeId === mission.scopeId &&
    grant.scopeId === context.scopeId &&
    grant.provider === context.provider &&
    grant.model === context.model &&
    (mission.status === 'active' || mission.status === 'waiting_approval') &&
    // Web tools only with this grant's web budget (counted by the host before each request).
    (AUTONOMOUS_TOOLS.includes(tool) || ((tool === 'web_search' || tool === 'web_fetch') && grant.web !== undefined))
  );
}

export function pauseMission(mission: MissionRecord, now: number): MissionResult<MissionRecord> {
  if (!['active', 'waiting_approval', 'interrupted', 'blocked'].includes(mission.status)) {
    return { ok: false, error: 'Only a running, interrupted, or blocked Mission can be paused.' };
  }
  mission.status = 'paused';
  mission.note = 'Paused by you. Nothing runs until you resume it.';
  const task = currentTask(mission);
  if (task) {
    mission.evidence.push(evidence(task.id, 'note', 'paused by the user', now));
  }
  return { ok: true, value: mission };
}

export function cancelMission(mission: MissionRecord, now: number): MissionResult<MissionRecord> {
  if (mission.status === 'completed' || mission.status === 'cancelled') {
    return { ok: false, error: 'This Mission has already ended.' };
  }
  mission.status = 'cancelled';
  mission.note = 'Cancelled by you. It will not run again.';
  mission.lease = null;
  const task = currentTask(mission);
  if (task) {
    mission.evidence.push(evidence(task.id, 'note', 'cancelled by the user', now));
  }
  return { ok: true, value: mission };
}

export function blockMission(mission: MissionRecord, reason: string, now: number): MissionResult<MissionRecord> {
  if (mission.status === 'completed' || mission.status === 'cancelled') {
    return { ok: false, error: 'This Mission has already ended.' };
  }
  mission.status = 'blocked';
  mission.note = clean(`Blocked: ${reason}`, 500);
  const task = currentTask(mission);
  if (task) {
    mission.evidence.push(evidence(task.id, 'note', `blocked: ${reason}`, now));
  }
  return { ok: true, value: mission };
}

/** What the host saw in one internal run (never the model's claims). */
export interface RunObservation {
  outcome: string;
  /** Files written in the run, with their hash now (null = missing). */
  writes: Array<{ path: string; hash: string | null }>;
  lastTest: { commandId: string; exitCode: number | null } | null;
  /** A write happened after the last test of the run (or no test ran after a write). */
  wroteAfterLastTest: boolean;
  /** Actions that started but never recorded a result. */
  uncertain: number;
  hostRecord: string[];
  /** The agent's final report of the run, if it wrote one. */
  report?: string;
  /** Read-only calls in the run that returned exactly what an earlier call had. */
  repeatedReads?: number;
  /** The last result of each test command in the run. */
  verifiers?: VerifierResult[];
  /** Hash of the manifest the tests ran against, at the end of the run. */
  conditions?: string;
}

export interface RunAssessment {
  progress: boolean;
  /** The current task still needs a passing test after its last change. */
  needs: boolean;
  /** Host evidence: a passing test after the last change, nothing uncertain, and the run reported done. */
  verified: boolean;
  /** Everything else would verify the task, but a blocking verifier is still open. */
  blockedByVerifier: boolean;
  /** Blocking verifiers after this run, and what changed. */
  verifierUpdate: VerifierUpdate;
  signature: string;
  summary: string;
  /** The progress memory after this run (recordRun stores it). */
  memory?: ProgressMemory;
}

/**
 * Judge one internal run from host data. Progress means the host-derived
 * state changed (file hashes, test result, verification); reading alone is
 * not progress. A task is verified only when an allowlisted test passed
 * after its last change, nothing is uncertain, and the run reported done.
 */
export function assessRun(mission: MissionRecord, observation: RunObservation): RunAssessment {
  const auto = mission.auto;
  const task = currentTask(mission);
  let needs = auto?.needsVerification ?? true;
  if (observation.writes.length > 0) {
    needs = true;
  }
  if (observation.lastTest !== null) {
    needs = !(observation.lastTest.exitCode === 0 && !observation.wroteAfterLastTest);
  }
  const signature = createHash('sha256')
    .update(
      JSON.stringify({
        task: task?.id ?? '',
        writes: [...observation.writes].sort((a, b) => a.path.localeCompare(b.path)),
        test: observation.lastTest,
        needs,
      }),
    )
    .digest('hex');
  // Only a demonstrable improvement in a new file state is progress (missionProgress.ts).
  const measured = measureProgress(auto, observation);
  // A test that failed blocks every task until that same test passes again.
  const verifierUpdate = updateVerifiers(auto?.blockers ?? [], auto?.recoveries ?? [], observation.verifiers ?? [], observation.conditions ?? '', (auto?.runs ?? 0) + 1, 'agent', mission.id);
  const cleanRun = observation.outcome === 'done' && observation.uncertain === 0 && !needs;
  const verified = cleanRun && verifierUpdate.blockers.length === 0;
  const parts: string[] = [];
  if (observation.writes.length > 0) {
    parts.push(`changed ${observation.writes.map((entry) => entry.path).slice(0, 6).join(', ')}`);
  }
  if (observation.lastTest !== null) {
    parts.push(`${observation.lastTest.commandId} exit=${observation.lastTest.exitCode ?? 'unknown'}`);
  }
  if (verifierUpdate.blockers.length > 0) {
    parts.push(`blocking: ${verifierUpdate.blockers.map((blocker) => blocker.commandId).join(', ')}`);
  }
  const summary = parts.length > 0 ? parts.join('; ') : 'no file change and no test';
  const recovered = verifierUpdate.blockers.length < (auto?.blockers ?? []).length;
  const progress = (measured.improved || recovered) && measured.newState;
  return { progress, needs, verified, blockedByVerifier: cleanRun && !verified, verifierUpdate, signature, summary, memory: measured.memory };
}


/**
 * Record the host's own re-run of the open blocking verifiers after a run
 * that was otherwise verified. Returns whether every blocker recovered.
 */
export function recordVerifierRecheck(
  mission: MissionRecord,
  results: ReadonlyArray<{ commandId: string; exitCode: number | null }>,
  conditions: string,
  now: number,
): MissionResult<{ mission: MissionRecord; cleared: boolean }> {
  const task = currentTask(mission);
  if (task === null || mission.auto === null) {
    return { ok: false, error: 'This Mission has no current task.' };
  }
  for (const result of results) {
    mission.evidence.push(evidence(task.id, 'host-record', `• run_tests ${result.commandId} → exit=${result.exitCode ?? 'unknown'} (re-run by the host: blocking verifier)`, now));
  }
  const update = updateVerifiers(
    mission.auto.blockers,
    mission.auto.recoveries,
    results.map((result) => ({ ...result, afterLastWrite: true })),
    conditions,
    mission.auto.runs,
    'host',
    mission.id,
  );
  mission.auto.blockers = update.blockers;
  mission.auto.recoveries = update.recoveries;
  for (const note of update.notes) {
    mission.evidence.push(evidence(task.id, 'note', note, now));
  }
  return { ok: true, value: { mission, cleared: update.blockers.length === 0 } };
}

/** Record one internal run's outcome in the checkpoint and decide what comes next. */
export function recordRun(
  mission: MissionRecord,
  observation: RunObservation,
  assessment: RunAssessment,
  now: number,
): MissionResult<{ mission: MissionRecord; next: 'complete-task' | 'continue' | 'blocked' }> {
  const task = currentTask(mission);
  if (task === null || mission.auto === null) {
    return { ok: false, error: 'This Mission has no current task.' };
  }
  const auto = mission.auto;
  auto.runs += 1;
  auto.needsVerification = assessment.needs;
  auto.lastSignature = assessment.signature;
  if (assessment.memory !== undefined) {
    auto.fileState = assessment.memory.fileState;
    auto.seenStates = assessment.memory.seenStates;
    auto.lastResults = assessment.memory.lastResults;
  }
  if (assessment.progress) {
    auto.noProgressStreak = 0;
    auto.lastProgress = clean(`run ${auto.runs}: ${assessment.summary}`, MAX_EVIDENCE_TEXT);
  } else {
    auto.noProgressStreak += 1;
  }
  for (const line of observation.hostRecord.slice(0, 14)) {
    mission.evidence.push(evidence(task.id, 'host-record', line, now));
  }
  const repeats = observation.repeatedReads ?? 0;
  mission.evidence.push(
    evidence(
      task.id,
      'note',
      `internal run ${auto.runs} (${observation.outcome}): ${assessment.summary}${assessment.progress ? '' : ' — no verifiable progress'}${repeats > 0 ? `; ${repeats} repeated read(s) without new information` : ''}`,
      now,
    ),
  );
  auto.blockers = assessment.verifierUpdate.blockers;
  auto.recoveries = assessment.verifierUpdate.recoveries;
  for (const note of assessment.verifierUpdate.notes) {
    mission.evidence.push(evidence(task.id, 'note', note, now));
  }
  const report = clean(observation.report ?? '', MAX_RUN_NOTES);
  const notes = report.length > 0 ? clean(`[internal run ${auto.runs}, task "${task.title}"] ${report}`, MAX_RUN_NOTES) : '';
  auto.lastRunNotes = notes;
  if (report.length > 0) {
    // Kept on this machine too, so a run can be reviewed after the fact.
    mission.evidence.push(evidence(task.id, 'report', `internal run ${auto.runs} report: ${report}`, now));
  }
  if (assessment.verified) {
    return { ok: true, value: { mission, next: 'complete-task' } };
  }
  if (auto.noProgressStreak >= MAX_NO_PROGRESS_RUNS) {
    return { ok: true, value: { mission, next: 'blocked' } };
  }
  if (task.runs >= (mission.runsPerTask ?? MAX_AUTO_RUNS_PER_TASK) || mission.taskRunsUsed >= mission.maxTaskRuns) {
    return { ok: true, value: { mission, next: 'blocked' } };
  }
  return { ok: true, value: { mission, next: 'continue' } };
}

/** Files the current task already read, from the host record (to avoid re-exploring). */
/** Files read by any internal run of this Mission, oldest first. */
export function filesReadInMission(mission: MissionRecord): string[] {
  const seen = new Set<string>();
  for (const entry of mission.evidence) {
    const match = entry.kind === 'host-record' ? /^•?\s*read_file (\S+) →/.exec(entry.text) : null;
    if (match) {
      seen.add(match[1] as string);
    }
  }
  return [...seen].slice(0, 20);
}

export function filesAlreadyRead(mission: MissionRecord): string[] {
  const task = currentTask(mission);
  if (task === null) {
    return [];
  }
  const seen = new Set<string>();
  for (const entry of mission.evidence) {
    if (entry.taskId === task.id && entry.kind === 'host-record') {
      const match = /^•?\s*read_file (\S+) →/.exec(entry.text);
      if (match) {
        seen.add(match[1] as string);
      }
    }
  }
  return [...seen].slice(0, 20);
}


const READ_ONLY_RECORD = /^•?\s*(list_files|inspect_workspace|filesystem_usage|search_text|read_file|read_decisions)\b/;

/**
 * Read-only actions the current task already repeated with the same result
 * line, as "tool target ×n". Without progress between runs nothing changed,
 * so a repeat brought no new information.
 */
export function repeatedReads(mission: MissionRecord): string[] {
  const task = currentTask(mission);
  if (task === null) {
    return [];
  }
  const counts = new Map<string, number>();
  for (const entry of mission.evidence) {
    if (entry.taskId === task.id && entry.kind === 'host-record' && READ_ONLY_RECORD.test(entry.text)) {
      const key = entry.text.replace(/^•\s*/, '').split(' → ')[0] as string;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key, count]) => `${key} ×${count}`).slice(0, 12);
}

export function leaseHeldByOther(
  mission: MissionRecord,
  token: string,
  isAlive: (lease: MissionLease) => boolean,
): boolean {
  return mission.lease !== null && mission.lease.token !== token && isAlive(mission.lease);
}

/** Paths no tool may change while this Mission has a frozen acceptance check. */
export function frozenPaths(mission: MissionRecord | null): string[] {
  const acceptance = mission?.grant?.acceptance ?? null;
  // A sealed folder is listed with a trailing '/': nothing may be added, changed or removed in it.
  return acceptance === null ? [] : [...acceptance.files.map((file) => file.path), 'package.json', ...(acceptance.scope?.sealed ?? []).map((dir) => `${dir}/`)];
}

/**
 * Record the host's own run of the acceptance check. A failure keeps the
 * current task open (it needs a passing test again) and counts as no
 * progress, so failing again and again still ends as blocked.
 */
export function recordAcceptance(
  mission: MissionRecord,
  result: { passed: boolean; summary: string; output: string },
  now: number,
): MissionResult<{ mission: MissionRecord; next: 'complete-task' | 'continue' | 'blocked' }> {
  const task = currentTask(mission);
  if (task === null || mission.auto === null) {
    return { ok: false, error: 'This Mission has no current task.' };
  }
  // A long host record (levels, differences, host record) continues in up to 3 more notes, never cut short.
  splitHostNote(`acceptance (run by the host): ${clean(result.summary, 1200)}`).forEach((part, index) => mission.evidence.push(evidence(task.id, 'note', index === 0 ? part : `${ACCEPTANCE_CONTINUED}${part}`, now)));
  if (result.passed) {
    mission.auto.acceptanceFeedback = '';
    return { ok: true, value: { mission, next: 'complete-task' } };
  }
  mission.auto.needsVerification = true;
  mission.auto.noProgressStreak += 1;
  mission.auto.acceptanceFeedback =
    `ACCEPTANCE FAILED: the host ran the user's frozen acceptance check and it did not pass (${clean(result.summary, 900)}). Output (bounded):\n` +
    result.output.slice(-1500) +
    '\nFix the code so this check passes; do not change the acceptance files.';
  if (mission.auto.noProgressStreak >= MAX_NO_PROGRESS_RUNS) {
    return { ok: true, value: { mission, next: 'blocked' } };
  }
  return { ok: true, value: { mission, next: 'continue' } };
}
