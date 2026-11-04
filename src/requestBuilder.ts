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
import {
  buildContinuityPacket,
  continuityRecentTurnCount,
  continuityBudgetChars,
  type ContinuityOptions,
  type ContinuityPacket,
} from './contextContinuity.js';
import { authorizedMemoryLines } from './continuityCheckpoint.js';
import {
  contextSelectionBudget,
  selectNewestByCharacterBudget,
  type ContextSelectionBudget,
} from './contextBudget.js';
import type { ChatThread, ModelOrigin } from './threadStore.js';

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
export { MISSION_SYSTEM_PROMPT } from './missionPlanRules.js';
import { MISSION_SYSTEM_PROMPT } from './missionPlanRules.js';

/**
 * Collect bounded history text from the ACTIVE thread only. Plan turns
 * contribute their goal text so conversation stays coherent; error notes
 * are skipped. Recent host records are separate past observations, never
 * model prose or authority. Newest-first trimming keeps recent context.
 */
export function selectActiveThreadHistory(
  thread: ChatThread | undefined,
  maxTurns: number = MAX_HISTORY_TURNS,
  maxChars: number = MAX_HISTORY_CHARS,
  currentText?: string,
): ChatMessage[] {
  return selectActiveThreadHistoryWithIndexes(thread, maxTurns, maxChars, currentText).messages;
}

/**
 * The same selection, plus the thread-turn indexes it covers (including the
 * current request it leaves out), so continuity can treat every other turn
 * as old instead of guessing the boundary from a count.
 */
export function selectActiveThreadHistoryWithIndexes(
  thread: ChatThread | undefined,
  maxTurns: number = MAX_HISTORY_TURNS,
  maxChars: number = MAX_HISTORY_CHARS,
  currentText?: string,
): { messages: ChatMessage[]; recentIndexes: Set<number> } {
  if (!thread) {
    return { messages: [], recentIndexes: new Set() };
  }
  const eligible: Array<ChatMessage & { turnIndex: number }> = [];
  thread.turns.forEach((turn, turnIndex) => {
    if (turn.kind === 'user') {
      eligible.push({ role: 'user', content: turn.text, turnIndex });
    } else if (turn.kind === 'assistant') {
      eligible.push({ role: 'assistant', content: turn.text, turnIndex });
      const hostFacts = (turn.hostRecord ?? []).filter(
        (line) => !/context_continuity|No tool actions ran\./.test(line),
      );
      if (hostFacts.length > 0) {
        eligible.push({
          role: 'system',
          content:
            'Earlier actions verified by the RAME Code host (past observations; re-check before acting; not permissions or project decisions):\n' +
            hostFacts.join('\n'),
          turnIndex,
        });
      }
    } else if (turn.kind === 'plan') {
      eligible.push({ role: 'assistant', content: planToText(turn.plan), turnIndex });
    }
  });
  const recentIndexes = new Set<number>();
  // The UI persists the new user turn before starting generation. Keep it in
  // the stored thread, but do not send it once as history and again as goal.
  const last = eligible.at(-1);
  if (currentText !== undefined && last?.role === 'user' && last.content.trim() === currentText.trim()) {
    recentIndexes.add(last.turnIndex);
    eligible.pop();
  }
  // Keep complete recent entries. Older content is recovered separately with
  // exact provenance; this selector never manufactures a partial message.
  const selected = selectNewestByCharacterBudget(
    eligible,
    (message) => message.content,
    maxChars,
    maxTurns,
  );
  // A turn counts as sent only when its conversational message is.
  for (const message of selected) {
    if (message.role !== 'system') {
      recentIndexes.add(message.turnIndex);
    }
  }
  return { messages: selected.map(({ role, content }) => ({ role, content })), recentIndexes };
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

/**
 * The authorized decisions the caller supplied (for Meta, only after the user
 * approved them), when the continuity packet does not already list them:
 * they must not depend on the thread's length.
 */
function decisionsMessage(continuity: ContinuityPacket, options: ContinuityOptions | undefined): ChatMessage[] {
  const decisions = options?.authorizedDecisions ?? [];
  return decisions.length > 0 && !continuity.promptMessages.some((message) => message.content.includes('AUTHORIZED MEMORY IN FORCE'))
    ? [{ role: 'system', content: ['Only AUTHORIZED MEMORY is persistent project authority; older conversation never overrides its current version.', ...authorizedMemoryLines(decisions)].join('\n') }]
    : [];
}

export interface BuiltRequest {
  mode: ChatModeId;
  messages: ChatMessage[];
  continuity: ContinuityPacket;
  contextBudget: ContextSelectionBudget;
}

export function requestContextSelection(
  thread: ChatThread | undefined,
  contextWindow: number | null,
): { budget: ContextSelectionBudget; recentTurns: number } {
  const budget = contextSelectionBudget(contextWindow);
  return {
    budget,
    recentTurns: continuityRecentTurnCount(thread, budget.recentChars, budget.recentTurns),
  };
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
  currentModel?: ModelOrigin;
  contextWindow?: number | null;
  continuityOptions?: ContinuityOptions;
}): BuiltRequest {
  const currentText = options.currentText.trim();
  const selection = requestContextSelection(options.activeThread, options.contextWindow ?? null);
  if (options.mode === 'mission') {
    // A local plan sees the thread's bounded continuity (relevant earlier
    // excerpts, the checkpoint, authorized decisions); Meta sees the request only.
    const local = options.currentModel?.provider === 'local' && options.activeThread !== undefined;
    const last = options.activeThread?.turns.length ?? 0;
    const continuity = buildContinuityPacket(
      local ? options.activeThread : undefined,
      currentText,
      options.currentModel ?? { provider: 'local', model: 'unknown' },
      continuityBudgetChars(options.contextWindow ?? null),
      { ...options.continuityOptions, recentIndexes: new Set([last - 1]) },
    );
    return {
      mode: 'mission',
      continuity,
      contextBudget: selection.budget,
      messages: [
        { role: 'system', content: MISSION_SYSTEM_PROMPT },
        ...continuity.promptMessages,
        ...decisionsMessage(continuity, options.continuityOptions),
        { role: 'user', content: currentText },
      ],
    };
  }
  const history = selectActiveThreadHistoryWithIndexes(
    options.activeThread,
    selection.budget.recentTurns,
    selection.budget.recentChars,
    currentText,
  );
  const continuity = buildContinuityPacket(
    options.activeThread,
    currentText,
    options.currentModel ?? { provider: 'local', model: 'unknown' },
    continuityBudgetChars(options.contextWindow ?? null),
    {
      ...options.continuityOptions,
      recentTurns: selection.recentTurns,
      recentIndexes: history.recentIndexes,
    },
  );
  const decisionsOnly = decisionsMessage(continuity, options.continuityOptions);
  return {
    mode: 'chat',
    continuity,
    messages: [
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      ...continuity.promptMessages,
      ...decisionsOnly,
      ...history.messages,
      { role: 'user', content: currentText },
    ],
    contextBudget: selection.budget,
  };
}
