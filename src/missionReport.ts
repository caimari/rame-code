import { MAX_HOST_RECORD_LINE_LENGTH } from './hostRecord.js';
import type { MissionRecord } from './missionStore.js';
import { acceptanceState, missionChangedFiles, missionFinalReport, missionTestRuns } from './missionPhase.js';

export interface MissionReportEntry {
  title: string;
  hostRecord: string[];
}

/** Build the host-authored terminal Mission record without touching UI state. */
/** `evidence`: the Model evidence summary lines (modelEvidence.ts), placed before the closing note. */
export function buildMissionReportEntry(mission: MissionRecord, evidence: string[] = []): MissionReportEntry | null {
  if (!['completed', 'blocked', 'paused', 'cancelled', 'interrupted', 'waiting_approval'].includes(mission.status)) {
    return null;
  }
  const tests = missionTestRuns(mission);
  const changed = missionChangedFiles(mission);
  const report = missionFinalReport(mission);
  const lines = [
    `mission: ${mission.status}${report !== null ? ' (every task verified by the host: a passing test after its last change, nothing uncertain)' : ''}`,
    `mission: tasks ${mission.tasks.map((task) => `${task.title.slice(0, 60)} [${task.status}, ${task.runs} run(s)]`).join('; ')}`,
    `mission: internal runs ${mission.taskRunsUsed}; grant ${mission.grant?.mode ?? 'none'}${mission.grant?.escalation ? `; Meta consultations ${mission.grant.escalation.used}/${mission.grant.escalation.maxConsultations}` : ''}`,
    mission.grant?.acceptance
      ? `mission: user acceptance check ${mission.grant.acceptance.commandId} (frozen: ${mission.grant.acceptance.files.map((file) => file.path).join(', ')}, package.json) — ${acceptanceState(mission).summary || 'not run'}`
      : 'mission: no user acceptance check; completion means the project and agent tests passed',
    ...(mission.grant?.tests
      ? [
          `mission: trusted project; tests granted ${mission.grant.tests.commandIds.join(', ')} for package.json ${mission.grant.tests.packageJsonHash.slice(0, 12)}…; test scripts run with your user permissions (path checks are not an operating-system sandbox)`,
        ]
      : []),
    `mission: files changed ${changed.length > 0 ? changed.slice(0, 12).join(', ') : 'none'}`,
    `mission: last test ${tests.length > 0 ? tests[tests.length - 1] : 'none'}`,
    ...(report !== null
      ? [
          `mission: tests run ${report.tests.length > 0 ? report.tests.join(' | ') : 'none'}`,
          `mission: time ${report.minutes} min since authorization`,
          `mission: models ${report.models.join('; ')}; Meta consultations ${report.metaConsultations}`,
          'mission: no sandbox: test scripts ran with your user permissions and could reach other files, the network, or other processes',
        ]
      : []),
    ...evidence,
    `mission: ${mission.note}`,
  ];
  return {
    title: report !== null ? 'Mission completed and verified by the host.' : `Mission ${mission.status.replace('_', ' ')} — status note, not a final report.`,
    hostRecord: lines.map((line) => `• ${line}`.slice(0, MAX_HOST_RECORD_LINE_LENGTH)),
  };
}
