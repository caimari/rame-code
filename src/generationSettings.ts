/**
 * Generation controls per provider/model: reasoning effort, output budget,
 * and context window. They stay separate from each other and from the
 * Agent step budget (`MAX_AGENT_STEPS`), which this module never touches.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * Only parameters verified in provider documentation or in the local
 * server's own template are ever sent:
 * - Meta Model API (dev.meta.ai/docs/protocols/chat-completions, /reasoning,
 *   /models): `reasoning_effort` accepts minimal/low/medium/high/xhigh and,
 *   on selected models, max;
 *   "none" returns HTTP 400 for Muse Spark and Muse Wonder, so reasoning
 *   cannot be turned off. `max_completion_tokens` caps reasoning plus
 *   visible output, and input plus output must fit the 1,048,576-token
 *   context window. Meta's Muse Spark 1.3 quickstart documents a 131,072
 *   output limit, which is also RAME Code's cloud safety ceiling.
 * - Muse Glimmer (GGUF chat template and its model card): the template
 *   reads `reasoning_strength` (low/medium/high/xhigh, default high) from
 *   `chat_template_kwargs`; it ignores `reasoning_effort`, and reasoning
 *   cannot be switched off. Its native context is 131,072 tokens; the
 *   per-request context is what the running server reports.
 */

export type GenerationProviderId = 'cloud' | 'local';

export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** `default` sends no reasoning parameter: the model decides. */
export type ReasoningChoice = 'default' | ReasoningLevel;

export const REASONING_LEVELS: readonly ReasoningLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const GLIMMER_REASONING_LEVELS: readonly ReasoningLevel[] = ['low', 'medium', 'high', 'xhigh'];
const META_REASONING_LEVELS: readonly ReasoningLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
export const REASONING_LABELS: Readonly<Record<ReasoningChoice, string>> = {
  default: 'Model default',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

/** Where a reasoning level goes in the request body. */
export type ReasoningParam = 'reasoning_effort' | 'chat_template_kwargs.reasoning_strength';

export interface ModelGenerationProfile {
  /** Explicit levels this exact provider/model accepts (may be empty). */
  reasoningLevels: readonly ReasoningLevel[];
  reasoningParam: ReasoningParam | null;
  /** What the model does with no level, as documented ("model-set" when unstated). */
  reasoningDefault: string;
  /** Tokens one request may use (input plus output); null when unknown. */
  contextWindow: number | null;
  /** Documented model output maximum; null when none is documented. */
  maxOutputTokens: number | null;
  /** Output budget used when no manual maximum is set. */
  autoOutputTokens: number;
  /** Where the profile came from, for display. */
  source: string;
}

export const META_CONTEXT_WINDOW = 1048576;
export const META_OUTPUT_LIMIT = 131072;
/**
 * Local automatic budget: Glimmer reasons before it answers and reasoning
 * counts against the budget. 4096 was measured as enough for its tool
 * steps and fits the 120 s request deadline at the slowest measured
 * ~80 tokens/s.
 */
export const LOCAL_AUTO_OUTPUT_TOKENS = 4096;
/**
 * Meta's economical automatic budget. Higher selected reasoning levels use
 * progressively larger automatic budgets through `automaticOutputTokens`.
 */
export const CLOUD_AUTO_OUTPUT_TOKENS = 32768;
/** Below this the reply would be cut almost at once, so the request is not sent. */
export const MIN_OUTPUT_TOKENS = 512;
/** Margin for template and tool-schema tokens the estimate cannot see. */
export const CONTEXT_SAFETY_TOKENS = 256;
export const MANUAL_OUTPUT_MIN = 256;
export const MANUAL_OUTPUT_MAX: Readonly<Record<GenerationProviderId, number>> = {
  local: 262144,
  cloud: META_OUTPUT_LIMIT,
};
export const MAX_STORED_REASONING_ENTRIES = 64;

const META_DOCUMENTED_MODELS: Readonly<Record<string, { reasoningLevels: readonly ReasoningLevel[]; maxOutputTokens: number | null }>> = {
  'muse-spark-1.1': { reasoningLevels: META_REASONING_LEVELS, maxOutputTokens: null },
  'muse-spark-1.2': { reasoningLevels: META_REASONING_LEVELS, maxOutputTokens: null },
  'muse-spark-1.3': { reasoningLevels: [...META_REASONING_LEVELS, 'max'], maxOutputTokens: META_OUTPUT_LIMIT },
  'muse-wonder-1.0': { reasoningLevels: [...META_REASONING_LEVELS, 'max'], maxOutputTokens: null },
  'muse-spark-1.2-contributor': { reasoningLevels: META_REASONING_LEVELS, maxOutputTokens: null },
  'muse-spark-1.3-contributor': { reasoningLevels: META_REASONING_LEVELS, maxOutputTokens: META_OUTPUT_LIMIT },
};

/** Automatic output budget selected for one provider and reasoning choice. */
export function automaticOutputTokens(provider: GenerationProviderId, reasoning: ReasoningChoice): number {
  if (provider === 'local') {
    return LOCAL_AUTO_OUTPUT_TOKENS;
  }
  switch (reasoning) {
    case 'minimal':
    case 'low':
      return 8192;
    case 'medium':
      return 16384;
    case 'xhigh':
      return 65536;
    case 'max':
      return META_OUTPUT_LIMIT;
    case 'default':
    case 'high':
      return 32768;
  }
}

/** Profile for one Meta cloud model id. Unknown ids get no explicit levels. */
export function cloudGenerationProfile(model: string): ModelGenerationProfile {
  const known = META_DOCUMENTED_MODELS[model.trim()];
  return {
    reasoningLevels: known ? known.reasoningLevels : [],
    reasoningParam: known ? 'reasoning_effort' : null,
    reasoningDefault: 'model-set',
    contextWindow: known ? META_CONTEXT_WINDOW : null,
    maxOutputTokens: known ? known.maxOutputTokens : null,
    autoOutputTokens: CLOUD_AUTO_OUTPUT_TOKENS,
    source: known ? 'Meta Model API documentation' : 'not documented for this model',
  };
}

export type LocalTemplateKind = 'muse-glimmer' | 'other' | 'unknown';

export interface LocalServerProps {
  /** Per-request context reported by the server (`n_ctx` per slot). */
  contextWindow: number | null;
  template: LocalTemplateKind;
}

export const UNKNOWN_LOCAL_PROPS: Readonly<LocalServerProps> = { contextWindow: null, template: 'unknown' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the two facts RAME needs from a llama-server `/props` reply: the
 * per-slot context and whether the chat template is Muse Glimmer's (it
 * reads `reasoning_strength` and renders a "Reasoning strength:" line).
 * Anything else is treated as unknown.
 */
export function parseLlamaServerProps(payload: unknown): LocalServerProps {
  if (!isRecord(payload)) {
    return { ...UNKNOWN_LOCAL_PROPS };
  }
  const settings = payload.default_generation_settings;
  const nCtx = isRecord(settings) ? settings.n_ctx : undefined;
  const contextWindow =
    typeof nCtx === 'number' && Number.isInteger(nCtx) && nCtx > 0 && nCtx <= 16777216 ? nCtx : null;
  const template = payload.chat_template;
  let kind: LocalTemplateKind = 'unknown';
  if (typeof template === 'string' && template.length > 0) {
    kind =
      template.includes('reasoning_strength') && template.includes('Reasoning strength: ')
        ? 'muse-glimmer'
        : 'other';
  }
  return { contextWindow, template: kind };
}

/**
 * Profile for the local runtime. Reasoning levels are offered only when the
 * running server's template is Muse Glimmer's; the context is the one the
 * server reports, else the context size RAME itself started it with.
 */
export function localGenerationProfile(
  props: LocalServerProps | null,
  configuredContext: number | null,
): ModelGenerationProfile {
  const glimmer = props?.template === 'muse-glimmer';
  const contextWindow = props?.contextWindow ?? configuredContext;
  return {
    reasoningLevels: glimmer ? GLIMMER_REASONING_LEVELS : [],
    reasoningParam: glimmer ? 'chat_template_kwargs.reasoning_strength' : null,
    reasoningDefault: glimmer ? 'high' : 'model-set',
    contextWindow,
    maxOutputTokens: null,
    autoOutputTokens: LOCAL_AUTO_OUTPUT_TOKENS,
    source: glimmer
      ? 'Muse Glimmer chat template on the running server'
      : props && props.template === 'other'
        ? 'running server template (no reasoning control found)'
        : 'local server not inspected yet',
  };
}

/**
 * The reply reached the output budget (`finish_reason: "length"`). Nothing
 * in it is used: no tool call runs and no partial text is stored.
 */
export class OutputCutOffError extends Error {
  constructor(readonly maxCompletionTokens: number) {
    super(
      `The reply was cut off at the ${maxCompletionTokens}-token output limit, so it was discarded. ` +
        'Raise the maximum output tokens in Settings › Generation, or lower the reasoning effort.',
    );
    this.name = 'OutputCutOffError';
  }
}

/** The request cannot fit the context window; nothing was cut or sent. */
export class GenerationContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationContextError';
  }
}

/**
 * llama-server answers an input that does not fit its context with HTTP 400
 * and `type: "exceed_context_size_error"` (with its own token counts).
 * Returns that refusal as a clear error, or null for any other reply.
 */
export function localContextRefusal(payload: unknown): GenerationContextError | null {
  if (!isRecord(payload)) {
    return null;
  }
  const error = isRecord(payload.error) ? payload.error : payload;
  if (error.type !== 'exceed_context_size_error') {
    return null;
  }
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
  const prompt = count(error.n_prompt_tokens);
  const context = count(error.n_ctx);
  const sizes = prompt !== null && context !== null ? ` (${prompt} input tokens for a ${context}-token context)` : '';
  // Worded without "refused": that word marks an unreachable server upstream.
  return new GenerationContextError(
    `The local server rejected the request because it does not fit its context${sizes}. ` +
      'Nothing was cut and no action ran. Start a new thread or raise the local context size.',
  );
}

/** True when a chat completion stopped at its output budget. */
export function stoppedAtLength(payload: unknown): boolean {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return false;
  }
  const first: unknown = payload.choices[0];
  return isRecord(first) && first.finish_reason === 'length';
}

export interface OutputBudget {
  maxCompletionTokens: number;
  /** What was asked for before any limit applied. */
  requested: number;
  source: 'automatic' | 'manual';
  limitedBy: null | 'model' | 'context';
}

/**
 * Choose `max_completion_tokens` for one request: the manual maximum (or
 * the automatic budget), never above a documented model maximum, and never
 * more than the context leaves after the estimated input. The input is
 * never shortened to make room: when the free context is too small the
 * request is refused with a clear error instead.
 */
export function resolveOutputBudget(
  provider: GenerationProviderId,
  profile: ModelGenerationProfile,
  manualMax: number | null,
  promptTokens: number,
): OutputBudget {
  const source = manualMax !== null ? 'manual' : 'automatic';
  const requested = manualMax ?? profile.autoOutputTokens;
  let budget = requested;
  let limitedBy: OutputBudget['limitedBy'] = null;
  if (profile.maxOutputTokens !== null && budget > profile.maxOutputTokens) {
    budget = profile.maxOutputTokens;
    limitedBy = 'model';
  }
  if (profile.contextWindow !== null) {
    const free = profile.contextWindow - promptTokens - CONTEXT_SAFETY_TOKENS;
    const needed = Math.min(requested, MIN_OUTPUT_TOKENS);
    if (free < needed) {
      throw new GenerationContextError(
        `This request needs about ${promptTokens} input tokens, which leaves ${Math.max(0, free)} of the ` +
          `${profile.contextWindow}-token context for the reply (at least ${needed} are needed). ` +
          'Nothing was cut and nothing was sent. ' +
          (provider === 'local'
            ? 'Start a new thread or raise the local context size.'
            : 'Start a new thread with a shorter request.'),
      );
    }
    if (budget > free) {
      budget = free;
      limitedBy = 'context';
    }
  }
  return { maxCompletionTokens: budget, requested, source, limitedBy };
}

/** Visible note when the budget is below what was asked for; null otherwise. */
export function describeBudgetLimit(budget: OutputBudget): string | null {
  if (budget.limitedBy === null) {
    return null;
  }
  const reason = budget.limitedBy === 'context' ? 'to fit the free context' : 'to the model maximum';
  return `Output budget reduced from ${budget.requested} (${budget.source}) to ${budget.maxCompletionTokens} tokens ${reason}.`;
}

/**
 * Conservative input-token estimate from the serialized request. Without a
 * measurement it assumes 3 characters per token; with one from an earlier
 * reply in the same run it uses that ratio plus 10 %, never below 4
 * characters per token.
 */
export function estimatePromptTokens(
  request: unknown,
  calibration?: { chars: number; tokens: number } | null,
): number {
  const chars = JSON.stringify(request ?? null).length;
  let perChar = 1 / 3;
  if (calibration && calibration.chars > 0 && calibration.tokens > 0) {
    perChar = Math.min(1, Math.max(1 / 4, (calibration.tokens / calibration.chars) * 1.1));
  }
  return Math.ceil(chars * perChar);
}

/** Parameters for one request, fixed when the run starts. */
export interface GenerationRequest {
  maxCompletionTokens: number;
  reasoning: ReasoningLevel | null;
  reasoningParam: ReasoningParam | null;
}

/** Body fields for one request; a default reasoning choice adds nothing. */
export function generationRequestFields(request: GenerationRequest): Record<string, unknown> {
  const fields: Record<string, unknown> = { max_completion_tokens: request.maxCompletionTokens };
  if (request.reasoning !== null && request.reasoningParam === 'reasoning_effort') {
    fields.reasoning_effort = request.reasoning;
  } else if (request.reasoning !== null && request.reasoningParam === 'chat_template_kwargs.reasoning_strength') {
    fields.chat_template_kwargs = { reasoning_strength: request.reasoning };
  }
  return fields;
}

export interface GenerationSettings {
  /** Explicit level per `provider:model`; a missing key means Model default. */
  reasoningByModel: Record<string, ReasoningLevel>;
  /** Advanced manual output maximum per provider; null means automatic. */
  maxOutputTokens: Record<GenerationProviderId, number | null>;
}

export function defaultGenerationSettings(): GenerationSettings {
  return { reasoningByModel: {}, maxOutputTokens: { local: null, cloud: null } };
}

const REASONING_KEY_PATTERN = /^(cloud|local):[A-Za-z0-9._-]{1,128}$/;

export function reasoningKey(provider: GenerationProviderId, model: string): string {
  return `${provider}:${model.trim()}`;
}

export function isReasoningChoice(value: unknown): value is ReasoningChoice {
  return value === 'default' || REASONING_LEVELS.includes(value as ReasoningLevel);
}

/** Validate an untrusted manual maximum; null clears it (automatic). */
export function parseManualMaxOutput(provider: GenerationProviderId, value: unknown): number | null {
  if (value === null) {
    return null;
  }
  const max = MANUAL_OUTPUT_MAX[provider];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MANUAL_OUTPUT_MIN || value > max) {
    throw new Error(`The maximum output tokens must be a whole number from ${MANUAL_OUTPUT_MIN} to ${max}, or empty for automatic.`);
  }
  return value;
}

/** Validate untrusted persisted generation settings; invalid entries are dropped. */
export function validateGenerationSettings(value: unknown): GenerationSettings {
  const result = defaultGenerationSettings();
  if (!isRecord(value)) {
    return result;
  }
  if (isRecord(value.reasoningByModel)) {
    for (const [key, level] of Object.entries(value.reasoningByModel).slice(0, MAX_STORED_REASONING_ENTRIES)) {
      if (REASONING_KEY_PATTERN.test(key) && REASONING_LEVELS.includes(level as ReasoningLevel)) {
        result.reasoningByModel[key] = level as ReasoningLevel;
      }
    }
  }
  if (isRecord(value.maxOutputTokens)) {
    for (const provider of ['local', 'cloud'] as const) {
      try {
        result.maxOutputTokens[provider] = parseManualMaxOutput(provider, value.maxOutputTokens[provider] ?? null);
      } catch {
        result.maxOutputTokens[provider] = null;
      }
    }
  }
  return result;
}

/** Store one choice; `default` removes the entry. Returns new settings. */
export function withReasoningChoice(
  settings: GenerationSettings,
  provider: GenerationProviderId,
  model: string,
  choice: ReasoningChoice,
): GenerationSettings {
  const reasoningByModel = { ...settings.reasoningByModel };
  const key = reasoningKey(provider, model);
  if (choice === 'default') {
    delete reasoningByModel[key];
  } else {
    if (!(key in reasoningByModel) && Object.keys(reasoningByModel).length >= MAX_STORED_REASONING_ENTRIES) {
      throw new Error('Too many stored reasoning choices; reset one to Model default first.');
    }
    reasoningByModel[key] = choice;
  }
  return { ...settings, reasoningByModel };
}

export interface ReasoningResolution {
  /** Level that will be sent; null sends no reasoning parameter. */
  level: ReasoningLevel | null;
  /** What the user stored for this provider/model. */
  stored: ReasoningChoice;
  /** The stored level cannot be applied to this provider/model. */
  unavailable: boolean;
}

/** Apply a stored level only when this exact provider/model accepts it. */
export function resolveReasoning(
  settings: GenerationSettings,
  provider: GenerationProviderId,
  model: string,
  profile: ModelGenerationProfile,
): ReasoningResolution {
  const stored: ReasoningLevel | undefined = settings.reasoningByModel[reasoningKey(provider, model)];
  if (stored === undefined) {
    return { level: null, stored: 'default', unavailable: false };
  }
  if (profile.reasoningParam !== null && profile.reasoningLevels.includes(stored)) {
    return { level: stored, stored, unavailable: false };
  }
  return { level: null, stored, unavailable: true };
}
