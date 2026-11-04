/**
 * Recovered-context log: which earlier turns RAME recovered for a request,
 * and why, kept apart from the host record and from a Mission's evidence (so
 * their first lines are never displaced).
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * Each event holds references only: turn positions, roles, times, the kind of
 * match, and the sha256 of the exact stored text each excerpt was read from
 * (recompute it from the thread to check). It never stores the excerpts, the
 * query, a prompt, or a reply: the query is kept as a hash. Versioned,
 * validated on load, bounded per thread; an unreadable thread entry is
 * dropped whole, and nothing in it is ever replayed.
 */

import { createHash } from 'node:crypto';

export const CONTINUITY_LOG_KEY = 'rameCode.continuityLog.v1';
export const MAX_LOG_THREADS = 30;
export const MAX_EVENTS_PER_THREAD = 60;
export const MAX_EVENT_SOURCES = 6;
export const MAX_EVENTS_SHOWN = 20;

export type RecoveryTrigger = 'automatic' | 'search_history';
export type RecoveryMode = 'chat' | 'agent' | 'mission-plan' | 'mission-run';
const MATCHES = ['lexical-exact', 'lexical-morphological', 'lexical-expanded', 'lexical-objective', 'semantic', 'hybrid'] as const;
export type RecoveryMatch = (typeof MATCHES)[number];

export interface RecoveredSource {
  turn: number;
  role: 'user' | 'assistant' | 'plan';
  at: number;
  match: RecoveryMatch;
  /** sha256 of the exact stored text the excerpt was read from (before clipping). */
  sha256: string;
}

export interface RecoveryEvent {
  seq: number;
  at: number;
  trigger: RecoveryTrigger;
  mode: RecoveryMode;
  provider: 'local' | 'cloud';
  model: string;
  mission: { missionId: string; run: number | null } | null;
  querySha256: string;
  sources: RecoveredSource[];
  /** Local-session messages not shared with Meta for this request. */
  withheldLocal: number;
}

interface ThreadLog {
  threadId: string;
  nextSeq: number;
  events: RecoveryEvent[];
}

export interface ContinuityLogState {
  version: 1;
  threads: ThreadLog[];
}

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const HEX = /^[0-9a-f]{64}$/;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join() === expected;
}

function count(value: unknown, max = 1_000_000_000): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function time(value: unknown): value is number {
  return count(value, 8_640_000_000_000_000);
}

function validSource(value: unknown): value is RecoveredSource {
  return (
    isRecord(value) &&
    keys(value, 'at,match,role,sha256,turn') &&
    count(value.turn, 1_000_000) &&
    (value.role === 'user' || value.role === 'assistant' || value.role === 'plan') &&
    time(value.at) &&
    (MATCHES as readonly unknown[]).includes(value.match) &&
    typeof value.sha256 === 'string' &&
    HEX.test(value.sha256)
  );
}

export function isValidRecoveryEvent(value: unknown): value is RecoveryEvent {
  if (!isRecord(value) || !keys(value, 'at,mission,mode,model,provider,querySha256,seq,sources,trigger,withheldLocal')) {
    return false;
  }
  const mission = value.mission;
  return (
    count(value.seq) &&
    value.seq >= 1 &&
    time(value.at) &&
    (value.trigger === 'automatic' || value.trigger === 'search_history') &&
    ['chat', 'agent', 'mission-plan', 'mission-run'].includes(value.mode as string) &&
    (value.provider === 'local' || value.provider === 'cloud') &&
    typeof value.model === 'string' &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._:/@+()-]{0,127}$/u.test(value.model) &&
    (mission === null ||
      (isRecord(mission) && keys(mission, 'missionId,run') && typeof mission.missionId === 'string' && ID.test(mission.missionId) && (mission.run === null || count(mission.run, 100_000)))) &&
    typeof value.querySha256 === 'string' &&
    HEX.test(value.querySha256) &&
    Array.isArray(value.sources) &&
    value.sources.length <= MAX_EVENT_SOURCES &&
    value.sources.every(validSource) &&
    count(value.withheldLocal, 1_000_000)
  );
}

function validThread(value: unknown): value is ThreadLog {
  return (
    isRecord(value) &&
    keys(value, 'events,nextSeq,threadId') &&
    typeof value.threadId === 'string' &&
    ID.test(value.threadId) &&
    count(value.nextSeq) &&
    Array.isArray(value.events) &&
    value.events.length <= MAX_EVENTS_PER_THREAD &&
    value.events.every(isValidRecoveryEvent) &&
    value.events.every((event) => (event as RecoveryEvent).seq < (value.nextSeq as number))
  );
}

/** Validate untrusted stored state: a wrong version is empty; an unreadable thread is dropped whole. */
export function loadContinuityLog(raw: unknown): { state: ContinuityLogState; discarded: number } {
  if (raw === undefined) {
    return { state: { version: 1, threads: [] }, discarded: 0 };
  }
  if (!isRecord(raw) || !keys(raw, 'threads,version') || raw.version !== 1 || !Array.isArray(raw.threads)) {
    return { state: { version: 1, threads: [] }, discarded: 1 };
  }
  const seen = new Set<string>();
  const threads: ThreadLog[] = [];
  let discarded = 0;
  for (const candidate of raw.threads) {
    if (!validThread(candidate) || seen.has(candidate.threadId)) {
      discarded += 1;
      continue;
    }
    seen.add(candidate.threadId);
    threads.push(structuredClone(candidate));
  }
  return { state: { version: 1, threads: threads.slice(0, MAX_LOG_THREADS) }, discarded };
}

export type NewRecoveryEvent = Omit<RecoveryEvent, 'seq'>;

/** Append one event (nothing is stored when it does not validate); the oldest events make room. */
export function appendRecoveryEvent(state: ContinuityLogState, threadId: string, input: NewRecoveryEvent): boolean {
  if (!ID.test(threadId)) {
    return false;
  }
  let thread = state.threads.find((entry) => entry.threadId === threadId);
  const event: RecoveryEvent = { ...input, sources: input.sources.slice(0, MAX_EVENT_SOURCES), seq: thread?.nextSeq ?? 1 };
  if (!isValidRecoveryEvent(event)) {
    return false;
  }
  if (thread === undefined) {
    thread = { threadId, nextSeq: 1, events: [] };
  }
  state.threads = [thread, ...state.threads.filter((entry) => entry.threadId !== threadId)].slice(0, MAX_LOG_THREADS);
  thread.events.push(event);
  thread.nextSeq = event.seq + 1;
  thread.events.splice(0, Math.max(0, thread.events.length - MAX_EVENTS_PER_THREAD));
  return true;
}

export function pruneContinuityLog(state: ContinuityLogState, liveThreadIds: ReadonlySet<string>): void {
  state.threads = state.threads.filter((entry) => liveThreadIds.has(entry.threadId));
}

export interface ContinuityLogView {
  events: RecoveryEvent[];
  total: number;
  discarded: boolean;
}

export const EMPTY_CONTINUITY_LOG_VIEW: ContinuityLogView = { events: [], total: 0, discarded: false };

export function continuityLogView(state: ContinuityLogState, threadId: string | null, discarded: boolean): ContinuityLogView {
  const events = state.threads.find((entry) => entry.threadId === threadId)?.events ?? [];
  return { events: events.slice(-MAX_EVENTS_SHOWN).map((event) => structuredClone(event)), total: events.length, discarded };
}

/** Re-validate at the webview boundary: invalid events are dropped, never repaired. */
export function sanitizeContinuityLogView(value: unknown): ContinuityLogView {
  if (!isRecord(value)) {
    return { ...EMPTY_CONTINUITY_LOG_VIEW, events: [] };
  }
  const events = Array.isArray(value.events) ? value.events.filter(isValidRecoveryEvent).slice(-MAX_EVENTS_SHOWN).map((event) => structuredClone(event)) : [];
  return { events, total: count(value.total, MAX_EVENTS_PER_THREAD) ? value.total : events.length, discarded: value.discarded === true };
}

/** The stored record and whether anything unreadable was discarded at load. */
export class ContinuityLogStore {
  state: ContinuityLogState;
  readonly discarded: boolean;

  constructor(private readonly backend: { get(key: string): unknown; update(key: string, value: unknown): unknown }) {
    const loaded = loadContinuityLog(backend.get(CONTINUITY_LOG_KEY));
    this.state = loaded.state;
    this.discarded = loaded.discarded > 0;
  }

  persist(): void {
    void this.backend.update(CONTINUITY_LOG_KEY, this.state);
  }
}
