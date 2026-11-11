/**
 * When a failed local request gets the "Reload in LM Studio with more
 * context" button, and with which context (lmStudioReload.ts runs it).
 * Free of the vscode API: the send-error path imports it.
 */

import { GenerationContextError } from './generationSettings.js';
import { LocalContextTooSmallError } from './localServerErrors.js';
import type { ProviderHost } from './providerTypes.js';

/** The context offered by default: what RAME's Agent runs comfortably with. */
export const RELOAD_CONTEXT_TOKENS = 32_768;
const STEP = 8_192;

/** The context to offer: 32,768, or more when the refused request needs it (with room for the reply), in 8,192 steps. */
export function reloadTarget(needed: number | null): number {
  if (needed === null) {
    return RELOAD_CONTEXT_TOKENS;
  }
  return Math.max(RELOAD_CONTEXT_TOKENS, Math.ceil((needed * 1.5) / STEP) * STEP);
}

/**
 * After a context refusal from a server chosen as LM Studio: the context to
 * offer a reload with, or null when the button does not apply.
 */
export function lmStudioReloadOffer(host: ProviderHost, error: unknown): number | null {
  if (!(error instanceof GenerationContextError)) {
    return null;
  }
  const external = host.settings.externalLocalEndpoint.trim();
  if (host.settings.externalLocal.kind !== 'lmstudio' || external.length === 0 || host.localEndpoint() !== external) {
    return null;
  }
  return reloadTarget(error instanceof LocalContextTooSmallError ? error.needed : error.neededTokens);
}
