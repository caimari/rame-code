/**
 * Host side of the two Meta paths outside Missions (see remoteAuthority.ts):
 * Advisory consultations (Glimmer stays in control) and delegated runs
 * (Spark proposes the tools of one request). Every send needs its own
 * approval, bound by digest; failures are classified, recorded without
 * credentials or payloads, never retried automatically, and never turned
 * into a recovery or into the other path.
 */

import { autonomyView, currentScopeId, finishExternal, fullMetaNow, fullMetaRefusalNow, recordExternal, settleMetaTokens, trackFullMeta, type FullMetaUse } from './autonomyHost.js';
import { META_PROVIDER } from './autonomyPolicy.js';
import * as os from 'node:os';
import * as path from 'node:path';

import { redactSecrets, scrubLocalPaths } from './cloudEgress.js';
import { withoutWebLines } from './missionWeb.js';

import { checkAgentRelPath, MAX_AGENT_STEPS } from './agentPolicy.js';
import { hashContent } from './agentPatch.js';
import { buildConsultPayload, buildVerificationPrompt, CONSULT_OFFER_TTL_MS, cascadeAdviceSchema, formatAdvisory, validateCascadeAdvice, type CascadeAdvice } from './cascade.js';
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
import { advisorFor, mainModelOf, missionMain } from './advisorHost.js';
import { advisorGeneration, safeCheckExcerpt } from './advisorRequest.js';
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

/**
 * For an Agent offer outside a Mission: the text Full Access may send without
 * the card (secrets removed, local paths hidden, web lines left out) and the
 * workspace it belongs to. Kept only until the offer is used or replaced.
 */
const autoPayloads = new WeakMap<object, { payload: string; withOutput: string | null; scopeId: string }>();

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
    /** The raw end of the failing check's output (made safe here; advisorRequest.ts). */
    checkOutput?: string;
    /** For a blocked Mission: the Mission, and the project files the user may choose to include. */
    missionId?: string;
    files?: string[];
  },
): void {
  if (!host.settings.allowCloudEscalation) {
    host.status = `${host.status} Asking Meta for advice needs cloud escalation ON in Settings; nothing was sent.`;
    return;
  }
  // The advisor of the main model that ran (never that model itself), chosen in Settings → Security → Escalation.
  const main = input.missionId !== undefined ? missionMain(host, input.missionId) : mainModelOf(host);
  const advisor = advisorFor(host, main);
  if (!advisor.ok) {
    host.status = `${host.status} No advisor to consult: ${advisor.reason}. Nothing was sent.`;
    return;
  }
  const model = advisor.model;
  // The end of the failing check's output: on the card as part of the exact text; never when it cannot be made safe.
  const folders: Array<[string, string]> = [[input.root, '<project folder>'], [os.homedir(), '~']];
  const excerpt = input.checkOutput ? safeCheckExcerpt(input.checkOutput, folders) : null;
  const checkOutput = excerpt?.ok ? excerpt.text : undefined;
  const cardInput = {
    task: input.task,
    reason: input.reason,
    hostRecord: input.hostRecord,
    decisions: host.memory.listCurrentDecisions(input.scopeId).map((entry) => ({ key: entry.key, value: entry.value, version: entry.version })),
    verifier: input.verifier,
  };
  // By default the card's exact text has no output: the user includes it (and sees the new text) on the card.
  const payload = buildConsultPayload(cardInput);
  const outputPayload = checkOutput !== undefined ? buildConsultPayload({ ...cardInput, checkOutput }) : undefined;
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
    localModel: main.model,
    mainProvider: main.provider,
    ...(outputPayload !== undefined ? { outputPayload, outputIncluded: false } : {}),
    digest: advisoryDigest(payload, model, input.threadId, 0),
    createdAt: Date.now(),
    generation: host.agentGeneration,
    fileCandidates: input.files ?? filesReadInRecord(input.hostRecord),
    authorizedFiles: [],
    attempts: 0,
    lastFailure: null,
    ...(input.missionId ? { missionId: input.missionId } : {}),
  };
  // What Full Access may send instead of the card (Agent's advice, or a blocked Mission's): never a file.
  const protect = (text: string) => scrubLocalPaths(redactSecrets(text).text, [[input.root, '<project folder>'], [os.homedir(), '~']]);
  const decisions = host.memory.listCurrentDecisions(input.scopeId).map((entry) => ({ key: entry.key, value: entry.value, version: entry.version }));
  const autoInput = { task: protect(input.task), reason: protect(input.reason), hostRecord: withoutWebLines(input.hostRecord).map(protect), decisions, verifier: input.verifier };
  const auto = buildConsultPayload(autoInput);
  // With the output only under a data scope that includes fragments (checked when it is sent).
  const withOutput = checkOutput !== undefined ? protect(buildConsultPayload({ ...autoInput, checkOutput })) : null;
  autoPayloads.set(host.consultOffer, { payload: protect(auto), withOutput, scopeId: input.scopeId });
  if (excerpt !== null && !excerpt.ok) {
    host.status = `${host.status} The failing check's output is not included: ${excerpt.reason}.`;
  }
  host.status = `${host.status} You can ask Meta ${model} for advice with the exact text shown, or dismiss.`;
}

/**
 * The user chose which files read in the run may be sent with their exact
 * content. The payload changes, so it needs a new approval of the new text.
 */
export async function includeConsultFiles(host: ProviderHost, digest: string, files: readonly string[], output?: boolean): Promise<void> {
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
  // The failing check's output: only when the user includes it here, and only when it was made safe.
  const withOutput = (output ?? offer.outputIncluded === true) && offer.outputPayload !== undefined;
  const payload = (withOutput ? (offer.outputPayload as string) : offer.basePayload) + authorizedFilesSection(offer.project, authorized);
  host.consultOffer = {
    ...offer,
    outputIncluded: withOutput,
    payload,
    authorizedFiles: authorized.map((file) => ({ path: file.path, sha256: file.sha256, truncated: file.truncated })),
    digest: advisoryDigest(payload, offer.model, offer.threadId, offer.attempts),
    createdAt: Date.now(),
  };
  const outputWords = withOutput ? " and the end of the failing check's output (secrets removed, local folders hidden)" : '';
  host.status =
    authorized.length > 0
      ? `Review the exact text again: it now includes the content of ${authorized.length} file(s) from ${offer.project}${outputWords}. Nothing was sent yet.`
      : `Review the exact text again: no file contents are included${withOutput ? `, but it includes${outputWords.replace(/^ and/, '')}` : ''}. Nothing was sent yet.`;
  await host.postState();
}

/**
 * Full Access with its Meta part (Autonomy & Permissions): send the advice
 * offer just made (Agent's, or a blocked Mission's) without its card, once,
 * within the Meta pre-authorization in force, counted per conversation or
 * Mission. Only the run's text and the host's notes go,
 * with secrets removed, local paths hidden and web lines left out; never a
 * file. Anything that does not fit keeps the card; nothing is retried by
 * itself. True when it was sent (or tried).
 */
export async function autoConsult(host: ProviderHost): Promise<boolean> {
  const offer = host.consultOffer;
  const auto = offer === null ? undefined : autoPayloads.get(offer);
  if (offer === null || auto === undefined || offer.attempts !== 0 || offer.authorizedFiles.length > 0 || busy(host)) {
    return false;
  }
  const key = offer.missionId ?? offer.threadId;
  const why = fullMetaRefusalNow(host, auto.scopeId, { dataScope: 'instructions', key });
  const apiKey = why === null ? await host.getApiKey() : undefined;
  if (why !== null || !apiKey || auto.payload.includes(apiKey)) {
    return false;
  }
  // The check's output goes only when the pre-authorization's data scope includes fragments.
  const withOutput = auto.withOutput !== null && !auto.withOutput.includes(apiKey) && fullMetaRefusalNow(host, auto.scopeId, { dataScope: 'files', key }) === null;
  const text = withOutput ? (auto.withOutput as string) : auto.payload;
  autoPayloads.delete(offer);
  const sent = { ...offer, basePayload: text, payload: text, digest: advisoryDigest(text, offer.model, offer.threadId, 0), createdAt: Date.now() };
  host.consultOffer = sent;
  await approveConsult(host, sent.digest, { scopeId: auto.scopeId, key, card: offer, withOutput });
  return true;
}

/** The user approved this exact payload (or Full Access sent it: `full`): ask Meta once, then verify locally. */
export async function approveConsult(host: ProviderHost, digest: string, full?: { scopeId: string; key: string; card: NonNullable<ProviderHost['consultOffer']>; withOutput?: boolean }): Promise<void> {
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
  if (offer.payload.includes(apiKey)) {
    host.consultOffer = null;
    host.status = 'The consultation text contains the API key. Nothing was sent.';
    await host.postState();
    return;
  }
  // One use: from here on this approval can never be used again.
  host.consultOffer = null;
  const files = offer.authorizedFiles.map((file) => file.path);
  const lines = [
    `advisory: ${offer.mainProvider === 'cloud' ? 'Ask the advisor model for advice — the main model remains in control' : ADVISORY_TITLE}; ${offer.localModel} keeps the tools, Meta ${offer.model} gets none`,
    `advisory: the local run stopped for a capability reason: ${offer.reason}`,
    `advisory: ${full ? 'Full Access (Meta part) sent, within the Meta pre-authorization,' : 'you approved sending'} ${offer.payload.length} characters to Meta ${offer.model} (digest ${offer.digest.slice(0, 12)}…)${full ? ` without its card: the run's text and the host's notes${full.withOutput ? ", and the end of the failing check's output" : ''}, secrets removed, local paths and web lines left out` : ''}; ${
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
  let entryId = '';
  const scopeOf = full?.scopeId ?? (offer.missionId !== undefined ? host.missions.get(offer.missionId)?.scopeId : undefined) ?? currentScopeId(host);
  let use: FullMetaUse | null = null;
  let fullRefused: string | null = null;
  let tracked: { signal: AbortSignal; done: () => void } | null = null;
  try {
    // The advisor's own settings (its profile and reasoning, its output cap), never the main model's.
    const generation = advisorGeneration(host.settings.generation, offer.model);
    const { request } = host.generationRequest(generation, { messages: [{ role: 'user', content: offer.payload }] });
    const result = await host.chatRunner.start(async ({ signal }) =>
      createCascadeAdvice({
        apiKey,
        model: offer.model,
        payload: offer.payload,
        schema: cascadeAdviceSchema,
        generation: request,
        signal,
        fetchImpl: async (input, init) => {
          if (full) {
            // Checked again right before it leaves, on the stored policy; the tokens and the count are reserved in the same step.
            const bytes = typeof init?.body === 'string' ? Buffer.byteLength(init.body, 'utf8') : Number.POSITIVE_INFINITY;
            const got = await fullMetaNow(host, full.scopeId, { dataScope: full.withOutput ? 'files' : 'instructions', key: full.key }, bytes + request.maxCompletionTokens);
            if (!got.ok) {
              fullRefused = got.why;
              throw new DOMException('Refused: Full Access does not cover this consultation now.', 'AbortError');
            }
            use = got.use;
            tracked = trackFullMeta(host, full.scopeId, got.use);
          }
          sent = true;
          // Recorded before it leaves (Autonomy & Permissions history): approved on its card, exact text; or by Full Access.
          entryId = await recordExternal(host, scopeOf, {
            provider: META_PROVIDER, destination: offer.model, reason: `advice: ${offer.reason}`.slice(0, 300),
            data: full
              ? `the run's text and the host's notes${full.withOutput ? ", the end of the failing check's output" : ''}, secrets removed, no file and no web page (digest ${offer.digest.slice(0, 12)}…)`
              : `the exact text approved on the card (digest ${offer.digest.slice(0, 12)}…)${files.length > 0 ? `; files: ${files.join(', ')}` : ''}`,
            approval: full ? 'full-access' : 'card', preauthId: use?.metaId ?? null, missionId: offer.missionId ?? null, bytes: Buffer.byteLength(offer.payload, 'utf8'),
          });
          const signals = [init?.signal, tracked?.signal].filter((entry): entry is AbortSignal => entry instanceof AbortSignal);
          return fetch(input, signals.length > 1 ? { ...init, signal: AbortSignal.any(signals) } : init);
        },
      }),
    );
    await finishExternal(host, scopeOf, entryId, `answered (in ${result.usage.inputTokens} / out ${result.usage.outputTokens} tokens)`);
    const used = use as FullMetaUse | null;
    if (used !== null) {
      await settleMetaTokens(host, scopeOf, used.metaId, used.reserved, result.usage.inputTokens + result.usage.outputTokens);
    }
    (tracked as { done: () => void } | null)?.done();
    host.recordUsage('cloud', result.usage);
    advice = validateCascadeAdvice(JSON.parse(result.content) as unknown);
    host.cloudConfirmed = true;
    recordAdvisory(host, offer.threadId, offer.model, { usage: result.usage });
    lines.push(`advisory: attempt ${offer.attempts + 1}: Meta ${offer.model} answered (in ${result.usage.inputTokens} / out ${result.usage.outputTokens} tokens); a valid answer`);
  } catch (error) {
    (tracked as { done: () => void } | null)?.done();
    if (full && !sent) {
      // Nothing left: the card comes back with the exact text, for the user to approve or dismiss.
      const used = use as FullMetaUse | null;
      if (used !== null) {
        await settleMetaTokens(host, scopeOf, used.metaId, used.reserved, 0);
      }
      host.running = false;
      host.connection = 'ready';
      host.consultOffer = { ...full.card, createdAt: Date.now() };
      host.status = `Not sent to Meta without its card: ${fullRefused ?? 'it was cancelled before it left'}. The card shows the exact text: approve it or dismiss.`;
      await host.postState();
      return;
    }
    const failure = classifyMetaFailure(error, [apiKey]);
    host.cloudConfirmed = host.cloudConfirmed && failure.category !== 'authentication';
    recordAdvisory(host, offer.threadId, offer.model, { error, sent });
    await finishExternal(host, scopeOf, entryId, `failed: ${describeMetaFailure(failure)}`.slice(0, 300));
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
        : `The Meta advice failed (${META_FAILURE_LABELS[failure.category]}). Nothing was retried and nothing changed. Continue with ${offer.localModel}, or approve the same text again to retry once.`;
    record(host, offer.threadId, 'Cascade stopped before the local verification run.', lines);
    await host.postState();
    return;
  }
  lines.push(`advisory: advice kept only as untrusted data (${advice.steps.length} step(s), ${advice.checks.length} check(s)); it wrote nothing`);
  host.running = false;
  if (offer.missionId !== undefined) {
    await keepAdviceForMission(host, offer, advice, lines);
    return;
  }
  const prompt = buildVerificationPrompt({ task: offer.task, reason: offer.reason, model: offer.model, advice }).slice(0, 7900);
  host.cascadeVerification = { threadId: offer.threadId };
  host.pinnedRunRoot = offer.root;
  host.hostPromptText = prompt.trim();
  host.lastAgentOutcome = null;
  try {
    // The main model that asked continues with the advice: never another one.
    await host.sendMessage(prompt, 'agent', providerToRuntime(offer.mainProvider ?? 'local'));
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

/**
 * Advice for a blocked Mission: kept, as untrusted data, for the Mission's
 * next internal run. Nothing runs and the Mission stays blocked until the
 * user retries it; Glimmer keeps the tools and the host's checks decide.
 */
async function keepAdviceForMission(host: ProviderHost, offer: NonNullable<ProviderHost['consultOffer']>, advice: CascadeAdvice, lines: string[]): Promise<void> {
  const mission = host.missions.get(offer.missionId as string);
  let kept = false;
  if (mission !== null && mission.status === 'blocked' && mission.auto !== null) {
    const saved = await host.missions.update(mission.id, mission.revision, (draft) => {
      if (draft.auto === null) {
        return { ok: false, error: 'This Mission was never started.' };
      }
      draft.auto.pendingAdvice = formatAdvisory(offer.model, advice).slice(0, 4000);
      return { ok: true, value: draft };
    });
    kept = saved.ok;
  }
  lines.push(
    kept
      ? `advisory: kept for the blocked Mission’s next run only; the Mission stays blocked until you retry it, ${offer.localModel} keeps the tools and the host’s checks still decide`
      : 'advisory: the Mission is no longer blocked or could not be saved, so the advice was not kept for it',
  );
  record(host, offer.threadId, kept ? 'Advice kept for the blocked Mission.' : 'Advice not kept.', lines);
  host.status = kept
    ? `Meta ${offer.model} answered. Nothing ran: the advice waits for the Mission's next run. Retry the Mission to let ${offer.localModel} try with it, or leave it blocked.`
    : 'Meta answered, but the Mission is no longer blocked; the advice was not kept.';
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
  // After the run ended (an offer made later from Settings): the thread's own folder.
  const root = mode === 'agent' ? (host.agentRunWorkspace?.root ?? thread?.workspaceRoot ?? null) : null;
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
  let state = delegationStateFor(host, threadId, keyStored);
  if (state === 'offered' && !offerDelegation(host, threadId, reason)) {
    state = 'internal';
  }
  if (unreachable && host.consultOffer !== null && host.consultOffer.threadId === threadId) {
    // A stopped or misconfigured server is not a reproducible blocker: no Advisory.
    host.consultOffer = null;
  }
  host.localIssue = { threadId, kind: unreachable ? 'unreachable' : 'failed', canStart: unreachable && canStartLocal(host), delegation: state, reason };
  return state;
}

/** Which Spark action the card of a failed local request in this thread may show, by the current settings. */
function delegationStateFor(host: ProviderHost, threadId: string, keyStored: boolean): DelegationState {
  const thread = host.store.get(threadId);
  const last = [...(thread?.turns ?? [])].reverse().find((turn) => turn.kind === 'user');
  const internal =
    host.missionAuto !== null || host.activeMission !== null || host.cascadeVerification !== null || last === undefined || last.kind !== 'user' || last.host === true;
  if (internal) {
    return 'internal';
  }
  const mode = last.mode ?? host.settings.mode;
  return !host.settings.allowCloudEscalation ? 'off' : mode !== 'agent' ? 'not-agent' : !keyStored ? 'no-key' : 'offered';
}

/**
 * Settings or the key changed while the card of a failed local request is
 * shown: turning cloud escalation ON (with a key) now offers "Run this request
 * with Spark", which still waits for the user's approval; turning it OFF or
 * clearing the key withdraws a waiting offer. Nothing is sent here.
 */
export function refreshLocalIssueDelegation(host: ProviderHost): void {
  const issue = host.localIssue;
  if (issue === null || issue.threadId === null || host.running || !['off', 'no-key', 'not-agent', 'offered'].includes(issue.delegation)) {
    return;
  }
  let state = delegationStateFor(host, issue.threadId, host.hasKey);
  if (state === issue.delegation) {
    return;
  }
  if (state === 'offered') {
    if (!offerDelegation(host, issue.threadId, issue.reason ?? 'The local request failed. You can send this request to Meta explicitly, or dismiss.')) {
      state = 'internal';
    }
  } else if (host.delegationOffer !== null && host.delegationOffer.threadId === issue.threadId) {
    host.delegationOffer = null;
    host.escalation = { pending: false, reason: '' };
  }
  host.localIssue = { ...issue, delegation: state };
}

/** RAME Code owns a configured server it could start (no external endpoint is used). */
function canStartLocal(host: ProviderHost): boolean {
  const local = host.settings.local;
  return host.settings.externalLocalEndpoint.trim().length === 0 && local.executablePath.trim().length > 0 && local.modelPath.trim().length > 0;
}

/**
 * The local server answered that it has no model ready: a setup problem of
 * that server. Neither a delegated run nor Advisory is offered for it, and a
 * pending offer for the thread is withdrawn; the user loads the model there.
 */
export function localSetupIssue(host: ProviderHost, threadId: string): void {
  if (host.consultOffer !== null && host.consultOffer.threadId === threadId) {
    host.consultOffer = null;
  }
  if (host.delegationOffer !== null && host.delegationOffer.threadId === threadId) {
    host.delegationOffer = null;
    host.escalation = { pending: false, reason: '' };
  }
  host.localIssue = { threadId, kind: 'setup', canStart: false, delegation: 'setup' };
}

/** The local server is stopped, so the request was refused before it was sent or stored. */
export function localNotRunning(host: ProviderHost, threadId: string | null): void {
  host.localIssue = { threadId, kind: 'unreachable', canStart: canStartLocal(host), delegation: 'not-sent' };
}

/**
 * Withdraw a delegated-run offer that can no longer be approved (older than
 * DELEGATION_OFFER_TTL_MS, or gone while the card still waits), so the view
 * stops showing a card whose button can only be refused. True if it did.
 */
export function expireDelegationOffer(host: ProviderHost, now: number = Date.now()): boolean {
  const offer = host.delegationOffer;
  const expired = offer !== null && now - offer.createdAt > DELEGATION_OFFER_TTL_MS;
  const orphan = offer === null && host.escalation.pending;
  if (!expired && !orphan) {
    return false;
  }
  host.delegationOffer = null;
  host.escalation = { pending: false, reason: '' };
  return true;
}

export async function approveDelegation(host: ProviderHost, digest: string): Promise<void> {
  if (expireDelegationOffer(host)) {
    host.status = `That offer to run the request with Spark expired (offers last ${DELEGATION_OFFER_TTL_MS / 60_000} minutes). Nothing was sent; send the request again to get a new one.`;
    await host.postState();
    return;
  }
  const offer = host.delegationOffer;
  if (offer === null || !host.escalation.pending || offer.digest !== digest) {
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
  const entryId = await recordExternal(host, currentScopeId(host), {
    provider: META_PROVIDER, destination: offer.model, reason: `delegated run: ${offer.reason}`.slice(0, 300), data: offer.dataClasses.join('; '), approval: 'card', preauthId: null, missionId: null, bytes: null,
  });
  try {
    await host.executeSend(thread.id, offer.text, offer.mode, 'cloud');
    await finishExternal(host, currentScopeId(host), entryId, `run ended: ${host.status}`.slice(0, 300));
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
    autonomy: autonomyView(host),
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
            outputAvailable: offer.outputPayload !== undefined,
            outputIncluded: offer.outputIncluded === true,
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
        : {
            kind: host.localIssue.kind,
            canStart: host.localIssue.canStart,
            delegation: host.localIssue.delegation,
            ...(typeof host.localIssue.reload === 'number' ? { reload: host.localIssue.reload } : {}),
            ...(host.localIssue.context === true ? { context: true as const } : {}),
          },
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
