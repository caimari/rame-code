/** Bounded webview projection of the optional independent acceptance review. */
export interface MissionAcceptanceReviewView {
  status: 'offered' | 'sending' | 'completed' | 'failed' | 'malformed' | 'budget-refused' | 'cancelled';
  model: string;
  processingClass: 'standard';
  commandId: string;
  files: Array<{ path: string; hash: string; chars: number; truncated: boolean }>;
  provenance: 'glimmer' | 'user' | 'mixed';
  payload: string;
  digest: string;
  requestBytes: number;
  sentBytes: number;
  maxRequestBytes: number;
  maxConsultations: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  attempts: number;
  usedTokens: number;
  decision: 'pending' | 'considered' | 'dismissed';
  result: { requirements: Array<{ requirement: string; tests: string[]; coverage: string }>; risks: string[]; additionalCases: string[]; recommendation: string } | null;
  failure: string;
}

const STATUSES = ['offered', 'sending', 'completed', 'failed', 'malformed', 'budget-refused', 'cancelled'] as const;
type RecordValue = Record<string, unknown>;

const object = (value: unknown): RecordValue | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null;
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.slice(0, max) : '';
const count = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
const strings = (value: unknown, max: number, each: number): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, max).map((item) => item.slice(0, each)) : [];

export function sanitizeMissionAcceptanceReviewView(value: unknown): MissionAcceptanceReviewView | null {
  const review = object(value);
  if (review === null || !STATUSES.includes(review.status as typeof STATUSES[number]) || typeof review.digest !== 'string' || !/^[0-9a-f]{64}$/.test(review.digest)) {
    return null;
  }
  const result = object(review.result);
  return {
    status: review.status as MissionAcceptanceReviewView['status'],
    model: text(review.model, 128),
    processingClass: 'standard',
    commandId: text(review.commandId, 128),
    files: (Array.isArray(review.files) ? review.files : []).map(object).filter((file): file is RecordValue => file !== null).slice(0, 3).map((file) => ({
      path: text(file.path, 512), hash: text(file.hash, 64), chars: count(file.chars), truncated: file.truncated === true,
    })),
    provenance: review.provenance === 'user' || review.provenance === 'mixed' ? review.provenance : 'glimmer',
    payload: text(review.payload, 12000),
    digest: review.digest,
    requestBytes: count(review.requestBytes),
    sentBytes: count(review.sentBytes),
    maxRequestBytes: count(review.maxRequestBytes),
    maxConsultations: count(review.maxConsultations),
    maxOutputTokens: count(review.maxOutputTokens),
    maxTotalTokens: count(review.maxTotalTokens),
    attempts: count(review.attempts),
    usedTokens: count(review.usedTokens),
    decision: review.decision === 'considered' || review.decision === 'dismissed' ? review.decision : 'pending',
    result: result === null ? null : {
      requirements: (Array.isArray(result.requirements) ? result.requirements : []).map(object).filter((item): item is RecordValue => item !== null).slice(0, 20).map((item) => ({
        requirement: text(item.requirement, 500), tests: strings(item.tests, 12, 500), coverage: text(item.coverage, 700),
      })),
      risks: strings(result.risks, 16, 600),
      additionalCases: strings(result.additionalCases, 16, 600),
      recommendation: text(result.recommendation, 1000),
    },
    failure: text(review.failure, 500),
  };
}
