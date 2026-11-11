/**
 * The host's own run of a protected acceptance check before a Mission can
 * end, and what that run may conclude.
 *
 * A pass needs all of this, checked by the host itself:
 *   1. every frozen file and package.json still has its granted hash, before
 *      and after the run;
 *   2. every other project file is as the host recorded it at authorization
 *      (SHA-256 of its bytes) before the check, after it and after the
 *      host-compared cases, except the writable code under test, the
 *      outputs, new code the code under test loads, and files the user
 *      approves in a scope review (see `acceptanceManifest.ts`);
 *   2b. where kernel change times can be trusted (not Windows), no such
 *      file was written, replaced, added or removed between those records
 *      even if restored: guarantee B. Elsewhere only the start and end state
 *      is claimed, and the note says so;
 *   3. the run was observed to its end, and the trace (a discovery aid) shows
 *      nothing outside the authorized scope;
 *   4. the frozen command exited 0;
 *   5. at the reinforced level, every host-compared case returned the
 *      expected value, and no code but the check read the cases.
 *
 * Anything RAME cannot verify is reported as such (`unverifiable`): never a
 * pass, and never a failure the agent is asked to fix.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { currentFileHash } from './agentController.js';
import type { AgentFs } from './agentHost.js';
import { hashContent } from './agentPatch.js';
import { diffBaseline, judgeChanges, type AcceptanceManifest, type ProjectChange } from './acceptanceManifest.js';
import { runTraced } from './acceptanceScopeHost.js';
import { parseTrace, scopeViolations, TRACE_RUNTIME_DIR, type ParsedTrace } from './acceptanceTrace.js';
import { CASES_FILE, parseCasesSpec, runHostCases } from './hostCases.js';
import { type FrozenReference, HOST_SPEC_FILE, runDifferential } from './referenceCheck.js';
import { metricSource, METRIC_RESULTS_ENV, parseResultsFile, type CheckResult } from './metricAcceptance.js';
import { runMeasuredAcceptance } from './metricRun.js';
import type { MissionRecord } from './missionStore.js';
import type { ProviderHost } from './providerTypes.js';
import { protectedProjectAccess, protectedVerifierSecret } from './protectedVerifier.js';
import { currentVerificationMode, type VerificationMode } from './shellIsolation.js';
import type { CommandIsolation } from './settingsStore.js';
import { changeTimesTrusted, FINGERPRINT_VERSION, foldersTouched, printsOf, snapshotProject, touchedBetween, type Snapshot } from './projectSnapshot.js';

/**
 * `tampered`: the criteria themselves changed. `unverifiable`: RAME cannot
 * verify the run against what the user authorized. `approved`: files the
 * user approved as writable in a scope review during this run.
 */
export type AcceptanceResult = CheckResult;

/** A protected→unprotected transition is evidence, never a reason to stop the same Mission. */
export function verificationChanged(mission: Pick<MissionRecord, 'evidence'>, mode: VerificationMode): boolean {
  const earlier = [...(mission.evidence ?? [])].reverse().find((entry) => /verification: (?:protected|unprotected)/.test(entry.text));
  return mode.kind === 'unprotected' && earlier?.text.includes('verification: protected') === true;
}

type Frozen = ReadonlyArray<{ path: string; hash: string }>;

const unverifiable = (summary: string, output = ''): AcceptanceResult => ({ passed: false, summary: `not verifiable: ${summary}`, output, tampered: false, unverifiable: true });
const stopped = (commandId: string): AcceptanceResult => ({ passed: false, summary: `${commandId} was stopped before it finished`, output: '', tampered: false, interrupted: true });
const list = (items: readonly string[], max = 4) => items.slice(0, max).join('; ') + (items.length > max ? `; and ${items.length - max} more` : '');

export async function runAcceptance(host: ProviderHost, mission: MissionRecord, root: string, fs: AgentFs): Promise<AcceptanceResult> {
  // Registered before any await: a Stop pressed at any point of this run is never lost.
  const controller = new AbortController();
  host.acceptanceController = controller;
  try {
    const mode = await currentVerificationMode();
    const changed = verificationChanged(mission, mode);
    const finish = (result: AcceptanceResult): AcceptanceResult => ({
      ...result,
      summary: `${result.summary}; verification: ${mode.kind}`,
      verification: { kind: mode.kind, reason: mode.reason, ...(changed ? { changed: true as const } : {}) },
    });
    const acceptance = mission.grant?.acceptance ?? null;
    if (acceptance?.metrics === undefined) {
      return finish(await runAcceptanceWith(host, mission, root, fs, controller, {}, mode));
    }
    // Numeric criteria: every measured run uses the host's explicit verification mode; files the
    // user approved in a scope review stay approved for the next run. An
    // inconclusive measurement is measured again once, by the host alone.
    let current = mission;
    const frozen = [...acceptance.files.map((file) => file.path), 'package.json'];
    const measured = await runMeasuredAcceptance(acceptance.metrics, root, frozen, async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'rame-metrics-'));
      const file = path.join(dir, 'declared.json');
      let run: AcceptanceResult;
      try {
        run = await runAcceptanceWith(host, current, root, fs, controller, { [METRIC_RESULTS_ENV]: file }, mode);
        if (run.passed) {
          const declared = parseResultsFile(await readFile(file, 'utf8').catch(() => ''));
          const needed = acceptance.metrics?.criteria.filter((criterion) => metricSource(criterion.metric) === 'project-declared') ?? [];
          if (needed.length > 0 && !declared.ok) {
            return { ...run, passed: false, summary: `project-declared metrics are invalid: ${declared.error}` };
          }
          const values = declared.ok ? declared.values : {};
          run = {
            ...run,
            // Host observations always win a same-named project declaration.
            hostMetrics: { ...values, ...(run.hostMetrics ?? {}) },
            metricSources: Object.fromEntries(acceptance.metrics!.criteria.map((criterion) => [criterion.metric, metricSource(criterion.metric)])),
          };
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      if (run.approved && acceptance.scope) {
        const scope = { ...acceptance.scope, writable: [...new Set([...acceptance.scope.writable, ...run.approved])] };
        current = { ...current, grant: { ...current.grant!, acceptance: { ...acceptance, scope } } };
      }
      return run;
    }, { stopped: () => controller.signal.aborted || host.disposed });
    return finish(measured);
  } finally {
    if (host.acceptanceController === controller) {
      host.acceptanceController = null;
    }
  }
}

async function frozenIntact(fs: AgentFs, files: Frozen, packageJsonHash: string): Promise<string | null> {
  for (const file of files) {
    if ((await currentFileHash(fs, file.path)) !== file.hash) {
      return `${file.path} changed since the Mission was authorized`;
    }
  }
  return (await currentFileHash(fs, 'package.json')) !== packageJsonHash ? 'package.json changed since the Mission was authorized' : null;
}

/** Paths the check itself (the command, its tooling or a frozen file) used in a run. */
function usedByCheck(trace: ParsedTrace | null, frozen: readonly string[], entries: readonly string[]): Set<string> {
  const mine = new Set([...frozen, ...entries]);
  return new Set((trace?.edges ?? []).filter((edge) => edge.by === null || mine.has(edge.by)).map((edge) => edge.path));
}

async function runAcceptanceWith(host: ProviderHost, mission: MissionRecord, root: string, fs: AgentFs, controller: AbortController, env: Record<string, string> = {}, mode: VerificationMode = { kind: 'protected', reason: '' }): Promise<AcceptanceResult> {
  const acceptance = mission.grant?.acceptance ?? null;
  if (acceptance === null) {
    return { passed: true, summary: 'no acceptance check', output: '', tampered: false };
  }
  const id = acceptance.commandId;
  const manifest = acceptance.scope;
  if (manifest === undefined) {
    return unverifiable(`${id} was authorized without a recorded scope (an earlier version of RAME); authorize the check again`);
  }
  const frozen = acceptance.files.map((file) => file.path);
  const changedFrozen = await frozenIntact(fs, acceptance.files, acceptance.packageJsonHash);
  if (changedFrozen !== null) {
    return { passed: false, summary: changedFrozen, output: '', tampered: true };
  }
  const command = (await host.testCommandContext(root)).allowlist.find((entry) => entry.id === id);
  if (!command) {
    return { passed: false, summary: `${id} is no longer allowlisted`, output: '', tampered: true };
  }
  if (manifest.fingerprint !== FINGERPRINT_VERSION) {
    return unverifiable(`${id} was authorized with an older file fingerprint (by size for large files); authorize the check again`);
  }
  const baseline = new Map(manifest.baseline);
  const record = await recordProject(root, controller);
  const before = record.snapshot;
  if (before === null) {
    return record.stopped ? stopped(id) : unverifiable(record.problem);
  }
  if (controller.signal.aborted || host.disposed) {
    return stopped(id);
  }
  const hidden = new Set(manifest.hidden);
  const access = protectedProjectAccess(
    root,
    // The implementation and its dependencies may have been created by the
    // Mission after authorization.  Give the verifier the current recorded
    // project view, then let the integrity/scope review below decide whether
    // each new path was authorized.  Host-only specifications and recognized
    // secrets remain absent from the child view.
    [...before.files.keys()].filter((file) => !hidden.has(file) && !protectedVerifierSecret(file)),
    [...manifest.writable, ...manifest.outputs],
    null,
    [TRACE_RUNTIME_DIR],
  );
  if (!access.ok) {
    return unverifiable(`the protected verifier view could not be built: ${access.error}`);
  }
  const run = await runTraced(host, command, root, false, controller, env, access.access, mode);
  if (run.interrupted || host.disposed) {
    // Paused, cancelled or closed while the check ran: not a result. The caller applies the stop.
    return stopped(id);
  }
  // After the run, the host's own record again: the code under test ran with the user's permissions.
  const changedDuring = await frozenIntact(fs, acceptance.files, acceptance.packageJsonHash);
  if (changedDuring !== null) {
    return { passed: false, summary: `${changedDuring} (during the check)`, output: run.output, tampered: true };
  }
  const recordMid = await recordProject(root, controller);
  const mid = recordMid.snapshot;
  if (mid === null) {
    return recordMid.stopped ? stopped(id) : unverifiable(recordMid.problem, run.output);
  }
  const exit = /^exit=(\d+)/.exec(run.output);
  const code = exit ? Number(exit[1]) : null;
  if (run.trace === null || !run.trace.complete) {
    // Fail closed: an exit code RAME could not observe to its end is not a pass.
    return { passed: false, summary: `${id} exit=${code ?? 'unknown'}, but RAME could not observe the check to its end; not counted as a pass`, output: run.output, tampered: false };
  }
  const authorized = { frozen, writable: manifest.writable, outputs: manifest.outputs, sealed: manifest.sealed, observed: manifest.observed, entries: manifest.entries };
  const violations = scopeViolations(run.trace, authorized);
  if (violations.length > 0) {
    return unverifiable(`${list(violations)}. Authorize the check again with its real scope`, run.output);
  }
  const used = usedByCheck(run.trace, frozen, manifest.entries);
  let judged = judgeRecords(baseline, [before, mid], manifest, frozen, used);
  if (judged.blocking.length > 0) {
    return unverifiable(`files changed outside the scope you authorized: ${list(judged.blocking)}`, run.output);
  }
  if (code !== 0) {
    return { passed: false, summary: `${id} exit=${code ?? 'unknown'} with every frozen file intact`, output: run.output, tampered: false };
  }
  const reinforced = await runFrozenCases(
    acceptance.files,
    root,
    fs,
    controller,
    acceptance.references ?? [],
    host.settings.shell?.isolation ?? 'project',
    [...mid.files.keys()].filter((file) => !hidden.has(file) && !protectedVerifierSecret(file)),
    mode,
  );
  if (reinforced.kind === 'interrupted' || host.disposed) {
    return stopped(id);
  }
  if (reinforced.kind === 'unverifiable') {
    return unverifiable(reinforced.summary, run.output);
  }
  if (reinforced.kind === 'tampered' || reinforced.kind === 'failed') {
    return { passed: false, summary: `${id} exit=0 with every frozen file intact, but ${reinforced.summary}`, output: run.output, tampered: reinforced.kind === 'tampered' };
  }
  if (reinforced.kind === 'passed') {
    // The code under test ran again in the case runner: record the project once more.
    const recordAfter = await recordProject(root, controller);
    if (recordAfter.snapshot === null) {
      return recordAfter.stopped ? stopped(id) : unverifiable(recordAfter.problem, run.output);
    }
    judged = judgeRecords(baseline, [before, mid, recordAfter.snapshot], manifest, frozen, used);
    if (judged.blocking.length > 0) {
      return unverifiable(`files changed outside the scope you authorized: ${list(judged.blocking)}`, run.output);
    }
  }
  let approved: string[] | undefined;
  if (judged.review.length > 0) {
    // Changes the host cannot attribute: the user decides, after seeing them.
    const confirmed = host.confirmAcceptanceScopeChange ? await host.confirmAcceptanceScopeChange({ commandId: id, changes: judged.review }) : false;
    if (host.disposed || controller.signal.aborted) {
      return stopped(id);
    }
    if (!confirmed) {
      return unverifiable(`files changed outside the scope you authorized and you did not approve them: ${list(judged.review.map((entry) => `${entry.path} (${entry.change})`))}`, run.output);
    }
    approved = judged.review.map((entry) => entry.path);
  }
  // Guarantee B (no change in between) only where kernel change times can be trusted.
  const integrity = judged.duringObserved ? 'host file record before, during and after the run' : 'host file record at start and end only';
  const node = run.trace.nodeVersions.length > 0 ? `; Node ${run.trace.nodeVersions.join(', ')}` : '';
  const level =
    reinforced.kind === 'passed'
      ? `; reinforced level: ${reinforced.summary}; ${integrity}`
      : `; ${mode.kind === 'protected' ? 'protected verification' : 'verification without isolation'} (frozen check exit code; ${integrity}; no host-compared cases)`;
  return {
    passed: true,
    summary: `${id} exit=0 with every frozen file intact${level}${node}`,
    output: run.output,
    tampered: false,
    hostMetrics: { wall_ms: run.elapsedMs, exit_code: 0 },
    ...(approved ? { approved } : {}),
  };
}

/** One host record of the project; on failure, why (or that it was stopped). */
async function recordProject(root: string, controller: AbortController): Promise<{ snapshot: Snapshot & { ok: true }; stopped: false; problem: '' } | { snapshot: null; stopped: boolean; problem: string }> {
  const snapshot = await snapshotProject(root, { signal: controller.signal });
  if (!snapshot.ok) {
    return snapshot.reason === 'aborted'
      ? { snapshot: null, stopped: true, problem: '' }
      : { snapshot: null, stopped: false, problem: `RAME could not record the project to compare it (${snapshot.reason === 'too-many-files' ? 'too many files' : snapshot.detail})` };
  }
  if (snapshot.unreadable.length > 0) {
    // A file RAME cannot read, or that changed while it was read, is never assumed intact.
    return { snapshot: null, stopped: false, problem: `RAME could not read ${list(snapshot.unreadable)} to compare it with its record` };
  }
  return { snapshot, stopped: false, problem: '' };
}

/**
 * Judge every host record of this run against the authorized baseline:
 * content differences in any record, and, where kernel change times are
 * trusted, files written, replaced, added or removed between consecutive
 * records even if restored, and files added or removed in a sealed or
 * acceptance folder.
 */
function judgeRecords(
  baseline: ReadonlyMap<string, string>,
  records: ReadonlyArray<Snapshot & { ok: true }>,
  manifest: AcceptanceManifest,
  frozen: readonly string[],
  used: ReadonlySet<string>,
): { blocking: string[]; review: ProjectChange[]; duringObserved: boolean } {
  const lists = records.map((record) => diffBaseline(baseline, printsOf(record)));
  const duringObserved = changeTimesTrusted();
  const restored = new Set<string>();
  const folderNotes: string[] = [];
  if (duringObserved) {
    const watched = [...new Set([...manifest.sealed, ...frozen.filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file)).map((file) => path.posix.dirname(file)).filter((dir) => dir !== '.')])];
    for (let i = 1; i < records.length; i += 1) {
      const earlier = records[i - 1] as Snapshot & { ok: true };
      const later = records[i] as Snapshot & { ok: true };
      const touched = touchedBetween(earlier, later);
      lists.push(touched.map((file) => ({ path: file, change: 'changed' as const })));
      for (const file of touched) {
        if (later.files.get(file)?.print === baseline.get(file)) {
          restored.add(file);
        }
      }
      for (const dir of foldersTouched(earlier, later, watched)) {
        folderNotes.push(`${dir}/ (a file was added, removed or renamed in this acceptance folder during the check)`);
      }
    }
  }
  const judged = judgeChanges(mergeChanges(...lists), manifest, frozen, used);
  const blocking = [
    ...judged.blocking.map((entry) => `${entry.path} (${entry.reason}${restored.has(entry.path) ? '; changed during the check, then restored' : ''})`),
    ...new Set(folderNotes),
  ];
  return { blocking, review: judged.review, duringObserved };
}

function mergeChanges(...lists: ProjectChange[][]): ProjectChange[] {
  const byPath = new Map<string, ProjectChange>();
  for (const entry of lists.flat()) {
    if (!byPath.has(entry.path)) {
      byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * The reinforced level: every frozen `*.rame-cases.json` is run by RAME's
 * case runner and judged here, with the expected values read from the
 * frozen file (checked against its hash) and never sent to the child. The
 * child runs under the trace: if the code under test is seen reading a
 * cases file, the run is not verifiable.
 */
async function runFrozenCases(
  files: Frozen,
  root: string,
  fs: AgentFs,
  controller: AbortController,
  references: readonly FrozenReference[] = [],
  isolation: CommandIsolation = 'project',
  visibleFiles: readonly string[] = [],
  mode: VerificationMode = { kind: 'protected', reason: '' },
): Promise<{ kind: 'none' | 'passed' | 'failed' | 'tampered' | 'interrupted' | 'unverifiable'; summary: string }> {
  const specs = files.filter((file) => CASES_FILE.test(file.path));
  if (specs.length === 0 && references.length === 0) {
    return { kind: 'none', summary: '' };
  }
  let total = 0;
  const protectedAccess = protectedProjectAccess(root, visibleFiles, [], null, [TRACE_RUNTIME_DIR]);
  if (!protectedAccess.ok) {
    return { kind: 'unverifiable', summary: `the protected case view could not be built: ${protectedAccess.error}` };
  }
  for (const file of specs) {
    let text: string;
    try {
      text = await fs.readText(file.path);
    } catch {
      return { kind: 'tampered', summary: `${file.path} could not be read` };
    }
    if (hashContent(text) !== file.hash) {
      return { kind: 'tampered', summary: `${file.path} changed since the Mission was authorized` };
    }
    const parsed = parseCasesSpec(text);
    if (!parsed.ok) {
      return { kind: 'tampered', summary: `${file.path} is not a valid cases file (${parsed.error})` };
    }
    if (controller.signal.aborted) {
      return { kind: 'interrupted', summary: '' };
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rame-cases-'));
    const traceFile = path.join(dir, 'trace.jsonl');
    try {
      const outcome = await runHostCases(root, parsed.spec, { signal: controller.signal, isolation, protectedAccess: protectedAccess.access, verificationMode: mode, trace: { file: traceFile, root, preload: path.join(TRACE_RUNTIME_DIR, 'acceptance-trace.cjs') } });
      if (outcome.interrupted) {
        return { kind: 'interrupted', summary: '' };
      }
      const trace = parseTrace(await readFile(traceFile, 'utf8').catch(() => ''));
      if (trace.processes === 0) {
        return { kind: 'unverifiable', summary: `RAME could not observe the host-compared cases in ${file.path}` };
      }
      const leaks = trace.edges.filter((edge) => HOST_SPEC_FILE.test(edge.path) && edge.kind !== 'entry').map((edge) => edge.path);
      if (leaks.length > 0) {
        return { kind: 'unverifiable', summary: `the code under test read the expected values in ${[...new Set(leaks)].join(', ')} while the host-compared cases ran` };
      }
      if (outcome.status === 'incomplete') {
        return { kind: 'failed', summary: `the host-compared cases in ${file.path} are incomplete: ${outcome.reason}` };
      }
      if (outcome.status === 'failed') {
        // The inputs of the failing cases help the agent find the fault; their expected values are never shown.
        const input = (index: number) => (JSON.stringify(parsed.spec.cases[index]?.args ?? []) ?? '').slice(1, -1).slice(0, 120);
        const first = outcome.failed.slice(0, 3).map((entry) => `case ${entry.index + 1} (${entry.call}(${input(entry.index)})) ${entry.reason}`).join('; ');
        return { kind: 'failed', summary: `${outcome.failed.length} of ${outcome.total} host-compared cases in ${file.path} failed: ${first}` };
      }
      total += outcome.total;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  // The differential comparison with the frozen original, on fresh inputs every time.
  const differential: string[] = [];
  for (const reference of references) {
    const frozenSpec = files.find((file) => file.path === reference.spec);
    let text: string;
    try {
      text = await fs.readText(reference.spec);
    } catch {
      return { kind: 'tampered', summary: `${reference.spec} could not be read` };
    }
    if (frozenSpec === undefined || hashContent(text) !== frozenSpec.hash) {
      return { kind: 'tampered', summary: `${reference.spec} changed since the Mission was authorized` };
    }
    const outcome = await runDifferential(root, reference, text, { signal: controller.signal, isolation, protectedAccess: protectedAccess.access, verificationMode: mode });
    if (outcome.kind === 'interrupted') {
      return { kind: 'interrupted', summary: '' };
    }
    if (outcome.kind !== 'passed') {
      return { kind: outcome.kind, summary: outcome.summary };
    }
    differential.push(outcome.summary);
  }
  return { kind: 'passed', summary: [...(specs.length > 0 ? [`${total} host-compared case(s) passed outside the code under test`] : []), ...differential].join('; ') };
}
