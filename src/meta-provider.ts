import { MISSION_SYSTEM_PROMPT } from './missionPlanRules.js';
import { MetaHttpError } from './metaFailures.js';
import { withBoundedRequest } from './boundedRequest.js';
import {
  CLOUD_AUTO_OUTPUT_TOKENS,
  OutputCutOffError,
  generationRequestFields,
  stoppedAtLength,
  type GenerationRequest,
} from './generationSettings.js';
import type { MissionPlan } from './types.js';
import { parseUsage, type ProviderUsage } from './usage.js';

export const META_API_ENDPOINT = 'https://api.meta.ai/v1/chat/completions';
export const META_MODEL = 'muse-spark-1.3';

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
  usage?: unknown;
}

export interface ChatTextResult {
  text: string;
  usage: ProviderUsage;
}

export interface MissionPlanResult {
  plan: MissionPlan;
  usage: ProviderUsage;
}

export interface CreateMissionPlanOptions {
  apiKey: string;
  goal: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  endpoint?: string;
  /** Exact validated cloud model selection; defaults to `muse-spark-1.3`. */
  model?: string;
  /** Deadline covering headers and body; defaults to 120 seconds. */
  timeoutMs?: number;
  /**
   * Output budget and reasoning level fixed when the run started. Callers
   * without generation settings get the automatic Meta budget and no
   * reasoning parameter.
   */
  generation?: GenerationRequest;
}

const AUTOMATIC_CLOUD_GENERATION: GenerationRequest = {
  maxCompletionTokens: CLOUD_AUTO_OUTPUT_TOKENS,
  reasoning: null,
  reasoningParam: null,
};

function generationFields(options: CreateMissionPlanOptions): Record<string, unknown> {
  return generationRequestFields(options.generation ?? AUTOMATIC_CLOUD_GENERATION);
}

/** Reject a reply that stopped at its output budget instead of using it. */
function assertNotCutOff(options: CreateMissionPlanOptions, payload: unknown): void {
  if (stoppedAtLength(payload)) {
    throw new OutputCutOffError((options.generation ?? AUTOMATIC_CLOUD_GENERATION).maxCompletionTokens);
  }
}

const META_TIMEOUT_MESSAGE = 'Meta Model API request timed out after 120 seconds.';

/**
 * POST one Meta request and read its whole body under one deadline, so a
 * response that never finishes cannot hang the caller.
 */
async function postMetaRequest(
  options: CreateMissionPlanOptions,
  body: Record<string, unknown>,
): Promise<{ response: Response; rawPayload: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  return withBoundedRequest(options.signal, options.timeoutMs, META_TIMEOUT_MESSAGE, async (signal) => {
    const response = await fetchImpl(options.endpoint ?? META_API_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify(body),
    });
    return { response, rawPayload: await response.text() };
  });
}

function selectedModel(value: unknown): string {
  if (typeof value === 'string') {
    const id = value.trim();
    if (
      id.length > 0 &&
      id.length <= 128 &&
      /^muse-(spark|wonder)-[A-Za-z0-9._-]+$/.test(id)
    ) {
      return id;
    }
  }
  return META_MODEL;
}

/** Strict structured-output format of a Mission plan (also sent to the local server). */
export const missionPlanSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'rame_mission_plan',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        assumptions: {
          type: 'array',
          items: { type: 'string' },
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              successCriterion: { type: 'string' },
            },
            required: ['id', 'title', 'successCriterion'],
            additionalProperties: false,
          },
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['goal', 'assumptions', 'steps', 'risks'],
      additionalProperties: false,
    },
  },
} as const;

export async function createMissionPlan(
  options: CreateMissionPlanOptions,
): Promise<MissionPlan> {
  const { response, rawPayload } = await postMetaRequest(options, {
    model: selectedModel(options.model),
    messages: [
      {
        role: 'system',
        content:
          MISSION_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: options.goal,
      },
    ],
    ...generationFields(options),
    response_format: missionPlanSchema,
    store: false,
  });
  const payload = parseResponsePayload(rawPayload);
  if (!response.ok) {
    const detail = payload.error?.message?.trim();
    throw new MetaHttpError(
      response.status,
      detail
        ? `Meta Model API returned HTTP ${response.status}: ${detail}`
        : `Meta Model API returned HTTP ${response.status}.`,
    );
  }
  assertNotCutOff(options, payload);

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('Meta Model API returned no mission plan.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(content) as unknown;
  } catch {
    throw new Error('Meta Model API returned an invalid JSON mission plan.');
  }

  return validateMissionPlan(decoded);
}

/**
 * Conversational Chat-mode call against Meta Model API. Returns the
 * assistant prose plus defensively parsed usage. A successful result lets
 * the caller mark the connection verified.
 */
export async function createChatCompletion(
  options: CreateMissionPlanOptions & { messages: ChatMessageInput[] },
): Promise<ChatTextResult> {
  const { response, rawPayload } = await postMetaRequest(options, {
    model: selectedModel(options.model),
    messages: options.messages,
    ...generationFields(options),
    store: false,
  });
  const payload = parseResponsePayload(rawPayload);
  if (!response.ok) {
    const detail = payload.error?.message?.trim();
    throw new MetaHttpError(
      response.status,
      detail
        ? `Meta Model API returned HTTP ${response.status}: ${detail}`
        : `Meta Model API returned HTTP ${response.status}.`,
    );
  }
  assertNotCutOff(options, payload);

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('Meta Model API returned no assistant reply.');
  }
  return { text: content, usage: parseUsage(payload) };
}

/**
 * Cascade consultation: send the exact payload the user approved, with no
 * tools, and get strict structured advice back. The advice is validated and
 * bounded by the caller; it is never treated as an instruction.
 */
export async function createCascadeAdvice(
  options: Omit<CreateMissionPlanOptions, 'goal'> & { payload: string; schema: unknown; systemPrompt?: string },
): Promise<{ content: string; usage: ProviderUsage }> {
  const { response, rawPayload } = await postMetaRequest({ ...options, goal: '' }, {
    model: selectedModel(options.model),
    messages: [
      {
        role: 'system',
        content:
          options.systemPrompt ??
          'You advise a local coding agent that has its own file and test tools. You cannot see the project and you cannot run tools. Do not claim to have inspected anything. Return only the requested structured output.',
      },
      { role: 'user', content: options.payload },
    ],
    ...generationFields({ ...options, goal: '' }),
    response_format: options.schema,
    store: false,
  });
  const payload = parseResponsePayload(rawPayload);
  if (!response.ok) {
    const detail = payload.error?.message?.trim();
    throw new MetaHttpError(
      response.status,
      detail
        ? `Meta Model API returned HTTP ${response.status}: ${detail}`
        : `Meta Model API returned HTTP ${response.status}.`,
    );
  }
  assertNotCutOff({ ...options, goal: '' }, payload);
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('Meta Model API returned no advice.');
  }
  return { content, usage: parseUsage(payload) };
}

/**
 * Mission-plan call that also returns defensively parsed usage. The
 * existing {@link createMissionPlan} behavior is unchanged.
 */
export async function createMissionPlanWithUsage(
  options: CreateMissionPlanOptions,
): Promise<MissionPlanResult> {
  const { response, rawPayload } = await postMetaRequest(options, {
    model: selectedModel(options.model),
    messages: [
      {
        role: 'system',
        content:
          MISSION_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: options.goal,
      },
    ],
    ...generationFields(options),
    response_format: missionPlanSchema,
    store: false,
  });
  const payload = parseResponsePayload(rawPayload);
  if (!response.ok) {
    const detail = payload.error?.message?.trim();
    throw new MetaHttpError(
      response.status,
      detail
        ? `Meta Model API returned HTTP ${response.status}: ${detail}`
        : `Meta Model API returned HTTP ${response.status}.`,
    );
  }
  assertNotCutOff(options, payload);

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('Meta Model API returned no mission plan.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(content) as unknown;
  } catch {
    throw new Error('Meta Model API returned an invalid JSON mission plan.');
  }

  return { plan: validateMissionPlan(decoded), usage: parseUsage(payload) };
}

export function validateMissionPlan(value: unknown): MissionPlan {
  if (!isRecord(value)) {
    throw new Error('Mission plan is not an object.');
  }

  if (
    !isNonEmptyString(value.goal) ||
    !isStringArray(value.assumptions) ||
    !isStringArray(value.risks) ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0
  ) {
    throw new Error('Mission plan has an invalid shape.');
  }

  const steps = value.steps.map((step) => {
    if (
      !isRecord(step) ||
      !isNonEmptyString(step.id) ||
      !isNonEmptyString(step.title) ||
      !isNonEmptyString(step.successCriterion)
    ) {
      throw new Error('Mission plan contains an invalid step.');
    }
    return {
      id: step.id,
      title: step.title,
      successCriterion: step.successCriterion,
    };
  });

  return {
    goal: value.goal,
    assumptions: [...value.assumptions],
    steps,
    risks: [...value.risks],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseResponsePayload(rawPayload: string): ChatCompletionResponse {
  if (rawPayload.length === 0) {
    return {};
  }

  try {
    return JSON.parse(rawPayload) as ChatCompletionResponse;
  } catch {
    return {};
  }
}
