/**
 * The pure parts of a protected acceptance check: what a write may not touch,
 * how a trace is read, how dependencies are classified, and what counts as
 * a verifier using an unfrozen test file at run time.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { frozenWriteHit } from '../src/acceptanceDependencies.js';
import { acceptanceTraceEnv, classifyAcceptanceScope, parseTrace, scopeViolations, type ParsedTrace, type ScopeInput } from '../src/acceptanceTrace.js';

test('a write may not touch a frozen file, how Node finds it, or installed packages', () => {
  const frozen = ['acceptance/accept.test.js', 'acceptance/cases.json', 'test/fixtures/index.js'];
  const hit = (rel: string) => frozenWriteHit(frozen, rel);
  assert.equal(hit('acceptance/cases.json'), true, 'the file');
  assert.equal(hit('Acceptance/Cases.JSON'), true, 'another letter case (case-insensitive file systems)');
  assert.equal(hit('acceptance/cases'), true, 'an extensionless sibling Node would load first');
  assert.equal(hit('acceptance/cases.js'), true, 'a .js sibling Node would load before .json');
  assert.equal(hit('acceptance/cases.node'), true);
  assert.equal(hit('acceptance/package.json'), true, 'a package.json next to a frozen file');
  assert.equal(hit('package.json'), true, 'the root package.json');
  assert.equal(hit('test/package.json'), true, 'a package.json above a frozen file');
  assert.equal(hit('test/fixtures.js'), true, 'shadows the frozen folder entry point');
  assert.equal(hit('test/fixtures'), true);
  assert.equal(hit('node_modules/x/index.js'), true);
  assert.equal(hit('acceptance/node_modules/assert/index.js'), true, 'node_modules at any depth');
  assert.equal(hit('lib/sum.js'), false, 'the code under test stays writable');
  assert.equal(hit('lib/package.json'), false, 'a package.json elsewhere');
  assert.equal(hit('acceptance/cases.json.bak'), false);
  assert.equal(hit('acceptance/casesX.js'), false);
  assert.equal(hit('acceptance'), true, 'moving or deleting the folder of a frozen file');
});

test('a sealed folder refuses any file added, changed or removed in it, and moving it or a folder above it', () => {
  const hit = (rel: string) => frozenWriteHit(['acceptance/a.test.js', 'acceptance/'], rel);
  assert.equal(hit('acceptance/b.test.js'), true, 'a new test file the command would discover');
  assert.equal(hit('Acceptance/Run.js'), true, 'another letter case');
  assert.equal(hit('acceptance/deep/x.js'), true);
  assert.equal(hit('acceptance'), true, 'the folder itself');
  assert.equal(hit('acceptance-other/x.js'), false, 'a folder that only starts with the same name');
  assert.equal(hit('lib/sum.js'), false);
  assert.equal(frozenWriteHit(['a/b/'], 'a'), true, 'a folder above a sealed one');
});

const trace = (lines: unknown[]): ParsedTrace => parseTrace(lines.map((line) => JSON.stringify(line)).join('\n'));

test('a trace is complete only when every observed process reached its exit handler', () => {
  const ok = trace([{ kind: 'start', pid: 1, esm: true }, { kind: 'read', path: 'a.json', by: 'acceptance/a.js' }, { kind: 'end', pid: 1, code: 0 }]);
  assert.equal(ok.complete, true);
  assert.deepEqual(ok.edges, [{ kind: 'read', path: 'a.json', by: 'acceptance/a.js' }]);
  assert.equal(trace([{ kind: 'start', pid: 1, esm: true }]).complete, false, 'killed before its exit handler');
  assert.equal(trace([{ kind: 'end', pid: 1, code: 0 }]).complete, false, 'an end with no start (the trace was cut)');
  assert.equal(trace([{ kind: 'start', pid: 1, esm: true }, { kind: 'start', pid: 2, esm: true }, { kind: 'end', pid: 1 }]).complete, false, 'a child process that never ended');
  assert.equal(parseTrace('{"kind":"start","pid":1,"esm":true}\nnot json\n{"kind":"end","pid":1}').complete, false);
  assert.equal(trace([{ kind: 'start', pid: 1, esm: false }, { kind: 'end', pid: 1 }]).esm, false);
  assert.deepEqual(trace([{ kind: 'start', pid: 1, esm: true, node: 'v24.22.1' }, { kind: 'start', pid: 2, esm: true, node: 'v20.19.0' }, { kind: 'end', pid: 1 }, { kind: 'end', pid: 2 }]).nodeVersions, ['v20.19.0', 'v24.22.1'], 'the Node version of every traced process is kept');
  assert.equal(trace([{ kind: 'start', pid: 1, esm: true }, { kind: 'something-else', pid: 1 }, { kind: 'end', pid: 1 }]).complete, false, 'a line RAME never writes makes the trace untrusted');
});

function scope(edges: unknown[], kinds: Record<string, 'file' | 'dir' | 'missing'>, extra: Partial<ScopeInput> = {}) {
  return classifyAcceptanceScope({
    listed: ['acceptance/accept.test.js'],
    staticVerifier: [],
    staticSubjects: [],
    staticProblem: null,
    trace: trace([{ kind: 'start', pid: 1, esm: true }, ...edges, { kind: 'end', pid: 1 }]),
    kind: (rel) => kinds[rel] ?? 'missing',
    filesUnder: (rel) => Object.keys(kinds).filter((file) => file.startsWith(`${rel}/`) && kinds[file] === 'file'),
    ...extra,
  });
}

test('classification: verifier support is frozen and followed; existing other files need the user; missing ones are outputs', () => {
  const result = scope(
    [
      { kind: 'module', path: 'acceptance/accept.test.js', by: null },
      { kind: 'read', path: 'acceptance/data/cases.json', by: 'acceptance/accept.test.js' },
      { kind: 'module', path: 'test/helpers/load.js', by: 'acceptance/accept.test.js' },
      { kind: 'read', path: 'test/golden/out.txt', by: 'test/helpers/load.js' },
      { kind: 'module', path: 'lib/sum.js', by: 'acceptance/accept.test.js' },
      { kind: 'module', path: 'lib/impl.js', by: 'lib/sum.js' },
      { kind: 'read', path: 'out/report.txt', by: 'acceptance/accept.test.js' },
      { kind: 'read', path: 'acceptance/fixtures', by: 'acceptance/accept.test.js' },
      { kind: 'module', path: 'node_modules/x/index.js', by: 'acceptance/accept.test.js' },
    ],
    { 'acceptance/data/cases.json': 'file', 'test/helpers/load.js': 'file', 'test/golden/out.txt': 'file', 'lib/sum.js': 'file', 'lib/impl.js': 'file', 'acceptance/fixtures': 'dir', 'acceptance/fixtures/a.json': 'file' },
  );
  assert.deepEqual(result, {
    verifier: ['acceptance/data/cases.json', 'acceptance/fixtures/a.json', 'test/golden/out.txt', 'test/helpers/load.js'],
    writable: ['lib/sum.js'],
    outputs: ['out/report.txt'],
    sealed: ['acceptance', 'acceptance/fixtures'],
    observed: ['acceptance/accept.test.js', 'acceptance/data/cases.json', 'acceptance/fixtures', 'lib/sum.js', 'out/report.txt', 'test/golden/out.txt', 'test/helpers/load.js'],
    entries: [],
    undetermined: [],
  });
});

test('AUD-01: test files a child process runs are part of the check, even with no project file on the stack (by: null)', () => {
  // `node --test acceptance/`: the runner (entry: the folder) starts one process per test file.
  const folder = scope(
    [
      { kind: 'entry', path: 'acceptance', by: null },
      { kind: 'entry', path: 'acceptance/a.test.js', by: 'acceptance' },
      { kind: 'entry', path: 'acceptance/b.test.js', by: 'acceptance' },
      { kind: 'read', path: 'acceptance/b.test.js', by: null },
      { kind: 'module', path: 'lib/sum.js', by: 'acceptance/b.test.js' },
    ],
    { acceptance: 'dir', 'acceptance/accept.test.js': 'file', 'acceptance/a.test.js': 'file', 'acceptance/b.test.js': 'file', 'lib/sum.js': 'file' },
    { listed: ['acceptance/a.test.js'] },
  );
  assert.deepEqual(folder.verifier, ['acceptance/accept.test.js', 'acceptance/b.test.js'], 'every file in the folder the command runs is frozen');
  assert.deepEqual(folder.sealed, ['acceptance'], 'and the folder is sealed: a file added later would be run too');
  assert.deepEqual(folder.entries, ['acceptance', 'acceptance/a.test.js', 'acceptance/b.test.js']);
  assert.deepEqual(folder.writable, ['lib/sum.js']);
  assert.deepEqual(folder.undetermined, []);
  // A frozen check that starts a sibling script: the child's entry names its parent.
  const child = scope(
    [
      { kind: 'entry', path: 'acceptance/accept.test.js', by: null },
      { kind: 'entry', path: 'support/run.js', by: 'acceptance/accept.test.js' },
      { kind: 'module', path: 'lib/sum.js', by: 'support/run.js' },
    ],
    { 'support/run.js': 'file', 'lib/sum.js': 'file' },
  );
  assert.deepEqual(child.verifier, ['support/run.js'], 'the spawned helper is test support: frozen');
  assert.deepEqual(child.writable, ['lib/sum.js']);
});

test('AUD-01: the command running code outside test locations, listing a non-test folder or the project root, or a folder too large, is refused', () => {
  assert.match(scope([{ kind: 'entry', path: 'scripts/verify.js', by: null }], { 'scripts/verify.js': 'file' }).undetermined.join(), /runs scripts\/verify\.js directly, but it is not an acceptance file/);
  assert.match(scope([{ kind: 'read', path: 'src', by: null }], { src: 'dir' }).undetermined.join(), /folder src, which is not a test folder/);
  assert.match(scope([{ kind: 'read', path: '.', by: null }], {}).undetermined.join(), /whole project folder/);
  assert.match(scope([{ kind: 'entry', path: 'test', by: null }], { test: 'dir' }, { filesUnder: () => null }).undetermined.join(), /too many files to freeze/);
  // A process the code under test starts is the code under test's business.
  assert.deepEqual(scope([{ kind: 'module', path: 'lib/sum.js', by: 'acceptance/accept.test.js' }, { kind: 'entry', path: 'lib/worker.js', by: 'lib/sum.js' }], { 'lib/sum.js': 'file', 'lib/worker.js': 'file' }).undetermined, []);
});

test('classification refuses what it cannot determine', () => {
  assert.match(scope([], {}, { trace: null }).undetermined.join(), /could not be observed/);
  assert.match(scope([], {}, { trace: parseTrace('{"kind":"start","pid":1,"esm":true}') }).undetermined.join(), /did not run to its end/);
  assert.match(scope([], {}, { staticProblem: 'acceptance/accept.test.js loads a module whose path RAME cannot determine (require(x)).' }).undetermined.join(), /cannot determine \(require\(x\)\)$/);
  assert.match(scope([{ kind: 'read', path: 'acceptance/expected.json', by: 'acceptance/accept.test.js' }], {}).undetermined.join(), /reads acceptance\/expected\.json, test data that does not exist yet/);
  assert.match(
    scope([], {}, { listed: ['acceptance/accept.test.mjs'], trace: parseTrace('{"kind":"start","pid":1,"esm":false}\n{"kind":"end","pid":1}') }).undetermined.join(),
    /cannot observe ES module loads/,
  );
});

test('AUD-02: at run time, anything the check uses outside the authorized scope is reported; the code under test and its files are not', () => {
  const authorized = {
    frozen: ['acceptance/accept.test.js', 'acceptance/cases/a.json'],
    writable: ['lib/sum.js'],
    outputs: ['out/report.txt'],
    sealed: ['acceptance'],
    observed: ['acceptance/accept.test.js', 'acceptance/cases', 'acceptance/cases/a.json', 'lib/sum.js', 'out/report.txt'],
    entries: ['acceptance/accept.test.js'],
  };
  const run = trace([
    { kind: 'start', pid: 1, esm: true },
    { kind: 'entry', path: 'acceptance/accept.test.js', by: null },
    { kind: 'read', path: 'acceptance/cases', by: 'acceptance/accept.test.js' },
    { kind: 'read', path: 'acceptance/cases/a.json', by: 'acceptance/accept.test.js' },
    { kind: 'read', path: 'acceptance/cases/zz.json', by: 'acceptance/accept.test.js' },
    { kind: 'read', path: 'data/expected.txt', by: 'acceptance/accept.test.js' },
    { kind: 'entry', path: 'acceptance/extra.test.js', by: null },
    { kind: 'module', path: 'lib/sum.js', by: 'acceptance/accept.test.js' },
    { kind: 'module', path: 'test/new-helper.js', by: 'lib/sum.js' },
    { kind: 'read', path: 'acceptance/sum.rame-cases.json', by: 'lib/sum.js' },
    { kind: 'end', pid: 1 },
  ]);
  assert.deepEqual(scopeViolations(run, authorized), [
    'lib/sum.js (not part of the check) read the expected values in acceptance/sum.rame-cases.json',
    'the check ran acceptance/extra.test.js, which was not part of the authorized check',
    'the check used acceptance/cases/zz.json, which was not in the sealed folder acceptance when you authorized it',
    'the check used data/expected.txt, which is outside the scope you authorized',
  ]);
  assert.deepEqual(scopeViolations(trace([{ kind: 'start', pid: 1 }, { kind: 'module', path: 'lib/sum.js', by: 'acceptance/accept.test.js' }, { kind: 'end', pid: 1 }]), authorized), []);
});

test('the real preload observes module loads and fs reads through aliases (CJS; ESM in the sabotage battery), and stubs missing code under test only when asked', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-trace-'));
  try {
    mkdirSync(path.join(root, 'acceptance'));
    writeFileSync(path.join(root, 'acceptance', 'cases.json'), '[]');
    writeFileSync(path.join(root, 'acceptance', 'a.test.js'), "const { readFileSync: r } = require('node:fs');\nconst { join: j } = require('node:path');\nconst add = require('../lib/sum.js');\nr(j(__dirname, 'cases.json'));\n");
    const run = (stub: boolean) => {
      const file = path.join(root, `trace-${stub}.jsonl`);
      const env = acceptanceTraceEnv(file, root, '', path.join(__dirname, '..', '..', 'runtime'), stub);
      try {
        execFileSync(process.execPath, ['acceptance/a.test.js'], { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore' });
      } catch {
        // exits 1 without the stub
      }
      return parseTrace(readFileSync(file, 'utf8'));
    };
    const plain = run(false);
    assert.equal(plain.complete, true);
    assert.equal(plain.edges.some((edge) => edge.path === 'acceptance/cases.json'), false, 'the check stopped at the missing module');
    const stubbed = run(true);
    assert.ok(stubbed.edges.some((edge) => edge.kind === 'missing-module' && edge.path === 'lib/sum.js' && edge.by === 'acceptance/a.test.js'));
    assert.ok(stubbed.edges.some((edge) => edge.kind === 'read' && edge.path === 'acceptance/cases.json' && edge.by === 'acceptance/a.test.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
