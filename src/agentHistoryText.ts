/**
 * How Agent carries an earlier thread message to the model, so the Meta
 * disclosure card can preview exactly that instead of the stored turn.
 *
 * Agent sends earlier user messages and the prose of earlier replies (the
 * host-record section is sent separately, as shown on the card), each
 * shortened to {@link AGENT_HISTORY_TEXT_LIMIT} characters with a visible
 * marker. Plan entries are not part of Agent history. Answers stay bound to
 * the stored turn: the preview can only show less than was approved.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 */

import { assistantHistoryText } from './hostRecord.js';

/** Earlier thread messages longer than this are shortened with a visible marker. */
export const AGENT_HISTORY_TEXT_LIMIT = 4000;

/** Shorten earlier thread text with a marker instead of cutting it silently. */
export function historyText(text: string): string {
  if (text.length <= AGENT_HISTORY_TEXT_LIMIT) {
    return text;
  }
  return (
    `${text.slice(0, AGENT_HISTORY_TEXT_LIMIT)}\n` +
    `…[RAME Code shortened this earlier message: ${text.length - AGENT_HISTORY_TEXT_LIMIT} characters left out]`
  );
}

/** The text an Agent request carries for one offered message; null when Agent does not send it. */
export function agentSentText(role: 'user' | 'assistant' | 'plan', text: string): string | null {
  if (role === 'user') {
    return historyText(text);
  }
  if (role === 'assistant') {
    const prose = assistantHistoryText(text);
    return prose.length > 0 ? historyText(prose) : null;
  }
  return null;
}
