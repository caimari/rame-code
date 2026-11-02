/**
 * Host record: the list of actions RAME Code itself verified during an
 * Agent run, kept apart from the model's prose.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * The record is stored as a structured field on the assistant turn and the
 * webview renders it in its own block, so model text can never pose as it.
 * Model text that imitates the host's labels (an `Agent (…):` prefix, a
 * "Host record" section copied from earlier turns) is removed from the
 * stored reply and from the history sent back to the model.
 */

export const HOST_RECORD_HEADING = 'Host record (verified by RAME Code, not written by the model):';
export const MAX_HOST_RECORD_LINES = 24;
export const MAX_HOST_RECORD_LINE_LENGTH = 240;
export const NO_HOST_ACTIONS_LINE = '• No tool actions ran.';
export const REMOVED_COPIED_RECORD_NOTE =
  '[RAME Code removed a section the model labelled as a host record. Only the record below comes from the host.]';
export const EMPTY_AFTER_SANITIZE_NOTE = '(The model reply contained only copied host labels.)';

/** Leading `Agent (profile, provider):` labels, possibly repeated. */
const AGENT_PREFIX = /^(?:\s*Agent \([^)\n]{1,60}\):[ \t]*)+/;

/** Zero-width and bidi controls that could hide a look-alike heading. */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤﻿]/g;

function headingKey(line: string): string {
  return line.normalize('NFKC').replace(INVISIBLE, '').toLowerCase();
}

/** True for a line that starts like a host-record heading. */
function isHostRecordHeading(line: string): boolean {
  return /^[\s>*_#•\-–—:|]*host[\s_-]*record\b/.test(headingKey(line));
}

/**
 * Clean one model reply for storage: drop echoed `Agent (…):` labels and
 * cut everything from the first line that presents itself as a host
 * record. A visible note says when something was cut.
 */
export function sanitizeAgentReply(reply: string): { text: string; removedHostRecord: boolean } {
  const withoutPrefix = reply.replace(AGENT_PREFIX, '');
  const lines = withoutPrefix.split('\n');
  const cut = lines.findIndex(isHostRecordHeading);
  let text = (cut === -1 ? lines : lines.slice(0, cut)).join('\n').trim();
  const removedHostRecord = cut !== -1;
  if (removedHostRecord) {
    text = text.length > 0 ? `${text}\n\n${REMOVED_COPIED_RECORD_NOTE}` : REMOVED_COPIED_RECORD_NOTE;
  }
  if (text.length === 0) {
    text = EMPTY_AFTER_SANITIZE_NOTE;
  }
  return { text, removedHostRecord };
}

/**
 * Text of an earlier assistant turn as sent back to the model: only its
 * prose. Labels and host-record sections (including the in-text form older
 * builds stored) are stripped so the model has nothing to imitate.
 */
export function assistantHistoryText(text: string): string {
  const withoutPrefix = text.replace(AGENT_PREFIX, '');
  const lines = withoutPrefix.split('\n');
  const cut = lines.findIndex(isHostRecordHeading);
  return (cut === -1 ? lines : lines.slice(0, cut))
    .filter((line) => line.trim() !== REMOVED_COPIED_RECORD_NOTE)
    .join('\n')
    .trim();
}

/** Validate a stored host record: bounded, non-empty single-line strings. */
export function isValidHostRecord(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_HOST_RECORD_LINES &&
    value.every(
      (line) =>
        typeof line === 'string' &&
        line.trim().length > 0 &&
        line.length <= MAX_HOST_RECORD_LINE_LENGTH &&
        !line.includes('\n'),
    )
  );
}
