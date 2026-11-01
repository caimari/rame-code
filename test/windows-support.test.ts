/**
 * Windows support: the pure rules are exercised with `platform: 'win32'`
 * so they run on any CI host. POSIX behaviour must stay unchanged.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NPM_NOT_FOUND_MESSAGE,
  resolveTestInvocation,
  type TestInvocationContext,
} from '../src/agentCommands.js';
import { policyGateForCall } from '../src/agentHost.js';
import {
  checkAgentRelPath,
  isWithinRoot,
  normalizeAgentRelPath,
  resolveSingleWorkspaceRoot,
} from '../src/agentPolicy.js';
import { windowsTreeKillCommand } from '../src/agentProcess.js';
import { validateLocalSettings } from '../src/localRuntime.js';
import type { ValidatedToolCall } from '../src/agentTools.js';

const NPM_ARGV = ['run', '--ignore-scripts', 'test'];

test('win32: names that Win32 rewrites into a protected or device path are rejected', () => {
  for (const alias of [
    '.git./config', // trailing dot opens .git
    '.git /config', // trailing space opens .git
    'GIT~1/config', // 8.3 short name of .git
    '.env::$DATA', // default data stream of .env
    'notes.txt:hidden', // alternate data stream
    'C:secret.txt', // drive-relative path
    'nul',
    'CON.txt',
    'src/com1.log',
    'a<b.ts',
    'what?.md',
    '.. /outside', // `.. ` becomes `..`
    '.../outside',
  ]) {
    const result = normalizeAgentRelPath(alias, 'win32');
    assert.equal(result.ok, false, `${alias} must be rejected on Windows`);
  }
});

test('win32: backslash paths normalize and still cannot escape or reach protected files', () => {
  assert.deepEqual(normalizeAgentRelPath('src\\app.ts', 'win32'), { ok: true, rel: 'src/app.ts' });
  assert.deepEqual(normalizeAgentRelPath('src\\..\\README.md', 'win32'), { ok: true, rel: 'README.md' });
  assert.equal(normalizeAgentRelPath('src\\..\\..\\x', 'win32').ok, false);
  assert.equal(normalizeAgentRelPath('C:\\Windows\\win.ini', 'win32').ok, false);
  assert.equal(normalizeAgentRelPath('\\\\server\\share\\x', 'win32').ok, false);
  assert.deepEqual(checkAgentRelPath('.GIT\\config', 'win32'), { ok: false, error: 'That path is protected.' });
  assert.deepEqual(checkAgentRelPath('.Env.Local', 'win32'), { ok: false, error: 'That path is protected.' });
  assert.deepEqual(checkAgentRelPath('docs\\notes.md', 'win32'), { ok: true, rel: 'docs/notes.md' });
});

test('posix: Windows-only name rules do not change Linux behaviour', () => {
  assert.deepEqual(normalizeAgentRelPath('notes:2026.txt', 'linux'), { ok: true, rel: 'notes:2026.txt' });
  assert.deepEqual(normalizeAgentRelPath('backup~1.txt', 'linux'), { ok: true, rel: 'backup~1.txt' });
  assert.deepEqual(normalizeAgentRelPath('nul', 'linux'), { ok: true, rel: 'nul' });
});

test('win32: containment compares canonical paths with either separator', () => {
  assert.equal(isWithinRoot('C:\\ws', 'C:\\ws', 'win32'), true);
  assert.equal(isWithinRoot('C:\\ws', 'C:\\ws\\src\\a.ts', 'win32'), true);
  assert.equal(isWithinRoot('C:\\ws\\', 'C:/ws/src', 'win32'), true);
  assert.equal(isWithinRoot('c:\\ws', 'C:\\ws\\a', 'win32'), true, 'drive letter case is not significant');
  assert.equal(isWithinRoot('C:\\ws', '\\\\?\\C:\\ws\\a', 'win32'), true);
  assert.equal(isWithinRoot('C:\\', 'C:\\anything', 'win32'), true);
  assert.equal(isWithinRoot('\\\\nas\\share\\ws', '\\\\nas\\share\\ws\\a', 'win32'), true);
  assert.equal(isWithinRoot('\\\\nas\\share\\ws', '\\\\?\\UNC\\nas\\share\\ws\\a', 'win32'), true);

  assert.equal(isWithinRoot('C:\\ws', 'C:\\ws-evil\\a', 'win32'), false);
  assert.equal(isWithinRoot('C:\\ws', 'C:\\Users\\me\\.ssh\\id_rsa', 'win32'), false);
  assert.equal(isWithinRoot('C:\\ws', 'D:\\ws\\a', 'win32'), false);
  assert.equal(isWithinRoot('C:\\ws', 'C:\\WS2\\a', 'win32'), false);
  // realpath returns on-disk case; a differently cased folder is another folder.
  assert.equal(isWithinRoot('C:\\ws', 'C:\\WS\\a', 'win32'), false);
  assert.equal(isWithinRoot('ws', 'ws\\a', 'win32'), false, 'a relative root fails closed');
  // POSIX unchanged: a backslash is an ordinary character there.
  assert.equal(isWithinRoot('/ws', '/ws/a', 'linux'), true);
  assert.equal(isWithinRoot('/ws', '/ws\\..\\x', 'linux'), false);
});

test('win32: the held workspace root keeps a drive root intact', () => {
  assert.deepEqual(resolveSingleWorkspaceRoot(['C:\\ws\\'], 'win32'), { ok: true, root: 'C:\\ws' });
  assert.deepEqual(resolveSingleWorkspaceRoot(['c:\\ws'], 'win32'), { ok: true, root: 'c:\\ws' });
  assert.deepEqual(resolveSingleWorkspaceRoot(['C:\\'], 'win32'), { ok: true, root: 'C:\\' });
  assert.deepEqual(resolveSingleWorkspaceRoot(['D:/'], 'win32'), { ok: true, root: 'D:\\' });
  assert.deepEqual(resolveSingleWorkspaceRoot(['/home/me/ws/'], 'linux'), { ok: true, root: '/home/me/ws' });
});

test('win32: set_executable is refused before any approval is asked', () => {
  const call: ValidatedToolCall = {
    id: 'x1',
    tool: 'set_executable',
    args: { path: 'run.sh', executable: true, expectedHash: 'a'.repeat(64) },
  };
  const gate = policyGateForCall(call, [], 'win32');
  assert.equal(gate.ok, false);
  assert.match((gate as { error: string }).error, /not supported on Windows/);
  assert.deepEqual(policyGateForCall(call, [], 'linux'), { ok: true });
});

function windowsContext(files: string[], pathEnv: string, cwd = 'C:\\ws'): TestInvocationContext {
  const present = new Set(files.map((file) => file.toLowerCase()));
  return {
    platform: 'win32',
    pathEnv,
    cwd,
    isFile: (absolutePath) => present.has(absolutePath.toLowerCase()),
  };
}

test('win32: npm resolves to absolute node.exe + npm-cli.js, never from the workspace or a relative PATH entry', () => {
  const context = windowsContext(
    [
      'C:\\ws\\node_modules\\.bin\\node.exe',
      'C:\\ws\\node_modules\\.bin\\node_modules\\npm\\bin\\npm-cli.js',
      'C:\\ws\\tools\\npm.exe',
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    ],
    '.;C:\\ws\\node_modules\\.bin;tools;"C:\\Program Files\\nodejs";C:\\Windows\\System32',
  );
  assert.deepEqual(resolveTestInvocation({ executable: 'npm', argv: NPM_ARGV }, context), {
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    argv: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', ...NPM_ARGV],
  });
});

test('win32: npm falls back to a real npm.exe shim or a globally updated npm next to npm.cmd', () => {
  const volta = windowsContext(
    ['C:\\Users\\me\\AppData\\Local\\Volta\\bin\\node.exe', 'C:\\Users\\me\\AppData\\Local\\Volta\\bin\\npm.exe'],
    'C:\\Users\\me\\AppData\\Local\\Volta\\bin',
  );
  assert.deepEqual(resolveTestInvocation({ executable: 'npm', argv: NPM_ARGV }, volta), {
    executable: 'C:\\Users\\me\\AppData\\Local\\Volta\\bin\\npm.exe',
    argv: NPM_ARGV,
  });

  const globalNpm = windowsContext(
    [
      'C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd',
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js',
      'D:\\node\\node.exe',
    ],
    'C:\\Users\\me\\AppData\\Roaming\\npm;D:\\node',
  );
  assert.deepEqual(resolveTestInvocation({ executable: 'npm', argv: NPM_ARGV }, globalNpm), {
    executable: 'D:\\node\\node.exe',
    argv: ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js', ...NPM_ARGV],
  });
});

test('win32: no usable npm fails closed with a clear message; a lone npm.cmd is never run', () => {
  const onlyCmd = windowsContext(['C:\\tools\\npm.cmd'], 'C:\\tools');
  assert.throws(() => resolveTestInvocation({ executable: 'npm', argv: NPM_ARGV }, onlyCmd), {
    message: NPM_NOT_FOUND_MESSAGE,
  });
  assert.throws(() => resolveTestInvocation({ executable: 'npm', argv: NPM_ARGV }, windowsContext([], undefined as unknown as string)), {
    message: NPM_NOT_FOUND_MESSAGE,
  });
});

test('posix: the approved npm invocation is passed through unchanged', () => {
  const linux: TestInvocationContext = {
    platform: 'linux',
    pathEnv: '/usr/bin',
    cwd: '/ws',
    isFile: () => {
      throw new Error('no lookup on POSIX');
    },
  };
  assert.deepEqual(resolveTestInvocation({ executable: 'npm', argv: NPM_ARGV }, linux), {
    executable: 'npm',
    argv: NPM_ARGV,
  });
});

test('win32: the tree kill uses the absolute System32 taskkill', () => {
  assert.deepEqual(windowsTreeKillCommand(4242, 'C:\\WINDOWS'), {
    executable: 'C:\\WINDOWS\\System32\\taskkill.exe',
    argv: ['/PID', '4242', '/T', '/F'],
  });
  assert.equal(windowsTreeKillCommand(1, 'evil').executable, 'C:\\Windows\\System32\\taskkill.exe');
  assert.equal(windowsTreeKillCommand(1, undefined).executable, 'C:\\Windows\\System32\\taskkill.exe');
});

test('win32: local runtime accepts drive/UNC paths and refuses batch launchers', () => {
  const valid = {
    executablePath: 'C:\\llama.cpp\\llama-server.exe',
    modelPath: '\\\\nas\\models\\glimmer.gguf',
    projectorPath: 'D:/models/mmproj.gguf',
    draftModelPath: '',
    modelId: 'local-glimmer',
    contextSize: 32768,
    port: 8775,
    idleTimeoutSec: 600,
  };
  assert.equal(validateLocalSettings(valid, 'win32').ok, true);
  assert.equal(validateLocalSettings({ ...valid, executablePath: 'C:llama-server.exe' }, 'win32').ok, false);
  assert.equal(validateLocalSettings({ ...valid, executablePath: '/usr/bin/llama-server' }, 'win32').ok, false);
  const batch = validateLocalSettings({ ...valid, executablePath: 'C:\\llama\\start.CMD' }, 'win32');
  assert.equal(batch.ok, false);
  assert.match((batch as { error: string }).error, /\.bat\/\.cmd/);
  // Linux keeps rejecting Windows paths as relative.
  assert.equal(validateLocalSettings(valid, 'linux').ok, false);
});
