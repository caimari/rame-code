/**
 * Exact allowlisted message protocol for the Settings webview view.
 *
 * This module is free of the `vscode` API so it can be unit tested with
 * plain `node:test`.
 *
 * Security rules enforced here (mirroring the existing panel contract):
 * - Only the three known inbound shapes are accepted.
 * - Every inbound message must contain exactly its allowlisted own
 *   enumerable keys: no missing and no additional fields.
 * - Validation errors never echo received values (in particular, never the
 *   API key).
 * - Outbound state carries only a boolean `hasKey` flag, never key material.
 */

import type { ConnectionState } from './panelState.js';

export interface SettingsReadyMessage {
  type: 'ready';
}

export interface SaveKeyMessage {
  type: 'saveKey';
  apiKey: string;
}

export interface ClearKeyMessage {
  type: 'clearKey';
}

export type SettingsInboundMessage =
  | SettingsReadyMessage
  | SaveKeyMessage
  | ClearKeyMessage;

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
 * Parse an untrusted Settings `postMessage` payload. Throws a generic
 * `Error` whose text never contains received values.
 */
export function parseSettingsInboundMessage(
  raw: unknown,
): SettingsInboundMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid settings message.');
  }
  const record = raw as Record<string, unknown>;
  switch (record.type) {
    case 'ready':
      if (!hasExactKeys(record, ['type'])) {
        throw new Error('Invalid ready message.');
      }
      return { type: 'ready' };
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
    default:
      throw new Error('Unknown settings message.');
  }
}

/**
 * Outbound Settings state posted to the webview. Contains a boolean
 * `hasKey` flag only; by construction there is no field that can carry key
 * material.
 */
export interface SettingsStateMessage {
  type: 'state';
  hasKey: boolean;
  connection: ConnectionState;
  status: string;
}

export function buildSettingsStateMessage(options: {
  hasKey: boolean;
  connection: ConnectionState;
  status: string;
}): SettingsStateMessage {
  return {
    type: 'state',
    hasKey: options.hasKey,
    connection: options.connection,
    status: options.status,
  };
}
