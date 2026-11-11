/**
 * Limits of a Mission's Advisory grant, all fixed when the user authorizes
 * it and never raised by RAME Code: consultations, bytes per request (the
 * exact request body), bytes sent in total, output tokens per answer, and a
 * total remote token budget. A consultation that would exceed any of them
 * is refused before anything is sent.
 *
 * The token budget is checked against an upper bound: the request body's
 * UTF-8 bytes (every input token covers at least one of them) plus the
 * answer's output cap. What Meta reports replaces that bound once known.
 */

export interface AdvisoryLimits {
  maxRequestBytes: number;
  maxTotalBytes: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
}

/** What the user chose in the grant form; null keeps the default. */
export type ChosenAdvisoryLimits = Partial<Record<keyof AdvisoryLimits, number | null>>;

/** What the grant has used so far; `maxConsultations` null = no count limit (the other limits remain). */
export interface AdvisoryUsage {
  maxConsultations: number | null;
  used: number;
  sentBytes: number;
  usedTokens: number;
}

export const ADVISORY_LIMIT_RANGES: Readonly<Record<keyof AdvisoryLimits, readonly [number, number]>> = {
  maxRequestBytes: [1000, 24000],
  // Up to 1000 full consultations; with no count limit, these totals are what still bounds a Mission.
  maxTotalBytes: [1000, 12_000_000],
  maxOutputTokens: [256, 8192],
  maxTotalTokens: [1000, 14_048_000],
};

const PER_REQUEST_BYTES = 12000;
const PER_ANSWER_TOKENS = 2048;

/** Defaults for n consultations: n full requests and answers, within the ranges; no count limit (null) takes the ceilings. */
export function defaultAdvisoryLimits(maxConsultations: number | null): AdvisoryLimits {
  const n = maxConsultations === null ? Number.MAX_SAFE_INTEGER : Math.max(1, maxConsultations);
  return {
    maxRequestBytes: PER_REQUEST_BYTES,
    maxTotalBytes: Math.min(ADVISORY_LIMIT_RANGES.maxTotalBytes[1], n * PER_REQUEST_BYTES),
    maxOutputTokens: PER_ANSWER_TOKENS,
    maxTotalTokens: Math.min(ADVISORY_LIMIT_RANGES.maxTotalTokens[1], n * (PER_REQUEST_BYTES + PER_ANSWER_TOKENS)),
  };
}

/** The user's values over the defaults; null fields keep the default. */
export function chooseAdvisoryLimits(maxConsultations: number | null, chosen: ChosenAdvisoryLimits | null | undefined): AdvisoryLimits {
  const limits = defaultAdvisoryLimits(maxConsultations);
  for (const key of Object.keys(ADVISORY_LIMIT_RANGES) as Array<keyof AdvisoryLimits>) {
    const value = chosen?.[key];
    if (typeof value === 'number') {
      limits[key] = value;
    }
  }
  return limits;
}

/** null when valid; otherwise why the grant cannot be authorized. */
export function checkAdvisoryLimits(limits: AdvisoryLimits): string | null {
  for (const [key, [min, max]] of Object.entries(ADVISORY_LIMIT_RANGES) as Array<[keyof AdvisoryLimits, readonly [number, number]]>) {
    const value = limits[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      return `Mission Advisory limit ${key} must be an integer from ${min} to ${max}.`;
    }
  }
  if (limits.maxRequestBytes > limits.maxTotalBytes) {
    return 'Mission Advisory limits: the bytes per request cannot exceed the total bytes sent.';
  }
  if (limits.maxOutputTokens > limits.maxTotalTokens) {
    return 'Mission Advisory limits: the output tokens per answer cannot exceed the total remote budget.';
  }
  return null;
}

/** Upper bound of the tokens one request can use: its bytes plus the answer's cap. */
export function tokenBound(requestBytes: number, limits: AdvisoryLimits): number {
  return requestBytes + limits.maxOutputTokens;
}

/** null when the request may be sent; otherwise which limit it would exceed. */
export function refuseOverLimit(limits: AdvisoryLimits, usage: AdvisoryUsage, requestBytes: number): string | null {
  if (usage.maxConsultations !== null && usage.used >= usage.maxConsultations) {
    return `the consultation limit (${usage.used}/${usage.maxConsultations}) is reached`;
  }
  if (requestBytes > limits.maxRequestBytes) {
    return `the request is ${requestBytes} bytes and the limit per request is ${limits.maxRequestBytes}`;
  }
  if (usage.sentBytes + requestBytes > limits.maxTotalBytes) {
    return `the request (${requestBytes} bytes) would bring the total sent to ${usage.sentBytes + requestBytes} of ${limits.maxTotalBytes} bytes`;
  }
  const bound = tokenBound(requestBytes, limits);
  if (usage.usedTokens + bound > limits.maxTotalTokens) {
    return `the request could use up to ${bound} tokens and only ${Math.max(0, limits.maxTotalTokens - usage.usedTokens)} of the ${limits.maxTotalTokens}-token remote budget remain`;
  }
  return null;
}

/** Back-compatible reading of stored limits: absent fields get the defaults. */
export function storedAdvisoryLimits(raw: Record<string, unknown>, maxConsultations: number | null): AdvisoryLimits | null {
  const defaults = defaultAdvisoryLimits(maxConsultations);
  const limits = { ...defaults };
  for (const key of Object.keys(ADVISORY_LIMIT_RANGES) as Array<keyof AdvisoryLimits>) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return null;
      }
      limits[key] = value;
    }
  }
  return limits;
}
