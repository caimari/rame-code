/**
 * What a Meta request may carry from a thread's local sessions.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * A turn belongs to a local session unless Meta answered it. Meta receives
 * a local-session turn only after the user saw that exact turn on a
 * disclosure card and chose to include it. Each inclusion is bound to the
 * provider and to the sha256 of the exact content shown, not only to the
 * turn's position: if the turn at that position is ever different (a
 * reloaded thread whose invalid turns were dropped shifts the positions), it
 * is neither sent nor treated as answered. Turns the user chose to withhold
 * are never offered again. Project decisions follow the same rule, bound to
 * the exact versions shown. Notes RAME Code wrote itself (records, reports)
 * are never offered and never sent. Anything unreadable in the stored record
 * counts as nothing disclosed, so RAME asks again rather than sending. The
 * user can withdraw every answer for a thread; that cannot recall what Meta
 * already received.
 *
 * An answer also belongs to one processing class (standard, contributor, or
 * one undocumented model: metaRecipient.ts) and one credential revision (the
 * Meta API key it was given under). Messages Meta received under another
 * class count as not yet shared with this one, so moving from a standard
 * model to a Contributor variant asks again for them too.
 */

import { createHash } from 'node:crypto';

import type { AuthorizedDecisionSummary } from './continuityCheckpoint.js';
import { processingClass } from './metaRecipient.js';
import type { ChatThread, ThreadTurn } from './threadStore.js';

export const CLOUD_DISCLOSURE_KEY = 'rameCode.cloudDisclosure.v1';
/** The only external recipient today; answers are bound to it. */
export const META_RECIPIENT = 'meta-model-api:https://api.meta.ai';
/** At most this much local history is offered at once: the v0.1 Chat bound. */
export const MAX_OFFERED_MESSAGES = 20;
export const MAX_OFFERED_CHARS = 12_000;
const MAX_THREADS = 50;
const MAX_INDEXES = 4_000;

/** The conditions an answer is given under, besides its content. */
export interface DisclosureScope {
  /** standard, contributor, or model:<id> (metaRecipient.processingClass). */
  processing: string;
  /** The Meta API key's revision when the answer was given (metaRecipient.ts). */
  credential: string;
}

export interface ThreadDisclosure extends DisclosureScope {
  threadId: string;
  recipient: string;
  /** Local-session turns the user chose to send to Meta, with the hash of what was shown. */
  disclosed: Array<{ turn: number; sha256: string }>;
  /** Local-session turns the user chose to keep local; never offered again. */
  withheld: number[];
  /** The decision set the user answered for, and the answer. */
  decisions: { digest: string; allowed: boolean } | null;
  updatedAt: number;
}

export interface DisclosureState {
  version: 4;
  threads: ThreadDisclosure[];
}

export interface OfferedMessage {
  turn: number;
  role: 'user' | 'assistant' | 'plan';
  at: number;
  text: string;
  hostRecord: string[];
}

/** The run a card is for: what the user is asked to allow depends on it. */
export interface DisclosureRequest {
  model: string;
  mode: 'chat' | 'agent';
  delegated: boolean;
  /** Agent with Meta, not delegated, and no answer yet in this session about tool results. */
  askToolResults: boolean;
}

export interface DisclosurePlan {
  /** True when the request must wait for the user's answer. */
  needed: boolean;
  /** New local messages to answer for. */
  messages: OfferedMessage[];
  /** Messages approved earlier that this request sends again: the card shows them too. */
  earlier: OfferedMessage[];
  /** Decisions to answer for (empty when already answered or none). */
  decisions: AuthorizedDecisionSummary[];
  decisionsDigest: string | null;
  /** Whether this request may carry the project's decisions. */
  decisionsAllowed: boolean;
  askToolResults: boolean;
  chars: number;
  digest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function indexes(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= MAX_INDEXES && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry < 1_000_000);
}

function disclosedEntries(value: unknown): value is ThreadDisclosure['disclosed'] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INDEXES &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        Object.keys(entry).sort().join() === 'sha256,turn' &&
        indexes([entry.turn]) &&
        typeof entry.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(entry.sha256),
    )
  );
}

function validThread(value: unknown): value is ThreadDisclosure {
  if (!isRecord(value) || Object.keys(value).sort().join() !== 'credential,decisions,disclosed,processing,recipient,threadId,updatedAt,withheld') {
    return false;
  }
  const decisions = value.decisions;
  return (
    typeof value.processing === 'string' &&
    /^(?:standard|contributor|model:[A-Za-z0-9._:-]{1,96})$/.test(value.processing) &&
    typeof value.credential === 'string' &&
    /^(?:[0-9a-f]{32}|none)$/.test(value.credential) &&
    typeof value.threadId === 'string' &&
    /^[A-Za-z0-9_.:-]{1,64}$/.test(value.threadId) &&
    value.recipient === META_RECIPIENT &&
    disclosedEntries(value.disclosed) &&
    indexes(value.withheld) &&
    Number.isInteger(value.updatedAt) &&
    (decisions === null ||
      (isRecord(decisions) &&
        Object.keys(decisions).sort().join() === 'allowed,digest' &&
        typeof decisions.digest === 'string' &&
        /^[0-9a-f]{64}$/.test(decisions.digest) &&
        typeof decisions.allowed === 'boolean'))
  );
}

/** Validate untrusted stored state; an unreadable or older entry is dropped (nothing disclosed). */
export function loadDisclosure(raw: unknown): DisclosureState {
  if (!isRecord(raw) || raw.version !== 4 || !Array.isArray(raw.threads)) {
    return { version: 4, threads: [] };
  }
  const seen = new Set<string>();
  const threads = raw.threads.filter((entry): entry is ThreadDisclosure => {
    if (!validThread(entry) || seen.has(`${entry.threadId}|${entry.processing}|${entry.credential}`)) {
      return false;
    }
    seen.add(`${entry.threadId}|${entry.processing}|${entry.credential}`);
    return true;
  });
  return { version: 4, threads: structuredClone(threads).slice(0, MAX_THREADS) };
}

/** The answers for one thread under one scope; none (nothing disclosed) when there are none. */
export function threadDisclosure(state: DisclosureState, threadId: string, scope: DisclosureScope): ThreadDisclosure {
  return (
    state.threads.find(
      (entry) =>
        entry.threadId === threadId &&
        entry.recipient === META_RECIPIENT &&
        entry.processing === scope.processing &&
        entry.credential === scope.credential,
    ) ?? { threadId, recipient: META_RECIPIENT, ...scope, disclosed: [], withheld: [], decisions: null, updatedAt: 0 }
  );
}

function sameScope(left: ThreadDisclosure, right: ThreadDisclosure): boolean {
  return left.threadId === right.threadId && left.processing === right.processing && left.credential === right.credential;
}

function store(state: DisclosureState, next: ThreadDisclosure): void {
  next.disclosed = next.disclosed.slice(-MAX_INDEXES);
  next.withheld = [...new Set(next.withheld)].slice(-MAX_INDEXES);
  state.threads = [next, ...state.threads.filter((entry) => !sameScope(entry, next))].slice(0, MAX_THREADS);
}

/** A note RAME Code wrote itself: marked, or (older threads) an assistant turn with no model origin. */
function isHostNote(turn: ThreadTurn | undefined): boolean {
  return turn?.kind === 'assistant' && (turn.host === true || turn.origin === undefined);
}

/**
 * The current request is not history: the last user turn when it equals
 * `currentText`, followed at most by notes about it (an error, the
 * delegation record), as when a failed local request is delegated.
 */
export function currentRequestTurn(thread: ChatThread, currentText: string): number {
  const turns = thread.turns;
  let last = turns.length - 1;
  while (last >= 0 && (turns[last]?.kind === 'error' || isHostNote(turns[last]))) {
    last -= 1;
  }
  return turns[last]?.kind === 'user' && (turns[last] as { text: string }).text.trim() === currentText.trim() ? last : -1;
}

/** A reply Meta wrote under this processing class (so already with this recipient). */
function fromClass(turn: ThreadTurn | undefined, processing: string): boolean {
  return turn?.kind === 'assistant' && turn.origin?.provider === 'cloud' && processingClass(turn.origin.model) === processing;
}

/**
 * Turns not yet with this recipient that a card may offer: every user,
 * assistant, and plan turn before the current request except the replies
 * Meta wrote under this processing class, the user turns those replies
 * answered, and the host's own marked notes. Exchanges with Meta under
 * another class (standard vs contributor) count as not yet shared.
 */
export function localSessionTurns(thread: ChatThread, currentText: string, processing = 'standard'): number[] {
  const local: number[] = [];
  const turns = thread.turns;
  const current = currentRequestTurn(thread, currentText);
  turns.forEach((turn, index) => {
    if ((current >= 0 && index >= current) || turn.kind === 'error') {
      return;
    }
    if (turn.kind === 'assistant') {
      if (turn.host !== true && !fromClass(turn, processing)) {
        local.push(index);
      }
      return;
    }
    if (turn.kind === 'user') {
      // Answered by Meta under this class when the next reply before another user turn came from it.
      const next = turns.slice(index + 1).find((later) => later.kind === 'user' || (later.kind === 'assistant' && later.host !== true));
      if (!fromClass(next, processing)) {
        local.push(index);
      }
      return;
    }
    local.push(index);
  });
  return local;
}

/** Retrieval statistics RAME adds to its own records: never content, never offered or sent. */
function shownRecord(lines: readonly string[] | undefined): string[] {
  return (lines ?? []).filter((line) => !/context_continuity/.test(line));
}

function messageOf(thread: ChatThread, index: number): OfferedMessage | null {
  const turn = thread.turns[index];
  if (turn?.kind === 'user') {
    return { turn: index, role: 'user', at: turn.timestamp, text: turn.text, hostRecord: [] };
  }
  if (turn?.kind === 'assistant') {
    return { turn: index, role: 'assistant', at: turn.timestamp, text: turn.text, hostRecord: shownRecord(turn.hostRecord) };
  }
  if (turn?.kind === 'plan') {
    return { turn: index, role: 'plan', at: turn.timestamp, text: `${turn.plan.goal}\n${turn.plan.steps.map((step) => step.title).join('\n')}`, hostRecord: [] };
  }
  return null;
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The hash an inclusion is bound to: every field the card showed (role, time, text, host record). */
export function messageHash(message: OfferedMessage): string {
  return sha(JSON.stringify([message.role, message.at, message.text, message.hostRecord]));
}

/** Disclosed turns whose content is still exactly what the user approved. */
function disclosedTurns(thread: ChatThread, record: ThreadDisclosure): Set<number> {
  return new Set(
    record.disclosed
      .filter((entry) => {
        const message = messageOf(thread, entry.turn);
        return message !== null && messageHash(message) === entry.sha256;
      })
      .map((entry) => entry.turn),
  );
}

export function decisionsDigest(scopeId: string, decisions: readonly AuthorizedDecisionSummary[]): string {
  return sha(JSON.stringify([META_RECIPIENT, scopeId, decisions.map((entry) => [entry.key, entry.version, entry.value])]));
}

/**
 * The local messages one Meta request may carry, newest first within the
 * bound (20 messages, 12,000 characters) for new and earlier-approved
 * messages together, so approvals never accumulate past it: messages approved
 * earlier still in content and not yet answered newer ones. Withheld ones and
 * unanswered ones older than the last answer are never included.
 */
function localWindow(thread: ChatThread, currentText: string, record: ThreadDisclosure): Array<OfferedMessage & { approved: boolean }> {
  const disclosed = disclosedTurns(thread, record);
  const withheld = new Set(record.withheld);
  // Each answer covers the newest local turns; older unanswered ones were
  // beyond the offered bound then and stay local: they are never offered.
  const floor = Math.max(-1, ...disclosed, ...withheld);
  const window: Array<OfferedMessage & { approved: boolean }> = [];
  let chars = 0;
  for (const index of localSessionTurns(thread, currentText, record.processing).reverse()) {
    const approved = disclosed.has(index);
    if (!approved && (withheld.has(index) || index <= floor)) {
      continue;
    }
    const message = messageOf(thread, index);
    if (message === null) {
      continue;
    }
    const size = message.text.length + message.hostRecord.join('\n').length;
    if (window.length >= MAX_OFFERED_MESSAGES || (window.length > 0 && chars + size > MAX_OFFERED_CHARS)) {
      break;
    }
    window.unshift({ ...message, approved });
    chars += size;
  }
  return window;
}

/** The disclosed local turns this request sends: the approved part of the window. */
function sentTurns(thread: ChatThread, currentText: string, record: ThreadDisclosure): Set<number> {
  return new Set(localWindow(thread, currentText, record).filter((entry) => entry.approved).map((entry) => entry.turn));
}

/**
 * What a Meta request would need the user to answer first: the newest
 * local-session turns not yet disclosed or withheld (bounded), the project's
 * decisions when their exact set was not answered yet, and, for Agent, the
 * tool-results scope of this session. The digest binds every one of them
 * plus the recipient, thread, model, mode, delegation, and the request.
 */
export function planDisclosure(
  thread: ChatThread,
  currentText: string,
  record: ThreadDisclosure,
  decisions: { scopeId: string; list: readonly AuthorizedDecisionSummary[] },
  request: DisclosureRequest,
): DisclosurePlan {
  const window = localWindow(thread, currentText, record);
  const strip = ({ approved: _approved, ...message }: OfferedMessage & { approved: boolean }): OfferedMessage => message;
  const messages = window.filter((entry) => !entry.approved).map(strip);
  const earlier = window.filter((entry) => entry.approved).map(strip);
  const chars = window.reduce((sum, entry) => sum + entry.text.length + entry.hostRecord.join('\n').length, 0);
  const digestOfDecisions = decisions.list.length > 0 ? decisionsDigest(decisions.scopeId, decisions.list) : null;
  const decisionsAnswered = digestOfDecisions === null || record.decisions?.digest === digestOfDecisions;
  const pendingDecisions = decisionsAnswered ? [] : [...decisions.list];
  return {
    needed: messages.length > 0 || pendingDecisions.length > 0 || request.askToolResults,
    messages,
    earlier,
    decisions: pendingDecisions,
    decisionsDigest: digestOfDecisions,
    decisionsAllowed: digestOfDecisions !== null && record.decisions?.digest === digestOfDecisions && record.decisions.allowed,
    askToolResults: request.askToolResults,
    chars,
    digest: sha(
      JSON.stringify([
        META_RECIPIENT,
        record.processing,
        record.credential,
        thread.id,
        request.model,
        request.mode,
        request.delegated,
        currentText.trim(),
        messages.map((entry) => [entry.turn, entry.role, messageHash(entry)]),
        earlier.map((entry) => [entry.turn, entry.role, messageHash(entry)]),
        digestOfDecisions,
        pendingDecisions.map((entry) => [entry.key, entry.version, entry.value]),
        request.askToolResults,
      ]),
    ),
  };
}

/** Record the user's answer to one plan. */
export function recordAnswer(state: DisclosureState, threadId: string, plan: DisclosurePlan, include: boolean, now: number, scope: DisclosureScope): void {
  const record = threadDisclosure(state, threadId, scope);
  const turns = plan.messages.map((entry) => entry.turn);
  const shown = plan.messages.map((entry) => ({ turn: entry.turn, sha256: messageHash(entry) }));
  store(state, {
    threadId,
    recipient: META_RECIPIENT,
    ...scope,
    disclosed: include ? [...record.disclosed.filter((entry) => !turns.includes(entry.turn)), ...shown] : record.disclosed,
    withheld: include ? record.withheld : [...record.withheld, ...turns],
    decisions: plan.decisionsDigest !== null && plan.decisions.length > 0 ? { digest: plan.decisionsDigest, allowed: include } : record.decisions,
    updatedAt: now,
  });
}

/** Withdraw every answer for a thread, under every class: nothing more is sent until the user answers again. */
export function forgetDisclosure(state: DisclosureState, threadId: string): boolean {
  const before = state.threads.length;
  state.threads = state.threads.filter((entry) => entry.threadId !== threadId);
  return state.threads.length !== before;
}

/** Drop the records of threads that no longer exist, and every answer given under another credential. */
export function pruneDisclosure(state: DisclosureState, liveThreadIds: ReadonlySet<string>, credential: string): void {
  state.threads = state.threads.filter((entry) => liveThreadIds.has(entry.threadId) && entry.credential === credential);
}

/** How many local-session messages a Meta request leaves out (not disclosed). */
export function withheldLocalCount(thread: ChatThread, currentText: string, record: ThreadDisclosure): number {
  const sent = sentTurns(thread, currentText, record);
  return localSessionTurns(thread, currentText, record.processing).filter((index) => !sent.has(index)).length;
}

/** Local-session messages the user disclosed in this thread whose content is unchanged. */
export function sharedLocalCount(thread: ChatThread, record: ThreadDisclosure): number {
  const disclosed = disclosedTurns(thread, record);
  return localSessionTurns(thread, '\u0000', record.processing).filter((index) => disclosed.has(index)).length;
}

/** The user sent this request to Meta: it is no local secret on the next request, even if Meta failed. */
export function recordRequestSent(state: DisclosureState, thread: ChatThread, turn: number, now: number, scope: DisclosureScope): void {
  const message = turn < 0 ? null : messageOf(thread, turn);
  if (message === null) {
    return;
  }
  const record = threadDisclosure(state, thread.id, scope);
  const sha256 = messageHash(message);
  if (record.disclosed.some((entry) => entry.turn === turn && entry.sha256 === sha256)) {
    return;
  }
  store(state, { ...record, disclosed: [...record.disclosed.filter((entry) => entry.turn !== turn), { turn, sha256 }], updatedAt: now });
}

/**
 * Local texts a Meta request must not contain: every local-session message
 * not disclosed with its current content, and every host note. Used to check
 * the request actually built, after every selection and recovery.
 */
export function protectedLocalTexts(thread: ChatThread, currentText: string, record: ThreadDisclosure): string[] {
  const sent = sentTurns(thread, currentText, record);
  const texts: string[] = [];
  localSessionTurns(thread, currentText, record.processing).forEach((index) => {
    const message = sent.has(index) ? null : messageOf(thread, index);
    if (message !== null) {
      texts.push(message.text, ...message.hostRecord);
    }
  });
  thread.turns.forEach((turn) => {
    if (turn.kind === 'assistant' && isHostNote(turn) && turn.host === true) {
      texts.push(...shownRecord(turn.hostRecord));
    }
  });
  return texts;
}

/** A thread without RAME's retrieval statistics in its records (they would only accumulate). */
export function withoutRetrievalLines(thread: ChatThread): ChatThread {
  return {
    ...thread,
    turns: thread.turns.map((turn) =>
      turn.kind === 'assistant' && turn.hostRecord?.some((line) => /context_continuity/.test(line))
        ? (() => {
            const hostRecord = shownRecord(turn.hostRecord);
            const { hostRecord: _dropped, ...rest } = turn;
            return hostRecord.length > 0 ? { ...rest, hostRecord } : rest;
          })()
        : turn,
    ),
  };
}

/**
 * The thread as a Meta request may see it: Meta's own exchanges, the
 * disclosed local-session turns within the bounded window, and the current
 * request. Every other local turn (including approved ones beyond the
 * bound) and every host note is left out, so no selection or recovery can
 * reach it.
 */
export function cloudVisibleThread(thread: ChatThread, currentText: string, record: ThreadDisclosure): ChatThread {
  const sent = sentTurns(thread, currentText, record);
  const hidden = new Set(localSessionTurns(thread, currentText, record.processing).filter((index) => !sent.has(index)));
  const current = currentRequestTurn(thread, currentText);
  return withoutRetrievalLines({
    ...thread,
    turns: thread.turns.filter(
      (turn, index) => !hidden.has(index) && !(turn.kind === 'assistant' && turn.host === true) && (current < 0 || index <= current),
    ),
  });
}

/** A Meta request waiting for the user's answer on the disclosure card. */
export interface CloudDisclosureOffer {
  threadId: string;
  text: string;
  mode: 'chat' | 'agent';
  model: string;
  agentTarget: { root: string; label: string } | null;
  /** A delegated run keeps its authority across the card. */
  delegatedRun: { threadId: string; root: string | null; text: string; mode: string } | null;
  plan: DisclosurePlan;
}

/** The Meta request now running: what it may carry beyond the request itself, and under which scope. */
export interface CloudRun extends DisclosureScope {
  threadId: string;
  /** The project's decisions, exactly as shown on the card. */
  allowed: boolean;
  decisions: AuthorizedDecisionSummary[];
  /** Agent tool results (file contents, searches, test output) may be sent. */
  toolResults: boolean;
}
