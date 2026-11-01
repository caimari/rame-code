/**
 * Local thread persistence for the RAME Code Chats view.
 *
 * This module is free of the `vscode` API so it can be unit tested with
 * plain `node:test`. The extension host adapts `ExtensionContext.globalState`
 * to the structural {@link ThreadMemento} interface; tests use an in-memory
 * fake with the same shape.
 *
 * Storage contract:
 * - Persisted under the versioned key {@link THREAD_STORE_KEY}.
 * - A thread record contains only an id, a derived title, timestamps, locally
 *   stored user mission text, validated assistant plans, and generic local
 *   error notes. It never contains an API key.
 * - History is bounded to {@link MAX_THREADS} threads (most recently updated
 *   first). Untrusted stored data is validated and migrated: invalid threads
 *   are dropped, a missing title is re-derived, and extra fields (including
 *   any `apiKey`) cause the record to be rejected.
 */

import { isValidHostRecord } from './hostRecord.js';
import { validateMissionPlan } from './meta-provider.js';
import type { MissionPlan } from './types.js';

export const THREAD_STORE_KEY = 'rameCode.threads.v1';
export const MAX_THREADS = 50;
export const MAX_TITLE_LENGTH = 60;
export const MAX_USER_TEXT_LENGTH = 8000;
export const MAX_ASSISTANT_TEXT_LENGTH = MAX_USER_TEXT_LENGTH;
export const MAX_ERROR_MESSAGE_LENGTH = 2000;

const TRUNCATION_MARKER = '\n…[truncated to fit thread storage]';

/**
 * Bound turn text at write time to the same limits the loader enforces: a
 * longer turn would otherwise be dropped silently on the next load.
 */
export function fitTurnText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
}

export interface UserTurn {
  kind: 'user';
  text: string;
  timestamp: number;
}

export interface PlanTurn {
  kind: 'plan';
  plan: MissionPlan;
  timestamp: number;
}

export interface AssistantTurn {
  kind: 'assistant';
  text: string;
  timestamp: number;
  /**
   * Agent runs only: actions RAME Code verified, kept apart from the
   * model's text so the webview can show them as host-written.
   */
  hostRecord?: string[];
}

export interface ErrorTurn {
  kind: 'error';
  message: string;
  timestamp: number;
}

export type ThreadTurn = UserTurn | PlanTurn | AssistantTurn | ErrorTurn;

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ThreadTurn[];
}

/** Minimal structural shape of the VS Code global-state API we need. */
export interface ThreadMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(record);
  if (keys.length !== allowed.length) {
    return false;
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return false;
    }
  }
  return true;
}

function isValidId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 4102444800000
  );
}

/**
 * Derive a short human-readable title from mission text: the first
 * non-empty line, whitespace-collapsed, bounded to {@link MAX_TITLE_LENGTH}.
 * Falls back to `'New thread'` for empty input.
 */
export function deriveTitle(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return 'New thread';
  }
  const collapsed = firstLine.replace(/\s+/g, ' ');
  if (collapsed.length <= MAX_TITLE_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function validateUserTurn(value: unknown): UserTurn | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'text', 'timestamp'])) {
    return null;
  }
  if (value.kind !== 'user') {
    return null;
  }
  if (
    typeof value.text !== 'string' ||
    value.text.trim().length === 0 ||
    value.text.length > MAX_USER_TEXT_LENGTH
  ) {
    return null;
  }
  if (!isValidTimestamp(value.timestamp)) {
    return null;
  }
  return { kind: 'user', text: value.text, timestamp: value.timestamp };
}

function validatePlanTurn(value: unknown): PlanTurn | null {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'plan', 'timestamp'])) {
    return null;
  }
  if (value.kind !== 'plan') {
    return null;
  }
  if (!isValidTimestamp(value.timestamp)) {
    return null;
  }
  try {
    const plan = validateMissionPlan(value.plan);
    return { kind: 'plan', plan, timestamp: value.timestamp };
  } catch {
    return null;
  }
}

function validateErrorTurn(value: unknown): ErrorTurn | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'message', 'timestamp'])
  ) {
    return null;
  }
  if (value.kind !== 'error') {
    return null;
  }
  if (
    typeof value.message !== 'string' ||
    value.message.trim().length === 0 ||
    value.message.length > MAX_ERROR_MESSAGE_LENGTH
  ) {
    return null;
  }
  if (!isValidTimestamp(value.timestamp)) {
    return null;
  }
  return { kind: 'error', message: value.message, timestamp: value.timestamp };
}

function validateAssistantTurn(value: unknown): AssistantTurn | null {
  if (
    !isRecord(value) ||
    !(
      hasExactKeys(value, ['kind', 'text', 'timestamp']) ||
      hasExactKeys(value, ['kind', 'text', 'timestamp', 'hostRecord'])
    )
  ) {
    return null;
  }
  if ('hostRecord' in value && !isValidHostRecord(value.hostRecord)) {
    return null;
  }
  if (value.kind !== 'assistant') {
    return null;
  }
  if (
    typeof value.text !== 'string' ||
    value.text.trim().length === 0 ||
    value.text.length > MAX_ASSISTANT_TEXT_LENGTH
  ) {
    return null;
  }
  if (!isValidTimestamp(value.timestamp)) {
    return null;
  }
  return 'hostRecord' in value
    ? { kind: 'assistant', text: value.text, timestamp: value.timestamp, hostRecord: [...(value.hostRecord as string[])] }
    : { kind: 'assistant', text: value.text, timestamp: value.timestamp };
}

function validateTurn(value: unknown): ThreadTurn | null {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return null;
  }
  switch (value.kind) {
    case 'user':
      return validateUserTurn(value);
    case 'plan':
      return validatePlanTurn(value);
    case 'assistant':
      return validateAssistantTurn(value);
    case 'error':
      return validateErrorTurn(value);
    default:
      return null;
  }
}

function firstUserText(turns: ThreadTurn[]): string | null {
  for (const turn of turns) {
    if (turn.kind === 'user') {
      return turn.text;
    }
  }
  return null;
}

/**
 * Validate one untrusted stored thread record. Extra fields — including any
 * `apiKey` — reject the record. A missing or blank title is migrated by
 * re-deriving it from the first user turn. Returns `null` when the record
 * cannot be salvaged.
 */
export function validateThreadRecord(value: unknown): ChatThread | null {
  if (!isRecord(value)) {
    return null;
  }
  const hasTitle = Object.prototype.hasOwnProperty.call(value, 'title');
  const allowed = hasTitle
    ? ['id', 'title', 'createdAt', 'updatedAt', 'turns']
    : ['id', 'createdAt', 'updatedAt', 'turns'];
  if (!hasExactKeys(value, allowed)) {
    return null;
  }
  if (!isValidId(value.id)) {
    return null;
  }
  if (!isValidTimestamp(value.createdAt) || !isValidTimestamp(value.updatedAt)) {
    return null;
  }
  if (!Array.isArray(value.turns) || value.turns.length === 0) {
    return null;
  }
  const turns: ThreadTurn[] = [];
  for (const raw of value.turns) {
    const turn = validateTurn(raw);
    if (turn !== null) {
      turns.push(turn);
    }
  }
  if (turns.length === 0) {
    return null;
  }
  let title = 'New thread';
  if (hasTitle) {
    if (typeof value.title !== 'string') {
      return null;
    }
    title =
      value.title.trim().length > 0
        ? value.title.slice(0, MAX_TITLE_LENGTH)
        : deriveTitle(firstUserText(turns) ?? '');
  } else {
    title = deriveTitle(firstUserText(turns) ?? '');
  }
  return {
    id: value.id,
    title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    turns,
  };
}

/**
 * Validate untrusted persisted state into a bounded, most-recent-first
 * thread list. Accepts either a bare array (the documented shape under the
 * versioned key) or `{ threads: [...] }`. Drops invalid records, sorts by
 * `updatedAt` descending, and keeps at most {@link MAX_THREADS}.
 */
export function loadThreads(raw: unknown): ChatThread[] {
  const candidates: unknown[] = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.threads)
      ? (raw.threads as unknown[])
      : [];
  const valid: ChatThread[] = [];
  for (const candidate of candidates) {
    const thread = validateThreadRecord(candidate);
    if (thread !== null) {
      valid.push(thread);
    }
  }
  valid.sort((a, b) => b.updatedAt - a.updatedAt);
  return valid.slice(0, MAX_THREADS);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

/** Create a new thread whose first turn is the submitted mission text. */
export function createThread(
  missionText: string,
  options?: { now?: number; id?: string },
): ChatThread {
  const now = options?.now ?? Date.now();
  const id = options?.id ?? `t-${now.toString(36)}-${randomSuffix()}`;
  const text = missionText.trim();
  return {
    id,
    title: deriveTitle(text),
    createdAt: now,
    updatedAt: now,
    turns: [{ kind: 'user', text, timestamp: now }],
  };
}

/** Append a validated user turn, returning a new thread record. */
export function appendUserTurn(
  thread: ChatThread,
  text: string,
  now?: number,
): ChatThread {
  const timestamp = now ?? Date.now();
  return {
    ...thread,
    updatedAt: timestamp,
    turns: [...thread.turns, { kind: 'user', text, timestamp }],
  };
}

/** Append a validated assistant plan, returning a new thread record. */
export function appendPlanTurn(
  thread: ChatThread,
  plan: MissionPlan,
  now?: number,
): ChatThread {
  const timestamp = now ?? Date.now();
  return {
    ...thread,
    updatedAt: timestamp,
    turns: [...thread.turns, { kind: 'plan', plan, timestamp }],
  };
}

/**
 * Append a conversational assistant reply, returning a new thread record.
 * `hostRecord` (Agent runs) is stored beside the text, never inside it.
 */
export function appendAssistantTurn(
  thread: ChatThread,
  text: string,
  now?: number,
  hostRecord?: string[],
): ChatThread {
  const timestamp = now ?? Date.now();
  const turn: AssistantTurn = { kind: 'assistant', text: fitTurnText(text, MAX_ASSISTANT_TEXT_LENGTH), timestamp };
  if (hostRecord !== undefined) {
    if (!isValidHostRecord(hostRecord)) {
      throw new Error('Invalid host record.');
    }
    turn.hostRecord = [...hostRecord];
  }
  return {
    ...thread,
    updatedAt: timestamp,
    turns: [...thread.turns, turn],
  };
}

/** Append a generic local error note, returning a new thread record. */
export function appendErrorTurn(
  thread: ChatThread,
  message: string,
  now?: number,
): ChatThread {
  const timestamp = now ?? Date.now();
  return {
    ...thread,
    updatedAt: timestamp,
    turns: [...thread.turns, { kind: 'error', message: fitTurnText(message, MAX_ERROR_MESSAGE_LENGTH), timestamp }],
  };
}

/**
 * Insert or replace a thread, keeping the list most-recent-first and bounded
 * to {@link MAX_THREADS}.
 */
export function upsertThread(
  threads: ChatThread[],
  thread: ChatThread,
): ChatThread[] {
  const rest = threads.filter((entry) => entry.id !== thread.id);
  return [thread, ...rest]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_THREADS);
}

/**
 * Small persistence wrapper shared by the Chats view and palette commands.
 * All reads go through {@link loadThreads}, so corrupt or hostile stored
 * data can never produce an invalid in-memory thread.
 */
export class ThreadStore {
  private threads: ChatThread[] = [];

  constructor(
    private readonly storage: ThreadMemento,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Load (and repair) persisted threads into memory. */
  load(): ChatThread[] {
    this.threads = loadThreads(this.storage.get(THREAD_STORE_KEY));
    return this.list();
  }

  list(): ChatThread[] {
    return [...this.threads];
  }

  get(id: string): ChatThread | undefined {
    return this.threads.find((thread) => thread.id === id);
  }

  /** Create, persist, and return a new thread for the given mission text. */
  create(missionText: string): ChatThread {
    const now = this.clock();
    const thread = createThread(missionText, { now });
    this.threads = upsertThread(this.threads, thread);
    this.persist();
    return thread;
  }

  /** Replace a thread (after appending turns) and persist the list. */
  save(thread: ChatThread): ChatThread[] {
    this.threads = upsertThread(this.threads, thread);
    this.persist();
    return this.list();
  }

  /** Delete exactly one stored thread by id. Returns false when absent. */
  delete(id: string): boolean {
    const next = this.threads.filter((thread) => thread.id !== id);
    if (next.length === this.threads.length) {
      return false;
    }
    this.threads = next;
    this.persist();
    return true;
  }

  private persist(): void {
    void this.storage.update(THREAD_STORE_KEY, this.threads);
  }
}
