/**
 * Shared, file-based memory/Mission storage: what makes two real VS Code
 * windows safe. Each window has its own extension host (a separate
 * process) and its own globalState cache, so these tests use separate
 * processes and separate state caches over one shared folder.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { DecisionStore, MEMORY_STATE_KEY, scopeIdForRoot, type MemoryProposal } from '../src/decisionStore.js';
import { LOCK_BUSY_MESSAGE, SharedJsonFileBackend, UNREADABLE_FILE } from '../src/sharedStateFile.js';
import { HostHarness, type PostedState } from './helpers/hostHarness.js';

const KEY = 'shipping.free_threshold_eur';
const SCOPE = scopeIdForRoot('/tmp/fixture/shop');

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rame-shared-state-'));
}

function approve(proposal: MemoryProposal) {
  return {
    proposalId: proposal.proposalId,
    proposalDigest: proposal.digest,
    scopeId: proposal.scopeId,
    threadId: proposal.provenance.threadId,
    provider: proposal.provenance.provider,
    approvedBy: 'user' as const,
    approvalDigest: createHash('sha256').update(proposal.proposalId).digest('hex'),
    approvedAt: Date.now(),
  };
}

function put(store: DecisionStore, value: number, expectedVersion: number): MemoryProposal {
  const prepared = store.preparePut({
    scopeId: SCOPE,
    scopeLabel: 'shop',
    key: KEY,
    value,
    expectedVersion,
    provenance: { source: 'user', provider: 'none', threadId: 'settings', reason: '' },
  });
  assert.ok(prepared.ok, prepared.ok ? '' : prepared.error);
  return prepared.value;
}

test('the shared file backend writes atomically and never overwrites a damaged file', async () => {
  const dir = tempDir();
  try {
    const backend = new SharedJsonFileBackend(dir);
    assert.equal(backend.get(MEMORY_STATE_KEY), undefined);
    await backend.update(MEMORY_STATE_KEY, { a: 1 });
    assert.deepEqual(backend.get(MEMORY_STATE_KEY), { a: 1 });
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left behind');
    // A damaged file reads as unreadable, and the store refuses to write over it.
    const file = path.join(dir, `${MEMORY_STATE_KEY}.json`);
    fs.writeFileSync(file, '{"schema":1,"scopes":');
    assert.equal(backend.get(MEMORY_STATE_KEY), UNREADABLE_FILE);
    const store = new DecisionStore(backend);
    assert.equal(store.isReadable(), false);
    const refused = store.preparePut({ scopeId: SCOPE, scopeLabel: 'shop', key: KEY, value: 50, expectedVersion: 0, provenance: { source: 'user', provider: 'none', threadId: 's', reason: '' } });
    assert.equal(refused.ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"schema":1,"scopes":');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock held by a live window makes a commit wait, then report busy without consuming anything', async () => {
  const dir = tempDir();
  try {
    const holder = new SharedJsonFileBackend(dir);
    const waiter = new SharedJsonFileBackend(dir, { lockTimeoutMs: 150 });
    const store = new DecisionStore(waiter);
    const proposal = put(store, 50, 0);
    let release: () => void = () => {};
    const held = holder.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
    const busy = await store.commitAuthorizedChange(approve(proposal));
    assert.deepEqual(busy, { ok: false, error: LOCK_BUSY_MESSAGE });
    release();
    await held;
    // The same authorization still works once the other window is done.
    const committed = await store.commitAuthorizedChange(approve(proposal));
    assert.ok(committed.ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock left by a crashed window is broken; a fresh one is respected', async () => {
  const dir = tempDir();
  try {
    // A dead owner: a pid that cannot exist.
    fs.mkdirSync(path.join(dir, '.lock'));
    fs.writeFileSync(path.join(dir, '.lock', 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, token: 'dead', at: Date.now() }));
    const backend = new SharedJsonFileBackend(dir, { lockTimeoutMs: 1000 });
    assert.equal(await backend.exclusive(async () => 'ran'), 'ran');
    assert.equal(fs.existsSync(path.join(dir, '.lock')), false);
    // A live owner (this process, another token) that is fresh is never broken.
    fs.mkdirSync(path.join(dir, '.lock'));
    fs.writeFileSync(path.join(dir, '.lock', 'owner.json'), JSON.stringify({ pid: process.pid, token: 'other', at: Date.now() }));
    const impatient = new SharedJsonFileBackend(dir, { lockTimeoutMs: 100 });
    await assert.rejects(impatient.exclusive(async () => 'ran'), new RegExp(LOCK_BUSY_MESSAGE.replace(/[.;]/g, '.')));
    assert.equal(fs.existsSync(path.join(dir, '.lock')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('four processes committing against the same version: exactly one wins, history stays linear', async () => {
  const dir = tempDir();
  try {
    const setup = new DecisionStore(new SharedJsonFileBackend(dir));
    assert.ok((await setup.commitAuthorizedChange(approve(put(setup, 50, 0)))).ok);
    const go = path.join(dir, 'go');
    const storeModule = path.join(__dirname, '..', 'src', 'decisionStore.js');
    const backendModule = path.join(__dirname, '..', 'src', 'sharedStateFile.js');
    const child = (value: number): Promise<string> =>
      new Promise((resolve, reject) => {
        const script = `
          const { DecisionStore, scopeIdForRoot } = require(${JSON.stringify(storeModule)});
          const { SharedJsonFileBackend } = require(${JSON.stringify(backendModule)});
          const fs = require('node:fs');
          const crypto = require('node:crypto');
          // A slow disk: every write waits first, so without the lock the
          // read-check-write windows of the racers would overlap.
          class SlowBackend extends SharedJsonFileBackend {
            async update(key, value) { await new Promise((r) => setTimeout(r, 60)); return super.update(key, value); }
          }
          const store = new DecisionStore(new SlowBackend(${JSON.stringify(dir)}, { lockTimeoutMs: 8000 }));
          const p = store.preparePut({ scopeId: scopeIdForRoot('/tmp/fixture/shop'), scopeLabel: 'shop', key: ${JSON.stringify(KEY)}, value: ${value}, expectedVersion: 1, provenance: { source: 'user', provider: 'none', threadId: 'settings', reason: '' } });
          if (!p.ok) { console.log('prepare-failed'); process.exit(0); }
          const wait = () => fs.existsSync(${JSON.stringify(go)}) ? Promise.resolve() : new Promise((r) => setTimeout(r, 5)).then(wait);
          wait().then(() => store.commitAuthorizedChange({ proposalId: p.value.proposalId, proposalDigest: p.value.digest, scopeId: p.value.scopeId, threadId: 'settings', provider: 'none', approvedBy: 'user', approvalDigest: crypto.createHash('sha256').update(p.value.proposalId).digest('hex'), approvedAt: Date.now() }))
            .then((r) => console.log(r.ok ? 'won' : 'lost: ' + r.error));
        `;
        execFile(process.execPath, ['-e', script], { timeout: 20000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
      });
    const racers = [55, 60, 65, 70].map(child);
    await new Promise((resolve) => setTimeout(resolve, 400));
    fs.writeFileSync(go, '');
    const results = await Promise.all(racers);
    assert.equal(results.filter((line) => line === 'won').length, 1, JSON.stringify(results));
    assert.equal(results.filter((line) => /^lost: shipping\.free_threshold_eur changed to version 2 after this proposal was prepared for version 1\./.test(line)).length, 3, JSON.stringify(results));
    const history = new DecisionStore(new SharedJsonFileBackend(dir)).getDecisionHistory(SCOPE, KEY);
    assert.deepEqual(history.map((entry) => entry.version), [1, 2]);
    assert.equal(history[1]?.previousDigest, history[0]?.digest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface MemoryState {
  decisions: Array<{ value: string; version: number }>;
  pending: { actionId: string; digest: string; text: string } | null;
}
const memoryOf = (state: PostedState): MemoryState => state.memory as MemoryState;

test('two windows with unsynchronized state caches share memory through the files', async () => {
  const shared = tempDir();
  const h = new HostHarness({ sharedStateDir: shared });
  await h.start({ agentProfile: 'safe-auto' });
  try {
    const setValue = async (value: string) => {
      h.send({ type: 'proposeDecision', key: KEY, valueType: 'number', value });
      const shown = await h.waitFor((state) => (memoryOf(state)?.pending?.text ?? '').includes(` to ${value} (`));
      return memoryOf(shown).pending as { actionId: string; digest: string };
    };
    const first = await setValue('50');
    h.send({ type: 'approveMemoryChange', actionId: first.actionId, digest: first.digest });
    await h.waitFor((state) => state.status === `Saved ${KEY} v1 = 50.`);
    assert.equal(h.memento.get(MEMORY_STATE_KEY), undefined, 'memory is not kept in the window state cache');
    // Window B starts with its own, empty state cache.
    const windowA = h.provider;
    h.createProvider({ isolatedState: true });
    h.send({ type: 'navigate', screen: 'settings' });
    const seen = await h.waitFor((state) => memoryOf(state)?.decisions?.length === 1 && memoryOf(state)?.pending === null);
    assert.deepEqual(memoryOf(seen).decisions.map((d) => [d.value, d.version]), [['50', 1]], 'window B sees window A');
    // B shows a card for 55 on v1; A then commits 60; B's card is refused.
    const cardB = await setValue('55');
    const windowB = h.provider;
    const p = (windowA as unknown as { memory: DecisionStore }).memory.preparePut({
      scopeId: (windowB as unknown as { memoryPending: { proposal: MemoryProposal } }).memoryPending.proposal.scopeId,
      scopeLabel: 'ws',
      key: KEY,
      value: 60,
      expectedVersion: 1,
      provenance: { source: 'user', provider: 'none', threadId: 'settings', reason: '' },
    });
    assert.ok(p.ok);
    assert.ok((await (windowA as unknown as { memory: DecisionStore }).memory.commitAuthorizedChange(approve(p.value))).ok);
    await windowB.approveMemoryChange(cardB.actionId, cardB.digest);
    assert.ok(h.posted.some((state) => /^Not written: shipping\.free_threshold_eur changed since this proposal was shown/.test(state.status)));
    const history = new DecisionStore(new SharedJsonFileBackend(shared)).getDecisionHistory(p.value.scopeId, KEY);
    assert.deepEqual(history.map((entry) => entry.value), [50, 60]);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
    fs.rmSync(shared, { recursive: true, force: true });
  }
});
