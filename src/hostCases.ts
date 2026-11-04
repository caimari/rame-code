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
 * reported without them. The child runs under RAME's trace, so a run in which
 * the code under test is seen reading a cases file is not counted.
 *
 * What this does not do: it is not a sandbox. The child runs with the user's
 * permissions, so code under test can still find and read the cases file on
 * disk (the trace is a discovery aid, not a barrier); weak cases stay weak;
 * values must be JSON. The guarantee is that the host ran every authorized
 * case and compared every result itself, not that the answers are secret.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

export const CASES_FILE = /\.rame-cases\.json$/i;
export const MAX_CASES = 200;
const MAX_REPORT_BYTES = 1024 * 1024;
export const CHILD_SCRIPT = path.join(__dirname, '..', '..', 'runtime', 'rame-cases-child.cjs');

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

/** Judge the child's report against the expected values the host kept. */
export function judgeReport(report: string, spec: CasesSpec, tokens: { start: string; end: string }): CasesOutcome {
  const results = new Map<number, { ok: boolean; value?: unknown; error?: string }>();
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
  if (!ended || results.size !== spec.cases.length) {
    return { status: 'incomplete', reason: `the run ended before every case returned (${results.size} of ${spec.cases.length}); for example the code under test ended the process early` };
  }
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

/** Run the cases in a child process with RAME's shim, and judge them here. */
export function runHostCases(
  root: string,
  spec: CasesSpec,
  options: { signal?: AbortSignal; timeoutMs?: number; nodePath?: string; childScript?: string; trace?: { file: string; root: string; preload: string } } = {},
): Promise<CasesOutcome & { interrupted?: true }> {
  const tokens = { start: randomBytes(16).toString('hex'), end: randomBytes(16).toString('hex') };
  return new Promise((resolve) => {
    let report = '';
    let settled = false;
    const finish = (outcome: CasesOutcome & { interrupted?: true }) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      }
    };
    const trace = options.trace;
    const child = spawn(options.nodePath ?? process.execPath, [...(trace ? ['--require', trace.preload] : []), options.childScript ?? CHILD_SCRIPT], {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '',
        ...(trace ? { RAME_TRACE_FILE: trace.file, RAME_TRACE_ROOT: trace.root, RAME_TRACE_PARENT: '' } : {}),
      },
      stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ status: 'incomplete', reason: 'the cases did not finish in time' });
    }, options.timeoutMs ?? 60_000);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish({ status: 'incomplete', reason: 'stopped before it finished', interrupted: true });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const channel = child.stdio[3] as NodeJS.ReadableStream | null;
    channel?.on('data', (chunk: Buffer) => {
      if (report.length < MAX_REPORT_BYTES) {
        report += chunk.toString('utf8');
      }
    });
    child.on('error', () => finish({ status: 'incomplete', reason: 'the case runner could not start' }));
    child.on('close', () => {
      options.signal?.removeEventListener('abort', onAbort);
      finish(judgeReport(report, spec, tokens));
    });
    const calls = spec.cases.map((entry, id) => ({ id, name: entry.call, args: entry.args }));
    child.stdin?.end(JSON.stringify({ module: spec.module, calls, start: tokens.start, end: tokens.end }));
  });
}
