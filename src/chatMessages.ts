/**
 * Exact allowlisted message protocol for the Chats webview view.
 *
 * This module is free of the `vscode` API so it can be unit tested with
 * plain `node:test`.
 *
 * Security rules enforced here (mirroring the existing panel contract):
 * - Only the known inbound shapes are accepted.
 * - Every inbound message must contain exactly its allowlisted own
 *   enumerable keys: no missing and no additional fields.
 * - Validation errors never echo received values.
 * - Outbound state carries only a boolean `hasKey` flag, never key material.
 */

import type { ConnectionState } from './panelState.js';
import type { ChatThread, ThreadTurn } from './threadStore.js';

export interface ChatReadyMessage {
  type: 'ready';
}

export interface NewThreadMessage {
  type: 'newThread';
}

export interface OpenThreadMessage {
  type: 'openThread';
  threadId: string;
}

export interface RefreshThreadsMessage {
  type: 'refreshThreads';
}

export interface SendMessageMessage {
  type: 'sendMessage';
  text: string;
  mode: string;
  model: string;
}

export interface CancelMissionMessage {
  type: 'cancelMission';
}

export interface OpenSettingsMessage {
  type: 'openSettings';
}

export type ChatInboundMessage =
  | ChatReadyMessage
  | NewThreadMessage
  | OpenThreadMessage
  | RefreshThreadsMessage
  | SendMessageMessage
  | CancelMissionMessage
  | OpenSettingsMessage;

export const MAX_THREAD_ID_LENGTH = 128;

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

/**
 * Parse an untrusted Chats `postMessage` payload. Throws a generic `Error`
 * whose text never contains received values.
 */
export function parseChatInboundMessage(raw: unknown): ChatInboundMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid chats message.');
  }
  const record = raw as Record<string, unknown>;
  switch (record.type) {
    case 'ready':
      if (!hasExactKeys(record, ['type'])) {
        throw new Error('Invalid ready message.');
      }
      return { type: 'ready' };
    case 'newThread':
      if (!hasExactKeys(record, ['type'])) {
        throw new Error('Invalid newThread message.');
      }
      return { type: 'newThread' };
    case 'openThread':
      if (
        !hasExactKeys(record, ['type', 'threadId']) ||
        typeof record.threadId !== 'string' ||
        record.threadId.length === 0 ||
        record.threadId.length > MAX_THREAD_ID_LENGTH
      ) {
        throw new Error('Invalid openThread message.');
      }
      return { type: 'openThread', threadId: record.threadId };
    case 'refreshThreads':
      if (!hasExactKeys(record, ['type'])) {
        throw new Error('Invalid refreshThreads message.');
      }
      return { type: 'refreshThreads' };
    case 'sendMessage':
      if (
        !hasExactKeys(record, ['type', 'text', 'mode', 'model']) ||
        typeof record.text !== 'string' ||
        typeof record.mode !== 'string' ||
        typeof record.model !== 'string'
      ) {
        throw new Error('Invalid sendMessage message.');
      }
      return {
        type: 'sendMessage',
        text: record.text,
        mode: record.mode,
        model: record.model,
      };
    case 'cancelMission':
      if (!hasExactKeys(record, ['type'])) {
        throw new Error('Invalid cancelMission message.');
      }
      return { type: 'cancelMission' };
    case 'openSettings':
      if (!hasExactKeys(record, ['type'])) {
        throw new Error('Invalid openSettings message.');
      }
      return { type: 'openSettings' };
    default:
      throw new Error('Unknown chats message.');
  }
}

export interface ChatThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
}

/**
 * Outbound Chats state posted to the webview. Contains a boolean `hasKey`
 * flag only; by construction there is no field that can carry key material.
 */
export interface ChatsStateMessage {
  type: 'state';
  hasKey: boolean;
  running: boolean;
  status: string;
  connection: ConnectionState;
  threads: ChatThreadSummary[];
  activeThreadId: string | null;
  turns: ThreadTurn[];
  notice: string;
}

export const CHATS_SCOPE_NOTICE =
  'Only the current message is sent to Meta Model API. Earlier thread content is not sent as context yet.';

export function toThreadSummaries(threads: ChatThread[]): ChatThreadSummary[] {
  return threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
  }));
}

export function buildChatsStateMessage(options: {
  hasKey: boolean;
  running: boolean;
  status: string;
  connection: ConnectionState;
  threads: ChatThread[];
  activeThreadId: string | null;
  turns: ThreadTurn[];
}): ChatsStateMessage {
  return {
    type: 'state',
    hasKey: options.hasKey,
    running: options.running,
    status: options.status,
    connection: options.connection,
    threads: toThreadSummaries(options.threads),
    activeThreadId: options.activeThreadId,
    turns: options.turns,
    notice: CHATS_SCOPE_NOTICE,
  };
}

/**
 * Select the goal text for one mission-plan call. Takes only the newly
 * submitted composer text — never the thread history — so additional sends
 * in the same thread stay independent mission-plan calls by construction.
 * Callers validate the returned text with `validateGoalInput` before sending.
 */
export function selectMissionGoalForSend(currentText: string): string {
  return currentText.trim();
}
