/**
 * Local OpenAI-compatible chat calls against RAME's own `llama-server`, or
 * a separately running server the user selected (Ollama, LM Studio, another
 * llama-server) that RAME does not own.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * The endpoint must be on this computer or on the private network (see
 * `localServers.ts`); a private-network server is used only after the user
 * confirmed it. A public address is refused.
 */

import { isAbortError, withBoundedRequest } from './boundedRequest.js';
import {
  OutputCutOffError,
  generationRequestFields,
  localContextRefusal,
  stoppedAtLength,
  type GenerationRequest,
} from './generationSettings.js';
import { isLocalOrPrivateUrl, refuseRedirect } from './localServers.js';
import { validateMissionPlan } from './meta-provider.js';
import type { MissionPlan } from './types.js';
import { parseUsage, type ProviderUsage } from './usage.js';

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface LocalChatOptions {
  endpoint: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  /** Output budget and reasoning level fixed when the run started. */
  generation: GenerationRequest;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** Deadline covering headers and body; defaults to 120 seconds. */
  timeoutMs?: number;
}

export interface LocalChatResult {
  text: string;
  usage: ProviderUsage;
}

/**
 * Send one chat request to `{endpoint}/v1/chat/completions`. Returns the
 * assistant prose plus defensively parsed usage. Rejects loopback
 * violations and empty replies with generic errors.
 */
export async function createLocalChatCompletion(
  options: LocalChatOptions,
): Promise<LocalChatResult> {
  if (!isLocalOrPrivateUrl(options.endpoint)) {
    throw new Error('The local endpoint must stay on this computer or the private network.');
  }
  const model = options.model.trim();
  if (model.length === 0) {
    throw new Error('A local model ID is required.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.endpoint.replace(/\/+$/, '')}/v1/chat/completions`;
  // The deadline and cancellation cover the body read as well as headers.
  const { response, payload } = await withBoundedRequest(
    options.signal,
    options.timeoutMs,
    'The local model did not answer within 120 seconds.',
    async (signal) => {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          redirect: 'manual',
          body: JSON.stringify({
            model,
            messages: options.messages,
            ...generationRequestFields(options.generation),
            stream: false,
          }),
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        throw new Error('The local runtime is unreachable.');
      }
      refuseRedirect(response);
      let payload: Record<string, unknown>;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        throw new Error('The local runtime returned an invalid response.');
      }
      return { response, payload };
    },
  );
  if (!response.ok) {
    throw localContextRefusal(payload) ?? new Error(
      `The local runtime returned HTTP ${response.status}.`,
    );
  }
  if (stoppedAtLength(payload)) {
    // An incomplete reply (possibly only reasoning) is never shown as an answer.
    throw new OutputCutOffError(options.generation.maxCompletionTokens);
  }
  const choices = payload.choices;
  const content =
    Array.isArray(choices) &&
    typeof (choices[0] as Record<string, unknown> | undefined)?.message ===
      'object'
      ? (
          (choices[0] as Record<string, unknown>).message as Record<
            string,
            unknown
          >
        ).content
      : undefined;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('The local runtime returned no assistant reply.');
  }
  return { text: content, usage: parseUsage(payload) };
}

/**
 * The only tool offered when a local model plans a Mission. Tool calls are
 * what local llama-server models follow reliably (a `response_format`
 * schema is not applied with every chat template), and the arguments are
 * still checked by {@link validateMissionPlan}.
 */
export function missionPlanTool(schema: unknown): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: 'submit_mission_plan',
      description:
        'Submit the Mission plan once. Each step is one whole bounded Agent run that can read, edit, and test files, so group the work into as few steps as possible (usually 1 to 3) and never make a step only to find or read a file. If the user asks for a number of tasks, use exactly that number.',
      parameters: schema,
    },
  };
}

export interface LocalMissionPlanResult {
  /** The validated plan, or null when the model did not submit a valid one. */
  plan: MissionPlan | null;
  /** The model's prose, shown as prose when there is no valid plan. */
  text: string;
  usage: ProviderUsage;
}

/**
 * Ask the local model for a Mission plan through one strict tool call.
 * Anything other than a valid `submit_mission_plan` call yields no plan:
 * prose is never turned into an executable Mission.
 */
export async function createLocalMissionPlan(
  options: LocalChatOptions & { planSchema: unknown },
): Promise<LocalMissionPlanResult> {
  if (!isLocalOrPrivateUrl(options.endpoint)) {
    throw new Error('The local endpoint must stay on this computer or the private network.');
  }
  const model = options.model.trim();
  if (model.length === 0) {
    throw new Error('A local model ID is required.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.endpoint.replace(/\/+$/, '')}/v1/chat/completions`;
  const { response, payload } = await withBoundedRequest(
    options.signal,
    options.timeoutMs,
    'The local model did not answer within 120 seconds.',
    async (signal) => {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          redirect: 'manual',
          body: JSON.stringify({
            model,
            messages: [
              ...options.messages,
              { role: 'system', content: 'Submit the plan by calling submit_mission_plan exactly once.' },
            ],
            tools: [missionPlanTool(options.planSchema)],
            tool_choice: 'auto',
            ...generationRequestFields(options.generation),
            stream: false,
          }),
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        throw new Error('The local runtime is unreachable.');
      }
      refuseRedirect(response);
      let payload: Record<string, unknown>;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        throw new Error('The local runtime returned an invalid response.');
      }
      return { response, payload };
    },
  );
  if (!response.ok) {
    throw localContextRefusal(payload) ?? new Error(`The local runtime returned HTTP ${response.status}.`);
  }
  if (stoppedAtLength(payload)) {
    throw new OutputCutOffError(options.generation.maxCompletionTokens);
  }
  const choices = payload.choices;
  const message =
    Array.isArray(choices) && typeof (choices[0] as Record<string, unknown> | undefined)?.message === 'object'
      ? ((choices[0] as Record<string, unknown>).message as Record<string, unknown>)
      : {};
  const text = typeof message.content === 'string' ? message.content : '';
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  let plan: MissionPlan | null = null;
  if (calls.length === 1) {
    const fn = (calls[0] as Record<string, unknown>)?.function as Record<string, unknown> | undefined;
    if (fn?.name === 'submit_mission_plan' && typeof fn.arguments === 'string') {
      try {
        plan = validateMissionPlan(JSON.parse(fn.arguments) as unknown);
      } catch {
        plan = null;
      }
    }
  }
  return { plan, text, usage: parseUsage(payload) };
}
