/**
 * P5b: the differential comparison with a frozen original (referenceCheck.ts).
 * Real child processes, real files; no model.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  edgeValues,
  freezeReference,
  freezeReferencesFor,
  type FrozenReference,
  generateInputs,
  generatePools,
  parseReferenceSpec,
  referenceProblem,
  replayRecordInputs,
  runDifferential,
  verifyReferenceCopy,
} from '../src/referenceCheck.js';

const M = 1000003;
const K = 7919;
const SLOW = `function checksum(n) {\n  let s = 0;\n  for (let i = 0; i < n; i++) s = (s + i * ${K}) % ${M};\n  return s;\n}\nmodule.exports = { checksum };\n`;
// Fast, and right for small inputs; wrong for most inputs above about 1.5 million (floating point).
const FLOAT = `function checksum(n) {\n  return (${K} * n * (n - 1) / 2) % ${M};\n}\nmodule.exports = { checksum };\n`;
const EXACT = `function checksum(n) {\n  const a = n % 2 === 0 ? (n / 2) % ${M} : n % ${M};\n  const b = n % 2 === 0 ? (n - 1) % ${M} : ((n - 1) / 2) % ${M};\n  return (${K} * ((a * b) % ${M})) % ${M};\n}\nmodule.exports = { checksum };\n`;
const slow = (n: number): number => {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + i * K) % M;
  return s;
};
const SPEC = JSON.stringify({ rameReference: 1, module: 'lib/report.js', call: 'checksum', args: [{ int: { min: 0, max: 4000000 } }], edges: [[3]], random: 16, reserved: 12 });

function project(code: string, spec = SPEC): { root: string; store: string; dispose: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-ref-project-'));
  const store = mkdtempSync(path.join(os.tmpdir(), 'rame-ref-store-'));
  mkdirSync(path.join(root, 'lib'));
  mkdirSync(path.join(root, 'acceptance'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'report', private: true }));
  writeFileSync(path.join(root, 'lib', 'report.js'), code);
  writeFileSync(path.join(root, 'acceptance', 'report.rame-reference.json'), spec);
  return { root, store, dispose: () => [root, store].forEach((dir) => rmSync(dir, { recursive: true, force: true })) };
}

async function frozenOf(root: string, store: string, spec = SPEC): Promise<FrozenReference> {
  const frozen = await freezeReference(root, 'acceptance/report.rame-reference.json', spec, path.join(store, 'ref'));
  assert.ok(frozen.ok, frozen.ok ? '' : frozen.error);
  return frozen.frozen;
}

test('reference spec: strict validation, defaults, and a reserved pool that always exists', () => {
  const ok = parseReferenceSpec(SPEC);
  assert.ok(ok.ok);
  assert.deepEqual(ok.spec.files, ['lib/report.js'], 'the module is the default reference file');
  assert.equal(ok.spec.timeoutMs, 120_000);
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ module: '../x.js' }, /inside the project/],
    [{ files: ['lib/other.js'] }, /must include the module/],
    [{ files: ['lib/report.js', 'package.json'] }, /not package\.json/],
    [{ reserved: 0 }, /"reserved" 1 to 500/],
    [{ random: 501 }, /"random" must be 0 to 500/],
    [{ edges: [[1, 2]] }, /one value per argument/],
    [{ args: [{ int: { min: 0, max: 2 ** 60 } }] }, /safe integers/],
    [{ args: [{ float: {} }] }, /unknown argument kind float/],
    [{ args: [{ int: { min: 5, max: 1 } }] }, /min <= max/],
    [{ timeoutMs: 10 }, /timeoutMs/],
  ];
  for (const [change, error] of bad) {
    const parsed = parseReferenceSpec(JSON.stringify({ ...JSON.parse(SPEC), ...change }));
    assert.ok(!parsed.ok, JSON.stringify(change));
    assert.match(parsed.error, error);
  }
  assert.ok(!parseReferenceSpec('{"rameCases":1}').ok);
});

test('inputs: reproducible from the seed, with edge values and every magnitude, small and large', () => {
  const parsed = parseReferenceSpec(JSON.stringify({ ...JSON.parse(SPEC), args: [{ int: { min: 0, max: 2000000000 } }], random: 200 }));
  assert.ok(parsed.ok);
  const spec = parsed.spec;
  const a = generateInputs(spec, 'seed-1', 200, true);
  assert.deepEqual(generateInputs(spec, 'seed-1', 200, true), a, 'the same seed gives the same inputs');
  assert.notDeepEqual(generateInputs(spec, 'seed-2', 200, true), a, 'another seed gives other inputs');
  const values = a.map((input) => input[0] as number);
  for (const edge of [0, 1, 2, 3, 2000000000, 1999999999, 1000000000, 2 ** 24, 2 ** 24 + 1, 65535, 65536]) {
    assert.ok(values.includes(edge), `edge ${edge}`);
  }
  assert.ok(values.filter((n) => n < 10000).length >= 20, 'small values are drawn too');
  assert.ok(values.filter((n) => n > 100000000).length >= 50, 'large values are drawn too');
  assert.ok(values.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 2000000000));
  assert.deepEqual(edgeValues({ bool: true }), [false, true]);
  assert.deepEqual(edgeValues({ string: { maxLength: 3, alphabet: 'xy' } }), ['', 'x', 'xxx']);
  const reserved = generateInputs(spec, 'seed-r', 30, false);
  assert.equal(reserved.length, 30, 'the reserved pool has random inputs only');
});

test('the reserved pool never repeats an input of the shown pool, keeps its size, and a record replays the same pools', () => {
  // Draws favour values near the limits, which the shown pool always has: before this rule, about a
  // third of the checks of SPEC had a "reserved" input the agent had been shown (measured 2026-11-08).
  const parsed = parseReferenceSpec(SPEC);
  assert.ok(parsed.ok);
  for (let i = 0; i < 300; i++) {
    const seeds = { shown: `shown-${i}`, reserved: `reserved-${i}` };
    const pools = generatePools(parsed.spec, seeds);
    const shown = new Set(pools.shown.map((input) => JSON.stringify(input)));
    assert.equal(pools.reserved.some((input) => shown.has(JSON.stringify(input))), false, `seeds ${i}`);
    assert.equal(pools.reserved.length, 12);
    const replay = replayRecordInputs(SPEC, seeds);
    assert.deepEqual([replay?.shown, replay?.reserved], [pools.shown, pools.reserved], 'the record reproduces exactly what was checked');
  }
});

test('freezing: the copy lives outside the project and any change, addition or removal is detected', async () => {
  const p = project(SLOW);
  try {
    const frozen = await frozenOf(p.root, p.store);
    assert.ok(!frozen.dir.startsWith(p.root));
    assert.deepEqual(frozen.files.map((file) => file.path), ['lib/report.js', 'package.json']);
    assert.equal(await verifyReferenceCopy(frozen), null);
    // The project changes (the agent's work): the frozen copy does not.
    writeFileSync(path.join(p.root, 'lib', 'report.js'), FLOAT);
    assert.equal(readFileSync(path.join(frozen.dir, 'files', 'lib', 'report.js'), 'utf8'), SLOW);
    writeFileSync(path.join(frozen.dir, 'files', 'lib', 'helper.js'), 'module.exports = 1;\n');
    assert.match(String(await verifyReferenceCopy(frozen)), /lib\/helper\.js was added to it/);
    rmSync(path.join(frozen.dir, 'files', 'lib', 'helper.js'));
    writeFileSync(path.join(frozen.dir, 'files', 'lib', 'report.js'), FLOAT);
    assert.match(String(await verifyReferenceCopy(frozen)), /lib\/report\.js changed in it/);
    rmSync(path.join(frozen.dir, 'files', 'lib', 'report.js'));
    assert.match(String(await verifyReferenceCopy(frozen)), /lib\/report\.js is missing from it/);
  } finally {
    p.dispose();
  }
});

test('differential: fast but imprecise fails; the agent sees a few failing inputs, never the original results or the reserved inputs; the record reproduces it', async () => {
  const p = project(SLOW);
  try {
    const frozen = await frozenOf(p.root, p.store);
    writeFileSync(path.join(p.root, 'lib', 'report.js'), FLOAT);
    // Fixed seeds: with fresh ones, about 1 check in 1,300 draws 12 reserved inputs all on values
    // where FLOAT happens to be right (measured 2026-11-08), and this test asserts reserved differences.
    // These give 10 shown and 3 reserved differences.
    const outcome = await runDifferential(p.root, frozen, SPEC, { seeds: { shown: 'differential-shown-1', reserved: 'differential-reserved-1' } });
    assert.equal(outcome.kind, 'failed', outcome.summary);
    assert.match(outcome.summary, /^the differential comparison with the frozen original \(acceptance\/report\.rame-reference\.json\) failed: \d+ of \d+ shown inputs and \d+ of 12 reserved inputs gave a different result; for example checksum\(\d+\) returned a different result than the original/);
    assert.match(outcome.summary, /\(the original's results and the reserved inputs are not shown\); host record /);
    const examples = [...outcome.summary.matchAll(/checksum\((\d+)\)/g)].map((match) => Number(match[1]));
    assert.ok(examples.length >= 1 && examples.length <= 3);
    for (const n of examples) {
      assert.ok(!outcome.summary.includes(String(slow(n))), `the original's result for ${n} is not shown`);
    }
    // The host record: seeds, hashes and every difference with both results, outside the project.
    const record = JSON.parse(readFileSync(outcome.record as string, 'utf8')) as {
      seeds: { shown: string; reserved: string };
      inputsDigest: { shown: string; reserved: string };
      original: Array<{ path: string; hash: string }>;
      candidate: { hash: string };
      outcome: string;
      differences: Array<{ pool: string; input: number[]; original: { value: number } }>;
    };
    assert.ok(!(outcome.record as string).startsWith(p.root));
    assert.equal(record.outcome, 'failed');
    assert.deepEqual(record.original, frozen.files);
    const reservedDiffs = record.differences.filter((entry) => entry.pool === 'reserved');
    assert.ok(reservedDiffs.length > 0, 'the reserved pool found differences too');
    for (const entry of reservedDiffs) {
      assert.ok(!outcome.summary.includes(`checksum(${entry.input[0]})`), 'a reserved input is never shown');
    }
    for (const entry of record.differences.slice(0, 5)) {
      assert.equal(entry.original.value, slow(entry.input[0] as number), 'the record keeps the original result, for the user');
    }
    const replay = replayRecordInputs(SPEC, record.seeds);
    assert.deepEqual(replay?.digest, record.inputsDigest, 'the seeds reproduce exactly the inputs of that pass');
    // Run it again with the recorded seeds: the same differences.
    const again = await runDifferential(p.root, frozen, SPEC, { seeds: record.seeds });
    assert.equal(again.kind, 'failed');
    assert.equal(again.summary.replace(/host record .*$/, ''), outcome.summary.replace(/host record .*$/, ''));
    // The exact fix passes, on fresh inputs.
    writeFileSync(path.join(p.root, 'lib', 'report.js'), EXACT);
    const fixed = await runDifferential(p.root, frozen, SPEC);
    assert.equal(fixed.kind, 'passed', fixed.summary);
    assert.match(fixed.summary, /^differential with the frozen original \(acceptance\/report\.rame-reference\.json\): \d+ inputs \(\d+ edge and random, 12 reserved\) gave the same results as the original; host record /);
  } finally {
    p.dispose();
  }
});

test('differential sabotage: right only on the edge values, ending the process, forging the results channel, reading the reference, changed spec or copy', async () => {
  const p = project(SLOW);
  try {
    const frozen = await frozenOf(p.root, p.store);
    const write = (code: string) => writeFileSync(path.join(p.root, 'lib', 'report.js'), code);
    // Correct for every value it could know in advance (the edges), wrong elsewhere.
    const edges = JSON.stringify(edgeValues({ int: { min: 0, max: 4000000 } }));
    write(`${SLOW.replace('module.exports = { checksum };', '')}const known = new Set(${edges});\nmodule.exports = { checksum: (n) => (known.has(n) || n === 3 ? checksum(n) : (${K} * n * (n - 1) / 2) % ${M}) };\n`);
    const special = await runDifferential(p.root, frozen, SPEC);
    assert.equal(special.kind, 'failed');
    assert.match(special.summary, /and [1-9]\d* of 12 reserved inputs gave a different result/, 'fresh random inputs catch it');
    write("process.exit(0);\n");
    const ended = await runDifferential(p.root, frozen, SPEC);
    assert.equal(ended.kind, 'failed');
    assert.match(ended.summary, /is incomplete: the run ended before every case returned/);
    write("require('node:fs').writeSync(3, JSON.stringify({ id: 0, ok: true, value: 0 }) + '\\n');\nmodule.exports = { checksum: () => 0 };\n");
    const forged = await runDifferential(p.root, frozen, SPEC);
    assert.equal(forged.kind, 'failed');
    // It cannot know the witness tokens: its line is taken as an answer, then the real one makes it answered twice.
    assert.match(forged.summary, /is incomplete: case 1 was answered twice/);
    write(`require('node:fs').readFileSync(require('node:path').join(process.cwd(), 'acceptance', 'report.rame-reference.json'));\n${EXACT}`);
    const peeked = await runDifferential(p.root, frozen, SPEC);
    assert.equal(peeked.kind, 'unverifiable');
    assert.match(peeked.summary, /the code under test read acceptance\/report\.rame-reference\.json during the differential comparison/);
    write(EXACT);
    const changedSpec = await runDifferential(p.root, frozen, SPEC.replace('"reserved":12', '"reserved":1'));
    assert.equal(changedSpec.kind, 'tampered');
    writeFileSync(path.join(frozen.dir, 'files', 'lib', 'report.js'), EXACT);
    const changedCopy = await runDifferential(p.root, frozen, SPEC);
    assert.equal(changedCopy.kind, 'tampered');
    assert.match(changedCopy.summary, /the host's frozen copy of the original for acceptance\/report\.rame-reference\.json can no longer be trusted: lib\/report\.js changed in it/);
  } finally {
    p.dispose();
  }
});

test('differential: an original too slow for its limit cannot judge (not the agent\'s fault); a stop is an interruption, not a result', async () => {
  const slowSpec = JSON.stringify({ ...JSON.parse(SPEC), args: [{ int: { min: 3000000000, max: 4000000000 } }], timeoutMs: 1000 });
  const p = project(SLOW, slowSpec);
  try {
    const frozen = await frozenOf(p.root, p.store, slowSpec);
    writeFileSync(path.join(p.root, 'lib', 'report.js'), EXACT);
    const timedOut = await runDifferential(p.root, frozen, slowSpec);
    assert.equal(timedOut.kind, 'unverifiable');
    assert.match(timedOut.summary, /the frozen original for acceptance\/report\.rame-reference\.json did not answer every input \(the cases did not finish in time\); give it fewer inputs or more time/);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const stopped = await runDifferential(p.root, frozen, slowSpec, { signal: controller.signal });
    assert.equal(stopped.kind, 'interrupted');
  } finally {
    p.dispose();
  }
});

test('a non-deterministic original cannot be a reference; a deterministic one can', async () => {
  const p = project('module.exports = { checksum: (n) => n + Math.floor(Math.random() * 1000) };\n');
  try {
    assert.match(String(await referenceProblem(p.root, 'acceptance/report.rame-reference.json', SPEC)), /gave two different results for checksum\(\d+\); a function that does not always give the same result cannot be a reference/);
    writeFileSync(path.join(p.root, 'lib', 'report.js'), EXACT);
    assert.equal(await referenceProblem(p.root, 'acceptance/report.rame-reference.json', SPEC), null);
    writeFileSync(path.join(p.root, 'lib', 'report.js'), 'module.exports = { other: () => 1 };\n');
    assert.match(String(await referenceProblem(p.root, 'acceptance/report.rame-reference.json', SPEC)), /threw on every input/);
  } finally {
    p.dispose();
  }
});

test('the folder that keeps frozen originals must be this user\'s and writable by nobody else', { skip: process.platform === 'win32' ? 'POSIX permissions' : false }, async () => {
  const p = project(SLOW);
  try {
    const jobsRoot = path.join(p.store, 'jobs');
    mkdirSync(path.join(p.store, 'references'), { mode: 0o777 });
    chmodSync(path.join(p.store, 'references'), 0o777);
    const refused = await freezeReferencesFor(p.root, [{ path: 'acceptance/report.rame-reference.json' }], async () => SPEC, jobsRoot, 'mis_test');
    assert.ok(!refused.ok);
    assert.match(refused.error, /RAME cannot keep the frozen original safely: .*references can be written by other users\./);
    chmodSync(path.join(p.store, 'references'), 0o700);
    const frozen = await freezeReferencesFor(p.root, [{ path: 'acceptance/report.rame-reference.json' }], async () => SPEC, jobsRoot, 'mis_test');
    assert.ok(frozen.ok, frozen.ok ? '' : frozen.error);
    assert.equal(frozen.references.length, 1);
    assert.ok(frozen.references[0]!.dir.startsWith(path.join(p.store, 'references')));
  } finally {
    p.dispose();
  }
});
