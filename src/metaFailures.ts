/**
 * Stable categories for failed Meta Model API calls, from what the adapter
 * actually observes: the HTTP status (standard HTTP meaning only), the
 * adapter's own timeout and cancellation, and responses it could not use.
 * Meta's exact status codes and messages for quota or balance have not been
 * verified against the real service; a 429 counts as credit/quota only when
 * its message says so, and an unrecognized failure stays "unknown".
 *
 * Details are sanitized: credentials are redacted, control characters and
 * long bodies are cut. Nothing here keeps payloads or full responses.
 */

export type MetaFailureCategory =
  | 'authentication'
  | 'credit'
  | 'rate-limit'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'invalid-response'
  | 'remote-error'
  | 'unknown';

export const META_FAILURE_CATEGORIES: readonly MetaFailureCategory[] = [
  'authentication',
  'credit',
  'rate-limit',
  'network',
  'timeout',
  'cancelled',
  'invalid-response',
  'remote-error',
  'unknown',
];

/** A Meta Model API reply with a non-2xx HTTP status. */
export class MetaHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MetaHttpError';
  }
}

export interface MetaFailure {
  category: MetaFailureCategory;
  /** HTTP status when there was one. */
  status: number | null;
  /** Sanitized, bounded detail; never a payload or a credential. */
  detail: string;
}

/** Plain words for each category, for the host record and the view. */
export const META_FAILURE_LABELS: Record<MetaFailureCategory, string> = {
  authentication: 'authentication failed',
  credit: 'credit, balance, or quota exhausted',
  'rate-limit': 'rate limited',
  network: 'network error',
  timeout: 'timed out',
  cancelled: 'cancelled',
  'invalid-response': 'invalid or incomplete response',
  'remote-error': 'Meta returned an error',
  unknown: 'unknown error',
};

const QUOTA_WORDS = /\b(quota|credit|credits|balance|billing|insufficient|payment required)\b/i;
const NETWORK_WORDS = /fetch failed|network|econnrefused|econnreset|enotfound|eai_again|socket|tls|certificate/i;
const INVALID_WORDS = /returned no (advice|assistant reply|mission plan)|invalid json|unexpected token|not valid json|the advice |cut off at the .*output limit/i;
const MAX_DETAIL = 200;

/** Remove credentials and control characters; bound the length. */
export function sanitizeFailureDetail(text: string, secrets: readonly string[]): string {
  let clean = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      clean = clean.split(secret).join('[redacted]');
    }
  }
  clean = clean.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
  return clean.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL) || 'no detail';
}

function isAbort(error: unknown): boolean {
  return (error instanceof Error || (typeof DOMException !== 'undefined' && error instanceof DOMException)) && (error as Error).name === 'AbortError';
}

/** Classify one failed Meta call. */
export function classifyMetaFailure(error: unknown, secrets: readonly string[] = []): MetaFailure {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const detail = sanitizeFailureDetail(message, secrets);
  if (isAbort(error)) {
    return { category: 'cancelled', status: null, detail };
  }
  if (error instanceof MetaHttpError) {
    const status = error.status;
    const category: MetaFailureCategory =
      status === 401 || status === 403
        ? 'authentication'
        : status === 402
          ? 'credit'
          : status === 429
            ? QUOTA_WORDS.test(message) ? 'credit' : 'rate-limit'
            : status === 408 || status === 504
              ? 'timeout'
              : status >= 500
                ? 'remote-error'
                : status >= 400
                  ? 'remote-error'
                  : 'unknown';
    return { category, status, detail };
  }
  if (/timed out/i.test(message)) {
    return { category: 'timeout', status: null, detail };
  }
  if ((error instanceof Error && (error.name === 'OutputCutOffError' || error instanceof SyntaxError)) || INVALID_WORDS.test(message)) {
    return { category: 'invalid-response', status: null, detail };
  }
  if (NETWORK_WORDS.test(message)) {
    return { category: 'network', status: null, detail };
  }
  return { category: 'unknown', status: null, detail };
}

/** One line for the host record: category, status, sanitized detail. */
export function describeMetaFailure(failure: MetaFailure): string {
  return `${META_FAILURE_LABELS[failure.category]}${failure.status !== null ? ` (HTTP ${failure.status})` : ''}: ${failure.detail}`;
}
