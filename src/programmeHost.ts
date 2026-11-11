/**
 * Running a programme (see `programmeRecord.ts`) on the host: creating it
 * from the user's authorization, measuring the baseline with host jobs,
 * opening a Mission phase with criteria fixed from that baseline, and
 * following each phase until the host has verified it.
 *
 * Nothing starts by itself: after a reload a running measurement waits for
 * the user to resume it (its jobs are followed, never started again), and a
 * Mission phase is followed through its Mission as usual.
 */

import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { resolveTestInvocation } from './agentCommands.js';
import { currentFileHash } from './agentController.js';
import { hashContent } from './agentPatch.js';
import { buildContainerJob } from './jobContainer.js';
import { DEFAULT_JOB_HEARTBEAT_MS, DEFAULT_JOB_LOG_BYTES, jobApprovalDigest, type JobSpec } from './jobRecord.js';
import type { NewJob } from './jobStore.js';
import { CASES_FILE, parseCasesSpec, runHostCases } from './hostCases.js';
import { HOST_SPEC_FILE, parseReferenceSpec, REFERENCE_FILE, referenceProblem } from './referenceCheck.js';
import { memoryScopeForUi } from './memoryController.js';
import { MAX_METRIC_REPEATS, METRIC_RESULTS_ENV, metricSource, parseResultsFile, summarizeSamples } from './metricAcceptance.js';
import { acceptanceState } from './missionPhase.js';
import type { MissionGrant } from './missionStore.js';
import {
  canStartPhase,
  describeBaseline,
  fingerprintOf,
  missionPhaseVerified,
  newPhases,
  type ProgrammeRecord,
  type ProgrammePhaseLease,
  resolveCriteria,
  validatePhases,
} from './programmeRecord.js';
import { PROGRAMME_LEASE_MS, type ProgrammeResult, ProgrammeStore } from './programmeStore.js';
import { snapshotProject } from './projectSnapshot.js';
import type { ProviderHost } from './providerTypes.js';
import { protectedProjectAccess, protectedVerifierSecret } from './protectedVerifier.js';
import { currentVerificationMode, protectedVerifierInvocation, UNPROTECTED_VERIFICATION_WARNING, verificationLabel, type VerificationMode } from './shellIsolation.js';

export const MEASURE_JOB_TIMEOUT_MS = 30 * 60 * 1000;
const METRIC_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export type ProgrammeHost = ProviderHost & {
  programmes: ProgrammeStore;
  startMission(missionId: string, expectedRevision: number, mode: MissionGrant['mode'], escalation: null, trustedProject: boolean, acceptance: { commandId: string; files: string[]; metrics?: unknown } | null): Promise<void>;
};

export interface NewProgramme {
  goal: string;
  check: { commandId: string; files: string[]; metrics: string[]; repeats?: number; maxSpreadPct?: number };
  phases: unknown;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Hold and renew one phase lease; a fencing token makes every late update fail closed. */
async function withPhaseLease(
  host: ProgrammeHost,
  programmeId: string,
  phaseIndex: number,
  work: (lease: () => ProgrammePhaseLease) => Promise<ProgrammeResult<ProgrammeRecord>>,
): Promise<ProgrammeResult<ProgrammeRecord>> {
  const acquired = await host.programmes.acquirePhase(programmeId, phaseIndex, host.leaseToken);
  if (!acquired.ok) return acquired;
  let lease = acquired.value.lease;
  let renewal: Promise<void> | null = null;
  let lost: string | null = null;
  const timer = setInterval(() => {
    if (renewal !== null || lost !== null) return;
    renewal = host.programmes.renewPhase(programmeId, lease).then((result) => {
      if (result.ok) lease = result.value;
      else lost = result.error;
    }).catch((error) => {
      lost = error instanceof Error ? error.message : 'The Programme lease could not be renewed.';
    }).finally(() => { renewal = null; });
  }, Math.max(1000, Math.floor(PROGRAMME_LEASE_MS / 3)));
  let result: ProgrammeResult<ProgrammeRecord>;
  try {
    result = await work(() => lease);
    if (lost !== null) result = fail(lost);
  } finally {
    clearInterval(timer);
    // Do not release while a timer renewal is still inside the shared store
    // lock. Otherwise that late renewal could recreate a live lease after the
    // phase was released.
    if (renewal !== null) await renewal;
  }
  const released = await host.programmes.releasePhase(programmeId, lease);
  if (!released.ok) return result.ok ? released : result;
  return result.ok ? released : result;
}

/** The project files as they are now (the container output folder excluded), as one hash. */
async function projectFingerprint(host: ProviderHost, root: string): Promise<{ ok: true; print: string } | { ok: false; error: string }> {
  const snapshot = await snapshotProject(root);
  if (!snapshot.ok || snapshot.unreadable.length > 0) {
    return fail(`RAME could not read every project file${snapshot.ok ? ` (${snapshot.unreadable.slice(0, 3).join(', ')})` : ''}`);
  }
  const output = host.settings.jobs?.container?.outputDir;
  const prints = new Map<string, string>();
  for (const [rel, state] of snapshot.files) {
    if (output === undefined || (rel !== output && !rel.startsWith(`${output}/`))) {
      prints.set(rel, state.print);
    }
  }
  return { ok: true, print: fingerprintOf(prints) };
}

/** The check files and package.json still have the hashes the user authorized. */
async function checkIntact(host: ProviderHost, programme: ProgrammeRecord): Promise<string | null> {
  const fs = host.agentFsFor(programme.root);
  for (const file of programme.check.files) {
    if ((await currentFileHash(fs, file.path)) !== file.hash) {
      return `${file.path} changed since the programme was authorized`;
    }
  }
  return (await currentFileHash(fs, 'package.json')) !== programme.check.packageJsonHash ? 'package.json changed since the programme was authorized' : null;
}

/** The user authorizes a programme: its goal, the frozen measurement, and the phases. */
export async function createProgramme(host: ProgrammeHost, input: NewProgramme): Promise<ProgrammeResult<ProgrammeRecord>> {
  const scope = await memoryScopeForUi(host);
  if (!scope.ok) {
    return fail(scope.error);
  }
  const goal = String(input.goal ?? '').trim();
  if (goal.length === 0 || goal.length > 2000) {
    return fail('A programme needs a goal of 1 to 2000 characters.');
  }
  const check = input.check;
  const repeats = check?.repeats ?? 3;
  const maxSpreadPct = check?.maxSpreadPct ?? 15;
  if (!Array.isArray(check?.metrics) || check.metrics.length === 0 || check.metrics.length > 8 || !check.metrics.every((name) => METRIC_NAME.test(name))) {
    return fail('The measurement needs 1 to 8 metric names of lowercase letters, digits and _.');
  }
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_METRIC_REPEATS || typeof maxSpreadPct !== 'number' || maxSpreadPct < 1 || maxSpreadPct > 100) {
    return fail(`The measurement needs 1 to ${MAX_METRIC_REPEATS} repeats and an allowed spread of 1 to 100 %.`);
  }
  const phases = validatePhases(input.phases, check.metrics);
  if (!phases.ok) {
    return fail(`The phases are not valid: ${phases.error}. Nothing was authorized.`);
  }
  const context = await host.testCommandContext(scope.root);
  if (!context.allowlist.some((entry) => entry.id === check.commandId) || context.packageJsonRaw.length === 0) {
    return fail(`${String(check.commandId).slice(0, 60)} is not an allowlisted test command of this project. Nothing was authorized.`);
  }
  if (!Array.isArray(check.files) || check.files.length === 0 || check.files.length > 20) {
    return fail('The measurement needs the files that define it (1 to 20). Nothing was authorized.');
  }
  const files: Array<{ path: string; hash: string }> = [];
  for (const file of check.files) {
    const hash = await currentFileHash(scope.fs, file);
    if (hash === null) {
      return fail(`The check file ${String(file).slice(0, 120)} does not exist in this project. Nothing was authorized.`);
    }
    if (CASES_FILE.test(file)) {
      const parsed = parseCasesSpec(await scope.fs.readText(file).catch(() => ''));
      if (!parsed.ok) {
        return fail(`The functional cases ${file} are not valid: ${parsed.error}. Nothing was authorized.`);
      }
    }
    if (REFERENCE_FILE.test(file)) {
      const parsed = parseReferenceSpec(await scope.fs.readText(file).catch(() => ''));
      if (!parsed.ok) {
        return fail(`The reference ${file} is not valid: ${parsed.error}. Nothing was authorized.`);
      }
    }
    files.push({ path: file, hash });
  }
  const now = Date.now();
  const mode = await currentVerificationMode();
  return host.programmes.create({
    id: `prg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    scopeId: scope.scopeId,
    root: scope.root,
    goal,
    check: { commandId: check.commandId, files, packageJsonHash: hashContent(context.packageJsonRaw), metrics: [...check.metrics], repeats, maxSpreadPct },
    phases: newPhases(phases.phases),
    baseline: null,
    lease: null,
    nextFence: 0,
    status: 'active',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    note: `Authorized by the user. Phase 1 measures the baseline. ${verificationLabel(mode)}.${mode.kind === 'unprotected' ? ` ${UNPROTECTED_VERIFICATION_WARNING}` : ''}`,
  });
}

async function measureJob(host: ProgrammeHost, programme: ProgrammeRecord, repeat: number, mode: VerificationMode): Promise<NewJob> {
  const command = (await host.testCommandContext(programme.root)).allowlist.find((entry) => entry.id === programme.check.commandId);
  if (command === undefined) {
    throw new Error(`${programme.check.commandId} is no longer allowlisted`);
  }
  const scratch = path.join(host.jobs.root, '..', 'programmes', programme.id, `scratch-run${repeat}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const metricDir = await mkdtemp(path.join(host.jobs.root, 'programme-metrics-'));
  const resultsFile = path.join(metricDir, 'declared.json');
  const env = { RAME_JOB: '1', TMPDIR: scratch, TMP: scratch, TEMP: scratch, [METRIC_RESULTS_ENV]: resultsFile };
  const container = host.settings.jobs?.container ?? null;
  let spec: JobSpec;
  if (container === null) {
    const isFile = (candidate: string): boolean => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    };
    const invocation = resolveTestInvocation(command, { platform: process.platform, pathEnv: process.env.PATH, cwd: programme.root, isFile });
    const snapshot = await snapshotProject(programme.root);
    if (!snapshot.ok || snapshot.unreadable.length > 0) throw new Error('the project cannot be recorded for protected measurement');
    const readable = [...snapshot.files.keys()].filter((file) => !HOST_SPEC_FILE.test(file) && !protectedVerifierSecret(file));
    const access = protectedProjectAccess(programme.root, readable, [], scratch);
    if (!access.ok) throw new Error(access.error);
    const isolated = mode.kind === 'protected' ? protectedVerifierInvocation(invocation.executable, invocation.argv, {
      ...access.access,
      readFiles: [...access.access.readFiles, ...invocation.argv.filter((part) => path.isAbsolute(part))],
      // Keep Programme measurements on the same active Node toolchain as
      // RAME; otherwise a denied NVM npm can fall through to /usr/bin/npm.
      readTrees: [...(access.access.readTrees ?? []), path.dirname(path.dirname(process.execPath))],
      writeTrees: [...(access.access.writeTrees ?? []), metricDir],
    }) : invocation;
    spec = { executable: isolated.executable, argv: isolated.argv, cwd: programme.root, timeoutMs: MEASURE_JOB_TIMEOUT_MS, maxLogBytes: DEFAULT_JOB_LOG_BYTES, heartbeatMs: DEFAULT_JOB_HEARTBEAT_MS, env, keepElectronRunAsNode: false, cleanup: null };
  } else {
    const user = typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : null;
    const containerResults = '/rame-results/declared.json';
    spec = buildContainerJob(
      {
        executable: command.executable,
        argv: command.argv,
        projectRoot: programme.root,
        timeoutMs: MEASURE_JOB_TIMEOUT_MS,
        containerName: `rame-job-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        user,
        env: { ...env, [METRIC_RESULTS_ENV]: containerResults },
        extraMounts: [{ hostPath: metricDir, containerPath: '/rame-results' }],
        hiddenFiles: programme.check.files.filter((file) => HOST_SPEC_FILE.test(file.path)).map((file) => file.path),
      },
      container,
    );
  }
  return { scopeId: programme.scopeId, label: `${programme.check.commandId} (baseline ${repeat}/${programme.check.repeats}; ${mode.kind === 'protected' ? 'protected verification' : 'verification without isolation'})`, missionId: programme.id, spec };
}

/**
 * The host measures the baseline: each repeat is a host job (it outlives a
 * reload and is never started twice). Calling this again after a reload
 * follows the jobs already started and runs the remaining repeats.
 */
export async function runMeasurePhase(host: ProgrammeHost, programmeId: string, options: { signal?: AbortSignal; again?: boolean } = {}): Promise<ProgrammeResult<ProgrammeRecord>> {
  return withPhaseLease(host, programmeId, 0, (lease) => runMeasurePhaseOwned(host, programmeId, options, lease));
}

async function runMeasurePhaseOwned(host: ProgrammeHost, programmeId: string, options: { signal?: AbortSignal; again?: boolean }, lease: () => ProgrammePhaseLease): Promise<ProgrammeResult<ProgrammeRecord>> {
  const update = (mutate: (draft: ProgrammeRecord) => ProgrammeResult<ProgrammeRecord>) => host.programmes.updateLeased(programmeId, lease(), mutate);
  let programme = host.programmes.get(programmeId);
  if (programme === null) {
    return fail('RAME Code has no record of this programme.');
  }
  const mode = await currentVerificationMode();
  const changedMode = mode.kind === 'unprotected' && programme.note.includes('verification: protected');
  if (mode.kind === 'unprotected') {
    const marked = await update((draft) => {
      draft.note = `${UNPROTECTED_VERIFICATION_WARNING} ${verificationLabel(mode)}.${changedMode ? ` verification changed from protected to unprotected: ${mode.reason}` : ''}`;
      draft.phases[0]!.note = draft.note;
      return { ok: true, value: draft };
    });
    if (!marked.ok) return marked;
    programme = marked.value;
  }
  const first = programme.phases[0];
  if (options.again === true && first !== undefined && (first.status === 'failed' || first.status === 'inconclusive')) {
    const reset = await update((draft) => {
      Object.assign(draft.phases[0]!, { status: 'open', jobIds: [], samples: [], fingerprint: null, note: 'Measuring the baseline again, at the user\'s request.' });
      return { ok: true, value: draft };
    });
    if (!reset.ok) {
      return reset;
    }
    programme = reset.value;
  }
  const allowed = canStartPhase(programme, 0, 'measure');
  if (!allowed.ok) {
    return allowed;
  }
  const settle = (status: 'failed' | 'inconclusive' | 'running', note: string) =>
    update((draft) => {
      Object.assign(draft.phases[0]!, { status, note });
      return { ok: true, value: draft };
    });
  const tampered = await checkIntact(host, programme);
  if (tampered !== null) {
    return settle('failed', `Not verifiable: ${tampered}. The baseline was not measured.`);
  }
  if (programme.phases[0]!.fingerprint === null) {
    const print = await projectFingerprint(host, programme.root);
    if (!print.ok) {
      return settle('failed', `Not verifiable: ${print.error}.`);
    }
    const started = await update((draft) => {
      Object.assign(draft.phases[0]!, { status: 'running', fingerprint: print.print, note: 'The host is measuring the baseline.' });
      return { ok: true, value: draft };
    });
    if (!started.ok) {
      return started;
    }
    programme = started.value;
  }
  for (let repeat = 1; repeat <= programme.check.repeats; repeat++) {
    if (options.signal?.aborted) {
      return settle('running', 'Stopped before the measurement finished; resume it to follow its jobs.');
    }
    let jobId = programme.phases[0]!.jobIds[repeat - 1];
    if (jobId === undefined) {
      const intact = await checkIntact(host, programme);
      if (intact !== null) {
        return settle('failed', `Not verifiable: ${intact}. The baseline was not measured.`);
      }
      let job: NewJob;
      try {
        job = await measureJob(host, programme, repeat, mode);
      } catch (error) {
        return settle('failed', `The measurement cannot run: ${String((error as Error)?.message ?? error)}.`);
      }
      const started = await host.jobs.start(job, jobApprovalDigest(job));
      if (!started.ok) {
        return settle('failed', `Run ${repeat} of the baseline did not start: ${started.error}`);
      }
      jobId = started.value.id;
      const recorded = await update((draft) => {
        draft.phases[0]!.jobIds[repeat - 1] = jobId as string;
        draft.phases[0]!.note = `The host is measuring the baseline (run ${repeat}/${draft.check.repeats}).`;
        return { ok: true, value: draft };
      });
      if (!recorded.ok) {
        return recorded;
      }
      programme = recorded.value;
    }
    if (programme.phases[0]!.samples[repeat - 1] !== undefined) {
      continue;
    }
    const done = await host.jobs.waitFor(jobId, { pollMs: 500, ...(options.signal ? { signal: options.signal } : {}) });
    if (!done.ok) {
      return settle('failed', `Run ${repeat} of the baseline: ${done.error}`);
    }
    const job = done.value;
    if (job.status === 'starting' || job.status === 'running') {
      return settle('running', `Stopped while run ${repeat} of the baseline was running; resume it to follow job ${job.id}.`);
    }
    if (job.status === 'uncertain') {
      return settle('running', `RAME lost track of run ${repeat} of the baseline (job ${job.id}); nothing was restarted. Settle it in RAME Code: Long Jobs, then measure again.`);
    }
    if (job.status !== 'finished' || job.exit?.exitCode !== 0) {
      return settle('failed', `Run ${repeat} of the baseline did not pass: ${job.note}`);
    }
    const declaredText = await readFile(job.spec.env[METRIC_RESULTS_ENV] ?? '', 'utf8').catch(() => '');
    const declared = parseResultsFile(declaredText);
    const projectNames = programme.check.metrics.filter((name) => metricSource(name) === 'project-declared');
    if (projectNames.length > 0 && !declared.ok) {
      return settle('failed', `Run ${repeat} did not produce valid project-declared metrics: ${declared.error}`);
    }
    const values: Record<string, number> = {
      ...(declared.ok ? declared.values : {}),
      wall_ms: Math.max(0, (job.exit?.endedAt ?? job.updatedAt) - job.createdAt),
      exit_code: job.exit?.exitCode ?? -1,
    };
    const stored = await update((draft) => {
      draft.phases[0]!.samples[repeat - 1] = values;
      return { ok: true, value: draft };
    });
    if (!stored.ok) {
      return stored;
    }
    programme = stored.value;
  }
  const tamperedAfter = await checkIntact(host, programme);
  if (tamperedAfter !== null) {
    return settle('failed', `Not verifiable: ${tamperedAfter} while the baseline was measured.`);
  }
  const after = await projectFingerprint(host, programme.root);
  if (!after.ok || after.print !== programme.phases[0]!.fingerprint) {
    return settle('failed', 'Not verifiable: the project changed while the baseline was measured; a baseline must describe one unchanged project.');
  }
  const verifierSnapshot = await snapshotProject(programme.root);
  if (!verifierSnapshot.ok || verifierSnapshot.unreadable.length > 0) {
    return settle('failed', 'Not verifiable: the host could not build the protected verifier view.');
  }
  const verifierAccess = protectedProjectAccess(programme.root, [...verifierSnapshot.files.keys()].filter((file) => !HOST_SPEC_FILE.test(file) && !protectedVerifierSecret(file)), [], null);
  if (!verifierAccess.ok) {
    return settle('failed', `Not verifiable: ${verifierAccess.error}.`);
  }
  // The baseline must describe a project that works: its functional cases pass on it, unchanged.
  let casesNote = '';
  for (const file of programme.check.files.filter((entry) => CASES_FILE.test(entry.path))) {
    const parsed = parseCasesSpec(await host.agentFsFor(programme.root).readText(file.path).catch(() => ''));
    if (!parsed.ok) {
      return settle('failed', `Not verifiable: the functional cases ${file.path} cannot be read (${parsed.error}).`);
    }
    const outcome = await runHostCases(programme.root, parsed.spec, { timeoutMs: 120_000, isolation: host.settings.shell?.isolation ?? 'project', protectedAccess: verifierAccess.access, verificationMode: mode, ...(options.signal ? { signal: options.signal } : {}) });
    if (outcome.interrupted) {
      return settle('running', 'Stopped while the functional cases of the baseline ran; resume it.');
    }
    if (outcome.status !== 'passed') {
      return settle('failed', `The baseline project fails its own functional cases (${file.path}: ${outcome.status === 'failed' ? `${outcome.failed.length} of ${outcome.total} failed` : outcome.reason}); a baseline must describe code that works.`);
    }
    casesNote += `; functional cases ${file.path}: ${outcome.total} passed`;
  }
  // A frozen original must be able to judge: it answers every input in time and always the same way.
  for (const file of programme.check.files.filter((entry) => REFERENCE_FILE.test(entry.path))) {
    const problem = await referenceProblem(programme.root, file.path, await host.agentFsFor(programme.root).readText(file.path).catch(() => ''), options.signal, host.settings.shell?.isolation ?? 'project', verifierAccess.access, mode);
    if (problem === 'interrupted') {
      return settle('running', 'Stopped while the reference of the baseline was checked; resume it.');
    }
    if (problem !== null) {
      return settle('failed', `Not verifiable: ${problem}. The baseline was not frozen.`);
    }
    casesNote += `; reference ${file.path}: the original answers every input the same way twice`;
  }
  const casesIntact = await checkIntact(host, programme);
  if (casesIntact !== null) {
    return settle('failed', `Not verifiable: ${casesIntact} while the baseline was measured.`);
  }
  const print = programme.phases[0]!.fingerprint as string;
  const afterHostChecks = await projectFingerprint(host, programme.root);
  if (!afterHostChecks.ok || afterHostChecks.print !== print) {
    return settle('failed', 'Not verifiable: the project changed while the baseline\'s functional or reference checks ran; a baseline must describe one unchanged project.');
  }
  const summary = summarizeSamples(programme.check.metrics, programme.phases[0]!.samples, programme.check.maxSpreadPct);
  if (summary.missing.length > 0) {
    return settle('failed', `The baseline is incomplete: ${summary.missing.join(', ')} missing from the results.`);
  }
  if (summary.unstable.length > 0) {
    return settle('inconclusive', `The baseline is inconclusive: ${summary.unstable.join(', ')} varied more than ${programme.check.maxSpreadPct}% between runs. It was not frozen; measure again.`);
  }
  return update((draft) => {
    draft.baseline = { values: summary.values, projectFingerprint: print, measuredAt: Date.now() };
    Object.assign(draft.phases[0]!, { status: 'verified', note: `Baseline judged and frozen (${verificationLabel(mode)}): ${describeBaseline(draft.baseline)}${casesNote}.` });
    const next = draft.phases[1];
    if (next !== undefined && next.status === 'locked') {
      next.status = 'open';
      next.note = 'Ready: start its Mission.';
    }
    return { ok: true, value: draft };
  });
}

/**
 * Open a Mission phase with a Mission the user planned: its measured
 * criteria are fixed from the frozen baseline and authorized with the
 * Mission. The project must still be exactly the one the baseline measured.
 */
export async function startMissionPhase(host: ProgrammeHost, programmeId: string, index: number, missionId: string, missionRevision: number): Promise<ProgrammeResult<ProgrammeRecord>> {
  const opened = await withPhaseLease(host, programmeId, index, (lease) => startMissionPhaseOwned(host, programmeId, index, missionId, missionRevision, lease));
  return opened.ok ? refreshProgramme(host, programmeId) : opened;
}

async function startMissionPhaseOwned(host: ProgrammeHost, programmeId: string, index: number, missionId: string, missionRevision: number, lease: () => ProgrammePhaseLease): Promise<ProgrammeResult<ProgrammeRecord>> {
  const programme = host.programmes.get(programmeId);
  if (programme === null) {
    return fail('RAME Code has no record of this programme.');
  }
  const allowed = canStartPhase(programme, index, 'mission');
  if (!allowed.ok) {
    return allowed;
  }
  const mission = host.missions.get(missionId);
  if (mission === null || mission.scopeId !== programme.scopeId || mission.grant !== null) {
    return fail('That Mission cannot run this phase: it must be a new, not yet authorized Mission of the same project.');
  }
  if (programme.phases.some((phase) => phase.missionId === missionId)) {
    return fail('That Mission already ran a phase of this programme.');
  }
  const tampered = await checkIntact(host, programme);
  if (tampered !== null) {
    return fail(`The baseline is no longer valid: ${tampered}. Nothing was authorized.`);
  }
  if (allowed.phase.relative.length > 0) {
    const print = await projectFingerprint(host, programme.root);
    if (!print.ok || print.print !== programme.baseline?.projectFingerprint) {
      return fail('The project changed since the baseline was measured, so the baseline no longer describes the starting point. Measure it again. Nothing was authorized.');
    }
  }
  const criteria = resolveCriteria(allowed.phase, programme.baseline);
  if (!criteria.ok) {
    return fail(`The criteria cannot be fixed: ${criteria.error}. Nothing was authorized.`);
  }
  const opened = await host.programmes.updateLeased(programmeId, lease(), (draft) => {
    Object.assign(draft.phases[index]!, { status: 'running', missionId, resolved: criteria.criteria, note: `Its Mission runs with criteria fixed from the baseline: ${criteria.criteria.map((entry) => `${entry.metric} ${entry.op} ${entry.value}`).join('; ')}.` });
    return { ok: true, value: draft };
  });
  if (!opened.ok) {
    return opened;
  }
  await host.startMission(missionId, missionRevision, 'autonomous-workspace', null, true, {
    commandId: programme.check.commandId,
    files: programme.check.files.map((file) => file.path),
    metrics: { criteria: criteria.criteria, repeats: programme.check.repeats, maxSpreadPct: programme.check.maxSpreadPct },
  });
  return opened;
}

/** Follow the running Mission phases: a phase is verified only from the host's record. */
export async function refreshProgramme(host: ProgrammeHost, programmeId: string): Promise<ProgrammeResult<ProgrammeRecord>> {
  const programme = host.programmes.get(programmeId);
  if (programme === null) {
    return fail('RAME Code has no record of this programme.');
  }
  const driving = programme.phases.find((phase) => phase.kind === 'mission' && phase.status === 'running');
  if (driving === undefined) {
    return { ok: true, value: programme };
  }
  return withPhaseLease(host, programmeId, driving.index, (lease) => refreshProgrammeOwned(host, programmeId, lease));
}

async function refreshProgrammeOwned(host: ProgrammeHost, programmeId: string, lease: () => ProgrammePhaseLease): Promise<ProgrammeResult<ProgrammeRecord>> {
  const authorizationNote = host.status;
  return host.programmes.updateLeased(programmeId, lease(), (draft) => {
    for (const phase of draft.phases) {
      if (phase.kind !== 'mission' || phase.status !== 'running' || phase.missionId === null) {
        continue;
      }
      const mission = host.missions.get(phase.missionId);
      if (mission !== null && mission.grant === null) {
        Object.assign(phase, { status: 'open', missionId: null, resolved: null, note: `Its Mission was not authorized (${authorizationNote.slice(0, 200)}); start the phase again.` });
        continue;
      }
      const verdict = missionPhaseVerified(draft, phase, mission);
      if (verdict.verified) {
        phase.status = 'verified';
        phase.note = `Verified by the host: ${verdict.reason}`;
        const next = draft.phases[phase.index + 1];
        if (next !== undefined && next.status === 'locked') {
          next.status = 'open';
          next.note = 'Ready: start its Mission.';
        }
      } else if (mission !== null && mission.status === 'blocked' && acceptanceState(mission).state === 'inconclusive') {
        // Measured twice by the host and unreliable both times: not verified, and not a failure of the code.
        phase.status = 'inconclusive';
        phase.note = `Inconclusive, not a failure: the host measured its Mission's check twice and both measurements were unreliable (${mission.note.slice(0, 200)}). Reopen the phase when the machine is less busy.`;
      } else if (mission === null || ['failed', 'cancelled', 'blocked'].includes(mission.status)) {
        phase.status = 'failed';
        phase.note = `Not verified: ${verdict.reason}${mission ? ` (${mission.note.slice(0, 200)})` : ''}.`;
      } else if (mission.status === 'completed') {
        phase.status = 'failed';
        phase.note = `Not verified: ${verdict.reason}. A Mission that says it is done does not count without the host's measurement.`;
      } else {
        phase.note = `Its Mission is ${mission.status}.`;
      }
    }
    if (draft.phases.every((phase) => phase.status === 'verified')) {
      draft.status = 'completed';
      draft.note = 'Every phase was verified by the host.';
    }
    return { ok: true, value: draft };
  });
}

/** The user reopens a failed or inconclusive Mission phase to run it with a new Mission. */
export async function reopenPhase(host: ProgrammeHost, programmeId: string, index: number): Promise<ProgrammeResult<ProgrammeRecord>> {
  return withPhaseLease(host, programmeId, index, (lease) => host.programmes.updateLeased(programmeId, lease(), (draft) => {
    const phase = draft.phases[index];
    if (phase === undefined || phase.kind !== 'mission' || (phase.status !== 'failed' && phase.status !== 'inconclusive')) {
      return { ok: false, error: 'Only a failed Mission phase can be reopened.' };
    }
    Object.assign(phase, { status: 'open', missionId: null, resolved: null, note: 'Reopened by the user: start it with a new Mission.' });
    return { ok: true, value: draft };
  }));
}
