/** Isolation shared by allowlisted tests and other non-shell processes. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { runBoundedProcess } from '../src/agentProcess.js';
import { isolationSupport, setIsolationProbe } from '../src/shellIsolation.js';
import { isolateTest } from '../src/testIsolation.js';
import type { ProviderHost } from '../src/providerTypes.js';

const host = (level: 'total' | 'project' | 'closed') => ({ settings: { shell: { enabled: false, isolation: level } } }) as ProviderHost;

test('allowlisted tests fail closed when Project isolation is unavailable', async () => {
  setIsolationProbe({ platform: 'win32', run: async () => '' });
  try {
    const result = await isolateTest(host('project'), process.execPath, ['-e', 'process.exit(0)'], process.cwd(), undefined);
    assert.deepEqual(result.ok, false);
    assert.match(result.ok ? '' : result.error, /does not run them without the protection chosen/);
  } finally { setIsolationProbe(null); }
});

test('real Landlock: an isolated test writes in its project but cannot write beside it', async (t) => {
  if (!(await isolationSupport()).ok) { t.skip('Landlock is unavailable'); return; }
  const parent = await mkdtemp(path.join(os.tmpdir(), 'rame-test-isolation-'));
  const project = path.join(parent, 'project');
  const outside = path.join(os.homedir(), `.rame-isolation-outside-${process.pid}.txt`);
  await import('node:fs/promises').then((fs) => fs.mkdir(project));
  try {
    const script = `const f=require('node:fs');f.writeFileSync('inside.txt','ok');try{f.writeFileSync(${JSON.stringify(outside)},'bad')}catch{};`;
    const invocation = await isolateTest(host('project'), process.execPath, ['-e', script], project, undefined);
    assert.ok(invocation.ok);
    const result = await runBoundedProcess({ executable: invocation.executable, argv: invocation.argv, cwd: project, timeoutMs: 10_000, maxOutputBytes: 1024 });
    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(path.join(project, 'inside.txt'), 'utf8'), 'ok');
    await assert.rejects(readFile(outside));
  } finally { await rm(parent, { recursive: true, force: true }); await rm(outside, { force: true }); }
});
