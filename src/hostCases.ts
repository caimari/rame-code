/**
 * Host-compared acceptance cases: the reinforced level of a protected
 * acceptance check.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * A `*.rame-cases.json` file, frozen with the check, lists calls to the code
 * under test and their expected results:
 *
 *   { "rameCases": 1, "module": "src/calculator.js",
 *     "cases": [ { "call": "add", "args": [19, 23], "expect": 42 } ] }
 *
 * The host reads the expected values from the frozen file (checked against
 * its hash) and keeps them. A child process running RAME's shim
 * (`runtime/rame-cases-child.cjs`) loads the module, makes the calls and
 * reports only their results, between two random witness tokens. The host
 * compares. A process that ends early (for example `process.exit(0)` in the
 * code under test) leaves the end witness or some results missing: the
 * outcome is "incomplete", never a pass.
 *
 * The expected values are never sent to the child: not on stdin, in its
 * arguments, its environment or its results channel, and a failed case is
 * reported without them. Official verification is read-confined and
 * network-closed on supported Linux: the child gets only the current input
 * and authorized code, never the cases file, future inputs, expected values,
 * host records or sibling projects. Each input gets a fresh process.
 * Unsupported platforms run with an explicit unprotected label and warning.
 * Weak cases stay weak; values are JSON.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { isolatedInvocation, isolationRefusal, isolationSupport, protectedVerifierInvocation, verificationMode, type ProtectedInvocationAccess, type VerificationMode } from './shellIsolation.js';
import type { CommandIsolation } from './settingsStore.js';

export const CASES_FILE = /\.rame-cases\.json$/i;
export const MAX_CASES = 200;
const MAX_REPORT_BYTES = 1024 * 1024;
export const CHILD_SCRIPT = path.join(__dirname, '..', '..', 'runtime', 'rame-cases-child.cjs');
const HOST_PACKAGE_JSON = path.join(__dirname, '..', '..', 'package.json');

export interface HostCase {
  call: string;
  args: unknown[];
  expect: unknown;
}
export interface CasesSpec {
  module: string;
  cases: HostCase[];
}

export function parseCasesSpec(text: string): { ok: true; spec: CasesSpec } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'it is not valid JSON' };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record !== 'object' || record === null || record.rameCases !== 1) {
    return { ok: false, error: 'it needs "rameCases": 1' };
  }
  if (typeof record.module !== 'string' || record.module.length === 0 || record.module.length > 512 || path.isAbsolute(record.module) || record.module.split(/[\\/]/).includes('..')) {
    return { ok: false, error: '"module" must be a path inside the project' };
  }
  if (!Array.isArray(record.cases) || record.cases.length === 0 || record.cases.length > MAX_CASES) {
    return { ok: false, error: `"cases" must list 1 to ${MAX_CASES} calls` };
  }
  const cases: HostCase[] = [];
  for (const entry of record.cases as unknown[]) {
    const item = entry as Record<string, unknown>;
    if (typeof item !== 'object' || item === null || typeof item.call !== 'string' || item.call.length > 128 || !Array.isArray(item.args) || !('expect' in item)) {
      return { ok: false, error: 'every case needs "call" (a function name, or "" for the module itself), "args" and "expect"' };
    }
    cases.push({ call: item.call, args: item.args as unknown[], expect: item.expect });
  }
  return { ok: true, spec: { module: record.module.replace(/\\/g, '/'), cases } };
}

/** Deterministic JSON for comparison: object keys sorted. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type CasesOutcome =
  | { status: 'passed'; total: number }
  | { status: 'failed'; total: number; failed: Array<{ index: number; call: string; reason: string }> }
  | { status: 'incomplete'; reason: string };

export type CaseAnswer = { ok: boolean; value?: unknown; error?: string };

/**
 * Read the child's report: one answer per call, between the two witness
 * tokens, or why the run is incomplete. Nothing is judged here.
 */
export function readCaseAnswers(report: string, count: number, tokens: { start: string; end: string }): { status: 'complete'; answers: Map<number, CaseAnswer> } | { status: 'incomplete'; reason: string } {
  const results = new Map<number, CaseAnswer>();
  let started = false;
  let ended = false;
  for (const line of report.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { status: 'incomplete', reason: 'the results channel carried something that is not a result' };
    }
    if (message.witness === tokens.start && !started && results.size === 0) {
      started = true;
    } else if (message.witness === tokens.end && started && !ended) {
      ended = true;
    } else if (typeof message.id === 'number' && started && !ended) {
      if (results.has(message.id)) {
        return { status: 'incomplete', reason: `case ${message.id + 1} was answered twice` };
      }
      results.set(message.id, { ok: message.ok === true, value: message.value, error: typeof message.error === 'string' ? message.error : undefined });
    } else if (message.load === false) {
      return { status: 'incomplete', reason: `the module could not be loaded: ${String(message.error ?? '').slice(0, 200)}` };
    } else {
      return { status: 'incomplete', reason: 'an unexpected message arrived on the results channel' };
    }
  }
  if (!started) {
    return { status: 'incomplete', reason: 'RAME’s case runner never started' };
  }
  if (!ended || results.size !== count) {
    return { status: 'incomplete', reason: `the run ended before every case returned (${results.size} of ${count}); for example the code under test ended the process early` };
  }
  return { status: 'complete', answers: results };
}

/** Judge the child's report against the expected values the host kept. */
export function judgeReport(report: string, spec: CasesSpec, tokens: { start: string; end: string }): CasesOutcome {
  const read = readCaseAnswers(report, spec.cases.length, tokens);
  if (read.status === 'incomplete') {
    return read;
  }
  const results = read.answers;
  const failed: Array<{ index: number; call: string; reason: string }> = [];
  spec.cases.forEach((expected, index) => {
    const result = results.get(index);
    if (result === undefined) {
      failed.push({ index, call: expected.call, reason: 'no result' });
    } else if (!result.ok) {
      failed.push({ index, call: expected.call, reason: `threw: ${result.error ?? 'error'}` });
    } else if (canonical(result.value) !== canonical(expected.expect)) {
      // The expected value is never quoted back: only that it differs.
      failed.push({ index, call: expected.call, reason: 'returned a different value than expected' });
    }
  });
  return failed.length === 0 ? { status: 'passed', total: spec.cases.length } : { status: 'failed', total: spec.cases.length, failed };
}

export interface CaseRunnerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  nodePath?: string;
  childScript?: string;
  trace?: { file: string; root: string; preload: string };
  /** Extra environment for the child (for example NODE_PATH for a frozen reference copy). */
  env?: Record<string, string>;
  /** Host-verifier child isolation; omitted only by low-level unit tests. */
  isolation?: CommandIsolation;
  /** Writable root when the child's cwd is deliberately read-only. */
  isolationRoot?: string;
  /** Mandatory read-confined view for official host verification. */
  protectedAccess?: ProtectedInvocationAccess;
  /** Official verifier trust decided once by the host; unprotected is explicit, never inferred from terminal settings. */
  verificationMode?: VerificationMode;
}

/**
 * Run RAME's case runner in `cwd`: it loads `module` and makes `calls`,
 * answering only on its results channel. Resolves with the raw report and
 * the witness tokens, or with why there is no report.
 */
async function spawnCaseBatch(
  cwd: string,
  module: string,
  calls: Array<{ name: string; args: unknown[] }>,
  options: CaseRunnerOptions = {},
): Promise<{ report: string; tokens: { start: string; end: string } } | { report: null; reason: string; interrupted?: true }> {
  const tokens = { start: randomBytes(16).toString('hex'), end: randomBytes(16).toString('hex') };
  const level = options.isolation ?? 'total';
  const support = await isolationSupport();
  const mode = options.verificationMode ?? verificationMode(support);
  const refusal = options.protectedAccess === undefined ? isolationRefusal(level, level === 'total' ? { ok: true, abi: 0 } : support) : null;
  if (refusal !== null) return { report: null, reason: `the host verifier was not run without its required isolation: ${refusal}` };
  const node = options.nodePath ?? process.execPath;
  const childArgs = [...(options.trace ? ['--require', options.trace.preload] : []), options.childScript ?? CHILD_SCRIPT];
  const protectedAccess = options.protectedAccess === undefined
    ? undefined
    : {
        ...options.protectedAccess,
        // Node 24 consults the package scope of the host-owned .cjs runner.
        // Grant that one public runtime manifest, never its parent tree.
        readFiles: [...options.protectedAccess.readFiles, HOST_PACKAGE_JSON, ...childArgs.filter((part) => path.isAbsolute(part))],
        readTrees: [...(options.protectedAccess.readTrees ?? []), ...(options.trace ? [path.dirname(options.trace.file)] : [])],
        writeTrees: [...(options.protectedAccess.writeTrees ?? []), ...(options.trace ? [path.dirname(options.trace.file)] : [])],
      };
  const invocation = protectedAccess === undefined
    ? isolatedInvocation(level, node, childArgs, options.isolationRoot ?? cwd, undefined, undefined, options.trace ? [path.dirname(options.trace.file)] : [])
    : mode.kind === 'protected' ? protectedVerifierInvocation(node, childArgs, protectedAccess) : { executable: node, argv: childArgs };
  return new Promise((resolve) => {
    let report = '';
    let settled = false;
    const finish = (outcome: { report: string; tokens: { start: string; end: string } } | { report: null; reason: string; interrupted?: true }) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      }
    };
    const trace = options.trace;
    const child = spawn(invocation.executable, invocation.argv, {
      cwd,
      env: {
        ...(protectedAccess === undefined ? process.env : { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }),
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '',
        ...(trace ? { RAME_TRACE_FILE: trace.file, RAME_TRACE_ROOT: trace.root, RAME_TRACE_PARENT: '' } : {}),
        ...(options.env ?? {}),
      },
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ report: null, reason: 'the cases did not finish in time' });
    }, options.timeoutMs ?? 60_000);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ report: null, reason: 'stopped before it finished', interrupted: true });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const channel = child.stdio[3] as NodeJS.ReadableStream | null;
    channel?.on('data', (chunk: Buffer) => {
      if (report.length < MAX_REPORT_BYTES) {
        report += chunk.toString('utf8');
      }
    });
    child.on('error', () => finish({ report: null, reason: 'the case runner could not start' }));
    child.on('close', () => {
      options.signal?.removeEventListener('abort', onAbort);
      finish({ report, tokens });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify({ module, calls: calls.map((entry, id) => ({ id, name: entry.name, args: entry.args })), start: tokens.start, end: tokens.end }));
  });
}

/**
 * Send one input to one fresh process. Future inputs, expected answers and
 * seeds remain in the host; the official aggregate report is built here,
 * never by code under test.
 */
export async function spawnCaseRunner(
  cwd: string,
  module: string,
  calls: Array<{ name: string; args: unknown[] }>,
  options: CaseRunnerOptions = {},
): Promise<{ report: string; tokens: { start: string; end: string } } | { report: null; reason: string; interrupted?: true }> {
  const tokens = { start: randomBytes(16).toString('hex'), end: randomBytes(16).toString('hex') };
  const messages: string[] = [JSON.stringify({ witness: tokens.start })];
  for (const [id, call] of calls.entries()) {
    if (options.signal?.aborted) return { report: null, reason: 'stopped before it finished', interrupted: true };
    const run = await spawnCaseBatch(cwd, module, [call], options);
    if (run.report === null) return run;
    const read = readCaseAnswers(run.report, 1, run.tokens);
    if (read.status === 'incomplete') return { report: null, reason: read.reason };
    const answer = read.answers.get(0);
    if (answer === undefined) return { report: null, reason: 'the isolated case returned no answer' };
    messages.push(JSON.stringify({ id, ...answer }));
  }
  messages.push(JSON.stringify({ witness: tokens.end }));
  return { report: `${messages.join('\n')}\n`, tokens };
}

/** Run the cases in a child process with RAME's shim, and judge them here. */
export async function runHostCases(root: string, spec: CasesSpec, options: CaseRunnerOptions = {}): Promise<CasesOutcome & { interrupted?: true }> {
  const run = await spawnCaseRunner(root, spec.module, spec.cases.map((entry) => ({ name: entry.call, args: entry.args })), options);
  if (run.report === null) {
    return { status: 'incomplete', reason: run.reason, ...(run.interrupted ? { interrupted: true as const } : {}) };
  }
  return judgeReport(run.report, spec, run.tokens);
}
