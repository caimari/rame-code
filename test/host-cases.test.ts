/**
 * Host-compared cases (reinforced acceptance): real child processes on a
 * temporary project. A premature exit is "incomplete", never a pass; the
 * expected values never reach the child or the failure text.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { canonical, judgeReport, parseCasesSpec, runHostCases, type CasesSpec } from '../src/hostCases.js';

const SPEC: CasesSpec = {
  module: 'src/calc.js',
  cases: [
    { call: 'add', args: [19, 23], expect: 42 },
    { call: 'add', args: [-8, -5], expect: -13 },
    { call: 'add', args: [0, 0], expect: 0 },
  ],
};

async function withModule(source: string, body: (root: string) => Promise<void>, file = 'src/calc.js', packageJson = '{"name":"calc","private":true}'): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-cases-'));
  try {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
    writeFileSync(path.join(root, 'package.json'), packageJson);
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a correct implementation passes; a wrong one fails without quoting the expected values', async () => {
  await withModule('exports.add = (a, b) => a + b;\n', async (root) => {
    assert.deepEqual(await runHostCases(root, SPEC), { status: 'passed', total: 3 });
  });
  await withModule('exports.add = (a, b) => a - b;\n', async (root) => {
    const outcome = await runHostCases(root, SPEC);
    assert.equal(outcome.status, 'failed');
    assert.equal(JSON.stringify(outcome).includes('42'), false, 'the expected value is not quoted');
    assert.deepEqual((outcome as { failed: Array<{ index: number }> }).failed.map((entry) => entry.index), [0, 1]);
  });
});

test('process.exit(0) while a fresh case loads is incomplete; process state never carries to the next case', async () => {
  await withModule('process.exit(0);\nexports.add = (a, b) => a + b;\n', async (root) => {
    const outcome = await runHostCases(root, SPEC);
    assert.equal(outcome.status, 'incomplete');
    assert.match((outcome as { reason: string }).reason, /ended before every case returned \(0 of 1\)/);
  });
  await withModule('let n = 0;\nexports.add = (a, b) => { if (++n === 2) process.exit(0); return a + b; };\n', async (root) => {
    const outcome = await runHostCases(root, SPEC);
    assert.deepEqual(outcome, { status: 'passed', total: 3 });
  });
});

test('results forged on the channel by the code under test do not pass', async () => {
  // It writes a claimed result for case 0, then exits before RAME's runner finishes.
  const forged = "require('node:fs').writeSync(3, JSON.stringify({ id: 0, ok: true, value: 42 }) + '\\n');\nrequire('node:fs').writeSync(3, JSON.stringify({ witness: 'guess' }) + '\\n');\nprocess.exit(0);\n";
  await withModule(forged, async (root) => {
    const outcome = await runHostCases(root, SPEC);
    assert.equal(outcome.status, 'incomplete');
  });
});

test('ES modules (.mjs, or "type": "module") load the same way', async () => {
  await withModule('export const add = (a, b) => a + b;\n', async (root) => {
    assert.deepEqual(await runHostCases(root, { ...SPEC, module: 'src/calc.mjs' }), { status: 'passed', total: 3 });
  }, 'src/calc.mjs');
  await withModule('export function add(a, b) { return a + b; }\n', async (root) => {
    assert.deepEqual(await runHostCases(root, SPEC), { status: 'passed', total: 3 });
  }, 'src/calc.js', '{"name":"calc","private":true,"type":"module"}');
});

test('the cases file is validated; comparison is canonical JSON; the report is judged strictly', () => {
  assert.equal(parseCasesSpec('{').ok, false);
  assert.equal(parseCasesSpec('{"rameCases":1,"module":"../x.js","cases":[{"call":"f","args":[],"expect":1}]}').ok, false);
  assert.equal(parseCasesSpec('{"rameCases":1,"module":"/abs.js","cases":[{"call":"f","args":[],"expect":1}]}').ok, false);
  assert.equal(parseCasesSpec('{"rameCases":1,"module":"a.js","cases":[]}').ok, false);
  assert.equal(parseCasesSpec('{"rameCases":1,"module":"a.js","cases":[{"call":"f","args":[]}]}').ok, false, 'a case needs expect');
  assert.deepEqual(parseCasesSpec('{"rameCases":1,"module":"a.js","cases":[{"call":"f","args":[1],"expect":{"b":1,"a":2}}]}'), { ok: true, spec: { module: 'a.js', cases: [{ call: 'f', args: [1], expect: { b: 1, a: 2 } }] } });
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
  const tokens = { start: 's', end: 'e' };
  const one: CasesSpec = { module: 'a.js', cases: [{ call: 'f', args: [], expect: 1 }] };
  const line = (value: unknown) => JSON.stringify(value) + '\n';
  assert.deepEqual(judgeReport(line({ witness: 's' }) + line({ id: 0, ok: true, value: 1 }) + line({ witness: 'e' }), one, tokens), { status: 'passed', total: 1 });
  assert.equal(judgeReport(line({ id: 0, ok: true, value: 1 }) + line({ witness: 's' }) + line({ witness: 'e' }), one, tokens).status, 'incomplete', 'a result before the start witness');
  assert.equal(judgeReport(line({ witness: 's' }) + line({ id: 0, ok: true, value: 1 }), one, tokens).status, 'incomplete', 'no end witness');
  assert.equal(judgeReport(line({ witness: 's' }) + line({ id: 0, ok: true, value: 1 }) + line({ id: 0, ok: true, value: 1 }) + line({ witness: 'e' }), one, tokens).status, 'incomplete', 'answered twice');
  assert.equal(judgeReport(line({ witness: 's' }) + line({ id: 0, ok: true, value: 1 }) + line({ witness: 'x' }), one, tokens).status, 'incomplete', 'a wrong end token');
  assert.equal(judgeReport(line({ witness: 's' }) + 'not json\n', one, tokens).status, 'incomplete');
});
