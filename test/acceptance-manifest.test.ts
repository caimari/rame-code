/**
 * The host's own evidence for a protected acceptance check, independent of
 * the trace (AUD-01b, AUD-02): the authorized manifest kept in the grant, the
 * fingerprint of every project file, how changes since authorization are
 * judged, the agent's view without the expected values (AUD-03), and the
 * environment a check runs with.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fsp, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  diffBaseline,
  hideFromAgent,
  judgeChanges,
  MAX_BASELINE_FILES,
  parseAcceptanceManifest,
  type AcceptanceManifest,
  type ProjectChange,
} from '../src/acceptanceManifest.js';
import { runAcceptance } from '../src/acceptanceRun.js';
import { acceptanceTraceEnv, parseTrace } from '../src/acceptanceTrace.js';
import type { AgentFs } from '../src/agentHost.js';
import { childEnvironment } from '../src/agentProcess.js';
import type { MissionRecord } from '../src/missionStore.js';
import type { ProviderHost } from '../src/providerTypes.js';
import { HIDDEN_ANSWERS_MESSAGE } from '../src/toolResultSummary.js';

function diskFs(root: string): AgentFs {
  const abs = (rel: string) => path.join(root, rel);
  return {
    async listEntries(rel) {
      const entries = await fsp.readdir(abs(rel), { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDir: entry.isDirectory(), isSymlink: entry.isSymbolicLink() }));
    },
    async readText(rel) {
      return fsp.readFile(abs(rel), 'utf8');
    },
    async stat(rel) {
      try {
        const st = await fsp.lstat(abs(rel));
        return { kind: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'other', size: st.size };
      } catch {
        return { kind: 'missing' };
      }
    },
    async writeText(rel, content) {
      await fsp.mkdir(path.dirname(abs(rel)), { recursive: true });
      await fsp.writeFile(abs(rel), content);
    },
  };
}

const MANIFEST: AcceptanceManifest = {
  writable: ['lib/sum.js'],
  outputs: ['out/report.txt'],
  sealed: ['acceptance'],
  observed: ['acceptance/accept.test.js', 'lib/sum.js', 'test/fixtures/a.json'],
  entries: ['acceptance/accept.test.js'],
  hidden: ['acceptance/sum.rame-cases.json'],
  baseline: [['README.md', 'x:1']],
  node: 'v20.19.0',
  approvals: 0,
};

test('the manifest is validated when the grant is read back; anything malformed is rejected', () => {
  assert.deepEqual(parseAcceptanceManifest(JSON.parse(JSON.stringify(MANIFEST))), MANIFEST);
  assert.equal(parseAcceptanceManifest(null), undefined);
  assert.equal(parseAcceptanceManifest({ ...MANIFEST, writable: 'lib/sum.js' }), undefined);
  assert.equal(parseAcceptanceManifest({ ...MANIFEST, baseline: [['a', 1]] }), undefined);
  assert.equal(parseAcceptanceManifest({ ...MANIFEST, baseline: Array.from({ length: MAX_BASELINE_FILES + 1 }, (_, i) => [`f${i}`, 'x']) }), undefined);
  assert.equal(parseAcceptanceManifest({ ...MANIFEST, sealed: Array.from({ length: 21 }, (_, i) => `d${i}`) }), undefined);
  assert.equal(parseAcceptanceManifest({ ...MANIFEST, approvals: -1 }), undefined);
});

test('diffBaseline lists removed, added and changed files from two sets of prints', () => {
  const before = new Map([['README.md', 'a'], ['lib/sum.js', 'b']]);
  const now = new Map([['lib/sum.js', 'B'], ['lib/new.js', 'n']]);
  assert.deepEqual(diffBaseline(before, now), [
    { path: 'README.md', change: 'removed' },
    { path: 'lib/new.js', change: 'added' },
    { path: 'lib/sum.js', change: 'changed' },
  ]);
});

test('AUD-02: changes since authorization are judged by the host, whatever the trace says', () => {
  const change = (file: string, kind: ProjectChange['change'] = 'changed'): ProjectChange => ({ path: file, change: kind });
  const judged = judgeChanges(
    [
      change('lib/sum.js'),
      change('out/report.txt', 'added'),
      change('lib/helper.js', 'added'),
      change('acceptance/new.test.js', 'added'),
      change('acceptance/Run.js'),
      change('test/fixtures/a.json'),
      change('tsconfig.json', 'added'),
      change('data/expected.txt'),
      change('README.md'),
      change('lib/util.js'),
      change('own.test.js'),
      change('test/sum.test.js', 'added'),
      change('docs/notes.txt', 'added'),
    ],
    MANIFEST,
    ['acceptance/accept.test.js'],
    new Set(),
  );
  assert.deepEqual(judged.blocking, [
    { path: 'acceptance/new.test.js', reason: 'it is in the acceptance folder acceptance' },
    { path: 'acceptance/Run.js', reason: 'it is in the acceptance folder acceptance' },
    { path: 'test/fixtures/a.json', reason: 'the check itself uses it' },
    { path: 'tsconfig.json', reason: 'it decides how the check runs' },
    { path: 'data/expected.txt', reason: 'it existed when you authorized the check and is not code; RAME cannot tell whether the check reads it' },
    { path: 'README.md', reason: 'it existed when you authorized the check and is not code; RAME cannot tell whether the check reads it' },
  ]);
  assert.deepEqual(
    judged.review.map((entry) => entry.path),
    ['lib/helper.js', 'lib/util.js', 'own.test.js', 'test/sum.test.js', 'docs/notes.txt'],
    'every new file and existing code outside the authorized scope needs the user; writable code and declared outputs are allowed',
  );
  assert.deepEqual(judgeChanges([change('lib/other.js')], MANIFEST, ['acceptance/accept.test.js'], new Set(['lib/other.js'])).blocking, [{ path: 'lib/other.js', reason: 'the check itself uses it' }], 'used in this run');
  // A new code file is reviewed even if the untrusted trace says the code under test loaded it.
  assert.deepEqual(judgeChanges([change('lib/orphan.js', 'added')], MANIFEST, ['acceptance/accept.test.js'], new Set()).review, [{ path: 'lib/orphan.js', change: 'added' }]);
});

test('case-distinct POSIX paths never inherit another file\'s writable authorization', () => {
  const change = { path: 'lib/Subject.js', change: 'changed' as const };
  const manifest = {
    ...MANIFEST,
    writable: ['lib/subject.js'],
    observed: ['lib/subject.js', 'lib/Subject.js'],
  };
  assert.deepEqual(
    judgeChanges([change], manifest, [], new Set(), 'linux').blocking,
    [{ path: 'lib/Subject.js', reason: 'the check itself uses it' }],
    'Linux treats the two files as distinct; permission for one cannot authorize the other',
  );
  assert.deepEqual(
    judgeChanges([change], manifest, [], new Set(), 'win32'),
    { blocking: [], review: [] },
    'on Windows both spellings name the same file',
  );
});

test('AUD-03: the agent\'s file system cannot read the hidden cases; everything else is unchanged', async () => {
  const fs: AgentFs = {
    listEntries: async () => [],
    readText: async (rel) => `content of ${rel}`,
    stat: async () => ({ kind: 'file' }),
    writeText: async () => undefined,
  };
  const agent = hideFromAgent(fs, () => ['acceptance/sum.rame-cases.json']);
  await assert.rejects(agent.readText('acceptance/sum.rame-cases.json'), (error: Error) => error.message === HIDDEN_ANSWERS_MESSAGE);
  await assert.rejects(agent.readText('./Acceptance/Sum.rame-cases.json'), /hidden from the agent/);
  assert.equal(await agent.readText('lib/sum.js'), 'content of lib/sum.js');
  assert.equal(await hideFromAgent(fs, () => []).readText('acceptance/sum.rame-cases.json'), 'content of acceptance/sum.rame-cases.json', 'no Mission: nothing hidden');
});

test('a grant without a recorded scope (an earlier version) is not verifiable: never a pass', async () => {
  const host = { acceptanceController: null, disposed: false } as unknown as ProviderHost;
  const mission = { grant: { acceptance: { commandId: 'npm:check', packageJsonHash: 'a'.repeat(64), files: [{ path: 'acceptance/accept.test.js', hash: 'b'.repeat(64) }] } } } as unknown as MissionRecord;
  const result = await runAcceptance(host, mission, '/nonexistent', {} as AgentFs);
  assert.equal(result.passed, false);
  assert.equal(result.unverifiable, true);
  assert.match(result.summary, /^not verifiable: npm:check was authorized without a recorded scope/);
});

test('a check never inherits NODE_TEST_CONTEXT: a nested `node --test` would exit 0 without running anything', () => {
  const previous = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8';
  try {
    const env = childEnvironment({ EXTRA: '1' });
    assert.equal('NODE_TEST_CONTEXT' in env, false);
    assert.equal(env.EXTRA, '1');
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_TEST_CONTEXT;
    } else {
      process.env.NODE_TEST_CONTEXT = previous;
    }
  }
});

test('AUD-01: the real preload records each process entry point with the one that started it, and the Node version it ran on', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-lineage-'));
  try {
    mkdirSync(path.join(root, 'acceptance'));
    writeFileSync(path.join(root, 'acceptance', 'parent.js'), "require('node:child_process').execFileSync(process.execPath, [require('node:path').join(__dirname, 'child' + '.js')], { stdio: 'ignore' });\n");
    writeFileSync(path.join(root, 'acceptance', 'child.js'), "require('node:fs').readFileSync(require('node:path').join(__dirname, 'data.txt'));\n");
    writeFileSync(path.join(root, 'acceptance', 'data.txt'), 'x');
    const file = path.join(root, 'trace.jsonl');
    const env = acceptanceTraceEnv(file, root, '', path.join(__dirname, '..', '..', 'runtime'));
    execFileSync(process.execPath, ['acceptance/parent.js'], { cwd: root, env: { ...childEnvironment(), ...env }, stdio: 'ignore' });
    const trace = parseTrace(readFileSync(file, 'utf8'));
    assert.equal(trace.complete, true);
    assert.equal(trace.processes, 2);
    assert.deepEqual(trace.nodeVersions, [process.version], 'every traced process ran on the Node under test');
    assert.ok(trace.edges.some((edge) => edge.kind === 'entry' && edge.path === 'acceptance/parent.js' && edge.by === null));
    assert.ok(trace.edges.some((edge) => edge.kind === 'entry' && edge.path === 'acceptance/child.js' && edge.by === 'acceptance/parent.js'), 'the child names its parent');
    assert.ok(trace.edges.some((edge) => edge.kind === 'read' && edge.path === 'acceptance/data.txt' && edge.by === 'acceptance/child.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the report never states a full level when changes during the run could not be observed', async () => {
  const { reportLevel } = await import('../src/missionReport.js');
  assert.equal(reportLevel(false, ''), 'conventional level');
  assert.equal(reportLevel(true, 'npm:check exit=0 with every frozen file intact; protected level (frozen check exit code; host file record before, during and after the run; no host-compared cases)'), 'protected level');
  assert.equal(reportLevel(true, 'npm:check exit=0 with every frozen file intact; reinforced level: 2 host-compared case(s) passed outside the code under test; host file record at start and end only'), 'reinforced level, start and end only');
  assert.equal(reportLevel(true, 'npm:check exit=0 with every frozen file intact; protected level (frozen check exit code; host file record at start and end only; no host-compared cases)'), 'protected level, start and end only');
});

test('a load made deep in the stack is still attributed to its project file (Node 24 adds loader frames)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-deep-'));
  try {
    mkdirSync(path.join(root, 'acceptance'));
    mkdirSync(path.join(root, 'lib'));
    writeFileSync(path.join(root, 'acceptance', 'a.test.js'), "require('../lib/sum.js');\n");
    writeFileSync(path.join(root, 'lib', 'sum.js'), "const deep = (n) => (n === 0 ? require('./impl.js') : deep(n - 1));\nmodule.exports = deep(30);\n");
    writeFileSync(path.join(root, 'lib', 'impl.js'), 'module.exports = 1;\n');
    const file = path.join(root, 'trace.jsonl');
    const env = acceptanceTraceEnv(file, root, '', path.join(__dirname, '..', '..', 'runtime'));
    execFileSync(process.execPath, ['acceptance/a.test.js'], { cwd: root, env: { ...childEnvironment(), ...env }, stdio: 'ignore' });
    const reads = parseTrace(readFileSync(file, 'utf8')).edges.filter((edge) => edge.path === 'lib/impl.js');
    assert.ok(reads.length > 0);
    assert.deepEqual([...new Set(reads.map((edge) => edge.by))], ['lib/sum.js'], 'never left without an author (which would count as the check)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest whose prints were made by an earlier method (size for large files) is not verifiable: never compared', async () => {
  const host = { acceptanceController: null, disposed: false, testCommandContext: async () => ({ allowlist: [{ id: 'npm:check' }] }) } as unknown as ProviderHost;
  const files = [{ path: 'acceptance/accept.test.js', hash: 'b'.repeat(64) }];
  const fs: AgentFs = { listEntries: async () => [], readText: async () => '', stat: async () => ({ kind: 'missing' }), writeText: async () => undefined };
  const mission = { grant: { acceptance: { commandId: 'npm:check', packageJsonHash: 'a'.repeat(64), files, scope: { ...MANIFEST } } } } as unknown as MissionRecord;
  // Frozen hashes are checked first; make them match an empty read.
  const empty = (await import('../src/agentPatch.js')).hashContent('');
  files[0]!.hash = empty;
  (mission.grant as unknown as { acceptance: { packageJsonHash: string } }).acceptance.packageJsonHash = empty;
  const result = await runAcceptance(host, mission, '/nonexistent', { ...fs, stat: async () => ({ kind: 'file' }) });
  assert.equal(result.unverifiable, true, result.summary);
  assert.match(result.summary, /authorized with an older file fingerprint/);
});

test('a read made through a library many frames deep is still attributed to the project file below it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-deeplib-'));
  try {
    mkdirSync(path.join(root, 'acceptance'));
    mkdirSync(path.join(root, 'lib'));
    mkdirSync(path.join(root, 'node_modules', 'deepcall'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', 'deepcall', 'index.js'), "const call = (n, file) => (n === 0 ? require('node:fs').readFileSync(file) : call(n - 1, file));\nmodule.exports = call;\n");
    writeFileSync(path.join(root, 'acceptance', 'a.test.js'), "require('../lib/sum.js');\n");
    writeFileSync(path.join(root, 'lib', 'sum.js'), "require('deepcall')(30, require('node:path').join(__dirname, 'table.txt'));\n");
    writeFileSync(path.join(root, 'lib', 'table.txt'), '1');
    const file = path.join(root, 'trace.jsonl');
    const env = acceptanceTraceEnv(file, root, '', path.join(__dirname, '..', '..', 'runtime'));
    execFileSync(process.execPath, ['acceptance/a.test.js'], { cwd: root, env: { ...childEnvironment(), ...env }, stdio: 'ignore' });
    const reads = parseTrace(readFileSync(file, 'utf8')).edges.filter((edge) => edge.path === 'lib/table.txt');
    assert.deepEqual([...new Set(reads.map((edge) => edge.by))], ['lib/sum.js'], 'with the default stack limit the author would be lost and the read counted as the check');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
