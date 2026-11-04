/**
 * Reserved bridge for optional semantic continuity in a future release.
 * No v0.2.0 runtime module imports it.
 */
import { continuitySemanticCandidates, type ContinuityOptions } from './contextContinuity.js';
import { retrieveLocalSemanticScores, type SemanticRetrievalResult } from './localEmbeddings.js';
import type { ChatThread, ModelOrigin } from './threadStore.js';

export async function prepareSemanticContinuity(options: {
  thread: ChatThread | undefined; query: string; current: ModelOrigin;
  recentTurns: number; endpoint: string | null; signal?: AbortSignal;
}): Promise<{ retrieval: SemanticRetrievalResult; continuity: ContinuityOptions }> {
  if (options.current.provider !== 'local' || options.endpoint === null) {
    const status = options.current.provider === 'cloud' ? 'withheld-cloud-boundary' : 'unavailable';
    return { retrieval: { status, scores: new Map(), candidates: 0, latencyMs: 0, detail: 'not enabled' }, continuity: { recentTurns: options.recentTurns, semanticStatus: status } };
  }
  const retrieval = await retrieveLocalSemanticScores({
    endpoint: options.endpoint, model: options.current.model, query: options.query,
    candidates: continuitySemanticCandidates(options.thread, options.recentTurns), signal: options.signal,
  });
  return { retrieval, continuity: { recentTurns: options.recentTurns, semanticScores: retrieval.scores, semanticStatus: retrieval.status, semanticCandidates: retrieval.candidates, semanticLatencyMs: retrieval.latencyMs } };
}
