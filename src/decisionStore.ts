/**
 * Persistent, versioned project decisions controlled by the host.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Rules this store enforces:
 * - Memory is scoped per project (one canonical workspace root each).
 * - Every change is a new monotonic version that names the version it
 *   expected; a stale expectation is rejected (optimistic concurrency).
 *   History is append-only: older versions stay readable, never rewritten.
 * - Nothing is written from a model, a file, or a tool result. A write
 *   needs a proposal prepared here plus a host authorization for exactly
 *   that proposal (its id and digest, project, thread, provider). Each
 *   proposal can be committed once; consumed ids are persisted, so a
 *   replay is rejected even after a reload.
 * - Every version carries a digest chained to the previous one. A record
 *   that fails validation marks only its key unusable (fail closed) and is
 *   kept as stored, never silently overwritten. This detects accidental
 *   corruption; it is not protection against someone who can edit the
 *   extension state directly.
 * - Artifacts (files) are bound to one decision version with the file hash
 *   and a passing host-run test. When the decision changes, the binding
 *   reads as stale until the file is verified again against the new version.
 */

import { createHash, randomBytes } from 'node:crypto';

export const MEMORY_STATE_KEY = 'rameCode.memory.v1';
export const MEMORY_SCHEMA = 1;

export const MAX_SCOPES = 64;
export const MAX_KEYS_PER_SCOPE = 256;
export const MAX_VERSIONS_PER_KEY = 200;
export const MAX_ARTIFACTS_PER_SCOPE = 256;
export const MAX_CONSUMED_PROPOSALS = 2000;
export const MAX_DECISION_KEY_LENGTH = 128;
export const MAX_STRING_VALUE_LENGTH = 2000;
export const MAX_REASON_LENGTH = 300;
export const MAX_ARTIFACT_PATH_LENGTH = 512;
/** A prepared proposal that is not approved within this window expires. */
export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

/** Dotted lowercase key, e.g. `shipping.free_threshold_eur`. */
const KEY_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*){0,7}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^mem_[0-9a-f]{32}$/;

export type DecisionValue = string | number | boolean;
export type MemoryProviderId = 'cloud' | 'local' | 'none';

export interface DecisionProvenance {
  /** Who proposed the change: the user in the UI, or a model in an Agent run. */
  source: 'user' | 'model';
  provider: MemoryProviderId;
  threadId: string;
  /** Bounded, single-line reason shown in the approval and history. */
  reason: string;
  /**
   * For a model proposal: the user's own words it was taken from, checked
   * by the host against the messages the user typed (see decisionSource).
   */
  quote?: string;
}

export interface DecisionVersion {
  key: string;
  version: number;
  op: 'put' | 'delete';
  /** Null only for a delete. */
  value: DecisionValue | null;
  expectedVersion: number;
  provenance: DecisionProvenance;
  /** Only the user (through a host approval) ever authorizes a version. */
  actor: 'user';
  createdAt: number;
  proposalId: string;
  proposalDigest: string;
  approvalDigest: string;
  previousDigest: string | null;
  digest: string;
}

export interface ArtifactVerification {
  commandId: string;
  exitCode: 0;
  ranAt: number;
  /** SHA-256 of the test output, never the output itself. */
  resultDigest: string;
}

export interface ArtifactBinding {
  path: string;
  fileHash: string;
  decisionKey: string;
  decisionVersion: number;
  decisionDigest: string;
  verification: ArtifactVerification;
  provenance: DecisionProvenance;
  actor: 'user';
  boundAt: number;
  proposalId: string;
  approvalDigest: string;
}

export interface DecisionProposal {
  kind: 'decision';
  proposalId: string;
  scopeId: string;
  scopeLabel: string;
  key: string;
  op: 'put' | 'delete';
  value: DecisionValue | null;
  expectedVersion: number;
  newVersion: number;
  /** Value in force when the proposal was prepared (for the approval text). */
  previousValue: DecisionValue | null;
  provenance: DecisionProvenance;
  createdAt: number;
  digest: string;
}

export interface ArtifactProposal {
  kind: 'artifact';
  proposalId: string;
  scopeId: string;
  scopeLabel: string;
  path: string;
  fileHash: string;
  decisionKey: string;
  decisionVersion: number;
  decisionDigest: string;
  decisionValue: DecisionValue;
  verification: ArtifactVerification;
  provenance: DecisionProvenance;
  createdAt: number;
  digest: string;
}

export type MemoryProposal = DecisionProposal | ArtifactProposal;

/** Host-issued approval of one exact proposal (never built from model text). */
export interface MemoryAuthorization {
  proposalId: string;
  proposalDigest: string;
  scopeId: string;
  threadId: string;
  provider: MemoryProviderId;
  approvedBy: 'user';
  /** Digest of the host approval card the user confirmed. */
  approvalDigest: string;
  approvedAt: number;
}

export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Storage the store reads fresh before every operation (VS Code Memento shape). */
export interface MemoryBackend {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
  /**
   * Optional machine-wide exclusive section (see SharedJsonFileBackend):
   * when present, every commit's read-check-write runs inside it, so two
   * windows can never both commit against the same version.
   */
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
}

export interface CurrentDecision {
  key: string;
  version: number;
  value: DecisionValue;
  provenance: DecisionProvenance;
  createdAt: number;
  digest: string;
}

export type ArtifactStatus = 'current' | 'stale' | 'modified' | 'missing' | 'decision-removed' | 'unverified';

export interface ArtifactView extends ArtifactBinding {
  status: ArtifactStatus;
  /** Plain reason for anything other than `current`. */
  detail: string;
  currentDecisionVersion: number | null;
}

interface StoredScope {
  label: string;
  decisions: Record<string, unknown>;
  artifacts: unknown[];
}

interface StoredState {
  schema: number;
  scopes: Record<string, StoredScope>;
  consumed: unknown[];
}

/** Read result: what is usable plus what failed validation (kept, never used). */
export interface MemoryReadout {
  /** False when the stored blob itself is unreadable: writes are refused. */
  readable: boolean;
  current: CurrentDecision[];
  corruptKeys: string[];
  droppedArtifacts: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable project id for one canonical workspace root. */
export function scopeIdForRoot(canonicalRoot: string): string {
  return `ws_${sha256(`rame-scope:v1:${canonicalRoot}`).slice(0, 32)}`;
}

export function isDecisionKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_DECISION_KEY_LENGTH && KEY_PATTERN.test(value);
}

/** Strings are single-line-safe text; numbers finite; booleans as is. */
export function isDecisionValue(value: unknown): value is DecisionValue {
  if (typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= 1e15;
  }
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_STRING_VALUE_LENGTH &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
  );
}

function cleanReason(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}

function isProvenance(value: unknown): value is DecisionProvenance {
  return (
    isRecord(value) &&
    (value.source === 'user' || value.source === 'model') &&
    (value.provider === 'cloud' || value.provider === 'local' || value.provider === 'none') &&
    typeof value.threadId === 'string' &&
    value.threadId.length <= 128 &&
    typeof value.reason === 'string' &&
    value.reason.length <= MAX_REASON_LENGTH &&
    (value.quote === undefined || (typeof value.quote === 'string' && value.quote.length <= MAX_REASON_LENGTH))
  );
}

function provenanceCanonical(provenance: DecisionProvenance): Record<string, string> {
  const canonical: Record<string, string> = { source: provenance.source, provider: provenance.provider, threadId: provenance.threadId, reason: provenance.reason };
  // Only present when given, so versions stored before quotes existed keep their digests.
  if (provenance.quote !== undefined) {
    canonical.quote = provenance.quote;
  }
  return canonical;
}

function cleanProvenance(provenance: DecisionProvenance): DecisionProvenance {
  const clean: DecisionProvenance = { source: provenance.source, provider: provenance.provider, threadId: provenance.threadId, reason: cleanReason(provenance.reason) };
  if (provenance.quote !== undefined) {
    clean.quote = cleanReason(provenance.quote);
  }
  return clean;
}

/** Digest over one committed version, chained to the previous one. */
export function computeVersionDigest(scopeId: string, entry: Omit<DecisionVersion, 'digest'>): string {
  return sha256(
    JSON.stringify({
      scopeId,
      key: entry.key,
      version: entry.version,
      op: entry.op,
      value: entry.value,
      expectedVersion: entry.expectedVersion,
      provenance: provenanceCanonical(entry.provenance),
      actor: entry.actor,
      createdAt: entry.createdAt,
      proposalId: entry.proposalId,
      proposalDigest: entry.proposalDigest,
      approvalDigest: entry.approvalDigest,
      previousDigest: entry.previousDigest,
    }),
  );
}

/** Digest over the exact proposal the user is asked to approve. */
export function computeProposalDigest(proposal: Omit<DecisionProposal, 'digest'> | Omit<ArtifactProposal, 'digest'>): string {
  if (proposal.kind === 'decision') {
    return sha256(
      JSON.stringify({
        kind: proposal.kind,
        proposalId: proposal.proposalId,
        scopeId: proposal.scopeId,
        key: proposal.key,
        op: proposal.op,
        value: proposal.value,
        expectedVersion: proposal.expectedVersion,
        newVersion: proposal.newVersion,
        provenance: provenanceCanonical(proposal.provenance),
        createdAt: proposal.createdAt,
      }),
    );
  }
  return sha256(
    JSON.stringify({
      kind: proposal.kind,
      proposalId: proposal.proposalId,
      scopeId: proposal.scopeId,
      path: proposal.path,
      fileHash: proposal.fileHash,
      decisionKey: proposal.decisionKey,
      decisionVersion: proposal.decisionVersion,
      decisionDigest: proposal.decisionDigest,
      verification: proposal.verification,
      provenance: provenanceCanonical(proposal.provenance),
      createdAt: proposal.createdAt,
    }),
  );
}

function parseVersion(scopeId: string, key: string, raw: unknown, index: number, previousDigest: string | null): DecisionVersion | null {
  if (!isRecord(raw)) {
    return null;
  }
  const op = raw.op;
  const value = raw.value;
  if (
    raw.key !== key ||
    raw.version !== index + 1 ||
    (op !== 'put' && op !== 'delete') ||
    (op === 'put' && !isDecisionValue(value)) ||
    (op === 'delete' && value !== null) ||
    raw.expectedVersion !== index ||
    !isProvenance(raw.provenance) ||
    raw.actor !== 'user' ||
    typeof raw.createdAt !== 'number' ||
    !Number.isFinite(raw.createdAt) ||
    typeof raw.proposalId !== 'string' ||
    !ID_PATTERN.test(raw.proposalId) ||
    typeof raw.proposalDigest !== 'string' ||
    !SHA256_PATTERN.test(raw.proposalDigest) ||
    typeof raw.approvalDigest !== 'string' ||
    !SHA256_PATTERN.test(raw.approvalDigest) ||
    raw.previousDigest !== previousDigest ||
    typeof raw.digest !== 'string'
  ) {
    return null;
  }
  const entry: DecisionVersion = {
    key,
    version: index + 1,
    op,
    value: value as DecisionValue | null,
    expectedVersion: index,
    provenance: { ...(raw.provenance as DecisionProvenance) },
    actor: 'user',
    createdAt: raw.createdAt,
    proposalId: raw.proposalId,
    proposalDigest: raw.proposalDigest,
    approvalDigest: raw.approvalDigest,
    previousDigest,
    digest: raw.digest,
  };
  const { digest: _digest, ...rest } = entry;
  return computeVersionDigest(scopeId, rest) === entry.digest ? entry : null;
}

/** Validate one key's whole history; null when any version fails. */
function parseHistory(scopeId: string, key: string, raw: unknown): DecisionVersion[] | null {
  if (!isDecisionKey(key) || !Array.isArray(raw) || raw.length === 0 || raw.length > MAX_VERSIONS_PER_KEY) {
    return null;
  }
  const out: DecisionVersion[] = [];
  let previous: string | null = null;
  for (let index = 0; index < raw.length; index++) {
    const entry = parseVersion(scopeId, key, raw[index], index, previous);
    if (entry === null) {
      return null;
    }
    out.push(entry);
    previous = entry.digest;
  }
  return out;
}

function parseArtifact(raw: unknown): ArtifactBinding | null {
  if (!isRecord(raw)) {
    return null;
  }
  const v = raw.verification;
  if (
    typeof raw.path !== 'string' ||
    raw.path.length === 0 ||
    raw.path.length > MAX_ARTIFACT_PATH_LENGTH ||
    typeof raw.fileHash !== 'string' ||
    !SHA256_PATTERN.test(raw.fileHash) ||
    !isDecisionKey(raw.decisionKey) ||
    typeof raw.decisionVersion !== 'number' ||
    !Number.isInteger(raw.decisionVersion) ||
    raw.decisionVersion < 1 ||
    typeof raw.decisionDigest !== 'string' ||
    !SHA256_PATTERN.test(raw.decisionDigest) ||
    !isRecord(v) ||
    typeof v.commandId !== 'string' ||
    v.commandId.length === 0 ||
    v.commandId.length > 128 ||
    v.exitCode !== 0 ||
    typeof v.ranAt !== 'number' ||
    typeof v.resultDigest !== 'string' ||
    !SHA256_PATTERN.test(v.resultDigest) ||
    !isProvenance(raw.provenance) ||
    raw.actor !== 'user' ||
    typeof raw.boundAt !== 'number' ||
    typeof raw.proposalId !== 'string' ||
    !ID_PATTERN.test(raw.proposalId) ||
    typeof raw.approvalDigest !== 'string' ||
    !SHA256_PATTERN.test(raw.approvalDigest)
  ) {
    return null;
  }
  return {
    path: raw.path,
    fileHash: raw.fileHash,
    decisionKey: raw.decisionKey,
    decisionVersion: raw.decisionVersion,
    decisionDigest: raw.decisionDigest,
    verification: { commandId: v.commandId, exitCode: 0, ranAt: v.ranAt, resultDigest: v.resultDigest },
    provenance: { ...(raw.provenance as DecisionProvenance) },
    actor: 'user',
    boundAt: raw.boundAt,
    proposalId: raw.proposalId,
    approvalDigest: raw.approvalDigest,
  };
}

function emptyState(): StoredState {
  return { schema: MEMORY_SCHEMA, scopes: {}, consumed: [] };
}

/**
 * Host-side store over one backend. It keeps no copy of persisted data
 * between calls: every read and every commit starts from the backend, so a
 * second instance (another window, a reload) is always seen.
 */
export class DecisionStore {
  private readonly pending = new Map<string, MemoryProposal>();

  constructor(
    private readonly backend: MemoryBackend,
    private readonly now: () => number = Date.now,
  ) {}

  /** Raw state, or null when the stored blob is present but unreadable. */
  private readRaw(): StoredState | null {
    const raw = this.backend.get(MEMORY_STATE_KEY);
    if (raw === undefined || raw === null) {
      return emptyState();
    }
    if (
      !isRecord(raw) ||
      raw.schema !== MEMORY_SCHEMA ||
      !isRecord(raw.scopes) ||
      !Array.isArray(raw.consumed)
    ) {
      return null;
    }
    const scopes: Record<string, StoredScope> = {};
    for (const [scopeId, scope] of Object.entries(raw.scopes)) {
      if (!isRecord(scope) || !isRecord(scope.decisions) || !Array.isArray(scope.artifacts)) {
        return null;
      }
      scopes[scopeId] = {
        label: typeof scope.label === 'string' ? scope.label.slice(0, 128) : '',
        decisions: scope.decisions,
        artifacts: scope.artifacts,
      };
    }
    return { schema: MEMORY_SCHEMA, scopes, consumed: raw.consumed };
  }

  /** True when the stored memory can be read (and therefore written). */
  isReadable(): boolean {
    return this.readRaw() !== null;
  }

  private history(state: StoredState, scopeId: string, key: string): DecisionVersion[] | null | undefined {
    const raw = state.scopes[scopeId]?.decisions[key];
    if (raw === undefined) {
      return undefined;
    }
    return parseHistory(scopeId, key, raw);
  }

  /** Current (non-deleted) decisions of one project, plus corrupt keys. */
  readScope(scopeId: string): MemoryReadout {
    const state = this.readRaw();
    if (state === null) {
      return { readable: false, current: [], corruptKeys: [], droppedArtifacts: 0 };
    }
    const scope = state.scopes[scopeId];
    const current: CurrentDecision[] = [];
    const corruptKeys: string[] = [];
    if (scope) {
      for (const key of Object.keys(scope.decisions).sort()) {
        const history = parseHistory(scopeId, key, scope.decisions[key]);
        if (history === null) {
          corruptKeys.push(key.slice(0, MAX_DECISION_KEY_LENGTH));
          continue;
        }
        const last = history[history.length - 1] as DecisionVersion;
        if (last.op === 'put') {
          current.push({
            key,
            version: last.version,
            value: last.value as DecisionValue,
            provenance: { ...last.provenance },
            createdAt: last.createdAt,
            digest: last.digest,
          });
        }
      }
    }
    const droppedArtifacts = scope ? scope.artifacts.filter((entry) => parseArtifact(entry) === null).length : 0;
    return { readable: true, current, corruptKeys, droppedArtifacts };
  }

  listCurrentDecisions(scopeId: string): CurrentDecision[] {
    return this.readScope(scopeId).current;
  }

  /** The decision in force, or null (absent, deleted, or corrupt). */
  getDecision(scopeId: string, key: string): CurrentDecision | null {
    return this.listCurrentDecisions(scopeId).find((entry) => entry.key === key) ?? null;
  }

  /** Full history, oldest first; empty when absent or corrupt. */
  getDecisionHistory(scopeId: string, key: string): DecisionVersion[] {
    const state = this.readRaw();
    if (state === null) {
      return [];
    }
    return (this.history(state, scopeId, key) ?? []).map((entry) => ({ ...entry, provenance: { ...entry.provenance } }));
  }

  /** Latest version number of a key (0 when it never existed). */
  latestVersion(scopeId: string, key: string): number | null {
    const state = this.readRaw();
    if (state === null) {
      return null;
    }
    const history = this.history(state, scopeId, key);
    if (history === null) {
      return null;
    }
    return history === undefined ? 0 : history.length;
  }

  private newProposalId(): string {
    return `mem_${randomBytes(16).toString('hex')}`;
  }

  private checkWritable(state: StoredState | null, scopeId: string, key: string): MemoryResult<DecisionVersion[]> {
    if (state === null) {
      return { ok: false, error: 'Project memory could not be read, so RAME Code will not write to it.' };
    }
    const history = this.history(state, scopeId, key);
    if (history === null) {
      return { ok: false, error: `The stored history of ${key} failed validation; it is kept as is and cannot be changed.` };
    }
    const scope = state.scopes[scopeId];
    if (history === undefined && scope && Object.keys(scope.decisions).length >= MAX_KEYS_PER_SCOPE) {
      return { ok: false, error: `This project already has ${MAX_KEYS_PER_SCOPE} decisions.` };
    }
    if (!scope && Object.keys(state.scopes).length >= MAX_SCOPES) {
      return { ok: false, error: `Project memory already holds ${MAX_SCOPES} projects.` };
    }
    if (history !== undefined && history.length >= MAX_VERSIONS_PER_KEY) {
      return { ok: false, error: `${key} already has ${MAX_VERSIONS_PER_KEY} versions; its history is full.` };
    }
    return { ok: true, value: history ?? [] };
  }

  /**
   * Prepare (never commit) a new value. Rejected at once when the caller's
   * expected version is not the current one, so an old session cannot
   * even produce an approvable proposal for an outdated base.
   */
  preparePut(options: {
    scopeId: string;
    scopeLabel: string;
    key: string;
    value: unknown;
    expectedVersion: number;
    provenance: DecisionProvenance;
  }): MemoryResult<DecisionProposal> {
    return this.prepareDecision({ ...options, op: 'put' });
  }

  prepareDelete(options: {
    scopeId: string;
    scopeLabel: string;
    key: string;
    expectedVersion: number;
    provenance: DecisionProvenance;
  }): MemoryResult<DecisionProposal> {
    return this.prepareDecision({ ...options, value: null, op: 'delete' });
  }

  private prepareDecision(options: {
    scopeId: string;
    scopeLabel: string;
    key: string;
    value: unknown;
    expectedVersion: number;
    provenance: DecisionProvenance;
    op: 'put' | 'delete';
  }): MemoryResult<DecisionProposal> {
    if (!isDecisionKey(options.key)) {
      return { ok: false, error: 'The decision key must be lowercase dotted words, for example shipping.free_threshold_eur.' };
    }
    if (options.op === 'put' && !isDecisionValue(options.value)) {
      return { ok: false, error: `The value must be a number, true/false, or text of 1 to ${MAX_STRING_VALUE_LENGTH} characters.` };
    }
    if (!Number.isInteger(options.expectedVersion) || options.expectedVersion < 0) {
      return { ok: false, error: 'expectedVersion must be a whole number of 0 or more.' };
    }
    if (!isProvenance(cleanProvenance(options.provenance))) {
      return { ok: false, error: 'The proposal provenance is invalid.' };
    }
    const state = this.readRaw();
    const writable = this.checkWritable(state, options.scopeId, options.key);
    if (!writable.ok) {
      return writable;
    }
    const history = writable.value;
    const latest = history.length;
    if (options.expectedVersion !== latest) {
      return {
        ok: false,
        error: `${options.key} is at version ${latest}, not ${options.expectedVersion}. The proposal was based on an outdated version and was not prepared.`,
      };
    }
    const last = history[history.length - 1];
    const previousValue = last && last.op === 'put' ? (last.value as DecisionValue) : null;
    if (options.op === 'delete' && previousValue === null) {
      return { ok: false, error: `${options.key} has no value in force to delete.` };
    }
    if (options.op === 'put' && previousValue !== null && previousValue === options.value) {
      return { ok: false, error: `${options.key} is already ${JSON.stringify(previousValue)} at version ${latest}.` };
    }
    const body: Omit<DecisionProposal, 'digest'> = {
      kind: 'decision',
      proposalId: this.newProposalId(),
      scopeId: options.scopeId,
      scopeLabel: options.scopeLabel.slice(0, 128),
      key: options.key,
      op: options.op,
      value: options.op === 'put' ? (options.value as DecisionValue) : null,
      expectedVersion: latest,
      newVersion: latest + 1,
      previousValue,
      provenance: cleanProvenance(options.provenance),
      createdAt: this.now(),
    };
    const proposal: DecisionProposal = { ...body, digest: computeProposalDigest(body) };
    this.pending.set(proposal.proposalId, proposal);
    return { ok: true, value: { ...proposal, provenance: { ...proposal.provenance } } };
  }

  /**
   * Prepare an artifact binding. The caller (the host) supplies the file
   * hash it read and the passing test it ran itself; the binding must name
   * the decision version currently in force.
   */
  prepareArtifactBinding(options: {
    scopeId: string;
    scopeLabel: string;
    path: string;
    fileHash: string;
    decisionKey: string;
    decisionVersion: number;
    verification: ArtifactVerification;
    provenance: DecisionProvenance;
  }): MemoryResult<ArtifactProposal> {
    if (typeof options.path !== 'string' || options.path.length === 0 || options.path.length > MAX_ARTIFACT_PATH_LENGTH) {
      return { ok: false, error: 'The artifact path is invalid.' };
    }
    if (!SHA256_PATTERN.test(options.fileHash) || !SHA256_PATTERN.test(options.verification.resultDigest)) {
      return { ok: false, error: 'The artifact evidence is invalid.' };
    }
    if (options.verification.exitCode !== 0) {
      return { ok: false, error: 'Only a passing test can verify an artifact.' };
    }
    const state = this.readRaw();
    if (state === null) {
      return { ok: false, error: 'Project memory could not be read, so RAME Code will not write to it.' };
    }
    const history = this.history(state, options.scopeId, options.decisionKey);
    if (history === null) {
      return { ok: false, error: `The stored history of ${options.decisionKey} failed validation; nothing can be bound to it.` };
    }
    const last = history?.[history.length - 1];
    if (!last || last.op !== 'put') {
      return { ok: false, error: `${options.decisionKey} has no authorized value in this project.` };
    }
    if (options.decisionVersion !== last.version) {
      return {
        ok: false,
        error: `${options.decisionKey} is at version ${last.version}, not ${options.decisionVersion}; verify the file against the version in force.`,
      };
    }
    const scope = state.scopes[options.scopeId];
    const replacing = scope?.artifacts.some((entry) => {
      const parsed = parseArtifact(entry);
      return parsed !== null && parsed.path === options.path && parsed.decisionKey === options.decisionKey;
    });
    if (!replacing && scope && scope.artifacts.length >= MAX_ARTIFACTS_PER_SCOPE) {
      return { ok: false, error: `This project already has ${MAX_ARTIFACTS_PER_SCOPE} bound artifacts.` };
    }
    const body: Omit<ArtifactProposal, 'digest'> = {
      kind: 'artifact',
      proposalId: this.newProposalId(),
      scopeId: options.scopeId,
      scopeLabel: options.scopeLabel.slice(0, 128),
      path: options.path,
      fileHash: options.fileHash,
      decisionKey: options.decisionKey,
      decisionVersion: last.version,
      decisionDigest: last.digest,
      decisionValue: last.value as DecisionValue,
      verification: { ...options.verification },
      provenance: { ...options.provenance, reason: cleanReason(options.provenance.reason) },
      createdAt: this.now(),
    };
    const proposal: ArtifactProposal = { ...body, digest: computeProposalDigest(body) };
    this.pending.set(proposal.proposalId, proposal);
    return { ok: true, value: { ...proposal, provenance: { ...proposal.provenance }, verification: { ...proposal.verification } } };
  }

  /** A pending (prepared, not yet committed or discarded) proposal. */
  getPendingProposal(proposalId: string): MemoryProposal | null {
    const proposal = this.pending.get(proposalId);
    return proposal ? { ...proposal } : null;
  }

  /** Pending proposals of one project, oldest first (copies). */
  listPendingProposals(scopeId: string): MemoryProposal[] {
    return [...this.pending.values()]
      .filter((proposal) => proposal.scopeId === scopeId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((proposal) => ({ ...proposal }));
  }

  /** Discard pending proposals (cancellation, rejection, end of run). */
  discardProposals(filter: { proposalId?: string; threadId?: string } = {}): number {
    let count = 0;
    for (const [id, proposal] of this.pending) {
      if (
        (filter.proposalId === undefined || filter.proposalId === id) &&
        (filter.threadId === undefined || filter.threadId === proposal.provenance.threadId)
      ) {
        this.pending.delete(id);
        count += 1;
      }
    }
    return count;
  }

  private verifyAuthorization(authorization: MemoryAuthorization, state: StoredState): MemoryResult<MemoryProposal> {
    const proposal = this.pending.get(authorization.proposalId);
    const consumed = state.consumed.includes(authorization.proposalId);
    if (consumed) {
      return { ok: false, error: 'That authorization was already used.' };
    }
    if (!proposal) {
      return { ok: false, error: 'That authorization does not match a pending proposal.' };
    }
    if (authorization.approvedBy !== 'user' || !SHA256_PATTERN.test(authorization.approvalDigest)) {
      return { ok: false, error: 'Only a host approval can authorize a memory change.' };
    }
    const { digest, ...body } = proposal;
    if (authorization.proposalDigest !== digest || computeProposalDigest(body) !== digest) {
      return { ok: false, error: 'The authorization does not match the exact proposal.' };
    }
    if (
      authorization.scopeId !== proposal.scopeId ||
      authorization.threadId !== proposal.provenance.threadId ||
      authorization.provider !== proposal.provenance.provider
    ) {
      return { ok: false, error: 'The authorization belongs to another project, thread, or provider.' };
    }
    if (this.now() - proposal.createdAt > PROPOSAL_TTL_MS) {
      this.pending.delete(proposal.proposalId);
      return { ok: false, error: 'The proposal expired before it was approved; propose it again.' };
    }
    return { ok: true, value: proposal };
  }

  private consumedWith(state: StoredState, proposalId: string): unknown[] {
    const consumed = state.consumed.filter((entry) => typeof entry === 'string' && ID_PATTERN.test(entry));
    consumed.push(proposalId);
    return consumed.slice(-MAX_CONSUMED_PROPOSALS);
  }

  /**
   * Commit one authorized proposal. Re-reads the backend first, so a change
   * committed meanwhile by another instance makes this one stale. The
   * proposal is consumed whether the commit succeeds or is rejected for a
   * stale version, so the same authorization can never be retried.
   */
  async commitAuthorizedChange(authorization: MemoryAuthorization): Promise<MemoryResult<DecisionVersion | ArtifactBinding>> {
    return this.locked(() => this.commitUnlocked(authorization));
  }

  /** Run a commit inside the backend's exclusive section, when it has one. */
  private async locked<T>(work: () => Promise<MemoryResult<T>>): Promise<MemoryResult<T>> {
    if (!this.backend.exclusive) {
      return work();
    }
    try {
      return await this.backend.exclusive(work);
    } catch (error) {
      // The lock was not obtained: nothing was read, written, or consumed.
      return { ok: false, error: error instanceof Error ? error.message : 'Project memory is busy; try again.' };
    }
  }

  private async commitUnlocked(authorization: MemoryAuthorization): Promise<MemoryResult<DecisionVersion | ArtifactBinding>> {
    const state = this.readRaw();
    if (state === null) {
      return { ok: false, error: 'Project memory could not be read, so RAME Code will not write to it.' };
    }
    const verified = this.verifyAuthorization(authorization, state);
    if (!verified.ok) {
      return verified;
    }
    const proposal = verified.value;
    this.pending.delete(proposal.proposalId);
    if (proposal.kind === 'artifact') {
      return this.commitArtifact(proposal, authorization, state);
    }
    const writable = this.checkWritable(state, proposal.scopeId, proposal.key);
    if (!writable.ok) {
      await this.persistConsumed(state, proposal.proposalId);
      return writable;
    }
    const history = writable.value;
    if (history.length !== proposal.expectedVersion) {
      await this.persistConsumed(state, proposal.proposalId);
      return {
        ok: false,
        error: `${proposal.key} changed to version ${history.length} after this proposal was prepared for version ${proposal.expectedVersion}. Nothing was written.`,
      };
    }
    const base: Omit<DecisionVersion, 'digest'> = {
      key: proposal.key,
      version: proposal.newVersion,
      op: proposal.op,
      value: proposal.value,
      expectedVersion: proposal.expectedVersion,
      provenance: { ...proposal.provenance },
      actor: 'user',
      createdAt: this.now(),
      proposalId: proposal.proposalId,
      proposalDigest: proposal.digest,
      approvalDigest: authorization.approvalDigest,
      previousDigest: history.length > 0 ? (history[history.length - 1] as DecisionVersion).digest : null,
    };
    const entry: DecisionVersion = { ...base, digest: computeVersionDigest(proposal.scopeId, base) };
    const scope = state.scopes[proposal.scopeId] ?? { label: proposal.scopeLabel, decisions: {}, artifacts: [] };
    const rawHistory = Array.isArray(scope.decisions[proposal.key]) ? (scope.decisions[proposal.key] as unknown[]) : [];
    const next: StoredState = {
      schema: MEMORY_SCHEMA,
      scopes: {
        ...state.scopes,
        [proposal.scopeId]: {
          label: proposal.scopeLabel || scope.label,
          decisions: { ...scope.decisions, [proposal.key]: [...rawHistory, entry] },
          artifacts: scope.artifacts,
        },
      },
      consumed: this.consumedWith(state, proposal.proposalId),
    };
    await this.backend.update(MEMORY_STATE_KEY, next);
    return { ok: true, value: { ...entry, provenance: { ...entry.provenance } } };
  }

  private async commitArtifact(
    proposal: ArtifactProposal,
    authorization: MemoryAuthorization,
    state: StoredState,
  ): Promise<MemoryResult<ArtifactBinding>> {
    const history = this.history(state, proposal.scopeId, proposal.decisionKey);
    const last = history?.[history.length - 1];
    if (!history || !last || last.op !== 'put' || last.version !== proposal.decisionVersion || last.digest !== proposal.decisionDigest) {
      await this.persistConsumed(state, proposal.proposalId);
      return {
        ok: false,
        error: `${proposal.decisionKey} is no longer at version ${proposal.decisionVersion}; the artifact was not bound.`,
      };
    }
    const binding: ArtifactBinding = {
      path: proposal.path,
      fileHash: proposal.fileHash,
      decisionKey: proposal.decisionKey,
      decisionVersion: proposal.decisionVersion,
      decisionDigest: proposal.decisionDigest,
      verification: { ...proposal.verification },
      provenance: { ...proposal.provenance },
      actor: 'user',
      boundAt: this.now(),
      proposalId: proposal.proposalId,
      approvalDigest: authorization.approvalDigest,
    };
    const scope = state.scopes[proposal.scopeId] ?? { label: proposal.scopeLabel, decisions: {}, artifacts: [] };
    // The newest binding for one (path, decision) replaces the older one;
    // unreadable entries are kept untouched rather than silently dropped.
    const artifacts = scope.artifacts.filter((entry) => {
      const parsed = parseArtifact(entry);
      return parsed === null || parsed.path !== binding.path || parsed.decisionKey !== binding.decisionKey;
    });
    artifacts.push(binding);
    const next: StoredState = {
      schema: MEMORY_SCHEMA,
      scopes: { ...state.scopes, [proposal.scopeId]: { label: scope.label || proposal.scopeLabel, decisions: scope.decisions, artifacts } },
      consumed: this.consumedWith(state, proposal.proposalId),
    };
    await this.backend.update(MEMORY_STATE_KEY, next);
    return { ok: true, value: { ...binding } };
  }

  private async persistConsumed(state: StoredState, proposalId: string): Promise<void> {
    await this.backend.update(MEMORY_STATE_KEY, { ...state, consumed: this.consumedWith(state, proposalId) });
  }

  /** Every readable binding of a project (unreadable ones are counted, not shown). */
  listArtifacts(scopeId: string): ArtifactBinding[] {
    const state = this.readRaw();
    if (state === null) {
      return [];
    }
    return (state.scopes[scopeId]?.artifacts ?? [])
      .map((entry) => parseArtifact(entry))
      .filter((entry): entry is ArtifactBinding => entry !== null);
  }

  /**
   * Bindings with their status. `liveHashes` maps a path to the hash the
   * host read now (or `null` when the file is missing); a path without an
   * entry reads as `unverified`.
   */
  artifactStatuses(scopeId: string, liveHashes: Record<string, string | null>): ArtifactView[] {
    const state = this.readRaw();
    if (state === null) {
      return [];
    }
    return this.listArtifacts(scopeId).map((binding) => {
      const history = this.history(state, scopeId, binding.decisionKey);
      const last = history ? history[history.length - 1] : undefined;
      const currentDecisionVersion = last && last.op === 'put' ? last.version : null;
      let status: ArtifactStatus = 'current';
      let detail = `Verified against ${binding.decisionKey} v${binding.decisionVersion} by ${binding.verification.commandId}.`;
      if (history === null) {
        status = 'decision-removed';
        detail = `The history of ${binding.decisionKey} failed validation.`;
      } else if (!last || last.op === 'delete') {
        status = 'decision-removed';
        detail = `${binding.decisionKey} has no value in force any more.`;
      } else if (last.version !== binding.decisionVersion || last.digest !== binding.decisionDigest) {
        status = 'stale';
        detail = `Verified against v${binding.decisionVersion}, but ${binding.decisionKey} is now v${last.version}.`;
      } else if (!(binding.path in liveHashes)) {
        status = 'unverified';
        detail = 'The file was not checked.';
      } else if (liveHashes[binding.path] === null) {
        status = 'missing';
        detail = 'The file no longer exists.';
      } else if (liveHashes[binding.path] !== binding.fileHash) {
        status = 'modified';
        detail = 'The file changed after it was verified.';
      }
      return { ...binding, status, detail, currentDecisionVersion };
    });
  }

  /** Bindings that are not `current`. */
  listStaleArtifacts(scopeId: string, liveHashes: Record<string, string | null>): ArtifactView[] {
    return this.artifactStatuses(scopeId, liveHashes).filter((entry) => entry.status !== 'current');
  }
}

/** Plain-language description of a proposal for the approval card. */
export function describeProposal(proposal: MemoryProposal): string {
  const who =
    proposal.provenance.source === 'user'
      ? 'you (Settings)'
      : `the ${proposal.provenance.provider === 'cloud' ? 'Meta cloud' : 'local'} model`;
  // Quoted so a proposer's reason cannot pass for part of the change itself.
  const reason = proposal.provenance.reason.length > 0 ? ` Reason given: ${JSON.stringify(proposal.provenance.reason)}` : '';
  // The user's own words the host found in the conversation (model proposals).
  const quote = proposal.provenance.quote !== undefined ? ` Your words: ${JSON.stringify(proposal.provenance.quote)}.` : '';
  if (proposal.kind === 'decision') {
    const before = proposal.previousValue === null ? 'not set' : JSON.stringify(proposal.previousValue);
    const change =
      proposal.op === 'delete'
        ? `Remove ${proposal.key} (now ${before}, v${proposal.expectedVersion}).`
        : `Set ${proposal.key} from ${before} (v${proposal.expectedVersion}) to ${JSON.stringify(proposal.value)} (v${proposal.newVersion}).`;
    return `${change} Project: ${proposal.scopeLabel}. Proposed by ${who}.${quote}${reason}`;
  }
  return (
    `Mark ${proposal.path} (sha256 ${proposal.fileHash.slice(0, 12)}…) as verified against ` +
    `${proposal.decisionKey} v${proposal.decisionVersion} = ${JSON.stringify(proposal.decisionValue)}, ` +
    `checked by ${proposal.verification.commandId} exit 0. Project: ${proposal.scopeLabel}. Proposed by ${who}.${reason}`
  );
}
