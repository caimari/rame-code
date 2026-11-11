/**
 * Time limits of a request to a local model (B-30), set per model:
 *   - idle: how long the model may go without sending new useful output,
 *     including the wait for its first token;
 *   - total: how long the whole request may take, even while output keeps
 *     arriving;
 *   - the user's own cancellation, reported apart from both.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Measuring idleness needs the answer streamed, so a request with limits asks
 * for `stream: true` and rebuilds the same payload a non-streamed answer
 * would have had. What counts as progress is new non-blank text (answer,
 * reasoning, or tool-call arguments) that is not the same short text
 * repeated: response headers, keep-alive comments, empty or blank deltas
 * and a loop of repeated text do not reset the idle limit. A server that
 * ignores `stream` and answers in one piece cannot show progress: only the
 * total limit and cancellation apply to it after its headers.
 */

export interface LocalRequestLimits {
  idleMs: number;
  totalMs: number;
}

export const DEFAULT_LOCAL_LIMITS: LocalRequestLimits = { idleMs: 180_000, totalMs: 600_000 };
const IDLE_SEC = { min: 30, max: 1800 };
const TOTAL_SEC = { min: 60, max: 3600 };
export const MAX_LIMITED_MODELS = 32;

export type LimitStop = 'first-output' | 'idle' | 'repetition' | 'total';

const seconds = (ms: number): string => (ms % 60_000 === 0 ? `${ms / 60_000} min` : ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

/** Why a request was stopped, in the words recorded and shown. */
export function limitMessage(stop: LimitStop, limits: LocalRequestLimits): string {
  switch (stop) {
    case 'first-output':
      return `The local model sent no output for ${seconds(limits.idleMs)} after the request (idle limit for this model); it may still be reading a long prompt. Nothing was concluded from this request.`;
    case 'idle':
      return `The local model stopped sending new output for ${seconds(limits.idleMs)} (idle limit for this model). Nothing was concluded from this request.`;
    case 'repetition':
      return `For ${seconds(limits.idleMs)} the local model only sent blank or repeated text, which RAME does not count as progress (idle limit for this model). Nothing was concluded from this request.`;
    case 'total':
      return `The request to the local model took longer than its total limit of ${seconds(limits.totalMs)} for this model, although output was still arriving. Nothing was concluded from this request.`;
  }
}

/** A request stopped by one of its limits (never by the user: that stays an AbortError). */
export class LocalLimitError extends Error {
  constructor(readonly stop: LimitStop, limits: LocalRequestLimits) {
    super(limitMessage(stop, limits));
    this.name = 'LocalLimitError';
  }
}

/** Validate limits given in seconds; null when they are not valid. */
export function validateLocalLimits(raw: unknown): LocalRequestLimits | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const idle = record.idleSec;
  const total = record.totalSec;
  if (
    typeof idle !== 'number' || !Number.isInteger(idle) || idle < IDLE_SEC.min || idle > IDLE_SEC.max ||
    typeof total !== 'number' || !Number.isInteger(total) || total < TOTAL_SEC.min || total > TOTAL_SEC.max ||
    idle > total
  ) {
    return null;
  }
  return { idleMs: idle * 1000, totalMs: total * 1000 };
}

export const LIMIT_RANGES = `idle ${IDLE_SEC.min}–${IDLE_SEC.max} s, total ${TOTAL_SEC.min}–${TOTAL_SEC.max} s, idle no longer than total`;

/** The limits stored for each local model id; invalid entries are dropped. */
export function parseLimitsByModel(raw: unknown): Record<string, { idleSec: number; totalSec: number }> {
  const out: Record<string, { idleSec: number; totalSec: number }> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return out;
  }
  for (const [model, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_LIMITED_MODELS)) {
    const limits = validateLocalLimits(value);
    if (model.trim().length > 0 && model.length <= 256 && limits !== null) {
      out[model] = { idleSec: limits.idleMs / 1000, totalSec: limits.totalMs / 1000 };
    }
  }
  return out;
}

export function limitsForModel(byModel: Record<string, { idleSec: number; totalSec: number }> | undefined, model: string): LocalRequestLimits {
  const entry = byModel?.[model.trim()];
  return entry ? { idleMs: entry.idleSec * 1000, totalMs: entry.totalSec * 1000 } : { ...DEFAULT_LOCAL_LIMITS };
}

/**
 * Is the end of the output one short piece repeated over and over? Checked
 * on the last 600 characters for any period up to 200 characters.
 */
export function isRepeating(tail: string): boolean {
  const window = 600;
  if (tail.length < window) {
    return false;
  }
  const text = tail.slice(-window);
  for (let period = 1; period <= 200; period += 1) {
    let same = true;
    for (let index = period; index < window; index += 1) {
      if (text.charCodeAt(index) !== text.charCodeAt(index - period)) {
        same = false;
        break;
      }
    }
    if (same) {
      return true;
    }
  }
  return false;
}

/** Tracks the output of one streamed answer and says whether a delta is progress. */
export class ProgressTracker {
  private tail = '';
  private sinceCheck = 0;
  private looping = false;
  /** Some delta arrived (useful or not) since the last progress. */
  sawOutput = false;
  anyProgress = false;

  /** Feed new text; true when it counts as progress. */
  feed(delta: string): boolean {
    if (delta.length === 0) {
      return false;
    }
    this.sawOutput = true;
    this.tail = (this.tail + delta).slice(-2000);
    this.sinceCheck += delta.length;
    if (this.sinceCheck >= 64) {
      this.sinceCheck = 0;
      this.looping = isRepeating(this.tail);
    }
    if (delta.trim().length === 0 || this.looping) {
      return false;
    }
    this.anyProgress = true;
    this.sawOutput = false;
    return true;
  }
}

export interface LimitedRequest {
  signal: AbortSignal;
  /** Report new output; resets the idle limit only when it is progress. */
  output(delta: string): void;
  /** The answer cannot be streamed: from now on only the total limit applies. */
  unmeasurable(): void;
  stopped(): LimitStop | null;
  dispose(): void;
}

/** A request signal bounded by idle and total limits and the caller's cancellation. */
export function limitedRequest(parent: AbortSignal | undefined, limits: LocalRequestLimits): LimitedRequest {
  const controller = new AbortController();
  const tracker = new ProgressTracker();
  let stop: LimitStop | null = null;
  const end = (why: LimitStop): void => {
    if (stop === null && !controller.signal.aborted) {
      stop = why;
      controller.abort();
    }
  };
  const onParent = (): void => controller.abort();
  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener('abort', onParent, { once: true });
  }
  const total = setTimeout(() => end('total'), limits.totalMs);
  let idle: ReturnType<typeof setTimeout> | null = null;
  const armIdle = (): void => {
    if (idle !== null) {
      clearTimeout(idle);
    }
    idle = setTimeout(() => end(!tracker.anyProgress && !tracker.sawOutput ? 'first-output' : tracker.sawOutput ? 'repetition' : 'idle'), limits.idleMs);
  };
  armIdle();
  return {
    signal: controller.signal,
    output(delta: string) {
      if (tracker.feed(delta)) {
        armIdle();
      }
    },
    unmeasurable() {
      if (idle !== null) {
        clearTimeout(idle);
        idle = null;
      }
    },
    stopped: () => stop,
    dispose() {
      clearTimeout(total);
      if (idle !== null) {
        clearTimeout(idle);
      }
      parent?.removeEventListener('abort', onParent);
    },
  };
}

type ToolDelta = { id: string; name: string; arguments: string; type: string };

/**
 * Read a streamed (SSE) chat completion and rebuild the payload a
 * non-streamed answer would have had: model, one choice with its message
 * (content, reasoning, tool calls) and finish reason, and usage. Every
 * delta is reported to `output`. An error event becomes `{ error }`.
 */
export async function readStreamedCompletion(response: Response, output: (delta: string) => void): Promise<Record<string, unknown>> {
  const body = response.body;
  if (body === null) {
    throw new Error('The local runtime returned an invalid response.');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let model: unknown;
  let usage: unknown;
  let finish: unknown = null;
  let error: unknown;
  let done = false;
  const tools: ToolDelta[] = [];
  const handle = (line: string): void => {
    if (!line.startsWith('data:')) {
      return; // comments (keep-alive), event names, ids: not output
    }
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new Error('The local runtime returned an invalid response.');
    }
    if (chunk.error !== undefined) {
      error = chunk.error;
      return;
    }
    model ??= chunk.model;
    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = chunk.usage;
    }
    const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Record<string, unknown> | undefined) : undefined;
    if (choice === undefined) {
      return;
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finish = choice.finish_reason;
    }
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === 'string') {
      content += delta.content;
      output(delta.content);
    }
    const thought = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (thought.length > 0) {
      reasoning += thought;
      output(thought);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
        const index = typeof raw.index === 'number' && raw.index >= 0 && raw.index < 64 ? raw.index : tools.length;
        const slot = (tools[index] ??= { id: '', name: '', arguments: '', type: 'function' });
        const fn = (raw.function ?? {}) as Record<string, unknown>;
        if (typeof raw.id === 'string') slot.id += raw.id;
        if (typeof raw.type === 'string') slot.type = raw.type;
        if (typeof fn.name === 'string') slot.name += fn.name;
        if (typeof fn.arguments === 'string') {
          slot.arguments += fn.arguments;
          output(fn.arguments);
        }
      }
    }
  };
  while (!done) {
    const { done: ended, value } = await reader.read();
    if (ended) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      handle(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.trim().length > 0) {
    handle(buffer.trim());
  }
  if (done) {
    await reader.cancel().catch(() => undefined);
  }
  if (error !== undefined) {
    return { error };
  }
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (reasoning.length > 0) {
    message.reasoning_content = reasoning;
  }
  if (tools.some(Boolean)) {
    message.tool_calls = tools.filter(Boolean).map((call) => ({ id: call.id, type: call.type, function: { name: call.name, arguments: call.arguments } }));
  }
  return {
    ...(model !== undefined ? { model } : {}),
    choices: [{ index: 0, message, finish_reason: finish }],
    ...(usage !== undefined ? { usage } : {}),
  };
}
