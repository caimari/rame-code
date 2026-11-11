/**
 * What an advisor consultation carries beyond the host's notes, and how the
 * advisor model itself is asked (P5h, the user's decisions of 08-11-2026).
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * 1. The end of the failing check's output, so the advisor can see what
 *    failed. It is cut to its last lines, secrets are removed and the user's
 *    folders hidden; when anything that looks like a secret or a private path
 *    remains, or would have to be removed, nothing of it is sent. It goes on
 *    the consultation card as part of the exact text the user approves, and
 *    without a card only under a Meta pre-authorization whose data scope
 *    includes fragments (never with "instructions only").
 * 2. The advisor's own generation settings: its documented profile and the
 *    reasoning level stored for that model, never the main model's, with its
 *    own output cap.
 */

import { redactSecrets, scrubLocalPaths } from './cloudEgress.js';
import { automaticOutputTokens, cloudGenerationProfile, resolveReasoning } from './generationSettings.js';
import type { GenerationSettings } from './generationSettings.js';
import type { RunGeneration } from './providerTypes.js';

/** At most this much of the failing check's output, from its end. */
export const MAX_EXCERPT_LINES = 30;
export const MAX_EXCERPT_CHARS = 1500;
/** The advisor answers in text: this caps every consultation's output, whatever the main model's settings. */
export const ADVISOR_MAX_OUTPUT_TOKENS = 2048;

/** Private paths that must never leave once the known folders are hidden. */
const PRIVATE_PATH = /(?:\/home\/[^/\s<>]+|\/Users\/[^/\s<>]+|\/root(?=[/\s]|$)|[A-Za-z]:\\Users\\[^\\\s<>]+)/;

export type Excerpt = { ok: true; text: string } | { ok: false; reason: string };

/**
 * The end of a failing check's output, safe to show the advisor, or why
 * nothing of it is sent. `folders` are hidden first (the project as
 * `<project folder>`, the home folder as `~`).
 */
export function safeCheckExcerpt(output: string, folders: Array<[string, string]>, apiKey = ''): Excerpt {
  const tail = output.split(/\r?\n/).slice(-MAX_EXCERPT_LINES).join('\n').slice(-MAX_EXCERPT_CHARS).trim();
  if (tail.length === 0) {
    return { ok: false, reason: 'the check printed nothing' };
  }
  if (apiKey.length > 0 && tail.includes(apiKey)) {
    return { ok: false, reason: 'it contained the API key' };
  }
  const secrets = redactSecrets(tail);
  if (secrets.found.length > 0) {
    // Removing a secret would change what failed: when one is there, nothing of the output goes.
    return { ok: false, reason: 'it looked like it contained a secret' };
  }
  const scrubbed = scrubLocalPaths(tail, folders);
  if (PRIVATE_PATH.test(scrubbed)) {
    return { ok: false, reason: 'it named a private folder that could not be hidden' };
  }
  return { ok: true, text: scrubbed };
}

/**
 * How the advisor model is asked: its own documented profile and the
 * reasoning level stored for it (Settings, per model), the manual output
 * maximum of Meta requests if lower, and never more than the advisor's cap.
 */
export function advisorGeneration(settings: GenerationSettings, model: string): RunGeneration {
  const profile = cloudGenerationProfile(model);
  const reasoning = resolveReasoning(settings, 'cloud', model, profile);
  const manual = settings.maxOutputTokens.cloud;
  return {
    provider: 'cloud',
    model,
    profile: { ...profile, autoOutputTokens: Math.min(ADVISOR_MAX_OUTPUT_TOKENS, automaticOutputTokens('cloud', reasoning.unavailable ? 'default' : reasoning.stored)) },
    reasoning: reasoning.level,
    manualMax: manual === null ? ADVISOR_MAX_OUTPUT_TOKENS : Math.min(manual, ADVISOR_MAX_OUTPUT_TOKENS),
    notes: reasoning.unavailable ? [`The reasoning level stored for ${model} is not available for it; the consultation uses its default.`] : [],
  };
}
