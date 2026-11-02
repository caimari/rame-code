/**
 * Bounded model HTTP requests shared by Chat, Mission, and Agent calls.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * The deadline and the caller's cancellation cover the whole exchange:
 * connecting, waiting for headers, and reading the body. A provider that
 * accepts the connection but never finishes the response can therefore
 * never leave a run stuck in Working.
 */

export const MODEL_REQUEST_TIMEOUT_MS = 120_000;

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

export interface BoundedRequest {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

/**
 * Derive a request signal that aborts on parent cancellation or after
 * `timeoutMs`. The caller's cancellation remains distinct from a provider
 * timeout so the UI can report the right outcome. Keep it alive until the
 * body has been read, then `dispose()` it.
 */
export function boundedRequestSignal(parent?: AbortSignal, timeoutMs = MODEL_REQUEST_TIMEOUT_MS): BoundedRequest {
  const controller = new AbortController();
  let didTimeOut = false;
  const onParentAbort = (): void => controller.abort();
  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * Run `work` (fetch plus body read) under one bounded signal. A timeout
 * becomes `timeoutMessage`; caller cancellation surfaces as an AbortError
 * even when it interrupts the body read.
 */
export async function withBoundedRequest<T>(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
  timeoutMessage: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const request = boundedRequestSignal(parent, timeoutMs);
  try {
    return await work(request.signal);
  } catch (error) {
    if (request.timedOut()) {
      throw new Error(timeoutMessage);
    }
    if (parent?.aborted) {
      throw isAbortError(error) ? error : new DOMException('Aborted', 'AbortError');
    }
    throw error;
  } finally {
    request.dispose();
  }
}
