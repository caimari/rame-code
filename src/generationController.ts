/**
 * Generation / provider-send logic extracted from mainProvider.
 *
 * Every public function receives a {@link ProviderHost} so the controller
 * never imports VS Code or reaches into the provider class.
 */

import * as remote from './remoteController.js';
import { withBoundedRequest } from './boundedRequest.js';
import {
  REASONING_LABELS,
  UNKNOWN_LOCAL_PROPS,
  automaticOutputTokens,
  cloudGenerationProfile,
  describeBudgetLimit,
  estimatePromptTokens,
  localGenerationProfile,
  parseLlamaServerProps,
  resolveOutputBudget,
  resolveReasoning,
} from './generationSettings.js';
import type {
  GenerationProviderId,
  GenerationRequest,
  LocalServerProps,
  ModelGenerationProfile,
} from './generationSettings.js';
import { createLocalChatCompletion, createLocalMissionPlan } from './localProvider.js';
import { isLocalOrPrivateUrl } from './localServers.js';
import { chatWebOffered, runChatWithWeb } from './chatWeb.js';
import { createChatCompletion, missionPlanSchema, validateMissionPlan } from './meta-provider.js';
import { decisionsForThread, threadForRun, withheldForRun } from './cloudDisclosureHost.js';
import { logPacket } from './continuityLogHost.js';
import { CloudEgressBlocked, guardCloudMessages } from './cloudEgress.js';
import { buildRequestMessages } from './requestBuilder.js';
import {
  appendErrorTurn,
  appendPlanTurn,
  appendAssistantTurn,
} from './threadStore.js';
import type { ChatThread } from './threadStore.js';
import { redactKeyFromText } from './webviewMessages.js';
import { localUnreachableMessage } from './viewMessages.js';
import { formatPlanAsText } from './panelState.js';
import { recordReply } from './modelEvidenceRecorder.js';
import { requestedLocalModel } from './localIdentity.js';
import { classifyMetaFailure } from './metaFailures.js';
import type { ProviderUsage } from './usage.js';
import type { MissionPlan } from './types.js';
import type { ProviderHost, RunGeneration } from './providerTypes.js';
import type { ProviderId } from './settingsStore.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bound for reading the local server's `/props` (loopback only). */
export const LOCAL_PROPS_TIMEOUT_MS = 3000;

const INTERRUPTED_RUN_NOTE =
  'This run was interrupted because VS Code reloaded or closed before it finished. Its outcome was not recorded; check the workspace before retrying.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Append a note to a status string (no-op when note is null). */
export function withNote(status: string, note: string | null): string {
  return note === null ? status : `${status} ${note}`;
}

/**
 * Best-effort parse of a raw model reply as a MissionPlan JSON object.
 * Returns null when the text is not valid JSON or fails schema validation.
 */
export function tryParseMissionPlan(text: string): MissionPlan | null {
  try {
    const decoded: unknown = JSON.parse(text);
    return validateMissionPlan(decoded);
  } catch {
    return null;
  }
}

/**
 * Extract the last user-turn text from a thread (newest first).
 */
export function lastUserText(thread: ChatThread | undefined): string | null {
  if (!thread) {
    return null;
  }
  for (let index = thread.turns.length - 1; index >= 0; index--) {
    const turn = thread.turns[index];
    if (turn && turn.kind === 'user') {
      return turn.text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generation: model, profile, snapshot, request budget
// ---------------------------------------------------------------------------

/**
 * Model the provider will be asked for (the cloud model or the local id).
 */
export function generationModel(
  host: ProviderHost,
  provider: ProviderId,
): string {
  if (provider === 'cloud') {
    return host.selectedCloudModel();
  }
  // A model chosen on an external server (Ollama, LM Studio) while RAME runs none of its own; Model evidence records the same id.
  return requestedLocalModel(host.settings, host.localEndpoint());
}

/**
 * Read the local server's `/props` (loopback, bounded).  Anything other
 * than a llama-server reply counts as unknown, which offers no reasoning
 * levels; it never blocks or fails the run.
 */
export async function probeLocalProps(
  host: ProviderHost,
  endpoint: string,
): Promise<LocalServerProps> {
  let props: LocalServerProps = { ...UNKNOWN_LOCAL_PROPS };
  if (isLocalOrPrivateUrl(endpoint)) {
    try {
      const payload = await withBoundedRequest(
        undefined,
        LOCAL_PROPS_TIMEOUT_MS,
        'Local /props timed out.',
        async (signal) => {
          const response = await fetch(
            `${endpoint.replace(/\/+$/, '')}/props`,
            { method: 'GET', signal, redirect: 'manual' },
          );
          return response.ok ? ((await response.json()) as unknown) : null;
        },
      );
      props = parseLlamaServerProps(payload);
      if (payload !== null) {
        host.localConfirmed = endpoint;
      }
    } catch {
      props = { ...UNKNOWN_LOCAL_PROPS };
    }
  }
  host.localProps = { endpoint, props };
  return props;
}

/**
 * Profile of the selected provider/model from what is known right now.
 */
export function generationProfile(
  host: ProviderHost,
  provider: ProviderId,
  model: string,
): ModelGenerationProfile {
  if (provider === 'cloud') {
    return cloudGenerationProfile(model);
  }
  const endpoint = host.localEndpoint();
  const props =
    endpoint !== null &&
    host.localProps?.endpoint === endpoint
      ? host.localProps.props
      : null;
  const local = host.localStatus();
  const ownContext = local.owned && local.endpoint === endpoint
    ? host.settings.local.contextSize
    : null;
  return localGenerationProfile(props, ownContext);
}

/**
 * Freeze generation parameters for a run.
 */
export async function snapshotGeneration(
  host: ProviderHost,
  provider: ProviderId,
): Promise<RunGeneration> {
  const model = generationModel(host, provider);
  if (provider === 'local') {
    const endpoint = host.localEndpoint();
    if (endpoint !== null) {
      await probeLocalProps(host, endpoint);
    }
  }
  const profile = generationProfile(host, provider, model);
  const reasoning = resolveReasoning(
    host.settings.generation,
    provider as GenerationProviderId,
    model,
    profile,
  );
  const notes = reasoning.unavailable
    ? [
        `Reasoning ${REASONING_LABELS[reasoning.stored]} is not available for ${model} (${profile.source}); this run uses Model default.`,
      ]
    : [];
  const runProfile = {
    ...profile,
    autoOutputTokens: automaticOutputTokens(
      provider as GenerationProviderId,
      reasoning.unavailable ? 'default' : reasoning.stored,
    ),
  };
  return {
    provider: provider as GenerationProviderId,
    model,
    profile: runProfile,
    reasoning: reasoning.level,
    manualMax: host.settings.generation.maxOutputTokens[provider as GenerationProviderId],
    notes,
  };
}

/**
 * Output budget for one request from the run's fixed settings and the
 * estimated input.  Throws GenerationContextError when the input
 * leaves too little context; the input is never shortened to fit.
 */
export function generationRequest(
  run: RunGeneration,
  body: unknown,
  calibration?: { chars: number; tokens: number } | null,
): { request: GenerationRequest; note: string | null } {
  const budget = resolveOutputBudget(
    run.provider,
    run.profile,
    run.manualMax,
    estimatePromptTokens(body, calibration),
  );
  return {
    request: {
      maxCompletionTokens: budget.maxCompletionTokens,
      reasoning: run.reasoning,
      reasoningParam: run.profile.reasoningParam,
    },
    note: describeBudgetLimit(budget),
  };
}

// ---------------------------------------------------------------------------
// Send: cloud
// ---------------------------------------------------------------------------

export async function sendCloud(
  host: ProviderHost,
  threadId: string,
  text: string,
  mode: string,
  generation: RunGeneration,
): Promise<void> {
  const apiKey = await host.getApiKey();
  if (!apiKey) {
    host.hasKey = false;
    host.running = false;
    host.connection = 'missing-key';
    host.status = 'No API key stored. Save a Meta Model API key to begin.';
    const current = host.store.get(threadId);
    if (current) {
      host.store.save(appendErrorTurn(current, 'No API key stored.'));
    }
    return;
  }
  // Only Meta's own exchanges and what the user disclosed (cloudDisclosure.ts).
  const thread = threadForRun(host, threadId, 'cloud', text);
  const withheldLocalTurns = mode === 'mission' ? 0 : withheldForRun(host, threadId, 'cloud', text);
  const built = buildRequestMessages({
    mode: mode === 'mission' ? 'mission' : 'chat',
    activeThread: thread,
    currentText: text,
    currentModel: { provider: 'cloud', model: generation.model },
    contextWindow: generation.profile.contextWindow,
    continuityOptions: {
      authorizedDecisions: host.cloudRun?.threadId === threadId ? host.cloudRun.decisions : [],
      withheldLocalTurns,
    },
  });
  if (mode !== 'mission') {
    logPacket(host, threadId, 'chat', { provider: 'cloud', model: generation.model }, text, built.continuity, withheldLocalTurns);
  }
  const cloudModel = generation.model;
  const { request, note } = host.generationRequest(generation, {
    messages: built.messages,
  });
  if (mode === 'mission') {
    const result = await observed(host, threadId, 'cloud', cloudModel, 'plan', host.missionRunner.startWithUsage({
      apiKey,
      goal: text,
      fetchImpl: undefined,
      model: cloudModel,
      generation: request,
    }));
    host.recordUsage('cloud', result.usage);
    host.cloudConfirmed = true;
    host.running = false;
    host.connection = 'verified';
    host.status = withNote('Plan ready.', note);
    const current = host.store.get(threadId);
    if (current) {
      host.store.save(appendPlanTurn(current, result.plan));
    }
    await host.createMissionFromPlan(threadId, result.plan);
    host.outputChannel.clear();
    host.outputChannel.appendLine(formatPlanAsText(result.plan, cloudModel));
    host.outputChannel.show(true);
  } else {
    // The request actually built is checked before anything is sent (cloudEgress.ts).
    const outgoing = guardCloudMessages(host, threadId, text, built.messages);
    const result = await host.chatRunner.start(async ({ signal }) =>
      observed(host, threadId, 'cloud', cloudModel, 'chat', createChatCompletion({
        apiKey,
        goal: text,
        messages: outgoing,
        signal,
        model: cloudModel,
        generation: request,
      })).then((completion) => {
        host.recordUsage('cloud', completion.usage);
        host.cloudConfirmed = true;
        return completion.text;
      }),
    );
    host.running = false;
    host.connection = 'verified';
    host.status = withNote('Reply ready.', note);
    const current = host.store.get(threadId);
    if (current) {
      host.store.save(appendAssistantTurn(
        current,
        result,
        undefined,
        built.continuity.hostRecordLine ? [built.continuity.hostRecordLine] : undefined,
        { provider: 'cloud', model: cloudModel },
      ));
    }
  }
}

/** Model evidence for a chat reply or a plan: its usage, or its failure category. */
function observed<T extends { usage: ProviderUsage }>(
  host: ProviderHost,
  threadId: string,
  provider: ProviderId,
  model: string,
  request: 'chat' | 'plan',
  work: Promise<T>,
): Promise<T> {
  return work.then(
    (value) => {
      recordReply(host, threadId, provider, model, request, { usage: value.usage, responseModel: (value as { responseModel?: string | null }).responseModel ?? null });
      return value;
    },
    (error: unknown) => {
      recordReply(host, threadId, provider, model, request, { error });
      throw error;
    },
  );
}

// ---------------------------------------------------------------------------
// Send: local
// ---------------------------------------------------------------------------

export async function sendLocal(
  host: ProviderHost,
  threadId: string,
  text: string,
  mode: string,
  generation: RunGeneration,
): Promise<void> {
  const endpoint = host.localEndpoint();
  if (!endpoint) {
    throw new Error(
      'The local runtime is not running and no external endpoint is selected.',
    );
  }
  const thread = host.store.get(threadId);
  const authorizedDecisions = (await decisionsForThread(host, thread)).list;
  const built = buildRequestMessages({
    mode: mode === 'mission' ? 'mission' : 'chat',
    activeThread: thread,
    currentText: text,
    currentModel: { provider: 'local', model: generation.model },
    contextWindow: generation.profile.contextWindow,
    continuityOptions: {
      authorizedDecisions,
      scopeLabel: thread?.workspaceRoot?.split(/[\\/]/).filter(Boolean).at(-1),
    },
  });
  logPacket(host, threadId, mode === 'mission' ? 'mission-plan' : 'chat', { provider: 'local', model: generation.model }, text, built.continuity);
  const modelId = generation.model;
  const { request, note } = host.generationRequest(generation, {
    messages: built.messages,
  });
  if (mode === 'mission') {
    const planned = await host.chatRunner.start(async ({ signal }) =>
      observed(host, threadId, 'local', modelId, 'plan', createLocalMissionPlan({
        endpoint,
        model: modelId,
        messages: built.messages,
        generation: request,
        signal,
        planSchema: missionPlanSchema.json_schema.schema,
      })).then((completion) => {
        host.recordUsage('local', completion.usage);
        return completion;
      }),
    );
    host.armIdleShutdown();
    await finishLocalMissionPlan(
      host,
      threadId,
      planned.plan ?? tryParseMissionPlan(planned.text),
      planned.text,
      note,
    );
    host.running = false;
    host.connection = 'verified';
    return;
  }
  // Chat with read-only web tools when the user turned web access on (chatWeb.ts); plain Chat otherwise.
  let webRecord: string[] = [];
  const result = await host.chatRunner.start(async ({ signal }) =>
    mode !== 'mission' && chatWebOffered(host)
      ? runChatWithWeb(host, {
          threadId,
          endpoint,
          model: modelId,
          messages: built.messages,
          generation: request,
          signal,
          observe: (promise) => observed(host, threadId, 'local', modelId, 'chat', promise),
        }).then((reply) => {
          webRecord = reply.hostRecord;
          return reply.text;
        })
      : observed(host, threadId, 'local', modelId, 'chat', createLocalChatCompletion({
          endpoint,
          model: modelId,
          messages: built.messages,
          generation: request,
          signal,
        })).then((completion) => {
          host.recordUsage('local', completion.usage);
          return completion.text;
        }),
  );
  host.armIdleShutdown();
  if (mode === 'mission') {
    const plan = tryParseMissionPlan(result);
    const current = host.store.get(threadId);
    if (plan) {
      if (current) {
        host.store.save(appendPlanTurn(current, plan));
      }
      host.status = withNote('Plan ready.', note);
      await host.createMissionFromPlan(threadId, plan);
    } else {
      if (current) {
        host.store.save(appendAssistantTurn(current, result, undefined, undefined, { provider: 'local', model: modelId }));
      }
      host.status = withNote(
        'The local model did not return a strict plan; its reply is shown as prose.',
        note,
      );
    }
  } else {
    const current = host.store.get(threadId);
    if (current) {
      const lines = [...(built.continuity.hostRecordLine ? [built.continuity.hostRecordLine] : []), ...webRecord];
      host.store.save(appendAssistantTurn(
        current,
        result,
        undefined,
        lines.length > 0 ? lines : undefined,
        { provider: 'local', model: modelId },
      ));
    }
    host.status = withNote('Reply ready.', note);
  }
  host.running = false;
  host.connection = 'verified';
}

// ---------------------------------------------------------------------------
// Finish: local mission plan
// ---------------------------------------------------------------------------

export async function finishLocalMissionPlan(
  host: ProviderHost,
  threadId: string,
  plan: MissionPlan | null,
  prose: string,
  note: string | null,
): Promise<void> {
  const current = host.store.get(threadId);
  if (plan) {
    if (current) {
      host.store.save(appendPlanTurn(current, plan));
    }
    host.status = withNote('Plan ready.', note);
    await host.createMissionFromPlan(threadId, plan);
    return;
  }
  if (current) {
    host.store.save(
      appendAssistantTurn(
        current,
        prose.trim().length > 0
          ? prose
          : 'The local model did not submit a valid Mission plan.',
      ),
    );
  }
  host.status = withNote(
    'The local model did not return a strict plan; its reply is shown as prose.',
    note,
  );
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

export async function handleSendError(
  host: ProviderHost,
  threadId: string,
  provider: ProviderId,
  error: unknown,
): Promise<void> {
  host.running = false;
  host.memory.discardProposals({ threadId });
  if (error instanceof CloudEgressBlocked) {
    // Stopped by RAME before sending: not a Meta failure, and nothing to retry or delegate.
    host.connection = 'error';
    host.status = error.message;
    const current = host.store.get(threadId);
    if (current) {
      host.store.save(appendErrorTurn(current, error.message));
    }
    return;
  }
  if (
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof DOMException && error.name === 'AbortError')
  ) {
    host.connection = 'cancelled';
    host.status = 'Request cancelled.';
    const current = host.store.get(threadId);
    if (current) {
      host.store.save(
        appendErrorTurn(
          current,
          host.disposed ? INTERRUPTED_RUN_NOTE : 'Request cancelled.',
        ),
      );
    }
    return;
  }
  let apiKey: string | undefined;
  try {
    apiKey = await host.getApiKey();
  } catch {
    apiKey = undefined;
  }
  const detail = error instanceof Error ? error.message : 'Unknown error.';
  const redacted = redactKeyFromText(detail, apiKey ?? '');
  const concise = redacted.replace(/\s+/g, ' ').trim().slice(0, 300);
  const safe = concise.length > 0 ? concise : 'Unknown error.';
  // Meta refused the key (Chat, Agent, a Mission plan or a delegated run): an earlier answer no longer verifies the connection.
  if (provider === 'cloud' && classifyMetaFailure(error, [apiKey ?? '']).category === 'authentication') {
    host.cloudConfirmed = false;
  }
  const displayEndpoint =
    host.localEndpoint() ??
    `http://127.0.0.1:${host.settings.local.port}`;
  const unreachable = localUnreachableMessage(displayEndpoint);
  const looksUnreachable =
    /not running|no external endpoint|not reachable|unreachable|refused|failed to fetch|fetch failed|network|econn|socket|health/i.test(
      safe,
    );
  const reason = looksUnreachable
    ? `${unreachable} You can send this request to Meta explicitly, or dismiss.`
    : `Local work could not complete (${safe}). You can send this request to Meta explicitly, or dismiss.`;
  // A failed delegated run is classified and recorded; it never switches to Glimmer by itself.
  const delegated = provider === 'cloud' ? remote.delegationFailed(host, threadId, error, apiKey ?? '') : null;
  // The local actions shown depend on the request: see remote.localFailure.
  const local = provider === 'local' ? remote.localFailure(host, threadId, looksUnreachable, reason, apiKey !== undefined && apiKey.length > 0) : null;
  const failed = looksUnreachable ? unreachable : `Local work failed (${safe}).`;
  if (local === 'offered') {
    host.connection = 'error';
    host.status = looksUnreachable
      ? `${unreachable} Escalation is waiting for approval.`
      : 'Local work failed. Escalation is waiting for approval.';
  } else if (local !== null && !host.settings.allowCloudEscalation) {
    host.connection = 'error';
    host.status = `${failed} Cloud escalation is OFF, so nothing was sent.`;
  } else if (local === 'internal') {
    // A host-written prompt (a Mission's internal run, an Advisory verification) is never delegated.
    host.connection = 'error';
    host.status = `${failed} A RAME Code internal run is never delegated to Meta; nothing was sent.`;
  } else if (local === 'not-agent') {
    host.connection = 'error';
    host.status = `${failed} Only an Agent request can be run with Meta; nothing was sent.`;
  } else if (local === 'no-key') {
    host.connection = 'error';
    host.status = `${failed} No Meta Model API key is stored, so nothing was sent.`;
  } else if (delegated !== null) {
    host.connection = 'error';
    host.status = delegated;
  } else {
    host.connection = 'error';
    host.status = `Request failed (${safe}).`;
  }
  const current = host.store.get(threadId);
  if (current) {
    const errorNote =
      provider === 'local' && looksUnreachable ? unreachable : host.status;
    host.store.save(appendErrorTurn(current, errorNote.slice(0, 500)));
  }
}
