/**
 * Numeric acceptance criteria for a Mission (piece F of the long-Mission
 * plan): criteria distinguish observations made by the extension host from
 * values declared by the frozen project check through its private channel.
 *
 * The channel prevents unrelated verifier children from replacing the host's
 * record. Code running inside the measured check can still alter its own
 * declared values; every card and result says so.
 *
 * Pure and free of the `vscode` API so it can be unit tested on its own.
 */

/** Environment variables the host sets for each measured run. */
export const METRIC_RESULTS_ENV = 'RAME_RESULTS_FILE';
export const METRIC_REPEAT_ENV = 'RAME_METRIC_REPEAT';
export const METRIC_REPEATS_ENV = 'RAME_METRIC_REPEATS';

export const MAX_METRIC_CRITERIA = 8;
export const MAX_METRIC_REPEATS = 5;
export const DEFAULT_METRIC_REPEATS = 3;
export const DEFAULT_MAX_SPREAD_PCT = 15;
export const MAX_RESULTS_BYTES = 16 * 1024;
const MAX_RESULT_KEYS = 64;
const METRIC_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const HOST_METRIC_NAMES = ['wall_ms', 'exit_code'] as const;
export type HostMetricName = (typeof HOST_METRIC_NAMES)[number];
export type MetricSource = 'host-observed' | 'project-declared';

export const metricSource = (name: string): MetricSource => HOST_METRIC_NAMES.includes(name as HostMetricName) ? 'host-observed' : 'project-declared';
export const metricSourceWords = (name: string): string => metricSource(name) === 'host-observed'
  ? 'observed by the host'
  : 'declared by the project — the figures are produced by project code; malicious code in the same process can alter them';

export interface MetricCriterion {
  /** An observation produced by the host. */
  metric: string;
  op: '<=' | '>=';
  value: number;
}

export interface MetricSpec {
  criteria: MetricCriterion[];
  /** Host runs of the frozen check; the median of each metric is judged. */
  repeats: number;
  /** Largest allowed spread between runs, as a percentage of the median (or of the threshold). */
  maxSpreadPct: number;
}

/** The shape every host check result shares (see `acceptanceRun.ts`). */
export interface CheckResult {
  passed: boolean;
  summary: string;
  output: string;
  tampered: boolean;
  unverifiable?: true;
  interrupted?: true;
  approved?: string[];
  /** The host measured again once because its first measurement was inconclusive: that first measurement. */
  remeasured?: string;
  /** Both measurements were inconclusive: never a pass, and nothing for the agent to fix. */
  inconclusive?: true;
  /** Official values, classified by `metricSources`; declared values come only from the private check channel. */
  hostMetrics?: Readonly<Record<string, number>>;
  metricSources?: Readonly<Record<string, MetricSource>>;
  verification?: { kind: 'protected' | 'unprotected'; reason: string; changed?: true };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validate criteria the user authorized; the error says what is wrong. */
export function validateMetricSpec(raw: unknown): { ok: true; spec: MetricSpec } | { ok: false; error: string } {
  if (!isRecord(raw) || !Array.isArray(raw.criteria)) {
    return { ok: false, error: 'metric criteria need a list of criteria' };
  }
  if (raw.criteria.length === 0 || raw.criteria.length > MAX_METRIC_CRITERIA) {
    return { ok: false, error: `metric criteria need 1 to ${MAX_METRIC_CRITERIA} criteria` };
  }
  const criteria: MetricCriterion[] = [];
  for (const entry of raw.criteria) {
    if (!isRecord(entry) || typeof entry.metric !== 'string' || !METRIC_NAME.test(entry.metric)) {
      return { ok: false, error: 'each metric needs a name of lowercase letters, digits and _ (e.g. wall_ms)' };
    }
    if (entry.op !== '<=' && entry.op !== '>=') {
      return { ok: false, error: `${entry.metric}: the comparison must be <= or >=` };
    }
    if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) {
      return { ok: false, error: `${entry.metric}: the threshold must be a finite number` };
    }
    if (criteria.some((known) => known.metric === entry.metric && known.op === entry.op)) {
      return { ok: false, error: `${entry.metric} ${entry.op} appears twice` };
    }
    criteria.push({ metric: entry.metric, op: entry.op, value: entry.value });
  }
  const repeats = raw.repeats === undefined ? DEFAULT_METRIC_REPEATS : raw.repeats;
  if (typeof repeats !== 'number' || !Number.isInteger(repeats) || repeats < 1 || repeats > MAX_METRIC_REPEATS) {
    return { ok: false, error: `metric criteria need 1 to ${MAX_METRIC_REPEATS} repeats` };
  }
  const maxSpreadPct = raw.maxSpreadPct === undefined ? DEFAULT_MAX_SPREAD_PCT : raw.maxSpreadPct;
  if (typeof maxSpreadPct !== 'number' || !Number.isFinite(maxSpreadPct) || maxSpreadPct < 1 || maxSpreadPct > 100) {
    return { ok: false, error: 'the allowed spread between runs must be 1 to 100 %' };
  }
  return { ok: true, spec: { criteria, repeats, maxSpreadPct } };
}

/** Stored form: `undefined` when invalid (a damaged record is refused). */
export function parseMetricSpec(raw: unknown): MetricSpec | undefined {
  const checked = validateMetricSpec(raw);
  return checked.ok ? checked.spec : undefined;
}

export function copyMetricSpec(spec: MetricSpec): MetricSpec {
  return { criteria: spec.criteria.map((entry) => ({ ...entry })), repeats: spec.repeats, maxSpreadPct: spec.maxSpreadPct };
}

export function describeMetricSpec(spec: MetricSpec): string {
  const list = spec.criteria.map((entry) => `${entry.metric} ${entry.op} ${entry.value} [${metricSourceWords(entry.metric)}]`).join('; ');
  return `${list} (median of ${spec.repeats} check run(s), spread up to ${spec.maxSpreadPct}%)`;
}

/** Legacy telemetry parser. Its values never become official acceptance evidence. */
export function parseResultsFile(text: string): { ok: true; values: Record<string, number> } | { ok: false; error: string } {
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULTS_BYTES) {
    return { ok: false, error: `the results file is larger than ${MAX_RESULTS_BYTES / 1024} KiB` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the results file is not valid JSON' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: 'the results file must be a JSON object' };
  }
  const keys = Object.keys(parsed);
  if (keys.length > MAX_RESULT_KEYS) {
    return { ok: false, error: `the results file has more than ${MAX_RESULT_KEYS} keys` };
  }
  const values: Record<string, number> = {};
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === 'number' && Number.isFinite(value) && METRIC_NAME.test(key)) {
      values[key] = value;
    }
  }
  return { ok: true, values };
}

export type MetricVerdict = 'pass' | 'fail' | 'inconclusive' | 'invalid';

export interface MetricEvaluation {
  verdict: MetricVerdict;
  /** One line per criterion, for the host record and the agent's feedback. */
  lines: string[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const meets = (criterion: MetricCriterion, value: number): boolean => (criterion.op === '<=' ? value <= criterion.value : value >= criterion.value);
const fmt = (value: number): string => (Number.isInteger(value) ? String(value) : value.toPrecision(4).replace(/\.?0+$/, ''));

/**
 * Judge the samples of every host run. Per criterion: met when the runs agree
 * (spread within the limit) and the median meets the threshold; not met when
 * every run misses it, or the runs agree and the median misses it; otherwise
 * inconclusive. A metric missing from any run makes the whole result invalid.
 */
export function evaluateMetrics(spec: MetricSpec, samples: ReadonlyArray<Record<string, number>>): MetricEvaluation {
  if (samples.length === 0) {
    return { verdict: 'invalid', lines: ['no host run produced results'] };
  }
  const lines: string[] = [];
  const states: MetricVerdict[] = [];
  for (const criterion of spec.criteria) {
    const values = samples.map((sample) => sample[criterion.metric]);
    const missing = values.findIndex((value) => value === undefined);
    if (missing >= 0) {
      lines.push(`${criterion.metric}: missing from the results of run ${missing + 1}`);
      states.push('invalid');
      continue;
    }
    const numbers = values as number[];
    const mid = median(numbers);
    const low = Math.min(...numbers);
    const high = Math.max(...numbers);
    const base = Math.max(Math.abs(mid), Math.abs(criterion.value));
    const spreadPct = high === low ? 0 : base === 0 ? Number.POSITIVE_INFINITY : ((high - low) / base) * 100;
    const stable = spreadPct <= spec.maxSpreadPct;
    const state: MetricVerdict = numbers.every((value) => !meets(criterion, value))
      ? 'fail'
      : stable
        ? meets(criterion, mid)
          ? 'pass'
          : 'fail'
        : 'inconclusive';
    states.push(state);
    const range = samples.length > 1 ? ` (${fmt(low)}–${fmt(high)}, spread ${Number.isFinite(spreadPct) ? `${Math.round(spreadPct)}%` : 'unbounded'})` : '';
    const word = state === 'pass' ? 'met' : state === 'fail' ? 'NOT met' : 'inconclusive';
    lines.push(`${criterion.metric} median ${fmt(mid)}${range} ${criterion.op} ${fmt(criterion.value)}: ${word} [${metricSourceWords(criterion.metric)}]`);
  }
  const verdict: MetricVerdict = states.includes('invalid')
    ? 'invalid'
    : states.includes('fail')
      ? 'fail'
      : states.includes('inconclusive')
        ? 'inconclusive'
        : 'pass';
  return { verdict, lines };
}

export interface MetricSummary {
  median: number;
  low: number;
  high: number;
  /** Spread between runs as a percentage of the median. */
  spreadPct: number;
}

/**
 * Summarize the host runs of a measurement (a baseline): the median of each
 * named metric, and which ones are missing or vary more than allowed. A
 * baseline is only usable when nothing is missing and nothing is unstable.
 */
export function summarizeSamples(
  names: readonly string[],
  samples: ReadonlyArray<Record<string, number>>,
  maxSpreadPct: number,
): { values: Record<string, MetricSummary>; missing: string[]; unstable: string[] } {
  const values: Record<string, MetricSummary> = {};
  const missing: string[] = [];
  const unstable: string[] = [];
  for (const name of names) {
    const numbers = samples.map((sample) => sample[name]);
    if (samples.length === 0 || numbers.some((value) => value === undefined)) {
      missing.push(name);
      continue;
    }
    const list = numbers as number[];
    const mid = median(list);
    const low = Math.min(...list);
    const high = Math.max(...list);
    const spreadPct = high === low ? 0 : mid === 0 ? Number.POSITIVE_INFINITY : ((high - low) / Math.abs(mid)) * 100;
    values[name] = { median: mid, low, high, spreadPct };
    if (spreadPct > maxSpreadPct) {
      unstable.push(name);
    }
  }
  return { values, missing, unstable };
}

export const formatMetricValue = fmt;
