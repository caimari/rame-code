/**
 * Token-usage parsing and accounting for the single RAME Code view.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Provider responses may or may not carry usage fields, and field names
 * differ between back ends, so every read here is defensive: missing or
 * malformed values count as zero rather than throwing.
 */

/** Token counts for one provider call. All fields are non-negative integers. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export const EMPTY_USAGE: ProviderUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
};

function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function firstCount(candidates: unknown[]): number {
  for (const candidate of candidates) {
    const count = toCount(candidate);
    if (count > 0) {
      return count;
    }
  }
  return 0;
}

/**
 * Extract token counts from an untrusted provider payload. Recognizes
 * OpenAI-style (`prompt_tokens`, `completion_tokens`, `total_tokens`) and
 * common vendor variants (`input_tokens`, `output_tokens`, `prompt_tokens`
 * details with `cached_tokens`). Never throws and never echoes input.
 */
export function parseUsage(payload: unknown): ProviderUsage {
  if (typeof payload !== 'object' || payload === null) {
    return { ...EMPTY_USAGE };
  }
  const record = payload as Record<string, unknown>;
  const usage = record.usage;
  if (typeof usage !== 'object' || usage === null) {
    return { ...EMPTY_USAGE };
  }
  const detail = usage as Record<string, unknown>;
  const nestedDetails = (key: string): Record<string, unknown> => {
    const value = detail[key];
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  };
  const promptDetails = nestedDetails('prompt_tokens_details');
  const completionDetails = nestedDetails('completion_tokens_details');

  const inputTokens = firstCount([
    detail.prompt_tokens,
    detail.input_tokens,
    detail.inputTokens,
  ]);
  const outputTokens = firstCount([
    detail.completion_tokens,
    detail.output_tokens,
    detail.outputTokens,
  ]);
  const cachedTokens = firstCount([
    detail.cached_tokens,
    detail.cachedTokens,
    promptDetails.cached_tokens,
    promptDetails.cachedTokens,
  ]);
  const totalTokens = firstCount([
    detail.total_tokens,
    detail.totalTokens,
    inputTokens + outputTokens > 0 ? inputTokens + outputTokens : 0,
  ]);

  return { inputTokens, outputTokens, cachedTokens, totalTokens };
}

/** Add two usage records field by field. */
export function addUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * Monetary-estimate rates, isolated in one named constant.
 *
 * Source note (2026-11-01): placeholder planning rates only — no
 * billing-balance API has been established, so any dollar figure derived
 * from these rates is an estimate and must be labeled as such in the UI.
 * Prefer token counts over price estimates.
 */
export interface EstimateRates {
  /** USD per 1M input tokens. */
  inputPerMillionUsd: number;
  /** USD per 1M output tokens. */
  outputPerMillionUsd: number;
  /** Date the rates were recorded, ISO `YYYY-MM-DD`. */
  ratesDated: string;
}

export const ESTIMATE_RATES: EstimateRates = {
  inputPerMillionUsd: 0,
  outputPerMillionUsd: 0,
  ratesDated: '2026-11-01',
};

/** Estimate USD cost for a usage record. Always an estimate, never a bill. */
export function estimateCostUsd(
  usage: ProviderUsage,
  rates: EstimateRates = ESTIMATE_RATES,
): number {
  return (
    (usage.inputTokens / 1_000_000) * rates.inputPerMillionUsd +
    (usage.outputTokens / 1_000_000) * rates.outputPerMillionUsd
  );
}
