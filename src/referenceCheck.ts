/**
 * Differential acceptance (P5b): the code under test is compared with a
 * frozen copy of the original implementation, on the same inputs.
 *
 * A `*.rame-reference.json` file, frozen with the check and hidden from the
 * agent, names the function and how to generate its inputs:
 *
 *   { "rameReference": 1, "module": "lib/report.js", "call": "checksum",
 *     "args": [ { "int": { "min": 0, "max": 2000000000 } } ],
 *     "edges": [[0], [1]], "random": 48, "reserved": 32 }
 *
 * When the Mission is authorized, the host copies the original files of the
 * reference (`files`, by default the module) into its own folder outside the
 * project and records their hashes in the grant. At every host check:
 *   1. the copy is checked against those hashes (and nothing was added to
 *      it): a changed copy is never used;
 *   2. the host generates the inputs itself, from the frozen description and
 *      two fresh random seeds: a "shown" pool (edge values plus random
 *      values) and a "reserved" pool (random values only, never an input
 *      of the shown pool: a reserved input the agent can see is not hidden);
 *   3. RAME's case runner calls the original copy and the code under test
 *      with exactly the same inputs, in two child processes, and the host
 *      compares every result;
 *   4. any difference fails the check, however fast the code is. Up to three
 *      failing inputs of the shown pool are reported (never the original's
 *      result); reserved inputs are never reported, only how many differed;
 *   5. the seeds, the hashes and every difference (with both results) are
 *      written to a host record outside the project, so a failure can be
 *      reproduced. The record is never read back to decide anything.
 *
 * What this does not do: it trusts the original. If the original is wrong
 * for some input, a faithful copy of its mistake passes and a correct fix
 * fails. Random inputs find many differences but prove none absent. Code
 * under test can detect RAME's case runner. Official verification always uses
 * the fail-closed Landlock/seccomp boundary, independently of terminal or
 * autonomy settings; Total cannot weaken it. Two thrown errors count as the
 * same result (the messages are not compared).
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseTrace, TRACE_RUNTIME_DIR } from './acceptanceTrace.js';
import { type CaseAnswer, canonical, readCaseAnswers, spawnCaseRunner } from './hostCases.js';
import { makeVisibleCopy, parseVisibleOriginal, removeReadOnlyTree, type VisibleOriginal } from './originalCopy.js';
import type { CommandIsolation } from './settingsStore.js';
import type { ProtectedInvocationAccess, VerificationMode } from './shellIsolation.js';

export const REFERENCE_FILE = /\.rame-reference\.json$/i;
/** Any host-side acceptance description the agent must not read. */
export const HOST_SPEC_FILE = /\.rame-(?:cases|reference)\.json$/i;
const MAX_FILES = 16;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_INPUTS = 500;
const MAX_EDGES = 64;
const SHOWN_FAILURES = 3;
const RECORDED_DIFFERENCES = 50;

export type InputGen =
  | { int: { min: number; max: number } }
  | { number: { min: number; max: number } }
  | { bool: true }
  | { string: { maxLength: number; alphabet?: string } }
  | { oneOf: unknown[] }
  | { array: { of: InputGen; maxLength: number } };

export interface ReferenceSpec {
  module: string;
  call: string;
  files: string[];
  args: InputGen[];
  edges: unknown[][];
  random: number;
  reserved: number;
  timeoutMs: number;
}

/** What the grant keeps of a frozen reference: where the host's copy is, and its hashes. */
export interface FrozenReference {
  spec: string;
  specHash: string;
  dir: string;
  files: Array<{ path: string; hash: string }>;
  /** The agent's read-only copy of the same original files, in another folder (originalCopy.ts). */
  visible?: VisibleOriginal;
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const projectPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..') && !/^[a-z]:/i.test(value);

function parseGen(raw: unknown, depth: number): InputGen | string {
  if (!isRecord(raw) || Object.keys(raw).length !== 1) {
    return 'every argument needs exactly one of int, number, bool, string, oneOf or array';
  }
  const [kind, body] = Object.entries(raw)[0] as [string, unknown];
  const bounds = (integer: boolean): { min: number; max: number } | string => {
    if (!isRecord(body) || typeof body.min !== 'number' || typeof body.max !== 'number' || !Number.isFinite(body.min) || !Number.isFinite(body.max) || body.min > body.max) {
      return `${kind} needs finite min <= max`;
    }
    if (integer && (!Number.isSafeInteger(body.min) || !Number.isSafeInteger(body.max))) {
      return 'int needs safe integers (at most 2^53 - 1)';
    }
    return { min: body.min, max: body.max };
  };
  switch (kind) {
    case 'int':
    case 'number': {
      const range = bounds(kind === 'int');
      return typeof range === 'string' ? range : kind === 'int' ? { int: range } : { number: range };
    }
    case 'bool':
      return body === true ? { bool: true } : 'bool takes true';
    case 'string': {
      if (!isRecord(body) || !Number.isInteger(body.maxLength) || (body.maxLength as number) < 0 || (body.maxLength as number) > 4096) {
        return 'string needs maxLength from 0 to 4096';
      }
      if (body.alphabet !== undefined && (typeof body.alphabet !== 'string' || body.alphabet.length === 0 || body.alphabet.length > 256)) {
        return 'string alphabet must have 1 to 256 characters';
      }
      return { string: { maxLength: body.maxLength as number, ...(typeof body.alphabet === 'string' ? { alphabet: body.alphabet } : {}) } };
    }
    case 'oneOf':
      return Array.isArray(body) && body.length > 0 && body.length <= 64 ? { oneOf: JSON.parse(JSON.stringify(body)) as unknown[] } : 'oneOf needs 1 to 64 values';
    case 'array': {
      if (depth >= 3 || !isRecord(body) || !Number.isInteger(body.maxLength) || (body.maxLength as number) < 0 || (body.maxLength as number) > 1000) {
        return 'array needs maxLength from 0 to 1000 (at most 3 levels deep)';
      }
      const of = parseGen(body.of, depth + 1);
      return typeof of === 'string' ? of : { array: { of, maxLength: body.maxLength as number } };
    }
    default:
      return `unknown argument kind ${kind.slice(0, 40)}`;
  }
}

export function parseReferenceSpec(text: string): { ok: true; spec: ReferenceSpec } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'it is not valid JSON' };
  }
  if (!isRecord(raw) || raw.rameReference !== 1) {
    return { ok: false, error: 'it needs "rameReference": 1' };
  }
  if (!projectPath(raw.module)) {
    return { ok: false, error: '"module" must be a path inside the project' };
  }
  if (typeof raw.call !== 'string' || raw.call.length > 128) {
    return { ok: false, error: '"call" must be a function name, or "" for the module itself' };
  }
  const module = raw.module.replace(/\\/g, '/');
  const files = raw.files === undefined ? [module] : raw.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES || !files.every(projectPath)) {
    return { ok: false, error: `"files" must list 1 to ${MAX_FILES} paths inside the project` };
  }
  const normalized = [...new Set((files as string[]).map((file) => file.replace(/\\/g, '/')))];
  if (!normalized.includes(module) || normalized.some((file) => file.toLowerCase() === 'package.json' || REFERENCE_FILE.test(file))) {
    return { ok: false, error: '"files" must include the module, and not package.json or a reference file' };
  }
  if (!Array.isArray(raw.args) || raw.args.length > 8) {
    return { ok: false, error: '"args" must describe 0 to 8 arguments' };
  }
  const args: InputGen[] = [];
  for (const entry of raw.args as unknown[]) {
    const gen = parseGen(entry, 0);
    if (typeof gen === 'string') {
      return { ok: false, error: gen };
    }
    args.push(gen);
  }
  const edges = raw.edges === undefined ? [] : raw.edges;
  if (!Array.isArray(edges) || edges.length > MAX_EDGES || !edges.every((entry) => Array.isArray(entry) && entry.length === args.length)) {
    return { ok: false, error: `"edges" must list up to ${MAX_EDGES} inputs, each with one value per argument` };
  }
  const count = (value: unknown, fallback: number, min: number): number | null => {
    const n = value === undefined ? fallback : value;
    return Number.isInteger(n) && (n as number) >= min && (n as number) <= MAX_INPUTS ? (n as number) : null;
  };
  const random = count(raw.random, 48, 0);
  const reserved = count(raw.reserved, 32, 1);
  if (random === null || reserved === null) {
    return { ok: false, error: `"random" must be 0 to ${MAX_INPUTS} and "reserved" 1 to ${MAX_INPUTS} (inputs that are never shown)` };
  }
  const timeoutMs = raw.timeoutMs === undefined ? 120_000 : raw.timeoutMs;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > 600_000) {
    return { ok: false, error: '"timeoutMs" must be 1000 to 600000' };
  }
  return { ok: true, spec: { module, call: raw.call, files: normalized, args, edges: JSON.parse(JSON.stringify(edges)) as unknown[][], random, reserved, timeoutMs: timeoutMs as number } };
}

/** A reproducible stream of numbers in [0, 1) from a seed (SHA-256 in counter mode). */
class SeededRandom {
  private counter = 0;
  private buffer = Buffer.alloc(0);
  constructor(private readonly seed: string) {}
  next(): number {
    if (this.buffer.length < 6) {
      this.buffer = createHash('sha256').update(`${this.seed}:${this.counter++}`).digest();
    }
    const value = this.buffer.readUIntBE(0, 6) / 2 ** 48;
    this.buffer = this.buffer.subarray(6);
    return value;
  }
  below(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }
}

function sample(gen: InputGen, rng: SeededRandom): unknown {
  if ('int' in gen) {
    const { min, max } = gen.int;
    const span = max - min;
    if (rng.next() < 0.5 || span < 1024) {
      return min + rng.below(span + 1);
    }
    // Every magnitude, small and large, near either end: a uniform draw alone misses small values.
    const offset = Math.min(span, Math.floor(2 ** (rng.next() * Math.log2(span + 1))) - 1 + rng.below(2));
    return rng.next() < 0.5 ? min + offset : max - offset;
  }
  if ('number' in gen) {
    return gen.number.min + rng.next() * (gen.number.max - gen.number.min);
  }
  if ('bool' in gen) {
    return rng.next() < 0.5;
  }
  if ('string' in gen) {
    const alphabet = gen.string.alphabet ?? ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
    const length = rng.below(gen.string.maxLength + 1);
    let text = '';
    for (let i = 0; i < length; i += 1) {
      text += alphabet[rng.below(alphabet.length)];
    }
    return text;
  }
  if ('oneOf' in gen) {
    return gen.oneOf[rng.below(gen.oneOf.length)];
  }
  const length = rng.below(gen.array.maxLength + 1);
  return Array.from({ length }, () => sample(gen.array.of, rng));
}

/** The edge values of one argument: limits, zero, one, powers of two near the top. */
export function edgeValues(gen: InputGen): unknown[] {
  const within = (values: number[], min: number, max: number) => [...new Set(values.filter((value) => value >= min && value <= max && Number.isFinite(value)))];
  if ('int' in gen) {
    const { min, max } = gen.int;
    const powers = [8, 15, 16, 24, 31, 32, 53].flatMap((p) => [2 ** p - 1, 2 ** p, 2 ** p + 1, -(2 ** p)]).filter(Number.isSafeInteger);
    return within([min, max, min + 1, max - 1, 0, 1, -1, 2, Math.floor((min + max) / 2), ...powers], min, max);
  }
  if ('number' in gen) {
    const { min, max } = gen.number;
    return within([min, max, 0, 1, -1, 0.5, Number.EPSILON, (min + max) / 2], min, max);
  }
  if ('bool' in gen) {
    return [false, true];
  }
  if ('string' in gen) {
    const first = (gen.string.alphabet ?? 'a')[0] as string;
    return [...new Set(['', first.slice(0, gen.string.maxLength), first.repeat(gen.string.maxLength)])];
  }
  if ('oneOf' in gen) {
    return gen.oneOf.slice(0, 16);
  }
  const inner = edgeValues(gen.array.of);
  return gen.array.maxLength === 0 ? [[]] : [[], [inner[0]], Array.from({ length: gen.array.maxLength }, (_, i) => inner[i % inner.length])];
}

/**
 * The inputs of one pool, reproducible from its seed. The shown pool starts
 * with the spec's own edges and every argument's edge values (the other
 * arguments drawn at random); then `count` random inputs.
 */
export function generateInputs(spec: ReferenceSpec, seed: string, count: number, withEdges: boolean, exclude: ReadonlySet<string> = new Set()): unknown[][] {
  const rng = new SeededRandom(seed);
  const inputs: unknown[][] = [];
  const seen = new Set<string>();
  const add = (input: unknown[]) => {
    const key = canonical(input);
    if (!seen.has(key) && !exclude.has(key)) {
      seen.add(key);
      inputs.push(input);
    }
  };
  if (withEdges) {
    spec.edges.forEach(add);
    spec.args.forEach((gen, position) => {
      for (const value of edgeValues(gen)) {
        if (inputs.length < MAX_EDGES) {
          add(spec.args.map((other, i) => (i === position ? value : sample(other, rng))));
        }
      }
    });
  }
  const target = inputs.length + count;
  for (let attempt = 0; inputs.length < target && attempt < count * 4; attempt += 1) {
    add(spec.args.map((gen) => sample(gen, rng)));
  }
  return inputs;
}

/**
 * Both pools of one check, reproducible from their seeds. The reserved pool
 * never repeats an input of the shown pool: random draws favour values near
 * the limits, which the shown pool always includes, so without this about a
 * third of the checks had a "reserved" input the agent had been shown.
 */
export function generatePools(spec: ReferenceSpec, seeds: { shown: string; reserved: string }): { shown: unknown[][]; reserved: unknown[][] } {
  const shown = generateInputs(spec, seeds.shown, spec.random, true);
  const reserved = generateInputs(spec, seeds.reserved, spec.reserved, false, new Set(shown.map(canonical)));
  return { shown, reserved };
}

const digestInputs = (inputs: unknown[][]): string => sha256(canonical(inputs));

/** Check a reference copy against its frozen hashes; null when intact. */
export async function verifyReferenceCopy(frozen: FrozenReference): Promise<string | null> {
  const base = path.join(frozen.dir, 'files');
  const expected = new Map(frozen.files.map((file) => [file.path, file.hash]));
  const found: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), child);
      } else {
        found.push(child);
      }
    }
  };
  try {
    await walk(base, '');
  } catch {
    return 'the copy is missing';
  }
  const extra = found.filter((file) => !expected.has(file));
  if (extra.length > 0) {
    return `${extra.slice(0, 3).join(', ')} was added to it`;
  }
  for (const [file, hash] of expected) {
    const absolute = path.join(base, ...file.split('/'));
    const info = await lstat(absolute).catch(() => null);
    if (info === null || !info.isFile()) {
      return `${file} is missing from it`;
    }
    if (sha256(await readFile(absolute)) !== hash) {
      return `${file} changed in it`;
    }
  }
  return null;
}

/**
 * Freeze the reference of one spec: copy the original files from the
 * project into `dir` (outside it) and return what the grant keeps.
 */
export async function freezeReference(root: string, specPath: string, specText: string, dir: string): Promise<{ ok: true; frozen: FrozenReference } | { ok: false; error: string }> {
  const parsed = parseReferenceSpec(specText);
  if (!parsed.ok) {
    return { ok: false, error: `The reference ${specPath} is not valid: ${parsed.error}.` };
  }
  const files: Array<{ path: string; hash: string }> = [];
  const base = path.join(dir, 'files');
  for (const file of parsed.spec.files) {
    if (HOST_SPEC_FILE.test(file)) {
      return { ok: false, error: `The reference ${specPath} cannot list ${file} as an original file: host descriptions are never copied for the agent.` };
    }
    const source = path.join(root, ...file.split('/'));
    const info = await lstat(source).catch(() => null);
    if (info === null || !info.isFile() || info.size > MAX_FILE_BYTES) {
      return { ok: false, error: `The original ${file} named by ${specPath} is not a regular file of at most 1 MB in this project.` };
    }
    const bytes = await readFile(source);
    await mkdir(path.dirname(path.join(base, ...file.split('/'))), { recursive: true, mode: 0o700 });
    await writeFile(path.join(base, ...file.split('/')), bytes, { mode: 0o600 });
    files.push({ path: file, hash: sha256(bytes) });
  }
  // How Node reads `.js` in the project (CommonJS or ES modules) applies to the copy too.
  let type = 'commonjs';
  try {
    type = (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { type?: unknown }).type === 'module' ? 'module' : 'commonjs';
  } catch {
    // no package.json: CommonJS
  }
  const manifest = JSON.stringify({ type });
  await writeFile(path.join(base, 'package.json'), manifest, { mode: 0o600 });
  files.push({ path: 'package.json', hash: sha256(manifest) });
  return { ok: true, frozen: { spec: specPath, specHash: sha256(specText), dir, files } };
}

/** A frozen reference read back from a stored grant, or undefined when it is not one. */
export function parseFrozenReferences(raw: unknown): FrozenReference[] | undefined {
  if (!Array.isArray(raw) || raw.length > 4) {
    return undefined;
  }
  const out: FrozenReference[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      !projectPath(item.spec) ||
      typeof item.specHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.specHash) ||
      typeof item.dir !== 'string' ||
      !path.isAbsolute(item.dir) ||
      item.dir.length > 1024 ||
      !Array.isArray(item.files) ||
      item.files.length === 0 ||
      item.files.length > MAX_FILES + 1 ||
      !item.files.every((file) => isRecord(file) && projectPath(file.path) && typeof file.hash === 'string' && /^[0-9a-f]{64}$/.test(file.hash))
    ) {
      return undefined;
    }
    const visible = parseVisibleOriginal(item.visible);
    if (visible === null) {
      return undefined;
    }
    out.push({ spec: item.spec, specHash: item.specHash, dir: item.dir, files: (item.files as Array<{ path: string; hash: string }>).map((file) => ({ path: file.path, hash: file.hash })), ...(visible ? { visible } : {}) });
  }
  return out;
}

export const copyFrozenReferences = (list: readonly FrozenReference[]): FrozenReference[] =>
  list.map((item) => ({ ...item, files: item.files.map((file) => ({ ...file })), ...(item.visible ? { visible: { dir: item.visible.dir, files: item.visible.files.map((file) => ({ ...file })) } } : {}) }));

export type DifferentialOutcome = { kind: 'passed' | 'failed' | 'tampered' | 'unverifiable'; summary: string; record?: string } | { kind: 'interrupted'; summary: '' };

const shortJson = (value: unknown, max = 80): string => {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const callText = (spec: ReferenceSpec, args: unknown[]): string => `${spec.call || 'module'}(${args.map((arg) => shortJson(arg, 60)).join(', ')})`;

function differs(reference: CaseAnswer, candidate: CaseAnswer): string | null {
  if (!reference.ok && !candidate.ok) {
    return null;
  }
  if (reference.ok && !candidate.ok) {
    return `threw: ${(candidate.error ?? 'error').slice(0, 120)}`;
  }
  if (!reference.ok) {
    return 'returned a value where the original throws';
  }
  return canonical(reference.value) === canonical(candidate.value) ? null : 'returned a different result than the original';
}

/**
 * Run one differential comparison: the frozen original and the code under
 * test on the same fresh inputs. `seeds` is for reproducing a recorded run.
 */
export async function runDifferential(
  root: string,
  frozen: FrozenReference,
  specText: string,
  options: { signal?: AbortSignal; seeds?: { shown: string; reserved: string }; trace?: boolean; nodePath?: string; isolation?: CommandIsolation; protectedAccess?: ProtectedInvocationAccess; verificationMode?: VerificationMode } = {},
): Promise<DifferentialOutcome> {
  if (sha256(specText) !== frozen.specHash) {
    return { kind: 'tampered', summary: `the reference ${frozen.spec} changed since the Mission was authorized` };
  }
  const parsed = parseReferenceSpec(specText);
  if (!parsed.ok) {
    return { kind: 'tampered', summary: `the reference ${frozen.spec} is not valid (${parsed.error})` };
  }
  const spec = parsed.spec;
  const copy = await verifyReferenceCopy(frozen);
  if (copy !== null) {
    return { kind: 'tampered', summary: `the host's frozen copy of the original for ${frozen.spec} can no longer be trusted: ${copy}` };
  }
  if (frozen.visible) {
    // Calling RAME's read-only copy instead of doing the work would pass today and break once the copy is gone.
    const marker = path.basename(frozen.visible.dir);
    for (const file of new Set([spec.module, ...spec.files])) {
      const text = await readFile(path.join(root, ...file.split('/')), 'utf8').catch(() => '');
      if (text.includes(marker)) {
        return { kind: 'unverifiable', summary: `the code under test (${file}) refers to RAME's read-only copy of the original instead of standing on its own` };
      }
    }
  }
  const seeds = options.seeds ?? { shown: randomBytes(16).toString('hex'), reserved: randomBytes(16).toString('hex') };
  const { shown, reserved } = generatePools(spec, seeds);
  const all = [...shown, ...reserved];
  const calls = all.map((args) => ({ name: spec.call, args }));
  const traceDir = options.trace === false ? null : await mkdtemp(path.join(os.tmpdir(), 'rame-reference-'));
  const traceFile = traceDir ? path.join(traceDir, 'trace.jsonl') : null;
  try {
    const common = { timeoutMs: spec.timeoutMs, ...(options.signal ? { signal: options.signal } : {}), ...(options.nodePath ? { nodePath: options.nodePath } : {}) };
    const originalRoot = path.join(frozen.dir, 'files');
    const projectModules = path.join(root, 'node_modules');
    const originalAccess: ProtectedInvocationAccess | undefined = options.protectedAccess === undefined ? undefined : {
      readFiles: frozen.files.map((file) => path.join(originalRoot, ...file.path.split('/'))),
      readTrees: [TRACE_RUNTIME_DIR, ...(existsSync(projectModules) ? [projectModules] : [])],
      readDirs: [originalRoot],
      writeTrees: [],
    };
    const [originalRun, candidateRun] = await Promise.all([
      spawnCaseRunner(originalRoot, spec.module, calls, { ...common, isolation: options.isolation, isolationRoot: os.tmpdir(), protectedAccess: originalAccess, verificationMode: options.verificationMode, env: { NODE_PATH: projectModules } }),
      spawnCaseRunner(root, spec.module, calls, { ...common, isolation: options.isolation, isolationRoot: root, protectedAccess: options.protectedAccess, verificationMode: options.verificationMode, ...(traceFile ? { trace: { file: traceFile, root, preload: path.join(TRACE_RUNTIME_DIR, 'acceptance-trace.cjs') } } : {}) }),
    ]);
    if ((originalRun.report === null && originalRun.interrupted) || (candidateRun.report === null && candidateRun.interrupted) || options.signal?.aborted) {
      return { kind: 'interrupted', summary: '' };
    }
    if (traceFile) {
      const trace = parseTrace(await readFile(traceFile, 'utf8').catch(() => ''));
      if (trace.processes === 0) {
        return { kind: 'unverifiable', summary: `RAME could not observe the code under test in the differential comparison of ${frozen.spec}` };
      }
      const leaks = trace.edges.filter((edge) => HOST_SPEC_FILE.test(edge.path) && edge.kind !== 'entry').map((edge) => edge.path);
      if (leaks.length > 0) {
        return { kind: 'unverifiable', summary: `the code under test read ${[...new Set(leaks)].join(', ')} during the differential comparison` };
      }
    }
    const original = originalRun.report === null ? { status: 'incomplete' as const, reason: originalRun.reason } : readCaseAnswers(originalRun.report, calls.length, originalRun.tokens);
    if (original.status === 'incomplete') {
      // Not the agent's fault: the reference cannot judge with these settings.
      return { kind: 'unverifiable', summary: `the frozen original for ${frozen.spec} did not answer every input (${original.reason}); give it fewer inputs or more time in ${frozen.spec}` };
    }
    const candidate = candidateRun.report === null ? { status: 'incomplete' as const, reason: candidateRun.reason } : readCaseAnswers(candidateRun.report, calls.length, candidateRun.tokens);
    const differences: Array<{ pool: 'shown' | 'reserved'; index: number; reason: string }> = [];
    if (candidate.status === 'complete') {
      all.forEach((_, index) => {
        const reason = differs(original.answers.get(index) as CaseAnswer, candidate.answers.get(index) as CaseAnswer);
        if (reason !== null) {
          differences.push({ pool: index < shown.length ? 'shown' : 'reserved', index, reason });
        }
      });
    }
    const record = await writeRecord(frozen, spec, seeds, { shown, reserved }, root, {
      outcome: candidate.status === 'incomplete' ? `incomplete: ${candidate.reason}` : differences.length === 0 ? 'passed' : 'failed',
      differences: differences.slice(0, RECORDED_DIFFERENCES).map((entry) => ({
        pool: entry.pool,
        input: all[entry.index],
        reason: entry.reason,
        original: original.answers.get(entry.index),
        candidate: candidate.status === 'complete' ? candidate.answers.get(entry.index) : undefined,
      })),
    });
    const where = `host record ${path.basename(record)}`;
    if (candidate.status === 'incomplete') {
      return { kind: 'failed', summary: `the differential comparison with the frozen original (${frozen.spec}) is incomplete: ${candidate.reason}; ${where}`, record };
    }
    if (differences.length === 0) {
      return { kind: 'passed', summary: `differential with the frozen original (${frozen.spec}): ${all.length} inputs (${shown.length} edge and random, ${reserved.length} reserved) gave the same results as the original; ${where}`, record };
    }
    const shownFailures = differences.filter((entry) => entry.pool === 'shown');
    const reservedFailures = differences.length - shownFailures.length;
    // The simplest failing inputs first: they are the easiest to debug.
    const examples = shownFailures
      .map((entry) => ({ entry, text: callText(spec, all[entry.index] as unknown[]) }))
      .sort((a, b) => a.text.length - b.text.length || (a.text < b.text ? -1 : 1))
      .slice(0, SHOWN_FAILURES)
      .map(({ entry, text }) => `${text} ${entry.reason}`);
    return {
      kind: 'failed',
      summary:
        `the differential comparison with the frozen original (${frozen.spec}) failed: ${shownFailures.length} of ${shown.length} shown inputs and ${reservedFailures} of ${reserved.length} reserved inputs gave a different result` +
        (examples.length > 0 ? `; for example ${examples.join('; ')}` : '') +
        ` (the original's results and the reserved inputs are not shown); ${where}`,
      record,
    };
  } finally {
    if (traceDir) {
      await rm(traceDir, { recursive: true, force: true });
    }
  }
}

async function writeRecord(
  frozen: FrozenReference,
  spec: ReferenceSpec,
  seeds: { shown: string; reserved: string },
  inputs: { shown: unknown[][]; reserved: unknown[][] },
  root: string,
  result: { outcome: string; differences: unknown[] },
): Promise<string> {
  const dir = path.join(frozen.dir, 'passes');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let candidateHash: string | null = null;
  try {
    candidateHash = sha256(await readFile(path.join(root, ...spec.module.split('/'))));
  } catch {
    // recorded as unknown
  }
  // Named apart from the seeds: the name is shown to the agent, the seeds never are.
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.json`);
  const body = {
    rameReferenceRecord: 1,
    at: new Date().toISOString(),
    spec: frozen.spec,
    specHash: frozen.specHash,
    original: frozen.files,
    candidate: { module: spec.module, hash: candidateHash },
    seeds,
    counts: { shown: inputs.shown.length, reserved: inputs.reserved.length },
    inputsDigest: { shown: digestInputs(inputs.shown), reserved: digestInputs(inputs.reserved) },
    ...result,
  };
  await writeFile(file, JSON.stringify(body, null, 2), { mode: 0o600 });
  return file;
}

/** Replay the inputs of a recorded pass from its seeds (for reproducing a failure). */
export function replayRecordInputs(specText: string, seeds: { shown: string; reserved: string }): { shown: unknown[][]; reserved: unknown[][]; digest: { shown: string; reserved: string } } | null {
  const parsed = parseReferenceSpec(specText);
  if (!parsed.ok) {
    return null;
  }
  const { shown, reserved } = generatePools(parsed.spec, seeds);
  return { shown, reserved, digest: { shown: digestInputs(shown), reserved: digestInputs(reserved) } };
}

/**
 * Before a baseline is frozen: the project's own implementation must agree
 * with itself on the same inputs (a non-deterministic function cannot be a
 * reference) and answer every input in time. Null when it can judge.
 */
export async function referenceProblem(root: string, specPath: string, specText: string, signal?: AbortSignal, isolation: CommandIsolation = 'total', protectedAccess?: ProtectedInvocationAccess, verificationMode?: VerificationMode): Promise<string | null | 'interrupted'> {
  const parsed = parseReferenceSpec(specText);
  if (!parsed.ok) {
    return `${specPath} is not valid: ${parsed.error}`;
  }
  const spec = parsed.spec;
  const inputs = [...generateInputs(spec, randomBytes(16).toString('hex'), spec.random, true), ...generateInputs(spec, randomBytes(16).toString('hex'), spec.reserved, false)];
  const calls = inputs.map((args) => ({ name: spec.call, args }));
  const options = { timeoutMs: spec.timeoutMs, isolation, protectedAccess, verificationMode, ...(signal ? { signal } : {}) };
  const [first, second] = await Promise.all([spawnCaseRunner(root, spec.module, calls, options), spawnCaseRunner(root, spec.module, calls, options)]);
  if (signal?.aborted || (first.report === null && first.interrupted) || (second.report === null && second.interrupted)) {
    return 'interrupted';
  }
  const a = first.report === null ? { status: 'incomplete' as const, reason: first.reason } : readCaseAnswers(first.report, calls.length, first.tokens);
  const b = second.report === null ? { status: 'incomplete' as const, reason: second.reason } : readCaseAnswers(second.report, calls.length, second.tokens);
  if (a.status === 'incomplete' || b.status === 'incomplete') {
    return `the original in ${spec.module} did not answer every input of ${specPath} (${a.status === 'incomplete' ? a.reason : (b as { reason: string }).reason}); give it fewer inputs or more time`;
  }
  const mismatch = inputs.findIndex((_, index) => differs(a.answers.get(index) as CaseAnswer, b.answers.get(index) as CaseAnswer) !== null);
  if (mismatch >= 0) {
    return `the original in ${spec.module} gave two different results for ${callText(spec, inputs[mismatch] as unknown[])}; a function that does not always give the same result cannot be a reference`;
  }
  const threw = inputs.filter((_, index) => a.answers.get(index)?.ok !== true).length;
  if (threw === inputs.length) {
    return `the original in ${spec.module} threw on every input of ${specPath}; check "call" and "args"`;
  }
  return null;
}

/** The folder that holds frozen originals must be this user's and writable by nobody else; null when it is. */
async function unsafeFolder(dir: string): Promise<string | null> {
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const info = await lstat(dir).catch(() => null);
  if (info === null || !info.isDirectory()) {
    return `${dir} is not a folder`;
  }
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      return `${dir} belongs to another user`;
    }
    if ((info.mode & 0o022) !== 0) {
      return `${dir} can be written by other users`;
    }
  }
  return null;
}

/**
 * At authorization: freeze the original of every reference file among the
 * acceptance files, each in its own folder under `<jobsRoot>/../references/`.
 */
export async function freezeReferencesFor(
  root: string,
  files: ReadonlyArray<{ path: string }>,
  readText: (file: string) => Promise<string>,
  jobsRoot: string,
  missionId: string,
): Promise<{ ok: true; references: FrozenReference[]; notes: string[] } | { ok: false; error: string }> {
  const specs = files.filter((file) => REFERENCE_FILE.test(file.path));
  if (specs.length > 4) {
    return { ok: false, error: 'An acceptance check can have at most 4 reference files.' };
  }
  const references: FrozenReference[] = [];
  const notes: string[] = [];
  const home = path.join(jobsRoot, '..', 'references');
  // The agent's read-only copies live apart from the host's references: no folder is shared.
  const shownHome = path.join(jobsRoot, '..', 'originals');
  if (specs.length > 0) {
    const unsafe = (await unsafeFolder(home)) ?? (await unsafeFolder(shownHome));
    if (unsafe !== null) {
      return { ok: false, error: `RAME cannot keep the frozen original safely: ${unsafe}.` };
    }
  }
  const undo = async (): Promise<void> => {
    for (const done of references) {
      await rm(done.dir, { recursive: true, force: true });
      if (done.visible) {
        await removeReadOnlyTree(done.visible.dir);
      }
    }
  };
  for (const file of specs) {
    const dir = path.join(home, `${missionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}-${randomBytes(6).toString('hex')}`);
    const frozen = await freezeReference(root, file.path, await readText(file.path).catch(() => ''), dir);
    if (!frozen.ok) {
      await rm(dir, { recursive: true, force: true });
      await undo();
      return frozen;
    }
    // The original source files only: package.json in the host's copy is RAME's own module-type manifest.
    const originals = frozen.frozen.files.filter((entry) => entry.path !== 'package.json');
    const visible = await makeVisibleCopy(root, originals, path.join(shownHome, `${missionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}-${randomBytes(6).toString('hex')}`));
    if (!visible.ok) {
      await rm(dir, { recursive: true, force: true });
      await undo();
      return visible;
    }
    references.push({ ...frozen.frozen, visible: visible.visible });
    notes.push(`differential reference ${file.path}: the host froze the original ${frozen.frozen.files.filter((entry) => entry.path !== 'package.json').map((entry) => entry.path).join(', ')} outside the project; every check compares the code under test with it on fresh inputs; the agent can read a separate read-only copy with read_original`);
  }
  return { ok: true, references, notes };
}
