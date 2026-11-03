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
import { memoryScopeForUi } from './memoryController.js';
import {
  assessRun,
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
import {
  buildMissionLiveView,
  buildMissionView,
  buildPlanningMissionLiveView,
} from './missionViews.js';
import { ACCEPTANCE_ENVIRONMENT_FILES } from './projectAdapters/npmProjectAdapter.js';
import { createCascadeAdvice } from './meta-provider.js';
import { providerToRuntime } from './settingsStore.js';
import { appendAssistantTurn } from './threadStore.js';
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
    if (active === null) {
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
  escalation: { maxConsultations: number } | null,
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
  // The user's acceptance check is frozen now: its command and its files by hash.
  let frozen: { commandId: string; packageJsonHash: string; files: Array<{ path: string; hash: string }> } | null = null;
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
    frozen = { commandId: acceptance.commandId, packageJsonHash: hashContent(testContext.packageJsonRaw), files };
  }
  const granted = await host.missions.update(missionId, expectedRevision, (draft) =>
    grantMission(
      draft,
      {
        model: host.generationModel('local'),
        mode,
        escalation:
          escalation === null
            ? null
            : { model: host.selectedCloudModel(), maxConsultations: escalation.maxConsultations, maxOutputTokens: MISSION_CONSULT_OUTPUT_TOKENS },
        tests:
          mode === 'autonomous-workspace'
            ? {
                trustedProject: trustedProject,
                packageJsonHash: testContext.packageJsonRaw.length > 0 ? hashContent(testContext.packageJsonRaw) : '',
                commandIds: testContext.allowlist.map((entry) => entry.id),
              }
            : null,
        acceptance: frozen,
      },
      Date.now(),
    ),
  );
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
  host.missionAuto = { missionId, stop: null, holdAutonomy: uncertainActions(mission).length > 0 };
  const testCommands = (await host.testCommandContext(scope.root)).allowlist.map((entry) => entry.id);
  let ended = '';
  try {
    for (;;) {
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
      if (host.disposed) {
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
        // Back to a runnable state between internal runs.
        result.value.mission.status = 'active';
        return { ok: true, value: result.value.mission };
      });
      if (!recorded) {
        ended = 'The Mission checkpoint could not be saved; stopping before the next run.';
        break;
      }
      if (next === 'continue' && (assessment as RunAssessment | null)?.blockedByVerifier === true) {
        // The run is otherwise verified: the host re-runs the verifiers that
        // failed, itself, and only their passing result accepts the task.
        if (await recheckBlockingVerifiers(host, missionId, runContext, conditions, scope.root)) {
          next = 'complete-task';
        }
      }
      if (next === 'complete-task') {
        const latest = host.missions.get(missionId);
        const lastTask = latest !== null && latest.tasks.filter((task) => task.status === 'pending').length === 0;
        if (latest !== null && lastTask && latest.grant?.acceptance) {
          // Before the Mission can end, the host runs the user's frozen check.
          host.status = `Running the acceptance check ${latest.grant.acceptance.commandId}\u2026`;
          await host.postState();
          const acceptanceResult = await runAcceptance(host, latest, scope.root, scope.fs);
          if (acceptanceResult.tampered) {
            // The criteria themselves changed: no run of the agent can fix that.
            await updateActiveMission(host, (draft) => blockMission(draft, `the acceptance check can no longer be trusted: ${acceptanceResult.summary}.`, Date.now()));
            break;
          }
          if (host.missionAuto!.stop !== null) {
            const stopNow = host.missionAuto!.stop;
            await updateActiveMission(host, (draft) => (stopNow === 'pause' ? pauseMission(draft, Date.now()) : cancelMission(draft, Date.now())));
            break;
          }
          let decision = 'continue' as 'complete-task' | 'continue' | 'blocked';
          await updateActiveMission(host, (draft) => {
            const result = recordAcceptance(draft, acceptanceResult, Date.now());
            if (!result.ok) {
              return result;
            }
            decision = result.value.next;
            return { ok: true, value: result.value.mission };
          });
          if (decision === 'blocked') {
            await updateActiveMission(host, (draft) => blockMission(draft, `the user's acceptance check kept failing (${acceptanceResult.summary}).`, Date.now()));
            break;
          }
          if (decision === 'continue') {
            continue;
          }
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
      if (outcome.capabilityReason) {
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
    host.missionAuto = null;
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
  const entry = buildMissionReportEntry(mission);
  if (entry === null) {
    return;
  }
  const current = host.store.get(mission.threadId);
  if (current) {
    host.store.save(appendAssistantTurn(current, entry.title, undefined, entry.hostRecord));
  }
}

/**
 * Mission escalation: only within the grant (model, count, output budget)
 * and only after a capability stop. The advice is quoted as untrusted data
 * in the next internal run; it never acts.
 */
export async function consultForMission(
  host: ProviderHost,
  missionId: string,
  reason: string,
  hostRecord: string[],
  scopeId: string,
): Promise<void> {
  const mission = host.missions.get(missionId);
  const grant = mission?.grant ?? null;
  if (mission === null || grant === null || grant.escalation === null || grant.escalation.used >= grant.escalation.maxConsultations || !host.settings.allowCloudEscalation) {
    return;
  }
  const apiKey = await host.getApiKey();
  if (!apiKey) {
    return;
  }
  const escalation = grant.escalation;
  const task = currentTask(mission);
  const payload = buildConsultPayload({
    task: `${mission.goal}\nCurrent task: ${task?.title ?? ''}`,
    reason,
    hostRecord,
    decisions: host.memory.listCurrentDecisions(scopeId).map((entry) => ({ key: entry.key, value: entry.value, version: entry.version })),
  });
  // Counted before the call: a consultation that fails still used its slot.
  const counted = await host.missions.update(missionId, mission.revision, (draft) => {
    if (draft.grant?.escalation) {
      draft.grant.escalation.used += 1;
    }
    return { ok: true, value: draft };
  });
  if (!counted.ok) {
    return;
  }
  if (host.activeMission !== null && host.activeMission.id === missionId) {
    host.activeMission = { id: counted.value.id, revision: counted.value.revision };
  }
  let note: string;
  let advice = '';
  try {
    const result = await host.chatRunner.start(async ({ signal }) =>
      createCascadeAdvice({
        apiKey,
        model: escalation.model,
        payload,
        schema: cascadeAdviceSchema,
        generation: { maxCompletionTokens: escalation.maxOutputTokens, reasoning: null, reasoningParam: null },
        signal,
      }),
    );
    host.recordUsage('cloud', result.usage);
    const parsed = validateCascadeAdvice(JSON.parse(result.content) as unknown);
    advice = formatAdvisory(escalation.model, parsed);
    note = `Meta ${escalation.model} consulted (${escalation.used + 1}/${escalation.maxConsultations}, in ${result.usage.inputTokens} / out ${result.usage.outputTokens} tokens); advice kept as untrusted data`;
  } catch (error) {
    const detail = redactKeyFromText(error instanceof Error ? error.message : 'Unknown error.', apiKey).replace(/\s+/g, ' ').slice(0, 160);
    note = `Meta ${escalation.model} consultation ${escalation.used + 1}/${escalation.maxConsultations} not used (${detail})`;
  }
  await updateActiveMission(host, (draft) => {
    const current = currentTask(draft);
    if (current) {
      draft.evidence.push({ taskId: current.id, kind: 'note', text: note.slice(0, 300), at: Date.now() });
    }
    if (draft.auto !== null) {
      draft.auto.pendingAdvice = advice.slice(0, 4000);
    }
    return { ok: true, value: draft };
  });
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

/**
 * A target frozen by the running Mission's acceptance check (checked by
 * hash), or inside node_modules (only blocked for RAME's own tools, not
 * hashed: scripts, other processes, or the user can still change it).
 */
export function frozenTarget(host: ProviderHost, targets: readonly string[]): string | null {
  const auto = host.missionAuto;
  if (auto === null) {
    return null;
  }
  const frozen = frozenPaths(host.missions.get(auto.missionId));
  if (frozen.length === 0) {
    return null;
  }
  for (const target of targets) {
    const gate = checkAgentRelPath(target);
    const rel = gate.ok ? (gate as { ok: true; rel: string }).rel : target;
    if (frozen.includes(rel) || rel === 'node_modules' || rel.startsWith('node_modules/')) {
      return rel;
    }
  }
  return null;
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
 * The user's acceptance check, run by the host itself (never the model):
 * every frozen file and package.json must still have its granted hash, and
 * the granted command must exit 0.
 */
export async function runAcceptance(
  host: ProviderHost,
  mission: MissionRecord,
  root: string,
  fs: AgentFs,
): Promise<{ passed: boolean; summary: string; output: string; tampered: boolean }> {
  const acceptance = mission.grant?.acceptance ?? null;
  if (acceptance === null) {
    return { passed: true, summary: 'no acceptance check', output: '', tampered: false };
  }
  for (const file of acceptance.files) {
    if ((await currentFileHash(fs, file.path)) !== file.hash) {
      return { passed: false, summary: `${file.path} changed since the Mission was authorized`, output: '', tampered: true };
    }
  }
  if ((await currentFileHash(fs, 'package.json')) !== acceptance.packageJsonHash) {
    return { passed: false, summary: 'package.json changed since the Mission was authorized', output: '', tampered: true };
  }
  const command = (await host.testCommandContext(root)).allowlist.find((entry) => entry.id === acceptance.commandId);
  if (!command) {
    return { passed: false, summary: `${acceptance.commandId} is no longer allowlisted`, output: '', tampered: true };
  }
  const controller = new AbortController();
  host.acceptanceController = controller;
  try {
    const output = await host.runAllowlistedTest(command, controller.signal, root);
    const exit = /^exit=(\d+)/.exec(output);
    const code = exit ? Number(exit[1]) : null;
    return { passed: code === 0, summary: `${acceptance.commandId} exit=${code ?? 'unknown'} with every frozen file intact`, output, tampered: false };
  } finally {
    host.acceptanceController = null;
  }
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
    if (!command || !tests.commandIds.includes(blocker.commandId)) {
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
    if (host.missionAuto?.stop !== null && host.missionAuto?.stop !== undefined) {
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
