/**
 * Bounded Agent tool-call loop.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`
 * using a fake model transport and a temporary workspace double.
 * Executes serially for determinism: after each tool result the same
 * selected model is called again with bounded active-thread/agent context.
 * Other threads are never sent (the caller supplies only active-thread
 * history). Stops on normal response, rejection, cancellation, policy
 * failure, step/tool budget, provider error, or stale workspace.
 */

import { computeActionDigest } from './agentApproval.js';
import type { AgentCompletion, AgentChatMessage, AgentProviderId } from './agentModel.js';
import { buildAgentSystemPrompt } from './agentModel.js';
import {
  MAX_AGENT_STEPS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TRANSCRIPT_ENTRIES,
} from './agentPolicy.js';
import { isAutoAllowed, type AgentProfileId, type AgentToolName } from './agentProfiles.js';
import { truncateToolOutput, type ValidatedToolCall } from './agentTools.js';
import { addUsage, EMPTY_USAGE, type ProviderUsage } from './usage.js';

export type AgentOutcome =
  | 'done'
  | 'rejected'
  | 'cancelled'
  | 'policy-stop'
  | 'budget-stop'
  | 'provider-error'
  | 'stale';

export interface AgentTransport {
  (input: {
    provider: AgentProviderId;
    model: string;
    messages: AgentChatMessage[];
    signal?: AbortSignal;
  }): Promise<AgentCompletion>;
}

export interface AgentPolicyGate {
  (call: ValidatedToolCall): { ok: true } | { ok: false; error: string };
}

export interface AgentToolExecutor {
  (call: ValidatedToolCall): Promise<string>;
}

export interface AgentDecider {
  (pending: {
    tool: string;
    targets: string[];
    body: string;
    digest: string;
    preconditions: Record<string, string>;
  }): Promise<'approve' | 'reject'>;
}

export interface AgentCallDescriptor {
  targets: string[];
  body: string;
  preconditions: Record<string, string>;
}

export interface AgentTranscriptEntry {
  kind: 'assistant' | 'tool' | 'note';
  text: string;
}

export interface AgentLoopResult {
  outcome: AgentOutcome;
  steps: number;
  toolCalls: number;
  usage: ProviderUsage;
  transcript: AgentTranscriptEntry[];
  assistantText: string;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

/** Build bounded agent context: system + active-thread history + goal. */
export function buildAgentMessages(
  workspaceLabel: string,
  history: AgentChatMessage[],
  goal: string,
  extra: AgentChatMessage[] = [],
): AgentChatMessage[] {
  const boundedHistory = history.slice(-20);
  return [
    { role: 'system', content: buildAgentSystemPrompt(workspaceLabel) },
    ...boundedHistory,
    { role: 'user', content: goal.slice(0, 8000) },
    ...extra.slice(-40),
  ];
}

function boundTranscript(entries: AgentTranscriptEntry[]): AgentTranscriptEntry[] {
  return entries.slice(-MAX_TRANSCRIPT_ENTRIES);
}

/**
 * Run the serial Agent loop with injected doubles. Tool output is treated
 * as untrusted data: it never alters `profile`, `provider`, or `model`.
 */
export async function runAgentLoop(options: {
  transport: AgentTransport;
  policyGate: AgentPolicyGate;
  executeTool: AgentToolExecutor;
  decide: AgentDecider;
  profile: AgentProfileId;
  provider: AgentProviderId;
  model: string;
  threadId: string;
  workspaceId: string;
  goal: string;
  history?: AgentChatMessage[];
  signal?: AbortSignal;
  maxSteps?: number;
  checkWorkspace?: () => { ok: true } | { ok: false; error: string };
  describeCall?: (call: ValidatedToolCall) => AgentCallDescriptor;
}): Promise<AgentLoopResult> {
  const maxSteps = Math.max(1, Math.min(32, options.maxSteps ?? MAX_AGENT_STEPS));
  const history = options.history ?? [];
  const extra: AgentChatMessage[] = [];
  const transcript: AgentTranscriptEntry[] = [];
  let usage: ProviderUsage = { ...EMPTY_USAGE };
  let toolCallsTotal = 0;
  let steps = 0;
  let assistantText = '';

  for (let step = 0; step < maxSteps; step++) {
    if (options.checkWorkspace) {
      const checked = options.checkWorkspace();
      if (!checked.ok) {
        return { outcome: 'stale', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
      }
    }
    if (options.signal?.aborted) {
      return { outcome: 'cancelled', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
    }
    const messages = buildAgentMessages(options.workspaceId, history, options.goal, extra);
    let completion: AgentCompletion;
    try {
      completion = await options.transport({
        provider: options.provider,
        model: options.model,
        messages,
        signal: options.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        return { outcome: 'cancelled', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
      }
      return { outcome: 'provider-error', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
    }
    usage = addUsage(usage, completion.usage);
    steps += 1;
    if (!completion.toolCalls || completion.toolCalls.length === 0) {
      assistantText = (completion.text ?? '').slice(0, 8000);
      transcript.push({ kind: 'assistant', text: truncateToolOutput(assistantText, 4000) });
      return { outcome: 'done', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
    }
    if (completion.toolCalls.length > MAX_TOOL_CALLS_PER_TURN) {
      transcript.push({ kind: 'note', text: 'Too many parallel tool calls; stopped.' });
      return { outcome: 'budget-stop', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
    }
    // Serial execution for determinism.
    for (const call of completion.toolCalls) {
      if (options.signal?.aborted) {
        return { outcome: 'cancelled', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
      }
      const gate = options.policyGate(call);
      if (!gate.ok) {
        transcript.push({ kind: 'note', text: `Policy blocked ${call.tool}.` });
        return { outcome: 'policy-stop', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
      }
      const auto = isAutoAllowed(options.profile, call.tool as AgentToolName);
      if (!auto) {
        const described = options.describeCall
          ? options.describeCall(call)
          : {
              targets: [call.id],
              body: JSON.stringify(call.args),
              preconditions: {},
            };
        const digest = computeActionDigest({
          tool: call.tool,
          targets: described.targets,
          body: described.body,
          provider: options.provider,
          workspaceId: options.workspaceId,
          threadId: options.threadId,
          preconditions: described.preconditions,
        });
        let choice: 'approve' | 'reject';
        try {
          choice = await options.decide({
            tool: call.tool,
            targets: described.targets,
            body: described.body,
            digest,
            preconditions: described.preconditions,
          });
        } catch (error) {
          if (isAbortError(error) || options.signal?.aborted) {
            return { outcome: 'cancelled', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
          }
          throw error;
        }
        if (options.signal?.aborted) {
          return { outcome: 'cancelled', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
        }
        if (choice !== 'approve') {
          transcript.push({ kind: 'note', text: `Rejected ${call.tool}.` });
          return { outcome: 'rejected', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
        }
      }
      let resultText: string;
      try {
        resultText = await options.executeTool(call);
      } catch (error) {
        if (isAbortError(error)) {
          return { outcome: 'cancelled', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
        }
        resultText = `Tool failed: ${error instanceof Error ? error.message : 'Unknown error.'}`;
      }
      // Authority cannot be elevated by tool output: ignore any embedded
      // profile/provider/model directives by construction (never parsed).
      toolCallsTotal += 1;
      transcript.push({ kind: 'tool', text: `${call.tool}: ${truncateToolOutput(resultText, 2000)}` });
      // Preserve the assistant tool-call record so the next model turn can
      // match results to calls. OpenAI-compatible servers require the
      // assistant `tool_calls` message to precede its `tool` result.
      extra.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: call.id,
            type: 'function',
            function: { name: call.tool, arguments: JSON.stringify(call.args) },
          },
        ],
      });
      extra.push({
        role: 'tool',
        tool_call_id: call.id,
        content: truncateToolOutput(resultText),
      });
      if (toolCallsTotal >= maxSteps * MAX_TOOL_CALLS_PER_TURN) {
        return { outcome: 'budget-stop', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
      }
    }
  }
  return { outcome: 'budget-stop', steps, toolCalls: toolCallsTotal, usage, transcript: boundTranscript(transcript), assistantText };
}

/** Single-flight runner so Agent cooperates with Chat/Mission cancellation. */
export class AgentRunner {
  private controller: AbortController | null = null;

  get isRunning(): boolean {
    return this.controller !== null;
  }

  async start<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.controller !== null) {
      throw new Error('A RAME Code agent run is already running.');
    }
    const controller = new AbortController();
    this.controller = controller;
    try {
      return await work(controller.signal);
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  cancel(): boolean {
    if (this.controller === null) {
      return false;
    }
    this.controller.abort();
    return true;
  }
}
