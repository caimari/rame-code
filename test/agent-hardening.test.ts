import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { computeActionDigest } from '../src/agentApproval.js';
import {
  boundRunTestsStillMatches,
  describeBoundRunTestsAction,
  isDerivedNpmTestCommand,
} from '../src/agentCommands.js';
import {
  ensureCanonicalScope,
  executeListFiles,
  executeReadFile,
  executeSearchText,
  guardFsPath,
  type AgentFs,
} from '../src/agentHost.js';
import { applyPatchAtomically, hashContent } from '../src/agentPatch.js';
import {
  AGENT_BOUNDARIES_TEXT,
  WORKSPACE_FULL_WARNING,
} from '../src/agentProfiles.js';
import { AGENT_SCOPE_NOTICE } from '../src/viewMessages.js';

function canonicalMemoryFs(opts: {
  files: Record<string, string>;
  dirs?: string[];
  symlinks?: string[];
  rootReal?: string;
  realTargets?: Record<string, string>;
}): AgentFs {
  const store = new Map(Object.entries(opts.files));
  const dirs = opts.dirs ?? [''];
  const symlinks = new Set(opts.symlinks ?? []);
  const rootReal = opts.rootReal ?? '/ws';
  const realTargets = opts.realTargets ?? {};
  const kindOf = (rel: string): 'file' | 'dir' | 'symlink' | 'missing' | 'other' => {
    if (symlinks.has(rel)) {
      return 'symlink';
    }
    if (store.has(rel)) {
      return 'file';
    }
    if (dirs.includes(rel) || rel === '') {
      return 'dir';
    }
    return 'missing';
  };
  return {
    async listEntries(rel: string) {
      const prefix = rel === '' ? '' : `${rel}/`;
      const names = new Set<string>();
      for (const path of [...store.keys(), ...dirs]) {
        if (path === rel) {
          continue;
        }
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length);
          const head = rest.split('/')[0] as string;
          if (head) {
            names.add(head);
          }
        }
      }
      for (const link of symlinks) {
        if (rel === '' && !link.includes('/')) {
          names.add(link);
        }
      }
      return [...names].map((name) => {
        const full = rel === '' ? name : `${rel}/${name}`;
        return {
          name,
          isFile: store.has(full),
          isDir: dirs.includes(full),
          isSymlink: symlinks.has(full),
        };
      });
    },
    async readText(rel: string) {
      const value = store.get(rel);
      if (value === undefined) {
        throw new Error('missing');
      }
      return value;
    },
    async stat(rel: string) {
      return { kind: kindOf(rel) };
    },
    async writeText(rel: string, content: string) {
      store.set(rel, content);
    },
    async removeFile(rel: string) {
      store.delete(rel);
    },
    async realpath(rel: string) {
      if (Object.prototype.hasOwnProperty.call(realTargets, rel)) {
        return realTargets[rel] as string;
      }
      const kind = kindOf(rel);
      if (kind === 'missing' || rel === '') {
        if (rel === '') {
          return rootReal;
        }
        throw new Error('missing');
      }
      return `${rootReal}/${rel}`;
    },
    async realpathRoot() {
      return rootReal;
    },
  };
}

const readCall = (path: string) => ({ id: 'r1', tool: 'read_file' as const, args: { path, maxBytes: 1024 } });

test('parent symlink escape is blocked on read', async () => {
  const fs = canonicalMemoryFs({
    files: { 'ok.txt': 'ok', 'linked-dir/public.txt': 'outside' },
    dirs: ['', 'linked-dir'],
    symlinks: ['linked-dir'],
  });
  await assert.rejects(executeReadFile(fs, readCall('linked-dir/public.txt')), /Symlink/);
  await assert.rejects(guardFsPath(fs, 'linked-dir/public.txt', '/ws'), /Symlink/);
});

test('parent symlink escape is blocked on list and search', async () => {
  const fs = canonicalMemoryFs({
    files: { 'linked-dir/inner.txt': 'hello secret' },
    dirs: ['', 'linked-dir'],
    symlinks: ['linked-dir'],
  });
  await assert.rejects(
    executeListFiles(fs, { id: 'l1', tool: 'list_files', args: { dir: 'linked-dir', limit: 10 } }, '/ws'),
    /Symlink/,
  );
  await assert.rejects(
    executeSearchText(
      fs,
      { id: 's1', tool: 'search_text', args: { query: 'hello', dir: 'linked-dir', isRegex: false, maxResults: 10 } },
      '/ws',
    ),
    /Symlink/,
  );
});

test('missing child beneath a symlink parent is rejected for write', async () => {
  const fs = canonicalMemoryFs({
    files: {},
    dirs: [''],
    symlinks: ['linked-dir'],
    realTargets: { 'linked-dir': '/outside/secret' },
  });
  await assert.rejects(ensureCanonicalScope(fs, 'linked-dir/new.txt', '/ws'), /Symlink/);
});

test('canonical escape outside the held root is rejected', async () => {
  const fs = canonicalMemoryFs({
    files: { 'evil.txt': 'x' },
    dirs: ['', 'evil.txt'],
    realTargets: { 'evil.txt': '/outside/evil.txt' },
  });
  await assert.rejects(ensureCanonicalScope(fs, 'evil.txt', '/ws'), /escapes/);
});

test('patch rollback removes a newly-created file and restores the existing one', () => {
  const store = new Map<string, string>([['a.txt', 'v1']]);
  let calls = 0;
  const host = {
    inspect(rel: string) {
      if (store.has(rel)) {
        return { kind: 'file' as const, bytes: store.get(rel) as string };
      }
      return { kind: 'missing' as const, bytes: '' };
    },
    write(rel: string, content: string) {
      calls += 1;
      if (calls === 2) {
        // Fail after the new file was created first.
        store.set('new.txt', 'new-content');
        throw new Error('boom');
      }
      store.set(rel, content);
    },
    remove(rel: string) {
      store.delete(rel);
    },
  };
  const result = applyPatchAtomically(
    [
      { path: 'new.txt', expectedHash: hashContent(''), newContent: 'new-content' },
      { path: 'a.txt', expectedHash: hashContent('v1'), newContent: 'v2' },
    ],
    host,
  );
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.equal(store.has('new.txt'), false);
  assert.equal(store.get('a.txt'), 'v1');
});

test('patch verification failure rolls back mixed targets with confirmation', () => {
  const store = new Map<string, string>([['a.txt', 'v1']]);
  const host = {
    inspect(rel: string) {
      // Lie after the write so verification fails for the new file.
      if (rel === 'new.txt' && store.get('new.txt') === 'new-content') {
        return { kind: 'file' as const, bytes: 'tampered' };
      }
      if (store.has(rel)) {
        return { kind: 'file' as const, bytes: store.get(rel) as string };
      }
      return { kind: 'missing' as const, bytes: '' };
    },
    write(rel: string, content: string) {
      store.set(rel, content);
    },
    remove(rel: string) {
      store.delete(rel);
    },
  };
  const result = applyPatchAtomically(
    [
      { path: 'a.txt', expectedHash: hashContent('v1'), newContent: 'v2' },
      { path: 'new.txt', expectedHash: hashContent(''), newContent: 'new-content' },
    ],
    host,
  );
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.equal(store.has('new.txt'), false);
  assert.equal(store.get('a.txt'), 'v1');
});

test('patch without bounded remove never claims a verified restore', () => {
  const store = new Map<string, string>([['a.txt', 'v1']]);
  let calls = 0;
  const host = {
    inspect(rel: string) {
      if (store.has(rel)) {
        return { kind: 'file' as const, bytes: store.get(rel) as string };
      }
      return { kind: 'missing' as const, bytes: '' };
    },
    write(rel: string, content: string) {
      calls += 1;
      if (calls === 2) {
        store.set('new.txt', 'partial');
        throw new Error('boom');
      }
      store.set(rel, content);
    },
  };
  const result = applyPatchAtomically(
    [
      { path: 'new.txt', expectedHash: hashContent(''), newContent: 'new-content' },
      { path: 'a.txt', expectedHash: hashContent('v1'), newContent: 'v2' },
    ],
    host,
  );
  assert.equal(result.ok, false);
  assert.equal(result.restored, false);
});

test('test-command boundary wording is honest about OS permissions', () => {
  assert.doesNotMatch(AGENT_BOUNDARIES_TEXT, /no external network/);
  assert.match(AGENT_BOUNDARIES_TEXT, /OS permissions/);
  assert.match(AGENT_BOUNDARIES_TEXT, /may access files, network/);
  assert.match(AGENT_BOUNDARIES_TEXT, /Workspace-full may run them without/);
  assert.match(AGENT_BOUNDARIES_TEXT, /high risk/);
  assert.match(AGENT_BOUNDARIES_TEXT, /shell:false/);
  assert.match(WORKSPACE_FULL_WARNING, /high risk/);
  assert.match(WORKSPACE_FULL_WARNING, /OS/);
  assert.match(WORKSPACE_FULL_WARNING, /not sandboxed/);
  assert.match(AGENT_SCOPE_NOTICE, /OS permissions/);
  assert.match(AGENT_SCOPE_NOTICE, /arbitrary internet/);
  assert.match(AGENT_SCOPE_NOTICE, /no OS sandbox/);
  const html = readFileSync('src/viewHtml.ts', 'utf8');
  assert.match(html, /OS permissions/);
  assert.match(html, /high risk/);
  assert.doesNotMatch(html, /no external network/);
  const script = readFileSync('media/main.js', 'utf8');
  // Client renders host/HTML content safely; no duplicated security paragraph.
  assert.match(script, /agentWarningEl/);
  assert.match(script, /workspace-full/);
  assert.match(script, /agentWarningEl\.hidden/);
  assert.match(script, /textContent/);
  // Reject executable innerHTML use (property or bracket access), not the
  // bare word in documentation comments.
  assert.doesNotMatch(script, /\.innerHTML/);
  assert.doesNotMatch(script, /\[\s*['"]innerHTML['"]\s*\]/);
});

test('run_tests approval binds the resolved action and package.json state', () => {
  const command = { id: 'npm:test', executable: 'npm', argv: ['run', '--ignore-scripts', 'test'], description: 'x' };
  const raw = JSON.stringify({ scripts: { test: 'node --test' } });
  const bound = describeBoundRunTestsAction('npm:test', command, raw, 'node --test', hashContent);
  assert.deepEqual(bound.targets, ['npm:test']);
  assert.deepEqual(bound.preconditions, { 'package.json': hashContent(raw) });
  assert.match(bound.body, /npm/);
  assert.match(bound.body, /node --test/);
  const digestFor = (body: string, pre: Record<string, string>) =>
    computeActionDigest({
      tool: 'run_tests',
      targets: ['npm:test'],
      body,
      provider: 'local',
      workspaceId: '/ws',
      threadId: 't-1',
      preconditions: pre,
    });
  const before = digestFor(bound.body, bound.preconditions);
  const alteredScript = describeBoundRunTestsAction('npm:test', command, raw, 'rm -rf /', hashContent);
  assert.notEqual(digestFor(alteredScript.body, alteredScript.preconditions), before);
  const alteredRaw = JSON.stringify({ scripts: { test: 'node --test --changed' } });
  const alteredPkg = describeBoundRunTestsAction('npm:test', command, alteredRaw, 'node --test --changed', hashContent);
  assert.notEqual(digestFor(alteredPkg.body, alteredPkg.preconditions), before);
  assert.equal(
    boundRunTestsStillMatches(bound.body, bound.preconditions, command, raw, 'node --test', hashContent),
    true,
  );
  assert.equal(
    boundRunTestsStillMatches(bound.body, bound.preconditions, command, alteredRaw, 'node --test --changed', hashContent),
    false,
  );
  assert.equal(
    boundRunTestsStillMatches(
      bound.body,
      bound.preconditions,
      { ...command, executable: 'npx' },
      raw,
      'node --test',
      hashContent,
    ),
    false,
  );
  assert.equal(boundRunTestsStillMatches(bound.body, bound.preconditions, null, raw, 'node --test', hashContent), false);
  assert.equal(isDerivedNpmTestCommand(command), true);
  assert.equal(
    isDerivedNpmTestCommand({ id: 'custom', executable: 'npx', argv: ['run', 'test'], description: 'x' }),
    false,
  );
  // Without --ignore-scripts npm would also run pretest/posttest hooks.
  assert.equal(
    isDerivedNpmTestCommand({ id: 'npm:test', executable: 'npm', argv: ['run', 'test'], description: 'x' }),
    false,
  );
});
