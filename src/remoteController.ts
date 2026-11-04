/**
 * Host side of the two Meta paths outside Missions (see remoteAuthority.ts):
 * Advisory consultations (Glimmer stays in control) and delegated runs
 * (Spark proposes the tools of one request). Every send needs its own
 * approval, bound by digest; failures are classified, recorded without
 * credentials or payloads, never retried automatically, and never turned
 * into a recovery or into the other path.
 */

import * as path from 'node:path';

import { checkAgentRelPath, MAX_AGENT_STEPS } from './agentPolicy.js';
import { hashContent } from './agentPatch.js';
import { buildConsultPayload, buildVerificationPrompt, CONSULT_OFFER_TTL_MS, cascadeAdviceSchema, validateCascadeAdvice, type CascadeAdvice } from './cascade.js';
import { MAX_HOST_RECORD_LINE_LENGTH } from './hostRecord.js';
import { createCascadeAdvice } from './meta-provider.js';
import { classifyMetaFailure, describeMetaFailure, META_FAILURE_LABELS } from './metaFailures.js';
import { recordAdvisory } from './modelEvidenceRecorder.js';
import type { AgentOutcomeRecord, ProviderHost } from './providerTypes.js';
import {
  ADVISORY_DATA_CLASSES,
  ADVISORY_TITLE,
  advisoryDigest,
  authorizedFilesSection,
  DELEGATED_TITLE,
  delegatedDataClasses,
  DELEGATION_OFFER_TTL_MS,
  delegationBudget,
  delegationDigest,
  filesReadInRecord,
  MAX_AUTHORIZED_FILE_CHARS,
  MAX_AUTHORIZED_FILES,
  type AuthorizedFile,
  type DelegationOffer,
  type DelegationState,
} from './remoteAuthority.js';
import type { LocalRuntimeLifecycle } from './localRuntime.js';
import type { RemoteView } from './remoteViews.js';
import { providerToRuntime } from './settingsStore.js';
import { appendHostNoteTurn } from './threadStore.js';
import { sharingView } from './cloudDisclosureHost.js';
import { isContributorClass, processingClass } from './metaRecipient.js';
import { agentSentText } from './agentHistoryText.js';
import type { OfferedMessage } from './cloudDisclosure.js';
import { localSourceView } from './localSourceState.js';

function record(host: ProviderHost, threadId: string, text: string, lines: string[]): void {
  const current = host.store.get(threadId);
  if (current) {
    host.store.save(appendHostNoteTurn(current, text, lines.map((line) => `• ${line}`.slice(0, MAX_HOST_RECORD_LINE_LENGTH))));
  }
}

function busy(host: ProviderHost): boolean {
  return host.running || host.missionRunner.isRunning || host.chatRunner.isRunning || host.agentRunner.isRunning;
}

// ---- Advisory --------------------------------------------------------------

/** After a local capability stop: prepare the exact Advisory text for approval. */
export function offerConsult(
  host: ProviderHost,
  input: {
    threadId: string;
    root: string;
    task: string;
    reason: string;
    hostRecord: string[];
    scopeId: string;
    verifier: { commandId: string; exitCode: number | null } | null;
  },
): void {
  if (!host.settings.allowCloudEscalation) {
    host.status = `${host.status} Asking Meta for advice needs cloud escalation ON in Settings; nothing was sent.`;
    return;
  }
  const model = host.selectedCloudModel();
  const payload = buildConsultPayload({
    task: input.task,
    reason: input.reason,
    hostRecord: input.hostRecord,
    decisions: host.memory.listCurrentDecisions(input.scopeId).map((entry) => ({ key: entry.key, value: entry.value, version: entry.version })),
    verifier: input.verifier,
  });
  host.consultOffer = {
    threadId: input.threadId,
    root: input.root,
    project: path.basename(input.root),
    task: input.task,
    reason: input.reason,
    verifier: input.verifier,
    basePayload: payload,
    payload,
    model,
    localModel: host.generationModel('local'),
    digest: advisoryDigest(payload, model, input.threadId, 0),
    createdAt: Date.now(),
    generation: host.agentGeneration,
    fileCandidates: filesReadInRecord(input.hostRecord),
    authorizedFiles: [],
    attempts: 0,
    lastFailure: null,
  };
  host.status = `${host.status} You can ask Meta ${model} for advice with the exact text shown, or dismiss.`;
}

/**
 * The user chose which files read in the run may be sent with their exact
 * content. The payload changes, so it needs a new approval of the new text.
 */
export async function includeConsultFiles(host: ProviderHost, digest: string, files: readonly string[]): Promise<void> {
  const offer = host.consultOffer;
  if (offer === null || offer.digest !== digest) {
    host.status = 'That consultation is no longer valid. Nothing was sent.';
    await host.postState();
    return;
  }
  if (files.length > MAX_AUTHORIZED_FILES || files.some((file) => !offer.fileCandidates.includes(file))) {
    host.status = `Only files this run read can be included, at most ${MAX_AUTHORIZED_FILES}. Nothing was sent.`;
    await host.postState();
    return;
  }
  const fs = host.agentFsFor(offer.root);
  const apiKey = (await host.getApiKey()) ?? '';
  const authorized: AuthorizedFile[] = [];
  for (const file of files) {
    const gate = checkAgentRelPath(file);
    let content: string | null = null;
    try {
      content = gate.ok && (await fs.stat(file)).kind === 'file' ? await fs.readText(file) : null;
    } catch {
      content = null;
    }
    if (content === null || (apiKey.length > 0 && content.includes(apiKey))) {
      host.status = `${file} cannot be included. Nothing was sent.`;
      await host.postState();
      return;
    }
    const truncated = content.length > MAX_AUTHORIZED_FILE_CHARS;
    authorized.push({ path: file, sha256: hashContent(content), content: content.slice(0, MAX_AUTHORIZED_FILE_CHARS), truncated });
  }
  const payload = offer.basePayload + authorizedFilesSection(offer.project, authorized);
  host.consultOffer = {
    ...offer,
    payload,
    authorizedFiles: authorized.map((file) => ({ path: file.path, sha256: file.sha256, truncated: file.truncated })),
    digest: advisoryDigest(payload, offer.model, offer.threadId, offer.attempts),
    createdAt: Date.now(),
  };
  host.status =
    authorized.length > 0
      ? `Review the exact text again: it now includes the content of ${authorized.length} file(s) from ${offer.project}. Nothing was sent yet.`
      : 'Review the exact text again: no file contents are included. Nothing was sent yet.';
  await host.postState();
}

/** The user approved this exact payload: ask Meta once, then verify locally. */
export async function approveConsult(host: ProviderHost, digest: string): Promise<void> {
  const offer = host.consultOffer;
  const expired = offer !== null && Date.now() - offer.createdAt > CONSULT_OFFER_TTL_MS;
  if (offer === null || offer.digest !== digest || offer.generation !== host.agentGeneration || expired) {
    if (expired) {
      host.consultOffer = null;
    }
    host.status = 'That consultation approval is no longer valid. Nothing was sent.';
    await host.postState();
    return;
  }
  if (busy(host)) {
    host.status = 'A request is already running. Cancel it or wait before sending to Meta. Nothing was sent.';
    await host.postState();
    return;
  }
  if (!host.settings.allowCloudEscalation) {
    host.status = 'Cloud escalation is OFF. Nothing was sent.';
    await host.postState();
    return;
  }
  const apiKey = await host.getApiKey();
  if (!apiKey) {
    host.status = 'No Meta Model API key is stored. Save one in Settings or choose a local runtime.';
    await host.postState();
    return;
  }
  // One use: from here on this approval can never be used again.
  host.consultOffer = null;
  const files = offer.authorizedFiles.map((file) => file.path);
  const lines = [
    `advisory: ${ADVISORY_TITLE}; ${offer.localModel} keeps the tools, Meta ${offer.model} gets none`,
    `advisory: the local run stopped for a capability reason: ${offer.reason}`,
    `advisory: you approved sending ${offer.payload.length} characters to Meta ${offer.model} (digest ${offer.digest.slice(0, 12)}…); ${
      files.length > 0 ? `file contents you authorized: ${files.join(', ')}` : 'no file contents were included'
    }`,
  ];
  host.activeThreadId = offer.threadId;
  host.running = true;
  host.connection = 'working';
  host.status = `Asking Meta ${offer.model} for advice with the approved text only…`;
  await host.postState();
  let sent = false;
  let advice: CascadeAdvice;
  try {
    const generation = await host.snapshotGeneration('cloud');
    const { request } = host.generationRequest(generation, { messages: [{ role: 'user', content: offer.payload }] });
    const result = await host.chatRunner.start(async ({ signal }) =>
      createCascadeAdvice({
        apiKey,
        model: offer.model,
        payload: offer.payload,
        schema: cascadeAdviceSchema,
        generation: request,
        signal,
        fetchImpl: (input, init) => {
          sent = true;
          return fetch(input, init);
        },
      }),
    );
    host.recordUsage('cloud', result.usage);
    advice = validateCascadeAdvice(JSON.parse(result.content) as unknown);
    host.cloudConfirmed = true;
    recordAdvisory(host, offer.threadId, offer.model, { usage: result.usage });
    lines.push(`advisory: attempt ${offer.attempts + 1}: Meta ${offer.model} answered (in ${result.usage.inputTokens} / out ${result.usage.outputTokens} tokens); a valid answer`);
  } catch (error) {
    const failure = classifyMetaFailure(error, [apiKey]);
    host.cloudConfirmed = host.cloudConfirmed && failure.category !== 'authentication';
    recordAdvisory(host, offer.threadId, offer.model, { error, sent });
    const counted = sent || failure.category !== 'cancelled';
    lines.push(
      `advisory: attempt ${counted ? offer.attempts + 1 : `${offer.attempts + 1} cancelled before sending, not counted`}: ${describeMetaFailure(failure)}; no advice was used and nothing was retried`,
      'advisory: the local state and evidence are unchanged; the stop that motivated it is not resolved',
    );
    host.running = false;
    host.connection = failure.category === 'cancelled' ? 'cancelled' : 'error';
    if (failure.category !== 'cancelled') {
      // A new approval of the same text may retry; nothing is retried by itself.
      const attempts = offer.attempts + 1;
      host.consultOffer = {
        ...offer,
        attempts,
        lastFailure: failure.category,
        digest: advisoryDigest(offer.payload, offer.model, offer.threadId, attempts),
        createdAt: Date.now(),
      };
    }
    host.status =
      failure.category === 'cancelled'
        ? 'Request cancelled.'
        : `The Meta advice failed (${META_FAILURE_LABELS[failure.category]}). Nothing was retried and nothing changed. Continue with Glimmer, or approve the same text again to retry once.`;
    record(host, offer.threadId, 'Cascade stopped before the local verification run.', lines);
    await host.postState();
    return;
  }
  lines.push(`advisory: advice kept only as untrusted data (${advice.steps.length} step(s), ${advice.checks.length} check(s)); it wrote nothing`);
  host.running = false;
  const prompt = buildVerificationPrompt({ task: offer.task, reason: offer.reason, model: offer.model, advice }).slice(0, 7900);
  host.cascadeVerification = { threadId: offer.threadId };
  host.pinnedRunRoot = offer.root;
  host.hostPromptText = prompt.trim();
  host.lastAgentOutcome = null;
  try {
    await host.sendMessage(prompt, 'agent', providerToRuntime('local'));
  } finally {
    host.pinnedRunRoot = null;
    host.hostPromptText = null;
    host.cascadeVerification = null;
  }
  const outcome = host.lastAgentOutcome as AgentOutcomeRecord | null;
  if (outcome !== null && outcome.threadId === offer.threadId) {
    const test = outcome.lastTest ? `${outcome.lastTest.commandId} exit=${outcome.lastTest.exitCode ?? 'unknown'}` : 'no test ran';
    lines.push(`advisory: local verification run ${outcome.outcome === 'done' ? 'finished' : `stopped (${outcome.outcome})`}; last test: ${test}`);
  } else {
    lines.push(`advisory: the local verification run did not start (${host.status.slice(0, 160)})`);
  }
  lines.push('advisory: no calibrated policy chose these steps; you approved each one');
  const verified = outcome !== null && outcome.outcome === 'done' && outcome.lastTest?.exitCode === 0;
  record(host, offer.threadId, verified ? 'Cascade finished: the local verification run passed its test.' : 'Cascade finished without a passing local test.', lines);
  await host.postState();
}

export async function dismissConsult(host: ProviderHost): Promise<void> {
  const offer = host.consultOffer;
  host.consultOffer = null;
  if (offer !== null) {
    record(host, offer.threadId, 'Cascade not used.', [
      `advisory: the local run stopped for a capability reason: ${offer.reason}`,
      'advisory: you dismissed the consultation; nothing was sent to Meta',
    ]);
  }
  host.status = 'Consultation dismissed. Nothing was sent to Meta.';
  await host.postState();
}

// ---- Delegated -------------------------------------------------------------

/**
 * After a local request failed: offer to run that same request with Spark.
 * Never for a host-written prompt (a Mission's internal run or an Advisory
 * verification run): that would turn Advisory or a Mission budget into a
 * delegated run. Returns whether an offer was made.
 */
export function offerDelegation(host: ProviderHost, threadId: string, reason: string): boolean {
  const thread = host.store.get(threadId);
  const last = [...(thread?.turns ?? [])].reverse().find((turn) => turn.kind === 'user');
  if (
    host.missionAuto !== null ||
    host.activeMission !== null ||
    host.cascadeVerification !== null ||
    last === undefined ||
    last.kind !== 'user' ||
    last.host === true
  ) {
    return false;
  }
  const text = last.text;
  const mode = last.mode ?? host.settings.mode;
  const root = mode === 'agent' ? (host.agentRunWorkspace?.root ?? null) : null;
  const base: Omit<DelegationOffer, 'digest' | 'createdAt' | 'reason'> = {
    threadId,
    root,
    project: root === null ? null : path.basename(root),
    text,
    mode,
    model: host.selectedCloudModel(),
    profile: host.settings.agentProfile,
    dataClasses: delegatedDataClasses(mode),
    budget: delegationBudget(mode, MAX_AGENT_STEPS),
  };
  host.delegationOffer = { ...base, reason, digest: delegationDigest(base), createdAt: Date.now() };
  host.delegationFailure = null;
  host.escalation = { pending: true, reason };
  return true;
}

/**
 * A local request failed: decide, from its context, which actions to show.
 * A stopped or misconfigured server gets "start it / open its settings";
 * Advisory is never offered for that. "Run this request with Spark" is
 * offered only for a normal Agent request with escalation ON and a key;
 * otherwise it is shown disabled with the reason, and never for a host
 * prompt (a Mission's internal run or an Advisory verification run).
 */
export function localFailure(host: ProviderHost, threadId: string, unreachable: boolean, reason: string, keyStored: boolean): DelegationState {
  const thread = host.store.get(threadId);
  const last = [...(thread?.turns ?? [])].reverse().find((turn) => turn.kind === 'user');
  const internal =
    host.missionAuto !== null || host.activeMission !== null || host.cascadeVerification !== null || last === undefined || last.kind !== 'user' || last.host === true;
  const mode = last !== undefined && last.kind === 'user' ? (last.mode ?? host.settings.mode) : host.settings.mode;
  let state: DelegationState = 'internal';
  if (!internal) {
    state = !host.settings.allowCloudEscalation ? 'off' : mode !== 'agent' ? 'not-agent' : !keyStored ? 'no-key' : 'offered';
  }
  if (state === 'offered' && !offerDelegation(host, threadId, reason)) {
    state = 'internal';
  }
  if (unreachable && host.consultOffer !== null && host.consultOffer.threadId === threadId) {
    // A stopped or misconfigured server is not a reproducible blocker: no Advisory.
    host.consultOffer = null;
  }
  host.localIssue = { threadId, kind: unreachable ? 'unreachable' : 'failed', canStart: unreachable && canStartLocal(host), delegation: state };
  return state;
}

/** RAME Code owns a configured server it could start (no external endpoint is used). */
function canStartLocal(host: ProviderHost): boolean {
  const local = host.settings.local;
  return host.settings.externalLocalEndpoint.trim().length === 0 && local.executablePath.trim().length > 0 && local.modelPath.trim().length > 0;
}

/** The local server is stopped, so the request was refused before it was sent or stored. */
export function localNotRunning(host: ProviderHost, threadId: string | null): void {
  host.localIssue = { threadId, kind: 'unreachable', canStart: canStartLocal(host), delegation: 'not-sent' };
}

export async function approveDelegation(host: ProviderHost, digest: string): Promise<void> {
  const offer = host.delegationOffer;
  if (offer === null || !host.escalation.pending || offer.digest !== digest || Date.now() - offer.createdAt > DELEGATION_OFFER_TTL_MS) {
    host.status = 'That approval does not match a waiting delegated run. Nothing was sent.';
    await host.postState();
    return;
  }
  if (busy(host)) {
    host.status = 'A request is already running. Cancel it or wait before sending to Meta. Nothing was sent.';
    await host.postState();
    return;
  }
  if (!host.settings.allowCloudEscalation) {
    host.status = 'Cloud escalation is OFF. Nothing was sent.';
    await host.postState();
    return;
  }
  // The approval covers this model, profile, and project only.
  const now = { model: host.selectedCloudModel(), profile: host.settings.agentProfile };
  if (now.model !== offer.model || now.profile !== offer.profile || (offer.root !== null && !host.isBoundRootStillOpen(offer.root))) {
    host.status = 'The model, permission profile, or project changed since this was offered. Nothing was sent; ask again.';
    host.delegationOffer = null;
    host.escalation = { pending: false, reason: '' };
    await host.postState();
    return;
  }
  const thread = host.store.get(offer.threadId);
  host.delegationOffer = null;
  host.escalation = { pending: false, reason: '' };
  if (!thread) {
    host.status = 'That thread is no longer stored. Nothing was sent.';
    await host.postState();
    return;
  }
  record(host, offer.threadId, 'Delegated run approved.', [
    `delegated: ${DELEGATED_TITLE}; Meta ${offer.model} proposes the tools, RAME Code checks each one with the ${offer.profile} profile`,
    `delegated: scope ${offer.budget}${offer.project ? ` in project ${offer.project}` : ''}; data that may be sent: ${offer.dataClasses.join('; ')}`,
  ]);
  host.activeThreadId = thread.id;
  host.delegatedRun = { threadId: offer.threadId, root: offer.root, text: offer.text, mode: offer.mode };
  host.pinnedRunRoot = offer.root;
  try {
    await host.executeSend(thread.id, offer.text, offer.mode, 'cloud');
  } finally {
    host.pinnedRunRoot = null;
    host.delegatedRun = null;
  }
}

export async function dismissDelegation(host: ProviderHost): Promise<void> {
  host.delegationOffer = null;
  host.delegationFailure = null;
  host.pendingRequest = null;
  host.escalation = { pending: false, reason: '' };
  host.status = 'Escalation dismissed. Nothing was sent to Meta.';
  await host.postState();
}

/**
 * A delegated run failed at Meta. It does not switch to Glimmer by itself
 * and nothing is retried; actions the host already confirmed stay as they
 * are. A local run of the same request is offered only when it is safe: not
 * after a cancellation, and only from a clean run state.
 */
export function delegationFailed(host: ProviderHost, threadId: string, error: unknown, apiKey: string): string | null {
  const run = host.delegatedRun;
  if (run === null || run.threadId !== threadId) {
    return null;
  }
  const failure = classifyMetaFailure(error, [apiKey]);
  host.cloudConfirmed = host.cloudConfirmed && failure.category !== 'authentication';
  const confirmed = host.agentLogView.filter((entry) => !/reject|refus|denied|not proposed/i.test(entry.decision)).length;
  host.delegationFailure =
    failure.category === 'cancelled'
      ? null
      : { threadId, root: run.root, text: run.text, mode: run.mode, category: failure.category, confirmedActions: confirmed };
  record(host, threadId, 'Delegated run stopped.', [
    `delegated: Meta failed: ${describeMetaFailure(failure)}`,
    `delegated: it was not retried and did not switch to Glimmer; ${confirmed} action(s) confirmed by the host are kept as they are`,
  ]);
  return failure.category === 'cancelled'
    ? 'Request cancelled.'
    : `The delegated run with Meta stopped (${META_FAILURE_LABELS[failure.category]}). It was not retried and did not switch to Glimmer. You can run this request with Glimmer.`;
}

/** After a failed delegated run: the user chose to run the same request locally. */
export async function runDelegationLocally(host: ProviderHost): Promise<void> {
  const failure = host.delegationFailure;
  if (failure === null || busy(host)) {
    host.status = failure === null ? 'There is no failed delegated run to continue. Nothing ran.' : 'A request is already running. Nothing ran.';
    await host.postState();
    return;
  }
  host.delegationFailure = null;
  record(host, failure.threadId, 'Continuing with Glimmer.', [
    'local: you chose to run this request with Glimmer after the delegated run failed; nothing the host already applied is undone or repeated by the host',
  ]);
  host.activeThreadId = failure.threadId;
  host.pinnedRunRoot = failure.root;
  try {
    await host.executeSend(failure.threadId, failure.text, failure.mode, 'local');
  } finally {
    host.pinnedRunRoot = null;
  }
}

/** What the view is shown about both paths, for the open thread only. */
/**
 * The header's runtime line. "connected" needs an answer in this session:
 * a stored key, or a saved endpoint, is only "configured".
 */
export function runtimeView(host: ProviderHost, lifecycle: LocalRuntimeLifecycle): RemoteView['runtime'] {
  const external = host.settings.externalLocalEndpoint.trim();
  let local: RemoteView['runtime']['local'];
  if (lifecycle === 'running' || lifecycle === 'starting') {
    local = lifecycle;
  } else if (external.length > 0) {
    local = host.localConfirmed === external ? 'connected' : 'configured';
  } else {
    local = canStartLocal(host) ? 'stopped' : 'not-configured';
  }
  return { local, cloud: !host.hasKey ? 'not-configured' : host.cloudConfirmed ? 'connected' : 'configured', selected: host.settings.provider };
}

export function remoteView(host: ProviderHost, threadId: string | null, lifecycle: LocalRuntimeLifecycle = 'stopped'): RemoteView {
  const shown = host.cloudDisclosureOffer?.threadId === threadId ? (host.cloudDisclosureOffer ?? null) : null;
  // Agent shortens long earlier messages before sending: preview them as sent,
  // so the card never shows more than Meta would receive.
  const asSent = (entry: OfferedMessage) => ({
    ...entry,
    text: shown?.mode === 'agent' ? (agentSentText(entry.role, entry.text) ?? entry.text) : entry.text,
    hostRecord: [...entry.hostRecord],
  });
  const messages = shown === null ? [] : shown.plan.messages.map(asSent);
  const earlier = shown === null ? [] : shown.plan.earlier.map(asSent);
  const disclosure: RemoteView['disclosure'] = shown === null
    ? null
    : {
        model: shown.model,
        mode: shown.mode,
        delegated: shown.delegatedRun !== null,
        messages,
        earlier,
        decisions: shown.plan.decisions.map((entry) => ({ key: entry.key, version: entry.version, value: entry.value })),
        askToolResults: shown.plan.askToolResults,
        contributor: isContributorClass(processingClass(shown.model)),
        chars: [...messages, ...earlier].reduce((sum, entry) => sum + entry.text.length + entry.hostRecord.join('\n').length, 0),
        digest: shown.plan.digest,
      };
  const offer = host.consultOffer !== null && host.consultOffer.threadId === threadId ? host.consultOffer : null;
  const delegation = host.delegationOffer !== null && host.delegationOffer.threadId === threadId ? host.delegationOffer : null;
  const failure = host.delegationFailure !== null && host.delegationFailure.threadId === threadId ? host.delegationFailure : null;
  return {
    servers: localSourceView(host),
    consult:
      offer === null
        ? null
        : {
            mode: 'advisory',
            localModel: offer.localModel,
            model: offer.model,
            project: offer.project,
            verifier: offer.verifier ? `${offer.verifier.commandId} exit=${offer.verifier.exitCode ?? 'unknown'}` : '',
            dataClasses: [...ADVISORY_DATA_CLASSES],
            fileCandidates: [...offer.fileCandidates],
            authorizedFiles: offer.authorizedFiles.map((file) => file.path),
            attempts: offer.attempts,
            lastFailure: offer.lastFailure,
          },
    delegation:
      delegation === null
        ? null
        : {
            mode: 'delegated',
            model: delegation.model,
            project: delegation.project,
            profile: delegation.profile,
            budget: delegation.budget,
            dataClasses: [...delegation.dataClasses],
            digest: delegation.digest,
          },
    delegationFailure: failure === null ? null : { category: failure.category, confirmedActions: failure.confirmedActions },
    runtime: runtimeView(host, lifecycle),
    localIssue:
      host.localIssue === null || host.localIssue.threadId !== threadId
        ? null
        : { kind: host.localIssue.kind, canStart: host.localIssue.canStart, delegation: host.localIssue.delegation },
    disclosure,
    sharing: sharingView(host, threadId),
    waitingElsewhere: waitingElsewhere(host, threadId),
  };
}

/**
 * A run waiting for an approval or a disclosure choice on another thread
 * (for example a card the model asked again after the user left): its card
 * stays bound to its own thread, and the view offers a way back to it.
 */
function waitingElsewhere(host: ProviderHost, threadId: string | null): RemoteView['waitingElsewhere'] {
  const other = [host.agentPending?.threadId, host.cloudDisclosureOffer?.threadId].find((id) => id !== undefined && id !== threadId);
  if (other === undefined) {
    return null;
  }
  return { threadId: other, title: host.store.get(other)?.title ?? 'another thread' };
}
