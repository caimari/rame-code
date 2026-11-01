import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkAgentRelPath,
  isProtectedRelPath,
  isWithinRoot,
  normalizeAgentRelPath,
  resolveSingleWorkspaceRoot,
} from '../src/agentPolicy.js';

test('relative paths reject absolute, dot-dot escape, and NUL', () => {
  assert.deepEqual(normalizeAgentRelPath(''), { ok: true, rel: '' });
  assert.deepEqual(normalizeAgentRelPath('.'), { ok: true, rel: '' });
  assert.deepEqual(normalizeAgentRelPath('src/a.ts'), { ok: true, rel: 'src/a.ts' });
  assert.deepEqual(normalizeAgentRelPath('./src/./b.ts'), { ok: true, rel: 'src/b.ts' });
  assert.deepEqual(normalizeAgentRelPath('src/../src/c.ts'), { ok: true, rel: 'src/c.ts' });
  assert.equal(normalizeAgentRelPath('/etc/passwd').ok, false);
  assert.equal(normalizeAgentRelPath('C:\\Windows').ok, false);
  assert.equal(normalizeAgentRelPath('../escape').ok, false);
  assert.equal(normalizeAgentRelPath('a/../../escape').ok, false);
  assert.equal(normalizeAgentRelPath('a\0b').ok, false);
  assert.equal(normalizeAgentRelPath(42).ok, false);
});

test('protected paths block secrets and control files', () => {
  for (const rel of [
    '.git/config',
    '.gitignore',
    '.env',
    '.env.local',
    'keys/id.pem',
    'cert.key',
    'store.p12',
    'vault/credentials.json',
    'docs/api-secret-notes.md',
    '.vscode/settings.json',
    '.github/workflows/ci.yml',
    'auth.json',
  ]) {
    assert.equal(isProtectedRelPath(rel), true, rel);
  }
  assert.equal(isProtectedRelPath('src/app.ts'), false);
  assert.equal(isProtectedRelPath('test/data.txt'), false);
  assert.equal(checkAgentRelPath('.git/config').ok, false);
  assert.equal(checkAgentRelPath('src/ok.ts').ok, true);
});

test('workspace root holding rejects missing and multi-root ambiguity', () => {
  assert.deepEqual(resolveSingleWorkspaceRoot(undefined), {
    ok: false,
    error: 'No workspace folder is open.',
  });
  assert.deepEqual(resolveSingleWorkspaceRoot([]), {
    ok: false,
    error: 'No workspace folder is open.',
  });
  const multi = resolveSingleWorkspaceRoot(['/a', '/b']);
  assert.equal(multi.ok, false);
  if (!multi.ok) {
    assert.match(multi.error, /Several workspace folders/);
  }
  assert.deepEqual(resolveSingleWorkspaceRoot(['/ws/']), { ok: true, root: '/ws' });
});

test('canonical containment keeps targets inside the held identity', () => {
  // POSIX fixtures; the win32 rules are covered in windows-support.test.ts.
  assert.equal(isWithinRoot('/ws', '/ws', 'linux'), true);
  assert.equal(isWithinRoot('/ws', '/ws/src/a.ts', 'linux'), true);
  assert.equal(isWithinRoot('/ws', '/ws2/evil', 'linux'), false);
  assert.equal(isWithinRoot('/ws', '/other', 'linux'), false);
  assert.equal(isWithinRoot('/ws/', '/ws/src/', 'linux'), true);
});
