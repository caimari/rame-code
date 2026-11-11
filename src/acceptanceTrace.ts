/**
 * What a frozen acceptance check actually runs, loads and reads, observed by
 * RAME's own preload (`runtime/acceptance-trace.cjs` and the ESM hooks it
 * registers), and how those files are classified.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Classification, from the files the user froze outward along the observed
 * process entries, loads and reads (and the literal ones static analysis
 * found):
 *   - verifier: test support (see `isTestSupport`) reached from the check.
 *     Frozen with it; what it loads is followed in turn.
 *   - writable: an existing file outside test locations that the check loads
 *     or reads: the code under test, or data the user must confirm.
 *   - output: a path the check reads that does not exist yet.
 *   - undetermined: anything RAME cannot classify safely. Any undetermined
 *     dependency means the check cannot be offered as protected.
 *
 * An access with no project file on the stack (`by: null`) was made by the
 * command itself or its tooling (npm, the test runner): it counts as the
 * check's own, never as nobody's. A process entry point started by the
 * command, or by a verifier file, is part of the check too.
 *
 * The trace runs in the same process as the code under test, which can
 * tamper with it. It is a discovery aid. The host's own evidence is the hash
 * of every project file (see `acceptanceManifest.ts`), not this trace.
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isTestSupport } from './acceptanceDependencies.js';
import { ACCEPTANCE_ENVIRONMENT_FILES } from './projectAdapters/npmProjectAdapter.js';

export interface TraceEdge {
  /**
   * `entry`: the entry point of a traced process (`by`: the entry point of
   * the traced process that started it, or null for the command itself).
   * `missing-module`: a relative module that did not exist when observed (stubbed).
   */
  kind: 'module' | 'read' | 'missing-module' | 'entry';
  path: string;
  by: string | null;
}

export interface ParsedTrace {
  edges: TraceEdge[];
  /** Every traced process started and reached its exit handler. */
  complete: boolean;
  /** Every traced process could register the ESM hooks. */
  esm: boolean;
  processes: number;
  /** The Node versions the traced processes reported (`process.version`). */
  nodeVersions: string[];
}

export const TRACE_RUNTIME_DIR = path.join(__dirname, '..', '..', 'runtime');
const MAX_TRACE_EDGES = 5_000;
/** Bounds of what the grant records about the check's observed scope. */
export const MAX_OBSERVED_PATHS = 500;
export const MAX_SEALED_FOLDERS = 20;

/** Environment for one traced run: RAME's preload and ESM hooks, appended to any NODE_OPTIONS. */
export function acceptanceTraceEnv(traceFile: string, root: string, baseNodeOptions = '', runtimeDir = TRACE_RUNTIME_DIR, stubMissing = false): Record<string, string> {
  const preload = path.join(runtimeDir, 'acceptance-trace.cjs');
  const register = pathToFileURL(path.join(runtimeDir, 'acceptance-trace-register.mjs')).href;
  const quote = (value: string) => `"${value.replace(/(["\\])/g, '\\$1')}"`;
  return {
    RAME_TRACE_FILE: traceFile,
    RAME_TRACE_ROOT: root,
    RAME_TRACE_PARENT: '',
    ...(stubMissing ? { RAME_TRACE_STUB_MISSING: '1' } : {}),
    NODE_OPTIONS: `${baseNodeOptions} --require ${quote(preload)} --import ${quote(register)}`.trim(),
  };
}

const EDGE_KINDS = new Set(['module', 'read', 'missing-module', 'entry']);

export function parseTrace(text: string): ParsedTrace {
  const edges: TraceEdge[] = [];
  const started = new Set<number>();
  const ended = new Set<number>();
  const versions = new Set<string>();
  let esm = true;
  const seen = new Set<string>();
  const result = (complete: boolean): ParsedTrace => ({ edges, complete, esm, processes: started.size, nodeVersions: [...versions].sort() });
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return result(false);
    }
    if (entry.kind === 'start' && typeof entry.pid === 'number') {
      started.add(entry.pid);
      esm &&= entry.esm === true;
      if (typeof entry.node === 'string') {
        versions.add(entry.node.slice(0, 32));
      }
    } else if (entry.kind === 'end' && typeof entry.pid === 'number') {
      ended.add(entry.pid);
    } else if (EDGE_KINDS.has(String(entry.kind)) && typeof entry.path === 'string' && (entry.by === null || entry.by === undefined || typeof entry.by === 'string')) {
      const by = typeof entry.by === 'string' ? entry.by : null;
      const key = `${String(entry.kind)}\0${entry.path}\0${by ?? ''}`;
      if (!seen.has(key) && edges.length < MAX_TRACE_EDGES) {
        seen.add(key);
        edges.push({ kind: entry.kind as TraceEdge['kind'], path: entry.path, by });
      }
    } else {
      // A line RAME's preload never writes: the trace is not RAME's alone.
      return result(false);
    }
  }
  return result(started.size > 0 && [...started].every((pid) => ended.has(pid)) && edges.length < MAX_TRACE_EDGES);
}

/**
 * Paths that never need classifying: installed packages, and files covered by
 * other rules (package.json and the environment files are frozen by hash when
 * present, and the host's project baseline refuses them when they appear).
 */
export function ignoredPath(rel: string): boolean {
  return rel.split('/').includes('node_modules') || rel === 'package.json' || rel.endsWith('/package.json') || (ACCEPTANCE_ENVIRONMENT_FILES as readonly string[]).includes(rel);
}

export function scriptFolders(files: readonly string[]): string[] {
  return [...new Set(files.filter((file) => /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i.test(file)).map((file) => path.posix.dirname(file)).map((dir) => (dir === '.' ? '' : dir)))];
}

export interface AcceptanceScope {
  /** Verifier files to freeze, beyond the ones the user listed. */
  verifier: string[];
  /** Existing files outside test locations the check loads or reads: writable only if the user confirms. */
  writable: string[];
  /** Paths the check reads that do not exist yet: the Mission's outputs. */
  outputs: string[];
  /** Folders the check runs or lists, and the acceptance files' own folders: nothing may be added, changed or removed there. */
  sealed: string[];
  /** Every path the check itself was observed to use. */
  observed: string[];
  /** Process entry points the check runs inside the project. */
  entries: string[];
  /** Why the check cannot be offered as protected; empty when it can. */
  undetermined: string[];
}

export interface ScopeInput {
  /** Files the user froze, plus environment files. */
  listed: readonly string[];
  /** Test support static analysis found through literal loads and reads. */
  staticVerifier: readonly string[];
  /** Code under test static analysis found (possibly "(not created yet)"). */
  staticSubjects: readonly string[];
  /** Static analysis could not determine some load (its reason), if any. */
  staticProblem: string | null;
  trace: ParsedTrace | null;
  /** What exists at authorization. */
  kind(rel: string): 'file' | 'dir' | 'missing';
  /** Files under a directory, or null when there are too many to freeze. */
  filesUnder(rel: string): string[] | null;
}

/** Classify every dependency of a frozen check, conservatively. */
export function classifyAcceptanceScope(input: ScopeInput): AcceptanceScope {
  const undetermined: string[] = [];
  if (input.staticProblem !== null) {
    undetermined.push(input.staticProblem.replace(/\.\s*$/, ''));
  }
  const trace = input.trace;
  if (trace === null || trace.processes === 0) {
    undetermined.push('the check could not be observed while it ran, so what it loads is unknown');
  } else if (!trace.complete) {
    undetermined.push('the check did not run to its end under observation (killed, timed out, or its trace was cut short)');
  }
  const acceptanceDirs = scriptFolders(input.listed);
  if (trace !== null && !trace.esm && input.listed.some((file) => /\.m[jt]s$/i.test(file))) {
    undetermined.push('this Node version cannot observe ES module loads, and the check is an ES module');
  }
  const verifier = new Set<string>([...input.listed, ...input.staticVerifier]);
  const writable = new Set<string>();
  const outputs = new Set<string>();
  const sealed = new Set<string>(acceptanceDirs.filter((dir) => dir !== ''));
  const observed = new Set<string>();
  const entries = new Set<string>();
  for (const subject of input.staticSubjects) {
    if (subject.endsWith(' (not created yet)')) {
      outputs.add(subject.replace(/ \(not created yet\)$/, ''));
    } else {
      writable.add(subject);
    }
  }
  const edges = trace?.edges ?? [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of edges) {
      // No project file on the stack: the command or its tooling did it. A
      // process the check started (its entry, possibly a folder) is the check too.
      const fromVerifier = edge.by === null || verifier.has(edge.by) || entries.has(edge.by);
      if (!fromVerifier || ignoredPath(edge.path)) {
        continue;
      }
      observed.add(edge.path);
      if (edge.kind === 'entry' && !entries.has(edge.path)) {
        entries.add(edge.path);
        grew = true;
      }
      if (edge.path === '.') {
        undetermined.push('the check lists the whole project folder; what it finds there cannot be protected');
        continue;
      }
      if (verifier.has(edge.path) || writable.has(edge.path) || outputs.has(edge.path)) {
        continue;
      }
      const kind = input.kind(edge.path);
      // A folder is a test folder when what it holds would be test support.
      const support = isTestSupport(kind === 'dir' ? `${edge.path}/_` : edge.path, acceptanceDirs);
      if (kind === 'dir') {
        // The check runs or lists a folder: whatever is in it is part of the check.
        if (!support) {
          undetermined.push(`the check runs or lists the folder ${edge.path}, which is not a test folder; what it finds there cannot be protected`);
          continue;
        }
        const files = input.filesUnder(edge.path);
        if (files === null) {
          undetermined.push(`the check runs or lists the folder ${edge.path}, which holds too many files to freeze`);
          continue;
        }
        sealed.add(edge.path);
        for (const file of files) {
          if (!verifier.has(file)) {
            verifier.add(file);
            grew = true;
          }
        }
        continue;
      }
      if (support) {
        if (kind === 'missing') {
          undetermined.push(`the check reads ${edge.path}, test data that does not exist yet (the agent could create it)`);
          continue;
        }
        verifier.add(edge.path);
        grew = true;
      } else if (edge.kind === 'entry' && edge.by === null) {
        // The command runs it as its own program: its exit decides the check.
        undetermined.push(`the command runs ${edge.path} directly, but it is not an acceptance file; list it with the acceptance files or move it to a test folder`);
      } else if (kind === 'file') {
        writable.add(edge.path);
      } else {
        outputs.add(edge.path);
      }
    }
  }
  if (observed.size > MAX_OBSERVED_PATHS) {
    undetermined.push(`the check uses more than ${MAX_OBSERVED_PATHS} files; RAME cannot record its scope`);
  }
  if (sealed.size > MAX_SEALED_FOLDERS) {
    undetermined.push(`the check spans more than ${MAX_SEALED_FOLDERS} folders; RAME cannot seal them all`);
  }
  for (const file of input.listed) {
    verifier.delete(file);
  }
  return {
    verifier: [...verifier].filter((file) => !ignoredPath(file)).sort(),
    writable: [...writable].sort(),
    outputs: [...outputs].sort(),
    sealed: [...sealed].sort(),
    observed: [...observed].sort(),
    entries: [...entries].sort(),
    undetermined: [...new Set(undetermined)],
  };
}

/** What the grant authorized for one protected check, as far as a run-time trace is compared with it. */
export interface AuthorizedScope {
  frozen: readonly string[];
  writable: readonly string[];
  outputs: readonly string[];
  sealed: readonly string[];
  observed: readonly string[];
  entries: readonly string[];
}

export function insideFolder(rel: string, folder: string): boolean {
  const target = rel.toLowerCase();
  const dir = folder.toLowerCase();
  return target === dir || target.startsWith(`${dir}/`);
}

// Host-side acceptance descriptions: cases (expected values) and references (how inputs are generated).
const CASES_PATH = /\.rame-(?:cases|reference)\.json$/i;

/**
 * At run time, what the trace shows outside the authorized scope:
 *   - the check (or a process it started) used a path the grant does not
 *     list: a new dependency, a branch that never ran at authorization, a
 *     file added to a sealed folder;
 *   - a process entry point the grant does not list;
 *   - code that is not the check read a host-compared cases file (its
 *     expected values).
 * Only a discovery aid: an empty answer proves nothing (the trace can be
 * forged); a non-empty one means the run cannot be verified.
 */
export function scopeViolations(trace: ParsedTrace, scope: AuthorizedScope): string[] {
  const frozen = new Set(scope.frozen);
  const known = new Set([...scope.frozen, ...scope.writable, ...scope.outputs, ...scope.observed]);
  const found = new Set<string>();
  for (const edge of trace.edges) {
    if (ignoredPath(edge.path)) {
      continue;
    }
    const byCheck = edge.by === null || frozen.has(edge.by) || scope.entries.includes(edge.by);
    if (!byCheck) {
      if (CASES_PATH.test(edge.path) && edge.kind !== 'entry') {
        found.add(`${edge.by} (not part of the check) read the expected values in ${edge.path}`);
      }
      continue;
    }
    if (edge.kind === 'entry' && !scope.entries.includes(edge.path) && !frozen.has(edge.path)) {
      found.add(`the check ran ${edge.path}, which was not part of the authorized check`);
      continue;
    }
    if (known.has(edge.path)) {
      continue;
    }
    const sealed = scope.sealed.find((folder) => insideFolder(edge.path, folder));
    found.add(
      sealed !== undefined
        ? `the check used ${edge.path}, which was not in the sealed folder ${sealed} when you authorized it`
        : `the check used ${edge.path}, which is outside the scope you authorized`,
    );
  }
  return [...found].sort();
}
