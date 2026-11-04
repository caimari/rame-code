/**
 * Who receives a Meta request, and under which conditions: the two facts a
 * disclosure answer is bound to besides the content itself.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * - Processing class: Meta's documented standard models share one class;
 *   its documented Contributor variants (Meta may use what they receive)
 *   share another. Any other model id is its own class, so nothing approved
 *   for one model is reused for an undocumented one.
 * - Credential revision: an opaque random id that changes whenever the Meta
 *   API key is saved or cleared. It is never derived from the key, so it
 *   reveals nothing about it; answers given under another revision (another
 *   account or key) never apply.
 */

import { randomBytes } from 'node:crypto';

export const META_CREDENTIAL_KEY = 'rameCode.metaCredentialRevision.v1';

/** Documented standard models: equivalent recipient and processing conditions. */
const STANDARD_MODELS: readonly string[] = ['muse-spark-1.1', 'muse-spark-1.2', 'muse-spark-1.3', 'muse-wonder-1.0'];
/** Documented Contributor variants: Meta may use the data they receive. */
const CONTRIBUTOR_MODELS: readonly string[] = ['muse-spark-1.2-contributor', 'muse-spark-1.3-contributor'];

export type ProcessingClass = string;

/** The class an answer for `model` is bound to: `standard`, `contributor`, or `model:<id>`. */
export function processingClass(model: string): ProcessingClass {
  const id = model.trim();
  if (STANDARD_MODELS.includes(id)) {
    return 'standard';
  }
  if (CONTRIBUTOR_MODELS.includes(id)) {
    return 'contributor';
  }
  return `model:${id.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 96)}`;
}

/** True when Meta's terms let it use what this class receives (shown on the card). */
export function isContributorClass(processing: ProcessingClass): boolean {
  return processing === 'contributor' || /contrib/i.test(processing);
}

const REVISION = /^[0-9a-f]{32}$/;

/** The stored revision, or a new one (persisted) when there is none or it is unreadable. */
export function loadCredentialRevision(state: { get(key: string): unknown; update(key: string, value: unknown): unknown }): string {
  const stored = state.get(META_CREDENTIAL_KEY);
  if (typeof stored === 'string' && REVISION.test(stored)) {
    return stored;
  }
  return rotateCredentialRevision(state);
}

/** A new revision, persisted: every answer bound to the previous one stops applying. */
export function rotateCredentialRevision(state: { update(key: string, value: unknown): unknown }): string {
  const next = randomBytes(16).toString('hex');
  void state.update(META_CREDENTIAL_KEY, next);
  return next;
}
