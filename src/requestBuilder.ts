/**
 * Chat vs Mission request construction for the single RAME Code view.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Scope contract (shown in the UI and enforced here):
 * - Chat mode sends a normal conversational history built ONLY from the
 *   active thread's bounded validated turns plus the new message.
 * - Mission mode sends ONLY the newly submitted text (independent call).
 * - Other threads are never included in either mode.
 */

import type { ChatModeId } from './modes.js';
import type { ChatThread } from './threadStore.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Maximum history turns (user/assistant text) included for Chat mode. */
export const MAX_HISTORY_TURNS = 20;
/** Maximum total history characters included for Chat mode. */
export const MAX_HISTORY_CHARS = 12000;

export const CHAT_SYSTEM_PROMPT =
  'You are RAME Code, a conversational coding assistant inside VS Code. Answer concisely. You cannot read files or run commands yet; say so when asked to act on the workspace.';
export const MISSION_SYSTEM_PROMPT =
  'Create a bounded software mission plan. Do not claim to have inspected files or run tools. Return only the requested structured output.';

/**
 * Collect bounded history text from the ACTIVE thread only. Plan turns
 * contribute their goal text so conversation stays coherent; error notes
 * are skipped. Newest-first trimming keeps the most recent context.
 */
export function selectActiveThreadHistory(
  thread: ChatThread | undefined,
  maxTurns: number = MAX_HISTORY_TURNS,
  maxChars: number = MAX_HISTORY_CHARS,
): ChatMessage[] {
  if (!thread) {
    return [];
  }
  const eligible: ChatMessage[] = [];
  for (const turn of thread.turns) {
    if (turn.kind === 'user') {
      eligible.push({ role: 'user', content: turn.text });
    } else if (turn.kind === 'assistant') {
      eligible.push({ role: 'assistant', content: turn.text });
    } else if (turn.kind === 'plan') {
      eligible.push({ role: 'assistant', content: planToText(turn.plan) });
    }
  }
  const recent = eligible.slice(-1 * Math.max(1, maxTurns));
  // Trim oldest entries until the character budget holds.
  let chars = recent.reduce((sum, message) => sum + message.content.length, 0);
  while (recent.length > 1 && chars > maxChars) {
    const removed = recent.shift();
    chars -= removed ? removed.content.length : 0;
  }
  // Hard-truncate any single over-long message tail-first (keep the end).
  return recent.map((message) =>
    message.content.length > maxChars
      ? { ...message, content: message.content.slice(-maxChars) }
      : message,
  );
}

function planToText(plan: {
  goal: string;
  steps: Array<{ title: string }>;
}): string {
  const steps = plan.steps
    .map((step, index) => `${index + 1}. ${step.title}`)
    .join('\n');
  return `Mission plan for: ${plan.goal}\n${steps}`;
}

export interface BuiltRequest {
  mode: ChatModeId;
  messages: ChatMessage[];
}

/**
 * Build the message list for one send. Mission mode ignores thread history
 * entirely; Chat mode prepends the bounded active-thread history. Agent
 * mode never uses this helper (the Agent loop builds its own tool-aware
 * messages); it is mapped to Chat history here only so the type stays
 * total without changing Chat/Mission behavior.
 */
export function buildRequestMessages(options: {
  mode: ChatModeId;
  activeThread: ChatThread | undefined;
  currentText: string;
}): BuiltRequest {
  const currentText = options.currentText.trim();
  if (options.mode === 'mission') {
    return {
      mode: 'mission',
      messages: [
        { role: 'system', content: MISSION_SYSTEM_PROMPT },
        { role: 'user', content: currentText },
      ],
    };
  }
  return {
    mode: 'chat',
    messages: [
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      ...selectActiveThreadHistory(options.activeThread),
      { role: 'user', content: currentText },
    ],
  };
}
