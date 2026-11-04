/**
 * The authorized scope of a protected acceptance check, kept in the Mission
 * grant, and the host's own evidence that it was respected.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * At authorization the user approves a manifest: the frozen files (by hash,
 * in the grant's `files`), the code under test that stays writable, the
 * outputs, the sealed folders and the process entry points the check runs.
 * The host also records a baseline: a fingerprint of every file in the
 * project (outside `node_modules` and `.git`).
 *
 * The baseline does not depend on any trace. Before and after every host run
 * of the check, the host fingerprints the project again. A file that changed,
 * appeared or disappeared outside the writable code and the outputs means
 * the check may no longer be judging what the user authorized:
 *   - in a sealed or acceptance folder, frozen, an environment file, used by
 *     the check (at authorization or in this run), or an existing file that
 *     is not code (data, documents, configuration: RAME cannot tell whether
 *     the check reads it): not verifiable, whatever the trace says;
 *   - a new code file outside test locations that the run shows the code
 *     under test loading: code under test, allowed;
 *   - any other new file, or an existing code file: its role is not
 *     established, so the user is asked (scope review), and until they
 *     approve it the run is not counted.
 *
 * The fingerprints come from `projectSnapshot.ts`: the SHA-256 of every
 * file's bytes, never its size alone. A file that cannot be read is not
 * verifiable. Limits: at most `MAX_BASELINE_FILES` files and 4 GiB, beyond
 * which protection is refused.
 */

import * as path from 'node:path';

import { isTestSupport } from './acceptanceDependencies.js';
import type { AgentFs } from './agentHost.js';
import { insideFolder, MAX_OBSERVED_PATHS, MAX_SEALED_FOLDERS } from './acceptanceTrace.js';
import { ACCEPTANCE_ENVIRONMENT_FILES } from './projectAdapters/npmProjectAdapter.js';
import { MAX_SNAPSHOT_FILES } from './projectSnapshot.js';
import { HIDDEN_ANSWERS_MESSAGE } from './toolResultSummary.js';

export { MAX_SNAPSHOT_FILES as MAX_BASELINE_FILES } from './projectSnapshot.js';
const MAX_LIST = 200;

export interface AcceptanceManifest {
  /** Existing code under test the user confirmed as writable (and files approved later in a scope review). */
  writable: string[];
  /** Paths the check reads that did not exist: the Mission creates them. */
  outputs: string[];
  /** Folders where nothing may be added, changed or removed. */
  sealed: string[];
  /** Every path the check was observed to use at authorization. */
  observed: string[];
  /** Process entry points the check runs inside the project. */
  entries: string[];
  /** Host-compared cases files: their expected values are hidden from the agent's tools. */
  hidden: string[];
  /** Fingerprint of every project file at authorization, sorted by path. */
  baseline: Array<[string, string]>;
  /** The Node version(s) the observation ran on. */
  node: string;
  /** Scope reviews the user approved after authorization. */
  approvals: number;
  /** How the baseline prints were made (`FINGERPRINT_VERSION`); absent in an earlier version. */
  fingerprint?: string;
}

const isPathList = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 512);

/** A stored manifest, validated; `undefined` when it is malformed. */
export function parseAcceptanceManifest(raw: unknown): AcceptanceManifest | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  if (
    !isPathList(m.writable, MAX_LIST) ||
    !isPathList(m.outputs, MAX_LIST) ||
    !isPathList(m.sealed, MAX_SEALED_FOLDERS) ||
    !isPathList(m.observed, MAX_OBSERVED_PATHS) ||
    !isPathList(m.entries, MAX_LIST) ||
    !isPathList(m.hidden, 20) ||
    !Array.isArray(m.baseline) ||
    m.baseline.length > MAX_SNAPSHOT_FILES ||
    !m.baseline.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[0].length <= 512 && typeof entry[1] === 'string' && entry[1].length <= 100) ||
    typeof m.node !== 'string' ||
    m.node.length > 80 ||
    typeof m.approvals !== 'number' ||
    !Number.isInteger(m.approvals) ||
    m.approvals < 0 ||
    (m.fingerprint !== undefined && (typeof m.fingerprint !== 'string' || m.fingerprint.length > 40))
  ) {
    return undefined;
  }
  return {
    writable: [...m.writable],
    outputs: [...m.outputs],
    sealed: [...m.sealed],
    observed: [...m.observed],
    entries: [...m.entries],
    hidden: [...m.hidden],
    baseline: (m.baseline as Array<[string, string]>).map(([file, print]) => [file, print]),
    node: m.node,
    approvals: m.approvals,
    ...(typeof m.fingerprint === 'string' ? { fingerprint: m.fingerprint } : {}),
  };
}

export function copyManifest(manifest: AcceptanceManifest): AcceptanceManifest {
  return parseAcceptanceManifest(manifest) as AcceptanceManifest;
}

export interface ProjectChange {
  path: string;
  change: 'changed' | 'added' | 'removed';
}

export function diffBaseline(before: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>): ProjectChange[] {
  const changes: ProjectChange[] = [];
  for (const [file, print] of before) {
    const current = now.get(file);
    if (current === undefined) {
      changes.push({ path: file, change: 'removed' });
    } else if (current !== print) {
      changes.push({ path: file, change: 'changed' });
    }
  }
  for (const file of now.keys()) {
    if (!before.has(file)) {
      changes.push({ path: file, change: 'added' });
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const CODE_FILE = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i;

export interface ChangeJudgement {
  /** Changes no approval can accept: the run is not verifiable. */
  blocking: Array<{ path: string; reason: string }>;
  /** Changes outside the authorized scope the user may approve as code under test. */
  review: ProjectChange[];
}

/**
 * Judge the project's changes since authorization against the manifest.
 * `frozen` are the grant's frozen files; `usedNow` the paths the check was
 * observed to use in this run (a discovery aid, may be empty).
 */
export function judgeChanges(
  changes: readonly ProjectChange[],
  manifest: AcceptanceManifest,
  frozen: readonly string[],
  usedNow: ReadonlySet<string>,
  /** Files the run showed the code under test loading (not the check): their role is established. */
  loadedByCode: ReadonlySet<string> = new Set(),
): ChangeJudgement {
  const lower = (list: readonly string[]) => new Set(list.map((entry) => entry.toLowerCase()));
  const frozenSet = lower(frozen);
  const allowed = lower([...manifest.writable, ...manifest.outputs]);
  const used = lower([...manifest.observed, ...manifest.entries, ...usedNow]);
  const acceptanceDirs = [...new Set(frozen.filter((file) => CODE_FILE.test(file)).map((file) => path.posix.dirname(file)).filter((dir) => dir !== '.'))];
  const environment = lower(ACCEPTANCE_ENVIRONMENT_FILES as readonly string[]);
  const blocking: ChangeJudgement['blocking'] = [];
  const review: ProjectChange[] = [];
  for (const entry of changes) {
    const key = entry.path.toLowerCase();
    if (allowed.has(key)) {
      continue;
    }
    const folder = [...manifest.sealed, ...acceptanceDirs].find((dir) => insideFolder(entry.path, dir));
    if (frozenSet.has(key) || key === 'package.json') {
      blocking.push({ path: entry.path, reason: 'it is frozen with the check' });
    } else if (environment.has(key)) {
      blocking.push({ path: entry.path, reason: 'it decides how the check runs' });
    } else if (folder !== undefined) {
      blocking.push({ path: entry.path, reason: `it is in the acceptance folder ${folder}` });
    } else if (used.has(key)) {
      blocking.push({ path: entry.path, reason: 'the check itself uses it' });
    } else if (entry.change !== 'added' && !CODE_FILE.test(entry.path)) {
      blocking.push({ path: entry.path, reason: 'it existed when you authorized the check and is not code; RAME cannot tell whether the check reads it' });
    } else if (entry.change === 'added' && CODE_FILE.test(entry.path) && !isTestSupport(entry.path, acceptanceDirs) && loadedByCode.has(entry.path)) {
      // New code outside test locations that the code under test loads: the code under test growing.
      continue;
    } else {
      review.push(entry);
    }
  }
  return { blocking, review };
}

/**
 * The agent's view of the workspace: the same file system, but the
 * host-compared cases files (the expected values) cannot be read through it.
 * The host reads them through its own file system.
 */
export function hideFromAgent(fs: AgentFs, hidden: () => readonly string[]): AgentFs {
  const isHidden = (rel: string) => {
    const target = rel.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    return hidden().some((file) => file.toLowerCase() === target);
  };
  return {
    ...fs,
    listEntries: fs.listEntries.bind(fs),
    stat: fs.stat.bind(fs),
    writeText: fs.writeText.bind(fs),
    readText: async (rel: string) => {
      if (isHidden(rel)) {
        throw new Error(HIDDEN_ANSWERS_MESSAGE);
      }
      return fs.readText(rel);
    },
  };
}
