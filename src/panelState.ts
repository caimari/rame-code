/**
 * Pure panel-state logic for the RAME Code webview. This module is free of
 * the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * The API key itself never appears in this state: the webview learns only
 * the boolean `hasKey` flag through {@link toWebviewStateMessage}.
 */

import type { MissionPlan } from './types.js';

export type ConnectionState =
  | 'missing-key'
  | 'ready'
  | 'working'
  | 'done'
  | 'cancelled'
  | 'error';

export interface PanelState {
  hasKey: boolean;
  running: boolean;
  status: string;
  connection: ConnectionState;
  plan: MissionPlan | null;
  error: string | null;
}

/** Outbound state update posted to the webview. Contains no key material. */
export interface WebviewStateMessage {
  type: 'state';
  hasKey: boolean;
  running: boolean;
  status: string;
  connection: ConnectionState;
  plan: MissionPlan | null;
  error: string | null;
}

export function initialPanelState(hasKey: boolean): PanelState {
  return {
    hasKey,
    running: false,
    status: hasKey
      ? 'Ready. Enter a mission goal to begin.'
      : 'No API key stored. Save a Meta Model API key to begin.',
    connection: hasKey ? 'ready' : 'missing-key',
    plan: null,
    error: null,
  };
}

/** Record whether a key is stored, preserving any running mission. */
export function withHasKey(state: PanelState, hasKey: boolean): PanelState {
  return {
    ...state,
    hasKey,
    connection: state.running ? 'working' : hasKey ? 'ready' : 'missing-key',
    status: hasKey
      ? 'API key stored. Ready.'
      : 'API key cleared. Save a key to run missions.',
  };
}

/** Replace only the status line, leaving mission state untouched. */
export function withStatus(state: PanelState, status: string): PanelState {
  return { ...state, status };
}

/**
 * Enter the running state for a validated goal. Returns `null` when a
 * mission cannot start (already running, no key, or invalid goal), which is
 * how concurrent missions are prevented.
 */
export function withMissionStarted(
  state: PanelState,
  goal: string,
): PanelState | null {
  if (state.running || !state.hasKey || goal.trim().length < 10) {
    return null;
  }
  return {
    ...state,
    running: true,
    connection: 'working',
    status: 'Planning with muse-spark-1.3…',
    plan: null,
    error: null,
  };
}

export function withMissionSucceeded(
  state: PanelState,
  plan: MissionPlan,
): PanelState {
  return {
    ...state,
    running: false,
    connection: 'done',
    status: 'Plan ready.',
    plan,
    error: null,
  };
}

export function withMissionFailed(
  state: PanelState,
  message: string,
): PanelState {
  return {
    ...state,
    running: false,
    connection: 'error',
    status: 'Planning failed.',
    plan: null,
    error: message,
  };
}

export function withMissionCancelled(state: PanelState): PanelState {
  return {
    ...state,
    running: false,
    connection: 'cancelled',
    status: 'Mission cancelled.',
    error: null,
  };
}

/** Project host state to the key-free message the webview receives. */
export function toWebviewStateMessage(state: PanelState): WebviewStateMessage {
  return {
    type: 'state',
    hasKey: state.hasKey,
    running: state.running,
    status: state.status,
    connection: state.connection,
    plan: state.plan,
    error: state.error,
  };
}

/** Human-readable label for the connection indicator. */
export function connectionLabel(connection: ConnectionState): string {
  switch (connection) {
    case 'missing-key':
      return 'Not connected — API key required';
    case 'ready':
      return 'Key stored — live connection not yet verified';
    case 'working':
      return 'Working…';
    case 'done':
      return 'Plan ready';
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return 'Error';
  }
}

/** Escape text for the rare cases where host text enters HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a mission plan as plain text for the output channel. Takes no key
 * argument, so key disclosure through this path is impossible by construction.
 */
export function formatPlanAsText(plan: MissionPlan, model: string): string {
  const lines: string[] = [];
  lines.push(`RAME Code mission plan — ${model}`);
  lines.push('No workspace content was read or sent for this plan.');
  lines.push('');
  lines.push(`Goal: ${plan.goal}`);
  lines.push('');
  lines.push('Assumptions:');
  lines.push(...plan.assumptions.map((item) => `- ${item}`));
  lines.push('');
  lines.push('Steps:');
  plan.steps.forEach((step, index) => {
    lines.push(`${index + 1}. [${step.id}] ${step.title}`);
    lines.push(`   Success criterion: ${step.successCriterion}`);
  });
  lines.push('');
  lines.push('Risks:');
  lines.push(...plan.risks.map((item) => `- ${item}`));
  return lines.join('\n');
}
