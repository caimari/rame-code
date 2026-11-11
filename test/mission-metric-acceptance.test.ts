/**
 * Measured acceptance (piece F, P1 of the long-Mission plan). Found in P0
 * (B-27): a Mission ended "completed and verified" with a results.json the
 * model wrote by hand. With numeric criteria, only numbers the host reads
 * from its own results file, after its own protected runs, can meet them.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  evaluateMetrics,
  METRIC_REPEAT_ENV,
  METRIC_RESULTS_ENV,
  parseResultsFile,
  validateMetricSpec,
  type CheckResult,
  type MetricSpec,
} from '../src/metricAcceptance.js';
import { runMeasuredAcceptance } from '../src/metricRun.js';
import { verificationChanged } from '../src/acceptanceRun.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { setIsolationProbe, UNPROTECTED_VERIFICATION_WARNING } from '../src/shellIsolation.js';
import { assistantText, fakeWindow, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const spec = (criteria: MetricSpec['criteria'], repeats = 3, maxSpreadPct = 15): MetricSpec => ({ criteria, repeats, maxSpreadPct });
const P95 = { metric: 'p95_ms', op: '<=' as const, value: 50 };
const ERR = { metric: 'errors', op: '<=' as const, value: 0 };
const WALL = { metric: 'wall_ms', op: '<=' as const, value: 50 };

// ---- Pure parts ----

test('criteria: host-observed and project-declared metrics get defaults; malformed criteria are refused', () => {
  const ok = validateMetricSpec({ criteria: [WALL] });
  assert.deepEqual(ok, { ok: true, spec: { criteria: [WALL], repeats: 3, maxSpreadPct: 15 } });
  assert.equal(validateMetricSpec({ criteria: [P95] }).ok, true, 'an old Mission may keep its project-declared p95 metric');
  const bad: Array<[unknown, RegExp]> = [
    [null, /list of criteria/],
    [{ criteria: [] }, /1 to 8 criteria/],
    [{ criteria: Array.from({ length: 9 }, (_, i) => ({ metric: `m${i}`, op: '<=', value: 1 })) }, /1 to 8 criteria/],
    [{ criteria: [{ metric: 'P95', op: '<=', value: 1 }] }, /lowercase/],
    [{ criteria: [{ metric: 'wall_ms', op: '<', value: 1 }] }, /<= or >=/],
    [{ criteria: [{ metric: 'wall_ms', op: '<=', value: Number.NaN }] }, /finite/],
    [{ criteria: [{ metric: 'wall_ms', op: '<=', value: '50' }] }, /finite/],
    [{ criteria: [WALL, WALL] }, /twice/],
    [{ criteria: [WALL], repeats: 0 }, /1 to 5 repeats/],
    [{ criteria: [WALL], repeats: 6 }, /1 to 5 repeats/],
    [{ criteria: [WALL], repeats: 2.5 }, /1 to 5 repeats/],
    [{ criteria: [WALL], maxSpreadPct: 0 }, /1 to 100/],
  ];
  for (const [raw, error] of bad) {
    const checked = validateMetricSpec(raw);
    assert.equal(checked.ok, false, JSON.stringify(raw));
    assert.match((checked as { error: string }).error, error);
  }
});

test('results file: a flat JSON object; only finite numbers with metric-like names are kept', () => {
  assert.deepEqual(parseResultsFile('{"p95_ms": 12.5, "errors": 0, "note": "fast", "Bad": 1, "inf": 1e999}'), { ok: true, values: { p95_ms: 12.5, errors: 0 } });
  assert.match((parseResultsFile('not json') as { error: string }).error, /not valid JSON/);
  assert.match((parseResultsFile('[1,2]') as { error: string }).error, /JSON object/);
  assert.match((parseResultsFile(JSON.stringify({ pad: 'x'.repeat(17 * 1024) })) as { error: string }).error, /larger than 16 KiB/);
});

test('verdict: the median is judged only when the runs agree; a clear miss is a miss even when noisy', () => {
  const met = evaluateMetrics(spec([P95, ERR]), [{ p95_ms: 20, errors: 0 }, { p95_ms: 21, errors: 0 }, { p95_ms: 19, errors: 0 }]);
  assert.equal(met.verdict, 'pass');
  assert.match(met.lines[0] as string, /^p95_ms median 20 \(19–21, spread 4%\) <= 50: met \[declared by the project — .*malicious code in the same process can alter them\]$/);
  assert.equal(evaluateMetrics(spec([P95]), [{ p95_ms: 80 }, { p95_ms: 81 }, { p95_ms: 79 }]).verdict, 'fail', 'stable and over the threshold');
  assert.equal(evaluateMetrics(spec([P95]), [{ p95_ms: 80 }, { p95_ms: 200 }, { p95_ms: 60 }]).verdict, 'fail', 'noisy, but every run misses');
  const noisy = evaluateMetrics(spec([P95]), [{ p95_ms: 10 }, { p95_ms: 45 }, { p95_ms: 12 }]);
  assert.equal(noisy.verdict, 'inconclusive', 'every run meets it, but they disagree by 70% of the threshold');
  assert.match(noisy.lines[0] as string, /inconclusive \[declared by the project — .*\]$/);
  assert.equal(evaluateMetrics(spec([P95]), [{ p95_ms: 30 }, { p95_ms: 70 }, { p95_ms: 40 }]).verdict, 'inconclusive', 'runs on both sides of the threshold');
  assert.equal(evaluateMetrics(spec([ERR]), [{ errors: 0 }, { errors: 1 }, { errors: 0 }]).verdict, 'inconclusive', 'a flaky error count is not a pass');
  const missing = evaluateMetrics(spec([P95, ERR]), [{ p95_ms: 20, errors: 0 }, { p95_ms: 20 }]);
  assert.equal(missing.verdict, 'invalid');
  assert.match(missing.lines.join('\n'), /errors: missing from the results of run 2/);
  assert.equal(evaluateMetrics(spec([{ metric: 'rps', op: '>=', value: 1000 }], 1), [{ rps: 1200 }]).verdict, 'pass', 'one run, a lower bound');
  assert.equal(evaluateMetrics(spec([P95]), []).verdict, 'invalid');
});

// ---- The measured runs (host part, with a stand-in for the protected run) ----

async function withRoot(files: Record<string, string>, body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-metric-root-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const passing = (summary = 'npm:check exit=0 with every frozen file intact', metrics: Record<string, number> = { p95_ms: 20, errors: 0 }): CheckResult => ({ passed: true, summary, output: 'exit=0', tampered: false, hostMetrics: metrics as unknown as CheckResult['hostMetrics'] });

test('measured runs: arbitrary project result files are ignored; only the official per-run channel counts', async () => {
  await withRoot({ 'package.json': '{}', 'bench.js': `// writes ${METRIC_RESULTS_ENV}`, 'results.json': '{"p95_ms": 1}' }, async (root) => {
    let n = 0;
    const result = await runMeasuredAcceptance(spec([P95]), root, ['bench.js', 'package.json'], async () => {
      n += 1;
      return passing(undefined, { p95_ms: 70 + n });
    });
    assert.equal(result.passed, false, 'the project results.json (p95_ms 1) is never read');
    assert.match(result.summary, /^metrics NOT met: p95_ms median 72 \(71–73, spread 3%\) <= 50: NOT met \[declared by the project — .*malicious code in the same process can alter them\]$/);
  });
});

test('measured runs: an exit 0 without an official host observation is not verifiable', async () => {
  await withRoot({ 'package.json': '{}', 'results.json': '{"p95_ms": 1}' }, async (root) => {
    const result = await runMeasuredAcceptance(spec([P95]), root, ['package.json'], async () => ({ passed: true, summary: 'npm:check exit=0', output: '', tampered: false }));
    assert.equal(result.passed, false);
    assert.match(result.summary, /without official metric evidence/);
  });
});

test('measured runs: the first protected run that does not pass ends the measurement, keeping its verdict', async () => {
  await withRoot({ 'package.json': '{}' }, async (root) => {
    let runs = 0;
    const result = await runMeasuredAcceptance(spec([P95]), root, ['package.json'], async () => {
      runs += 1;
      if (runs === 2) {
        return { passed: false, summary: 'not verifiable: files changed outside the scope you authorized: x.js', output: '', tampered: false, unverifiable: true };
      }
      return passing(undefined, { p95_ms: 10 });
    });
    assert.equal(runs, 2);
    assert.equal(result.unverifiable, true);
    assert.match(result.summary, /^measured run 2\/3: not verifiable: /);
  });
});

test('measured runs: a forged legacy results channel has no authority', async () => {
  await withRoot({ 'package.json': '{}', 'acceptance/bench.js': `fs.writeFileSync(process.env.${METRIC_RESULTS_ENV}, x)`, 'app.js': `require('fs').writeFileSync(process.env.${METRIC_RESULTS_ENV}, '{"p95_ms":1}')` }, async (root) => {
    let runs = 0;
    const result = await runMeasuredAcceptance(spec([P95]), root, ['acceptance/bench.js', 'package.json'], async () => {
      runs += 1;
      return passing();
    });
    assert.equal(runs, 3);
    assert.equal(result.passed, true);
  });
});

test('measured runs: met criteria retain the check summary and label every project-declared metric', async () => {
  await withRoot({ 'package.json': '{}' }, async (root) => {
    const result = await runMeasuredAcceptance(spec([P95, ERR], 2), root, ['package.json'], async () => {
      return { ...passing(undefined, { p95_ms: 20, errors: 0 }), approved: ['src/new.js'] };
    });
    assert.equal(result.passed, true);
    assert.match(result.summary, /^metrics judged by the host: p95_ms median 20 \(20–20, spread 0%\) <= 50: met \[declared by the project — .*\]; errors median 0 \(0–0, spread 0%\) <= 0: met \[declared by the project — .*\]; npm:check exit=0 with every frozen file intact$/);
    assert.deepEqual(result.approved, ['src/new.js']);
    assert.match(result.output, /Metrics judged by the host \(including project-declared values\) \(2 run\(s\)\):/);
  });
});

// ---- A whole Mission, with the real host and a scripted model ----

// The frozen check performs real work; elapsed wall time is measured outside
// the project by the extension host.
const BENCH =
  "const { latencyMs } = require('../app.js');\n" +
  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, latencyMs);\n';
// The slow code waits well above the threshold and the fast code waits 0, so the start-up cost of a check run
// never decides the verdict. CI evidence (2026-11-11, ubuntu-latest): an acceptance run with a 0 ms wait took
// 996-1133 ms there (RAME's trace hooks plus process start-up), so the old 1000 ms threshold failed B-27 twice.
// 2500 still leaves the slow code (3000 ms) out at any start-up cost.
const SLOW = 'module.exports = { latencyMs: 3000 };\n';
const FAST = 'module.exports = { latencyMs: 0 };\n';
const HOST_WALL = { metric: 'wall_ms', op: '<=' as const, value: 2500 };
const CRITERIA = { criteria: [HOST_WALL], repeats: 3, maxSpreadPct: 30 };
const stored = (h: HostHarness): MissionRecord => (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;
const notes = (h: HostHarness): string => stored(h).evidence.map((entry) => entry.text).join('\n');
const patch = (id: string, file: string, before: string, after: string) => ({ kind: 'json' as const, body: toolCallReply([{ id, name: 'apply_patch', args: { files: [{ path: file, expectedHash: sha(before), newContent: after }] } }]) });
const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });

async function withMeasuredMission(body: (h: HostHarness, mission: { id: string; revision: number }) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'measured', private: true, scripts: { test: 'node t.js', check: 'node acceptance/bench.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await h.writeFile('app.js', SLOW);
    await h.writeFile('acceptance/bench.js', BENCH);
    const plan = { goal: 'Make app.js fast enough.', assumptions: [], steps: [{ id: 't1', title: 'Speed up app.js', successCriterion: 'wall_ms <= 2500 measured by the host' }], risks: [] };
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: plan }]) });
    await h.provider.sendMessage('Make app.js fast enough: p95 at most 50 ms.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const shown = (await h.waitFor((state: PostedState) => (state.memory as { mission: unknown } | undefined)?.mission != null)).memory as { mission: { id: string; revision: number } };
    h.model.requests.length = 0;
    fakeWindow.warningCalls.length = 0;
    await body(h, shown.mission);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

test('B-27 sabotage: hand-written good numbers do not complete the Mission; only the host measurement does', async () => {
  await withMeasuredMission(async (h, mission) => {
    h.model.enqueue(
      // Run 1: the agent "proves" it with a results file of its own and leaves the code slow.
      patch('fake', 'results.json', '', JSON.stringify({ p95_ms: 5, errors: 0 })),
      say('Done: results.json shows p95 5 ms.'),
      say('Done, no test needed.'),
      // Run 2: after the host's feedback, the agent fixes the code.
      patch('fix', 'app.js', SLOW, FAST),
      say('Done: app.js is faster.'),
      say('Done, no test needed.'),
    );
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/bench.js'], metrics: CRITERIA });
    const record = stored(h);
    const text = notes(h);
    assert.match(text, /measured acceptance: wall_ms <= 2500 \[observed by the host\] \(median of 3 check run\(s\), spread up to 30%\)/);
    assert.deepEqual(record.grant?.acceptance?.metrics, CRITERIA, 'the criteria are part of the grant');
    const prompt = JSON.stringify(h.model.requests[0]);
    assert.match(prompt, /The host judges: wall_ms <= 2500 \[observed by the host\]/);
    assert.match(prompt, /Host-observed values have maximum trust/);
    // The first host check measured the slow code, whatever results.json said.
    assert.match(text, /acceptance \(run by the host\): metrics NOT met: wall_ms median .* <= 2500: NOT met/);
    assert.match(JSON.stringify(h.model.requests), /ACCEPTANCE FAILED: .*metrics NOT met: wall_ms median/, 'the agent was told what the host measured');
    // Then the fix: measured, met, completed.
    assert.equal(record.status, 'completed', record.note);
    assert.match(text, /acceptance \(run by the host\): metrics measured by the host: wall_ms median .* <= 2500: met \[observed by the host\]; npm:check exit=0 with every frozen file intact; protected verification/);
    assert.equal(await h.readFile('results.json'), JSON.stringify({ p95_ms: 5, errors: 0 }), 'the hand-written file is still there, never used');
    const scopeReviews = fakeWindow.warningCalls.filter((call) => /^Count the acceptance check npm:check with these changes\?$/.test(call.message));
    assert.equal(scopeReviews.length, 1, 'the new results.json is reviewed once, not once per measured run');
    assert.match(scopeReviews[0]?.detail ?? '', /results\.json look like tests or data/, 'and the dialog warns that it looks like data');
  });
});

test('code under test cannot forge acceptance through the legacy results channel', async () => {
  await withMeasuredMission(async (h, mission) => {
    const cheat = `const key = Object.keys(process.env).find((name) => name.endsWith('RESULTS_FILE')); if (key) require('node:fs').writeFileSync(process.env[key], '{"wall_ms":1}');\nmodule.exports = { latencyMs: 3000 };\n`;
    h.model.enqueue(patch('cheat', 'app.js', SLOW, cheat), say('Done.'), say('Done, no test needed.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/bench.js'], metrics: CRITERIA });
    const record = stored(h);
    assert.equal(record.status, 'blocked', record.note);
    assert.match(record.note, /acceptance check kept failing \(metrics NOT met: wall_ms median/);
    assert.doesNotMatch(notes(h), /metrics measured by the host/);
  });
});

test('invalid criteria authorize nothing; valid ones survive a reload in the stored grant', async () => {
  await withMeasuredMission(async (h, mission) => {
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/bench.js'], metrics: { criteria: [{ metric: 'wall_ms', op: '<', value: 1000 }] } });
    assert.match(h.last().status, /^The acceptance criteria are not valid: wall_ms: the comparison must be <= or >=\. Nothing was authorized\.$/);
    assert.equal(stored(h).grant, null);
    assert.equal(h.model.requests.length, 0, 'nothing was sent to the model');
    // A valid grant, then a reload: the criteria are read back from the stored Mission.
    h.model.enqueue(patch('fix', 'app.js', SLOW, FAST), say('Done.'), say('Done, no test needed.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/bench.js'], metrics: { criteria: [HOST_WALL], repeats: 2, maxSpreadPct: 30 } });
    assert.equal(stored(h).status, 'completed', stored(h).note);
    h.provider.dispose();
    h.createProvider();
    assert.deepEqual(stored(h).grant?.acceptance?.metrics, { criteria: [HOST_WALL], repeats: 2, maxSpreadPct: 30 });
  });
});

test('without Landlock a Mission runs without confirmation and records the warning and unprotected result', async () => {
  setIsolationProbe({ platform: 'win32', run: async () => '' });
  try {
    await withMeasuredMission(async (h, mission) => {
      h.model.enqueue(patch('fix', 'app.js', SLOW, FAST), say('Done.'), say('Done, no test needed.'));
      await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/bench.js'], metrics: CRITERIA });
      const record = stored(h);
      const text = notes(h);
      assert.equal(record.status, 'completed', record.note);
      assert.match(text, new RegExp(UNPROTECTED_VERIFICATION_WARNING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(text, /verification: unprotected/);
      assert.doesNotMatch(text.split('\n').find((line) => line.includes('acceptance (run by the host):')) ?? '', /verification: protected|protected level/);
      assert.equal(fakeWindow.warningCalls.some((call) => /Continue without isolation|Continuar sin aislamiento|Cancel verification|Cancelar la verificación/i.test(call.message)), false);
    });
  } finally {
    setIsolationProbe(null);
  }
});

test('the same Mission changing from protected to unprotected continues and marks the transition', () => {
  const mission = { evidence: [{ kind: 'note', text: 'acceptance (run by the host): passed; verification: protected' }] } as Pick<MissionRecord, 'evidence'>;
  const mode = { kind: 'unprotected' as const, reason: 'Landlock disappeared after the first execution' };
  assert.equal(verificationChanged(mission, mode), true);
  assert.equal(`verification changed from protected to unprotected: ${mode.reason}`, 'verification changed from protected to unprotected: Landlock disappeared after the first execution');
});

test('an older Mission with p95_ms and errors uses the frozen check private channel without reauthorization', async () => {
  await withMeasuredMission(async (h, mission) => {
    await h.writeFile('acceptance/bench.js', `if(process.env.${METRIC_RESULTS_ENV})require('node:fs').writeFileSync(process.env.${METRIC_RESULTS_ENV},JSON.stringify({p95_ms:20,errors:0}));\n`);
    h.model.enqueue(patch('fix', 'app.js', SLOW, FAST), say('Done.'), say('Done, no test needed.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, {
      commandId: 'npm:check', files: ['acceptance/bench.js'], metrics: { criteria: [P95, ERR], repeats: 2, maxSpreadPct: 15 },
    });
    const record = stored(h);
    assert.equal(record.status, 'completed', record.note);
    assert.match(notes(h), /metrics judged by the host: p95_ms median 20 .* \[declared by the project — .*malicious code in the same process can alter them\]; errors median 0/);
  });
});
