/**
 * The host's measured runs of a frozen acceptance check with numeric
 * criteria (see `metricAcceptance.ts`). Each run is a full protected
 * acceptance run (frozen files, project record, trace). Only observations
 * attached by the extension host count. Values declared by the frozen check
 * are read only from its private results channel and remain lower-trust.
 *
 * Free of the `vscode` API: the protected run is passed in as `runOnce`.
 */

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  type CheckResult,
  evaluateMetrics,
  METRIC_REPEAT_ENV,
  METRIC_REPEATS_ENV,
  METRIC_RESULTS_ENV,
  type MetricSpec,
} from './metricAcceptance.js';
import { snapshotProject } from './projectSnapshot.js';

const MAX_SCANNED_BYTES = 512 * 1024;

const notVerifiable = (summary: string): CheckResult => ({ passed: false, summary: `not verifiable: ${summary}`, output: '', tampered: false, unverifiable: true });

/**
 * Project files, other than the frozen check, that name the results channel.
 * Code under test runs with the user's permissions, so it could write the
 * numbers itself; naming the channel is the obvious way, refused up front.
 * Not a sandbox: deliberately hidden access is not detected.
 */
export async function filesNamingResultsChannel(root: string, frozen: ReadonlySet<string>): Promise<string[] | null> {
  const snapshot = await snapshotProject(root);
  if (!snapshot.ok) {
    return null;
  }
  const found: string[] = [];
  for (const rel of snapshot.files.keys()) {
    if (frozen.has(rel)) {
      continue;
    }
    let text: Buffer;
    try {
      text = await readFile(path.join(root, rel));
    } catch {
      return null;
    }
    if (text.length <= MAX_SCANNED_BYTES ? text.includes(METRIC_RESULTS_ENV) : true) {
      found.push(rel);
    }
  }
  return found;
}

/**
 * Compatibility telemetry for an old check during an agent-owned run. No
 * acceptance or Programme code reads it, so it has no authority.
 */
export function agentScratchResults(mission: { id: string; grant: { acceptance: { commandId: string; metrics?: unknown } | null } | null } | null | undefined, commandId: string): Record<string, string> | undefined {
  const acceptance = mission?.grant?.acceptance ?? null;
  if (mission == null || acceptance === null || acceptance.metrics === undefined || acceptance.commandId !== commandId) {
    return undefined;
  }
  const dir = path.join(os.tmpdir(), `rame-agent-results-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return { [METRIC_RESULTS_ENV]: path.join(dir, `${mission.id}.json`) };
}

type Series = { ended: CheckResult } | { ended: null; samples: Array<Record<string, number>>; last: CheckResult };

/** One measurement: `spec.repeats` full protected runs; the first run that does not pass ends it. */
async function measureSeries(spec: MetricSpec, runOnce: () => Promise<CheckResult>, approved: Set<string>, label: string): Promise<Series> {
  const samples: Array<Record<string, number>> = [];
  let last: CheckResult | null = null;
  for (let repeat = 1; repeat <= spec.repeats; repeat++) {
    const run = await runOnce();
    for (const rel of run.approved ?? []) {
      approved.add(rel);
    }
    if (!run.passed) {
      return { ended: { ...run, summary: spec.repeats > 1 || label !== '' ? `${label}measured run ${repeat}/${spec.repeats}: ${run.summary}` : run.summary, ...(approved.size > 0 ? { approved: [...approved] } : {}) } };
    }
    last = run;
    if (run.hostMetrics === undefined) {
      return { ended: notVerifiable(`${label}measured run ${repeat}/${spec.repeats} ended without official metric evidence`) };
    }
    samples.push({ ...run.hostMetrics });
  }
  return { ended: null, samples, last: last as CheckResult };
}

/**
 * The host's measurement of a frozen check with numeric criteria. When the
 * first measurement is inconclusive (its runs disagree more than allowed:
 * noise, a busy machine), the host measures again ONCE, by itself, with the
 * same criteria, repeats and spread; no model is involved. Only the second
 * measurement is judged, and both are reported. Inconclusive twice is never
 * a pass (`inconclusive`). A failed, invalid or unverifiable measurement is
 * never repeated. `stopped` (Pause, Cancel, a reload) ends it before the
 * second measurement starts.
 */
export async function runMeasuredAcceptance(
  spec: MetricSpec,
  _root: string,
  _frozen: readonly string[],
  runOnce: () => Promise<CheckResult>,
  options: { stopped?: () => boolean } = {},
): Promise<CheckResult> {
  const approved = new Set<string>();
  const first = await measureSeries(spec, runOnce, approved, '');
  if (first.ended !== null) {
    return first.ended;
  }
  const judgedFirst = evaluateMetrics(spec, first.samples);
  if (judgedFirst.verdict !== 'inconclusive') {
    return conclude(spec, judgedFirst, first, approved, null);
  }
  const firstLines = judgedFirst.lines.join('; ');
  if (options.stopped?.() === true) {
    return { passed: false, summary: `stopped before the host measured again (the first measurement was inconclusive: ${firstLines})`, output: '', tampered: false, interrupted: true, remeasured: firstLines, ...(approved.size > 0 ? { approved: [...approved] } : {}) };
  }
  const second = await measureSeries(spec, runOnce, approved, 'second measurement, ');
  if (second.ended !== null) {
    return { ...second.ended, remeasured: firstLines };
  }
  return conclude(spec, evaluateMetrics(spec, second.samples), second, approved, judgedFirst);
}

function conclude(spec: MetricSpec, judged: ReturnType<typeof evaluateMetrics>, series: { samples: unknown[]; last: CheckResult }, approved: ReadonlySet<string>, first: ReturnType<typeof evaluateMetrics> | null): CheckResult {
  const measured = judged.lines.join('; ');
  const again = first === null ? '' : 'second measurement (the first was inconclusive): ';
  const extra = { ...(approved.size > 0 ? { approved: [...approved] } : {}), ...(first === null ? {} : { remeasured: first.lines.join('; ') }) };
  const before = first === null ? '' : `\nFirst measurement by the host (inconclusive; measured again once):\n${first.lines.join('\n')}`;
  const declared = spec.criteria.some((criterion) => !['wall_ms', 'exit_code'].includes(criterion.metric));
  const heading = declared ? 'Metrics judged by the host (including project-declared values)' : 'Measured by the host';
  const prefix = declared ? 'metrics judged by the host' : 'metrics measured by the host';
  const output = `${series.last.output}${before}\n${heading} (${series.samples.length} run(s)${first === null ? '' : ', second measurement'}):\n${judged.lines.join('\n')}`;
  if (judged.verdict === 'pass') {
    // Metrics first: the host record keeps a bounded line, and they are what this check adds.
    return { ...series.last, summary: `${prefix}: ${again}${measured}; ${series.last.summary}`, output, ...extra };
  }
  if (judged.verdict === 'inconclusive') {
    return first === null
      ? { passed: false, summary: `metrics inconclusive (the runs disagree more than allowed; not counted): ${measured}`, output, tampered: false, ...extra }
      : { passed: false, summary: `metrics inconclusive twice (the runs disagree more than ${spec.maxSpreadPct}% in both measurements; not counted): second: ${measured}; first: ${extra.remeasured}`, output, tampered: false, inconclusive: true, ...extra };
  }
  if (judged.verdict === 'invalid') {
    return { passed: false, summary: `the measured results are incomplete: ${again}${measured}`, output, tampered: false, ...extra };
  }
  return { passed: false, summary: `metrics NOT met: ${again}${measured}`, output, tampered: false, ...extra };
}
