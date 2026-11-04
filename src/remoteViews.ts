/**
 * View contract for the Meta paths: the messages the view may send about
 * them, strictly parsed, and the bounded state it is shown. Kept apart from
 * viewMessages.ts so that module stays within its size budget.
 */

import { META_FAILURE_CATEGORIES, type MetaFailureCategory } from './metaFailures.js';
import type { DelegationState } from './remoteAuthority.js';

export interface EscalateApproveMessage {
  type: 'escalateApprove';
  /** The delegated run being approved, by its digest. */
  digest: string;
}

export interface ConsultIncludeFilesMessage {
  type: 'consultIncludeFiles';
  digest: string;
  files: string[];
}

export interface DelegationRunLocalMessage {
  type: 'delegationRunLocal';
}

/** Start the saved local server after a failed request; only when the host offered it. */
export interface LocalIssueStartMessage {
  type: 'localIssueStart';
}

/** The user's answer on the Meta disclosure card, bound to the digest shown. */
export interface DisclosureDecideMessage {
  type: 'disclosureDecide';
  digest: string;
  choice: 'include' | 'withhold' | 'cancel';
  /** Agent only: may tool results go to Meta in this thread for this session. */
  toolResults?: boolean;
}

/** Withdraw every Meta answer for the open thread. */
export interface DisclosureStopMessage {
  type: 'disclosureStop';
}

export interface AcceptanceReviewPrepareMessage {
  type: 'acceptanceReviewPrepare';
  missionId: string;
  revision: number;
  commandId: string;
  files: string[];
  maxConsultations: number;
  maxRequestBytes: number | null;
  maxOutputTokens: number | null;
  maxTotalTokens: number | null;
}

export interface AcceptanceReviewActionMessage {
  type: 'acceptanceReviewSend' | 'acceptanceReviewCancel';
  missionId: string;
  revision: number;
  digest: string;
}

export interface AcceptanceReviewDecideMessage {
  type: 'acceptanceReviewDecide';
  missionId: string;
  revision: number;
  digest: string;
  decision: 'considered' | 'dismissed';
}

export type RemoteMessage =
  | EscalateApproveMessage | ConsultIncludeFilesMessage | DelegationRunLocalMessage | LocalIssueStartMessage
  | DisclosureDecideMessage | DisclosureStopMessage | AcceptanceReviewPrepareMessage
  | AcceptanceReviewActionMessage | AcceptanceReviewDecideMessage;

const DIGEST = /^[0-9a-f]{64}$/;

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

/** Parse a Meta-path message; null when the type is not one of them; throws when malformed. */
export function parseRemoteMessage(record: Record<string, unknown>): RemoteMessage | null {
  const mission = (): boolean =>
    typeof record.missionId === 'string' && /^mis_[0-9a-f]{24}$/.test(record.missionId) &&
    typeof record.revision === 'number' && Number.isInteger(record.revision) && record.revision > 0;
  switch (record.type) {
    case 'escalateApprove':
      if (!exactKeys(record, ['type', 'digest']) || typeof record.digest !== 'string' || !DIGEST.test(record.digest)) {
        throw new Error('Invalid escalateApprove message.');
      }
      return { type: 'escalateApprove', digest: record.digest };
    case 'consultIncludeFiles':
      if (
        !exactKeys(record, ['type', 'digest', 'files']) ||
        typeof record.digest !== 'string' ||
        !DIGEST.test(record.digest) ||
        !Array.isArray(record.files) ||
        record.files.length > 3 ||
        (record.files as unknown[]).some((file) => typeof file !== 'string' || file.length === 0 || file.length > 512)
      ) {
        throw new Error('Invalid consultIncludeFiles message.');
      }
      return { type: 'consultIncludeFiles', digest: record.digest, files: [...(record.files as string[])] };
    case 'delegationRunLocal':
      if (!exactKeys(record, ['type'])) {
        throw new Error('Invalid delegationRunLocal message.');
      }
      return { type: 'delegationRunLocal' };
    case 'localIssueStart':
      if (!exactKeys(record, ['type'])) {
        throw new Error('Invalid localIssueStart message.');
      }
      return { type: 'localIssueStart' };
    case 'disclosureDecide':
      if (
        !(exactKeys(record, ['type', 'digest', 'choice']) || (exactKeys(record, ['type', 'digest', 'choice', 'toolResults']) && typeof record.toolResults === 'boolean')) ||
        typeof record.digest !== 'string' ||
        !DIGEST.test(record.digest) ||
        (record.choice !== 'include' && record.choice !== 'withhold' && record.choice !== 'cancel')
      ) {
        throw new Error('Invalid disclosureDecide message.');
      }
      return { type: 'disclosureDecide', digest: record.digest, choice: record.choice, toolResults: record.toolResults === true };
    case 'disclosureStop':
      if (!exactKeys(record, ['type'])) {
        throw new Error('Invalid disclosureStop message.');
      }
      return { type: 'disclosureStop' };
    case 'acceptanceReviewPrepare': {
      const numeric = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000);
      if (
        !exactKeys(record, ['type', 'missionId', 'revision', 'commandId', 'files', 'maxConsultations', 'maxRequestBytes', 'maxOutputTokens', 'maxTotalTokens']) || !mission() ||
        typeof record.commandId !== 'string' || record.commandId.length === 0 || record.commandId.length > 128 ||
        !Array.isArray(record.files) || record.files.length === 0 || record.files.length > 3 ||
        record.files.some((file) => typeof file !== 'string' || file.length === 0 || file.length > 512) ||
        typeof record.maxConsultations !== 'number' || !Number.isInteger(record.maxConsultations) || record.maxConsultations < 1 || record.maxConsultations > 5 ||
        !numeric(record.maxRequestBytes) || !numeric(record.maxOutputTokens) || !numeric(record.maxTotalTokens)
      ) {
        throw new Error('Invalid acceptanceReviewPrepare message.');
      }
      return {
        type: 'acceptanceReviewPrepare', missionId: record.missionId as string, revision: record.revision as number,
        commandId: record.commandId, files: [...(record.files as string[])], maxConsultations: record.maxConsultations, maxRequestBytes: record.maxRequestBytes,
        maxOutputTokens: record.maxOutputTokens, maxTotalTokens: record.maxTotalTokens,
      };
    }
    case 'acceptanceReviewSend':
    case 'acceptanceReviewCancel':
      if (!exactKeys(record, ['type', 'missionId', 'revision', 'digest']) || !mission() || typeof record.digest !== 'string' || !DIGEST.test(record.digest)) {
        throw new Error(`Invalid ${record.type} message.`);
      }
      return { type: record.type, missionId: record.missionId as string, revision: record.revision as number, digest: record.digest };
    case 'acceptanceReviewDecide':
      if (
        !exactKeys(record, ['type', 'missionId', 'revision', 'digest', 'decision']) || !mission() ||
        typeof record.digest !== 'string' || !DIGEST.test(record.digest) || (record.decision !== 'considered' && record.decision !== 'dismissed')
      ) {
        throw new Error('Invalid acceptanceReviewDecide message.');
      }
      return { type: 'acceptanceReviewDecide', missionId: record.missionId as string, revision: record.revision as number, digest: record.digest, decision: record.decision };
    default:
      return null;
  }
}

/** Local messages shown on the Meta disclosure card. */
export type OfferedMessages = Array<{ turn: number; role: 'user' | 'assistant' | 'plan'; at: number; text: string; hostRecord: string[] }>;

/** What the view shows about the Meta paths, beyond the exact consult text. */
export interface RemoteView {
  consult: {
    mode: 'advisory';
    localModel: string;
    model: string;
    project: string;
    verifier: string;
    dataClasses: string[];
    fileCandidates: string[];
    authorizedFiles: string[];
    attempts: number;
    lastFailure: MetaFailureCategory | null;
  } | null;
  delegation: {
    mode: 'delegated';
    model: string;
    project: string | null;
    profile: string;
    budget: string;
    dataClasses: string[];
    digest: string;
  } | null;
  delegationFailure: { category: MetaFailureCategory; confirmedActions: number } | null;
  /** The header's runtime line; "connected" only after an answer in this session. */
  runtime: {
    local: 'running' | 'starting' | 'connected' | 'configured' | 'stopped' | 'not-configured';
    cloud: 'connected' | 'configured' | 'not-configured';
    selected: 'local' | 'cloud';
  };
  /** A failed local request: which local actions apply and why delegation is (not) offered. */
  localIssue: { kind: 'unreachable' | 'failed'; canStart: boolean; delegation: DelegationState } | null;
  /** A Meta request waiting on the disclosure card: exactly what it would add from local sessions. */
  disclosure: {
    model: string;
    mode: 'chat' | 'agent';
    delegated: boolean;
    messages: OfferedMessages;
    /** Approved earlier and sent again with this request (within the same bound). */
    earlier: OfferedMessages;
    decisions: Array<{ key: string; version: number; value: string | number | boolean }>;
    /** Agent: the card also asks whether tool results may go to Meta in this session. */
    askToolResults: boolean;
    /** A Contributor variant: under Meta's terms it may use what it receives. */
    contributor: boolean;
    chars: number;
    digest: string;
  } | null;
  /** What the open thread shares with Meta now; null when nothing was ever answered. */
  sharing: { messages: number; decisions: 'shared' | 'withheld' | null; toolResults: boolean | null } | null;
}

export const EMPTY_REMOTE_VIEW: RemoteView = {
  consult: null,
  delegation: null,
  delegationFailure: null,
  runtime: { local: 'not-configured', cloud: 'not-configured', selected: 'local' },
  localIssue: null,
  disclosure: null,
  sharing: null,
};

const LOCAL_RUNTIME_STATES: ReadonlyArray<RemoteView['runtime']['local']> = ['running', 'starting', 'connected', 'configured', 'stopped', 'not-configured'];
const CLOUD_RUNTIME_STATES: ReadonlyArray<RemoteView['runtime']['cloud']> = ['connected', 'configured', 'not-configured'];

const DELEGATION_STATES: readonly DelegationState[] = ['offered', 'off', 'no-key', 'not-agent', 'internal', 'not-sent'];

/** Mission Advisory state for the live card. */
export interface MissionRemoteView {
  model: string;
  maxConsultations: number;
  attempts: number;
  validResponses: number;
  /** The grant's fixed limits and what has been used against them; null without a grant. */
  limits: { maxRequestBytes: number; maxTotalBytes: number; sentBytes: number; maxOutputTokens: number; maxTotalTokens: number; usedTokens: number } | null;
  dataClasses: string[];
  lastResult: string;
  blocker: { id: string; commandId: string; sinceRun: number; state: string } | null;
  causalState: 'normal' | 'restricted' | 'unrecoverable';
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function strings(value: unknown, max: number, each: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, max).map((item) => item.slice(0, each)) : [];
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function category(value: unknown): MetaFailureCategory | null {
  return META_FAILURE_CATEGORIES.includes(value as MetaFailureCategory) ? (value as MetaFailureCategory) : null;
}

function offered(value: unknown): OfferedMessages {
  return (Array.isArray(value) ? value : []).slice(0, 20).flatMap((raw) => {
    const entry = object(raw);
    return entry === null || !['user', 'assistant', 'plan'].includes(entry.role as string)
      ? []
      : [{ turn: count(entry.turn), role: entry.role as 'user' | 'assistant' | 'plan', at: count(entry.at), text: text(entry.text, 8000), hostRecord: strings(entry.hostRecord, 24, 240) }];
  });
}

export function sanitizeRemoteView(value: unknown): RemoteView {
  const record = object(value);
  if (record === null) {
    return { ...EMPTY_REMOTE_VIEW };
  }
  const consult = object(record.consult);
  const delegation = object(record.delegation);
  const failure = object(record.delegationFailure);
  const issue = object(record.localIssue);
  const runtime = object(record.runtime);
  const disclosure = object(record.disclosure);
  return {
    disclosure:
      disclosure === null || typeof disclosure.digest !== 'string' || !DIGEST.test(disclosure.digest)
        ? null
        : {
            model: text(disclosure.model, 128),
            mode: disclosure.mode === 'agent' ? 'agent' : 'chat',
            delegated: disclosure.delegated === true,
            messages: offered(disclosure.messages),
            earlier: offered(disclosure.earlier),
            decisions: (Array.isArray(disclosure.decisions) ? disclosure.decisions : []).slice(0, 32).flatMap((raw) => {
              const entry = object(raw);
              const value = entry?.value;
              return entry === null || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
                ? []
                : [{ key: text(entry.key, 128), version: count(entry.version), value: typeof value === 'string' ? value.slice(0, 500) : value }];
            }),
            askToolResults: disclosure.askToolResults === true,
            contributor: disclosure.contributor === true,
            chars: count(disclosure.chars),
            digest: disclosure.digest,
          },
    sharing: (() => {
      const sharing = object(record.sharing);
      return sharing === null
        ? null
        : {
            messages: count(sharing.messages),
            decisions: sharing.decisions === 'shared' || sharing.decisions === 'withheld' ? sharing.decisions : null,
            toolResults: typeof sharing.toolResults === 'boolean' ? sharing.toolResults : null,
          };
    })(),
    runtime: {
      local: LOCAL_RUNTIME_STATES.includes(runtime?.local as never) ? (runtime?.local as RemoteView['runtime']['local']) : 'not-configured',
      cloud: CLOUD_RUNTIME_STATES.includes(runtime?.cloud as never) ? (runtime?.cloud as RemoteView['runtime']['cloud']) : 'not-configured',
      selected: runtime?.selected === 'cloud' ? 'cloud' : 'local',
    },
    consult:
      consult === null
        ? null
        : {
            mode: 'advisory',
            localModel: text(consult.localModel, 128),
            model: text(consult.model, 128),
            project: text(consult.project, 256),
            verifier: text(consult.verifier, 160),
            dataClasses: strings(consult.dataClasses, 8, 160),
            fileCandidates: strings(consult.fileCandidates, 12, 512),
            authorizedFiles: strings(consult.authorizedFiles, 3, 512),
            attempts: count(consult.attempts),
            lastFailure: category(consult.lastFailure),
          },
    delegation:
      delegation === null || typeof delegation.digest !== 'string' || !DIGEST.test(delegation.digest)
        ? null
        : {
            mode: 'delegated',
            model: text(delegation.model, 128),
            project: typeof delegation.project === 'string' ? delegation.project.slice(0, 256) : null,
            profile: text(delegation.profile, 32),
            budget: text(delegation.budget, 120),
            dataClasses: strings(delegation.dataClasses, 6, 160),
            digest: delegation.digest,
          },
    delegationFailure:
      failure === null || category(failure.category) === null
        ? null
        : { category: category(failure.category) as MetaFailureCategory, confirmedActions: count(failure.confirmedActions) },
    localIssue:
      issue === null || (issue.kind !== 'unreachable' && issue.kind !== 'failed') || !DELEGATION_STATES.includes(issue.delegation as DelegationState)
        ? null
        : { kind: issue.kind, canStart: issue.canStart === true, delegation: issue.delegation as DelegationState },
  };
}

export function sanitizeMissionRemote(value: unknown): MissionRemoteView | null {
  const record = object(value);
  if (record === null) {
    return null;
  }
  const blocker = object(record.blocker);
  const limits = object(record.limits);
  return {
    model: text(record.model, 128),
    limits:
      limits === null
        ? null
        : {
            maxRequestBytes: count(limits.maxRequestBytes),
            maxTotalBytes: count(limits.maxTotalBytes),
            sentBytes: count(limits.sentBytes),
            maxOutputTokens: count(limits.maxOutputTokens),
            maxTotalTokens: count(limits.maxTotalTokens),
            usedTokens: count(limits.usedTokens),
          },
    maxConsultations: count(record.maxConsultations),
    attempts: count(record.attempts),
    validResponses: count(record.validResponses),
    dataClasses: strings(record.dataClasses, 8, 160),
    lastResult: text(record.lastResult, 300),
    blocker:
      blocker === null
        ? null
        : { id: text(blocker.id, 40), commandId: text(blocker.commandId, 80), sinceRun: count(blocker.sinceRun), state: text(blocker.state, 24) },
    causalState: record.causalState === 'restricted' || record.causalState === 'unrecoverable' ? record.causalState : 'normal',
  };
}
