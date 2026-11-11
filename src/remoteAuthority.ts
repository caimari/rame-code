/**
 * The two ways RAME Code may involve Meta, kept apart by construction:
 *
 * - Advisory: "Ask Spark for advice — Glimmer remains in control". Meta gets
 *   a minimal text, no tools, and cannot change anything. The local agent
 *   keeps proposing every action under the original permissions.
 * - Delegated: "Run this request with Spark — Spark directs the agent".
 *   Meta proposes the tool calls of one request; the host still checks and
 *   approves each one with the same workspace and permission profile.
 *
 * Each approval is bound by digest to what it allows. An Advisory approval
 * or budget can never start a delegated run. Pure: no VS Code, no network.
 */

import { createHash } from 'node:crypto';

import type { MetaFailureCategory } from './metaFailures.js';

export const ADVISORY_TITLE = 'Ask Spark for advice — Glimmer remains in control';
export const DELEGATED_TITLE = 'Run this request with Spark — Spark directs the agent';

/** What an Advisory consultation sends by default. File contents are never in it. */
export const ADVISORY_DATA_CLASSES: readonly string[] = [
  'your request',
  'why the local run stopped',
  "the host's content-free record of the run",
  'the failing check and its exit code',
  'project decisions in force',
];

/** What a delegated run may send to Meta, by mode. */
export function delegatedDataClasses(mode: string): string[] {
  return mode === 'agent'
    ? ['your request', "this thread's recent messages", 'the output of each tool it runs, including the contents of files it reads']
    : ['your request', "this thread's recent messages"];
}

export interface AuthorizedFile {
  path: string;
  sha256: string;
  content: string;
  truncated: boolean;
}

/** One Advisory offer: exactly what would be sent, once, to which model. */
export interface ConsultOffer {
  threadId: string;
  root: string;
  /** Folder name only; the model never receives the absolute root. */
  project: string;
  task: string;
  reason: string;
  /** The failing check that motivated it, if any. */
  verifier: { commandId: string; exitCode: number | null } | null;
  /** The default payload, without any authorized file contents. */
  basePayload: string;
  payload: string;
  model: string;
  /** The main model doing the work (it keeps the tools and stays in control). */
  localModel: string;
  /** Its provider; omitted means local (offers made before Meta could be the main model). */
  mainProvider?: 'local' | 'cloud';
  /** The default text with the safe end of the failing check's output, when there is one; on the card only if the user includes it. */
  outputPayload?: string;
  outputIncluded?: boolean;
  digest: string;
  createdAt: number;
  generation: number;
  /** Files read in the run that the user may choose to include. */
  fileCandidates: string[];
  /** Files whose exact content the user authorized for this payload. */
  authorizedFiles: Array<{ path: string; sha256: string; truncated: boolean }>;
  /** Attempts already made for this offer, and the last failure. */
  attempts: number;
  lastFailure: MetaFailureCategory | null;
  /**
   * A blocked Mission the advice is for: the answer is kept for that
   * Mission's next run (if the user retries it), and no separate run starts.
   */
  missionId?: string;
}

export interface DelegationOffer {
  threadId: string;
  /** Workspace root of the failed local run; null when the mode has no workspace. */
  root: string | null;
  project: string | null;
  text: string;
  mode: string;
  model: string;
  /** The permission profile the delegated run will use: the same as the local one. */
  profile: string;
  dataClasses: string[];
  budget: string;
  reason: string;
  digest: string;
  createdAt: number;
}

export interface DelegationFailure {
  threadId: string;
  root: string | null;
  text: string;
  mode: string;
  category: MetaFailureCategory;
  /** Host-confirmed actions of the failed delegated run. */
  confirmedActions: number;
}

export const DELEGATION_OFFER_TTL_MS = 15 * 60 * 1000;
export const MAX_AUTHORIZED_FILES = 3;
export const MAX_AUTHORIZED_FILE_CHARS = 8000;

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/** Binds an Advisory approval to the exact payload, model, thread, and attempt. */
export function advisoryDigest(payload: string, model: string, threadId: string, attempt: number): string {
  return sha({ kind: 'rame-advisory:v2', payload, model, threadId, attempt });
}

/** Binds a delegated approval to project, request, provider, model, scope, budget, and data. */
export function delegationDigest(offer: Omit<DelegationOffer, 'digest' | 'createdAt' | 'reason'>): string {
  return sha({
    kind: 'rame-delegation:v1',
    provider: 'cloud',
    threadId: offer.threadId,
    root: offer.root,
    request: createHash('sha256').update(offer.text, 'utf8').digest('hex'),
    mode: offer.mode,
    model: offer.model,
    profile: offer.profile,
    dataClasses: offer.dataClasses,
    budget: offer.budget,
  });
}

/** The budget of one delegated run, in plain words. */
export function delegationBudget(mode: string, maxSteps: number): string {
  return mode === 'agent' ? `this one request, up to ${maxSteps} model steps` : 'this one request, one reply';
}

/** Files read in a run, from the host record ("read_file <path> → …"). */
export function filesReadInRecord(record: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const line of record) {
    const match = /^•?\s*read_file (\S+) →/.exec(line);
    if (match) {
      seen.add(match[1] as string);
    }
  }
  return [...seen].slice(0, 12);
}

/** The labeled section of authorized file contents appended to an Advisory payload. */
export function authorizedFilesSection(project: string, files: readonly AuthorizedFile[]): string {
  if (files.length === 0) {
    return '';
  }
  const parts = files.map(
    (file) =>
      `--- ${file.path} (sha256 ${file.sha256})${file.truncated ? ` — first ${MAX_AUTHORIZED_FILE_CHARS} characters only` : ''}\n${file.content}`,
  );
  return `\n\nFile contents the user authorized for this consultation (project ${project}):\n${parts.join('\n')}`;
}

/** Why "Run this request with Spark" is not available for a failed local request. */
export type DelegationState = 'offered' | 'off' | 'no-key' | 'not-agent' | 'internal' | 'not-sent' | 'setup';

/**
 * A failed local request: "unreachable" means the server did not answer at
 * all; "setup" means it answered that it has no model ready (load it there),
 * which is never a reason to run the request with Spark.
 */
export interface LocalIssue {
  /** null: the home screen, when the request was refused before a thread existed. */
  threadId: string | null;
  kind: 'unreachable' | 'failed' | 'setup';
  /** LM Studio refused for lack of context: the context a "Reload in LM Studio" button offers. */
  reload?: number;
  /** The server refused because the request does not fit its context (the card says so, not "Glimmer answered"). */
  context?: true;
  /** Host only (never sent to the view): the reason a Spark offer made later from Settings shows. */
  reason?: string;
  /** RAME Code owns a configured server it can start. */
  canStart: boolean;
  delegation: DelegationState;
}
