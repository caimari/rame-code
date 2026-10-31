import type { MissionPlan } from './types.js';

export const META_API_ENDPOINT = 'https://api.meta.ai/v1/chat/completions';
export const META_MODEL = 'muse-spark-1.3';

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
}

export interface CreateMissionPlanOptions {
  apiKey: string;
  goal: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  endpoint?: string;
}

const missionPlanSchema = {
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.endpoint ?? META_API_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: options.signal,
    body: JSON.stringify({
      model: META_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Create a bounded software mission plan. Do not claim to have inspected files or run tools. Return only the requested structured output.',
        },
        {
          role: 'user',
          content: options.goal,
        },
      ],
      max_completion_tokens: 1200,
      response_format: missionPlanSchema,
      store: false,
    }),
  });

  const rawPayload = await response.text();
  const payload = parseResponsePayload(rawPayload);
  if (!response.ok) {
    const detail = payload.error?.message?.trim();
    throw new Error(
      detail
        ? `Meta Model API returned HTTP ${response.status}: ${detail}`
        : `Meta Model API returned HTTP ${response.status}.`,
    );
  }

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
