import { MAX_AGENT_STEPS } from './agentPolicy.js';
import { canRunTask, currentTask, leaseHeldByOther, type MissionLease, type MissionRecord } from './missionStore.js';
import { acceptanceState, missionFinalReport, missionPhase, missionTestRuns, missionTestsNotRun } from './missionPhase.js';
import type { MissionLiveView, MissionView } from './viewMessages.js';

export interface MissionSetupView {
  scopeId: string;
  testCommands: string[];
  candidates: string[];
  environmentFiles: string[];
  packageJsonHash: string;
}

export interface MissionStartRequestView {
  requestId: string;
  missionId: string;
  state: 'authorizing' | 'started' | 'failed';
  error: string;
}

export interface MissionViewRuntime {
  hostRunning: boolean;
  driving: boolean;
  starting: boolean;
  manualTask: boolean;
  agentStep: number | null;
  authorizing: boolean;
  leaseToken: string;
  isLeaseAlive(lease: MissionLease): boolean;
  cloudEscalationAllowed: boolean;
  testCommands: string[];
  setup: MissionSetupView | null;
  startRequest: MissionStartRequestView | null;
}

export function buildMissionAutonomyView(mission: MissionRecord, runtime: MissionViewRuntime): MissionView['autonomy'] {
  const ended = ['completed', 'cancelled', 'failed'].includes(mission.status);
  const lastTest = [...mission.evidence].reverse().find((entry) => /run_tests /.test(entry.text) && entry.kind === 'host-record');
  return {
    grant: mission.grant?.mode ?? null,
    model: mission.grant?.model ?? null,
    running: runtime.driving,
    internalRuns: mission.auto?.runs ?? 0,
    step: runtime.driving ? runtime.agentStep : null,
    maxSteps: MAX_AGENT_STEPS,
    startedAt: mission.auto?.startedAt ?? null,
    lastProgress: mission.auto?.lastProgress ?? '',
    lastTest: lastTest ? lastTest.text.replace(/^•\s*/, '') : '',
    escalation: mission.grant?.escalation
      ? { used: mission.grant.escalation.used, max: mission.grant.escalation.maxConsultations, model: mission.grant.escalation.model }
      : null,
    canStart: !runtime.driving && !runtime.hostRunning && !ended && mission.grant === null && !runtime.authorizing,
    canResume: !runtime.driving && !runtime.hostRunning && !ended && mission.grant !== null && mission.status !== 'waiting_approval',
    canPause: runtime.driving || ['interrupted', 'blocked'].includes(mission.status),
    canCancel: !ended,
    cloudEscalationAllowed: runtime.cloudEscalationAllowed,
    testCommands: runtime.testCommands,
    acceptance: mission.grant?.acceptance
      ? { commandId: mission.grant.acceptance.commandId, files: mission.grant.acceptance.files.map((file) => file.path) }
      : null,
  };
}

export function buildMissionView(
  mission: MissionRecord,
  current: Array<{ key: string; version: number }>,
  runtime: MissionViewRuntime,
): MissionView {
  const task = currentTask(mission);
  return {
    id: mission.id,
    revision: mission.revision,
    threadId: mission.threadId,
    goal: mission.goal,
    status: mission.status,
    tasks: mission.tasks.map((entry) => ({ title: entry.title, status: entry.status, runs: entry.runs })),
    current: task?.title ?? null,
    pendingCount: mission.tasks.filter((entry) => entry.status !== 'completed').length,
    decisionsUsed: mission.decisionsUsed.map((entry) => ({
      key: entry.key,
      version: entry.version,
      currentVersion: current.find((decision) => decision.key === entry.key)?.version ?? null,
    })),
    evidence: mission.evidence.slice(-20).map((entry) => `${entry.kind}: ${entry.text}`),
    runsUsed: mission.taskRunsUsed,
    maxRuns: mission.maxTaskRuns,
    note: mission.note,
    canRun: !runtime.driving && !runtime.hostRunning && mission.grant === null && canRunTask(mission).ok,
    resume: (task?.runs ?? 0) > 0,
    autonomy: buildMissionAutonomyView(mission, runtime),
  };
}

export function buildPlanningMissionLiveView(threadId: string, goal: string): MissionLiveView {
  return {
    missionId: null,
    revision: 0,
    threadId,
    goal,
    phase: 'planning',
    currentTask: null,
    tasksDone: 0,
    tasksTotal: 0,
    internalRun: 0,
    step: null,
    maxSteps: MAX_AGENT_STEPS,
    startedAt: null,
    endedAt: null,
    lastProgress: '',
    lastTest: '',
    grant: null,
    model: null,
    acceptance: null,
    canStart: false,
    canPause: false,
    canResume: false,
    canCancel: false,
    setup: null,
    startRequest: null,
    report: null,
    blocked: null,
    review: [],
    note: '',
  };
}

export function buildMissionLiveView(mission: MissionRecord, runtime: MissionViewRuntime): MissionLiveView {
  const auto = buildMissionAutonomyView(mission, runtime);
  const driving = runtime.driving || (runtime.starting && mission.status === 'active');
  const phase = missionPhase(mission, {
    driving,
    authorizing: runtime.authorizing,
    manualTask: runtime.manualTask,
    runningElsewhere: !driving && leaseHeldByOther(mission, runtime.leaseToken, runtime.isLeaseAlive),
  });
  const acceptance = acceptanceState(mission);
  const tests = missionTestRuns(mission);
  const ended = ['completed', 'cancelled', 'failed', 'paused', 'blocked', 'interrupted'].includes(phase);
  const setup = auto.canStart && runtime.setup !== null && runtime.setup.scopeId === mission.scopeId
    ? {
        testCommands: [...runtime.setup.testCommands],
        candidates: [...runtime.setup.candidates],
        environmentFiles: [...runtime.setup.environmentFiles],
        packageJsonHash: runtime.setup.packageJsonHash,
      }
    : null;
  return {
    missionId: mission.id,
    revision: mission.revision,
    threadId: mission.threadId,
    goal: mission.goal,
    phase,
    currentTask: currentTask(mission)?.title ?? null,
    tasksDone: mission.tasks.filter((task) => task.status === 'completed').length,
    tasksTotal: mission.tasks.length,
    internalRun: mission.auto === null ? 0 : mission.auto.runs + (driving ? 1 : 0),
    step: driving ? runtime.agentStep : null,
    maxSteps: MAX_AGENT_STEPS,
    startedAt: mission.grant?.grantedAt ?? null,
    endedAt: ended && mission.grant !== null ? mission.updatedAt : null,
    lastProgress: mission.auto?.lastProgress ?? '',
    lastTest: tests.length > 0 ? (tests[tests.length - 1] as string) : '',
    grant: mission.grant?.mode ?? null,
    model: mission.grant?.model ?? null,
    acceptance: mission.grant?.acceptance == null
      ? null
      : {
          commandId: mission.grant.acceptance.commandId,
          files: mission.grant.acceptance.files.map((file) => ({ path: file.path, hash: file.hash })),
          state: acceptance.state,
          summary: acceptance.summary,
        },
    canStart: auto.canStart,
    canPause: auto.canPause && !['paused', 'cancelled', 'completed', 'failed'].includes(mission.status),
    canResume: auto.canResume && ['paused', 'blocked', 'interrupted'].includes(phase),
    canCancel: auto.canCancel,
    setup,
    startRequest: runtime.startRequest === null
      ? null
      : { requestId: runtime.startRequest.requestId, state: runtime.startRequest.state, error: runtime.startRequest.error },
    report: missionFinalReport(mission),
    blocked: phase === 'blocked'
      ? { reason: mission.note, runs: mission.auto?.runs ?? 0, lastProgress: mission.auto?.lastProgress ?? '', testsNotRun: missionTestsNotRun(mission) }
      : null,
    review: mission.evidence.slice(-40).map((entry) => `${entry.kind}: ${entry.text}`),
    note: mission.note,
  };
}
