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

import type { ChosenAdvisoryLimits } from './missionAdvisoryLimits.js';
import { MISSION_CONSULT_CHOICES } from './autonomyPolicy.js';
import { sanitizeEvidenceView, type ModelEvidenceView } from './modelEvidence.js';
import { sanitizeContinuityLogView, type ContinuityLogView } from './continuityLog.js';
import { sanitizeMissionAcceptanceReviewView, type MissionAcceptanceReviewView } from './missionAcceptanceReviewView.js';
import { isLocalOrPrivateUrl } from './localServers.js';
import { parseRemoteMessage, sanitizeMissionRemote, sanitizeRemoteView, type MissionRemoteView, type RemoteMessage, type RemoteView } from './remoteViews.js';
import { isAgentProfileId } from './agentProfiles.js';
import { isReasoningChoice, REASONING_LEVELS } from './generationSettings.js';
import type { LocalRuntimeSettings, LocalRuntimeStatus } from './localRuntime.js';
import type { ChatModeId } from './modes.js';
import { MISSION_PHASES, type AcceptanceState, type MissionFinalReport, type MissionPhase } from './missionPhase.js';
import type { CloudCatalogSource, CloudModelInfo } from './metaCatalog.js';
import {
  isRuntimeId,
  isViewLanguage,
  RUNTIME_CLOUD_ID,
  RUNTIME_LOCAL_ID,
  type ProviderId,
  type RuntimeId,
  type ViewLanguage,
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

export interface TestMetaConnectionMessage {
  type: 'testMetaConnection';
}

export interface OpenRepositoryMessage {
  type: 'openRepository';
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

export type { EscalateApproveMessage } from './remoteViews.js';

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

/** Reasoning level for the exact provider/model the view shows. */
export interface SetReasoningMessage {
  type: 'setReasoning';
  provider: ProviderId;
  model: string;
  level: string;
}

/** Settings: the user proposes one decision value (nothing is written yet). */
export interface ProposeDecisionMessage {
  type: 'proposeDecision';
  key: string;
  valueType: 'number' | 'boolean' | 'string';
  value: string;
}

/** Start or resume the current task of a Mission the view showed at `revision`. */
export interface RunMissionTaskMessage {
  type: 'runMissionTask';
  missionId: string;
  revision: number;
}

/** Approve or reject the exact pending memory card. */
export interface MemoryDecisionMessage {
  type: 'approveMemoryChange' | 'rejectMemoryChange';
  actionId: string;
  digest: string;
}

/** Settings: show the memory of one of the open workspace folders. */
export interface SelectMemoryProjectMessage {
  type: 'selectMemoryProject';
  path: string;
}

/** Interface language of the view. */
export interface SetLanguageMessage {
  type: 'setLanguage';
  language: ViewLanguage;
}

/** Mission controls: authorize and start, resume, pause, cancel. */
export interface MissionStartMessage {
  type: 'missionStart';
  missionId: string;
  revision: number;
  mode: 'supervised' | 'autonomous-workspace';
  /** 0 = no Meta consultation; 1 to 5 = at most that many. */
  maxConsultations: number;
  /** The user marked this project as trusted (required for autonomous workspace). */
  trustedProject: boolean;
  /** The user's acceptance check to freeze ('' = none) and its files. */
  acceptanceCommand: string;
  acceptanceFiles: string[];
  /** One click of "Authorize and start"; the host confirms it by this id. */
  requestId?: string;
  /** Advisory limits the user chose; a null field keeps the default. */
  advisoryLimits?: ChosenAdvisoryLimits | null;
}

/** Pattern of a view-generated start request id. */
const REQUEST_ID_PATTERN = /^req_[0-9a-z]{6,40}$/;

/** Every required key, and otherwise only optional ones. */
function hasKeysAmong(record: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return required.every((key) => Object.prototype.hasOwnProperty.call(record, key)) && Object.keys(record).every((key) => required.includes(key) || optional.includes(key));
}

/** Absent, null, or exactly the four limits, each an integer or null; ranges are the store's. */
function isChosenLimits(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  const keys = ['maxRequestBytes', 'maxTotalBytes', 'maxOutputTokens', 'maxTotalTokens'];
  return (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    hasExactKeys(value as Record<string, unknown>, keys) &&
    keys.every((key) => {
      const entry = (value as Record<string, unknown>)[key];
      return entry === null || (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 20_000_000);
    })
  );
}

export interface MissionControlMessage {
  type: 'missionResume' | 'missionPause' | 'missionCancel';
  missionId: string;
  revision: number;
}

/** Retry a blocked Mission with guidance the user typed for the next runs. */
export interface MissionRetryMessage {
  type: 'missionRetry';
  missionId: string;
  revision: number;
  guidance: string;
}

/** Cascade: approve the exact consultation payload shown (by its digest), or dismiss it. */
export interface ConsultApproveMessage {
  type: 'consultApprove';
  digest: string;
}

export interface ConsultDismissMessage {
  type: 'consultDismiss';
}

/** Advanced manual output maximum per provider; null = automatic. */
export interface SetMaxOutputTokensMessage {
  type: 'setMaxOutputTokens';
  local: number | null;
  cloud: number | null;
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
  | TestMetaConnectionMessage
  | OpenRepositoryMessage
  | StartLocalMessage
  | StopLocalMessage
  | SelectExternalEndpointMessage
  | ClearExternalEndpointMessage
  | RemoteMessage
  | EscalateDismissMessage
  | SetAgentProfileMessage
  | ApproveAgentActionMessage
  | RejectAgentActionMessage
  | SetReasoningMessage
  | SetMaxOutputTokensMessage
  | ProposeDecisionMessage
  | MemoryDecisionMessage
  | RunMissionTaskMessage
  | SelectMemoryProjectMessage
  | SetLanguageMessage
  | ConsultApproveMessage
  | ConsultDismissMessage
  | MissionStartMessage
  | MissionControlMessage
  | MissionRetryMessage;

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

function parseRemoteOrFail(record: Record<string, unknown>): RemoteMessage | null {
  try {
    return parseRemoteMessage(record);
  } catch (error) {
    return fail((error as Error).message);
  }
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
  const remote = parseRemoteOrFail(record);
  if (remote !== null) {
    return remote;
  }
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
    case 'testMetaConnection':
      if (!hasExactKeys(record, ['type'])) {
        fail('Invalid testMetaConnection message.');
      }
      return { type: 'testMetaConnection' };
    case 'openRepository':
      if (!hasExactKeys(record, ['type'])) {
        fail('Invalid openRepository message.');
      }
      return { type: 'openRepository' };
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
    case 'setReasoning':
      if (
        !hasExactKeys(record, ['type', 'provider', 'model', 'level']) ||
        (record.provider !== 'cloud' && record.provider !== 'local') ||
        typeof record.model !== 'string' ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(record.model) ||
        typeof record.level !== 'string' ||
        !isReasoningChoice(record.level)
      ) {
        fail('Invalid setReasoning message.');
      }
      return {
        type: 'setReasoning',
        provider: record.provider as ProviderId,
        model: record.model as string,
        level: record.level as string,
      };
    case 'proposeDecision':
      if (
        !hasExactKeys(record, ['type', 'key', 'valueType', 'value']) ||
        typeof record.key !== 'string' ||
        record.key.length === 0 ||
        record.key.length > 128 ||
        (record.valueType !== 'number' && record.valueType !== 'boolean' && record.valueType !== 'string') ||
        typeof record.value !== 'string' ||
        record.value.length === 0 ||
        record.value.length > 2000
      ) {
        fail('Invalid proposeDecision message.');
      }
      return {
        type: 'proposeDecision',
        key: record.key as string,
        valueType: record.valueType as 'number' | 'boolean' | 'string',
        value: record.value as string,
      };
    case 'runMissionTask':
      if (
        !hasExactKeys(record, ['type', 'missionId', 'revision']) ||
        typeof record.missionId !== 'string' ||
        !/^mis_[0-9a-f]{24}$/.test(record.missionId) ||
        typeof record.revision !== 'number' ||
        !Number.isInteger(record.revision) ||
        record.revision < 1
      ) {
        fail('Invalid runMissionTask message.');
      }
      return { type: 'runMissionTask', missionId: record.missionId as string, revision: record.revision as number };
    case 'approveMemoryChange':
    case 'rejectMemoryChange':
      if (
        !hasExactKeys(record, ['type', 'actionId', 'digest']) ||
        typeof record.actionId !== 'string' ||
        record.actionId.length === 0 ||
        record.actionId.length > 128 ||
        typeof record.digest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(record.digest)
      ) {
        fail(`Invalid ${record.type} message.`);
      }
      return { type: record.type, actionId: record.actionId as string, digest: record.digest as string };
    case 'selectMemoryProject':
      // Only shape-checked here; the host accepts it only when it is
      // exactly one of the open workspace folders.
      if (
        !hasExactKeys(record, ['type', 'path']) ||
        typeof record.path !== 'string' ||
        record.path.length === 0 ||
        record.path.length > 4096
      ) {
        fail('Invalid selectMemoryProject message.');
      }
      return { type: 'selectMemoryProject', path: record.path as string };
    case 'missionStart':
      if (
        !hasKeysAmong(record, ['type', 'missionId', 'revision', 'mode', 'maxConsultations', 'trustedProject', 'acceptanceCommand', 'acceptanceFiles'], ['requestId', 'advisoryLimits']) ||
        (record.requestId !== undefined && (typeof record.requestId !== 'string' || !REQUEST_ID_PATTERN.test(record.requestId))) ||
        !isChosenLimits(record.advisoryLimits) ||
        typeof record.trustedProject !== 'boolean' ||
        typeof record.acceptanceCommand !== 'string' ||
        record.acceptanceCommand.length > 128 ||
        !Array.isArray(record.acceptanceFiles) ||
        record.acceptanceFiles.length > 20 ||
        (record.acceptanceFiles as unknown[]).some((file) => typeof file !== 'string' || file.length === 0 || file.length > 512) ||
        (record.acceptanceCommand.length > 0) !== ((record.acceptanceFiles as unknown[]).length > 0) ||
        typeof record.missionId !== 'string' ||
        !/^mis_[0-9a-f]{24}$/.test(record.missionId) ||
        typeof record.revision !== 'number' ||
        !Number.isInteger(record.revision) ||
        record.revision < 1 ||
        (record.mode !== 'supervised' && record.mode !== 'autonomous-workspace') ||
        typeof record.maxConsultations !== 'number' ||
        !MISSION_CONSULT_CHOICES.includes(record.maxConsultations)
      ) {
        fail('Invalid missionStart message.');
      }
      return {
        type: 'missionStart',
        missionId: record.missionId as string,
        revision: record.revision as number,
        mode: record.mode as 'supervised' | 'autonomous-workspace',
        maxConsultations: record.maxConsultations as number,
        trustedProject: record.trustedProject as boolean,
        acceptanceCommand: record.acceptanceCommand as string,
        acceptanceFiles: [...(record.acceptanceFiles as string[])],
        ...(typeof record.requestId === 'string' ? { requestId: record.requestId } : {}),
        ...(record.advisoryLimits !== undefined && record.advisoryLimits !== null ? { advisoryLimits: { ...(record.advisoryLimits as ChosenAdvisoryLimits) } } : {}),
      };
    case 'missionResume':
    case 'missionPause':
    case 'missionCancel':
      if (
        !hasExactKeys(record, ['type', 'missionId', 'revision']) ||
        typeof record.missionId !== 'string' ||
        !/^mis_[0-9a-f]{24}$/.test(record.missionId) ||
        typeof record.revision !== 'number' ||
        !Number.isInteger(record.revision) ||
        record.revision < 1
      ) {
        fail(`Invalid ${record.type} message.`);
      }
      return { type: record.type, missionId: record.missionId as string, revision: record.revision as number };
    case 'missionRetry':
      if (
        !hasExactKeys(record, ['type', 'missionId', 'revision', 'guidance']) ||
        typeof record.missionId !== 'string' ||
        !/^mis_[0-9a-f]{24}$/.test(record.missionId) ||
        typeof record.revision !== 'number' ||
        !Number.isInteger(record.revision) ||
        record.revision < 1 ||
        typeof record.guidance !== 'string' ||
        record.guidance.trim().length === 0 ||
        record.guidance.length > 1000
      ) {
        fail('Invalid missionRetry message.');
      }
      return { type: 'missionRetry', missionId: record.missionId as string, revision: record.revision as number, guidance: (record.guidance as string).trim() };
    case 'consultApprove':
      if (!hasExactKeys(record, ['type', 'digest']) || typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) {
        fail('Invalid consultApprove message.');
      }
      return { type: 'consultApprove', digest: record.digest as string };
    case 'consultDismiss':
      if (!hasExactKeys(record, ['type'])) {
        fail('Invalid consultDismiss message.');
      }
      return { type: 'consultDismiss' };
    case 'setLanguage':
      if (!hasExactKeys(record, ['type', 'language']) || !isViewLanguage(record.language)) {
        fail('Invalid setLanguage message.');
      }
      return { type: 'setLanguage', language: record.language as ViewLanguage };
    case 'setMaxOutputTokens':
      if (
        !hasExactKeys(record, ['type', 'local', 'cloud']) ||
        (record.local !== null && (typeof record.local !== 'number' || !Number.isInteger(record.local))) ||
        (record.cloud !== null && (typeof record.cloud !== 'number' || !Number.isInteger(record.cloud)))
      ) {
        fail('Invalid setMaxOutputTokens message.');
      }
      return {
        type: 'setMaxOutputTokens',
        local: record.local as number | null,
        cloud: record.cloud as number | null,
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
  'Chat sends the active thread\u2019s recent history, a bounded host-selected set of relevant older excerpts, and your new message. Other threads are never sent. Older local excerpts are withheld when switching to Meta.';
export const MISSION_SCOPE_NOTICE =
  'Mission sends only your new message to Meta Model API. Earlier thread content is never sent as context.';
export const AGENT_SCOPE_NOTICE =
  'Agent runs a bounded tool loop with the selected provider only (local Glimmer or the selected Meta cloud model, never switched silently). It inspects and changes only the active workspace under the selected permission profile. Arbitrary shell commands run only through the optional terminal tool, OFF by default, each shown before it runs; allowlisted test scripts run with your OS permissions and may access files, network including arbitrary internet, or shells; there is no OS sandbox for them. No computer-wide control or memory safety beyond what is implemented is claimed.';

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
    'It inspects and changes only the active workspace under the selected permission profile. Arbitrary shell commands run only through the optional terminal tool, OFF by default, each shown before it runs; allowlisted test scripts run with your OS permissions and may access files, network including arbitrary internet, or shells; there is no OS sandbox for them. No computer-wide control or memory safety beyond what is implemented is claimed.'
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
  generation: GenerationView;
  memory: MemoryView;
  /** Interface language the view renders in. */
  language: ViewLanguage;
  /** Cascade: the exact text that would be sent to Meta, waiting for the user. */
  consult: ConsultView | null;
  /** The Mission of the open thread, live (phase, progress, controls), if any. */
  missionLive: MissionLiveView | null;
  /** What the current or most recent run was: a Mission plan is never "completed". */
  runKind: RunKind;
  /** Public version and build of this extension. */
  about: AboutView;
  /** Advisory and delegated Meta paths, beyond the exact consult text. */
  remote: RemoteView;
  /** Model evidence for the active thread (modelEvidence.ts), re-validated here. */
  modelEvidence: ModelEvidenceView;
  /** Recovered context for the active thread, by reference and hash (continuityLog.ts). */
  continuityLog: ContinuityLogView;
}

export type RunKind = 'mission-plan' | 'mission-run' | 'other' | null;

export interface AboutView {
  version: string;
  revision: string;
  channel: 'candidate' | 'release';
}

/** The live Mission card of a thread. Every field comes from the host. */
export interface MissionLiveView {
  missionId: string | null;
  revision: number;
  threadId: string;
  goal: string;
  phase: MissionPhase;
  currentTask: string | null;
  tasksDone: number;
  tasksTotal: number;
  internalRun: number;
  step: number | null;
  maxSteps: number;
  /** When the user authorized the Mission, for the elapsed time. */
  startedAt: number | null;
  /** The phase's own end, when it ended (the clock stops there). */
  endedAt: number | null;
  lastProgress: string;
  lastTest: string;
  grant: 'supervised' | 'autonomous-workspace' | null;
  model: string | null;
  acceptance: { commandId: string; files: Array<{ path: string; hash: string }>; state: AcceptanceState; summary: string } | null;
  canStart: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  /** Choices for the start card, only while the Mission can be authorized. */
  setup: {
    testCommands: string[];
    candidates: string[];
    environmentFiles: string[];
    packageJsonHash: string;
    createdFiles: string[];
    /** Empty-project first authorization. */
    bootstrap: boolean;
    /** Scaffold created; a second authorization must review its tests. */
    awaitingVerification: boolean;
    /** Optional independent review; never includes credentials or tool authority. */
    review: MissionAcceptanceReviewView | null;
  } | null;
  /** The last start request of this window and what the host made of it. */
  startRequest: { requestId: string; state: 'authorizing' | 'started' | 'failed'; error: string } | null;
  report: MissionFinalReport | null;
  /** Only for a blocked Mission: why, how far it got, and which tests never ran. */
  blocked: { reason: string; runs: number; lastProgress: string; testsNotRun: string[] } | null;
  /** Mission Advisory consultations and the causal recovery state. */
  remote: MissionRemoteView | null;
  /** The host's record of the Mission, newest last, for "Review". */
  review: string[];
  note: string;
}

export interface ConsultView {
  reason: string;
  payload: string;
  model: string;
  digest: string;
}

function sanitizeConsultView(value: unknown): ConsultView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest) || typeof record.payload !== 'string') {
    return null;
  }
  return {
    reason: typeof record.reason === 'string' ? record.reason.slice(0, 400) : '',
    // Shown whole: it is exactly what would be sent (bounded by the host).
    payload: record.payload.slice(0, 6000),
    model: typeof record.model === 'string' ? record.model.slice(0, 128) : '',
    digest: record.digest,
  };
}

/**
 * Project memory as Settings shows it: decisions in force with version and
 * provenance, their history, bound files with status, and the one exact
 * change waiting for approval. Values are display strings (JSON-encoded).
 */
export interface MemoryView {
  project: string | null;
  readable: boolean;
  decisions: Array<{ key: string; value: string; version: number; source: string; provider: string; createdAt: number }>;
  history: Array<{
    key: string;
    versions: Array<{ version: number; value: string; createdAt: number; source: string; provider: string; reason: string }>;
  }>;
  artifacts: Array<{ path: string; decisionKey: string; decisionVersion: number; status: string; detail: string }>;
  corruptKeys: string[];
  pending: { actionId: string; digest: string; text: string } | null;
  note: string;
  mission: MissionView | null;
  /** Open workspace folders the user can choose from. */
  folders: Array<{ name: string; path: string }>;
  /** The open folder whose memory is shown, if any. */
  selectedPath: string | null;
}

/** The project's latest Mission: goal, tasks, decisions used, evidence. */
export interface MissionView {
  id: string;
  revision: number;
  /** The thread the Mission was planned in (its live card is there). */
  threadId: string;
  goal: string;
  status: string;
  tasks: Array<{ title: string; status: string; runs: number }>;
  current: string | null;
  pendingCount: number;
  decisionsUsed: Array<{ key: string; version: number; currentVersion: number | null }>;
  evidence: string[];
  runsUsed: number;
  maxRuns: number;
  note: string;
  /** Whether "Run task" / "Resume task" is offered now. */
  canRun: boolean;
  resume: boolean;
  /** The Mission grant and the autonomous loop, for the controls. */
  autonomy: {
    grant: 'supervised' | 'autonomous-workspace' | null;
    model: string | null;
    running: boolean;
    internalRuns: number;
    step: number | null;
    maxSteps: number;
    startedAt: number | null;
    lastProgress: string;
    lastTest: string;
    escalation: { used: number; max: number | '∞'; model: string } | null;
    canStart: boolean;
    canResume: boolean;
    canPause: boolean;
    canCancel: boolean;
    cloudEscalationAllowed: boolean;
    /** Allowlisted test commands of the project, for the acceptance choice. */
    testCommands: string[];
    /** The frozen acceptance check of the grant, if any. */
    acceptance: { commandId: string; files: string[] } | null;
  };
}

function sanitizeAutonomy(value: unknown): MissionView['autonomy'] {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const escalation = typeof record.escalation === 'object' && record.escalation !== null ? (record.escalation as Record<string, unknown>) : null;
  const num = (entry: unknown): number => (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 ? entry : 0);
  return {
    grant: record.grant === 'supervised' || record.grant === 'autonomous-workspace' ? record.grant : null,
    model: typeof record.model === 'string' ? record.model.slice(0, 128) : null,
    running: record.running === true,
    internalRuns: num(record.internalRuns),
    step: typeof record.step === 'number' ? record.step : null,
    maxSteps: num(record.maxSteps),
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
    lastProgress: typeof record.lastProgress === 'string' ? record.lastProgress.slice(0, 300) : '',
    lastTest: typeof record.lastTest === 'string' ? record.lastTest.slice(0, 300) : '',
    escalation: escalation === null ? null : { used: num(escalation.used), max: escalation.max === '∞' ? '∞' : num(escalation.max), model: typeof escalation.model === 'string' ? escalation.model.slice(0, 128) : '' },
    canStart: record.canStart === true,
    canResume: record.canResume === true,
    canPause: record.canPause === true,
    canCancel: record.canCancel === true,
    cloudEscalationAllowed: record.cloudEscalationAllowed === true,
    testCommands: Array.isArray(record.testCommands) ? record.testCommands.filter((id): id is string => typeof id === 'string').slice(0, 16).map((id) => id.slice(0, 128)) : [],
    acceptance:
      typeof record.acceptance === 'object' && record.acceptance !== null
        ? {
            commandId: String((record.acceptance as Record<string, unknown>).commandId ?? '').slice(0, 128),
            files: Array.isArray((record.acceptance as Record<string, unknown>).files)
              ? ((record.acceptance as Record<string, unknown>).files as unknown[]).filter((f): f is string => typeof f === 'string').slice(0, 20)
              : [],
          }
        : null,
  };
}

function sanitizeMissionView(value: unknown): MissionView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !/^mis_[0-9a-f]{24}$/.test(record.id)) {
    return null;
  }
  const rows = (entry: unknown): Array<Record<string, unknown>> =>
    Array.isArray(entry)
      ? entry.slice(0, 64).filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      : [];
  return {
    id: record.id,
    revision: count(record.revision),
    threadId: text(record.threadId, 128),
    goal: text(record.goal, 2000),
    status: text(record.status, 24),
    tasks: rows(record.tasks).map((task) => ({ title: text(task.title, 300), status: text(task.status, 16), runs: count(task.runs) })),
    current: typeof record.current === 'string' ? record.current.slice(0, 300) : null,
    pendingCount: count(record.pendingCount),
    decisionsUsed: rows(record.decisionsUsed).map((entry) => ({
      key: text(entry.key, 128),
      version: count(entry.version),
      currentVersion: typeof entry.currentVersion === 'number' ? entry.currentVersion : null,
    })),
    evidence: Array.isArray(record.evidence) ? record.evidence.slice(-20).map((entry) => text(entry, 300)) : [],
    runsUsed: count(record.runsUsed),
    maxRuns: count(record.maxRuns),
    note: text(record.note, 500),
    canRun: record.canRun === true,
    resume: record.resume === true,
    autonomy: sanitizeAutonomy(record.autonomy),
  };
}

export const EMPTY_MEMORY_VIEW: MemoryView = {
  project: null,
  readable: true,
  decisions: [],
  history: [],
  artifacts: [],
  corruptKeys: [],
  pending: null,
  note: '',
  mission: null,
  folders: [],
  selectedPath: null,
};

const MEMORY_VIEW_LIMIT = 256;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Bound and type-check the memory view before it reaches the webview. */
function sanitizeMemoryView(value: unknown): MemoryView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...EMPTY_MEMORY_VIEW };
  }
  const record = value as Record<string, unknown>;
  const list = (entry: unknown): Array<Record<string, unknown>> =>
    Array.isArray(entry)
      ? entry.slice(0, MEMORY_VIEW_LIMIT).filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      : [];
  const pending = record.pending;
  const pendingRecord = typeof pending === 'object' && pending !== null && !Array.isArray(pending) ? (pending as Record<string, unknown>) : null;
  return {
    project: typeof record.project === 'string' ? record.project.slice(0, 128) : null,
    readable: record.readable !== false,
    decisions: list(record.decisions).map((entry) => ({
      key: text(entry.key, 128),
      value: text(entry.value, 2100),
      version: count(entry.version),
      source: text(entry.source, 16),
      provider: text(entry.provider, 16),
      createdAt: count(entry.createdAt),
    })),
    history: list(record.history).map((entry) => ({
      key: text(entry.key, 128),
      versions: list(entry.versions).map((version) => ({
        version: count(version.version),
        value: text(version.value, 2100),
        createdAt: count(version.createdAt),
        source: text(version.source, 16),
        provider: text(version.provider, 16),
        reason: text(version.reason, 300),
      })),
    })),
    artifacts: list(record.artifacts).map((entry) => ({
      path: text(entry.path, 512),
      decisionKey: text(entry.decisionKey, 128),
      decisionVersion: count(entry.decisionVersion),
      status: text(entry.status, 24),
      detail: text(entry.detail, 300),
    })),
    corruptKeys: Array.isArray(record.corruptKeys) ? record.corruptKeys.slice(0, 64).map((key) => text(key, 128)) : [],
    pending:
      pendingRecord !== null &&
      typeof pendingRecord.actionId === 'string' &&
      typeof pendingRecord.digest === 'string' &&
      /^[0-9a-f]{64}$/.test(pendingRecord.digest)
        ? { actionId: pendingRecord.actionId.slice(0, 128), digest: pendingRecord.digest, text: text(pendingRecord.text, 2000) }
        : null,
    note: text(record.note, 300),
    mission: sanitizeMissionView(record.mission),
    folders: list(record.folders)
      .slice(0, 64)
      .filter((entry) => typeof entry.path === 'string' && entry.path.length > 0 && entry.path.length <= 4096)
      .map((entry) => ({ name: text(entry.name, 128), path: entry.path as string })),
    selectedPath: typeof record.selectedPath === 'string' && record.selectedPath.length <= 4096 ? record.selectedPath : null,
  };
}

/**
 * Generation controls for the selected provider/model. Reasoning effort,
 * output budget, and context stay separate fields; none of them is the
 * Agent step budget.
 */
export interface GenerationView {
  provider: ProviderId;
  model: string;
  /** `default` plus only the levels this provider/model accepts. */
  reasoningOptions: string[];
  /** Stored choice when it applies here, else `default`. */
  reasoning: string;
  /** A stored level that does not apply to this provider/model, if any. */
  reasoningUnavailable: string | null;
  reasoningDefault: string;
  /** Request field the level is sent in; null when none is sent. */
  reasoningParam: string | null;
  source: string;
  contextWindow: number | null;
  autoOutputTokens: number;
  maxOutputTokensLocal: number | null;
  maxOutputTokensCloud: number | null;
}

function emptyGenerationView(provider: ProviderId, model: string): GenerationView {
  return {
    provider,
    model,
    reasoningOptions: ['default'],
    reasoning: 'default',
    reasoningUnavailable: null,
    reasoningDefault: 'model-set',
    reasoningParam: null,
    source: 'unknown',
    contextWindow: null,
    autoOutputTokens: 0,
    maxOutputTokensLocal: null,
    maxOutputTokensCloud: null,
  };
}

function sanitizeGenerationView(value: unknown, provider: ProviderId, model: string): GenerationView {
  const fallback = emptyGenerationView(provider, model);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const count = (entry: unknown): number | null =>
    typeof entry === 'number' && Number.isInteger(entry) && entry > 0 ? entry : null;
  const options = Array.isArray(record.reasoningOptions)
    ? ['default', ...REASONING_LEVELS.filter((level) => (record.reasoningOptions as unknown[]).includes(level))]
    : ['default'];
  const reasoning = typeof record.reasoning === 'string' && options.includes(record.reasoning) ? record.reasoning : 'default';
  const text = (entry: unknown, max: number): string | null => (typeof entry === 'string' ? entry.slice(0, max) : null);
  return {
    provider,
    // The id actually sent (for local, the configured model id).
    model: typeof record.model === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(record.model) ? record.model : model,
    reasoningOptions: options,
    reasoning,
    reasoningUnavailable:
      typeof record.reasoningUnavailable === 'string' && isReasoningChoice(record.reasoningUnavailable)
        ? record.reasoningUnavailable
        : null,
    reasoningDefault: text(record.reasoningDefault, 40) ?? 'model-set',
    reasoningParam: text(record.reasoningParam, 80),
    source: text(record.source, 120) ?? 'unknown',
    contextWindow: count(record.contextWindow),
    autoOutputTokens: count(record.autoOutputTokens) ?? 0,
    maxOutputTokensLocal: count(record.maxOutputTokensLocal),
    maxOutputTokensCloud: count(record.maxOutputTokensCloud),
  };
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
  generation?: GenerationView;
  memory?: MemoryView | null;
  language?: ViewLanguage;
  consult?: ConsultView | null;
  missionLive?: MissionLiveView | null;
  runKind?: RunKind;
  about?: AboutView;
  remote?: RemoteView;
  modelEvidence?: ModelEvidenceView;
  continuityLog?: ContinuityLogView;
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
    generation: sanitizeGenerationView(options.generation, provider, model),
    memory: sanitizeMemoryView(options.memory ?? EMPTY_MEMORY_VIEW),
    language: isViewLanguage(options.language) ? options.language : 'en',
    consult: sanitizeConsultView(options.consult ?? null),
    missionLive: sanitizeMissionLive(options.missionLive ?? null),
    runKind: options.runKind === 'mission-plan' || options.runKind === 'mission-run' || options.runKind === 'other' ? options.runKind : null,
    about: sanitizeAbout(options.about),
    remote: sanitizeRemoteView(options.remote),
    modelEvidence: sanitizeEvidenceView(options.modelEvidence),
    continuityLog: sanitizeContinuityLogView(options.continuityLog),
  };
}

const UNKNOWN_ABOUT: AboutView = { version: 'unknown', revision: 'unknown', channel: 'candidate' };

function sanitizeAbout(value: unknown): AboutView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...UNKNOWN_ABOUT };
  }
  const record = value as Record<string, unknown>;
  const field = (entry: unknown): string => (typeof entry === 'string' && /^[0-9A-Za-z.+_-]{1,64}$/.test(entry) ? entry : 'unknown');
  return {
    version: field(record.version),
    revision: field(record.revision),
    // Only an explicit release build says "release".
    channel: record.channel === 'release' ? 'release' : 'candidate',
  };
}

const ACCEPTANCE_STATES: readonly AcceptanceState[] = ['none', 'not_run', 'passed', 'failed', 'inconclusive', 'tampered'];

function sanitizeMissionLive(value: unknown): MissionLiveView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.threadId !== 'string' || !MISSION_PHASES.includes(record.phase as MissionPhase)) {
    return null;
  }
  const strings = (entry: unknown, max: number, each: number): string[] =>
    Array.isArray(entry) ? entry.filter((item): item is string => typeof item === 'string').slice(0, max).map((item) => item.slice(0, each)) : [];
  const object = (entry: unknown): Record<string, unknown> | null =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
  const acceptance = object(record.acceptance);
  const setup = object(record.setup);
  const request = object(record.startRequest);
  const report = object(record.report);
  const time = (entry: unknown): number | null => (typeof entry === 'number' && Number.isFinite(entry) && entry > 0 ? entry : null);
  return {
    missionId: typeof record.missionId === 'string' && /^mis_[0-9a-f]{24}$/.test(record.missionId) ? record.missionId : null,
    revision: count(record.revision),
    threadId: record.threadId.slice(0, 128),
    goal: text(record.goal, 2000),
    phase: record.phase as MissionPhase,
    currentTask: typeof record.currentTask === 'string' ? record.currentTask.slice(0, 300) : null,
    tasksDone: count(record.tasksDone),
    tasksTotal: count(record.tasksTotal),
    internalRun: count(record.internalRun),
    step: typeof record.step === 'number' && Number.isInteger(record.step) && record.step > 0 ? record.step : null,
    maxSteps: count(record.maxSteps),
    startedAt: time(record.startedAt),
    endedAt: time(record.endedAt),
    lastProgress: text(record.lastProgress, 300),
    lastTest: text(record.lastTest, 300),
    grant: record.grant === 'supervised' || record.grant === 'autonomous-workspace' ? record.grant : null,
    model: typeof record.model === 'string' ? record.model.slice(0, 128) : null,
    acceptance:
      acceptance === null
        ? null
        : {
            commandId: text(acceptance.commandId, 128),
            files: (Array.isArray(acceptance.files) ? acceptance.files : [])
              .map(object)
              .filter((file): file is Record<string, unknown> => file !== null)
              .slice(0, 24)
              .map((file) => ({ path: text(file.path, 512), hash: text(file.hash, 64) })),
            state: ACCEPTANCE_STATES.includes(acceptance.state as AcceptanceState) ? (acceptance.state as AcceptanceState) : 'not_run',
            summary: text(acceptance.summary, 300),
          },
    canStart: record.canStart === true,
    canPause: record.canPause === true,
    canResume: record.canResume === true,
    canCancel: record.canCancel === true,
    setup:
      setup === null
        ? null
        : {
            testCommands: strings(setup.testCommands, 16, 128),
            candidates: strings(setup.candidates, 80, 512),
            environmentFiles: strings(setup.environmentFiles, 8, 64),
            packageJsonHash: text(setup.packageJsonHash, 64),
            createdFiles: strings(setup.createdFiles, 24, 512),
            bootstrap: setup.bootstrap === true,
            awaitingVerification: setup.awaitingVerification === true,
            review: sanitizeMissionAcceptanceReviewView(setup.review),
          },
    startRequest:
      request === null || typeof request.requestId !== 'string' || !['authorizing', 'started', 'failed'].includes(request.state as string)
        ? null
        : { requestId: request.requestId.slice(0, 48), state: request.state as 'authorizing' | 'started' | 'failed', error: text(request.error, 300) },
    report:
      report === null
        ? null
        : {
            tasks: strings(report.tasks, 20, 300),
            files: strings(report.files, 12, 300),
            tests: strings(report.tests, 12, 300),
            acceptance: text(report.acceptance, 600),
            internalRuns: count(report.internalRuns),
            minutes: count(report.minutes),
            models: strings(report.models, 4, 200),
            metaConsultations: text(report.metaConsultations, 200),
            isolation: strings(report.isolation, 4, 300),
          },
    blocked:
      object(record.blocked) === null
        ? null
        : {
            reason: text((record.blocked as Record<string, unknown>).reason, 500),
            runs: count((record.blocked as Record<string, unknown>).runs),
            lastProgress: text((record.blocked as Record<string, unknown>).lastProgress, 300),
            testsNotRun: strings((record.blocked as Record<string, unknown>).testsNotRun, 16, 128),
          },
    review: strings(record.review, 40, 300),
    remote: sanitizeMissionRemote(record.remote),
    note: text(record.note, 500),
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
    idleTimeoutSec: 900,
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
    idleTimeoutSec: num('idleTimeoutSec', 900),
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
  // This computer or a private-network server the user chose (see localServers.ts).
  return isLocalOrPrivateUrl(url.toString()) ? trimmed.slice(0, 128) : 'http://127.0.0.1:8775';
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
