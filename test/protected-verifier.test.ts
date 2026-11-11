/** Adversarial checks for the mandatory verifier read boundary. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { runHostCases } from '../src/hostCases.js';
import { protectedProjectAccess } from '../src/protectedVerifier.js';
import { isolationSupport, protectedVerificationRefusal, protectedVerifierInvocation, UNPROTECTED_VERIFICATION_WARNING, verificationLabel, verificationMode } from '../src/shellIsolation.js';

const run = (executable: string, argv: string[], cwd: string, access: ReturnType<typeof protectedProjectAccess> & { ok: true }): string => {
  const invoked = protectedVerifierInvocation(executable, argv, access.access);
  return execFileSync(invoked.executable, invoked.argv, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
};

test('protected verifier can read only its allowlist; Node, Python and shell inherit the boundary', async (t) => {
  const support = await isolationSupport();
  const refusal = protectedVerificationRefusal(support);
  if (refusal !== null) return t.skip(refusal);
  const parent = mkdtempSync(path.join(os.tmpdir(), 'rame-protected-'));
  const root = path.join(parent, 'project');
  mkdirSync(root);
  writeFileSync(path.join(root, 'public.txt'), 'PUBLIC');
  writeFileSync(path.join(root, 'hidden.txt'), 'HIDDEN');
  writeFileSync(path.join(root, '.env'), 'TOKEN=secret');
  writeFileSync(path.join(parent, 'sibling-secret.txt'), 'SIBLING');
  try {
    const access = protectedProjectAccess(root, ['public.txt', '.env'], [], null);
    assert.ok(access.ok, access.ok ? '' : access.error);
    assert.equal(run(process.execPath, ['-e', "process.stdout.write(require('fs').readFileSync('public.txt','utf8'))"], root, access), 'PUBLIC');
    for (const [exe, argv] of [
      [process.execPath, ['-e', "require('fs').readFileSync('../sibling-secret.txt')"]],
      ['/usr/bin/python3', ['-c', "open('../sibling-secret.txt').read()"]],
      ['/bin/sh', ['-c', 'cat ../sibling-secret.txt']],
      [process.execPath, ['-e', "require('fs').readFileSync('hidden.txt')"]],
      [process.execPath, ['-e', "require('fs').readFileSync('.env')"]],
    ] as Array<[string, string[]]>) {
      assert.throws(() => run(exe, argv, root, access), /EACCES|Permission denied|Operation not permitted/);
    }
    for (const kind of ['udp4', 'unix'] as const) {
      const source = kind === 'udp4'
        ? "require('dgram').createSocket('udp4').bind(0)"
        : "require('net').createServer().listen('/tmp/rame-forbidden.sock')";
      assert.throws(() => run(process.execPath, ['-e', source], root, access), /EPERM|Operation not permitted/, `${kind} sockets are denied, not merely TCP`);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('protected verifier refuses a project symlink that smuggles an outside file', () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'rame-protected-link-'));
  const root = path.join(parent, 'project');
  mkdirSync(root);
  writeFileSync(path.join(parent, 'secret.txt'), 'secret');
  symlinkSync(path.join(parent, 'secret.txt'), path.join(root, 'link.txt'));
  try {
    const access = protectedProjectAccess(root, ['link.txt'], [], null);
    assert.equal(access.ok, false);
    assert.match(access.ok ? '' : access.error, /points outside the project/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('recognized secret paths cannot be reintroduced through a writable grant', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-protected-secret-'));
  writeFileSync(path.join(root, '.env'), 'TOKEN=secret');
  try {
    const access = protectedProjectAccess(root, [], ['.env'], null);
    assert.equal(access.ok, false);
    assert.match(access.ok ? '' : access.error, /recognized secret path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('official host cases cannot inspect their cases file or a sibling project', async (t) => {
  const support = await isolationSupport();
  const refusal = protectedVerificationRefusal(support);
  if (refusal !== null) return t.skip(refusal);
  const parent = mkdtempSync(path.join(os.tmpdir(), 'rame-cases-boundary-'));
  const root = path.join(parent, 'project');
  mkdirSync(root);
  writeFileSync(path.join(root, 'candidate.js'), `const fs=require('node:fs'); exports.probe=(name)=>{try{return fs.readFileSync(name,'utf8')}catch(e){return e.code}}; exports.tamper=(name)=>{try{fs.writeFileSync(name,'forged');return 'WROTE'}catch(e){return e.code}};`);
  writeFileSync(path.join(root, 'private.rame-cases.json'), '{"expect":"secret"}');
  writeFileSync(path.join(parent, 'sibling.txt'), 'sibling secret');
  try {
    const access = protectedProjectAccess(root, ['candidate.js'], [], null);
    assert.ok(access.ok, access.ok ? '' : access.error);
    const outcome = await runHostCases(root, {
      module: 'candidate.js',
      cases: [
        { call: 'probe', args: ['private.rame-cases.json'], expect: 'EACCES' },
        { call: 'probe', args: ['../sibling.txt'], expect: 'EACCES' },
        { call: 'tamper', args: ['../host-evidence.json'], expect: 'EACCES' },
      ],
    }, { protectedAccess: access.access });
    assert.deepEqual(outcome, { status: 'passed', total: 3 });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('an evaluated child cannot discover or replace host evidence through env, proc or tmp', async (t) => {
  const support = await isolationSupport();
  const refusal = protectedVerificationRefusal(support);
  if (refusal !== null) return t.skip(refusal);
  const parent = mkdtempSync(path.join(os.tmpdir(), 'rame-channel-boundary-'));
  const root = path.join(parent, 'project');
  const evidence = path.join(parent, 'official-results.json');
  mkdirSync(root);
  writeFileSync(path.join(root, 'candidate.js'), `
const fs = require('node:fs');
exports.probe = () => {
  const found = [];
  const leaked = Object.entries(process.env).some(([key, value]) => /RESULTS_FILE|TOKEN|API_KEY|SECRET/i.test(key + '=' + value));
  for (const [name, read] of [['/proc/self/environ', () => fs.readFileSync('/proc/self/environ')], ['/proc/self/fd', () => fs.readdirSync('/proc/self/fd')], ['/tmp', () => fs.readdirSync('/tmp')]]) {
    try { read(); found.push('READ'); } catch (error) { found.push(error.code); }
  }
  try { fs.writeFileSync(${JSON.stringify(evidence)}, '{"wall_ms":1}'); found.push('WROTE'); }
  catch (error) { found.push(error.code); }
  return !leaked && found.every((value) => value === 'EACCES');
};
`);
  writeFileSync(evidence, '{"wall_ms":900}');
  try {
    const access = protectedProjectAccess(root, ['candidate.js'], [], null);
    assert.ok(access.ok, access.ok ? '' : access.error);
    const outcome = await runHostCases(root, {
      module: 'candidate.js',
      cases: [{ call: 'probe', args: [], expect: true }],
    }, { protectedAccess: access.access });
    assert.deepEqual(outcome, { status: 'passed', total: 1 });
    assert.equal(execFileSync('/bin/cat', [evidence], { encoding: 'utf8' }), '{"wall_ms":900}');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('unsupported systems, old Landlock and missing libseccomp select an explicit unprotected mode without a prompt', () => {
  assert.match(protectedVerificationRefusal({ ok: false, reason: 'unsupported' }) ?? '', /unsupported/);
  assert.match(protectedVerificationRefusal({ ok: true, abi: 3 }) ?? '', /needs version 4 or newer/);
  assert.match(protectedVerificationRefusal({ ok: true, abi: 4, seccomp: false }) ?? '', /libseccomp/);
  assert.deepEqual(verificationMode({ ok: false, reason: 'simulated without Landlock' }), { kind: 'unprotected', reason: 'simulated without Landlock' });
  assert.equal(verificationLabel(verificationMode({ ok: false, reason: 'simulated without Landlock' })), 'verification: unprotected — simulated without Landlock');
  assert.match(UNPROTECTED_VERIFICATION_WARNING, /^This environment has no protected isolation:/);
  assert.equal(protectedVerificationRefusal({ ok: true, abi: 4, seccomp: true }), null);
  assert.deepEqual(verificationMode({ ok: true, abi: 4, seccomp: true }), { kind: 'protected', reason: '' });
});

test('without Landlock, host cases run immediately without isolation under Full Access and still reject a wrong case', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-unprotected-cases-'));
  writeFileSync(path.join(root, 'candidate.js'), `const fs=require('node:fs'); exports.read=()=>fs.readFileSync('hidden.txt','utf8'); exports.wrong=()=>41;`);
  writeFileSync(path.join(root, 'hidden.txt'), 'HIDDEN');
  try {
    const access = protectedProjectAccess(root, ['candidate.js'], [], null);
    assert.ok(access.ok, access.ok ? '' : access.error);
    const mode = verificationMode({ ok: false, reason: 'simulated Linux without Landlock' });
    const read = await runHostCases(root, { module: 'candidate.js', cases: [{ call: 'read', args: [], expect: 'HIDDEN' }] }, { protectedAccess: access.access, verificationMode: mode, isolation: 'total' });
    assert.deepEqual(read, { status: 'passed', total: 1 }, 'the check ran without asking and could read the hidden file');
    const wrong = await runHostCases(root, { module: 'candidate.js', cases: [{ call: 'wrong', args: [], expect: 42 }] }, { protectedAccess: access.access, verificationMode: mode, isolation: 'total' });
    assert.equal(wrong.status, 'failed', 'unprotected never turns an incorrect case into a pass');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
