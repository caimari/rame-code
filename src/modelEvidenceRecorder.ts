/**
 * Host side of Model evidence: fills each record from what the host itself
 * knows at that moment (the arguments it launched llama-server with, the
 * process it owns, /props, the provider's reply and usage, the action it
 * took) and keeps it in the versioned store. See modelEvidence.ts.
 *
 * Free of the `vscode` API. Nothing here reads a prompt, a message, a reply
 * text, tool arguments, or a key; errors are reduced to a category.
 */

import { AgentOutputTruncatedError, LocalMalformedToolCallError, type AgentCompletion } from './agentModel.js';
import { AgentToolProtocolError } from './agentTools.js';
import { classifyMetaFailure } from './metaFailures.js';
import { acceptanceState } from './missionPhase.js';
import {
  appendInference,
  beginEvidenceRun,
  buildEvidenceView,
  evidenceModelName,
  linkEvidenceAction,
  markEvidenceFinal,
  pruneEvidence,
  type EvidenceAction,
  type EvidenceApproval,
  type EvidenceFailure,
  type EvidenceFinish,
  type EvidenceMissionView,
  type EvidenceNowView,
  type EvidenceProvider,
  type EvidenceRequest,
  type EvidenceRuntime,
  type ModelEvidenceView,
} from './modelEvidence.js';
import type { ProviderHost } from './providerTypes.js';
import type { ProviderUsage } from './usage.js';

const WRITE_TOOLS = new Set(['apply_patch', 'replace_in_file', 'create_directory', 'move_file', 'delete_file', 'set_executable']);

function localRuntime(host: ProviderHost): { runtime: EvidenceRuntime; running: boolean } {
  const endpoint = host.localEndpoint();
  const launch = host.localLaunch;
  const props = endpoint !== null && host.localProps?.endpoint === endpoint ? host.localProps.props : null;
  const confirmed = { contextConfirmed: props?.contextWindow ?? null, template: props?.template ?? 'unknown' } as const;
  if (endpoint !== null && launch !== null && launch.endpoint === endpoint) {
    return {
      runtime: { kind: 'rame-launched', model: launch.model, contextConfigured: launch.contextSize, ...confirmed, projector: launch.projector, draft: launch.draft },
      running: true,
    };
  }
  if (endpoint !== null) {
    const requested = host.settings.local.modelId.trim() || 'local-glimmer';
    return {
      runtime: { kind: 'external-endpoint', model: requested, contextConfigured: null, ...confirmed, projector: false, draft: false },
      running: host.localConfirmed === endpoint,
    };
  }
  const local = host.settings.local;
  return {
    runtime: {
      kind: 'not-running',
      model: evidenceModelName(local.modelPath) || 'none',
      contextConfigured: local.contextSize,
      contextConfirmed: null,
      template: 'unknown',
      projector: local.projectorPath.length > 0,
      draft: local.draftModelPath.length > 0,
    },
    running: false,
  };
}

function finishOf(value: unknown): EvidenceFinish | null {
  return value === undefined || value === null ? null : value === 'stop' || value === 'tool_calls' || value === 'length' ? value : 'other';
}

function usageOf(usage: ProviderUsage | undefined): { input: number; output: number } | null {
  return usage === undefined || usage.inputTokens + usage.outputTokens === 0 ? null : { input: usage.inputTokens, output: usage.outputTokens };
}

function save(host: ProviderHost): void {
  pruneEvidence(host.modelEvidence.state, new Set(host.store.list().map((thread) => thread.id)));
  host.modelEvidence.persist();
}

/** A new run of a thread (an Agent run, a chat reply, a consultation). */
export function beginRun(host: ProviderHost, threadId: string): number {
  return beginEvidenceRun(host.modelEvidence.state, threadId, Date.now());
}

/**
 * Record one inference from what the host observed. A failure is stored as
 * its category only, and never as a response observed.
 */
export function recordInference(
  host: ProviderHost,
  threadId: string,
  run: number,
  input: {
    provider: EvidenceProvider;
    model: string;
    request: EvidenceRequest;
    answer: { toolCalls: Array<{ id: string; tool: string }>; usage: ProviderUsage; finish?: unknown } | null;
    invalid?: { failure: EvidenceFailure; usage?: ProviderUsage };
    failure?: EvidenceFailure;
    final?: boolean;
  },
): string | null {
  const local = input.provider === 'local' ? localRuntime(host) : null;
  const runtime: EvidenceRuntime =
    local?.runtime ?? { kind: 'meta-api', model: input.model, contextConfigured: null, contextConfirmed: null, template: 'unknown', projector: false, draft: false };
  const answered = input.answer !== null || input.invalid !== undefined;
  const mission = host.activeMission;
  const record = mission !== null ? host.missions.get(mission.id) : null;
  const id = appendInference(
    host.modelEvidence.state,
    threadId,
    {
      run,
      provider: input.provider,
      runtime,
      identity: answered ? 'response-observed' : local?.running === true && input.failure !== 'unreachable' ? 'running' : 'configured',
      authority:
        input.provider === 'local'
          ? 'local'
          : input.request === 'advisory'
            ? 'advisory'
            : host.delegatedRun?.threadId === threadId
              ? 'delegated'
              : 'selected',
      mode: mission !== null || input.request === 'plan' ? 'mission' : input.request === 'chat' ? 'chat' : 'agent',
      mission:
        mission !== null
          ? { missionId: mission.id, run: record?.taskRunsUsed ?? null, step: input.request === 'agent-step' ? host.agentStepNow : null }
          : null,
      request: input.request,
      response: input.answer !== null ? (input.answer.toolCalls.length > 0 ? 'tool-calls' : 'text') : input.invalid !== undefined ? 'invalid' : 'failed',
      failure: input.invalid?.failure ?? (input.answer === null ? (input.failure ?? 'unknown') : null),
      usage: usageOf(input.answer?.usage ?? input.invalid?.usage),
      finish: input.answer !== null ? finishOf(input.answer.finish) : input.invalid?.failure === 'cut-off' ? 'length' : null,
      toolCalls: (input.answer?.toolCalls ?? []).map((call) => ({ callId: call.id, tool: call.tool })),
      final: input.final,
    },
    Date.now(),
  );
  if (id !== null) {
    if (answered) {
      host.modelEvidence.observed[input.provider] = true;
    }
    save(host);
  }
  return id;
}

/** The category of a failed call, without its text. */
export function failureOf(provider: EvidenceProvider, error: unknown): EvidenceFailure | 'cancelled' {
  if (provider === 'cloud') {
    const category = classifyMetaFailure(error, []).category;
    return category;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'cancelled';
  }
  return error instanceof Error && /unreachable/i.test(error.message) ? 'unreachable' : 'local-error';
}

/**
 * One Advisory consultation: a valid answer, or its failure category. Only
 * a request that was actually sent is recorded; a cancellation is not.
 */
export function recordAdvisory(host: ProviderHost, threadId: string, model: string, outcome: { usage: ProviderUsage } | { error: unknown; sent: boolean }): void {
  const base = { provider: 'cloud' as const, model, request: 'advisory' as const };
  if ('usage' in outcome) {
    recordInference(host, threadId, beginRun(host, threadId), { ...base, answer: { toolCalls: [], usage: outcome.usage } });
    return;
  }
  const failure = failureOf('cloud', outcome.error);
  if (outcome.sent && failure !== 'cancelled') {
    recordInference(host, threadId, beginRun(host, threadId), { ...base, answer: null, failure });
  }
}

/** A chat reply or a Mission plan: one inference, its usage, and its failure category if it failed. */
export function recordReply(
  host: ProviderHost,
  threadId: string,
  provider: EvidenceProvider,
  model: string,
  request: 'chat' | 'plan',
  outcome: { usage: ProviderUsage } | { error: unknown },
): void {
  const run = beginRun(host, threadId);
  if ('usage' in outcome) {
    recordInference(host, threadId, run, { provider, model, request, answer: { toolCalls: [], usage: outcome.usage }, final: true });
    return;
  }
  const failure = failureOf(provider, outcome.error);
  if (failure !== 'cancelled') {
    recordInference(host, threadId, run, { provider, model, request, answer: null, failure });
  }
}

/** One Agent step: its answer, or why the host could not use it. Cancellation records nothing. */
export function recordAgentStep(
  host: ProviderHost,
  threadId: string,
  run: number,
  provider: EvidenceProvider,
  model: string,
  outcome: { completion: AgentCompletion } | { error: unknown },
): string | null {
  const base = { provider, model, request: 'agent-step' as const };
  if ('completion' in outcome) {
    const { toolCalls, usage, finish } = outcome.completion;
    return recordInference(host, threadId, run, { ...base, answer: { toolCalls: (toolCalls ?? []).map((call) => ({ id: call.id, tool: call.tool })), usage, finish } });
  }
  const error = outcome.error;
  if (error instanceof AgentToolProtocolError) {
    const failure: EvidenceFailure =
      error instanceof AgentOutputTruncatedError ? 'cut-off' : error instanceof LocalMalformedToolCallError ? 'malformed-tool-call' : 'invalid-arguments';
    return recordInference(host, threadId, run, { ...base, answer: null, invalid: { failure, usage: error.usage } });
  }
  const failure = failureOf(provider, error);
  return failure === 'cancelled' ? null : recordInference(host, threadId, run, { ...base, answer: null, failure });
}

/**
 * Link the host's action for tool call `call` of inference `inferenceId`.
 * The kind of action comes from the host-written outcome line; the digest
 * and approval only from the action the host itself computed and approved.
 */
export function recordAgentAction(
  host: ProviderHost,
  threadId: string,
  inferenceId: string | null,
  calls: ReadonlyArray<{ id: string; tool: string }> | null,
  call: { id: string; tool: string; args?: unknown },
  outcome: string,
  approved: { digest: string; approval: EvidenceApproval } | null,
): void {
  const n = (calls ?? []).indexOf(call) + 1;
  if (inferenceId === null || n === 0) {
    return;
  }
  const result: EvidenceAction['result'] = outcome.startsWith('blocked by policy')
    ? 'blocked-by-policy'
    : outcome.startsWith('not proposed')
      ? 'not-proposed'
      : outcome.startsWith('did not run: approval invalidated')
        ? 'approval-invalidated'
        : outcome.startsWith('rejected by user')
          ? 'rejected-by-user'
          : outcome.startsWith('did not run') || outcome.startsWith('stopped')
            ? 'did-not-run'
            : 'applied';
  const exit = result === 'applied' && call.tool === 'run_tests' ? /^exit=(\d+)/.exec(outcome) : null;
  // The command id the host bound to its allowlist before running it.
  const bound = call.tool === 'run_tests' && result === 'applied' ? (call.args as { commandId?: unknown } | undefined)?.commandId : undefined;
  const commandId = typeof bound === 'string' && /^[A-Za-z0-9:._@/-]{1,80}$/.test(bound) ? bound : call.tool === 'run_tests' && result === 'applied' ? 'unknown' : null;
  const linked = linkEvidenceAction(host.modelEvidence.state, threadId, inferenceId, n, {
    digest: approved?.digest ?? null,
    approval: result === 'applied' || result === 'did-not-run' ? (approved?.approval ?? null) : result === 'rejected-by-user' ? 'human' : null,
    result,
    write: WRITE_TOOLS.has(call.tool),
    commandId,
    exitCode: exit ? Number(exit[1]) : null,
  });
  if (linked) {
    save(host);
  }
}

export function markFinal(host: ProviderHost, threadId: string, inferenceId: string | null): void {
  if (inferenceId !== null) {
    markEvidenceFinal(host.modelEvidence.state, threadId, inferenceId);
    save(host);
  }
}

/** What is configured, what runs, and what answered in this session. */
export function evidenceNow(host: ProviderHost, lifecycle: string, owned: boolean): EvidenceNowView {
  const external = host.settings.externalLocalEndpoint.trim();
  const local = host.settings.local;
  const endpoint = host.localEndpoint();
  const props = endpoint !== null && host.localProps?.endpoint === endpoint ? host.localProps.props : null;
  const launched = owned && lifecycle === 'running' && host.localLaunch !== null && host.localLaunch.endpoint === endpoint;
  return {
    local: {
      configured:
        external.length > 0
          ? { kind: 'external', model: local.modelId.trim() || 'local-glimmer', context: null, projector: false, draft: false }
          : local.modelPath.length > 0
            ? { kind: 'owned', model: evidenceModelName(local.modelPath), context: local.contextSize, projector: local.projectorPath.length > 0, draft: local.draftModelPath.length > 0 }
            : null,
      running: launched
        ? { kind: 'rame-launched', contextConfirmed: props?.contextWindow ?? null, template: props?.template ?? 'unknown' }
        : !owned && endpoint !== null && host.localConfirmed === endpoint
          ? { kind: 'external-endpoint', contextConfirmed: props?.contextWindow ?? null, template: props?.template ?? 'unknown' }
          : null,
      observed: host.modelEvidence.observed.local,
    },
    cloud: { model: host.selectedCloudModel(), keyStored: host.hasKey, observed: host.modelEvidence.observed.cloud },
  };
}

function missionView(host: ProviderHost, threadId: string | null): EvidenceMissionView | null {
  if (threadId === null) {
    return null;
  }
  const mission = host.missions
    .list()
    .filter((entry) => entry.threadId === threadId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (mission === undefined) {
    return null;
  }
  const acceptance = acceptanceState(mission);
  const commands = (host.modelEvidence.state.threads.find((thread) => thread.threadId === threadId)?.inferences ?? [])
    .filter((entry) => entry.mission?.missionId === mission.id)
    .flatMap((entry) => entry.toolCalls)
    .filter((call) => call.action?.result === 'applied' && call.action.commandId !== null);
  const last = commands[commands.length - 1]?.action ?? null;
  return {
    status: mission.status,
    completedByHost: mission.status === 'completed',
    acceptance: acceptance.state,
    acceptanceCommand: mission.grant?.acceptance?.commandId ?? null,
    lastCommand: last !== null && last.commandId !== null ? { commandId: last.commandId, exitCode: last.exitCode } : null,
  };
}

export function evidenceView(host: ProviderHost, threadId: string | null, lifecycle: string, owned: boolean): ModelEvidenceView {
  return buildEvidenceView(host.modelEvidence.state, threadId, evidenceNow(host, lifecycle, owned), missionView(host, threadId), host.modelEvidence.discarded);
}
