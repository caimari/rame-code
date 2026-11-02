/**
 * Approval binding for Agent actions.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * Every pending action carries an opaque id plus a host-side cryptographic
 * digest over the exact payload. Approval binds to the payload, workspace
 * identity, thread, provider, and file/version preconditions. Stale,
 * mismatched, replayed, already-used, or superseded approvals are rejected.
 * One approval authorizes one action only; cancellation invalidates pending
 * approvals via a generation counter.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface AgentActionPayload {
  tool: string;
  /** Normalized targets (relative paths or command ids). */
  targets: string[];
  /** Exact patch/diff text or exact allowlisted command, when applicable. */
  body: string;
  provider: string;
  workspaceId: string;
  threadId: string;
  preconditions: Record<string, string>;
}

export interface PendingAgentAction extends AgentActionPayload {
  actionId: string;
  digest: string;
  createdAt: number;
  generation: number;
  used: boolean;
}

/** Host-only value distinguishing an absent target from an empty file. */
export const MISSING_FILE_PRECONDITION = 'rame:missing:v1';

/** Host-side digest over the exact canonical action payload. */
export function computeActionDigest(payload: AgentActionPayload): string {
  const canonical = JSON.stringify({
    tool: payload.tool,
    targets: [...payload.targets],
    body: payload.body,
    provider: payload.provider,
    workspaceId: payload.workspaceId,
    threadId: payload.threadId,
    preconditions: sortRecord(payload.preconditions),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = record[key] as string;
  }
  return out;
}

/** Create one pending action with a fresh opaque id and digest. */
export function createPendingAction(
  payload: AgentActionPayload,
  generation: number,
  now: number = Date.now(),
): PendingAgentAction {
  const digest = computeActionDigest(payload);
  return {
    ...payload,
    targets: [...payload.targets],
    preconditions: { ...payload.preconditions },
    actionId: `act_${randomBytes(16).toString('hex')}`,
    digest,
    createdAt: now,
    generation,
    used: false,
  };
}

export interface ApprovalMessage {
  actionId: string;
  digest: string;
}

export type ApprovalCheck =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Verify an approve/reject message against the pending action. The caller
 * supplies the live workspace/thread/provider identity plus current file
 * hashes; any drift (stale workspace, superseded action, replay, mismatch)
 * is rejected with a generic reason.
 */
export function verifyApproval(
  pending: PendingAgentAction | null | undefined,
  approval: ApprovalMessage,
  live: {
    workspaceId: string;
    threadId: string;
    provider: string;
    generation: number;
    currentHashes: Record<string, string>;
  },
): ApprovalCheck {
  if (!pending || pending.used) {
    return { ok: false, error: 'That approval is no longer valid.' };
  }
  if (approval.actionId !== pending.actionId) {
    return { ok: false, error: 'That approval is no longer valid.' };
  }
  if (approval.digest !== pending.digest) {
    return { ok: false, error: 'That approval is no longer valid.' };
  }
  if (live.generation !== pending.generation) {
    return { ok: false, error: 'That approval was cancelled.' };
  }
  if (
    live.workspaceId !== pending.workspaceId ||
    live.threadId !== pending.threadId ||
    live.provider !== pending.provider
  ) {
    return { ok: false, error: 'That approval is no longer valid.' };
  }
  // Preconditions must still match: a changed file supersedes the action.
  for (const [path, hash] of Object.entries(pending.preconditions)) {
    if (live.currentHashes[path] !== hash) {
      return { ok: false, error: 'A file changed since approval; re-propose the action.' };
    }
  }
  // Recompute the digest to catch payload tampering after creation.
  const recomputed = computeActionDigest({
    tool: pending.tool,
    targets: pending.targets,
    body: pending.body,
    provider: pending.provider,
    workspaceId: pending.workspaceId,
    threadId: pending.threadId,
    preconditions: pending.preconditions,
  });
  if (recomputed !== pending.digest) {
    return { ok: false, error: 'That approval is no longer valid.' };
  }
  return { ok: true };
}

/** Parse an untrusted approve/reject payload with exact keys. */
export function parseApprovalMessage(raw: unknown): ApprovalMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid approval message.');
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !('actionId' in record) || !('digest' in record)) {
    throw new Error('Invalid approval message.');
  }
  if (
    typeof record.actionId !== 'string' ||
    record.actionId.length === 0 ||
    record.actionId.length > 128 ||
    typeof record.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.digest)
  ) {
    throw new Error('Invalid approval message.');
  }
  return { actionId: record.actionId, digest: record.digest };
}
