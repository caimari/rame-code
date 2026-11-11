/**
 * Isolation of terminal commands (P5h, decision of 08-11-2026): three levels
 * independent of the autonomy mode. Project (default) writes only in the
 * project, temporary and package-cache folders; Closed also blocks TCP;
 * Total does not isolate. Where the chosen level cannot be applied, the
 * command is not run.
 *
 * The real runs apply Landlock on the Linux development machine with harmless
 * commands only (writing a small file inside and outside, a TCP connection
 * to a server of the test itself); they are skipped where Landlock is not
 * available. Nothing leaves the computer.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  isolatedInvocation,
  isolationRefusal,
  isolationSupport,
  ISOLATION_LAUNCHER,
  notIsolatedText,
  setIsolationProbe,
  writableFolders,
} from '../src/shellIsolation.js';
import { onAutonomyMessage } from '../src/autonomyEntry.js';
import { assistantText, HostHarness, toolCallReply } from './helpers/hostHarness.js';

type Request = { messages?: Array<{ content: string | null; tool_call_id?: string }> };
const runCommand = (id: string, command: string) => ({ kind: 'json' as const, body: toolCallReply([{ id, name: 'run_command', args: { command } }]) });
const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });
const result = (h: HostHarness, id: string) => String((h.model.requests as Request[]).flatMap((r) => r.messages ?? []).find((m) => m.tool_call_id === id)?.content ?? '');

function run(executable: string, argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(executable, argv, { cwd, timeout: 15000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : -1;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function listening(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const connectScript = (port: number) => `require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('connected');process.exit(0)}).on('error',(e)=>{console.log(e.code);process.exit(3)})`;

test('the three levels: Total leaves the command as it is; Project and Closed run it through the Landlock launcher, Closed without network', () => {
  assert.deepEqual(isolatedInvocation('total', '/bin/bash', ['-c', 'ls'], '/p'), { executable: '/bin/bash', argv: ['-c', 'ls'] });
  const project = isolatedInvocation('project', '/bin/bash', ['-c', 'ls'], '/p', '/home/u', '/tmp');
  assert.equal(project.executable, 'python3');
  assert.deepEqual(project.argv.slice(0, 2), ['-I', ISOLATION_LAUNCHER]);
  assert.equal(project.argv.includes('--no-net'), false);
  assert.deepEqual(project.argv.slice(project.argv.indexOf('--')), ['--', '/bin/bash', '-c', 'ls']);
  // The project first (it must exist), then the temporary folder, /dev/shm and the package caches.
  assert.deepEqual(writableFolders('/p', '/home/u', '/tmp').slice(0, 5), ['/p', '/tmp', '/dev/shm', '/home/u/.npm', '/home/u/.cache']);
  const closed = isolatedInvocation('closed', '/bin/bash', ['-c', 'ls'], '/p', '/home/u', '/tmp');
  assert.equal(closed.argv[2], '--no-net');
});

test('where the chosen level cannot be applied it is refused, never run unprotected: Windows, macOS, no python3, no Landlock, Closed on a kernel that cannot block the network', async () => {
  const probe = (platform: NodeJS.Platform, out: string | Error) => ({ platform, run: async () => (out instanceof Error ? Promise.reject(out) : out) });
  assert.match(String(isolationRefusal('project', await isolationSupport(probe('win32', '')))), /only on Linux for now \(this is Windows\)/);
  assert.match(String(isolationRefusal('project', await isolationSupport(probe('darwin', '')))), /this is macOS/);
  assert.match(String(isolationRefusal('project', await isolationSupport(probe('linux', new Error('ENOENT'))))), /python3[^]*could not be run/);
  assert.match(String(isolationRefusal('closed', await isolationSupport(probe('linux', 'landlock-abi=0\n')))), /no Landlock/);
  assert.match(String(isolationRefusal('closed', await isolationSupport(probe('linux', 'landlock-abi=3\n')))), /cannot block the network; it needs Linux 6\.7 or newer/);
  assert.equal(isolationRefusal('project', await isolationSupport(probe('linux', 'landlock-abi=3\n'))), null, 'Project needs only file rules');
  assert.equal(isolationRefusal('total', { ok: false, reason: 'anything' }), null, 'Total never needs it');
  assert.match(notIsolatedText('project', 'this is Windows'), /^Not run: [^]*"Project" isolation, and this is Windows\. RAME does not run a command without the protection chosen\. The user can choose "Total"/);
});

test('the shell tool, with isolation unavailable: a Project command is not run (and says how to choose Total); with Total it runs', async () => {
  const h = new HostHarness();
  setIsolationProbe({ platform: 'win32', run: async () => '' });
  try {
    await h.start({ agentProfile: 'workspace-full', shell: { enabled: true, isolation: 'project' } });
    h.provider.confirmAutonomy = async () => true;
    // Full Access with commands: no card, so only the isolation decides.
    await onAutonomyMessage(h.provider as never, { type: 'autonomyFull', tools: { files: true, tests: false, commands: true, installs: false, jobs: false, web: false, meta: false }, validityHours: 8 });
    h.model.enqueue(runCommand('c', 'echo ran > ran.txt'), say('Done.'));
    await h.provider.sendMessage('Write ran.txt.', 'agent', 'local');
    assert.match(result(h, 'c'), /^Not run: terminal commands are set to "Project" isolation, and RAME isolates commands only on Linux for now \(this is Windows\)\./);
    await assert.rejects(h.readFile('ran.txt'), 'nothing ran');
    h.provider.settings = { ...h.provider.settings, shell: { enabled: true, isolation: 'total' } };
    h.model.enqueue(runCommand('t', 'echo ran > ran.txt'), say('Done.'));
    await h.provider.sendMessage('Write ran.txt again.', 'agent', 'local');
    assert.match(result(h, 't'), /in the project folder, no isolation: the command runs with your permissions \(exit=0\)/);
    assert.equal(await h.readFile('ran.txt'), 'ran\n');
  } finally {
    setIsolationProbe(null);
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('real Landlock on this Linux: Project writes inside the project only, sudo cannot gain rights, TCP works; Closed blocks TCP; Total does not isolate', async (t) => {
  setIsolationProbe(null);
  const support = await isolationSupport();
  if (!support.ok || support.abi < 4) {
    t.skip(`Landlock with network rules is not available here (${support.ok ? `ABI ${support.abi}` : support.reason})`);
    return;
  }
  const project = await fsp.mkdtemp(path.join(os.tmpdir(), 'rame-iso-project-'));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'rame-iso-outside-'));
  const server = await listening();
  // The temporary folder of these runs is the project itself, so a sibling temporary folder is "outside".
  const isolated = (level: 'project' | 'closed' | 'total', command: string) => {
    const call = isolatedInvocation(level, '/bin/sh', ['-c', command], project, path.join(project, 'no-home'), project);
    return run(call.executable, call.argv, project);
  };
  try {
    const inside = await isolated('project', 'echo in > inside.txt && cat inside.txt');
    assert.equal(inside.code, 0, inside.stderr);
    assert.equal(inside.stdout, 'in\n');
    const out = await isolated('project', `echo x > ${path.join(outside, 'outside.txt')}`);
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /Permission denied|Permiso denegado/);
    await assert.rejects(fsp.stat(path.join(outside, 'outside.txt')), 'nothing was written outside');
    const privs = await isolated('project', 'grep NoNewPrivs /proc/self/status');
    assert.match(privs.stdout, /NoNewPrivs:\s+1/, 'sudo and setuid programs cannot gain rights');
    const tcpProject = await isolated('project', `${process.execPath} -e "${connectScript(server.port)}"`);
    assert.equal(tcpProject.stdout.trim(), 'connected', 'Project keeps the network');
    const tcpClosed = await isolated('closed', `${process.execPath} -e "${connectScript(server.port)}"`);
    assert.equal(tcpClosed.stdout.trim(), 'EACCES', 'Closed blocks TCP');
    const total = await isolated('total', `echo x > ${path.join(outside, 'total.txt')}`);
    assert.equal(total.code, 0, 'Total runs with the user\'s permissions');
    // A launcher that cannot apply what was asked runs nothing.
    const bad = await run('python3', ['-I', ISOLATION_LAUNCHER, '--write', project, '--bogus', '--', '/bin/sh', '-c', `touch ${path.join(project, 'ran.txt')}`], project);
    assert.equal(bad.code, 125);
    assert.match(bad.stderr, /^rame-isolate: unknown option --bogus/);
    await assert.rejects(fsp.stat(path.join(project, 'ran.txt')));
  } finally {
    await server.close();
    await fsp.rm(project, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});
