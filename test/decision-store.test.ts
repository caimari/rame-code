import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  DecisionStore,
  MEMORY_STATE_KEY,
  PROPOSAL_TTL_MS,
  describeProposal,
  scopeIdForRoot,
  type DecisionProposal,
  type MemoryAuthorization,
  type MemoryBackend,
  type MemoryProposal,
} from '../src/decisionStore.js';

const KEY = 'shipping.free_threshold_eur';

/** In-memory Memento double; JSON round-trips like VS Code state. */
class FakeBackend implements MemoryBackend {
  readonly data = new Map<string, unknown>();
  writes = 0;
  get(key: string): unknown {
    const value = this.data.get(key);
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
  }
  update(key: string, value: unknown): Promise<void> {
    this.writes += 1;
    this.data.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    return Promise.resolve();
  }
}

const SCOPE = scopeIdForRoot('/tmp/fixture/shop');
const OTHER_SCOPE = scopeIdForRoot('/tmp/fixture/blog');

function provenance(threadId = 'thread-1', provider: 'cloud' | 'local' | 'none' = 'none', source: 'user' | 'model' = 'user') {
  return { source, provider, threadId, reason: 'Business rule from the product owner.' };
}

function approve(proposal: MemoryProposal, overrides: Partial<MemoryAuthorization> = {}): MemoryAuthorization {
  return {
    proposalId: proposal.proposalId,
    proposalDigest: proposal.digest,
    scopeId: proposal.scopeId,
    threadId: proposal.provenance.threadId,
    provider: proposal.provenance.provider,
    approvedBy: 'user',
    approvalDigest: createHash('sha256').update(`card:${proposal.proposalId}`).digest('hex'),
    approvedAt: Date.now(),
    ...overrides,
  };
}

function put(store: DecisionStore, value: unknown, expectedVersion: number, scopeId = SCOPE, threadId = 'thread-1'): DecisionProposal {
  const prepared = store.preparePut({ scopeId, scopeLabel: 'shop', key: KEY, value, expectedVersion, provenance: provenance(threadId) });
  assert.ok(prepared.ok, prepared.ok ? '' : prepared.error);
  return prepared.value;
}

const PASS = { commandId: 'npm:test', exitCode: 0 as const, ranAt: 1, resultDigest: 'a'.repeat(64) };

test('PUT v0 -> v1 and v1 -> v2 keep the whole history', async () => {
  const backend = new FakeBackend();
  const store = new DecisionStore(backend);
  assert.equal(store.latestVersion(SCOPE, KEY), 0);
  const first = put(store, 50, 0);
  assert.equal(first.newVersion, 1);
  assert.equal(store.getDecision(SCOPE, KEY), null, 'preparing writes nothing');
  assert.equal(backend.writes, 0);
  const v1 = await store.commitAuthorizedChange(approve(first));
  assert.ok(v1.ok);
  assert.equal(store.getDecision(SCOPE, KEY)?.value, 50);
  const second = put(store, 60, 1);
  assert.equal(second.previousValue, 50);
  assert.match(describeProposal(second), /Set shipping\.free_threshold_eur from 50 \(v1\) to 60 \(v2\)/);
  assert.ok((await store.commitAuthorizedChange(approve(second))).ok);
  const current = store.getDecision(SCOPE, KEY);
  assert.equal(current?.value, 60);
  assert.equal(current?.version, 2);
  const history = store.getDecisionHistory(SCOPE, KEY);
  assert.deepEqual(history.map((entry) => [entry.version, entry.value, entry.expectedVersion]), [[1, 50, 0], [2, 60, 1]]);
  assert.equal(history[1]?.previousDigest, history[0]?.digest, 'versions are chained');
  assert.equal(history[0]?.actor, 'user');
  assert.equal(history[0]?.provenance.reason, 'Business rule from the product owner.');
  assert.match(history[0]?.proposalDigest ?? '', /^[0-9a-f]{64}$/);
});

test('a new instance over the same state recovers 60, its history, and rejects old proposals', async () => {
  const backend = new FakeBackend();
  const first = new DecisionStore(backend);
  const p1 = put(first, 50, 0);
  await first.commitAuthorizedChange(approve(p1));
  const p2 = put(first, 60, 1);
  await first.commitAuthorizedChange(approve(p2));
  const reloaded = new DecisionStore(backend);
  assert.equal(reloaded.getDecision(SCOPE, KEY)?.value, 60);
  assert.equal(reloaded.getDecisionHistory(SCOPE, KEY).length, 2);
  // Replaying the old authorization after the reload is rejected.
  const replay = await reloaded.commitAuthorizedChange(approve(p1));
  assert.deepEqual(replay, { ok: false, error: 'That authorization was already used.' });
  // An old session still based on v1 cannot even prepare "back to 50".
  const old = reloaded.preparePut({ scopeId: SCOPE, scopeLabel: 'shop', key: KEY, value: 50, expectedVersion: 1, provenance: provenance() });
  assert.equal(old.ok, false);
  assert.match(old.ok ? '' : old.error, /is at version 2, not 1/);
  assert.equal(reloaded.getDecision(SCOPE, KEY)?.value, 60);
});

test('two projects never see each other', async () => {
  const store = new DecisionStore(new FakeBackend());
  await store.commitAuthorizedChange(approve(put(store, 50, 0, SCOPE)));
  assert.equal(store.getDecision(OTHER_SCOPE, KEY), null);
  await store.commitAuthorizedChange(approve(put(store, 10, 0, OTHER_SCOPE)));
  assert.equal(store.getDecision(SCOPE, KEY)?.value, 50);
  assert.equal(store.getDecision(OTHER_SCOPE, KEY)?.value, 10);
  // An authorization for one project cannot commit into another.
  const proposal = put(store, 70, 1, SCOPE);
  const crossed = await store.commitAuthorizedChange(approve(proposal, { scopeId: OTHER_SCOPE }));
  assert.match(crossed.ok ? '' : crossed.error, /another project, thread, or provider/);
  assert.equal(store.getDecision(SCOPE, KEY)?.value, 50);
});

test('an authorization is single use, digest-bound, and bound to thread and provider', async () => {
  const store = new DecisionStore(new FakeBackend());
  const proposal = put(store, 50, 0);
  for (const [overrides, expected] of [
    [{ proposalDigest: 'f'.repeat(64) }, /exact proposal/],
    [{ threadId: 'thread-2' }, /another project, thread, or provider/],
    [{ provider: 'cloud' as const }, /another project, thread, or provider/],
    [{ approvedBy: 'model' as unknown as 'user' }, /Only a host approval/],
    [{ approvalDigest: 'not-a-digest' }, /Only a host approval/],
    [{ proposalId: 'mem_' + '0'.repeat(32) }, /does not match a pending proposal/],
  ] as const) {
    const result = await store.commitAuthorizedChange(approve(proposal, overrides));
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, expected);
  }
  assert.equal(store.getDecision(SCOPE, KEY), null, 'no rejected authorization wrote anything');
  assert.ok((await store.commitAuthorizedChange(approve(proposal))).ok);
  const reuse = await store.commitAuthorizedChange(approve(proposal));
  assert.deepEqual(reuse, { ok: false, error: 'That authorization was already used.' });
  assert.equal(store.getDecisionHistory(SCOPE, KEY).length, 1);
});

test('a proposal changed after preparation no longer matches its digest', async () => {
  const store = new DecisionStore(new FakeBackend());
  const proposal = put(store, 50, 0);
  // Tamper with the store's own pending copy (as a bug or an attacker would).
  const internal = (store as unknown as { pending: Map<string, DecisionProposal> }).pending.get(proposal.proposalId) as DecisionProposal;
  internal.value = 0;
  const result = await store.commitAuthorizedChange(approve(proposal));
  assert.match(result.ok ? '' : result.error, /exact proposal/);
  assert.equal(store.getDecision(SCOPE, KEY), null);
});

test('stale expectedVersion: two concurrent updates, only the first wins', async () => {
  const backend = new FakeBackend();
  const windowA = new DecisionStore(backend);
  const windowB = new DecisionStore(backend);
  await windowA.commitAuthorizedChange(approve(put(windowA, 50, 0)));
  const fromA = put(windowA, 60, 1);
  const fromB = put(windowB, 55, 1);
  const results = await Promise.all([windowA.commitAuthorizedChange(approve(fromA)), windowB.commitAuthorizedChange(approve(fromB))]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  const loser = results.find((result) => !result.ok);
  assert.match(loser && !loser.ok ? loser.error : '', /changed to version 2 after this proposal was prepared for version 1\. Nothing was written\./);
  assert.equal(windowB.getDecision(SCOPE, KEY)?.value, 60);
  assert.deepEqual(windowB.getDecisionHistory(SCOPE, KEY).map((entry) => entry.value), [50, 60]);
  // The losing authorization is consumed: retrying it cannot succeed later.
  const retry = await windowB.commitAuthorizedChange(approve(fromB));
  assert.equal(retry.ok, false);
});

test('cancellation before commit discards the proposal', async () => {
  const store = new DecisionStore(new FakeBackend());
  const proposal = put(store, 50, 0, SCOPE, 'thread-9');
  assert.equal(store.discardProposals({ threadId: 'thread-9' }), 1);
  const result = await store.commitAuthorizedChange(approve(proposal));
  assert.match(result.ok ? '' : result.error, /does not match a pending proposal/);
  assert.equal(store.getDecision(SCOPE, KEY), null);
});

test('an unapproved proposal expires', async () => {
  let clock = 1_000_000;
  const store = new DecisionStore(new FakeBackend(), () => clock);
  const proposal = put(store, 50, 0);
  clock += PROPOSAL_TTL_MS + 1;
  const result = await store.commitAuthorizedChange(approve(proposal));
  assert.match(result.ok ? '' : result.error, /expired/);
});

test('partial corruption: the damaged key is kept but unusable, the rest keeps working', async () => {
  const backend = new FakeBackend();
  const store = new DecisionStore(backend);
  await store.commitAuthorizedChange(approve(put(store, 50, 0)));
  const other = store.preparePut({ scopeId: SCOPE, scopeLabel: 'shop', key: 'tax.rate_pct', value: 21, expectedVersion: 0, provenance: provenance() });
  assert.ok(other.ok);
  await store.commitAuthorizedChange(approve(other.value));
  // Flip the stored value of one version without fixing its digest.
  const raw = backend.get(MEMORY_STATE_KEY) as { scopes: Record<string, { decisions: Record<string, Array<{ value: unknown }>> }> };
  (raw.scopes[SCOPE]?.decisions[KEY] as Array<{ value: unknown }>)[0]!.value = 0;
  await backend.update(MEMORY_STATE_KEY, raw);
  const readout = store.readScope(SCOPE);
  assert.deepEqual(readout.corruptKeys, [KEY]);
  assert.deepEqual(readout.current.map((entry) => entry.key), ['tax.rate_pct']);
  assert.equal(store.getDecision(SCOPE, KEY), null, 'a tampered value is never used');
  const refused = store.preparePut({ scopeId: SCOPE, scopeLabel: 'shop', key: KEY, value: 60, expectedVersion: 1, provenance: provenance() });
  assert.match(refused.ok ? '' : refused.error, /failed validation; it is kept as is/);
  // Writing another key keeps the damaged record exactly as stored.
  const tax = store.preparePut({ scopeId: SCOPE, scopeLabel: 'shop', key: 'tax.rate_pct', value: 10, expectedVersion: 1, provenance: provenance() });
  assert.ok(tax.ok);
  assert.ok((await store.commitAuthorizedChange(approve(tax.value))).ok);
  const after = backend.get(MEMORY_STATE_KEY) as typeof raw;
  assert.equal((after.scopes[SCOPE]?.decisions[KEY] as Array<{ value: unknown }>)[0]?.value, 0, 'evidence of the damage is preserved');
});

test('an unreadable memory blob is never overwritten', async () => {
  const backend = new FakeBackend();
  backend.data.set(MEMORY_STATE_KEY, { schema: 99, garbage: true });
  const store = new DecisionStore(backend);
  assert.equal(store.isReadable(), false);
  assert.deepEqual(store.listCurrentDecisions(SCOPE), []);
  const refused = store.preparePut({ scopeId: SCOPE, scopeLabel: 'shop', key: KEY, value: 50, expectedVersion: 0, provenance: provenance() });
  assert.match(refused.ok ? '' : refused.error, /could not be read, so RAME Code will not write to it/);
  assert.equal(backend.writes, 0);
  assert.deepEqual(backend.get(MEMORY_STATE_KEY), { schema: 99, garbage: true });
});

test('invalid keys and values are refused before anything is prepared', () => {
  const store = new DecisionStore(new FakeBackend());
  for (const key of ['', 'Shipping.Threshold', 'a..b', 'x'.repeat(200), 'drop table;', '__proto__']) {
    const result = store.preparePut({ scopeId: SCOPE, scopeLabel: 'shop', key, value: 1, expectedVersion: 0, provenance: provenance() });
    assert.equal(result.ok, false, key);
  }
  for (const value of [Number.NaN, Infinity, '', 'a\u0000b', {}, [], null, undefined, 'x'.repeat(2001)]) {
    const result = store.preparePut({ scopeId: SCOPE, scopeLabel: 'shop', key: KEY, value, expectedVersion: 0, provenance: provenance() });
    assert.equal(result.ok, false, JSON.stringify(value));
  }
  const negative = store.preparePut({ scopeId: SCOPE, scopeLabel: 'shop', key: KEY, value: 1, expectedVersion: -1, provenance: provenance() });
  assert.equal(negative.ok, false);
});

test('a 50 artifact turns stale when the decision becomes 60 and current again after re-verification', async () => {
  const store = new DecisionStore(new FakeBackend());
  await store.commitAuthorizedChange(approve(put(store, 50, 0)));
  const hash50 = 'b'.repeat(64);
  const bind50 = store.prepareArtifactBinding({
    scopeId: SCOPE,
    scopeLabel: 'shop',
    path: 'shipping.js',
    fileHash: hash50,
    decisionKey: KEY,
    decisionVersion: 1,
    verification: PASS,
    provenance: provenance('thread-1', 'local', 'model'),
  });
  assert.ok(bind50.ok);
  assert.match(describeProposal(bind50.value), /Mark shipping\.js \(sha256 bbbbbbbbbbbb…\) as verified against shipping\.free_threshold_eur v1 = 50/);
  assert.ok((await store.commitAuthorizedChange(approve(bind50.value))).ok);
  assert.deepEqual(store.artifactStatuses(SCOPE, { 'shipping.js': hash50 }).map((entry) => entry.status), ['current']);
  assert.deepEqual(store.artifactStatuses(SCOPE, { 'shipping.js': 'c'.repeat(64) }).map((entry) => entry.status), ['modified']);
  assert.deepEqual(store.artifactStatuses(SCOPE, { 'shipping.js': null }).map((entry) => entry.status), ['missing']);
  assert.deepEqual(store.artifactStatuses(SCOPE, {}).map((entry) => entry.status), ['unverified']);
  await store.commitAuthorizedChange(approve(put(store, 60, 1)));
  const stale = store.listStaleArtifacts(SCOPE, { 'shipping.js': hash50 });
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.status, 'stale');
  assert.equal(stale[0]?.detail, 'Verified against v1, but shipping.free_threshold_eur is now v2.');
  // Binding again against the old version is refused.
  const oldBind = store.prepareArtifactBinding({
    scopeId: SCOPE,
    scopeLabel: 'shop',
    path: 'shipping.js',
    fileHash: hash50,
    decisionKey: KEY,
    decisionVersion: 1,
    verification: PASS,
    provenance: provenance('thread-1', 'local', 'model'),
  });
  assert.match(oldBind.ok ? '' : oldBind.error, /is at version 2, not 1/);
  const hash60 = 'd'.repeat(64);
  const bind60 = store.prepareArtifactBinding({
    scopeId: SCOPE,
    scopeLabel: 'shop',
    path: 'shipping.js',
    fileHash: hash60,
    decisionKey: KEY,
    decisionVersion: 2,
    verification: PASS,
    provenance: provenance('thread-1', 'local', 'model'),
  });
  assert.ok(bind60.ok);
  assert.ok((await store.commitAuthorizedChange(approve(bind60.value))).ok);
  const views = store.artifactStatuses(SCOPE, { 'shipping.js': hash60 });
  assert.deepEqual(views.map((entry) => [entry.status, entry.decisionVersion]), [['current', 2]], 'one binding per file and decision');
  assert.equal(store.listStaleArtifacts(SCOPE, { 'shipping.js': hash60 }).length, 0);
});

test('a binding prepared before the decision changed is refused at commit', async () => {
  const store = new DecisionStore(new FakeBackend());
  await store.commitAuthorizedChange(approve(put(store, 50, 0)));
  const bind = store.prepareArtifactBinding({
    scopeId: SCOPE,
    scopeLabel: 'shop',
    path: 'shipping.js',
    fileHash: 'b'.repeat(64),
    decisionKey: KEY,
    decisionVersion: 1,
    verification: PASS,
    provenance: provenance(),
  });
  assert.ok(bind.ok);
  await store.commitAuthorizedChange(approve(put(store, 60, 1)));
  const late = await store.commitAuthorizedChange(approve(bind.value));
  assert.match(late.ok ? '' : late.error, /no longer at version 1; the artifact was not bound/);
  assert.equal(store.listArtifacts(SCOPE).length, 0);
  // A failing test never verifies anything.
  const failing = store.prepareArtifactBinding({
    scopeId: SCOPE,
    scopeLabel: 'shop',
    path: 'shipping.js',
    fileHash: 'b'.repeat(64),
    decisionKey: KEY,
    decisionVersion: 2,
    verification: { ...PASS, exitCode: 1 as unknown as 0 },
    provenance: provenance(),
  });
  assert.match(failing.ok ? '' : failing.error, /Only a passing test/);
});

test('delete keeps history and makes bound artifacts read as removed', async () => {
  const store = new DecisionStore(new FakeBackend());
  await store.commitAuthorizedChange(approve(put(store, 50, 0)));
  const removal = store.prepareDelete({ scopeId: SCOPE, scopeLabel: 'shop', key: KEY, expectedVersion: 1, provenance: provenance() });
  assert.ok(removal.ok);
  assert.match(describeProposal(removal.value), /Remove shipping\.free_threshold_eur \(now 50, v1\)/);
  await store.commitAuthorizedChange(approve(removal.value));
  assert.equal(store.getDecision(SCOPE, KEY), null);
  assert.deepEqual(store.getDecisionHistory(SCOPE, KEY).map((entry) => entry.op), ['put', 'delete']);
  assert.ok(store.preparePut({ scopeId: SCOPE, scopeLabel: 'shop', key: KEY, value: 60, expectedVersion: 2, provenance: provenance() }).ok);
});
