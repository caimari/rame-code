/**
 * Agent-mode and model selectors for the single RAME Code view.
 *
 * This module is free of the `vscode` API so it can be unit tested with
 * plain `node:test`.
 *
 * - `agent` (the default) talks naturally and uses its bounded tools only
 *   when a message needs them.
 * - `chat` is conversation only: no tools and no file access.
 * - `mission` keeps the strict structured mission-plan result.
 * - `agent` runs a bounded permission-gated tool-call loop inside the
 *   active workspace only. It does not claim unrestricted computer control,
 *   arbitrary internet access, terminal emulation, or memory safety beyond
 *   what is actually implemented.
 */

export const CHAT_MODE_ID = 'chat' as const;
export const MISSION_MODE_ID = 'mission' as const;
export const AGENT_MODE_ID = 'agent' as const;
export type ChatModeId =
  | typeof CHAT_MODE_ID
  | typeof MISSION_MODE_ID
  | typeof AGENT_MODE_ID;

export interface ChatModeOption {
  id: ChatModeId;
  label: string;
}

export const DEFAULT_CHAT_MODE: ChatModeId = AGENT_MODE_ID;

export const CHAT_MODES: readonly ChatModeOption[] = [
  { id: AGENT_MODE_ID, label: 'Agent' },
  { id: MISSION_MODE_ID, label: 'Mission' },
  { id: CHAT_MODE_ID, label: 'Chat only' },
];

export const SPARK_MODEL_ID = 'muse-spark-1.3' as const;
export const LOCAL_MODEL_ID = 'local-glimmer' as const;
export type ChatModelId = typeof SPARK_MODEL_ID | typeof LOCAL_MODEL_ID;

export interface ChatModelOption {
  id: ChatModelId;
  label: string;
}

export const CHAT_MODELS: readonly ChatModelOption[] = [
  { id: SPARK_MODEL_ID, label: 'Muse Spark 1.3 (cloud)' },
  { id: LOCAL_MODEL_ID, label: 'Local model (llama-server)' },
];

/** True only for the `chat`, `mission`, or `agent` mode ids. */
export function isSupportedMode(value: string): value is ChatModeId {
  return (
    value === CHAT_MODE_ID ||
    value === MISSION_MODE_ID ||
    value === AGENT_MODE_ID
  );
}

/** True only for the known cloud/local model ids. */
export function isSupportedModel(value: string): value is ChatModelId {
  return value === SPARK_MODEL_ID || value === LOCAL_MODEL_ID;
}
