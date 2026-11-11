/**
 * The scope a Meta request runs under: the processing class of the selected
 * Meta model and the API key's revision. Kept apart from
 * cloudDisclosureHost.ts so the egress guard can read it without importing
 * the disclosure host (and, through it, Autonomy & Permissions).
 */

import type { DisclosureScope } from './cloudDisclosure.js';
import { processingClass } from './metaRecipient.js';
import type { ProviderHost } from './providerTypes.js';

/** The scope a Meta request is under now: the selected model's processing class and the API key's revision. */
export function currentScope(host: ProviderHost): DisclosureScope {
  return { processing: processingClass(host.selectedCloudModel()), credential: host.metaCredential };
}

/** The scope of the Meta request running for this thread (fixed at its card), else the current one. */
export function runScope(host: ProviderHost, threadId: string): DisclosureScope {
  const run = host.cloudRun;
  return run !== null && run.threadId === threadId ? { processing: run.processing, credential: run.credential } : currentScope(host);
}
