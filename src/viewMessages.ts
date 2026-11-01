/**
 * Exact allowlisted message protocol for the single `RAME Code` webview.
 *
 * This module is free of the `vscode` API so it can be unit tested with
 * plain `node:test`.
 *
 * Security rules enforced here:
 * - Only the known inbound shapes are accepted.
 * - Every inbound message must contain exactly its allowlisted own
 *   enumerable keys: no missing and no additional fields.
 * - Validation errors never echo received values (in particular, never the
 *   API key or file paths).
 * - Outbound state carries only a boolean `hasKey` flag, never key material,
 *   and settings snapshots never include secrets.
 */

import { isAgentProfileId } from './agentProfiles.js';
import type { LocalRuntimeSettings, LocalRuntimeStatus } from './localRuntime.js';
import type { ChatModeId } from './modes.js';
import type { CloudCatalogSource, CloudModelInfo } from './metaCatalog.js';
import {
  isRuntimeId,
  RUNTIME_CLOUD_ID,
  RUNTIME_LOCAL_ID,
  type ProviderId,
  type RuntimeId,
} from './settingsStore.js';
import type { ChatThread, ThreadTurn } from './threadStore.js';
import type { ProviderUsage } from './usage.js';

export type ViewScreen = 'chat' | 'settings';

export type ViewConnection =
  | 'missing-key'
  | 'ready'
  | 'working'
  | 'done'
  | 'verified'
  | 'cancelled'
  | 'error';

export interface NavigateMessage {
  type: 'navigate';
  screen: ViewScreen;
}

export interface ReadyMessage {
  type: 'ready';
}

export interface NewThreadMessage {
  type: 'newThread';
}

export interface BackToListMessage {
  type: 'backToList';
}

export interface OpenThreadMessage {
  type: 'openThread';
  threadId: string;
}

export interface DeleteThreadMessage {
  type: 'deleteThread';
  threadId: string;
}

export interface RefreshMessage {
  type: 'refresh';
}

export interface SendMessageMessage {
  type: 'sendMessage';
  text: string;
  mode: string;
  /** One exact runtime choice; provider+model are derived host-side. */
  runtime: RuntimeId;
}

export interface CancelMessage {
  type: 'cancel';
}

export interface SaveKeyMessage {
  type: 'saveKey';
  apiKey: string;
}

export interface ClearKeyMessage {
  type: 'clearKey';
}

export interface UpdateSettingsMessage {
  type: 'updateSettings';
  runtime: RuntimeId;
  mode: string;
  allowCloudEscalation: boolean;
}

export interface UpdateLocalSettingsMessage {
  type: 'updateLocalSettings';
  executablePath: string;
  modelPath: string;
  projectorPath: string;
  draftModelPath: string;
  modelId: string;
  contextSize: number;
  port: number;
  idleTimeoutSec: number;
}

export interface UseSuggestionsMessage {
  type: 'useSuggestions';
}

export interface SelectCloudModelMessage {
  type: 'selectCloudModel';
  model: string;
}

export interface RefreshModelsMessage {
  type: 'refreshModels';
}

export interface StartLocalMessage {
  type: 'startLocal';
  executablePath: string;
  modelPath: string;
  projectorPath: string;
  draftModelPath: string;
  modelId: string;
  contextSize: number;
  port: number;
  idleTimeoutSec: number;
}

export interface StopLocalMessage {
  type: 'stopLocal';
}

export interface SelectExternalEndpointMessage {
  type: 'selectExternalEndpoint';
  endpoint: string;
}

export interface ClearExternalEndpointMessage {
  type: 'clearExternalEndpoint';
}

export interface EscalateApproveMessage {
  type: 'escalateApprove';
}

export interface EscalateDismissMessage {
  type: 'escalateDismiss';
}

export interface SetAgentProfileMessage {
  type: 'setAgentProfile';
  profile: string;
}

export interface ApproveAgentActionMessage {
  type: 'approveAgentAction';
  actionId: string;
  digest: string;
}

export interface RejectAgentActionMessage {
  type: 'rejectAgentAction';
  actionId: string;
  digest: string;
}

export type ViewInboundMessage =
  | NavigateMessage
  | ReadyMessage
  | NewThreadMessage
  | BackToListMessage
  | OpenThreadMessage
  | DeleteThreadMessage
  | RefreshMessage
  | SendMessageMessage
  | CancelMessage
  | SaveKeyMessage
  | ClearKeyMessage
  | UpdateSettingsMessage
  | UpdateLocalSettingsMessage
  | UseSuggestionsMessage
  | SelectCloudModelMessage
  | RefreshModelsMessage
  | StartLocalMessage
  | StopLocalMessage
  | SelectExternalEndpointMessage
  | ClearExternalEndpointMessage
  | EscalateApproveMessage
  | EscalateDismissMessage
  | SetAgentProfileMessage
  | ApproveAgentActionMessage
  | RejectAgentActionMessage;

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

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Parse an untrusted webview `postMessage` payload. Throws a generic
 * `Error` whose text never contains received values.
 */
export function parseViewInboundMessage(raw: unknown): ViewInboundMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('Invalid view message.');
  }
  const record = raw as Record<string, unknown>;
  switch (record.type) {
    case 'ready':
      if (!hasExactKeys(record, ['type'])) fail('Invalid ready message.');
      return { type: 'ready' };
    case 'navigate':
      if (
        !hasExactKeys(record, ['type', 'screen']) ||
        (record.screen !== 'chat' && record.screen !== 'settings')
      ) {
        fail('Invalid navigate message.');
      }
      return { type: 'navigate', screen: record.screen as ViewScreen };
    case 'newThread':
      if (!hasExactKeys(record, ['type'])) fail('Invalid newThread message.');
      return { type: 'newThread' };
    case 'backToList':
      if (!hasExactKeys(record, ['type'])) fail('Invalid backToList message.');
      return { type: 'backToList' };
    case 'openThread':
      if (
        !hasExactKeys(record, ['type', 'threadId']) ||
        typeof record.threadId !== 'string' ||
        record.threadId.length === 0 ||
        record.threadId.length > MAX_THREAD_ID_LENGTH
      ) {
        fail('Invalid openThread message.');
      }
      return { type: 'openThread', threadId: record.threadId };
    case 'deleteThread':
      if (
        !hasExactKeys(record, ['type', 'threadId']) ||
        typeof record.threadId !== 'string' ||
        record.threadId.length === 0 ||
        record.threadId.length > MAX_THREAD_ID_LENGTH
      ) {
        fail('Invalid deleteThread message.');
      }
      return { type: 'deleteThread', threadId: record.threadId };
    case 'refresh':
      if (!hasExactKeys(record, ['type'])) fail('Invalid refresh message.');
      return { type: 'refresh' };
    case 'sendMessage':
      if (
        !hasExactKeys(record, ['type', 'text', 'mode', 'runtime']) ||
        typeof record.text !== 'string' ||
        typeof record.mode !== 'string' ||
        typeof record.runtime !== 'string' ||
        !isRuntimeId(record.runtime)
      ) {
        fail('Invalid sendMessage message.');
      }
      return {
        type: 'sendMessage',
        text: record.text as string,
        mode: record.mode as string,
        runtime: record.runtime as RuntimeId,
      };
    case 'cancel':
      if (!hasExactKeys(record, ['type'])) fail('Invalid cancel message.');
      return { type: 'cancel' };
    case 'saveKey':
      if (
        !hasExactKeys(record, ['type', 'apiKey']) ||
        typeof record.apiKey !== 'string'
      ) {
        fail('Invalid saveKey message.');
      }
      return { type: 'saveKey', apiKey: record.apiKey };
    case 'clearKey':
      if (!hasExactKeys(record, ['type'])) fail('Invalid clearKey message.');
      return { type: 'clearKey' };
    case 'updateSettings':
      if (
        !hasExactKeys(record, [
          'type',
          'runtime',
          'mode',
          'allowCloudEscalation',
        ]) ||
        typeof record.runtime !== 'string' ||
        !isRuntimeId(record.runtime) ||
        typeof record.mode !== 'string' ||
        typeof record.allowCloudEscalation !== 'boolean'
      ) {
        fail('Invalid updateSettings message.');
      }
      return {
        type: 'updateSettings',
        runtime: record.runtime as RuntimeId,
        mode: record.mode as string,
        allowCloudEscalation: record.allowCloudEscalation as boolean,
      };
    case 'updateLocalSettings':
      if (
        !hasExactKeys(record, [
          'type',
          'executablePath',
          'modelPath',
          'projectorPath',
          'draftModelPath',
          'modelId',
          'contextSize',
          'port',
          'idleTimeoutSec',
        ]) ||
        typeof record.executablePath !== 'string' ||
        typeof record.modelPath !== 'string' ||
        typeof record.projectorPath !== 'string' ||
        typeof record.draftModelPath !== 'string' ||
        typeof record.modelId !== 'string' ||
        typeof record.contextSize !== 'number' ||
        typeof record.port !== 'number' ||
        typeof record.idleTimeoutSec !== 'number'
      ) {
        fail('Invalid updateLocalSettings message.');
      }
      return {
        type: 'updateLocalSettings',
        executablePath: record.executablePath,
        modelPath: record.modelPath,
        projectorPath: record.projectorPath,
        draftModelPath: record.draftModelPath,
        modelId: record.modelId,
        contextSize: record.contextSize,
        port: record.port,
        idleTimeoutSec: record.idleTimeoutSec,
      };
    case 'useSuggestions':
      if (!hasExactKeys(record, ['type'])) {
        fail('Invalid useSuggestions message.');
      }
      return { type: 'useSuggestions' };
    case 'selectCloudModel':
      if (
        !hasExactKeys(record, ['type', 'model']) ||
        typeof record.model !== 'string' ||
        record.model.length === 0 ||
        record.model.length > 128
      ) {
        fail('Invalid selectCloudModel message.');
      }
      return { type: 'selectCloudModel', model: record.model };
    case 'refreshModels':
      if (!hasExactKeys(record, ['type'])) {
        fail('Invalid refreshModels message.');
      }
      return { type: 'refreshModels' };
    case 'startLocal':
      if (
        !hasExactKeys(record, [
          'type',
          'executablePath',
          'modelPath',
          'projectorPath',
          'draftModelPath',
          'modelId',
          'contextSize',
          'port',
          'idleTimeoutSec',
        ]) ||
        typeof record.executablePath !== 'string' ||
        typeof record.modelPath !== 'string' ||
        typeof record.projectorPath !== 'string' ||
        typeof record.draftModelPath !== 'string' ||
        typeof record.modelId !== 'string' ||
        typeof record.contextSize !== 'number' ||
        typeof record.port !== 'number' ||
        typeof record.idleTimeoutSec !== 'number'
      ) {
        fail('Invalid startLocal message.');
      }
      return {
        type: 'startLocal',
        executablePath: record.executablePath,
        modelPath: record.modelPath,
        projectorPath: record.projectorPath,
        draftModelPath: record.draftModelPath,
        modelId: record.modelId,
        contextSize: record.contextSize,
        port: record.port,
        idleTimeoutSec: record.idleTimeoutSec,
      };
    case 'stopLocal':
      if (!hasExactKeys(record, ['type'])) fail('Invalid stopLocal message.');
      return { type: 'stopLocal' };
    case 'selectExternalEndpoint':
      if (
        !hasExactKeys(record, ['type', 'endpoint']) ||
        typeof record.endpoint !== 'string'
      ) {
        fail('Invalid selectExternalEndpoint message.');
      }
      return { type: 'selectExternalEndpoint', endpoint: record.endpoint };
    case 'clearExternalEndpoint':
      if (!hasExactKeys(record, ['type'])) {
        fail('Invalid clearExternalEndpoint message.');
      }
      return { type: 'clearExternalEndpoint' };
    case 'escalateApprove':
      if (!hasExactKeys(record, ['type'])) {
        fail('Invalid escalateApprove message.');
      }
      return { type: 'escalateApprove' };
    case 'escalateDismiss':
      if (!hasExactKeys(record, ['type'])) {
        fail('Invalid escalateDismiss message.');
      }
      return { type: 'escalateDismiss' };
    case 'setAgentProfile':
      if (
        !hasExactKeys(record, ['type', 'profile']) ||
        typeof record.profile !== 'string' ||
        !isAgentProfileId(record.profile)
      ) {
        fail('Invalid setAgentProfile message.');
      }
      return { type: 'setAgentProfile', profile: record.profile };
    case 'approveAgentAction':
      if (
        !hasExactKeys(record, ['type', 'actionId', 'digest']) ||
        typeof record.actionId !== 'string' ||
        record.actionId.length === 0 ||
        record.actionId.length > 128 ||
        typeof record.digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(record.digest)
      ) {
        fail('Invalid approveAgentAction message.');
      }
      return {
        type: 'approveAgentAction',
        actionId: record.actionId,
        digest: record.digest,
      };
    case 'rejectAgentAction':
      if (
        !hasExactKeys(record, ['type', 'actionId', 'digest']) ||
        typeof record.actionId !== 'string' ||
        record.actionId.length === 0 ||
        record.actionId.length > 128 ||
        typeof record.digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(record.digest)
      ) {
        fail('Invalid rejectAgentAction message.');
      }
      return {
        type: 'rejectAgentAction',
        actionId: record.actionId,
        digest: record.digest,
      };
    default:
      fail('Unknown view message.');
  }
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export function toThreadSummaries(threads: ChatThread[]): ThreadSummary[] {
  return threads.map((thread) => ({
    id: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
  }));
}

export const CHAT_SCOPE_NOTICE =
  'Chat sends the active thread\u2019s recent history (bounded, most recent first) plus your new message. Other threads are never sent.';
export const MISSION_SCOPE_NOTICE =
  'Mission sends only your new message to Meta Model API. Earlier thread content is never sent as context.';
export const AGENT_SCOPE_NOTICE =
  'Agent runs a bounded tool loop with the selected provider only (local Glimmer or the selected Meta cloud model, never switched silently). It inspects and changes only the active workspace under the selected permission profile. There is no arbitrary shell or terminal emulation tool, but allowlisted test scripts run with your OS permissions and may access files, network including arbitrary internet, or shells; there is no OS sandbox for them. No computer-wide control or memory safety beyond what is implemented is claimed.';

/** Agent notice naming the exact selected cloud model (or local Glimmer). */
export function agentScopeNotice(cloudModel: string): string {
  const safe =
    typeof cloudModel === 'string' &&
    /^muse-(spark|wonder)-[A-Za-z0-9._-]+$/.test(cloudModel.trim()) &&
    cloudModel.trim().length <= 128
      ? cloudModel.trim()
      : 'muse-spark-1.3';
  return (
    `Agent runs a bounded tool loop with the selected provider only (local Glimmer or Meta ${safe}, never switched silently). ` +
    'It inspects and changes only the active workspace under the selected permission profile. There is no arbitrary shell or terminal emulation tool, but allowlisted test scripts run with your OS permissions and may access files, network including arbitrary internet, or shells; there is no OS sandbox for them. No computer-wide control or memory safety beyond what is implemented is claimed.'
  );
}

export function scopeNoticeForMode(mode: ChatModeId, cloudModel?: string): string {
  if (mode === 'mission') {
    return MISSION_SCOPE_NOTICE;
  }
  if (mode === 'agent') {
    return agentScopeNotice(typeof cloudModel === 'string' ? cloudModel : 'muse-spark-1.3');
  }
  return CHAT_SCOPE_NOTICE;
}

export interface EscalationState {
  pending: boolean;
  reason: string;
}

/**
 * Outbound view state posted to the webview. Contains a boolean `hasKey`
 * flag only; by construction there is no field that can carry key material.
 */
export interface AgentPendingView {
  actionId: string;
  digest: string;
  tool: string;
  targets: string[];
  provider: string;
  workspaceId: string;
  threadId: string;
  bodyPreview: string;
}

export interface AgentLogEntryView {
  tool: string;
  digest: string;
  decision: string;
  result: string;
}

export interface ViewStateMessage {
  type: 'state';
  screen: ViewScreen;
  hasKey: boolean;
  running: boolean;
  status: string;
  connection: ViewConnection;
  /** Single provider-level runtime choice. */
  runtime: RuntimeId;
  provider: ProviderId;
  mode: ChatModeId;
  model: string;
  /** Validated subordinate cloud-only model selection. */
  cloudModel: string;
  /** Sanitized compatible catalog for display only (never key material). */
  cloudCatalog: CloudModelInfo[];
  cloudCatalogSource: CloudCatalogSource;
  threads: ThreadSummary[];
  activeThreadId: string | null;
  turns: ThreadTurn[];
  notice: string;
  usageLast: ProviderUsage;
  usageCloud: ProviderUsage;
  usageLocal: ProviderUsage;
  local: LocalRuntimeStatus;
  /** Bounded non-secret local settings snapshot for form population. */
  localSettings: LocalRuntimeSettings;
  /** Revision bumped whenever `localSettings` changes; webview fills once per rev. */
  localSettingsRev: number;
  escalation: EscalationState;
  allowCloudEscalation: boolean;
  externalLocalEndpoint: string;
  agentProfile: string;
  agentWorkspace: string | null;
  agentPending: AgentPendingView | null;
  agentLog: AgentLogEntryView[];
  /** Thread of the current or most recent run; run outcomes show only there. */
  runThreadId: string | null;
}

export function runtimeLabel(runtime: RuntimeId): string {
  return runtime === RUNTIME_LOCAL_ID
    ? 'Muse Glimmer — Local'
    : 'Meta Model API — Cloud';
}

/** Display label including the selected cloud model for cloud runtime. */
export function runtimeStatusLabel(runtime: RuntimeId, cloudModel: string): string {
  if (runtime === RUNTIME_LOCAL_ID) {
    return 'Muse Glimmer — Local';
  }
  const safe =
    typeof cloudModel === 'string' &&
    /^muse-(spark|wonder)-[A-Za-z0-9._-]+$/.test(cloudModel.trim())
      ? cloudModel.trim()
      : 'muse-spark-1.3';
  return `Meta Model API — Cloud (${safe})`;
}

export function buildViewStateMessage(options: {
  screen: ViewScreen;
  hasKey: boolean;
  running: boolean;
  status: string;
  connection: ViewConnection;
  provider: ProviderId;
  mode: ChatModeId;
  model?: string;
  cloudModel?: string;
  cloudCatalog?: CloudModelInfo[];
  cloudCatalogSource?: CloudCatalogSource;
  runtime?: RuntimeId;
  threads: ChatThread[];
  activeThreadId: string | null;
  turns: ThreadTurn[];
  usageLast: ProviderUsage;
  usageCloud: ProviderUsage;
  usageLocal: ProviderUsage;
  local: LocalRuntimeStatus;
  localSettings?: LocalRuntimeSettings;
  localSettingsRev?: number;
  escalation: EscalationState;
  allowCloudEscalation: boolean;
  externalLocalEndpoint: string;
  agentProfile?: string;
  agentWorkspace?: string | null;
  agentPending?: AgentPendingView | null;
  agentLog?: AgentLogEntryView[];
  runThreadId?: string | null;
}): ViewStateMessage {
  // The provider-level runtime is the source of truth; the cloud model is
  // a validated subordinate selection. Mismatched/arbitrary combinations
  // collapse to the safe fallback.
  const runtime: RuntimeId =
    options.runtime ?? (options.provider === 'local' ? RUNTIME_LOCAL_ID : RUNTIME_CLOUD_ID);
  const provider: ProviderId = runtime === RUNTIME_LOCAL_ID ? 'local' : 'cloud';
  const cloudModel = validateViewCloudModel(options.cloudModel ?? options.model);
  const model = runtime === RUNTIME_LOCAL_ID ? 'local-glimmer' : cloudModel;
  return {
    type: 'state',
    screen: options.screen,
    hasKey: options.hasKey,
    running: options.running,
    status: options.status,
    connection: options.connection,
    runtime,
    provider,
    mode: options.mode,
    model,
    cloudModel,
    cloudCatalog: sanitizeViewCatalog(options.cloudCatalog),
    cloudCatalogSource: options.cloudCatalogSource === 'live' ? 'live' : 'fallback',
    threads: toThreadSummaries(options.threads),
    activeThreadId: options.activeThreadId,
    turns: options.turns,
    notice: scopeNoticeForMode(options.mode, cloudModel),
    usageLast: options.usageLast,
    usageCloud: options.usageCloud,
    usageLocal: options.usageLocal,
    local: options.local,
    localSettings: sanitizeViewLocalSettings(options.localSettings),
    localSettingsRev:
      typeof options.localSettingsRev === 'number' &&
      Number.isInteger(options.localSettingsRev) &&
      options.localSettingsRev >= 0
        ? options.localSettingsRev
        : 0,
    escalation: options.escalation,
    allowCloudEscalation: options.allowCloudEscalation,
    externalLocalEndpoint: options.externalLocalEndpoint,
    agentProfile: options.agentProfile ?? 'ask',
    agentWorkspace: options.agentWorkspace ?? null,
    agentPending: options.agentPending ?? null,
    agentLog: options.agentLog ?? [],
    runThreadId: typeof options.runThreadId === 'string' ? options.runThreadId : null,
  };
}

function validateViewCloudModel(value: unknown): string {
  if (typeof value !== 'string') {
    return 'muse-spark-1.3';
  }
  const id = value.trim();
  if (id.length === 0 || id.length > 128) {
    return 'muse-spark-1.3';
  }
  if (!/^muse-(spark|wonder)-[A-Za-z0-9._-]+$/.test(id)) {
    return 'muse-spark-1.3';
  }
  return id;
}

function sanitizeViewCatalog(value: unknown): CloudModelInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: CloudModelInfo[] = [];
  for (const entry of value.slice(0, 100)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.label !== 'string') {
      continue;
    }
    const id = record.id.trim();
    if (!/^muse-(spark|wonder)-[A-Za-z0-9._-]+$/.test(id) || id.length > 128) {
      continue;
    }
    out.push({
      id,
      label: String(record.label).slice(0, 200),
      contributor: record.contributor === true,
      ...(typeof record.created === 'number' ? { created: record.created } : {}),
    });
  }
  return out;
}

function sanitizeViewLocalSettings(value: unknown): LocalRuntimeSettings {
  const fallback: LocalRuntimeSettings = {
    executablePath: '',
    modelPath: '',
    projectorPath: '',
    draftModelPath: '',
    modelId: 'local-glimmer',
    contextSize: 32768,
    port: 8775,
    idleTimeoutSec: 600,
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const str = (key: string): string =>
    typeof record[key] === 'string' ? String(record[key]).slice(0, 1024) : '';
  const num = (key: string, dflt: number): number =>
    typeof record[key] === 'number' && Number.isFinite(record[key])
      ? (record[key] as number)
      : dflt;
  return {
    executablePath: str('executablePath'),
    modelPath: str('modelPath'),
    projectorPath: str('projectorPath'),
    draftModelPath: str('draftModelPath'),
    modelId: str('modelId').length > 0 ? str('modelId').slice(0, 128) : 'local-glimmer',
    contextSize: num('contextSize', 32768),
    port: num('port', 8775),
    idleTimeoutSec: num('idleTimeoutSec', 600),
  };
}

export const LOCAL_UNREACHABLE_SETTINGS_HINT = 'Start it in Settings.';

function sanitizeLoopbackEndpoint(value: unknown): string {
  if (typeof value !== 'string') {
    return 'http://127.0.0.1:8775';
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0 || trimmed.length > 128) {
    return 'http://127.0.0.1:8775';
  }
  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    return 'http://127.0.0.1:8775';
  }
  const host = url.hostname.toLowerCase();
  if (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    (host === '127.0.0.1' || host === 'localhost' || host === '::1')
  ) {
    return trimmed.slice(0, 128);
  }
  return 'http://127.0.0.1:8775';
}

/**
 * Friendly actionable message when the selected local endpoint cannot be
 * reached. Never includes raw fetch stacks; the caller supplies only the
 * loopback endpoint display value.
 */
export function localUnreachableMessage(endpoint: unknown): string {
  const display = sanitizeLoopbackEndpoint(endpoint);
  return `Local model is not reachable at ${display}. Start it in Settings.`;
}

/** True when a message is the friendly local-unreachable action text. */
export function isLocalUnreachableMessage(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.startsWith('Local model is not reachable at ') &&
    value.endsWith('. Start it in Settings.')
  );
}

/** Human-readable label for the connection indicator. */
export function viewConnectionLabel(connection: ViewConnection): string {
  switch (connection) {
    case 'missing-key':
      return 'Not connected — API key required';
    case 'ready':
      return 'Key stored — live connection not yet verified';
    case 'working':
      return 'Working…';
    case 'done':
      return 'Plan ready';
    case 'verified':
      return 'Connected — verified';
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return 'Error';
  }
}
