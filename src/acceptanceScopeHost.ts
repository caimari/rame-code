/**
 * Host side of a protected acceptance check: run it under RAME's trace, and,
 * at authorization, decide what it freezes, what stays writable (with the
 * user's explicit confirmation) and whether it can be protected at all.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { currentFileHash } from './agentController.js';
import type { AgentFs } from './agentHost.js';
import { planAcceptanceDependencies } from './acceptanceDependencies.js';
import { MAX_BASELINE_FILES, type AcceptanceManifest } from './acceptanceManifest.js';
import { acceptanceTraceEnv, classifyAcceptanceScope, parseTrace, type ParsedTrace } from './acceptanceTrace.js';
import { CASES_FILE } from './hostCases.js';
import { FINGERPRINT_VERSION, printsOf, snapshotProject } from './projectSnapshot.js';
import type { ProviderHost } from './providerTypes.js';

/** The grant schema's ceiling on frozen files (listed, environment and verifier support). */
export const MAX_FROZEN_ACCEPTANCE_FILES = 20;
const MAX_FOLDER_FILES = 40;

type AllowedCommand = Parameters<ProviderHost['runAllowlistedTest']>[0];

/** One run of an allowlisted command under RAME's trace. `interrupted` when it was stopped. */
export async function runTraced(
  host: ProviderHost,
  command: AllowedCommand,
  root: string,
  observeOnly = false,
  given?: AbortController,
): Promise<{ output: string; trace: ParsedTrace | null; interrupted: boolean }> {
  // Registered before any await: a Stop can never fall between two steps.
  const controller = given ?? new AbortController();
  if (given === undefined) {
    host.acceptanceController = controller;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rame-trace-'));
  const file = path.join(dir, 'trace.jsonl');
  try {
    if (controller.signal.aborted) {
      return { output: '', trace: null, interrupted: true };
    }
    let output: string;
    try {
      output = await host.runAllowlistedTest(command, controller.signal, root, acceptanceTraceEnv(file, root, process.env.NODE_OPTIONS ?? '', undefined, observeOnly));
    } catch (error) {
      if (controller.signal.aborted) {
        return { output: '', trace: null, interrupted: true };
      }
      throw error;
    }
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // no trace written: the run could not be observed
    }
    return { output, trace: text.length > 0 ? parseTrace(text) : null, interrupted: false };
  } finally {
    if (given === undefined && host.acceptanceController === controller) {
      host.acceptanceController = null;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function kindOf(fs: AgentFs, rel: string): Promise<'file' | 'dir' | 'missing'> {
  try {
    const st = await fs.stat(rel);
    return st.kind === 'file' ? 'file' : st.kind === 'dir' ? 'dir' : 'missing';
  } catch {
    return 'missing';
  }
}

/** Files under a folder, or null when there are more than `budget` (never a silent partial list). */
async function filesUnder(fs: AgentFs, rel: string, budget = MAX_FOLDER_FILES): Promise<string[] | null> {
  const out: string[] = [];
  const queue = [rel];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries: Awaited<ReturnType<AgentFs['listEntries']>> = [];
    try {
      entries = await fs.listEntries(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDir && entry.name !== 'node_modules') {
        queue.push(child);
      } else if (entry.isFile) {
        out.push(child);
        if (out.length > budget) {
          return null;
        }
      }
    }
  }
  return out;
}

export type ProtectedScope =
  | { ok: true; freeze: Array<{ path: string; hash: string }>; manifest: AcceptanceManifest; notes: string[] }
  | { ok: false; error: string };

/**
 * Decide the scope of a frozen check at authorization. Runs the check once
 * under the trace (on the project as it is now), combines what it observed
 * with static analysis, refuses when anything is undetermined, and asks the
 * user to confirm every file that would stay writable.
 */
export async function protectAcceptanceScope(
  host: ProviderHost,
  fs: AgentFs,
  root: string,
  command: AllowedCommand,
  commandId: string,
  listed: ReadonlyArray<{ path: string; hash: string }>,
  projectName: string,
): Promise<ProtectedScope> {
  const listedPaths = listed.map((file) => file.path);
  const controller = new AbortController();
  host.acceptanceController = controller;
  try {
    return await protectWith(host, fs, root, command, commandId, listed, listedPaths, projectName, controller);
  } finally {
    if (host.acceptanceController === controller) {
      host.acceptanceController = null;
    }
  }
}

async function protectWith(
  host: ProviderHost,
  fs: AgentFs,
  root: string,
  command: AllowedCommand,
  commandId: string,
  listed: ReadonlyArray<{ path: string; hash: string }>,
  listedPaths: string[],
  projectName: string,
  controller: AbortController,
): Promise<ProtectedScope> {
  const plan = await planAcceptanceDependencies(fs, listedPaths, projectName);
  host.status = `Observing what the acceptance check ${commandId} loads and reads…`;
  await host.postState();
  // Observation only: missing code under test is stubbed so the check runs further.
  const run = await runTraced(host, command, root, true, controller);
  if (run.interrupted || host.disposed) {
    return { ok: false, error: 'The acceptance check was stopped while RAME observed it. Nothing was authorized.' };
  }
  const candidates = new Set<string>([...(run.trace?.edges ?? []).map((edge) => edge.path)]);
  const kinds = new Map<string, 'file' | 'dir' | 'missing'>();
  const folders = new Map<string, string[] | null>();
  for (const rel of candidates) {
    const kind = await kindOf(fs, rel);
    kinds.set(rel, kind);
    if (kind === 'dir') {
      folders.set(rel, await filesUnder(fs, rel));
    }
  }
  const scope = classifyAcceptanceScope({
    listed: listedPaths,
    staticVerifier: plan.ok ? plan.freeze : [],
    staticSubjects: plan.ok ? plan.subjects : [],
    staticProblem: plan.ok ? null : plan.error,
    trace: run.trace,
    kind: (rel) => kinds.get(rel) ?? 'missing',
    filesUnder: (rel) => folders.get(rel) ?? null,
  });
  if (scope.undetermined.length > 0) {
    return {
      ok: false,
      error:
        `The acceptance check ${commandId} cannot be protected: ${scope.undetermined.slice(0, 3).join('; ')}. Nothing was authorized. ` +
        'Fix the check, or authorize the Mission without an acceptance check (conventional verification: its own passing tests, with no protected acceptance).',
    };
  }
  const freeze: Array<{ path: string; hash: string }> = [];
  for (const file of scope.verifier) {
    const hash = await currentFileHash(fs, file);
    if (hash === null) {
      return { ok: false, error: `The acceptance check uses ${file.slice(0, 120)}, which cannot be read to freeze it. Nothing was authorized.` };
    }
    freeze.push({ path: file, hash });
  }
  if (listed.length + freeze.length > MAX_FROZEN_ACCEPTANCE_FILES) {
    return { ok: false, error: `The acceptance check and the files it uses come to ${listed.length + freeze.length} files; at most ${MAX_FROZEN_ACCEPTANCE_FILES} can be frozen. Nothing was authorized.` };
  }
  if (scope.writable.length > 0 || scope.outputs.length > 0) {
    const confirmed = host.confirmAcceptanceScope
      ? await host.confirmAcceptanceScope({ commandId, frozen: [...listedPaths, ...freeze.map((file) => file.path), 'package.json'], writable: scope.writable, outputs: scope.outputs, sealed: scope.sealed })
      : false;
    if (!confirmed || host.disposed) {
      return { ok: false, error: `You did not confirm which files the acceptance check ${commandId} leaves writable. Nothing was authorized.` };
    }
  }
  // The host's own evidence, independent of the trace: every project file, as
  // it is now that the user authorizes (after the observation run).
  const snapshot = await snapshotProject(root, { signal: controller.signal });
  if (!snapshot.ok) {
    return {
      ok: false,
      error:
        snapshot.reason === 'aborted'
          ? 'RAME was stopped while it recorded the project. Nothing was authorized.'
          : `RAME cannot keep its own record of this project (${snapshot.reason === 'too-many-files' ? `more than ${MAX_BASELINE_FILES} files outside node_modules and .git` : snapshot.detail}), so the check cannot be protected. Nothing was authorized.`,
    };
  }
  if (snapshot.unreadable.length > 0) {
    return { ok: false, error: `RAME cannot read ${snapshot.unreadable.slice(0, 3).join(', ')} to record it, so the check cannot be protected. Nothing was authorized.` };
  }
  const baseline = printsOf(snapshot);
  if (host.disposed) {
    return { ok: false, error: 'This window was closed while RAME authorized the check. Nothing was authorized.' };
  }
  const nodeVersions = run.trace?.nodeVersions ?? [];
  const manifest: AcceptanceManifest = {
    writable: scope.writable,
    outputs: scope.outputs,
    sealed: scope.sealed,
    observed: scope.observed,
    entries: scope.entries,
    hidden: listedPaths.filter((file) => CASES_FILE.test(file)),
    baseline: [...baseline.entries()],
    node: nodeVersions.join(', ').slice(0, 80),
    approvals: 0,
    fingerprint: FINGERPRINT_VERSION,
  };
  const stubbed = run.trace?.edges.some((edge) => edge.kind === 'missing-module') === true;
  const exit = /^exit=(\d+)/.exec(run.output);
  const list = (files: string[]) => (files.length > 0 ? files.slice(0, 6).join(', ') : 'none');
  const notes = [
    `acceptance ${commandId} protected: also froze ${list(freeze.map((file) => file.path))}; ` +
      `writable code under test, confirmed by the user: ${list(scope.writable)}; outputs: ${list(scope.outputs)}; ` +
      (stubbed ? 'before any change: no result (the code under test did not exist yet)' : `before any change it exited ${exit ? exit[1] : 'unknown'}`),
    `acceptance scope recorded by the host: sealed folders ${list(scope.sealed)}; ${scope.entries.length} process entry point(s); ` +
      `${baseline.size} project file(s) fingerprinted (SHA-256 of their bytes); observed on Node ${manifest.node || 'unknown'}`,
  ];
  return { ok: true, freeze, manifest, notes: notes.map((text) => text.slice(0, 300)) };
}
