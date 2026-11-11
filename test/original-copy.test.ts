/**
 * I-16: the agent's read-only copy of the original (originalCopy.ts,
 * originalTool.ts). It must never lead to what the verifier keeps protected:
 * the host's own frozen copy, the reference description (generators and
 * edge values), the records, the seeds, the reserved inputs. Real files and
 * child processes; no model.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { validateToolArgs } from '../src/agentTools.js';
import { isAutoAllowed } from '../src/agentProfiles.js';
import { AUTONOMOUS_TOOLS } from '../src/missionStore.js';
import { readVisibleOriginal } from '../src/originalCopy.js';
import { executeReadOriginal, originalToolDefinitions } from '../src/originalTool.js';
import { freezeReferencesFor, type FrozenReference, parseFrozenReferences, runDifferential, verifyReferenceCopy } from '../src/referenceCheck.js';

const M = 1000003;
const K = 7919;
const SLOW = `// helper kept with the original\nconst { K } = require('./constants.js');\nfunction checksum(n) {\n  let s = 0;\n  for (let i = 0; i < n; i++) s = (s + i * K) % ${M};\n  return s;\n}\nmodule.exports = { checksum };\n`;
const CONSTANTS = `module.exports = { K: ${K} };\n`;
const EXACT = `function checksum(n) {\n  const a = n % 2 === 0 ? (n / 2) % ${M} : n % ${M};\n  const b = n % 2 === 0 ? (n - 1) % ${M} : ((n - 1) / 2) % ${M};\n  return (${K} * ((a * b) % ${M})) % ${M};\n}\nmodule.exports = { checksum };\n`;
const SPEC_PATH = 'acceptance/report.rame-reference.json';
const SPEC = JSON.stringify({ rameReference: 1, module: 'lib/report.js', call: 'checksum', files: ['lib/report.js', 'lib/constants.js'], args: [{ int: { min: 0, max: 4000000 } }], edges: [[3], [1234567]], random: 12, reserved: 9 });
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function project(): { root: string; store: string; jobsRoot: string; dispose: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-orig-project-'));
  const store = mkdtempSync(path.join(os.tmpdir(), 'rame-orig-store-'));
  mkdirSync(path.join(root, 'lib'));
  mkdirSync(path.join(root, 'acceptance'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'report', private: true }));
  writeFileSync(path.join(root, 'lib', 'report.js'), SLOW);
  writeFileSync(path.join(root, 'lib', 'constants.js'), CONSTANTS);
  writeFileSync(path.join(root, SPEC_PATH), SPEC);
  return { root, store, jobsRoot: path.join(store, 'jobs'), dispose: () => [root, store].forEach((dir) => rmSync(dir, { recursive: true, force: true })) };
}

async function freeze(p: { root: string; jobsRoot: string }, spec = SPEC): Promise<FrozenReference> {
  const frozen = await freezeReferencesFor(p.root, [{ path: SPEC_PATH }, { path: 'acceptance/check.js' }], async () => spec, p.jobsRoot, 'mis_i16');
  assert.ok(frozen.ok, frozen.ok ? '' : frozen.error);
  assert.equal(frozen.references.length, 1);
  return frozen.references[0]!;
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)).map((child) => `${entry.name}/${child}`) : [entry.name]));
const refusal = async (promise: Promise<string>): Promise<string> => {
  try {
    return `READ: ${await promise}`;
  } catch (error) {
    return (error as Error).message;
  }
};

test('two separate copies: the host reference and the agent copy share no folder; the agent copy holds only the original sources, read-only', async () => {
  const p = project();
  try {
    const reference = await freeze(p);
    const visible = reference.visible!;
    assert.ok(visible, 'the agent copy is made with the reference');
    const host = path.resolve(reference.dir);
    const shown = path.resolve(visible.dir);
    assert.ok(!shown.startsWith(host + path.sep) && !host.startsWith(shown + path.sep) && shown !== host, 'neither folder is inside the other');
    assert.equal(path.basename(path.dirname(host)), 'references');
    assert.equal(path.basename(path.dirname(shown)), 'originals');
    assert.deepEqual(walk(shown).sort(), ['lib/constants.js', 'lib/report.js'], 'no reference description, no records, no RAME manifest');
    assert.deepEqual(visible.files.map((file) => file.path).sort(), ['lib/constants.js', 'lib/report.js']);
    assert.equal(readFileSync(path.join(shown, 'lib', 'report.js'), 'utf8'), SLOW);
    if (process.platform !== 'win32') {
      assert.equal(statSync(path.join(shown, 'lib', 'report.js')).mode & 0o222, 0, 'the agent copy is read-only on disk');
      if (!isRoot) {
        assert.throws(() => writeFileSync(path.join(shown, 'lib', 'report.js'), 'changed'), /EACCES|EPERM/);
      }
      assert.equal(statSync(path.dirname(shown)).mode & 0o077, 0, 'the originals folder is this user\'s only');
    }
    // The grant keeps it and reads it back; a damaged entry is not accepted.
    const stored = parseFrozenReferences(JSON.parse(JSON.stringify([reference])));
    assert.deepEqual(stored, [reference]);
    assert.equal(parseFrozenReferences([{ ...reference, visible: { dir: 'relative', files: visible.files } }]), undefined);
    assert.equal(parseFrozenReferences([{ ...reference, visible: { dir: visible.dir, files: [{ path: '../x', hash: visible.files[0]!.hash }] } }]), undefined);
  } finally {
    p.dispose();
  }
});

test('read_original lists and reads only the original files; never the reference, the host copy, the records or anything by path tricks', async () => {
  const p = project();
  try {
    const reference = await freeze(p);
    const copies = [reference.visible!];
    // A host pass first, so records with seeds exist next to the host copy.
    const passed = await runDifferential(p.root, reference, SPEC, { trace: false });
    assert.equal(passed.kind, 'passed', passed.summary);
    const record = JSON.parse(readFileSync(passed.record!, 'utf8')) as { seeds: { shown: string; reserved: string } };
    const listing = await readVisibleOriginal(copies, '');
    assert.match(listing, /^READ-ONLY COPY OF THE ORIGINAL/);
    assert.match(listing, /- lib\/report\.js\n- lib\/constants\.js/);
    const read = await readVisibleOriginal(copies, 'lib/report.js');
    assert.ok(read.endsWith(SLOW));
    assert.match(read, /^original: lib\/report\.js \(read-only, sha256 [0-9a-f]{12}…/);
    assert.ok((await readVisibleOriginal(copies, './original/lib/constants.js')).endsWith(CONSTANTS));
    const attempts = [
      SPEC_PATH,
      'report.rame-reference.json',
      'package.json',
      '../references',
      `../references/${path.basename(reference.dir)}/files/lib/report.js`,
      `../../references/${path.basename(reference.dir)}/passes/${path.basename(passed.record!)}`,
      path.join(reference.dir, 'files', 'lib', 'report.js'),
      passed.record!,
      'passes',
      'files/lib/report.js',
      'lib/../acceptance/report.rame-reference.json',
      'lib',
      'lib/report.js/..',
    ];
    for (const attempt of attempts) {
      const outcome = await refusal(readVisibleOriginal(copies, attempt));
      assert.match(outcome, /^Only the original files can be read with read_original: lib\/report\.js, lib\/constants\.js\.$/, attempt);
    }
    // Nothing it ever returns carries the seeds, the reserved inputs' description or a location.
    const everything = [listing, read, ...(await Promise.all(attempts.map((attempt) => refusal(readVisibleOriginal(copies, attempt)))))].join('\n');
    for (const secret of [record.seeds.shown, record.seeds.reserved, '"reserved"', 'rameReference', reference.dir, reference.visible!.dir, p.store]) {
      assert.equal(everything.includes(secret), false, `never shown: ${secret}`);
    }
  } finally {
    p.dispose();
  }
});

test('a changed or replaced agent copy is not shown, and it changes nothing for the host check, which never reads it', { skip: process.platform === 'win32' ? 'POSIX links and modes' : false }, async () => {
  const p = project();
  try {
    const reference = await freeze(p);
    const visible = reference.visible!;
    const file = path.join(visible.dir, 'lib', 'report.js');
    // Changed content (the read-only mode is lifted, as another process with the user's rights could).
    chmodSync(file, 0o644);
    writeFileSync(file, 'function checksum() { return 0; }\nmodule.exports = { checksum };\n');
    assert.match(await refusal(readVisibleOriginal([visible], 'lib/report.js')), /^RAME's read-only copy of lib\/report\.js changed after the Mission was authorized, so it is not shown\. The host's own check does not use this copy\.$/);
    // Replaced by a link to the host's record (to its seeds): never followed.
    const passed = await runDifferential(p.root, reference, SPEC, { trace: false });
    assert.equal(passed.kind, 'passed', 'the host check is unaffected by the agent copy');
    assert.equal(await verifyReferenceCopy(reference), null);
    unlinkSync(file);
    symlinkSync(passed.record!, file);
    const linked = await refusal(readVisibleOriginal([visible], 'lib/report.js'));
    assert.match(linked, /^RAME's read-only copy of lib\/report\.js is missing or is no longer a plain file, so it is not shown/);
    assert.equal(linked.includes('seeds'), false);
    // A link in a folder of the copy is refused too.
    rmSync(path.join(visible.dir, 'lib'), { recursive: true, force: true });
    symlinkSync(path.join(reference.dir, 'files', 'lib'), path.join(visible.dir, 'lib'));
    assert.match(await refusal(readVisibleOriginal([visible], 'lib/constants.js')), /is missing or is no longer a plain file/);
    // Removed: refused, and the host check still passes on its own copy.
    rmSync(visible.dir, { recursive: true, force: true });
    assert.match(await refusal(readVisibleOriginal([visible], 'lib/report.js')), /is missing or is no longer a plain file/);
    assert.equal((await runDifferential(p.root, reference, SPEC, { trace: false })).kind, 'passed');
  } finally {
    p.dispose();
  }
});

test('code that calls RAME\'s read-only copy instead of standing on its own is not verifiable; the exact rewrite passes', async () => {
  const p = project();
  try {
    const reference = await freeze(p);
    const relay = `const path = require('node:path');\nconst os = require('node:os');\n// Delegates to RAME's copy: ${path.basename(reference.visible!.dir)}\nmodule.exports = require(${JSON.stringify(path.join(reference.visible!.dir, 'lib', 'report.js'))});\n`;
    writeFileSync(path.join(p.root, 'lib', 'report.js'), relay);
    const relayed = await runDifferential(p.root, reference, SPEC, { trace: false });
    assert.equal(relayed.kind, 'unverifiable');
    assert.match(relayed.summary, /the code under test \(lib\/report\.js\) refers to RAME's read-only copy of the original instead of standing on its own/);
    writeFileSync(path.join(p.root, 'lib', 'report.js'), EXACT);
    const exact = await runDifferential(p.root, reference, SPEC, { trace: false });
    assert.equal(exact.kind, 'passed', exact.summary);
    // The record's name is not derived from the seeds: the agent sees the name, never the seeds.
    const record = JSON.parse(readFileSync(exact.record!, 'utf8')) as { seeds: { shown: string; reserved: string } };
    assert.equal(path.basename(exact.record!).includes(record.seeds.shown.slice(0, 8)), false);
    assert.equal(exact.summary.includes(record.seeds.shown) || exact.summary.includes(record.seeds.reserved), false);
  } finally {
    p.dispose();
  }
});

test('a reference cannot hand the agent a host description as an "original" file', async () => {
  const p = project();
  try {
    const asReference = JSON.stringify({ ...JSON.parse(SPEC), files: ['lib/report.js', SPEC_PATH] });
    const refused = await freezeReferencesFor(p.root, [{ path: SPEC_PATH }], async () => asReference, p.jobsRoot, 'mis_i16');
    assert.ok(!refused.ok);
    assert.match(refused.error, /"files" must include the module, and not package\.json or a reference file\./);
    // The expected values of host-compared cases are a host description too.
    writeFileSync(path.join(p.root, 'acceptance', 'report.rame-cases.json'), JSON.stringify({ rameCases: 1, module: 'lib/report.js', cases: [{ call: 'checksum', args: [3], expect: 23757 }] }));
    const asCases = JSON.stringify({ ...JSON.parse(SPEC), files: ['lib/report.js', 'acceptance/report.rame-cases.json'] });
    const refusedCases = await freezeReferencesFor(p.root, [{ path: SPEC_PATH }], async () => asCases, p.jobsRoot, 'mis_i16');
    assert.ok(!refusedCases.ok);
    assert.match(refusedCases.error, /cannot list acceptance\/report\.rame-cases\.json as an original file: host descriptions are never copied for the agent\./);
    assert.deepEqual(readdirSync(path.join(p.store, 'originals')), [], 'nothing is left behind');
    assert.deepEqual(readdirSync(path.join(p.store, 'references')), []);
  } finally {
    p.dispose();
  }
});

test('read_original: strict arguments, offered only in a Mission with a copy, read-only in every profile, and it reads only that Mission\'s copy', async () => {
  const p = project();
  try {
    assert.deepEqual(validateToolArgs('read_original', {}), {});
    assert.deepEqual(validateToolArgs('read_original', { path: 'lib/report.js' }), { path: 'lib/report.js' });
    assert.throws(() => validateToolArgs('read_original', { path: 'lib/report.js', write: true }), /Invalid read_original arguments/);
    assert.throws(() => validateToolArgs('read_original', { path: 7 }), /Invalid read_original arguments/);
    assert.equal(isAutoAllowed('safe-auto', 'read_original'), true);
    assert.equal(isAutoAllowed('ask', 'read_original'), false, 'Ask still asks');
    assert.ok(AUTONOMOUS_TOOLS.includes('read_original'));
    const reference = await freeze(p);
    const missions = new Map<string, unknown>([['mis_i16', { grant: { acceptance: { references: [reference] } } }]]);
    const fakeHost = (missionId: string | null) => ({ missionAuto: missionId === null ? null : { missionId }, missions: { get: (id: string) => missions.get(id) ?? null } }) as never;
    assert.deepEqual(originalToolDefinitions(fakeHost(null)), [], 'not outside a Mission');
    assert.deepEqual(originalToolDefinitions(fakeHost('mis_other')), [], 'not in a Mission without a copy');
    const offered = originalToolDefinitions(fakeHost('mis_i16'));
    assert.deepEqual(offered.map((tool) => tool.function.name), ['read_original']);
    assert.ok((await executeReadOriginal(fakeHost('mis_i16'), { path: 'lib/report.js' })).endsWith(SLOW));
    await assert.rejects(executeReadOriginal(fakeHost(null), { path: 'lib/report.js' }), /This Mission has no read-only copy of the original\./);
  } finally {
    p.dispose();
  }
});
