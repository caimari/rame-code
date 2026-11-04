/**
 * Host side of the Meta disclosure policy (cloudDisclosure.ts): the card
 * before a Meta request, the user's answer, the thread a Meta request may
 * see, the project memory Meta may see, and withdrawing every answer. Nothing
 * reaches Meta while a card is open.
 *
 * Authorization contract, per thread and recipient (Meta Model API):
 * - Local-session messages: each by the sha256 of the exact content shown;
 *   persistent; new or changed content always needs a new answer.
 * - Project decisions: the exact set of (key, version, value) shown;
 *   persistent; any change needs a new answer. Meta sees only that set:
 *   never pending proposals, file bindings, or provenance.
 * - Agent tool results: per thread for this VS Code session only (not
 *   persisted); a delegated run's own approval covers its run.
 * - Every answer and every tool-results permission belongs to one processing
 *   class (standard, contributor, or one undocumented model) and one Meta API
 *   credential revision (metaRecipient.ts). Changing between standard models
 *   reuses them; a Contributor variant, an undocumented model, or a new or
 *   cleared API key needs its own answers. A card that was open when the
 *   model or the key changed is void.
 */

import { scopeIdForRoot } from './decisionStore.js';
import {
  CLOUD_DISCLOSURE_KEY,
  cloudVisibleThread,
  currentRequestTurn,
  forgetDisclosure,
  planDisclosure,
  pruneDisclosure,
  recordAnswer,
  recordRequestSent,
  sharedLocalCount,
  threadDisclosure,
  withheldLocalCount,
  withoutRetrievalLines,
  type DisclosurePlan,
  type DisclosureScope,
} from './cloudDisclosure.js';
import { processingClass } from './metaRecipient.js';
import type { AuthorizedDecisionSummary } from './continuityCheckpoint.js';
import type { ProviderHost } from './providerTypes.js';
import type { ChatThread } from './threadStore.js';

/** The authorized decisions of the project the thread is bound to (none when unbound or closed). */
export async function decisionsForThread(
  host: ProviderHost,
  thread: ChatThread | undefined,
): Promise<{ scopeId: string; list: AuthorizedDecisionSummary[] }> {
  const root = thread?.workspaceRoot;
  if (!root || !host.isBoundRootStillOpen(root)) {
    return { scopeId: '', list: [] };
  }
  try {
    const scopeId = scopeIdForRoot(await host.heldCanonicalRoot(root, host.agentFsFor(root)));
    const list = host.memory.listCurrentDecisions(scopeId).map((decision) => ({
      key: decision.key,
      version: decision.version,
      value: decision.value,
      createdAt: decision.createdAt,
    }));
    return { scopeId, list };
  } catch {
    return { scopeId: '', list: [] };
  }
}

/** The scope a Meta request is under now: the selected model's processing class and the API key's revision. */
export function currentScope(host: ProviderHost): DisclosureScope {
  return { processing: processingClass(host.selectedCloudModel()), credential: host.metaCredential };
}

/** The tool-results permission key: one thread, one class, one credential. */
function grantKey(threadId: string, scope: DisclosureScope): string {
  return `${threadId}|${scope.processing}|${scope.credential}`;
}

function persist(host: ProviderHost): void {
  pruneDisclosure(host.cloudDisclosure, new Set(host.store.list().map((thread) => thread.id)), host.metaCredential);
  void host.extensionState.update(CLOUD_DISCLOSURE_KEY, host.cloudDisclosure);
}

/**
 * The Meta API key was saved or cleared: every answer and permission given
 * under the previous key stops applying now and after a restart (the new
 * revision is persisted first), and an open card is void.
 */
export function credentialChanged(host: ProviderHost, revision: string): void {
  host.metaCredential = revision;
  host.cloudToolGrants.clear();
  host.cloudDisclosureOffer = null;
  persist(host);
}

async function planFor(host: ProviderHost, thread: ChatThread, text: string, mode: 'chat' | 'agent', delegated: boolean): Promise<{ plan: DisclosurePlan; decisions: AuthorizedDecisionSummary[] }> {
  const decisions = await decisionsForThread(host, thread);
  const scope = currentScope(host);
  const plan = planDisclosure(thread, text, threadDisclosure(host.cloudDisclosure, thread.id, scope), decisions, {
    model: host.selectedCloudModel(),
    mode,
    delegated,
    askToolResults: mode === 'agent' && !delegated && !host.cloudToolGrants.has(grantKey(thread.id, scope)),
  });
  return { plan, decisions: decisions.list };
}

/**
 * Before a Meta Chat or Agent request: true when it may go now (and what it
 * may carry is set in `host.cloudRun`); false when a disclosure card is open
 * and nothing was sent. Mission planning sends only the request itself.
 */
export async function cloudGate(
  host: ProviderHost,
  threadId: string,
  text: string,
  mode: string,
  agentTarget: { root: string; label: string } | undefined,
): Promise<boolean> {
  host.cloudRun = null;
  const thread = host.store.get(threadId);
  const scope = currentScope(host);
  if (thread === undefined || mode === 'mission') {
    // A Meta plan carries only the request itself.
    host.cloudRun = { threadId, ...scope, allowed: false, decisions: [], toolResults: false };
    if (thread !== undefined) {
      recordRequestSent(host.cloudDisclosure, thread, currentRequestTurn(thread, text), Date.now(), scope);
      persist(host);
    }
    return true;
  }
  const delegated = host.delegatedRun !== null && host.delegatedRun.threadId === threadId;
  const kind = mode === 'agent' ? 'agent' : 'chat';
  const { plan, decisions } = await planFor(host, thread, text, kind, delegated);
  if (!plan.needed) {
    host.cloudRun = {
      threadId,
      ...scope,
      allowed: plan.decisionsAllowed,
      decisions: plan.decisionsAllowed ? decisions : [],
      // A delegated run's own card lists tool output; otherwise this session's answer for this class and key.
      toolResults: delegated || host.cloudToolGrants.get(grantKey(threadId, scope)) === true,
    };
    recordRequestSent(host.cloudDisclosure, thread, currentRequestTurn(thread, text), Date.now(), scope);
    persist(host);
    return true;
  }
  host.cloudDisclosureOffer = {
    threadId,
    text,
    mode: kind,
    model: host.selectedCloudModel(),
    agentTarget: agentTarget ?? null,
    delegatedRun: host.delegatedRun,
    plan,
  };
  host.running = false;
  host.connection = 'ready';
  host.status = 'Review what this request would send to Meta from your local sessions. Nothing was sent yet.';
  await host.postState();
  return false;
}

/**
 * The user's answer on the card: include the shown context, send without it,
 * or cancel; and, for Agent, whether tool results may go to Meta in this
 * session. The thread, decisions, model, mode, and delegation must still match
 * what was shown; otherwise nothing is sent and the user is asked to send again.
 */
export async function decideDisclosure(
  host: ProviderHost,
  digest: string,
  choice: 'include' | 'withhold' | 'cancel',
  toolResults = false,
): Promise<void> {
  const offer = host.cloudDisclosureOffer;
  if (offer === null || offer.plan.digest !== digest) {
    host.status = 'That review is no longer valid. Nothing was sent to Meta.';
    await host.postState();
    return;
  }
  if (host.running) {
    host.status = 'A request is already running. Nothing was sent to Meta.';
    await host.postState();
    return;
  }
  host.cloudDisclosureOffer = null;
  if (choice === 'cancel') {
    host.status = 'Cancelled. Nothing was sent to Meta.';
    await host.postState();
    return;
  }
  const thread = host.store.get(offer.threadId);
  const planned = thread === undefined ? null : await planFor(host, thread, offer.text, offer.mode, offer.delegatedRun !== null);
  if (planned === null || planned.plan.digest !== digest) {
    host.status = 'The thread, the project decisions, or the Meta model changed since this was shown. Nothing was sent; send the request again to review it.';
    await host.postState();
    return;
  }
  const scope = currentScope(host);
  recordAnswer(host.cloudDisclosure, offer.threadId, planned.plan, choice === 'include', Date.now(), scope);
  if (planned.plan.askToolResults) {
    host.cloudToolGrants.set(grantKey(offer.threadId, scope), toolResults === true);
  }
  persist(host);
  host.activeThreadId = offer.threadId;
  host.delegatedRun = offer.delegatedRun;
  host.pinnedRunRoot = offer.delegatedRun?.root ?? host.pinnedRunRoot;
  try {
    await host.executeSend(offer.threadId, offer.text, offer.mode, 'cloud', offer.agentTarget ?? undefined);
  } finally {
    if (offer.delegatedRun !== null) {
      host.delegatedRun = null;
      host.pinnedRunRoot = null;
    }
  }
}

/** Withdraw every answer for a thread: Meta gets nothing more from it until the user answers again. */
export async function stopSharing(host: ProviderHost, threadId: string | null): Promise<void> {
  if (threadId === null || host.running) {
    host.status = host.running ? 'A request is running. Stop it first; nothing was changed.' : 'Open a thread first.';
    await host.postState();
    return;
  }
  forgetDisclosure(host.cloudDisclosure, threadId);
  for (const key of [...host.cloudToolGrants.keys()]) {
    if (key.startsWith(`${threadId}|`)) {
      host.cloudToolGrants.delete(key);
    }
  }
  if (host.cloudDisclosureOffer?.threadId === threadId) {
    host.cloudDisclosureOffer = null;
  }
  persist(host);
  host.status = 'Stopped sharing this thread with Meta: nothing more from its local sessions, its project decisions, or tool results is sent until you approve it again. What Meta already received cannot be recalled.';
  await host.postState();
}

/** What the thread shares with Meta now, for the view (null when nothing was ever answered). */
export function sharingView(host: ProviderHost, threadId: string | null): { messages: number; decisions: 'shared' | 'withheld' | null; toolResults: boolean | null } | null {
  if (threadId === null || host.cloudDisclosure === undefined) {
    return null;
  }
  // For the model selected now: what its class and the current API key share.
  const scope = currentScope(host);
  const record = host.cloudDisclosure?.threads.find((entry) => entry.threadId === threadId && entry.processing === scope.processing && entry.credential === scope.credential) ?? null;
  const thread = host.store.get(threadId);
  const messages = record !== null && thread !== undefined ? sharedLocalCount(thread, record) : 0;
  const decisions = record?.decisions ? (record.decisions.allowed ? 'shared' : 'withheld') : null;
  const key = grantKey(threadId, scope);
  const toolResults = host.cloudToolGrants?.has(key) ? host.cloudToolGrants.get(key) === true : null;
  return messages === 0 && decisions === null && toolResults === null ? null : { messages, decisions, toolResults };
}

/**
 * The thread a request may see: all of it locally (without RAME's retrieval
 * statistics, which would only accumulate); for Meta, only what the user
 * disclosed.
 */
export function threadForRun(host: ProviderHost, threadId: string, provider: 'local' | 'cloud', text: string): ChatThread | undefined {
  const thread = host.store.get(threadId);
  if (thread === undefined) {
    return undefined;
  }
  return provider === 'local' ? withoutRetrievalLines(thread) : cloudVisibleThread(thread, text, threadDisclosure(host.cloudDisclosure, threadId, runScope(host, threadId)));
}

/** The scope of the Meta request running for this thread (fixed at its card), else the current one. */
export function runScope(host: ProviderHost, threadId: string): DisclosureScope {
  const run = host.cloudRun;
  return run !== null && run.threadId === threadId ? { processing: run.processing, credential: run.credential } : currentScope(host);
}

/** Local-session messages a Meta request leaves out, so the model can be told (0 for local runs). */
export function withheldForRun(host: ProviderHost, threadId: string, provider: 'local' | 'cloud', text: string): number {
  const thread = host.store.get(threadId);
  return thread === undefined || provider === 'local' ? 0 : withheldLocalCount(thread, text, threadDisclosure(host.cloudDisclosure, threadId, runScope(host, threadId)));
}

/**
 * Project memory as a Meta run may see it (null for local runs): only the
 * decisions the user approved on the card, exactly as shown, or a note that
 * none are shared. Never pending proposals, file bindings, or provenance.
 */
export function cloudMemoryText(host: ProviderHost, label: string): string | null {
  const run = host.cloudRun;
  if (run === null) {
    return null;
  }
  if (!run.allowed || run.decisions.length === 0) {
    return `PROJECT MEMORY (${label}): not shared with Meta. The user has not approved sending this project's decisions to Meta in this thread; do not assume any project decision.`;
  }
  return [
    `AUTHORIZED MEMORY for project "${label}" shared with Meta (exactly the versions the user approved for Meta; nothing else from project memory is shared):`,
    ...run.decisions.map((decision) => `- ${decision.key} = ${JSON.stringify(decision.value)} (v${decision.version})`),
  ].join('\n');
}
