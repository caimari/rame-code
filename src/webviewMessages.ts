/**
 * Validation for messages travelling between the RAME Code webview and the
 * extension host. This module is intentionally free of the `vscode` API so it
 * can be unit tested with plain `node:test`.
 *
 * Security rules enforced here:
 * - Only the five known inbound message shapes are accepted.
 * - Every inbound message must contain exactly its allowlisted own
 *   enumerable keys: no missing and no additional fields.
 * - Validation errors never echo received values (in particular, never the
 *   API key).
 */

/** Save the API key. Sent only when the user clicks "Save key". */
export interface SaveKeyMessage {
  type: 'saveKey';
  /** Raw key text as typed; the host trims and validates it. */
  apiKey: string;
}

/** Delete the stored API key. */
export interface ClearKeyMessage {
  type: 'clearKey';
}

/** Start a mission with the given goal text. */
export interface StartMissionMessage {
  type: 'startMission';
  goal: string;
}

/** Cancel the currently running mission, if any. */
export interface CancelMissionMessage {
  type: 'cancelMission';
}

/** Webview signals it is loaded and ready for state. */
export interface ReadyMessage {
  type: 'ready';
}

export type InboundMessage =
  | SaveKeyMessage
  | ClearKeyMessage
  | StartMissionMessage
  | CancelMissionMessage
  | ReadyMessage;

export const MAX_API_KEY_LENGTH = 4096;
export const MAX_GOAL_LENGTH = 8000;
export const MIN_GOAL_LENGTH = 10;

/**
 * Parse an untrusted `postMessage` payload into a known inbound message.
 * Throws a generic `Error` whose text never contains received values.
 */
function hasExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(record);
  if (keys.length !== allowed.length) {
    return false;
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return false;
    }
  }
  return true;
}

export function parseInboundMessage(raw: unknown): InboundMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid panel message.');
  }
  const record = raw as Record<string, unknown>;
  switch (record.type) {
    case 'saveKey':
      if (
        !hasExactKeys(record, ['type', 'apiKey']) ||
        typeof record.apiKey !== 'string'
      ) {
        throw new Error('Invalid saveKey message.');
      }
      return { type: 'saveKey', apiKey: record.apiKey };
    case 'clearKey':
      if (!hasExactKeys(record, ['type'])) {
        throw new Error('Invalid clearKey message.');
      }
      return { type: 'clearKey' };
    case 'startMission':
      if (
        !hasExactKeys(record, ['type', 'goal']) ||
        typeof record.goal !== 'string'
      ) {
        throw new Error('Invalid startMission message.');
      }
      return { type: 'startMission', goal: record.goal };
    case 'cancelMission':
      if (!hasExactKeys(record, ['type'])) {
        throw new Error('Invalid cancelMission message.');
      }
      return { type: 'cancelMission' };
    case 'ready':
      if (!hasExactKeys(record, ['type'])) {
        throw new Error('Invalid ready message.');
      }
      return { type: 'ready' };
    default:
      throw new Error('Unknown panel message.');
  }
}

export interface ApiKeyValidation {
  ok: boolean;
  /** Trimmed key, present only when `ok` is true. */
  apiKey?: string;
  error?: string;
}

/** Validate raw API-key input without ever echoing it back. */
export function validateApiKeyInput(value: unknown): ApiKeyValidation {
  if (typeof value !== 'string') {
    return { ok: false, error: 'An API key is required.' };
  }
  const apiKey = value.trim();
  if (apiKey.length === 0) {
    return { ok: false, error: 'An API key is required.' };
  }
  if (apiKey.length > MAX_API_KEY_LENGTH) {
    return { ok: false, error: 'The API key is too long.' };
  }
  return { ok: true, apiKey };
}

export interface GoalValidation {
  ok: boolean;
  /** Trimmed goal, present only when `ok` is true. */
  goal?: string;
  error?: string;
}

/** Validate raw mission-goal input. Only the trimmed goal is sent to the API. */
export function validateGoalInput(value: unknown): GoalValidation {
  if (typeof value !== 'string') {
    return { ok: false, error: 'A mission goal is required.' };
  }
  const goal = value.trim();
  if (goal.length < MIN_GOAL_LENGTH) {
    return {
      ok: false,
      error: `Describe the goal in at least ${MIN_GOAL_LENGTH} characters.`,
    };
  }
  if (goal.length > MAX_GOAL_LENGTH) {
    return { ok: false, error: 'The mission goal is too long.' };
  }
  return { ok: true, goal };
}

/**
 * Remove every occurrence of `apiKey` from `text` so error detail can be
 * shown or forwarded without disclosing the key. Returns `text` unchanged
 * when `apiKey` is empty.
 */
export function redactKeyFromText(text: string, apiKey: string): string {
  if (apiKey.length === 0) {
    return text;
  }
  return text.split(apiKey).join('[redacted]');
}
