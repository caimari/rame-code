/**
 * Programmes (piece A of the long-Mission plan): a goal split into phases
 * that open one after another, each one only when the host has verified the
 * previous one. This first version has two kinds of phase:
 *   - `measure`: the host itself runs the frozen measurement N times (as long
 *     jobs, see jobStore.ts) on the project as it is, and freezes the medians
 *     as the baseline. No model is involved.
 *   - `mission`: a normal Mission whose measured acceptance criteria may be
 *     relative to the baseline ("wall_ms <= 0.5 x baseline"); they are turned
 *     into fixed numbers, and frozen in the Mission's grant, when it opens.
 * A phase counts as verified only from what the host recorded: a baseline
 * it measured itself, or a completed Mission whose grant carries exactly the
 * phase's criteria and whose host record says the metrics were measured.
 *
 * Pure: records, validation, and the rules.
 */

import { createHash } from 'node:crypto';

import { CASES_FILE } from './hostCases.js';
import { REFERENCE_FILE } from './referenceCheck.js';
import { formatMetricValue, metricSourceWords, type MetricCriterion, type MetricSummary } from './metricAcceptance.js';
import { ACCEPTANCE_CONTINUED, type MissionRecord } from './missionStore.js';

export const MAX_PROGRAMME_PHASES = 8;
const METRIC_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export interface RelativeCriterion {
  metric: string;
  op: '<=' | '>=';
  /** The threshold is `factor` x the baseline median of `metric`. */
  factor: number;
}

export type PhaseStatus = 'locked' | 'open' | 'running' | 'verified' | 'failed' | 'inconclusive';

export interface ProgrammePhase {
  index: number;
  title: string;
  kind: 'measure' | 'mission';
  relative: RelativeCriterion[];
  absolute: MetricCriterion[];
  status: PhaseStatus;
  /** mission phases: the Mission that runs it. */
  missionId: string | null;
  /** measure phases: one host job per repeat, in order, so a reload follows them instead of starting new ones. */
  jobIds: string[];
  samples: Array<Record<string, number>>;
  /** mission phases: the fixed criteria the phase was opened with. */
  resolved: MetricCriterion[] | null;
  /** measure phases: the project fingerprint when the measurement started. */
  fingerprint: string | null;
  note: string;
}

/** The frozen measurement every phase uses: one allowlisted command and the files that define it, by hash. */
export interface ProgrammeCheck {
  commandId: string;
  files: Array<{ path: string; hash: string }>;
  packageJsonHash: string;
  /** Host-observed or project-declared metrics; every presentation labels the source. */
  metrics: string[];
  repeats: number;
  maxSpreadPct: number;
}

export interface Baseline {
  values: Record<string, MetricSummary>;
  /** Hash of every project file when the baseline was measured: the starting point it describes. */
  projectFingerprint: string;
  measuredAt: number;
}

/** One live window may direct one Programme phase; `fence` rejects its late writes after recovery. */
export interface ProgrammePhaseLease {
  phaseIndex: number;
  owner: string;
  fence: number;
  expiresAt: number;
}

export interface ProgrammeRecord {
  id: string;
  scopeId: string;
  root: string;
  goal: string;
  check: ProgrammeCheck;
  phases: ProgrammePhase[];
  baseline: Baseline | null;
  lease: ProgrammePhaseLease | null;
  nextFence: number;
  status: 'active' | 'completed' | 'stopped';
  revision: number;
  createdAt: number;
  updatedAt: number;
  note: string;
}

export interface PhaseSpec {
  title: string;
  kind: 'measure' | 'mission';
  relative?: RelativeCriterion[];
  absolute?: MetricCriterion[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function validCriterion(raw: unknown, relative: boolean): string | null {
  if (!isRecord(raw) || typeof raw.metric !== 'string' || !METRIC_NAME.test(raw.metric)) {
    return 'each criterion needs a metric name such as wall_ms';
  }
  if (raw.op !== '<=' && raw.op !== '>=') {
    return `${raw.metric}: the comparison must be <= or >=`;
  }
  const number = relative ? raw.factor : raw.value;
  if (typeof number !== 'number' || !Number.isFinite(number) || (relative && (number <= 0 || number > 100))) {
    return relative ? `${raw.metric}: the factor must be a number above 0 and at most 100` : `${raw.metric}: the threshold must be a finite number`;
  }
  return null;
}

/** The phases the user authorizes: a measurement first, then at least one Mission. */
export function validatePhases(raw: unknown, measured: readonly string[]): { ok: true; phases: PhaseSpec[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_PROGRAMME_PHASES) {
    return { ok: false, error: `a programme needs 2 to ${MAX_PROGRAMME_PHASES} phases` };
  }
  const phases: PhaseSpec[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry) || typeof entry.title !== 'string' || entry.title.trim().length === 0 || entry.title.length > 200) {
      return { ok: false, error: `phase ${index + 1} needs a title` };
    }
    if (entry.kind !== 'measure' && entry.kind !== 'mission') {
      return { ok: false, error: `phase ${index + 1}: the kind must be measure or mission` };
    }
    if (index === 0 && entry.kind !== 'measure') {
      return { ok: false, error: 'the first phase must measure the baseline' };
    }
    const relative = Array.isArray(entry.relative) ? entry.relative : [];
    const absolute = Array.isArray(entry.absolute) ? entry.absolute : [];
    if (entry.kind === 'measure' && (relative.length > 0 || absolute.length > 0)) {
      return { ok: false, error: `phase ${index + 1}: a measurement has no criteria of its own` };
    }
    if (entry.kind === 'mission' && relative.length + absolute.length === 0) {
      return { ok: false, error: `phase ${index + 1}: a Mission phase needs at least one measured criterion` };
    }
    for (const criterion of relative) {
      const error = validCriterion(criterion, true) ?? (measured.includes((criterion as RelativeCriterion).metric) ? null : `${(criterion as RelativeCriterion).metric} is not measured by the baseline`);
      if (error !== null) {
        return { ok: false, error: `phase ${index + 1}: ${error}` };
      }
    }
    for (const criterion of absolute) {
      const error = validCriterion(criterion, false);
      if (error !== null) {
        return { ok: false, error: `phase ${index + 1}: ${error}` };
      }
    }
    phases.push({
      title: entry.title.trim(),
      kind: entry.kind,
      relative: relative.map((criterion) => ({ metric: criterion.metric, op: criterion.op, factor: criterion.factor })),
      absolute: absolute.map((criterion) => ({ metric: criterion.metric, op: criterion.op, value: criterion.value })),
    });
  }
  if (!phases.some((phase) => phase.kind === 'mission')) {
    return { ok: false, error: 'a programme needs at least one Mission phase' };
  }
  return { ok: true, phases };
}

export function newPhases(specs: readonly PhaseSpec[]): ProgrammePhase[] {
  return specs.map((spec, index) => ({
    index,
    title: spec.title,
    kind: spec.kind,
    relative: spec.relative ?? [],
    absolute: spec.absolute ?? [],
    status: index === 0 ? 'open' : 'locked',
    missionId: null,
    jobIds: [],
    samples: [],
    resolved: null,
    fingerprint: null,
    note: index === 0 ? 'Ready: the host measures the baseline.' : 'Locked until the previous phase is verified by the host.',
  }));
}

/** Can this phase start now? Only after every earlier phase was verified by the host. */
export function canStartPhase(programme: ProgrammeRecord, index: number, kind: 'measure' | 'mission'): { ok: true; phase: ProgrammePhase } | { ok: false; error: string } {
  if (programme.status !== 'active') {
    return { ok: false, error: `This programme is ${programme.status}.` };
  }
  const phase = programme.phases[index];
  if (phase === undefined) {
    return { ok: false, error: 'This programme has no such phase.' };
  }
  if (phase.kind !== kind) {
    return { ok: false, error: `Phase ${index + 1} is a ${phase.kind} phase.` };
  }
  const pending = programme.phases.slice(0, index).find((earlier) => earlier.status !== 'verified');
  if (pending !== undefined) {
    return { ok: false, error: `Phase ${index + 1} cannot open: phase ${pending.index + 1} (${pending.title}) is ${pending.status}, not verified by the host.` };
  }
  if (phase.status === 'verified') {
    return { ok: false, error: `Phase ${index + 1} is already verified.` };
  }
  if (phase.kind === 'mission' && phase.status !== 'open') {
    return { ok: false, error: `Phase ${index + 1} is ${phase.status}.` };
  }
  return { ok: true, phase };
}

/** The fixed criteria of a Mission phase, from the frozen baseline. */
export function resolveCriteria(phase: ProgrammePhase, baseline: Baseline | null): { ok: true; criteria: MetricCriterion[] } | { ok: false; error: string } {
  const criteria: MetricCriterion[] = [];
  for (const criterion of phase.relative) {
    const base = baseline?.values[criterion.metric];
    if (base === undefined) {
      return { ok: false, error: `there is no baseline for ${criterion.metric}` };
    }
    criteria.push({ metric: criterion.metric, op: criterion.op, value: Number((base.median * criterion.factor).toPrecision(6)) });
  }
  return { ok: true, criteria: [...criteria, ...phase.absolute.map((criterion) => ({ ...criterion }))] };
}

export function describeBaseline(baseline: Baseline): string {
  return Object.entries(baseline.values)
    .map(([name, value]) => `${name} median ${formatMetricValue(value.median)} (${formatMetricValue(value.low)}–${formatMetricValue(value.high)}) [${metricSourceWords(name)}]`)
    .join('; ');
}

const sameCriteria = (a: readonly MetricCriterion[], b: readonly MetricCriterion[]): boolean =>
  a.length === b.length && a.every((entry, i) => entry.metric === b[i]?.metric && entry.op === b[i]?.op && entry.value === b[i]?.value);

/**
 * Did the host verify this Mission phase? Only a completed Mission whose
 * frozen check is the programme's, with exactly the phase's criteria, and
 * whose last host acceptance record says the metrics were measured.
 */
export function missionPhaseVerified(programme: ProgrammeRecord, phase: ProgrammePhase, mission: MissionRecord | null): { verified: boolean; reason: string } {
  if (mission === null) {
    return { verified: false, reason: 'its Mission no longer exists' };
  }
  if (mission.status !== 'completed') {
    return { verified: false, reason: `its Mission is ${mission.status}` };
  }
  const acceptance = mission.grant?.acceptance ?? null;
  if (acceptance === null || acceptance.commandId !== programme.check.commandId || acceptance.packageJsonHash !== programme.check.packageJsonHash) {
    return { verified: false, reason: 'its Mission did not run the programme\'s frozen check' };
  }
  const files = new Map(acceptance.files.map((file) => [file.path, file.hash]));
  if (programme.check.files.some((file) => files.get(file.path) !== file.hash)) {
    return { verified: false, reason: 'its Mission froze different check files' };
  }
  if (phase.resolved === null || acceptance.metrics === undefined || !sameCriteria(acceptance.metrics.criteria, phase.resolved)) {
    return { verified: false, reason: 'its Mission was not authorized with this phase\'s measured criteria' };
  }
  const index = mission.evidence.map((entry) => entry.text.startsWith('acceptance (run by the host): ')).lastIndexOf(true);
  // The host's record of that pass, with the notes it continues in.
  let text = index >= 0 ? (mission.evidence[index] as { text: string }).text : '';
  for (let i = index + 1; index >= 0 && i < mission.evidence.length && (mission.evidence[i] as { text: string }).text.startsWith(ACCEPTANCE_CONTINUED); i += 1) {
    text += ` ${(mission.evidence[i] as { text: string }).text.slice(ACCEPTANCE_CONTINUED.length)}`;
  }
  const last = index >= 0 ? { text } : undefined;
  if (last === undefined || !/^acceptance \(run by the host\): metrics (?:measured|judged) by the host: /.test(last.text)) {
    return { verified: false, reason: 'the host did not record a measured pass of its check' };
  }
  // With functional cases in the check, the same pass must also be the reinforced level:
  // fast is not enough, the results must be right.
  if (hasFunctionalCases(programme) && !last.text.includes('; reinforced level: ')) {
    return { verified: false, reason: 'the host did not record its functional cases (reinforced level) passing with the measurement' };
  }
  // With a frozen original, the same pass must also be the differential comparison with it.
  const references = programme.check.files.filter((file) => REFERENCE_FILE.test(file.path));
  const missing = references.find((file) => !last.text.includes(`differential with the frozen original (${file.path})`));
  if (missing !== undefined) {
    return { verified: false, reason: `the host did not record the differential comparison with the frozen original (${missing.path}) passing with the measurement` };
  }
  return { verified: true, reason: last.text.slice('acceptance (run by the host): '.length, 900) };
}

/** The frozen check includes host-compared functional cases (`*.rame-cases.json`) or a frozen original (`*.rame-reference.json`). */
export const hasFunctionalCases = (programme: Pick<ProgrammeRecord, 'check'>): boolean => programme.check.files.some((file) => CASES_FILE.test(file.path) || REFERENCE_FILE.test(file.path));

/** A stable fingerprint of a project snapshot (path → content hash). */
export function fingerprintOf(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const key of [...files.keys()].sort()) {
    hash.update(`${key}\0${files.get(key)}\n`);
  }
  return hash.digest('hex');
}
