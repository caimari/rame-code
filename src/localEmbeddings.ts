/**
 * Reserved optional semantic-retrieval client for a future release.
 *
 * v0.2.0 does not import this module from Agent, Chat or Mission. It starts
 * no process, downloads no model and adds no dependency. Keeping the client
 * isolated preserves the already-tested architecture for a future explicit
 * opt-in setting without changing today's lexical path.
 */

import { isAbortError, withBoundedRequest } from './boundedRequest.js';
import { isLoopbackUrl } from './localRuntime.js';

export const MAX_SEMANTIC_CANDIDATES = 128;
export const MAX_SEMANTIC_INPUT_CHARS = 96_000;
export const MAX_EMBEDDING_DIMENSIONS = 8_192;
export const MAX_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface SemanticCandidate { id: number; text: string }
export type SemanticRetrievalStatus = 'used' | 'unavailable' | 'failed' | 'withheld-cloud-boundary' | 'not-needed';
export interface SemanticRetrievalResult {
  status: SemanticRetrievalStatus;
  scores: Map<number, number>;
  candidates: number;
  latencyMs: number;
  detail: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const unsupported = new Set<string>();

function empty(status: SemanticRetrievalStatus, detail: string, candidates = 0, latencyMs = 0): SemanticRetrievalResult {
  return { status, scores: new Map(), candidates, latencyMs, detail };
}

function vector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EMBEDDING_DIMENSIONS) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    out.push(item);
  }
  return out;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0; let l2 = 0; let r2 = 0;
  for (let index = 0; index < left.length; index++) {
    const l = left[index] as number; const r = right[index] as number;
    dot += l * r; l2 += l * l; r2 += r * r;
  }
  return l2 > 0 && r2 > 0 ? dot / Math.sqrt(l2 * r2) : -1;
}

function bounded(candidates: readonly SemanticCandidate[]): SemanticCandidate[] {
  const out: SemanticCandidate[] = []; let chars = 0;
  for (const candidate of candidates.slice(-MAX_SEMANTIC_CANDIDATES)) {
    const text = candidate.text.replace(/\s+/g, ' ').trim().slice(0, 1_200);
    if (!text || chars + text.length > MAX_SEMANTIC_INPUT_CHARS) continue;
    out.push({ id: candidate.id, text }); chars += text.length;
  }
  return out;
}

/** Explicit callers may use this only with an already-running loopback endpoint. */
export async function retrieveLocalSemanticScores(options: {
  endpoint: string; model: string; query: string; candidates: readonly SemanticCandidate[];
  fetchImpl?: FetchLike; signal?: AbortSignal; timeoutMs?: number;
}): Promise<SemanticRetrievalResult> {
  const candidates = bounded(options.candidates);
  if (candidates.length === 0) return empty('not-needed', 'no old candidate excerpts');
  if (!isLoopbackUrl(options.endpoint)) return empty('unavailable', 'embedding endpoint is not loopback', candidates.length);
  const model = options.model.trim();
  if (!model) return empty('unavailable', 'no local embedding model id', candidates.length);
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const key = `${endpoint}\n${model}`;
  if (unsupported.has(key)) return empty('unavailable', 'endpoint previously reported embeddings unavailable', candidates.length);
  const started = Date.now();
  try {
    const { response, raw } = await withBoundedRequest(options.signal, options.timeoutMs ?? 5_000, 'Local semantic retrieval timed out.', async (signal) => {
      const response = await (options.fetchImpl ?? fetch)(`${endpoint}/v1/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ model, input: [options.query.slice(0, 2_000), ...candidates.map((entry) => entry.text)], encoding_format: 'float' }),
      });
      const raw = await response.text();
      if (raw.length > MAX_EMBEDDING_RESPONSE_BYTES) throw new Error('Local embedding response exceeded the size limit.');
      return { response, raw };
    });
    if (!response.ok) {
      if ([400, 404, 405, 501].includes(response.status)) unsupported.add(key);
      return empty(response.status === 400 || response.status === 404 || response.status === 405 || response.status === 501 ? 'unavailable' : 'failed', `local embedding endpoint returned HTTP ${response.status}`, candidates.length, Date.now() - started);
    }
    const payload = JSON.parse(raw) as { data?: Array<{ embedding?: unknown }> };
    if (!Array.isArray(payload.data) || payload.data.length !== candidates.length + 1) return empty('failed', 'wrong vector count', candidates.length, Date.now() - started);
    const vectors = payload.data.map((entry) => vector(entry.embedding));
    const query = vectors[0];
    if (query === null || vectors.some((entry) => entry === null || entry.length !== query.length)) return empty('failed', 'malformed vectors', candidates.length, Date.now() - started);
    const scores = new Map<number, number>();
    candidates.forEach((entry, index) => scores.set(entry.id, cosine(query, vectors[index + 1] as number[])));
    return { status: 'used', scores, candidates: candidates.length, latencyMs: Date.now() - started, detail: 'optional local embeddings' };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return empty('failed', error instanceof Error ? error.message.slice(0, 180) : 'semantic retrieval failed', candidates.length, Date.now() - started);
  }
}

export function clearEmbeddingCapabilityCache(): void { unsupported.clear(); }
