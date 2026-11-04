/**
 * Mission coordinator: persistent-goal lifecycle extracted from
 * mainProvider. Each function receives {@link ProviderHost} as its
 * first parameter, avoiding circular imports and keeping the module
 * free of the vscode API.
 */

import { hashContent } from './agentPatch.js';
import { checkAgentRelPath } from './agentPolicy.js';
import {
  buildConsultPayload,
  cascadeAdviceSchema,
  formatAdvisory,
  validateCascadeAdvice,
} from './cascade.js';
import { currentFileHash } from './agentController.js';
import type { AcceptanceManifest } from './acceptanceManifest.js';
import { runAcceptance } from './acceptanceRun.js';
import { protectAcceptanceScope } from './acceptanceScopeHost.js';
import { CASES_FILE, parseCasesSpec } from './hostCases.js';
import { memoryScopeForUi } from './memoryController.js';
import {
  assessRun,
  awaitBootstrapVerification,
  blockMission,
  buildAutoTaskPrompt,
  buildTaskPrompt,
  canRunTask,
  cancelMission,
  completeTask,
  currentTask,
  filesReadInMission,
  frozenPaths,
  grantAllows,
  grantMission,
  interrupt,
  leaseHeldByOther,
  MAX_NO_PROGRESS_RUNS,
  MAX_USER_GUIDANCE,
  pauseMission,
  recordAcceptance,
  recordVerifierRecheck,
  recordRun,
  startTaskRun,
  uncertainActions,
} from './missionStore.js';
import {
  MISSION_CONSULT_OUTPUT_TOKENS,
  registerLiveMissionLease,
  unregisterLiveMissionLease,
} from './missionRuntime.js';
import { buildMissionReportEntry } from './missionReport.js';
import { missionEvidenceLines } from './modelEvidence.js';
import { consultForMission } from './missionAdvice.js';
import { chooseAdvisoryLimits, type ChosenAdvisoryLimits } from './missionAdvisoryLimits.js';
import { markUnrecoverable } from './missionVerifiers.js';
import {
  buildMissionLiveView,
  buildMissionView,
  buildPlanningMissionLiveView,
} from './missionViews.js';
import { ACCEPTANCE_ENVIRONMENT_FILES, listAcceptanceCandidates } from './projectAdapters/npmProjectAdapter.js';
import { createCascadeAdvice } from './meta-provider.js';
import { providerToRuntime } from './settingsStore.js';
import { appendHostNoteTurn } from './threadStore.js';
import { redactKeyFromText } from './webviewMessages.js';

import type { AgentFs } from './agentHost.js';
import type {
  MissionGrant,
  MissionRecord,
  MissionResult,
  RunAssessment,
  RunObservation,
} from './missionStore.js';
import type { MissionViewRuntime } from './missionViews.js';
import type { MissionPlan } from './types.js';
import type { AgentOutcomeRecord, ProviderHost } from './providerTypes.js';
import type { MissionLiveView, MissionView } from './viewMessages.js';

// ---- Module-level state -----------------------------------------------------

/**
 * Serialization chain for active-mission updates so each one reads the
 * revision the previous one wrote; none can be lost to a race.
 */
let missionUpdates: Promise<void> = Promise.resolve();

// ---- Mission lifecycle ------------------------------------------------------

/** A strict Mission plan becomes a persistent Mission of the project. */
export async function createMissionFromPlan(
  host: ProviderHost,
  threadId: string,
  plan: MissionPlan,
): Promise<void> {
  const scope = await memoryScopeForUi(host);
  if (!scope.ok) {
    host.status = `${host.status} The plan was not saved as a Mission: ${scope.error}`;
    return;
  }
  const created = await host.missions.create({
    scopeId: scope.scopeId,
    scopeLabel: scope.label,
    threadId,
    goal: plan.goal,
    steps: plan.steps.map((step) => ({ id: step.id, title: step.title, successCriterion: step.successCriterion })),
    decisions: host.memory.listCurrentDecisions(scope.scopeId).map((entry) => ({ key: entry.key, version: entry.version })),
  });
  host.status = created.ok
    ? `${host.status} Saved as a Mission with ${created.value.tasks.length} task(s); review it and authorize it in the Mission card of this thread.`
    : `${host.status} The plan was not saved as a Mission: ${created.error}`;
}

/**
 * Updates of the running Mission are queued so each one reads the
 * revision the previous one wrote; none can be lost to a race.
 */
export function updateActiveMission(
  host: ProviderHost,
  change: (mission: MissionRecord) => MissionResult<MissionRecord>,
): Promise<boolean> {
  const next = missionUpdates.then(async () => {
    const active = host.activeMission;
    if (active === null || host.disposed) {
      // A disposed window writes no Mission state; the next one recovers it.
      return false;
    }
    const result = await host.missions.update(active.id, active.revision, change);
    if (result.ok) {
      host.activeMission = { id: result.value.id, revision: result.value.revision };
    }
    return result.ok;
  });
  missionUpdates = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Start (or resume) the current task of a Mission: one ordinary bounded
 * Agent run in the Mission's thread. The user starts every run; a resumed
 * task is told what already ran and never writes without approval.
 */
export async function runMissionTask(
  host: ProviderHost,
  missionId: string,
  expectedRevision: number,
): Promise<void> {
  if (host.running || host.agentRunner.isRunning) {
    host.status = 'A request is already running. Cancel it before starting a Mission task.';
    await host.postState();
    return;
  }
  await host.missionRecovery;
  const mission = host.missions.get(missionId);
  const scope = await memoryScopeForUi(host);
  if (mission === null || !scope.ok || mission.scopeId !== scope.scopeId) {
    host.status = 'That Mission does not belong to the open project.';
    await host.postState();
    return;
  }
  if (mission.revision !== expectedRevision) {
    host.status = 'The Mission changed; review it again before continuing.';
    await host.refreshMemoryView();
    await host.postState();
    return;
  }
  const allowed = canRunTask(mission);
  if (!allowed.ok) {
    host.status = allowed.error;
    await host.postState();
    return;
  }
  if (!host.store.get(mission.threadId)) {
    host.status = 'The Mission thread no longer exists.';
    await host.postState();
    return;
  }
  // The prompt is built before the run counter moves, so a task that ran
  // before is presented as resumed with what already happened.
  const resumed = allowed.value.runs > 0;
  const prompt = buildTaskPrompt(mission);
  const decisions = host.memory.listCurrentDecisions(scope.scopeId).map((entry) => ({ key: entry.key, version: entry.version }));
  const started = await host.missions.update(mission.id, mission.revision, (draft) => startTaskRun(draft, decisions, Date.now()));
  if (!started.ok) {
    host.status = started.error;
    await host.postState();
    return;
  }
  host.activeMission = { id: started.value.id, revision: started.value.revision };
  host.missionProfileCap = resumed ? 'safe-auto' : null;
  host.lastAgentOutcome = null;
  host.activeThreadId = mission.threadId;
  host.pinnedRunRoot = scope.root;
  host.hostPromptText = prompt.trim();
  try {
    await host.sendMessage(prompt, 'agent', providerToRuntime(host.settings.provider));
  } finally {
    host.pinnedRunRoot = null;
    host.hostPromptText = null;
    const outcome = host.lastAgentOutcome as AgentOutcomeRecord | null;
    const reason = host.status;
    if (outcome !== null && outcome.threadId === mission.threadId && outcome.outcome === 'done') {
      await updateActiveMission(host, (draft) => completeTask(draft, outcome.hostRecord, outcome.report, Date.now()));
    } else {
      await updateActiveMission(host, (draft) =>
        interrupt(draft, `The task run ended without completing: ${reason}`, Date.now(), outcome?.hostRecord ?? []),
      );
    }
    host.activeMission = null;
    host.missionProfileCap = null;
    await host.refreshMemoryView();
    await host.postState();
  }
}

/**
 * The user authorizes the Mission once (mode, local model, optional Meta
 * consultations) and starts it. Nothing runs before this explicit step.
 */
export async function startMission(
  host: ProviderHost,
  missionId: string,
  expectedRevision: number,
  mode: MissionGrant['mode'],
  escalation: { maxConsultations: number; limits?: ChosenAdvisoryLimits | null } | null,
  trustedProject = false,
  acceptance: { commandId: string; files: string[] } | null = null,
): Promise<void> {
  const mission = host.missions.get(missionId);
  const scope = await memoryScopeForUi(host);
  if (mission === null || !scope.ok || mission.scopeId !== scope.scopeId) {
    host.status = 'That Mission does not belong to the open project.';
    await host.postState();
    return;
  }
  if (escalation !== null && !host.settings.allowCloudEscalation) {
    host.status = 'Meta consultations need cloud escalation ON in Settings. Nothing was authorized.';
    await host.postState();
    return;
  }
  // The test commands are bound to the exact package.json they come from now.
  const testContext = await host.testCommandContext(scope.root);
  const bootstrap = testContext.packageJsonRaw.length === 0 || testContext.allowlist.length === 0;
  if (bootstrap && acceptance !== null) {
    host.status = 'This empty project needs a bootstrap stage first. Its tests do not exist yet, so nothing was frozen or authorized.';
    await host.postState();
    return;
  }
  // The user's acceptance check is frozen now: its command and its files by hash.
  let frozen: { commandId: string; packageJsonHash: string; files: Array<{ path: string; hash: string }>; scope: AcceptanceManifest } | null = null;
  let scopeNotes: string[] = [];
  if (acceptance !== null) {
    const files: Array<{ path: string; hash: string }> = [];
    // Also frozen, when present: what decides how the check runs.
    const environment: string[] = [];
    for (const file of ACCEPTANCE_ENVIRONMENT_FILES) {
      if ((await currentFileHash(scope.fs, file)) !== null && !acceptance.files.includes(file)) {
        environment.push(file);
      }
    }
    for (const file of [...acceptance.files, ...environment]) {
      const hash = await currentFileHash(scope.fs, file);
      const gate = checkAgentRelPath(file);
      if (hash === null || !gate.ok) {
        host.status = `The acceptance file ${file.slice(0, 120)} does not exist in this project. Nothing was authorized.`;
        await host.postState();
        return;
      }
      files.push({ path: (gate as { ok: true; rel: string }).rel, hash });
    }
    if (!testContext.allowlist.some((entry) => entry.id === acceptance.commandId) || testContext.packageJsonRaw.length === 0) {
      host.status = `The acceptance command ${acceptance.commandId.slice(0, 60)} is not an allowlisted test of this project. Nothing was authorized.`;
      await host.postState();
      return;
    }
    // What the check loads and reads, observed and analysed: verifier files are
    // frozen with it, writable ones need the user's confirmation, and anything
    // undetermined means it cannot be protected (S6b/S6e).
    for (const file of files.filter((candidate) => CASES_FILE.test(candidate.path))) {
      const parsed = parseCasesSpec(await scope.fs.readText(file.path).catch(() => ''));
      if (!parsed.ok) {
        host.status = `The cases file ${file.path.slice(0, 120)} is not valid: ${parsed.error}. Nothing was authorized.`;
        await host.postState();
        return;
      }
    }
    const entry = testContext.allowlist.find((candidate) => candidate.id === acceptance.commandId) as Parameters<ProviderHost['runAllowlistedTest']>[0];
    const protectedScope = await protectAcceptanceScope(host, scope.fs, scope.root, entry, acceptance.commandId, files, packageName(testContext.packageJsonRaw));
    if (!protectedScope.ok) {
      host.status = protectedScope.error;
      await host.postState();
      return;
    }
    files.push(...protectedScope.freeze);
    scopeNotes = protectedScope.notes;
    frozen = { commandId: acceptance.commandId, packageJsonHash: hashContent(testContext.packageJsonRaw), files, scope: protectedScope.manifest };
  }
  const granted = await host.missions.update(missionId, expectedRevision, (draft) => {
    const result = grantMission(
      draft,
      {
        model: host.generationModel('local'),
        mode,
        escalation:
          escalation === null
            ? null
            : {
                model: host.selectedCloudModel(),
                maxConsultations: escalation.maxConsultations,
                // Never raised later; RAME Code only counts against them.
                ...chooseAdvisoryLimits(escalation.maxConsultations, { maxOutputTokens: MISSION_CONSULT_OUTPUT_TOKENS, ...escalation.limits }),
              },
        tests:
          mode === 'autonomous-workspace'
            ? {
                trustedProject: trustedProject,
                packageJsonHash: testContext.packageJsonRaw.length > 0 ? hashContent(testContext.packageJsonRaw) : '',
                commandIds: testContext.allowlist.map((entry) => entry.id),
              }
            : null,
        acceptance: frozen,
        bootstrap,
      },
      Date.now(),
    );
    if (result.ok && frozen !== null) {
      const task = currentTask(result.value);
      for (const text of task ? scopeNotes : []) {
        result.value.evidence.push({ taskId: task!.id, kind: 'note', text: text.slice(0, 300), at: Date.now() });
      }
    }
    if (result.ok && result.value.acceptanceReview && frozen !== null) {
      const review = result.value.acceptanceReview;
      const task = currentTask(result.value);
      if (task) {
        result.value.evidence.push({
          taskId: task.id,
          kind: 'note',
          text: `user froze ${frozen.commandId} and ${frozen.files.length} acceptance file(s) after Spark review status ${review.status}, decision ${review.decision}; Spark authorized nothing`,
          at: Date.now(),
        });
      }
    }
    return result;
  });
  if (!granted.ok) {
    host.status = granted.error;
    await host.refreshMemoryView();
    await host.postState();
    return;
  }
  host.missionStarting = missionId;
  try {
    if (host.missionStartRequest !== null && host.missionStartRequest.missionId === missionId && host.missionStartRequest.state === 'authorizing') {
      // The grant is saved: confirm the click before the first internal run.
      host.missionStartRequest = { ...host.missionStartRequest, state: 'started' };
      host.status = 'Mission started.';
      await host.refreshMemoryView();
      await host.postState();
    }
    await runMissionAutonomous(host, missionId, granted.value.revision);
  } finally {
    host.missionStarting = null;
  }
}

/**
 * One click of "Authorize and start": confirmed at once as authorizing,
 * then as started or failed. While one start is being authorized, another
 * (a double click, a second message) changes nothing.
 */
export async function requestMissionStart(
  host: ProviderHost,
  requestId: string,
  start: () => Promise<void>,
  missionId: string,
): Promise<void> {
  const current = host.missionStartRequest;
  if (current !== null && (current.state === 'authorizing' || current.requestId === requestId)) {
    await host.postState();
    return;
  }
  if (host.missionAuto !== null && host.missionAuto.missionId === missionId) {
    await host.postState();
    return;
  }
  host.missionStartRequest = { requestId, missionId, state: 'authorizing', error: '' };
  host.status = 'Authorizing the Mission\u2026';
  await host.refreshMemoryView();
  await host.postState();
  try {
    await start();
  } finally {
    const after = host.missionStartRequest;
    if (after !== null && after.requestId === requestId && after.state === 'authorizing') {
      // Nothing was granted: the reason is the host's own status.
      host.missionStartRequest = { ...after, state: 'failed', error: host.status };
      await host.refreshMemoryView();
      await host.postState();
    }
  }
}

/** Continue an authorized Mission (after a pause, a block, or a reload). */
export async function resumeMission(
  host: ProviderHost,
  missionId: string,
  expectedRevision: number,
): Promise<void> {
  const mission = host.missions.get(missionId);
  if (mission !== null && mission.grant === null) {
    host.status = 'Authorize the Mission before running it.';
    await host.postState();
    return;
  }
  if (mission !== null && (mission.status === 'paused' || mission.status === 'blocked')) {
    // An explicit resume makes it runnable again; the loop re-checks everything.
    const reopened = await host.missions.update(missionId, expectedRevision, (draft) => {
      draft.status = 'interrupted';
      draft.note = 'Resumed by you.';
      if (draft.auto !== null) {
        draft.auto.noProgressStreak = 0;
      }
      return { ok: true, value: draft };
    });
    if (!reopened.ok) {
      host.status = reopened.error;
      await host.postState();
      return;
    }
    expectedRevision = reopened.value.revision;
  }
  host.missionStarting = missionId;
  try {
    await runMissionAutonomous(host, missionId, expectedRevision);
  } finally {
    host.missionStarting = null;
  }
}

/** Pause (resumable) or cancel (final) at once: the current internal run is stopped. */
export async function stopMission(
  host: ProviderHost,
  missionId: string,
  kind: 'pause' | 'cancel',
): Promise<void> {
  if (host.missionAuto !== null && host.missionAuto.missionId === missionId) {
    host.missionAuto.stop = kind;
    host.cancelRequest();
    host.status = kind === 'pause' ? 'Pausing the Mission\u2026' : 'Cancelling the Mission\u2026';
    await host.postState();
    return;
  }
  const mission = host.missions.get(missionId);
  if (mission === null) {
    host.status = 'That Mission no longer exists or could not be read.';
    await host.postState();
    return;
  }
  const result = await host.missions.update(missionId, mission.revision, (draft) =>
    kind === 'pause' ? pauseMission(draft, Date.now()) : cancelMission(draft, Date.now()),
  );
  host.status = result.ok ? result.value.note : result.error;
  await host.refreshMemoryView();
  await host.postState();
}

/**
 * The loop: one bounded Agent run (12 steps) at a time, a checkpoint after
 * each, and the next run started by the host until the goal is verified,
 * an approval is pending, the user stops it, or the host sees no progress.
 */
export async function runMissionAutonomous(
  host: ProviderHost,
  missionId: string,
  expectedRevision: number,
): Promise<void> {
  if (host.running || host.agentRunner.isRunning || host.missionAuto !== null) {
    host.status = 'A request is already running. Cancel it before starting a Mission.';
    await host.postState();
    return;
  }
  await host.missionRecovery;
  const scope = await memoryScopeForUi(host);
  let mission = host.missions.get(missionId);
  if (mission === null || !scope.ok || mission.scopeId !== scope.scopeId) {
    host.status = 'That Mission does not belong to the open project.';
    await host.postState();
    return;
  }
  if (leaseHeldByOther(mission, host.leaseToken, (lease) => host.isLeaseAlive(lease))) {
    host.status = 'This Mission is running in another VS Code window.';
    await host.postState();
    return;
  }
  if (mission.revision !== expectedRevision) {
    host.status = 'The Mission changed; review it again before continuing.';
    await host.refreshMemoryView();
    await host.postState();
    return;
  }
  if (mission.grant === null || mission.grant.model !== host.generationModel('local')) {
    host.status = 'Authorize the Mission for the current local model before running it.';
    await host.postState();
    return;
  }
  if (!host.store.get(mission.threadId)) {
    host.status = 'The Mission thread no longer exists.';
    await host.postState();
    return;
  }
  const leased = await host.missions.update(missionId, expectedRevision, (draft) => {
    if (leaseHeldByOther(draft, host.leaseToken, (lease) => host.isLeaseAlive(lease))) {
      return { ok: false, error: 'This Mission is running in another VS Code window.' };
    }
    draft.lease = { pid: process.pid, token: host.leaseToken, at: Date.now() };
    return { ok: true, value: draft };
  });
  if (!leased.ok) {
    host.status = leased.error;
    await host.postState();
    return;
  }
  registerLiveMissionLease(host.leaseToken);
  mission = leased.value;
  // After an interruption with an unknown result, the first run checks
  // before any automatic write: its writes still ask.
  const auto: NonNullable<ProviderHost['missionAuto']> = { missionId, stop: null, holdAutonomy: uncertainActions(mission).length > 0 };
  host.missionAuto = auto;
  // This loop's lifetime: a disposed window, or another loop for this host,
  // ends it. Checked after every await before anything is started or written.
  const live = (): boolean => !host.disposed && host.missionAuto === auto;
  const testCommands = (await host.testCommandContext(scope.root)).allowlist.map((entry) => entry.id);
  let ended = '';
  try {
    for (;;) {
      if (!live()) {
        break;
      }
      mission = host.missions.get(missionId);
      if (mission === null) {
        ended = 'The Mission could not be read.';
        break;
      }
      if (host.missionAuto!.stop !== null || ['paused', 'cancelled', 'blocked', 'completed', 'failed'].includes(mission.status)) {
        break;
      }
      const allowed = canRunTask(mission);
      if (!allowed.ok) {
        if (currentTask(mission) !== null) {
          await host.missions.update(mission.id, mission.revision, (draft) => blockMission(draft, allowed.error, Date.now()));
        }
        break;
      }
      // The files already read, with their hash as they are now, for the operational summary.
      const fileHashes: Record<string, string | null> = {};
      for (const file of filesReadInMission(mission)) {
        fileHashes[file] = await currentFileHash(scope.fs, file);
      }
      if (!live()) {
        break;
      }
      const prompt = buildAutoTaskPrompt(mission, testCommands, fileHashes);
      const decisions = host.memory.listCurrentDecisions(scope.scopeId).map((entry) => ({ key: entry.key, version: entry.version }));
      const started = await host.missions.update(mission.id, mission.revision, (draft) => {
        const result = startTaskRun(draft, decisions, Date.now());
        // Advice is quoted in exactly one internal run.
        if (result.ok && result.value.auto !== null) {
          result.value.auto.pendingAdvice = '';
        }
        return result;
      });
      if (!started.ok) {
        ended = started.error;
        break;
      }
      host.activeMission = { id: started.value.id, revision: started.value.revision };
      host.missionProfileCap = null;
      host.lastAgentOutcome = null;
      host.activeThreadId = mission.threadId;
      host.pinnedRunRoot = scope.root;
      host.hostPromptText = prompt.trim();
      try {
        await host.sendMessage(prompt, 'agent', providerToRuntime('local'));
      } finally {
        host.pinnedRunRoot = null;
        host.hostPromptText = null;
      }
      if (!live()) {
        // This window is going away (a reload): like a killed process, it
        // writes nothing more; the next window recovers the Mission.
        break;
      }
      host.missionAuto!.holdAutonomy = false;
      const stop = host.missionAuto!.stop as 'pause' | 'cancel' | null;
      if (stop !== null) {
        await updateActiveMission(host, (draft) => (stop === 'pause' ? pauseMission(draft, Date.now()) : cancelMission(draft, Date.now())));
        break;
      }
      const outcome = host.lastAgentOutcome as AgentOutcomeRecord | null;
      if (outcome === null || outcome.threadId !== mission.threadId || outcome.outcome === 'rejected' || outcome.outcome === 'stale') {
        const reason = outcome === null ? host.status : outcome.outcome === 'rejected' ? 'You rejected an action.' : host.status;
        await updateActiveMission(host, (draft) => interrupt(draft, `The internal run ended without a result: ${reason}`, Date.now(), outcome?.hostRecord ?? []));
        break;
      }
      const current = host.missions.get(missionId);
      // The manifest the tests ran against: a blocking verifier recovers only under the same one.
      const runContext = await host.testCommandContext(scope.root);
      const conditions = runContext.packageJsonRaw.length > 0 ? hashContent(runContext.packageJsonRaw) : '';
      const bootstrapCandidates = current?.grant?.bootstrap === true ? await listAcceptanceCandidates(scope.fs) : [];
      if (!live()) {
        break;
      }
      const bootstrapReady =
        current?.grant?.bootstrap === true &&
        runContext.packageJsonRaw.length > 0 &&
        runContext.allowlist.length > 0 &&
        bootstrapCandidates.length > 0;
      const observation: RunObservation = {
        outcome: outcome.outcome,
        writes: outcome.writes ?? [],
        lastTest: outcome.lastTest ?? null,
        wroteAfterLastTest: outcome.wroteAfterLastTest ?? false,
        uncertain: current !== null ? uncertainActions(current).length : 1,
        hostRecord: outcome.hostRecord,
        report: outcome.report,
        repeatedReads: outcome.repeatedReads ?? 0,
        verifiers: outcome.verifiers ?? [],
        conditions,
      };
      let next = 'continue' as 'complete-task' | 'continue' | 'blocked';
      let assessment = null as RunAssessment | null;
      const recorded = await updateActiveMission(host, (draft) => {
        assessment = assessRun(draft, observation);
        const result = recordRun(draft, observation, assessment, Date.now());
        if (!result.ok) {
          return result;
        }
        next = result.value.next;
        if (bootstrapReady) {
          const waiting = awaitBootstrapVerification(
            result.value.mission,
            runContext.allowlist.map((entry) => entry.id),
            bootstrapCandidates,
            Date.now(),
          );
          if (!waiting.ok) {
            return waiting;
          }
          return { ok: true, value: waiting.value };
        }
        // Back to a runnable state between internal runs.
        result.value.mission.status = 'active';
        return { ok: true, value: result.value.mission };
      });
      if (!live()) {
        break;
      }
      if (!recorded) {
        ended = 'The Mission checkpoint could not be saved; stopping before the next run.';
        break;
      }
      if (bootstrapReady) {
        ended = 'Scaffold created. Review and authorize the verification stage; nothing else ran.';
        break;
      }
      // A blocking verifier that can no longer run can never recover: show it and stop.
      let unrecoverable = '';
      await updateActiveMission(host, (draft) => {
        const notes = draft.auto === null ? [] : markUnrecoverable(draft.auto.blockers, runContext.allowlist.map((entry) => entry.id));
        const task = currentTask(draft);
        for (const line of notes) {
          if (task) {
            draft.evidence.push({ taskId: task.id, kind: 'note', text: line.slice(0, 300), at: Date.now() });
          }
        }
        unrecoverable = notes[0] ?? '';
        return { ok: true, value: draft };
      });
      if (!live()) {
        break;
      }
      if (unrecoverable.length > 0) {
        await updateActiveMission(host, (draft) => blockMission(draft, `${unrecoverable}.`, Date.now()));
        break;
      }
      if (next === 'continue' && (assessment as RunAssessment | null)?.blockedByVerifier === true) {
        // The run is otherwise verified: the host re-runs the verifiers that
        // failed, itself, and only their passing result accepts the task.
        if (await recheckBlockingVerifiers(host, missionId, runContext, conditions, scope.root)) {
          next = 'complete-task';
        }
        if (!live()) {
          break;
        }
      }
      if (next !== 'complete-task' && hostVerifiesAcceptance(host.missions.get(missionId), observation, assessment as RunAssessment | null)) {
        // S10b: the agent reported done without a passing test after its last
        // change. With a frozen acceptance check on the last task, the host runs
        // that check itself (below) instead of waiting for the agent to test.
        next = 'complete-task';
      }
      if (next === 'complete-task') {
        const latest = host.missions.get(missionId);
        const lastTask = latest !== null && latest.tasks.filter((task) => task.status === 'pending').length === 0;
        if (latest !== null && lastTask && latest.grant?.acceptance) {
          // Before the Mission can end, the host runs the user's frozen check.
          host.status = `Running the acceptance check ${latest.grant.acceptance.commandId}\u2026`;
          await host.postState();
          if (!live()) {
            break;
          }
          const acceptanceResult = await runAcceptance(host, latest, scope.root, scope.fs);
          if (!live()) {
            // Closed or reloaded while the check ran: nothing is recorded here.
            break;
          }
          if (acceptanceResult.interrupted && host.missionAuto!.stop === null) {
            // Stopped before it finished, but not by the user: an interruption, not a failed check.
            await updateActiveMission(host, (draft) => interrupt(draft, `The acceptance check ${latest.grant!.acceptance!.commandId} was interrupted before it finished; nothing was concluded from it.`, Date.now()));
            break;
          }
          if (acceptanceResult.tampered || acceptanceResult.unverifiable) {
            // The criteria themselves changed, or RAME cannot verify them: no run of the agent can fix that.
            await updateActiveMission(host, (draft) => {
              note(draft, `acceptance (run by the host): ${acceptanceResult.summary}`);
              return blockMission(
                draft,
                acceptanceResult.unverifiable
                  ? `NOT VERIFIABLE: ${acceptanceResult.summary.replace(/^not verifiable: /, '')}. RAME did not count this run; the acceptance you authorized is unchanged.`
                  : `the acceptance check can no longer be trusted: ${acceptanceResult.summary}.`,
                Date.now(),
              );
            });
            break;
          }
          if (host.missionAuto!.stop !== null) {
            const stopNow = host.missionAuto!.stop;
            await updateActiveMission(host, (draft) => (stopNow === 'pause' ? pauseMission(draft, Date.now()) : cancelMission(draft, Date.now())));
            break;
          }
          let decision = 'continue' as 'complete-task' | 'continue' | 'blocked';
          await updateActiveMission(host, (draft) => {
            const approvedScope = draft.grant?.acceptance?.scope;
            if (acceptanceResult.approved && approvedScope) {
              // A scope review the user approved: a new authorization, recorded as such.
              approvedScope.writable = [...new Set([...approvedScope.writable, ...acceptanceResult.approved])].slice(0, 200);
              approvedScope.approvals += 1;
              note(draft, `scope review: the user approved ${acceptanceResult.approved.slice(0, 8).join(', ')} as writable after the check ran`);
            }
            const result = recordAcceptance(draft, acceptanceResult, Date.now());
            if (!result.ok) {
              return result;
            }
            decision = result.value.next;
            return { ok: true, value: result.value.mission };
          });
          if (!live()) {
            break;
          }
          if (decision === 'blocked') {
            await updateActiveMission(host, (draft) => blockMission(draft, `the user's acceptance check kept failing (${acceptanceResult.summary}).`, Date.now()));
            break;
          }
          if (decision === 'continue') {
            continue;
          }
        }
        if (!live()) {
          break;
        }
        await updateActiveMission(host, (draft) => completeTask(draft, [], outcome.report || 'verified by the host', Date.now()));
        continue;
      }
      if (next === 'blocked') {
        const summary = assessment?.summary ?? '';
        await updateActiveMission(host, (draft) =>
          blockMission(draft, `${MAX_NO_PROGRESS_RUNS} internal runs in a row without verifiable progress, or the run ceiling was reached (last: ${summary}).`, Date.now()),
        );
        break;
      }
      if (outcome.capabilityReason && live()) {
        await consultForMission(host, missionId, outcome.capabilityReason, outcome.hostRecord, scope.scopeId);
      }
    }
  } finally {
    host.activeMission = null;
    host.missionProfileCap = null;
    const finalMission = host.disposed ? null : host.missions.get(missionId);
    if (finalMission !== null && finalMission.lease?.token === host.leaseToken) {
      await host.missions.update(missionId, finalMission.revision, (draft) => {
        draft.lease = null;
        return { ok: true, value: draft };
      });
    }
    unregisterLiveMissionLease(host.leaseToken);
    if (host.missionAuto === auto) {
      host.missionAuto = null;
    }
    const done = host.disposed ? null : host.missions.get(missionId);
    if (done !== null) {
      appendMissionReport(host, done);
      host.status = ended || done.note;
    }
    await host.refreshMemoryView();
    await host.postState();
  }
}

/**
 * One host-written entry for the whole Mission, apart from the internal
 * runs. The final report is written only for a completed Mission and, when
 * the user froze an acceptance check, only after the host's own run of it
 * exited 0; any other stop gets a short status note instead.
 */
export function appendMissionReport(host: ProviderHost, mission: MissionRecord): void {
  const entry = buildMissionReportEntry(mission, missionEvidenceLines(host.modelEvidence.state, mission.threadId, mission.id));
  if (entry === null) {
    return;
  }
  const current = host.store.get(mission.threadId);
  if (current) {
    host.store.save(appendHostNoteTurn(current, entry.title, entry.hostRecord));
  }
}

/**
 * Retry a blocked Mission with guidance the user typed: it is quoted to the
 * next internal runs, and the Mission resumes under the same grant.
 */
export async function retryMission(
  host: ProviderHost,
  missionId: string,
  expectedRevision: number,
  guidance: string,
): Promise<void> {
  const mission = host.missions.get(missionId);
  if (mission === null || mission.status !== 'blocked' || mission.auto === null) {
    host.status = 'Only a blocked Mission can be retried with guidance.';
    await host.postState();
    return;
  }
  const guided = await host.missions.update(missionId, expectedRevision, (draft) => {
    if (draft.auto === null) {
      return { ok: false, error: 'This Mission was never started.' };
    }
    draft.auto.userGuidance = guidance.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, MAX_USER_GUIDANCE);
    return { ok: true, value: draft };
  });
  if (!guided.ok) {
    host.status = guided.error;
    await host.postState();
    return;
  }
  await resumeMission(host, missionId, guided.value.revision);
}

// ---- Mission helpers --------------------------------------------------------

/** A host note on the current task (bounded like every evidence entry). */
function note(mission: MissionRecord, text: string): void {
  const task = currentTask(mission);
  if (task) {
    mission.evidence.push({ taskId: task.id, kind: 'note', text: text.replace(/[\u0000-\u001F\u007F]+/g, ' ').slice(0, 300), at: Date.now() });
  }
}

/** Whether the running Mission's grant covers this tool for this exact run. */
export function missionGrantAllows(
  host: ProviderHost,
  tool: string,
  scopeId: string,
  provider: string,
  model: string,
  test: { commandId: string; packageJsonHash: string },
): boolean {
  const auto = host.missionAuto;
  if (auto === null || host.activeMission === null || auto.missionId !== host.activeMission.id || auto.holdAutonomy) {
    return false;
  }
  return grantAllows(host.missions.get(auto.missionId), { missionId: auto.missionId, scopeId, provider, model }, tool, test);
}

/**
 * The host's own re-run of the open blocking verifiers. Only commands the
 * autonomous grant already allows, under the package.json it was granted
 * for: a supervised Mission keeps asking, so the host never runs them there.
 */
export async function recheckBlockingVerifiers(
  host: ProviderHost,
  missionId: string,
  context: { allowlist: Array<{ id: string }>; packageJsonRaw: string },
  conditions: string,
  root: string,
): Promise<boolean> {
  const mission = host.missions.get(missionId);
  const tests = mission?.grant?.mode === 'autonomous-workspace' ? mission.grant.tests : null;
  const blockers = mission?.auto?.blockers ?? [];
  if (mission === null || tests === null || blockers.length === 0 || tests.packageJsonHash !== conditions) {
    return false;
  }
  const results: Array<{ commandId: string; exitCode: number | null }> = [];
  for (const blocker of blockers) {
    const command = (await host.testCommandContext(root)).allowlist.find((entry) => entry.id === blocker.commandId);
    if (!command || !tests.commandIds.includes(blocker.commandId) || host.disposed) {
      return false;
    }
    host.status = `Re-running the blocking verifier ${blocker.commandId}\u2026`;
    await host.postState();
    const controller = new AbortController();
    host.acceptanceController = controller;
    try {
      const output = await host.runAllowlistedTest(command, controller.signal, root);
      const exit = /^exit=(\d+)/.exec(output);
      results.push({ commandId: blocker.commandId, exitCode: exit ? Number(exit[1]) : null });
    } finally {
      host.acceptanceController = null;
    }
    if ((host.missionAuto?.stop !== null && host.missionAuto?.stop !== undefined) || host.disposed) {
      return false;
    }
  }
  let cleared = false;
  await updateActiveMission(host, (draft) => {
    const result = recordVerifierRecheck(draft, results, conditions, Date.now());
    if (!result.ok) {
      return result;
    }
    cleared = result.value.cleared;
    return { ok: true, value: result.value.mission };
  });
  return cleared;
}

/** Whether this window is currently authorizing the given Mission. */
export function isAuthorizing(host: ProviderHost, missionId: string): boolean {
  return host.missionStartRequest !== null && host.missionStartRequest.missionId === missionId && host.missionStartRequest.state === 'authorizing';
}

// ---- Mission views ----------------------------------------------------------

/** Settings: the project's latest Mission card. */
export function missionView(
  host: ProviderHost,
  scopeId: string,
  current: Array<{ key: string; version: number }>,
): MissionView | null {
  const mission = host.missions
    .list()
    .filter((entry) => entry.scopeId === scopeId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!mission) {
    return null;
  }
  return buildMissionView(mission, current, missionViewRuntime(host, mission));
}

/**
 * The live card of the open thread's Mission, from host data only: the
 * phase, progress, acceptance state, controls, and, once completed and
 * accepted, the final report. Computed on every state message so the
 * step and run counters move while the Mission works.
 */
export function missionLiveView(host: ProviderHost, threadId: string | null): MissionLiveView | null {
  if (threadId === null) {
    return null;
  }
  const mission = host.missions
    .list()
    .filter((entry) => entry.threadId === threadId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!mission) {
    if (host.running && host.runThreadId === threadId && host.runKind === 'mission-plan') {
      const thread = host.store.get(threadId);
      const goal = [...(thread?.turns ?? [])].reverse().find((turn) => turn.kind === 'user');
      return buildPlanningMissionLiveView(threadId, goal && 'text' in goal && typeof goal.text === 'string' ? goal.text : '');
    }
    return null;
  }
  return buildMissionLiveView(mission, missionViewRuntime(host, mission));
}

/** Build the live runtime context for Mission view helpers. */
export function missionViewRuntime(host: ProviderHost, mission: MissionRecord): MissionViewRuntime {
  return {
    hostRunning: host.running,
    driving: host.missionAuto?.missionId === mission.id,
    starting: host.missionStarting === mission.id && host.missionAuto === null,
    manualTask: host.activeMission?.id === mission.id,
    agentStep: host.agentStepNow,
    authorizing: isAuthorizing(host, mission.id),
    leaseToken: host.leaseToken,
    isLeaseAlive: (lease) => host.isLeaseAlive(lease),
    cloudEscalationAllowed: host.settings.allowCloudEscalation,
    testCommands: host.missionTestCommands,
    setup: host.missionSetup,
    startRequest: host.missionStartRequest?.missionId === mission.id ? host.missionStartRequest : null,
  };
}

function packageName(packageJsonRaw: string): string {
  try {
    const name = (JSON.parse(packageJsonRaw) as { name?: unknown }).name;
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/**
 * S10b: the agent reported done, nothing is uncertain, no blocking verifier is
 * open, this is the last task, and the user froze an acceptance check, but no
 * test passed after the last change. The host then runs the frozen check
 * itself: its result, not the agent's silence, decides.
 */
export function hostVerifiesAcceptance(
  mission: MissionRecord | null,
  observation: Pick<RunObservation, 'outcome' | 'uncertain'>,
  assessment: Pick<RunAssessment, 'needs' | 'verifierUpdate'> | null,
): boolean {
  return (
    mission !== null &&
    mission.grant?.acceptance != null &&
    observation.outcome === 'done' &&
    observation.uncertain === 0 &&
    assessment !== null &&
    assessment.needs &&
    assessment.verifierUpdate.blockers.length === 0 &&
    mission.tasks.filter((task) => task.status === 'pending').length === 0
  );
}
