import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeActionDigest,
  createPendingAction,
  MISSING_FILE_PRECONDITION,
  parseApprovalMessage,
  verifyApproval,
} from '../src/agentApproval.js';

function payload() {
  return {
    tool: 'apply_patch',
    targets: ['src/a.ts'],
    body: '{"files":[]}',
    provider: 'local',
    workspaceId: '/ws',
    threadId: 't-1',
    preconditions: { 'src/a.ts': 'a'.repeat(64) },
  };
}

function liveFor(pending: ReturnType<typeof createPendingAction>) {
  return {
    workspaceId: pending.workspaceId,
    threadId: pending.threadId,
    provider: pending.provider,
    generation: pending.generation,
    currentHashes: { ...pending.preconditions },
  };
}

test('digest binds the exact payload and approval enforces one-use', () => {
  const first = createPendingAction(payload(), 0);
  const second = createPendingAction(payload(), 0);
  assert.equal(first.digest, second.digest);
  assert.notEqual(first.actionId, second.actionId);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  const altered = createPendingAction({ ...payload(), body: '{"files":[1]}' }, 0);
  assert.notEqual(altered.digest, first.digest);

  const ok = verifyApproval(first, { actionId: first.actionId, digest: first.digest }, liveFor(first));
  assert.deepEqual(ok, { ok: true });
  first.used = true;
  assert.deepEqual(
    verifyApproval(first, { actionId: first.actionId, digest: first.digest }, liveFor(first)).ok,
    false,
  );
});

test('approval distinguishes a missing target from an existing empty file', () => {
  const pending = createPendingAction(
    {
      ...payload(),
      targets: ['new.test.js'],
      preconditions: { 'new.test.js': MISSING_FILE_PRECONDITION },
    },
    0,
  );
  const approval = { actionId: pending.actionId, digest: pending.digest };
  assert.deepEqual(verifyApproval(pending, approval, liveFor(pending)), { ok: true });
  assert.deepEqual(
    verifyApproval(pending, approval, {
      ...liveFor(pending),
      currentHashes: {
        'new.test.js': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    }),
    { ok: false, error: 'A file changed since approval; re-propose the action.' },
  );
});

test('stale, mismatched, replayed, and superseded approvals are rejected', () => {
  const pending = createPendingAction(payload(), 7);
  const live = liveFor(pending);
  // Mismatched digest.
  assert.equal(
    verifyApproval(pending, { actionId: pending.actionId, digest: 'b'.repeat(64) }, live).ok,
    false,
  );
  // Wrong action id (replay of another action).
  const other = createPendingAction(payload(), 7);
  assert.equal(
    verifyApproval(pending, { actionId: other.actionId, digest: other.digest }, live).ok,
    false,
  );
  // Cancelled generation.
  assert.equal(
    verifyApproval(pending, { actionId: pending.actionId, digest: pending.digest }, { ...live, generation: 8 }).ok,
    false,
  );
  // Changed workspace / thread / provider.
  assert.equal(
    verifyApproval(pending, { actionId: pending.actionId, digest: pending.digest }, { ...live, workspaceId: '/else' }).ok,
    false,
  );
  assert.equal(
    verifyApproval(pending, { actionId: pending.actionId, digest: pending.digest }, { ...live, threadId: 't-2' }).ok,
    false,
  );
  assert.equal(
    verifyApproval(pending, { actionId: pending.actionId, digest: pending.digest }, { ...live, provider: 'cloud' }).ok,
    false,
  );
  // Superseded by a changed file.
  assert.equal(
    verifyApproval(
      pending,
      { actionId: pending.actionId, digest: pending.digest },
      { ...live, currentHashes: { 'src/a.ts': 'c'.repeat(64) } },
    ).ok,
    false,
  );
  // Null pending (already consumed).
  assert.equal(
    verifyApproval(null, { actionId: pending.actionId, digest: pending.digest }, live).ok,
    false,
  );
});

test('approval messages require exact keys and digest shape', () => {
  const good = parseApprovalMessage({ actionId: 'act_1', digest: 'a'.repeat(64) });
  assert.equal(good.actionId, 'act_1');
  assert.throws(() => parseApprovalMessage({ actionId: 'a', digest: 'short' }), /Invalid/);
  assert.throws(() => parseApprovalMessage({ actionId: 'a', digest: 'a'.repeat(64), extra: 1 }), /Invalid/);
  assert.throws(() => parseApprovalMessage(null), /Invalid/);
  void computeActionDigest;
});
