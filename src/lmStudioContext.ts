/**
 * The context LM Studio has the requested model loaded with, read before an
 * Agent or Chat request so RAME can refuse a request that does not fit
 * instead of sending it.
 *
 * Why it matters (seen 2026-11-11 in LM Studio's own server log): when a
 * request is larger than the loaded context, LM Studio first answers the
 * refusal internally, then retries by itself with the conversation cut to
 * fit (10,198 tokens → 3,865) and streams the model's answer to the cut
 * conversation as if nothing happened. The Agent then acted on a request it
 * only saw in part. With the loaded context known, RAME's own check refuses
 * first: nothing is cut and nothing is sent.
 *
 * Metadata only: GET /api/v1/models (LM Studio 0.4.0 or newer). Free of the
 * vscode API.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * From a GET /api/v1/models reply: the context of the loaded instance named
 * `model`; when `model` is a key, the smallest context among its loaded
 * instances (LM Studio may answer with any of them). Null when the model is
 * not listed, not loaded, or the reply says nothing about its context.
 */
export function lmStudioLoadedContext(payload: unknown, model: string): number | null {
  const wanted = model.trim();
  if (wanted.length === 0 || !isRecord(payload) || !Array.isArray(payload.models)) {
    return null;
  }
  for (const item of payload.models.filter(isRecord)) {
    const instances = (Array.isArray(item.loaded_instances) ? item.loaded_instances.filter(isRecord) : []).map((instance) => ({
      id: typeof instance.id === 'string' ? instance.id : null,
      context: positive(isRecord(instance.config) ? instance.config.context_length : null),
    }));
    const named = instances.find((instance) => instance.id === wanted);
    if (named !== undefined) {
      return named.context;
    }
    if (item.key === wanted) {
      const contexts = instances.map((instance) => instance.context).filter((context): context is number => context !== null);
      return contexts.length > 0 ? Math.min(...contexts) : null;
    }
  }
  return null;
}
