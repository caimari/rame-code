/**
 * Conservative context allocation shared by Chat and Agent.
 *
 * The provider still makes the final token measurement. These character
 * budgets only decide which persisted recent turns are worth proposing to
 * that measurement; they never truncate the current user request, governed
 * memory, or current-run tool exchanges.
 */

export const UNKNOWN_CONTEXT_RECENT_CHARS = 12_000;
export const MIN_RECENT_CONTEXT_CHARS = 12_000;
export const MAX_RECENT_CONTEXT_CHARS = 120_000;
export const MAX_RECENT_CONTEXT_TURNS = 120;

export interface ContextSelectionBudget {
  contextWindow: number | null;
  recentChars: number;
  recentTurns: number;
  source: 'conservative-default' | 'model-context';
}

/**
 * Reserve at least 20% of a known window for the reply, tool schemas and the
 * current run, then use only 55% of the remainder for stored recent history.
 * The request budgeter later rejects a request that still does not fit.
 */
export function contextSelectionBudget(contextWindow: number | null): ContextSelectionBudget {
  if (contextWindow === null || !Number.isInteger(contextWindow) || contextWindow <= 0) {
    return {
      contextWindow: null,
      recentChars: UNKNOWN_CONTEXT_RECENT_CHARS,
      recentTurns: 40,
      source: 'conservative-default',
    };
  }
  const replyAndToolReserve = Math.max(4_096, Math.floor(contextWindow * 0.2));
  const inputTokens = Math.max(2_048, contextWindow - replyAndToolReserve - 512);
  const recentChars = Math.max(
    MIN_RECENT_CONTEXT_CHARS,
    Math.min(MAX_RECENT_CONTEXT_CHARS, Math.floor(inputTokens * 3 * 0.55)),
  );
  return {
    contextWindow,
    recentChars,
    recentTurns: MAX_RECENT_CONTEXT_TURNS,
    source: 'model-context',
  };
}

/**
 * The thread turns that a newest-first selection of `messages` sends, given
 * the turn each message came from (-1 for messages that are not a turn's own
 * text). Callers treat every other conversational turn as old.
 */
export function selectedTurnIndexes(
  messages: ReadonlyArray<{ content: string }>,
  turnOf: readonly number[],
  maxChars: number,
  maxEntries: number,
): Set<number> {
  const positions = selectNewestByCharacterBudget(
    messages.map((_, position) => position),
    (position) => (messages[position] as { content: string }).content,
    maxChars,
    maxEntries,
  );
  return new Set(positions.map((position) => turnOf[position] as number).filter((index) => index >= 0));
}

/** Keep the newest complete entries that fit, with no silent partial entry. */
export function selectNewestByCharacterBudget<T>(
  entries: readonly T[],
  text: (entry: T) => string,
  maxChars: number,
  maxEntries: number,
): T[] {
  const selected: T[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0 && selected.length < Math.max(1, maxEntries); index--) {
    const entry = entries[index] as T;
    const length = text(entry).length;
    if (selected.length > 0 && used + length > Math.max(1, maxChars)) {
      break;
    }
    if (length > maxChars) {
      continue;
    }
    selected.push(entry);
    used += length;
  }
  return selected.reverse();
}
