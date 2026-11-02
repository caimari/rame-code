/**
 * Bounded append-only local action audit for Agent mode.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * Each entry carries timestamps, provider, thread, profile, action digest,
 * decision source, and a short verified result. Content and secrets are
 * never stored: only digests and bounded result summaries. Tamper-proofness
 * is not claimed; the log is a local convenience record with a hard bound.
 */

import { MAX_AUDIT_ENTRIES } from './agentPolicy.js';
import type { AgentProfileId } from './agentProfiles.js';

export type AuditDecision = 'human' | 'profile-auto' | 'rejected' | 'policy';

export interface AuditEntry {
  seq: number;
  at: string;
  provider: string;
  threadId: string;
  profile: AgentProfileId;
  tool: string;
  digest: string;
  decision: AuditDecision;
  result: string;
}

const MAX_RESULT_CHARS = 256;
const MAX_THREAD_CHARS = 128;

function sanitizeToken(value: string, max: number): string {
  const trimmed = value.trim().slice(0, max);
  // Strip control characters and never echo key-like material verbatim.
  return trimmed.replace(/[\0-\x1f\x7f]/g, '');
}

function looksLikeSecret(text: string): boolean {
  return /sk-[A-Za-z0-9]{8,}|bearer\s+[A-Za-z0-9._~+/-]{8,}|api[_-]?key\s*[:=]/i.test(text);
}

/** Redact a result summary: bound length, strip controls, drop secrets. */
export function redactAuditResult(text: string): string {
  if (looksLikeSecret(text)) {
    return '[redacted]';
  }
  return sanitizeToken(text, MAX_RESULT_CHARS);
}

export class AgentAuditLog {
  private entries: AuditEntry[] = [];
  private nextSeq = 1;
  private readonly bound: number;

  constructor(bound: number = MAX_AUDIT_ENTRIES) {
    this.bound = Math.max(1, Math.min(1000, Math.floor(bound)));
  }

  get length(): number {
    return this.entries.length;
  }

  append(input: {
    provider: string;
    threadId: string;
    profile: AgentProfileId;
    tool: string;
    digest: string;
    decision: AuditDecision;
    result: string;
    at?: string;
  }): AuditEntry {
    const entry: AuditEntry = {
      seq: this.nextSeq++,
      at: input.at ?? new Date().toISOString(),
      provider: sanitizeToken(input.provider, 16),
      threadId: sanitizeToken(input.threadId, MAX_THREAD_CHARS),
      profile: input.profile,
      tool: sanitizeToken(input.tool, 32),
      digest: /^[0-9a-f]{64}$/.test(input.digest) ? input.digest : '0'.repeat(64),
      decision: input.decision,
      result: redactAuditResult(input.result),
    };
    this.entries.push(entry);
    while (this.entries.length > this.bound) {
      this.entries.shift();
    }
    return entry;
  }

  list(): AuditEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  /** Validate untrusted persisted entries; invalid rows are dropped. */
  load(raw: unknown): void {
    this.entries = [];
    if (!Array.isArray(raw)) {
      return;
    }
    for (const item of raw.slice(-this.bound)) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (
        typeof record.at !== 'string' ||
        typeof record.provider !== 'string' ||
        typeof record.threadId !== 'string' ||
        (record.profile !== 'ask' && record.profile !== 'safe-auto' && record.profile !== 'workspace-full') ||
        typeof record.tool !== 'string' ||
        typeof record.digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(record.digest) ||
        (record.decision !== 'human' && record.decision !== 'profile-auto' && record.decision !== 'rejected' && record.decision !== 'policy') ||
        typeof record.result !== 'string' ||
        typeof record.seq !== 'number'
      ) {
        continue;
      }
      this.entries.push({
        seq: Math.floor(record.seq as number),
        at: (record.at as string).slice(0, 32),
        provider: sanitizeToken(record.provider as string, 16),
        threadId: sanitizeToken(record.threadId as string, MAX_THREAD_CHARS),
        profile: record.profile as AgentProfileId,
        tool: sanitizeToken(record.tool as string, 32),
        digest: record.digest as string,
        decision: record.decision as AuditDecision,
        result: redactAuditResult(record.result as string),
      });
    }
    const maxSeq = this.entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    this.nextSeq = maxSeq + 1;
  }
}
