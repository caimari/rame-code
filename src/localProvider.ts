/**
 * Local OpenAI-compatible chat calls against a loopback `llama-server`.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * Ollama is not required: any OpenAI-compatible loopback server works, and
 * a separately running compatible server may be selected without RAME
 * owning its lifecycle. The endpoint must remain loopback (see
 * {@link isLoopbackUrl}); this module refuses anything else.
 */

import { isAbortError, withBoundedRequest } from './boundedRequest.js';
import { isLoopbackUrl } from './localRuntime.js';
import { parseUsage, type ProviderUsage } from './usage.js';

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface LocalChatOptions {
  endpoint: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
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
  if (!isLoopbackUrl(options.endpoint)) {
    throw new Error('The local endpoint must stay on loopback.');
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
          body: JSON.stringify({
            model,
            messages: options.messages,
            stream: false,
          }),
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        throw new Error('The local runtime is unreachable.');
      }
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
    throw new Error(
      `The local runtime returned HTTP ${response.status}.`,
    );
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
