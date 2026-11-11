/**
 * What a local server (LM Studio, Ollama, llama-server or another
 * OpenAI-compatible server) said when it refused a request.
 *
 * - The server's own words are kept, cleaned and shortened, instead of a bare
 *   "HTTP 400": the user sees why (seen with LM Studio, 2026-11-05: "No models
 *   loaded. Please load a model in the developer page or use the 'lms load'
 *   command.").
 * - "No model loaded" and "this model is not there" are setup problems of the
 *   local server. They become a LocalServerSetupError, which the host shows
 *   with what to do and never answers by offering a run with Spark.
 *
 * The server's text is untrusted: only shown as a quoted string, never used
 * as an instruction or sent to any model.
 */

import { GenerationContextError, localContextRefusal } from './generationSettings.js';

const MAX_SERVER_TEXT = 240;

/** A context refusal with the sizes the server reported (null when it gave none). */
export class LocalContextTooSmallError extends GenerationContextError {
  constructor(
    message: string,
    readonly needed: number | null,
    readonly available: number | null,
  ) {
    super(message);
  }
}

/** The local server answered but has no model ready to run the request. */
export class LocalServerSetupError extends Error {
  constructor(
    message: string,
    readonly problem: 'no-model-loaded' | 'model-missing',
  ) {
    super(message);
    this.name = 'LocalServerSetupError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The server's error text, cleaned (no control characters, one line) and capped; null when there is none. */
export function localServerErrorText(payload: unknown): string | null {
  let raw: unknown = null;
  if (typeof payload === 'string') {
    raw = payload;
  } else if (isRecord(payload)) {
    const error = payload.error;
    raw = typeof error === 'string' ? error : isRecord(error) ? error.message : payload.message;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0) {
    return null;
  }
  return text.length > MAX_SERVER_TEXT ? `${text.slice(0, MAX_SERVER_TEXT - 1)}…` : text;
}

const NO_MODEL_LOADED = /\bno models? (?:is |are )?(?:currently )?loaded\b/i;
const MODEL_MISSING =
  /\binvalid model identifier\b|\bmodel_not_found\b|\bfailed to load model\b|\bmodel\b[^.]{0,120}?\b(?:not found|does not exist|not loaded|is not available)\b/i;

function errorCode(payload: unknown): string {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  return error !== null && typeof error.code === 'string' ? error.code : '';
}

/** A setup refusal (no model loaded, or the requested model is not there), or null. */
export function localSetupRefusal(payload: unknown, model: string): LocalServerSetupError | null {
  const text = localServerErrorText(payload);
  const quoted = text === null ? '' : ` The server said: "${text}"`;
  const asked = model.trim().length > 0 ? `"${model.trim().slice(0, 120)}"` : 'the chosen model';
  if (text !== null && NO_MODEL_LOADED.test(text)) {
    return new LocalServerSetupError(
      'The local server has no model loaded, so it could not answer. Nothing ran and nothing was sent to Meta. ' +
        'Load the model in the server (in LM Studio: Developer → Load model, or lms load), then send again. ' +
        `RAME asked for ${asked}; if the server loads models on demand, choose a model it lists in the runtime settings.${quoted}`,
      'no-model-loaded',
    );
  }
  if ((text !== null && MODEL_MISSING.test(text)) || errorCode(payload) === 'model_not_found') {
    return new LocalServerSetupError(
      `The local server does not have the model ${asked} ready, so it could not answer. Nothing ran and nothing was sent to Meta. ` +
        `Load that model in the server, or choose a model the server lists in the runtime settings, then send again.${quoted}`,
      'model-missing',
    );
  }
  return null;
}

/**
 * A context refusal that arrives only as text: LM Studio wraps llama.cpp's
 * `exceed_context_size_error` in its own error (seen 2026-11-06: a model it
 * loaded on demand with a 4,096-token context, and an Agent request of about
 * 6,000 tokens). Null for any other reply.
 */
function contextRefusalInText(payload: unknown): GenerationContextError | null {
  const raw = isRecord(payload) ? JSON.stringify(payload) : typeof payload === 'string' ? payload : '';
  if (!/exceeds the available context size|exceed_context_size_error/i.test(raw)) {
    return null;
  }
  const sizes = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i.exec(raw);
  const detail = sizes ? ` (${sizes[1]} input tokens for a ${sizes[2]}-token context)` : '';
  return new LocalContextTooSmallError(
    `The local server's context is too small for this request${detail}. Nothing was cut and no action ran. ` +
      'Load the model in the server with a larger context (Agent needs about 16,384 tokens; in LM Studio, set the context length when loading the model), then send again.',
    sizes ? Number(sizes[1]) : null,
    sizes ? Number(sizes[2]) : null,
  );
}

/**
 * An error the server sent inside a streamed reply (HTTP 200): a context or
 * setup refusal, judged exactly as the same words sent as an HTTP error, or
 * null for any other error. LM Studio sends llama.cpp's context refusal this
 * way (seen 2026-11-10: "Engine protocol predict request returned 400:
 * {... exceed_context_size_error ...}" in the stream of an Agent request).
 */
export function localStreamRefusal(payload: unknown, model: string): GenerationContextError | LocalServerSetupError | null {
  return localContextRefusal(payload) ?? contextRefusalInText(payload) ?? localSetupRefusal(payload, model);
}

/**
 * Any other non-OK reply. The server answered, so it is never read as
 * "unreachable", whatever words its text contains.
 */
export class LocalServerHttpError extends Error {
  constructor(readonly status: number, readonly serverText: string | null) {
    super(serverText === null ? `The local runtime returned HTTP ${status}.` : `The local runtime returned HTTP ${status}: "${serverText}"`);
    this.name = 'LocalServerHttpError';
  }
}

/**
 * The error for a non-OK local reply: a context refusal, then a setup
 * refusal, then the HTTP status with the server's own words when it gave any.
 */
export function localHttpError(status: number, payload: unknown, model: string): GenerationContextError | LocalServerSetupError | LocalServerHttpError {
  const context = localContextRefusal(payload) ?? contextRefusalInText(payload);
  if (context !== null) {
    return context;
  }
  return localSetupRefusal(payload, model) ?? new LocalServerHttpError(status, localServerErrorText(payload));
}
