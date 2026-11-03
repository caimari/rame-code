/**
 * Extension-host side of the single `RAME Code` webview view.
 *
 * Key-handling contract:
 * - The key is read from `vscode.SecretStorage` at call time and never
 *   leaves the extension host except inside the Meta HTTPS request.
 * - The webview receives only the boolean `hasKey` flag.
 * - Errors are redacted before display; the key never appears in HTML,
 *   postMessage state, logs, diagnostics, tests, or persisted data.
 *
 * Transcript contract (release-blocking: the submitted user turn and the
 * returned assistant result must both be visible immediately):
 * - The user turn is persisted and posted BEFORE the network call.
 * - The assistant/plan/error turn is persisted and posted right after.
 * - Internal Chat <-> Settings navigation flips only the screen flag;
 *   threads, selection, and running state are preserved.
 *
 * Local-runtime contract:
 * - The executable is spawned directly with an argument array and
 *   `shell: false`, bound to `127.0.0.1` only.
 * - Only the owned child is ever stopped (tracked handle); an external
 *   endpoint is never owned and never killed.
 */

import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { AgentAuditLog } from './agentAudit.js';
import {
  computeActionDigest,
  createPendingAction,
  MISSING_FILE_PRECONDITION,
  verifyApproval,
  type PendingAgentAction,
} from './agentApproval.js';
import {
  boundRunTestsStillMatches,
  buildTestSpawnSpec,
  derivedNpmScriptName,
  describeBoundRunTestsAction,
  findAllowedCommand,
  isDerivedNpmTestCommand,
  resolveTestInvocation,
  type AllowedTestCommand,
} from './agentCommands.js';
import {
  describeAgentCall,
  executeCreateDirectory,
  executeDeleteFile,
  executeFilesystemUsage,
  executeInspectWorkspace,
  executeListFiles,
  executeMoveFile,
  executeReadFile,
  executeSearchText,
  executeSetExecutable,
  guardFsPath,
  policyGateForCall,
  REGEX_SEARCH_TIMEOUT_MESSAGE,
  WINDOWS_SET_EXECUTABLE_ERROR,
  resolveCanonicalRoot,
  type AgentFs,
} from './agentHost.js';
import { AgentRunner, buildAgentMessages } from './agentLoop.js';
import {
  AgentOutputTruncatedError,
  LocalMalformedToolCallError,
  assertAgentModelForProvider,
  buildAgentSystemPrompt,
  isAgentToolProtocolError,
  type AgentCompletion,
  type AgentChatMessage,
} from './agentModel.js';
import { applyPatchAtomically, hashContent } from './agentPatch.js';
import { formatProcessResult, runBoundedProcess } from './agentProcess.js';
import {
  assistantHistoryText,
  MAX_HOST_RECORD_LINE_LENGTH,
  MAX_HOST_RECORD_LINES,
  NO_HOST_ACTIONS_LINE,
  sanitizeAgentReply,
} from './hostRecord.js';
import {
  MAX_AGENT_STEPS,
  MAX_TEST_OUTPUT_BYTES,
  checkAgentRelPath,
  isWithinRoot,
  resolveSingleWorkspaceRoot,
} from './agentPolicy.js';
import {
  AGENT_BOUNDARIES_TEXT,
  DEFAULT_AGENT_PROFILE,
  describeAgentProfile,
  isAgentProfileId,
  isAutoAllowed,
  parseAgentProfile,
  type AgentProfileId,
} from './agentProfiles.js';
import {
  buildAgentToolDefinitions,
  buildMemoryToolDefinitions,
  parseDecisionValueText,
  truncateToolOutput,
  type DecisionValueType,
  type ReplaceInFileArgs,
  type ValidatedToolCall,
} from './agentTools.js';
import {
  DecisionStore,
  describeProposal,
  scopeIdForRoot,
  type MemoryAuthorization,
  type MemoryProposal,
} from './decisionStore.js';
import { SharedJsonFileBackend } from './sharedStateFile.js';
import { checkUserStatement } from './decisionSource.js';
import {
  buildConsultPayload,
  buildVerificationPrompt,
  formatAdvisory,
  cascadeAdviceSchema,
  consultDigest,
  CONSULT_OFFER_TTL_MS,
  validateCascadeAdvice,
  type CascadeAdvice,
  type LocalStopKind,
} from './cascade.js';
import {
  MissionStore,
  MAX_NO_PROGRESS_RUNS,
  assessRun,
  blockMission,
  filesReadInMission,
  frozenPaths,
  MAX_USER_GUIDANCE,
  recordAcceptance,
  buildAutoTaskPrompt,
  buildTaskPrompt,
  canRunTask,
  cancelMission,
  completeTask,
  currentTask,
  grantAllows,
  grantMission,
  interrupt,
  journalAction,
  leaseHeldByOther,
  pauseMission,
  recordRun,
  setWaiting,
  startTaskRun,
  uncertainActions,
  type MissionGrant,
  type MissionLease,
  type MissionRecord,
  type MissionResult,
  type RunAssessment,
  type RunObservation,
} from './missionStore.js';
import {
  MISSION_CONSULT_OUTPUT_TOKENS,
  isLiveMissionLease,
  registerLiveMissionLease,
  unregisterLiveMissionLease,
} from './missionRuntime.js';
import { buildMissionReportEntry } from './missionReport.js';
import {
  buildMissionLiveView,
  buildMissionView,
  buildPlanningMissionLiveView,
  type MissionViewRuntime,
} from './missionViews.js';
import { LocalAgentModelProvider, MetaAgentModelProvider } from './modelProviders/agentProvider.js';
import {
  ACCEPTANCE_ENVIRONMENT_FILES,
  listAcceptanceCandidates,
  npmTestContext,
} from './projectAdapters/npmProjectAdapter.js';
import { createVscodeWorkspaceFs } from './projectAdapters/vscodeWorkspaceFs.js';
import {
  REPLACE_NOT_FOUND_MESSAGE,
  REPLACE_NOT_UNIQUE_MESSAGE,
  isRecoverableAgentToolError,
  summarizeToolResult,
} from './toolResultSummary.js';
import {
  MEMORY_RULES_TEXT,
  buildMemorySnapshot,
  memoryPreconditionKey,
  memoryPreconditionValue,
  parseMemoryPreconditionKey,
} from './projectMemory.js';
import { withBoundedRequest } from './boundedRequest.js';
import { ChatRunner } from './chatRunner.js';
import {
  GenerationContextError,
  REASONING_LABELS,
  UNKNOWN_LOCAL_PROPS,
  automaticOutputTokens,
  cloudGenerationProfile,
  describeBudgetLimit,
  estimatePromptTokens,
  isReasoningChoice,
  localGenerationProfile,
  parseLlamaServerProps,
  parseManualMaxOutput,
  resolveOutputBudget,
  resolveReasoning,
  withReasoningChoice,
  type GenerationProviderId,
  type GenerationRequest,
  type LocalServerProps,
  type ModelGenerationProfile,
  type ReasoningLevel,
} from './generationSettings.js';
import { createLocalChatCompletion, createLocalMissionPlan } from './localProvider.js';
import {
  isLoopbackUrl,
  loopbackEndpoint,
  nextLocalRuntimeStatus,
  validateLocalSettings,
  type LocalRuntimeStatus,
} from './localRuntime.js';
import { LocalRuntimeManager } from './localRuntimeManager.js';
import {
  CLOUD_MODEL_FALLBACK,
  fallbackCatalog,
  refreshCompatibleModels,
  validateCloudModelSelection,
  type CloudModelInfo,
} from './metaCatalog.js';
import { createCascadeAdvice, createChatCompletion, missionPlanSchema, validateMissionPlan } from './meta-provider.js';
import { MissionRunner } from './missionRunner.js';
import { DEFAULT_CHAT_MODE, isSupportedMode } from './modes.js';
import {
  buildWorkspacePickItems,
  normalizeOpenFolders,
  NO_WORKSPACE_MESSAGE,
  validateChosenWorkspace,
  workspaceDisplayLabel,
  WORKSPACE_PICK_CANCELLED,
  type OpenWorkspaceFolder,
} from './workspaceSelect.js';
import { buildRequestMessages } from './requestBuilder.js';
import {
  defaultSettings,
  defaultUsageTotals,
  parseRuntimeId,
  providerToRuntime,
  RAME_AUDIT_KEY,
  RAME_SETTINGS_KEY,
  RAME_USAGE_KEY,
  runtimeToModel,
  runtimeToProvider,
  suggestedLocalSettings,
  validateSettings,
  validateUsageTotals,
  type ProviderId,
  type RameSettings,
  type RuntimeId,
  type UsageTotals,
  type ViewLanguage,
} from './settingsStore.js';
import {
  appendErrorTurn,
  appendPlanTurn,
  appendAssistantTurn,
  appendUserTurn,
  userWrittenTexts,
  fitTurnText,
  MAX_ASSISTANT_TEXT_LENGTH,
  ThreadStore,
  type ChatThread,
} from './threadStore.js';
import { addUsage, EMPTY_USAGE, type ProviderUsage } from './usage.js';
import {
  buildViewStateMessage,
  localUnreachableMessage,
  type AboutView,
  type EscalationState,
  type GenerationView,
  type MemoryView,
  type MissionLiveView,
  type MissionView,
  type RunKind,
  type ViewConnection,
  type ViewScreen,
} from './viewMessages.js';
import { readBuildInfo } from './buildInfo.js';
import { parseViewInboundMessage } from './viewMessages.js';
import { buildViewHtml, createViewNonce } from './viewHtml.js';
import {
  redactKeyFromText,
  validateApiKeyInput,
  validateGoalInput,
} from './webviewMessages.js';
import { formatPlanAsText } from './panelState.js';
import type { MissionPlan } from './types.js';

export const API_KEY_SECRET = 'rameCode.metaModelApiKey';

export const MAIN_VIEW_ID = 'rameCode.main';

/** Non-secret marker of the run in flight: `{ threadId, pid, startedAt }`. */
export const RAME_ACTIVE_RUN_KEY = 'rameCode.activeRun.v1';

const INTERRUPTED_RUN_NOTE =
  'This run was interrupted because VS Code reloaded or closed before it finished. Its outcome was not recorded; check the workspace before retrying.';

interface PendingEscalation {
  threadId: string;
  text: string;
  mode: string;
}

type AgentDecision =
  | { kind: 'approve' }
  | { kind: 'reject' }
  | { kind: 'cancelled' }
  | { kind: 'stale'; reason: string };

const APPROVAL_PREVIEW_CHARS = 2000;
/** The model is told to wrap up when this many steps of the budget remain. */
const AGENT_STEPS_WARNING_REMAINING = 2;
/** Mission runs: with this many steps left and nothing changed, the host says to act now. */
const MISSION_LOW_BUDGET_STEPS = 4;
/** Read-only tools whose identical repeats in one Mission run are flagged. */
const MISSION_REPEAT_CHECK_TOOLS = new Set(['list_files', 'inspect_workspace', 'filesystem_usage', 'search_text', 'read_file']);
/** Bound for reading the local server's `/props` (loopback only). */
const LOCAL_PROPS_TIMEOUT_MS = 3000;
/** Thread id recorded for changes the user makes in Settings. */
const SETTINGS_MEMORY_THREAD = 'settings';
/** Tools whose success changes workspace files (voids earlier test evidence). */
const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'replace_in_file', 'create_directory', 'move_file', 'delete_file', 'set_executable']);
/** Earlier thread messages longer than this are shortened with a visible marker. */
const AGENT_HISTORY_TEXT_LIMIT = 4000;

/**
 * Generation parameters fixed when a run starts, so changing a setting
 * while a request is in flight never alters that run.
 */
interface RunGeneration {
  provider: GenerationProviderId;
  model: string;
  profile: ModelGenerationProfile;
  reasoning: ReasoningLevel | null;
  manualMax: number | null;
  /** Visible notes about choices that could not be applied as stored. */
  notes: string[];
}

/** Plain reason when a decision moved on since its approval card was shown. */
function memoryDrift(pending: PendingAgentAction, currentHashes: Record<string, string>): string | null {
  for (const [key, expected] of Object.entries(pending.preconditions)) {
    const parsed = parseMemoryPreconditionKey(key);
    if (parsed !== null && currentHashes[key] !== expected) {
      return `${parsed.key} changed since this proposal was shown, so nothing was written; propose it again from the current version.`;
    }
  }
  return null;
}

/** The more restrictive of the chosen profile and a temporary cap. */
function capProfile(profile: AgentProfileId, cap: AgentProfileId | null): AgentProfileId {
  if (cap === null) {
    return profile;
  }
  const order: AgentProfileId[] = ['ask', 'safe-auto', 'workspace-full'];
  return order.indexOf(cap) < order.indexOf(profile) ? cap : profile;
}

function withNote(status: string, note: string | null): string {
  return note === null ? status : `${status} ${note}`;
}

/** Shorten earlier thread text with a marker instead of cutting it silently. */
function historyText(text: string): string {
  if (text.length <= AGENT_HISTORY_TEXT_LIMIT) {
    return text;
  }
  return (
    `${text.slice(0, AGENT_HISTORY_TEXT_LIMIT)}\n` +
    `…[RAME Code shortened this earlier message: ${text.length - AGENT_HISTORY_TEXT_LIMIT} characters left out]`
  );
}

export class RameCodeViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private screen: ViewScreen = 'chat';
  private hasKey = false;
  private running = false;
  private status = 'Starting…';
  private connection: ViewConnection = 'missing-key';
  private settings: RameSettings = defaultSettings();
  private usage: UsageTotals = defaultUsageTotals();
  private usageLast: ProviderUsage = { ...EMPTY_USAGE };
  private cloudCatalog: CloudModelInfo[] = fallbackCatalog();
  private localSettingsRev = 1;
  private readonly localRuntime = new LocalRuntimeManager({
    publish: async (status, message) => {
      this.localRuntime.replaceStatus(status);
      this.status = message;
      await this.postState();
    },
    probe: async (endpoint) => { await this.probeLocalProps(endpoint); },
    isBusy: () => this.isBusy(),
    idleTimeoutSeconds: () => this.settings.local.idleTimeoutSec,
  });
  private escalation: EscalationState = { pending: false, reason: '' };
  private pendingRequest: PendingEscalation | null = null;
  private activeThreadId: string | null = null;
  private disposed = false;
  private readonly agentRunner = new AgentRunner();
  private readonly audit = new AgentAuditLog();
  private agentPending: PendingAgentAction | null = null;
  private agentGeneration = 0;
  private agentWaiter: {
    resolve: (choice: AgentDecision) => void;
  } | null = null;
  private agentLogView: Array<{
    tool: string;
    digest: string;
    decision: string;
    result: string;
  }> = [];
  private agentRunWorkspace: { root: string; label: string } | null = null;
  /**
   * Thread of the current (or most recent) run in this session. Approvals
   * bind to it rather than to whichever thread the user is viewing, and the
   * Activity/approval cards are shown only in it.
   */
  private runThreadId: string | null = null;
  /** Last `/props` reading of the local server, tied to its endpoint. */
  private localProps: { endpoint: string; props: LocalServerProps } | null = null;
  /** Host-controlled project memory; the model can only read and propose. */
  private readonly memory: DecisionStore;
  /** A change the user proposed in Settings, waiting for its approval card. */
  private memoryPending: { action: PendingAgentAction; proposal: MemoryProposal } | null = null;
  /** Bumped by cancellation so an old Settings approval card can never commit. */
  private memoryGeneration = 0;
  /** Last computed memory view (refreshed at explicit points, not per status). */
  private memoryView: MemoryView | null = null;
  /**
   * The project Settings memory acts on: the open folder the user chose in
   * Settings, or the folder of the latest Agent run. Always one of the open
   * workspace folders when used.
   */
  private memoryRoot: string | null = null;
  /**
   * While a Mission task or a cascade verification runs, its Agent run
   * targets that project, never another open folder and without a prompt.
   */
  private pinnedRunRoot: string | null = null;
  /** A consultation the user may approve: the exact payload and its digest. */
  private consultOffer: {
    threadId: string;
    root: string;
    task: string;
    reason: string;
    payload: string;
    model: string;
    digest: string;
    createdAt: number;
    generation: number;
  } | null = null;
  /** Set while the local verification run of a cascade runs (no nested offers). */
  private cascadeVerification: { threadId: string } | null = null;
  /** The Mission task prompt being sent: stored as host-written, not as the user's words. */
  private hostPromptText: string | null = null;
  /** Persistent Missions; each task run is started by the user. */
  private readonly missions: MissionStore;
  private missionRecovery: Promise<number> = Promise.resolve(0);
  /** The Mission whose task the current Agent run works on, if any. */
  private activeMission: { id: string; revision: number } | null = null;
  /** A resumed Mission task never runs writes without approval. */
  private missionProfileCap: AgentProfileId | null = null;
  private missionUpdates: Promise<void> = Promise.resolve();
  /** Outcome of the latest Agent run, read by the Mission runner. */
  private lastAgentOutcome: {
    threadId: string;
    outcome: string;
    hostRecord: string[];
    report: string;
    lastTest?: { commandId: string; exitCode: number | null } | null;
    /** Files the run wrote, with their hash after the run (null = missing). */
    writes?: Array<{ path: string; hash: string | null }>;
    wroteAfterLastTest?: boolean;
    capabilityReason?: string | null;
    /** Read-only calls of the run that returned exactly what an earlier call had. */
    repeatedReads?: number;
  } | null = null;
  /** Model step of the current Agent run, for the Mission view. */
  private agentStepNow: number | null = null;
  /** The autonomous Mission loop this window drives, and a pending pause/cancel. */
  private missionAuto: { missionId: string; stop: 'pause' | 'cancel' | null; holdAutonomy: boolean } | null = null;
  /** Allowlisted test commands of the Settings project, refreshed with the memory view. */
  private missionTestCommands: string[] = [];
  /** Choices for the Mission start card of the Settings project, refreshed with the memory view. */
  private missionSetup: { scopeId: string; testCommands: string[]; candidates: string[]; environmentFiles: string[]; packageJsonHash: string } | null = null;
  /**
   * The last "Authorize and start" of this window, so a click is confirmed,
   * a second click is not a second start, and a rebuilt view sees it.
   */
  private missionStartRequest: { requestId: string; missionId: string; state: 'authorizing' | 'started' | 'failed'; error: string } | null = null;
  /** A Mission this window is starting or resuming, before its loop holds the lease. */
  private missionStarting: string | null = null;
  /** What the current or most recent run was, for the view's wording. */
  private runKind: RunKind = null;
  /** Public version and build of this extension (from out/build-info.json). */
  private readonly about: AboutView;
  /** The host's own acceptance run, stoppable by pause or cancel. */
  private acceptanceController: AbortController | null = null;
  /** This window's identity for Mission leases. */
  private readonly leaseToken = randomBytes(12).toString('hex');

  private get local(): LocalRuntimeStatus {
    return this.localRuntime.status;
  }

  private set local(status: LocalRuntimeStatus) {
    this.localRuntime.replaceStatus(status);
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly missionRunner: MissionRunner,
    private readonly chatRunner: ChatRunner,
    private readonly store: ThreadStore,
    private readonly state: {
      get(key: string): unknown;
      update(key: string, value: unknown): unknown;
    },
    private readonly output: vscode.OutputChannel,
    /**
     * Folder for memory and Missions shared by every window of this machine.
     * Without it (tests) they use this provider's state, one window only.
     */
    sharedStateDir?: string,
  ) {
    const backend = sharedStateDir
      ? new SharedJsonFileBackend(sharedStateDir)
      : {
          get: (key: string) => this.state.get(key),
          update: async (key: string, value: unknown) => {
            await this.state.update(key, value);
          },
        };
    this.memory = new DecisionStore(backend);
    this.missions = new MissionStore(backend);
    this.about = readBuildInfo(this.extensionUri.fsPath);
    this.settings = validateSettings(this.state.get(RAME_SETTINGS_KEY));
    this.settings = this.reconcileCloudModel(this.settings, this.cloudCatalog);
    this.usage = validateUsageTotals(this.state.get(RAME_USAGE_KEY));
    // The durable audit is loaded for appending only: entries from earlier
    // sessions are never shown as the current run's Activity.
    this.audit.load(this.state.get(RAME_AUDIT_KEY));
    const runningElsewhere = this.recoverInterruptedRun();
    if (!runningElsewhere) {
      // A Mission task run that was in flight is gone: mark it interrupted.
      // Nothing is re-run; the user decides when to resume.
      this.missionRecovery = this.missions.recoverInterrupted((lease) => this.isLeaseAlive(lease));
    }
  }

  /**
   * A run marker left by an extension host that is gone (reload, crash,
   * window close) means its thread never received an outcome: record that
   * explicitly. A marker owned by another live window is left alone.
   */
  /** Returns true when another live window owns the current run marker. */
  private recoverInterruptedRun(): boolean {
    const raw = this.state.get(RAME_ACTIVE_RUN_KEY);
    if (raw === undefined || raw === null) {
      return false;
    }
    const record = typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const threadId = typeof record.threadId === 'string' ? record.threadId : null;
    const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : null;
    if (pid !== null && pid !== process.pid && isProcessAlive(pid)) {
      return true;
    }
    void this.state.update(RAME_ACTIVE_RUN_KEY, undefined);
    const thread = threadId !== null ? this.store.get(threadId) : undefined;
    const lastTurn = thread?.turns[thread.turns.length - 1];
    if (thread && lastTurn?.kind === 'user') {
      this.store.save(appendErrorTurn(thread, INTERRUPTED_RUN_NOTE));
    }
    return false;
  }

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = view;

    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    const nonce = createViewNonce();
    view.webview.html = buildViewHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'))
        .toString(),
      styleUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'))
        .toString(),
      i18nUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'i18n.js'))
        .toString(),
      nonce,
    });

    const messageHandler = view.webview.onDidReceiveMessage((raw: unknown) => {
      void this.handleMessage(raw);
    });
    const disposeHandler = view.onDidDispose(() => {
      this.view = undefined;
      vscode.Disposable.from(...this.disposables).dispose();
      this.disposables.length = 0;
    });
    this.disposables.push(messageHandler, disposeHandler);

    void this.refreshAll();
  }

  dispose(): void {
    this.disposed = true;
    // Abort any run (model call, approval wait, test process tree) so a
    // reload never leaves owned work behind.
    this.cancelRequest();
    // This window no longer drives a Mission: its lease is no longer alive.
    unregisterLiveMissionLease(this.leaseToken);
    this.localRuntime.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
    this.view = undefined;
  }

  /** Selected cloud model, validated with safe fallback (never arbitrary). */
  selectedCloudModel(): string {
    return validateCloudModelSelection(this.settings.cloudModel, this.cloudCatalog);
  }

  private reconcileCloudModel(
    settings: RameSettings,
    catalog: CloudModelInfo[],
  ): RameSettings {
    const valid = validateCloudModelSelection(settings.cloudModel, catalog);
    const model = settings.provider === 'local' ? 'local-glimmer' : valid;
    if (valid === settings.cloudModel && model === settings.model) {
      return settings;
    }
    return { ...settings, cloudModel: valid, model };
  }

  /** Reload persisted threads/settings/usage and the key flag. */
  async refreshAll(): Promise<void> {
    this.store.load();
    this.settings = validateSettings(this.state.get(RAME_SETTINGS_KEY));
    this.settings = this.reconcileCloudModel(this.settings, this.cloudCatalog);
    this.localSettingsRev += 1;
    this.usage = validateUsageTotals(this.state.get(RAME_USAGE_KEY));
    const stored = await this.secrets.get(API_KEY_SECRET);
    this.hasKey = stored !== undefined;
    this.connection = this.running
      ? 'working'
      : this.hasKey || this.local.endpoint !== null
        ? 'ready'
        : 'missing-key';
    this.ensureActiveThreadStillExists();
    // Reading /props never starts a runtime: it only asks an endpoint that is
    // already running or explicitly selected.
    const endpoint = this.settings.provider === 'local' && !this.running ? this.localEndpoint() : null;
    if (endpoint !== null) {
      await this.probeLocalProps(endpoint);
    }
    await this.refreshMemoryView();
    await this.postState();
  }

  /** Re-read SecretStorage and publish the key-free `hasKey` flag. */
  async refreshHasKey(): Promise<void> {
    const stored = await this.secrets.get(API_KEY_SECRET);
    this.hasKey = stored !== undefined;
    if (!this.running) {
      this.connection = this.hasKey ? 'ready' : 'missing-key';
    }
    await this.postState();
  }

  /** Start an empty thread: selection clears; storage happens on send. */
  async newThread(): Promise<void> {
    this.activeThreadId = null;
    // A new thread never inherits an ambiguous target: clear the last run
    // display so the next Agent send re-asks when several folders are open.
    this.agentRunWorkspace = null;
    // Default mode for every new thread is Agent; persisted history is
    // untouched (only the composer default resets).
    if (!this.running) {
      this.status = 'New Agent thread started. Type a message below.';
    }
    if (this.settings.mode !== DEFAULT_CHAT_MODE) {
      this.settings = { ...this.settings, mode: DEFAULT_CHAT_MODE };
      this.persistSettings();
    }
    await this.postState();
  }

  /** Select an existing thread for display. */
  async openThread(threadId: string): Promise<void> {
    const thread = this.store.get(threadId);
    if (!thread) {
      this.status = 'That thread is no longer stored.';
      await this.postState();
      return;
    }
    this.activeThreadId = thread.id;
    this.status = `Opened “${thread.title}”.`;
    await this.postState();
  }

  /** Delete one user-confirmed thread. Running work is never deleted. */
  async deleteThread(threadId: string): Promise<void> {
    if (this.running || this.agentRunner.isRunning) {
      this.status = 'Stop the current run before deleting its thread.';
      await this.postState();
      return;
    }
    const deleted = this.store.delete(threadId);
    if (deleted && this.activeThreadId === threadId) {
      this.activeThreadId = null;
      this.agentRunWorkspace = null;
    }
    this.status = deleted ? 'Thread deleted.' : 'That thread is no longer stored.';
    await this.postState();
  }

  /**
   * Return to the thread-list home screen: clear the active selection only.
   * Thread data is never deleted here; Settings navigation state is kept.
   */
  async backToList(): Promise<void> {
    this.activeThreadId = null;
    this.agentRunWorkspace = null;
    if (!this.running) {
      this.status = 'Showing thread list.';
    }
    await this.postState();
  }

  /** Internal navigation: flip the screen flag only; state is preserved. */
  async navigate(screen: ViewScreen): Promise<void> {
    this.screen = screen;
    if (screen === 'settings') {
      await this.refreshMemoryView();
    }
    await this.postState();
  }

  /**
   * Submit one composer message through the selected provider/mode.
   * The user turn is persisted and posted before the network call so the
   * transcript always shows it immediately.
   */
  async sendMessage(
    rawText: string,
    rawMode: string,
    rawRuntime: string,
  ): Promise<void> {
    if (
      this.running ||
      this.missionRunner.isRunning ||
      this.chatRunner.isRunning ||
      this.agentRunner.isRunning
    ) {
      this.status =
        'A request is already running. Cancel it before sending another.';
      await this.postState();
      return;
    }
    if (!isSupportedMode(rawMode)) {
      this.status = 'Unknown mode. Choose Chat, Mission, or Agent.';
      await this.postState();
      return;
    }
    const runtime: RuntimeId | null = parseRuntimeId(rawRuntime);
    if (runtime === null) {
      this.status = 'Unknown runtime. Choose a runtime in Settings.';
      await this.postState();
      return;
    }
    const provider: ProviderId = runtimeToProvider(runtime);
    const model: string = runtimeToModel(runtime, this.selectedCloudModel());
    const text = rawText.trim();
    if (text.length === 0 || text.length > 8000) {
      this.status = 'Type a message first.';
      await this.postState();
      return;
    }
    if (rawMode === 'mission') {
      const checked = validateGoalInput(text);
      if (!checked.ok || checked.goal === undefined) {
        this.status = checked.error ?? 'The message is invalid.';
        await this.postState();
        return;
      }
    }

    // Provider preflight happens before settings or thread persistence. A
    // stopped local runtime must never create a failed conversation.
    if (provider === 'local') {
      const ownedReady =
        this.local.lifecycle === 'running' && this.local.endpoint !== null;
      const externalReady =
        this.settings.externalLocalEndpoint.trim().length > 0 &&
        isLoopbackUrl(this.settings.externalLocalEndpoint);
      if (!ownedReady && !externalReady) {
        this.connection = 'error';
        this.status =
          this.local.lifecycle === 'starting'
            ? 'Muse Glimmer is still starting. Wait for Running before sending.'
            : 'The local model is not running. Start Muse Glimmer, choose Meta Model API, or configure an external OpenAI-compatible loopback server.';
        await this.postState();
        return;
      }
    } else {
      const stored = await this.secrets.get(API_KEY_SECRET);
      if (!stored) {
        this.hasKey = false;
        this.connection = 'missing-key';
        this.status = 'No Meta Model API key is stored. Save one in Settings or choose a local runtime.';
        await this.postState();
        return;
      }
    }

    // Agent workspace preflight also happens before any persistence: a
    // cancelled folder pick or a missing folder never creates a thread.
    let agentTarget: { root: string; label: string } | undefined;
    if (rawMode === 'agent') {
      this.running = true;
      this.connection = 'working';
      this.status = 'Choose the workspace folder for this Agent run…';
      await this.postState();
      const target = await this.resolveAgentRunRoot();
      if (!this.running) {
        // Cancelled while the folder picker was open: nothing starts.
        return;
      }
      if (!target.ok) {
        this.running = false;
        this.connection = target.cancelled ? 'cancelled' : 'error';
        this.status = target.error;
        await this.postState();
        if (!target.cancelled) {
          await this.offerOpenFolderAction();
        }
        return;
      }
      agentTarget = { root: target.root, label: target.label };
    }

    // Remember the validated runtime + mode (non-secret). The model is
    // always the exact pair for the runtime, so no mismatch can persist.
    this.settings = {
      ...this.settings,
      provider,
      mode: rawMode,
      model,
    };
    this.persistSettings();

    // Persist the user turn BEFORE the network call so it renders at once.
    let thread = this.activeThreadId !== null
      ? this.store.get(this.activeThreadId)
      : undefined;
    if (!thread) {
      thread = this.store.create(text, rawMode);
      this.activeThreadId = thread.id;
    } else {
      thread = appendUserTurn(thread, text, undefined, { host: this.hostPromptText === text, mode: rawMode });
      this.store.save(thread);
    }
    const threadId = thread.id;

    await this.executeSend(threadId, text, rawMode, provider, agentTarget);
  }

  /**
   * Run one provider call for an already-persisted user turn. Split from
   * {@link sendMessage} so an approved escalation reuses the pending turn
   * instead of appending the same text a second time.
   */
  private async executeSend(
    threadId: string,
    text: string,
    mode: string,
    provider: ProviderId,
    agentTarget?: { root: string; label: string },
  ): Promise<void> {
    // The visible Activity section is scoped to this execution. The durable
    // audit remains append-only in extension state, but actions from older
    // runs must not be presented as if they belonged to the current request.
    this.agentLogView = [];
    this.runThreadId = threadId;
    this.runKind = this.missionAuto !== null || this.activeMission !== null ? 'mission-run' : mode === 'mission' ? 'mission-plan' : 'other';
    // Durable marker: if the extension host goes away mid-run, the next
    // activation records the interruption instead of leaving the thread
    // looking unanswered.
    void this.state.update(RAME_ACTIVE_RUN_KEY, { threadId, pid: process.pid, startedAt: Date.now() });
    this.running = true;
    this.connection = 'working';
    this.status =
      provider === 'cloud'
        ? `Working with ${this.selectedCloudModel()}…`
        : 'Working with the local runtime…';
    await this.postState();

    let generationNote: string | null = null;
    try {
      // Fixed for the whole run: later setting changes apply to the next run.
      const generation = await this.snapshotGeneration(provider);
      if (generation.notes.length > 0) {
        generationNote = generation.notes.join(' ');
        this.status = `${this.status} ${generationNote}`;
        await this.postState();
      }
      if (mode === 'agent') {
        await this.sendAgent(threadId, text, provider, generation, agentTarget);
      } else if (provider === 'cloud') {
        await this.sendCloud(threadId, text, mode, generation);
      } else {
        await this.sendLocal(threadId, text, mode, generation);
      }
    } catch (error) {
      await this.handleSendError(threadId, provider, error);
    }
    if (generationNote !== null && !this.status.includes(generationNote)) {
      // The final status must not hide that a stored choice was not applied.
      this.status = `${this.status} ${generationNote}`;
    }
    if (!this.disposed) {
      void this.state.update(RAME_ACTIVE_RUN_KEY, undefined);
    }
    await this.refreshMemoryView();
    await this.postState();
  }

  private async sendCloud(
    threadId: string,
    text: string,
    mode: string,
    generation: RunGeneration,
  ): Promise<void> {
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      this.hasKey = false;
      this.running = false;
      this.connection = 'missing-key';
      this.status = 'No API key stored. Save a Meta Model API key to begin.';
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendErrorTurn(current, 'No API key stored.'));
      }
      return;
    }
    const thread = this.store.get(threadId);
    const built = buildRequestMessages({
      mode: mode === 'mission' ? 'mission' : 'chat',
      activeThread: thread,
      currentText: text,
    });
    const cloudModel = generation.model;
    const { request, note } = this.generationRequest(generation, { messages: built.messages });
    if (mode === 'mission') {
      const result = await this.missionRunner.startWithUsage({
        apiKey,
        goal: text,
        fetchImpl: undefined,
        model: cloudModel,
        generation: request,
      });
      this.recordUsage('cloud', result.usage);
      this.running = false;
      this.connection = 'verified';
      this.status = withNote('Plan ready.', note);
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendPlanTurn(current, result.plan));
      }
      await this.createMissionFromPlan(threadId, result.plan);
      this.output.clear();
      this.output.appendLine(formatPlanAsText(result.plan, cloudModel));
      this.output.show(true);
    } else {
      const result = await this.chatRunner.start(async ({ signal }) =>
        createChatCompletion({
          apiKey,
          goal: text,
          messages: built.messages,
          signal,
          model: cloudModel,
          generation: request,
        }).then((completion) => {
          this.recordUsage('cloud', completion.usage);
          return completion.text;
        }),
      );
      this.running = false;
      this.connection = 'verified';
      this.status = withNote('Reply ready.', note);
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendAssistantTurn(current, result));
      }
    }
  }

  private async sendLocal(
    threadId: string,
    text: string,
    mode: string,
    generation: RunGeneration,
  ): Promise<void> {
    const endpoint = this.localEndpoint();
    if (!endpoint) {
      throw new Error(
        'The local runtime is not running and no external endpoint is selected.',
      );
    }
    const thread = this.store.get(threadId);
    const built = buildRequestMessages({
      mode: mode === 'mission' ? 'mission' : 'chat',
      activeThread: thread,
      currentText: text,
    });
    const modelId = generation.model;
    const { request, note } = this.generationRequest(generation, { messages: built.messages });
    if (mode === 'mission') {
      // One strict tool call carries the plan; prose never becomes a Mission.
      const planned = await this.chatRunner.start(async ({ signal }) =>
        createLocalMissionPlan({
          endpoint,
          model: modelId,
          messages: built.messages,
          generation: request,
          signal,
          planSchema: missionPlanSchema.json_schema.schema,
        }).then((completion) => {
          this.recordUsage('local', completion.usage);
          return completion;
        }),
      );
      this.armIdleShutdown();
      await this.finishLocalMissionPlan(threadId, planned.plan ?? tryParseMissionPlan(planned.text), planned.text, note);
      this.running = false;
      this.connection = 'verified';
      return;
    }
    const result = await this.chatRunner.start(async ({ signal }) =>
      createLocalChatCompletion({
        endpoint,
        model: modelId,
        messages: built.messages,
        generation: request,
        signal,
      }).then((completion) => {
        this.recordUsage('local', completion.usage);
        return completion.text;
      }),
    );
    this.armIdleShutdown();
    if (mode === 'mission') {
      const plan = tryParseMissionPlan(result);
      const current = this.store.get(threadId);
      if (plan) {
        if (current) {
          this.store.save(appendPlanTurn(current, plan));
        }
        this.status = withNote('Plan ready.', note);
        await this.createMissionFromPlan(threadId, plan);
      } else {
        if (current) {
          this.store.save(appendAssistantTurn(current, result));
        }
        this.status = withNote(
          'The local model did not return a strict plan; its reply is shown as prose.',
          note,
        );
      }
    } else {
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendAssistantTurn(current, result));
      }
      this.status = withNote('Reply ready.', note);
    }
    this.running = false;
    this.connection = 'verified';
  }

  private async finishLocalMissionPlan(threadId: string, plan: MissionPlan | null, prose: string, note: string | null): Promise<void> {
    const current = this.store.get(threadId);
    if (plan) {
      if (current) {
        this.store.save(appendPlanTurn(current, plan));
      }
      this.status = withNote('Plan ready.', note);
      await this.createMissionFromPlan(threadId, plan);
      return;
    }
    if (current) {
      this.store.save(appendAssistantTurn(current, prose.trim().length > 0 ? prose : 'The local model did not submit a valid Mission plan.'));
    }
    this.status = withNote('The local model did not return a strict plan; its reply is shown as prose.', note);
  }

  // ----- Generation: reasoning, output budget, and context -----

  /** Model the provider will be asked for (the cloud model or the local id). */
  private generationModel(provider: ProviderId): string {
    if (provider === 'cloud') {
      return this.selectedCloudModel();
    }
    return this.settings.local.modelId.trim().length > 0 ? this.settings.local.modelId.trim() : 'local-glimmer';
  }

  /**
   * Read the local server's `/props` (loopback, bounded). Anything other
   * than a llama-server reply counts as unknown, which offers no reasoning
   * levels; it never blocks or fails the run.
   */
  private async probeLocalProps(endpoint: string): Promise<LocalServerProps> {
    let props: LocalServerProps = { ...UNKNOWN_LOCAL_PROPS };
    if (isLoopbackUrl(endpoint)) {
      try {
        const payload = await withBoundedRequest(undefined, LOCAL_PROPS_TIMEOUT_MS, 'Local /props timed out.', async (signal) => {
          const response = await fetch(`${endpoint.replace(/\/+$/, '')}/props`, { method: 'GET', signal });
          return response.ok ? ((await response.json()) as unknown) : null;
        });
        props = parseLlamaServerProps(payload);
      } catch {
        props = { ...UNKNOWN_LOCAL_PROPS };
      }
    }
    this.localProps = { endpoint, props };
    return props;
  }

  /** Profile of the selected provider/model from what is known right now. */
  private generationProfile(provider: ProviderId, model: string): ModelGenerationProfile {
    if (provider === 'cloud') {
      return cloudGenerationProfile(model);
    }
    const endpoint = this.localEndpoint();
    const props = endpoint !== null && this.localProps?.endpoint === endpoint ? this.localProps.props : null;
    // The context RAME passed with -c is a fallback only for its own server.
    const ownContext = this.local.owned && this.local.endpoint === endpoint ? this.settings.local.contextSize : null;
    return localGenerationProfile(props, ownContext);
  }

  private async snapshotGeneration(provider: ProviderId): Promise<RunGeneration> {
    const model = this.generationModel(provider);
    if (provider === 'local') {
      const endpoint = this.localEndpoint();
      if (endpoint !== null) {
        await this.probeLocalProps(endpoint);
      }
    }
    const profile = this.generationProfile(provider, model);
    const reasoning = resolveReasoning(this.settings.generation, provider, model, profile);
    const notes = reasoning.unavailable
      ? [`Reasoning ${REASONING_LABELS[reasoning.stored]} is not available for ${model} (${profile.source}); this run uses Model default.`]
      : [];
    const runProfile = {
      ...profile,
      autoOutputTokens: automaticOutputTokens(provider, reasoning.unavailable ? 'default' : reasoning.stored),
    };
    return {
      provider,
      model,
      profile: runProfile,
      reasoning: reasoning.level,
      manualMax: this.settings.generation.maxOutputTokens[provider],
      notes,
    };
  }

  /**
   * Output budget for one request from the run's fixed settings and the
   * estimated input. Throws {@link GenerationContextError} when the input
   * leaves too little context; the input is never shortened to fit.
   */
  private generationRequest(
    run: RunGeneration,
    body: unknown,
    calibration?: { chars: number; tokens: number } | null,
  ): { request: GenerationRequest; note: string | null } {
    const budget = resolveOutputBudget(run.provider, run.profile, run.manualMax, estimatePromptTokens(body, calibration));
    return {
      request: {
        maxCompletionTokens: budget.maxCompletionTokens,
        reasoning: run.reasoning,
        reasoningParam: run.profile.reasoningParam,
      },
      note: describeBudgetLimit(budget),
    };
  }

  /** Store a reasoning level for the selected provider/model (next run only). */
  async setReasoning(provider: ProviderId, model: string, rawLevel: string): Promise<void> {
    const current = this.generationModel(this.settings.provider);
    if (provider !== this.settings.provider || model !== current || !isReasoningChoice(rawLevel)) {
      this.status = 'Reasoning was not changed: the selection no longer matches the current runtime.';
      await this.postState();
      return;
    }
    const profile = this.generationProfile(provider, model);
    if (rawLevel !== 'default' && !profile.reasoningLevels.includes(rawLevel)) {
      this.status = `Reasoning ${REASONING_LABELS[rawLevel]} is not available for ${model}.`;
      await this.postState();
      return;
    }
    try {
      this.settings = { ...this.settings, generation: withReasoningChoice(this.settings.generation, provider, model, rawLevel) };
    } catch (error) {
      this.status = error instanceof Error ? error.message : 'Reasoning was not changed.';
      await this.postState();
      return;
    }
    this.persistSettings();
    this.status = this.running
      ? `Reasoning set to ${REASONING_LABELS[rawLevel]} for ${model}; the current run keeps its settings.`
      : `Reasoning set to ${REASONING_LABELS[rawLevel]} for ${model}.`;
    await this.postState();
  }

  /**
   * Store the advanced manual output maximums (next run only). Both are
   * validated first: when either is invalid, neither changes.
   */
  async setMaxOutputTokens(rawLocal: number | null, rawCloud: number | null): Promise<void> {
    const parsed: Record<GenerationProviderId, number | null> = { local: null, cloud: null };
    for (const [provider, raw, label] of [['local', rawLocal, 'Local'], ['cloud', rawCloud, 'Meta']] as const) {
      try {
        parsed[provider] = parseManualMaxOutput(provider, raw);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'The value is invalid.';
        this.status = `${label} maximum not saved, so nothing changed: ${detail}`;
        await this.postState();
        return;
      }
    }
    this.settings = { ...this.settings, generation: { ...this.settings.generation, maxOutputTokens: parsed } };
    this.persistSettings();
    const what = (value: number | null): string => (value === null ? 'automatic' : `${value} tokens`);
    const summary = `Maximum output: Local ${what(parsed.local)}, Meta ${what(parsed.cloud)}.`;
    this.status = this.running ? `${summary} The current run keeps its settings.` : summary;
    await this.postState();
  }

  // ----- Agent mode (permission-gated bounded tool loop) -----

  /** Select the Agent permission profile; persists only the profile id. */
  async setAgentProfile(rawProfile: string): Promise<void> {
    const next = parseAgentProfile(rawProfile);
    if (!isAgentProfileId(rawProfile) && rawProfile !== next) {
      this.status = 'Unknown permission profile. Kept Ask (safest).';
    } else {
      this.status =
        next === 'workspace-full'
          ? 'Workspace-full selected (high risk). Policy-checked patches and allowlisted tests can run without prompts. Tests run with your OS permissions and may access files, network, or shells. Select Ask to return instantly.'
          : `Permission profile: ${describeAgentProfile(next)}.`;
    }
    this.settings = { ...this.settings, agentProfile: next };
    this.persistSettings();
    await this.postState();
  }

  /** Approve one pending Agent action (one approval authorizes one action). */
  async approveAgentAction(actionId: string, digest: string): Promise<void> {
    const pending = this.agentPending;
    if (!pending || !this.agentWaiter) {
      this.status = 'No Agent action is waiting for approval.';
      await this.postState();
      return;
    }
    if (pending.actionId !== actionId || pending.digest !== digest) {
      // An obsolete or replayed card: ignore it and keep the action that
      // is really pending. It can never authorize anything else.
      this.status = 'That approval is no longer valid.';
      await this.postState();
      return;
    }
    const live = await this.liveApprovalContext(pending);
    const drift = memoryDrift(pending, live.currentHashes);
    const checked = drift !== null ? { ok: false as const, error: drift } : verifyApproval(
      pending,
      { actionId, digest },
      live,
    );
    if (!checked.ok) {
      this.recordAgentAudit(pending, 'rejected', checked.error);
      this.agentPending = null;
      const waiter = this.agentWaiter;
      this.agentWaiter = null;
      waiter.resolve({ kind: 'stale', reason: checked.error });
      this.status = checked.error;
      await this.postState();
      return;
    }
    pending.used = true;
    this.agentPending = null;
    const waiter = this.agentWaiter;
    this.agentWaiter = null;
    this.recordAgentAudit(pending, 'human', 'approved by user');
    waiter.resolve({ kind: 'approve' });
    await this.postState();
  }

  /** Reject one pending Agent action. */
  async rejectAgentAction(actionId: string, digest: string): Promise<void> {
    const pending = this.agentPending;
    if (!pending || !this.agentWaiter) {
      this.status = 'No Agent action is waiting for approval.';
      await this.postState();
      return;
    }
    if (pending.actionId !== actionId || pending.digest !== digest) {
      this.status = 'That approval is no longer valid.';
      await this.postState();
      return;
    }
    this.recordAgentAudit(pending, 'rejected', 'rejected by user');
    this.agentPending = null;
    const waiter = this.agentWaiter;
    this.agentWaiter = null;
    waiter.resolve({ kind: 'reject' });
    this.status = 'Agent action rejected.';
    await this.postState();
  }

  private recordAgentAudit(
    pending: PendingAgentAction,
    decision: 'human' | 'profile-auto' | 'rejected' | 'policy',
    result: string,
  ): void {
    const entry = this.audit.append({
      provider: pending.provider,
      threadId: pending.threadId,
      profile: this.settings.agentProfile,
      tool: pending.tool,
      digest: pending.digest,
      decision,
      result,
    });
    void this.state.update(RAME_AUDIT_KEY, this.audit.list());
    this.agentLogView = [
      ...this.agentLogView,
      {
        tool: entry.tool,
        digest: entry.digest.slice(0, 16),
        decision: entry.decision,
        result: entry.result,
      },
    ].slice(-20);
  }

  private async liveApprovalContext(pending: PendingAgentAction): Promise<{
    workspaceId: string;
    threadId: string;
    provider: string;
    generation: number;
    currentHashes: Record<string, string>;
  }> {
    // The approval binds to the exact workspace held for the run. Prefer
    // the pending bound root when it is still open; fall back to the
    // single-folder root otherwise. Never accept a webview/model path.
    const open = this.listOpenWorkspaceFolders();
    const boundValid = validateChosenWorkspace(pending.workspaceId, open);
    const single = this.heldWorkspaceRoot();
    const heldRoot = boundValid ?? (single.ok ? single.root : null);
    const workspaceId = heldRoot ?? '';
    const currentHashes: Record<string, string> = {};
    if (heldRoot !== null) {
      const fs = this.agentFsFor(heldRoot);
      for (const rawPath of Object.keys(pending.preconditions)) {
        const memoryKey = parseMemoryPreconditionKey(rawPath);
        if (memoryKey !== null) {
          // A decision that moved on since the proposal voids the approval.
          const latest = this.memory.latestVersion(memoryKey.scopeId, memoryKey.key);
          currentHashes[rawPath] = latest === null ? '' : memoryPreconditionValue(latest);
          continue;
        }
        try {
          const gate = checkAgentRelPath(rawPath);
          if (!gate.ok) {
            currentHashes[rawPath] = '';
            continue;
          }
          const rel = (gate as { ok: true; rel: string }).rel;
          const st = await fs.stat(rel);
          if (st.kind === 'missing') {
            currentHashes[rawPath] = MISSING_FILE_PRECONDITION;
            continue;
          }
          if (st.kind !== 'file') {
            currentHashes[rawPath] = '';
            continue;
          }
          const text = await fs.readText(rel);
          currentHashes[rawPath] = hashContent(text);
        } catch {
          currentHashes[rawPath] = '';
        }
      }
    }
    return {
      workspaceId,
      // The run's own thread, never the thread currently on screen.
      threadId: this.runThreadId ?? '',
      provider: this.settings.provider,
      generation: this.agentGeneration,
      currentHashes,
    };
  }

  private heldWorkspaceRoot(): { ok: true; root: string } | { ok: false; error: string } {
    const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    return resolveSingleWorkspaceRoot(folders);
  }

  private listOpenWorkspaceFolders(): OpenWorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return normalizeOpenFolders(
      folders.map((folder) => ({ name: folder.name, path: folder.uri.fsPath })),
    );
  }

  private isBoundRootStillOpen(boundRoot: string): boolean {
    return validateChosenWorkspace(boundRoot, this.listOpenWorkspaceFolders()) !== null;
  }

  /**
   * Resolve the canonical workspace target for one Agent run.
   * - Exactly one folder: use it without prompting.
   * - Several folders: native QuickPick showing name + full path; the user
   *   must explicitly choose. Cancellation returns `cancelled` with no
   *   transcript changes. Never silently picks the first folder and never
   *   accepts a model/webview-supplied path.
   */
  private async resolveAgentRunRoot(): Promise<
    { ok: true; root: string; label: string } | { ok: false; cancelled: boolean; error: string }
  > {
    const open = this.listOpenWorkspaceFolders();
    if (open.length === 0) {
      return { ok: false, cancelled: false, error: NO_WORKSPACE_MESSAGE };
    }
    if (this.pinnedRunRoot !== null) {
      // A Mission task or cascade verification runs in its own project,
      // never in another open folder and without a second prompt.
      const pinned = open.find((folder) => folder.path === validateChosenWorkspace(this.pinnedRunRoot, open));
      return pinned
        ? { ok: true, root: pinned.path, label: workspaceDisplayLabel(pinned) ?? pinned.path }
        : { ok: false, cancelled: false, error: 'The project folder of this run is no longer open.' };
    }
    if (open.length === 1) {
      const only = open[0] as OpenWorkspaceFolder;
      return {
        ok: true,
        root: only.path,
        label: workspaceDisplayLabel(only) ?? only.path,
      };
    }
    const items = buildWorkspacePickItems(open).map((item) => ({
      label: item.label,
      description: item.description,
      detail: item.detail,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select workspace folder for this Agent run',
      ignoreFocusOut: true,
    });
    if (!picked) {
      return { ok: false, cancelled: true, error: WORKSPACE_PICK_CANCELLED };
    }
    const validated = validateChosenWorkspace(picked.description, open);
    if (validated === null) {
      return { ok: false, cancelled: true, error: WORKSPACE_PICK_CANCELLED };
    }
    const folder = open.find((entry) => entry.path === validated) as OpenWorkspaceFolder;
    return {
      ok: true,
      root: validated,
      label: workspaceDisplayLabel(folder) ?? validated,
    };
  }

  private async offerOpenFolderAction(): Promise<void> {
    try {
      const choice = await vscode.window.showInformationMessage(
        NO_WORKSPACE_MESSAGE,
        'Open Folder',
      );
      if (choice === 'Open Folder') {
        await vscode.commands.executeCommand('vscode.openFolder');
      }
    } catch {
      // Informational only; the status line already explains the state.
    }
  }

  private agentFsFor(root: string): AgentFs {
    return createVscodeWorkspaceFs(root);
  }

  /** Canonical root held for the run; falls back to the label when unavailable. */
  private async heldCanonicalRoot(labelRoot: string, fs: AgentFs): Promise<string> {
    return resolveCanonicalRoot(fs, labelRoot);
  }

  private async testCommandContext(boundRoot?: string): Promise<{
    allowlist: AllowedTestCommand[];
    packageJsonRaw: string;
    scripts: Record<string, string>;
  }> {
    const root = boundRoot ?? (this.heldWorkspaceRoot().ok
      ? (this.heldWorkspaceRoot() as { ok: true; root: string }).root
      : null);
    return root === null
      ? { allowlist: [], packageJsonRaw: '', scripts: {} }
      : npmTestContext(this.agentFsFor(root));
  }

  private async runAllowlistedTest(
    command: AllowedTestCommand,
    signal: AbortSignal,
    boundRoot?: string,
  ): Promise<string> {
    const spec = buildTestSpawnSpec(command);
    const held = this.heldWorkspaceRoot();
    const cwd = boundRoot ?? (held.ok ? held.root : undefined);
    // Windows: `npm` becomes absolute node.exe + npm-cli.js from PATH; the
    // approved argv is unchanged.
    const invocation = resolveTestInvocation(spec, {
      platform: process.platform,
      pathEnv: process.env.PATH,
      cwd,
      isFile: (absolutePath) => {
        try {
          return statSync(absolutePath).isFile();
        } catch {
          return false;
        }
      },
    });
    // Bounded tree-killing runner: a timeout or cancel ends the whole
    // process tree and the run always settles.
    const result = await runBoundedProcess(
      {
        executable: invocation.executable,
        argv: invocation.argv,
        cwd,
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
      },
      signal,
    );
    return truncateToolOutput(formatProcessResult(result, spec.timeoutMs, MAX_TEST_OUTPUT_BYTES));
  }

  private waitForAgentDecision(pending: PendingAgentAction, signal: AbortSignal): Promise<AgentDecision> {
    this.agentPending = pending;
    if (this.activeMission !== null) {
      void this.updateActiveMission((mission) => setWaiting(mission, true));
    }
    this.status = `Waiting for your approval: ${pending.tool}.`;
    void this.postState();
    return new Promise<AgentDecision>((resolve) => {
      const waiter = {
        resolve: (choice: AgentDecision): void => {
          signal.removeEventListener('abort', onAbort);
          if (this.activeMission !== null) {
            void this.updateActiveMission((mission) => setWaiting(mission, false));
          }
          resolve(choice);
        },
      };
      const onAbort = (): void => {
        if (this.agentPending?.actionId === pending.actionId) {
          this.agentPending = null;
        }
        this.agentWaiter = null;
        resolve({ kind: 'cancelled' });
      };
      this.agentWaiter = waiter;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Bounded Agent run with the explicitly selected provider only.
   * Cloud uses the selected compatible model; local uses Glimmer.
   * Never switches providers mid-run.
   */
  private async sendAgent(
    threadId: string,
    text: string,
    provider: ProviderId,
    generation: RunGeneration,
    resolvedTarget?: { root: string; label: string },
  ): Promise<void> {
    const profile: AgentProfileId = capProfile(this.settings.agentProfile ?? DEFAULT_AGENT_PROFILE, this.missionProfileCap);
    const target: Awaited<ReturnType<RameCodeViewProvider['resolveAgentRunRoot']>> = resolvedTarget
      ? { ok: true, root: resolvedTarget.root, label: resolvedTarget.label }
      : await this.resolveAgentRunRoot();
    if (!target.ok) {
      this.running = false;
      if (target.cancelled) {
        // Explicit user cancellation: concise status, no error transcript.
        this.connection = 'cancelled';
        this.status = target.error;
        await this.postState();
        return;
      }
      this.connection = 'error';
      this.status = target.error;
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendErrorTurn(current, target.error));
      }
      await this.offerOpenFolderAction();
      return;
    }
    const workspaceId = target.root;
    // Bind the verified target to this run and surface it for verification.
    // A later thread clears this display; it is never reused silently.
    this.agentRunWorkspace = { root: target.root, label: target.label };
    // Settings memory follows the project the user just chose for the run.
    if (this.memoryPending === null) {
      this.memoryRoot = target.root;
    }
    await this.postState();
    const model = generation.model;
    try {
      assertAgentModelForProvider(provider, model);
    } catch (error) {
      this.running = false;
      this.connection = 'error';
      const detail = error instanceof Error ? error.message : 'Invalid Agent model.';
      this.status = detail;
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendErrorTurn(current, detail));
      }
      return;
    }
    let apiKey = '';
    if (provider === 'cloud') {
      const stored = await this.secrets.get(API_KEY_SECRET);
      if (!stored) {
        this.hasKey = false;
        this.running = false;
        this.connection = 'missing-key';
        this.status = 'No API key stored. Save a Meta Model API key to begin.';
        const current = this.store.get(threadId);
        if (current) {
          this.store.save(appendErrorTurn(current, 'No API key stored.'));
        }
        return;
      }
      apiKey = stored;
    } else {
      const endpoint = this.localEndpoint();
      if (!endpoint) {
        throw new Error('The local runtime is not running and no external endpoint is selected.');
      }
    }
    const thread = this.store.get(threadId);
    const history: AgentChatMessage[] = [];
    if (thread) {
      // A Mission internal run gets its earlier internal runs (host prompts,
      // their replies and records, host status notes) from the host's
      // checkpoint in its prompt, not as replayed history; that includes its
      // own prompt, which is sent once as the goal. What the user wrote in
      // the thread, and the replies to it, are still sent. The stored thread
      // and the Mission record are unchanged.
      const missionRun = this.missionAuto !== null;
      let hostSegment = false;
      // buildAgentMessages keeps the most recent messages and tells the
      // model how many older ones it left out.
      for (const turn of thread.turns) {
        if (missionRun) {
          if (turn.kind === 'user') {
            hostSegment = turn.host === true;
          }
          if (hostSegment) {
            continue;
          }
        }
        if (turn.kind === 'user') {
          history.push({ role: 'user', content: historyText(turn.text) });
        } else if (turn.kind === 'assistant') {
          // Prose only: host labels and records are never echoed back for
          // the model to imitate. What actually ran is given separately.
          const prose = assistantHistoryText(turn.text);
          if (prose.length > 0) {
            history.push({ role: 'assistant', content: historyText(prose) });
          }
          if (turn.hostRecord) {
            history.push({
              role: 'system',
              content:
                'Context from RAME Code: the actions it verified for the previous reply were:\n' +
                `${turn.hostRecord.join('\n')}\n` +
                'Use this only as context. Never write a host record or an "Agent (...)" label yourself.',
            });
          }
        }
      }
    }
    const fs = this.agentFsFor(workspaceId);
    const heldCanonicalRoot = await this.heldCanonicalRoot(workspaceId, fs);
    const extra: AgentChatMessage[] = [];
    // Project memory of the canonical root this run is bound to. The model
    // reads it as a labeled snapshot and can only propose changes.
    // The label is the folder name only: the model never receives the root path.
    const memoryScope = { scopeId: scopeIdForRoot(heldCanonicalRoot), label: path.basename(target.root) };
    const runTools = [...buildAgentToolDefinitions(), ...buildMemoryToolDefinitions()];
    extra.push({ role: 'system', content: `${MEMORY_RULES_TEXT}\n${await this.memorySnapshotText(memoryScope, fs)}` });
    // Evidence for bind_artifact: file writes and host-run tests of this run.
    let workspaceWrites = 0;
    // Mission runs: identical read-only results already returned in this run,
    // the repeats seen, and the one push to act before a run ends without a change.
    const seenReadResults = new Map<string, { digest: string; step: number }>();
    let repeatedReads = 0;
    let actNudged = false;
    let lowBudgetNoted = false;
    // Files this run wrote, for the bind_artifact hint after a passing test.
    const changedFiles = new Set<string>();
    const testRuns: Array<{ commandId: string; exitCode: number | null; writes: number; at: number; outputDigest: string }> = [];
    const memoryProposals = new Map<string, MemoryProposal>();
    // Host-verified record of every action this run executed (or that did
    // not run), appended to the final report so the persisted thread never
    // rests on the model's own claims alone.
    const hostRecord: string[] = [];
    const recordHostAction = (call: ValidatedToolCall, targets: string[], outcome: string): void => {
      if (hostRecord.length < MAX_HOST_RECORD_LINES) {
        const target = targets.join(', ').slice(0, 120);
        const line = `• ${call.tool}${target.trim().length > 0 ? ` ${target}` : ''} → ${outcome}`;
        hostRecord.push(line.replace(/[\r\n]+/g, ' ').slice(0, MAX_HOST_RECORD_LINE_LENGTH));
      }
    };
    let steps = 0;
    let lastStepToolCallsRefused = false;
    let protocolRepairs = 0;
    let emptyReplies = 0;
    // Why the run stopped, for the cascade: only a capability stop can be helped by advice.
    let stopKind = 'policy' as LocalStopKind;
    // Measured input tokens of the last step refine the next estimate.
    let calibration: { chars: number; tokens: number } | null = null;
    let lastBudgetNote: string | null = null;
    const outcome = await this.agentRunner.start(async (signal) => {
      agentSteps: for (let step = 0; step < MAX_AGENT_STEPS; step++) {
        this.agentStepNow = step + 1;
        if (this.missionAuto !== null) {
          // The Mission card shows "step X/12": publish each new step.
          await this.postState();
        }
        const stale = await this.checkWorkspaceStillHeld(workspaceId);
        if (!stale.ok) {
          return 'stale';
        }
        const canonicalStale = await this.checkCanonicalStillHeld(fs, heldCanonicalRoot);
        if (!canonicalStale.ok) {
          return 'stale';
        }
        if (signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        if (this.missionAuto !== null && !lowBudgetNoted && MAX_AGENT_STEPS - step <= MISSION_LOW_BUDGET_STEPS && workspaceWrites === 0 && testRuns.length === 0) {
          lowBudgetNoted = true;
          extra.push({
            role: 'system',
            content:
              `Only ${MAX_AGENT_STEPS - step} model steps remain in this internal run and nothing has changed yet. Stop exploring: ` +
              'make the smallest change that meets the task now, run the allowlisted test, then report.',
          });
        }
        if (MAX_AGENT_STEPS - step === AGENT_STEPS_WARNING_REMAINING) {
          // Without a warning the run could end at the budget with work done
          // but no report; the budget itself is unchanged.
          extra.push({
            role: 'system',
            content:
              `Only ${AGENT_STEPS_WARNING_REMAINING} model steps remain in this run's budget of ${MAX_AGENT_STEPS}. ` +
              'Use at most one more tool call, and only if it is essential; then return the required final report: ' +
              'what you did, files changed (or none), tests/checks run and their result, and what remains unfinished.',
          });
        }
        // The last step goes out with tool_choice "none": the model can only
        // write its report. The budget stays the same.
        const lastStep = step === MAX_AGENT_STEPS - 1;
        if (lastStep) {
          extra.push({
            role: 'system',
            content:
              `This is the last model step of the budget of ${MAX_AGENT_STEPS}, and tools are disabled for it. ` +
              'Return the required final report now, based only on the tool results above: ' +
              'what you did, files changed (or none), tests/checks run and their result, and what remains unfinished.',
          });
        }
        // Meta documents only tool_choice "auto"; the local server also
        // honors "none". The host refuses last-step tool calls either way.
        const toolChoice = lastStep && provider === 'local' ? 'none' : 'auto';
        const messages = buildAgentMessages(workspaceId, history, text, extra);
        const estimateBody = { messages, tools: runTools };
        let stepRequest: ReturnType<RameCodeViewProvider['generationRequest']>;
        try {
          stepRequest = this.generationRequest(generation, estimateBody, calibration);
        } catch (error) {
          if (!(error instanceof GenerationContextError)) {
            throw error;
          }
          // The run's own exchanges are never dropped to make room.
          const detail = `The Agent stopped before model step ${step + 1}: ${error.message}`;
          const current = this.store.get(threadId);
          if (current) {
            this.store.save(appendErrorTurn(current, detail.slice(0, 500)));
          }
          this.status = detail;
          stopKind = 'context';
          return 'policy-stop';
        }
        if (stepRequest.note !== null && stepRequest.note !== lastBudgetNote) {
          lastBudgetNote = stepRequest.note;
          this.status = stepRequest.note;
          await this.postState();
        }
        let completion: AgentCompletion;
        try {
          const modelProvider = provider === 'cloud'
            ? new MetaAgentModelProvider(apiKey)
            : new LocalAgentModelProvider(this.localEndpoint() as string);
          completion = await modelProvider.complete({
            model,
            messages,
            generation: stepRequest.request,
            tools: runTools,
            signal,
            toolChoice,
          });
          this.recordUsage(modelProvider.id, completion.usage);
          if (modelProvider.id === 'local') {
            this.armIdleShutdown();
          }
          if (completion.usage.inputTokens > 0) {
            calibration = { chars: JSON.stringify(estimateBody).length, tokens: completion.usage.inputTokens };
          }
        } catch (error) {
          if (!isAgentToolProtocolError(error)) {
            throw error;
          }
          if (error.usage) {
            // The rejected reply still consumed provider tokens.
            this.recordUsage(provider, error.usage);
          }
          steps += 1;
          protocolRepairs += 1;
          const truncated = error instanceof AgentOutputTruncatedError ? error : null;
          const unparsed = error instanceof LocalMalformedToolCallError;
          if (protocolRepairs > 2) {
            const detail = truncated
              ? `The model's replies were repeatedly cut off at the ${truncated.maxCompletionTokens}-token output limit. No incomplete action ran and no success was claimed.`
              : unparsed
                ? 'The local server repeatedly could not parse the model\'s tool calls. None of them ran and no success was claimed.'
                : 'The model repeatedly produced invalid tool arguments. No invalid action ran.';
            const current = this.store.get(threadId);
            if (current) {
              this.store.save(appendErrorTurn(current, detail));
            }
            this.status = detail;
            stopKind = truncated ? 'truncation' : 'capability';
            return 'policy-stop';
          }
          const providerLabel = provider === 'local' ? 'local model' : 'Meta cloud model';
          if (truncated) {
            // An incomplete reply is not a schema mistake: nothing from it
            // was used, so ask for a shorter step instead.
            extra.push({
              role: 'system',
              content:
                `Your previous reply was cut off at the ${truncated.maxCompletionTokens}-token output limit before it was complete, so the host discarded it and no action ran. ` +
                'Keep your reasoning short and reply with one small tool call. ' +
                'Split a large edit into several smaller apply_patch calls, and keep the final report brief.',
            });
            this.status = `The ${providerLabel} reply was cut off at its ${truncated.maxCompletionTokens}-token limit; asking for a shorter step (${protocolRepairs}/2)…`;
            await this.postState();
            continue agentSteps;
          }
          if (unparsed) {
            // The server rejected the reply before any call reached the host:
            // nothing ran, so there is nothing uncertain to check.
            extra.push({
              role: 'system',
              content:
                'The local server could not parse your previous reply as a tool call, so it was not executed and nothing changed. ' +
                'Reply with one smaller, well-formed tool call. To change part of an existing file, use replace_in_file with a short exact fragment instead of rewriting the whole file.',
            });
            this.status = `The local server could not parse the ${providerLabel}'s tool call; nothing ran. Asking for a smaller step (${protocolRepairs}/2)…`;
            await this.postState();
            continue agentSteps;
          }
          // The reason is one of the host's own fixed validation messages
          // (never model text), so the model can fix the actual mistake.
          const reason = error.message.replace(/[^\x20-\x7e]/g, '').slice(0, 200);
          extra.push({
            role: 'system',
            content:
              'Your previous tool proposal was rejected before execution because it did not exactly match the declared JSON schema. ' +
              `Reason: ${reason} ` +
              'Return one corrected allowlisted tool call with every required key and no extra keys. ' +
              'For filesystem_usage, use exactly {} as its arguments. ' +
              'For apply_patch, use {"files":[{"path":"relative/path","expectedHash":"the sha256 returned by read_file, or e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 for a new file","newContent":"full replacement text"}]}.',
          });
          this.status = `Correcting malformed tool call (${protocolRepairs}/2): waiting for the ${providerLabel} (120 s maximum)…`;
          await this.postState();
          continue agentSteps;
        }
        steps += 1;
        if (lastStep && completion.toolCalls && completion.toolCalls.length > 0) {
          // A provider that ignores tool_choice "none" still gets no action:
          // nothing proposed on the last step runs.
          lastStepToolCallsRefused = true;
          break agentSteps;
        }
        // "Repeatedly" means consecutive: a valid reply resets the count.
        // The step budget still bounds the total number of model calls.
        protocolRepairs = 0;
        if (!completion.toolCalls || completion.toolCalls.length === 0) {
          const reply = (completion.text ?? '').trim().slice(0, 8000);
          if (reply.length === 0 && emptyReplies < 2) {
            emptyReplies += 1;
            extra.push({
              role: 'system',
              content:
                this.missionAuto !== null && workspaceWrites === 0 && testRuns.length === 0
                  ? 'Your previous response was empty. Continue the task with one valid tool call that moves it forward: the change, or the allowlisted test. Do not return an empty response.'
                  : 'Your previous response was empty. Continue the task with one valid tool call, or return the required concise final report. Do not return an empty response.',
            });
            this.status = `Retrying an empty Agent response (${emptyReplies}/2)…`;
            await this.postState();
            continue agentSteps;
          }
          if (reply.length === 0) {
            const detail = 'The model repeatedly returned an empty response. No success was claimed.';
            const current = this.store.get(threadId);
            if (current) {
              this.store.save(appendErrorTurn(current, detail));
            }
            this.status = detail;
            stopKind = 'capability';
            return 'policy-stop';
          }
          if (this.missionAuto !== null && !actNudged && workspaceWrites === 0 && testRuns.length === 0 && step < MAX_AGENT_STEPS - AGENT_STEPS_WARNING_REMAINING) {
            // Ending now would be a run with no change and no test: ask once
            // to act with the steps left. The step budget is unchanged.
            actNudged = true;
            extra.push({ role: 'assistant', content: reply.slice(0, 2000) });
            extra.push({
              role: 'system',
              content:
                `Your reply would end this internal run, but no file changed and no test ran, so the host would record no progress. ${MAX_AGENT_STEPS - step - 1} model steps remain. ` +
                'Do not explore again: make the smallest change that meets the task now (read only the file you change if you need its exact text and sha256), run the allowlisted test, then report. ' +
                'If something really blocks the change, say what it is in one sentence.',
            });
            this.status = 'The Agent stopped without a change or a test; asking it to act with the steps left…';
            await this.postState();
            continue agentSteps;
          }
          const lastTestNow = testRuns.length > 0 ? testRuns[testRuns.length - 1] : undefined;
          const untestedChange = workspaceWrites > 0 && (lastTestNow === undefined || workspaceWrites > lastTestNow.writes);
          if (this.missionAuto !== null && !actNudged && untestedChange && step < MAX_AGENT_STEPS - AGENT_STEPS_WARNING_REMAINING) {
            // A change with no test after it cannot be accepted: ask once to
            // run the test now instead of spending another internal run on it.
            actNudged = true;
            extra.push({ role: 'assistant', content: reply.slice(0, 2000) });
            extra.push({
              role: 'system',
              content:
                `Your reply would end this internal run, but no allowlisted test ran after your last change, so the host cannot accept the task. ${MAX_AGENT_STEPS - step - 1} model steps remain. ` +
                'Run the allowlisted test now; if it fails, fix the change and run it again; then report.',
            });
            this.status = 'The Agent changed files without running the test; asking it to run the test now…';
            await this.postState();
            continue agentSteps;
          }
          const current = this.store.get(threadId);
          if (current) {
            // The host record is stored as its own field and rendered apart;
            // labels or a "Host record" the model copied are cut from its prose.
            const prefix = `Agent (${profile}, ${provider}): `;
            const prose = sanitizeAgentReply(reply).text;
            this.lastAgentOutcome = { threadId, outcome: 'done', hostRecord: [...hostRecord], report: prose.slice(0, 1200) };
            const record = hostRecord.length > 0 ? hostRecord : [NO_HOST_ACTIONS_LINE];
            this.store.save(
              appendAssistantTurn(current, `${prefix}${fitTurnText(prose, MAX_ASSISTANT_TEXT_LENGTH - prefix.length)}`, undefined, record),
            );
          }
          this.pushAgentLog(profile, provider, threadId);
          return 'done';
        }
        for (const call of completion.toolCalls) {
          if (signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          // Freshly derive the test allowlist for every action so approvals
          // bind to current package.json state. Workspace-full auto-run uses
          // the same exact freshly-derived allowlist.
          const testContext = await this.testCommandContext(workspaceId);
          const gate = policyGateForCall(call, testContext.allowlist);
          if (!gate.ok) {
            // Reject without execution, then let the same model repair its
            // proposal inside the existing bounded step budget.
            this.recordBlockedProposal(call, provider, threadId, workspaceId, gate.error);
            recordHostAction(call, describeAgentCall(call).targets, `blocked by policy: ${gate.error}`);
            extra.push({
              role: 'assistant',
              content: '',
              tool_calls: [
                { id: call.id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } },
              ],
            });
            extra.push({
              role: 'tool',
              tool_call_id: call.id,
              content: truncateToolOutput(
                call.tool === 'run_tests'
                  ? `Rejected by host policy: ${gate.error} No action ran. Read package.json and retry with commandId npm:<safe-script-name>; for the test script use npm:test.`
                  : gate.error === WINDOWS_SET_EXECUTABLE_ERROR
                    ? `Rejected by host policy: ${gate.error} No action ran. Do not retry it; Windows has no executable bit, so continue without it.`
                    : `Rejected by host policy: ${gate.error} No action ran. Retry with workspace-relative paths only; use an empty dir for the workspace root.`,
              ),
            });
            this.status = `Correcting a blocked ${call.tool} proposal…`;
            await this.postState();
            continue agentSteps;
          }
          let described = describeAgentCall(call);
          if (call.tool === 'run_tests') {
            const bound = this.describeBoundTestCall(call, testContext);
            if (!bound.ok) {
              this.failAgentWithAudit(call, provider, threadId, workspaceId, 'policy', bound.error, 'Policy blocked the action.');
              return 'policy-stop';
            }
            described = { targets: bound.described.targets, body: bound.described.body, preconditions: bound.described.preconditions };
          } else if (call.tool === 'apply_patch') {
            described = {
              ...described,
              preconditions: await this.bindPatchApprovalPreconditions(call, fs, heldCanonicalRoot),
            };
          }
          const frozenHit = WORKSPACE_WRITE_TOOLS.has(call.tool) ? this.frozenTarget(described.targets) : null;
          if (frozenHit !== null) {
            // The user's acceptance check is frozen for this Mission: no write,
            // move, or delete of it is even proposed. node_modules is only
            // blocked for RAME's own tools; it is not hashed.
            const dependencies = frozenHit === 'node_modules' || frozenHit.startsWith('node_modules/');
            recordHostAction(
              call,
              described.targets,
              dependencies ? `not proposed: RAME's tools do not change ${frozenHit} during this Mission` : `not proposed: ${frozenHit} is frozen for this Mission`,
            );
            extra.push({
              role: 'assistant',
              content: '',
              tool_calls: [{ id: call.id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } }],
            });
            extra.push({
              role: 'tool',
              tool_call_id: call.id,
              content: dependencies
                ? `Not proposed: RAME Code's tools do not change installed dependencies (${frozenHit}) during a Mission with an acceptance check. Change the code instead.`
                : `Not proposed: ${frozenHit} is part of the user's frozen acceptance check for this Mission and cannot be changed, moved, or deleted. Change the code instead.`,
            });
            this.status = dependencies
              ? 'A change inside node_modules was refused; returning the reason to the Agent…'
              : 'A change to a frozen acceptance file was refused; returning the reason to the Agent…';
            await this.postState();
            continue agentSteps;
          }
          if (call.tool === 'replace_in_file') {
            // Never ask the user to approve a change that cannot apply: the
            // file must have the expected hash and hold oldText exactly once.
            let check: Awaited<ReturnType<RameCodeViewProvider['checkReplacement']>>;
            try {
              check = await this.checkReplacement(call, fs, heldCanonicalRoot);
            } catch (error) {
              const detail = error instanceof Error ? error.message : 'The path is not allowed.';
              this.failAgentWithAudit(call, provider, threadId, workspaceId, 'policy', detail, `Agent tool failed (${detail}).`);
              return 'policy-stop';
            }
            if (!check.ok) {
              recordHostAction(call, described.targets, `not proposed: ${check.error}`);
              extra.push({
                role: 'assistant',
                content: '',
                tool_calls: [{ id: call.id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } }],
              });
              extra.push({
                role: 'tool',
                tool_call_id: call.id,
                content: truncateToolOutput(`Not proposed: ${check.error} Nothing was changed. Read the file again and propose a fragment that appears exactly once.`),
              });
              this.status = 'The replace_in_file proposal was not prepared; returning the reason to the Agent…';
              await this.postState();
              continue agentSteps;
            }
          } else if (call.tool === 'create_directory') {
            const target = String((call.args as Record<string, unknown>).path ?? '');
            described = {
              ...described,
              preconditions: { [target]: MISSING_FILE_PRECONDITION },
            };
          } else if (call.tool === 'move_file') {
            const destination = String((call.args as Record<string, unknown>).destination ?? '');
            described = {
              ...described,
              preconditions: {
                ...described.preconditions,
                [destination]: MISSING_FILE_PRECONDITION,
              },
            };
          }
          // Memory writes: the store prepares the exact proposal; the user's
          // approval of this card is the only thing that can commit it.
          let memoryProposal: MemoryProposal | null = null;
          if (call.tool === 'propose_decision' || call.tool === 'bind_artifact') {
            const prepared =
              call.tool === 'propose_decision'
                ? this.prepareModelDecision(call, memoryScope, threadId, provider)
                : await this.prepareModelArtifact(call, memoryScope, threadId, provider, fs, heldCanonicalRoot, testRuns, workspaceWrites);
            if (!prepared.ok) {
              recordHostAction(call, described.targets, `not proposed: ${prepared.error}`);
              extra.push({
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: call.id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } },
                ],
              });
              extra.push({
                role: 'tool',
                tool_call_id: call.id,
                content: truncateToolOutput(
                  `Not proposed: ${prepared.error} Nothing was written. If the version was outdated, call read_decisions before proposing again; otherwise follow the reason above.`,
                ),
              });
              this.status = `The ${call.tool} proposal was not prepared; returning the reason to the Agent…`;
              await this.postState();
              continue agentSteps;
            }
            memoryProposal = prepared.value;
            memoryProposals.set(call.id, memoryProposal);
            described = this.describeMemoryProposal(memoryProposal);
          }
          const digest = computeActionDigest({
            tool: call.tool,
            targets: described.targets,
            body: described.body,
            provider,
            workspaceId,
            threadId,
            preconditions: described.preconditions,
          });
          // A Mission grant can run more tools without a card, but only for
          // the Mission, project, provider, and model it was given for.
          const auto =
            isAutoAllowed(profile, call.tool) ||
            this.missionGrantAllows(call.tool, memoryScope.scopeId, provider, model, {
              commandId: String((call.args as Record<string, unknown>).commandId ?? ''),
              packageJsonHash: hashContent(testContext.packageJsonRaw),
            });
          let approvedPending: PendingAgentAction | null = null;
          if (!auto) {
            const pending = createPendingAction(
              {
                tool: call.tool,
                targets: described.targets,
                body: described.body,
                provider,
                workspaceId,
                threadId,
                preconditions: described.preconditions,
              },
              this.agentGeneration,
            );
            // Bind to the exact digest computed above.
            if (pending.digest !== digest) {
              this.failAgentWithAudit(call, provider, threadId, workspaceId, 'policy', 'Digest mismatch.', 'Approval binding failed.');
              return 'policy-stop';
            }
            const choice = await this.waitForAgentDecision(pending, signal);
            if (choice.kind === 'cancelled') {
              // Cancellation is not a user rejection: report it as such.
              this.memory.discardProposals({ threadId });
              this.recordAgentAudit(pending, 'rejected', 'cancelled before approval');
              throw new DOMException('Aborted', 'AbortError');
            }
            if (choice.kind === 'stale') {
              if (memoryProposal !== null) {
                this.memory.discardProposals({ proposalId: memoryProposal.proposalId });
              }
              recordHostAction(call, described.targets, `did not run: approval invalidated (${choice.reason})`);
              extra.push({
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: call.id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } },
                ],
              });
              extra.push({
                role: 'tool',
                tool_call_id: call.id,
                content: truncateToolOutput(
                  `Approval invalidated before execution: ${choice.reason} No action ran. Re-read every affected file and re-propose the change.`,
                ),
              });
              this.status = 'A precondition changed; asking the Agent to re-read and re-propose…';
              await this.postState();
              continue agentSteps;
            }
            if (choice.kind !== 'approve') {
              approvedPending = null;
              this.memory.discardProposals({ threadId });
              const current = this.store.get(threadId);
              if (current) {
                this.store.save(appendErrorTurn(current, 'Action rejected by user. No changes were made.'));
              }
              this.status = 'Action rejected by user. No changes were made.';
              this.running = false;
              this.connection = 'cancelled';
              return 'rejected';
            }
            approvedPending = pending;
            // Re-derive immediately before spawn: package.json drift voids
            // the approval and requires re-proposal.
            if (call.tool === 'run_tests') {
              const reverified = await this.verifyBoundTestStillApproved(
                { body: described.body, preconditions: described.preconditions },
                workspaceId,
              );
              if (!reverified.ok) {
                this.failAgentWithAudit(call, provider, threadId, workspaceId, 'policy', reverified.error, 'Test definition changed since approval; re-propose the action.');
                return 'policy-stop';
              }
            }
          } else if (call.tool === 'run_tests') {
            // Workspace-full auto-run receives no prompt, so it must match
            // the same exact freshly-derived allowlist and precondition.
            const reverified = await this.verifyBoundTestStillApproved(
              { body: described.body, preconditions: described.preconditions },
              workspaceId,
            );
            if (!reverified.ok) {
              this.failAgentWithAudit(call, provider, threadId, workspaceId, 'policy', reverified.error, 'Test definition changed; re-propose the action.');
              return 'policy-stop';
            }
          }
          // Mission journal: written before the action runs, so an
          // interruption before its result is saved stays visible as uncertain.
          const journalId = `act-${digest.slice(0, 12)}`;
          if (this.activeMission !== null) {
            const journaled = await this.updateActiveMission((mission) =>
              journalAction(mission, 'started', journalId, `${call.tool} ${described.targets.join(', ')}`.slice(0, 200), Date.now()),
            );
            if (!journaled) {
              const detail = 'The Mission could not record this action before running it, so it did not run.';
              recordHostAction(call, described.targets, `did not run: ${detail}`);
              const current = this.store.get(threadId);
              if (current) {
                this.store.save(appendErrorTurn(current, detail));
              }
              this.status = detail;
              return 'policy-stop';
            }
          }
          let resultText: string;
          try {
            resultText =
              memoryProposal !== null
                ? await this.commitModelProposal(memoryProposal, approvedPending, threadId, provider)
                : await this.executeAgentTool(call, fs, testContext.allowlist, signal, workspaceId, heldCanonicalRoot);
          } catch (error) {
            if (
              (error instanceof Error && error.name === 'AbortError') ||
              (error instanceof DOMException && error.name === 'AbortError')
            ) {
              // Cancelled while running: its effect is unknown, so the journal
              // entry stays open (uncertain) on purpose.
              throw error;
            }
            const detail = error instanceof Error ? error.message : 'Tool failed.';
            if (this.activeMission !== null) {
              await this.updateActiveMission((mission) => journalAction(mission, 'finished', journalId, `did not complete: ${detail}`.slice(0, 200), Date.now()));
            }
            if (isRecoverableAgentToolError(detail)) {
              // Show that the approved/auto action did not run (or, for a
              // regex search, was stopped with no results), and why.
              const regexStopped = detail === REGEX_SEARCH_TIMEOUT_MESSAGE;
              const recorded = `${regexStopped ? 'stopped' : 'did not run'}: ${detail}`;
              this.recordAgentAudit(
                approvedPending ?? this.autoAuditRecord(call, described, provider, workspaceId, threadId, digest),
                approvedPending ? 'human' : 'profile-auto',
                recorded,
              );
              recordHostAction(call, described.targets, recorded);
              extra.push({
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: call.id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } },
                ],
              });
              extra.push({
                role: 'tool',
                tool_call_id: call.id,
                content: truncateToolOutput(
                  regexStopped
                    ? `${detail} Do not retry the same pattern; if the task required it, report this result.`
                    : `The tool did not run: ${detail} Inspect the current workspace state, then propose a corrected action.`,
                ),
              });
              this.status = regexStopped
                ? 'The regex search was stopped by its time budget; returning that to the Agent…'
                : `The workspace state differed; asking the Agent to inspect and retry…`;
              await this.postState();
              continue agentSteps;
            }
            this.failAgentWithAudit(call, provider, threadId, workspaceId, 'policy', detail, `Agent tool failed (${detail}).`);
            return 'policy-stop';
          }
          // Record the verified outcome (a content-free summary) for both
          // human-approved and profile-auto actions.
          this.recordAgentAudit(
            approvedPending ?? this.autoAuditRecord(call, described, provider, workspaceId, threadId, digest),
            approvedPending ? 'human' : 'profile-auto',
            summarizeToolResult(call.tool, resultText),
          );
          recordHostAction(call, described.targets, summarizeToolResult(call.tool, resultText));
          if (this.activeMission !== null) {
            await this.updateActiveMission((mission) => journalAction(mission, 'finished', journalId, summarizeToolResult(call.tool, resultText), Date.now()));
          }
          if (call.tool === 'run_tests') {
            const exit = /^exit=(\d+)/.exec(resultText);
            testRuns.push({
              commandId: String((call.args as Record<string, unknown>).commandId ?? ''),
              exitCode: exit ? Number(exit[1]) : null,
              writes: workspaceWrites,
              at: Date.now(),
              outputDigest: hashContent(resultText),
            });
          } else if (WORKSPACE_WRITE_TOOLS.has(call.tool)) {
            workspaceWrites += 1;
            described.targets.forEach((target) => changedFiles.add(target));
          }
          extra.push({
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: call.id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } },
            ],
          });
          const bindHint = call.tool === 'run_tests' ? this.bindArtifactHint(resultText, memoryScope.scopeId, changedFiles, String((call.args as Record<string, unknown>).commandId ?? '')) : '';
          let toolContent = truncateToolOutput(resultText) + bindHint;
          if (this.missionAuto !== null && MISSION_REPEAT_CHECK_TOOLS.has(call.tool)) {
            // The same read with the same result earlier in this run brings no new information.
            const key = `${call.tool} ${JSON.stringify(call.args)}`;
            const digest = hashContent(resultText);
            const earlier = seenReadResults.get(key);
            if (earlier !== undefined && earlier.digest === digest) {
              repeatedReads += 1;
              toolContent =
                call.tool === 'read_file'
                  ? `No new information: this is exactly what you read at step ${earlier.step} of this run (same sha256). Do not read it again; act on it now.\n\n${toolContent}`
                  : `No new information: identical to your ${call.tool} at step ${earlier.step} of this run, shown above. Do not repeat it; make the change, then run the test.`;
              this.status = `A repeated ${call.tool} returned nothing new; telling the Agent…`;
            } else {
              seenReadResults.set(key, { digest, step: step + 1 });
            }
          }
          extra.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
          // Show executed actions even when no prompt was required.
          await this.postState();
        }
      }
      return 'budget-stop';
    });
    if (outcome === 'done' || outcome === 'rejected') {
      this.running = false;
      this.connection = outcome === 'done' ? 'verified' : 'cancelled';
      this.status = outcome === 'done' ? 'Agent reply ready.' : this.status;
    } else if (outcome === 'stale') {
      this.running = false;
      this.connection = 'error';
      this.status = 'The workspace changed; the Agent run stopped.';
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendErrorTurn(current, 'The workspace changed; the Agent run stopped.'));
      }
    } else if (outcome === 'budget-stop') {
      this.running = false;
      this.connection = 'error';
      // Never leave a retry/correction status behind or the thread silent.
      const detail =
        `Agent stopped at its step budget (${MAX_AGENT_STEPS} model steps) without a final report. ` +
        (lastStepToolCallsRefused ? 'Tools were disabled on the last step, but the model still proposed one; it did not run. ' : '') +
        'Check Activity for the actions that ran.';
      this.status = detail;
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendErrorTurn(current, detail));
      }
    } else if (outcome === 'policy-stop') {
      this.running = false;
      this.connection = 'error';
    }
    // A proposal never outlives its run: an unapproved one is discarded.
    this.memory.discardProposals({ threadId });
    if (outcome !== 'done') {
      this.lastAgentOutcome = { threadId, outcome, hostRecord: [...hostRecord], report: '' };
    }
    const lastTestRun = testRuns.length > 0 ? testRuns[testRuns.length - 1] : undefined;
    const lastTest = lastTestRun ? { commandId: lastTestRun.commandId, exitCode: lastTestRun.exitCode } : null;
    this.agentStepNow = null;
    if (this.lastAgentOutcome !== null && this.lastAgentOutcome.threadId === threadId) {
      // Host observation for the Mission loop: what changed, as the files are now.
      const writes: Array<{ path: string; hash: string | null }> = [];
      for (const file of [...changedFiles].slice(0, 50)) {
        writes.push({ path: file, hash: await this.currentFileHash(fs, file) });
      }
      this.lastAgentOutcome = {
        ...this.lastAgentOutcome,
        lastTest,
        writes,
        wroteAfterLastTest: lastTestRun ? workspaceWrites > lastTestRun.writes : workspaceWrites > 0,
        repeatedReads,
      };
    }
    let capabilityReason: string | null = null;
    if (outcome === 'budget-stop') {
      capabilityReason = `the run reached its ${MAX_AGENT_STEPS}-step budget without finishing`;
    } else if (outcome === 'policy-stop' && stopKind === 'capability') {
      capabilityReason = this.status.slice(0, 300);
    } else if (outcome === 'done' && lastTest !== null && lastTest.exitCode !== 0) {
      capabilityReason = `the run ended with ${lastTest.commandId} still failing (exit ${lastTest.exitCode ?? 'unknown'})`;
    }
    // Not inside a Mission task (its own resume flow applies) nor inside a
    // cascade's verification run (no nested consultations).
    if (this.lastAgentOutcome !== null && this.lastAgentOutcome.threadId === threadId) {
      this.lastAgentOutcome = { ...this.lastAgentOutcome, capabilityReason };
    }
    if (provider === 'local' && capabilityReason !== null && this.cascadeVerification === null && this.activeMission === null) {
      this.offerConsult({ threadId, root: target.root, task: text, reason: capabilityReason, hostRecord: [...hostRecord], scopeId: memoryScope.scopeId });
    }
    void steps;
    void buildAgentSystemPrompt;
  }

  private failAgentWithAudit(
    call: ValidatedToolCall,
    provider: string,
    threadId: string,
    workspaceId: string,
    decision: 'policy' | 'rejected',
    auditResult: string,
    status: string,
  ): void {
    const described = describeAgentCall(call);
    const pending: PendingAgentAction = {
      tool: call.tool,
      targets: described.targets,
      body: described.body,
      provider,
      workspaceId,
      threadId,
      preconditions: described.preconditions,
      actionId: `blocked_${computeActionDigest({
        tool: call.tool,
        targets: described.targets,
        body: described.body,
        provider,
        workspaceId,
        threadId,
        preconditions: described.preconditions,
      }).slice(0, 16)}`,
      digest: computeActionDigest({
        tool: call.tool,
        targets: described.targets,
        body: described.body,
        provider,
        workspaceId,
        threadId,
        preconditions: described.preconditions,
      }),
      createdAt: Date.now(),
      generation: this.agentGeneration,
      used: true,
    };
    this.recordAgentAudit(pending, decision, auditResult);
    const current = this.store.get(threadId);
    if (current) {
      this.store.save(appendErrorTurn(current, status));
    }
    this.running = false;
    this.connection = 'error';
    this.status = status;
  }

  /** Audit a rejected proposal without ending the bounded Agent run. */
  private recordBlockedProposal(
    call: ValidatedToolCall,
    provider: string,
    threadId: string,
    workspaceId: string,
    reason: string,
  ): void {
    const described = describeAgentCall(call);
    const digest = computeActionDigest({
      tool: call.tool,
      targets: described.targets,
      body: described.body,
      provider,
      workspaceId,
      threadId,
      preconditions: described.preconditions,
    });
    this.recordAgentAudit(
      {
        tool: call.tool,
        targets: described.targets,
        body: described.body,
        provider,
        workspaceId,
        threadId,
        preconditions: described.preconditions,
        actionId: `blocked_${digest.slice(0, 16)}`,
        digest,
        createdAt: Date.now(),
        generation: this.agentGeneration,
        used: true,
      },
      'policy',
      reason,
    );
  }

  private autoAuditRecord(
    call: ValidatedToolCall,
    described: { targets: string[]; body: string; preconditions: Record<string, string> },
    provider: string,
    workspaceId: string,
    threadId: string,
    digest: string,
  ): PendingAgentAction {
    return {
      tool: call.tool,
      targets: described.targets,
      body: described.body,
      provider,
      workspaceId,
      threadId,
      preconditions: described.preconditions,
      actionId: `auto_${digest.slice(0, 16)}`,
      digest,
      createdAt: Date.now(),
      generation: this.agentGeneration,
      used: true,
    };
  }

  private pushAgentLog(profile: string, provider: string, threadId: string): void {
    void profile;
    void provider;
    void threadId;
  }

  private async checkWorkspaceStillHeld(expectedRoot: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isBoundRootStillOpen(expectedRoot)) {
      return { ok: false, error: 'The workspace changed.' };
    }
    return { ok: true };
  }

  private async checkCanonicalStillHeld(fs: AgentFs, heldCanonicalRoot: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const current = await this.heldCanonicalRoot(heldCanonicalRoot, fs);
      if (current !== heldCanonicalRoot) {
        return { ok: false, error: 'The workspace changed.' };
      }
    } catch {
      return { ok: false, error: 'The workspace changed.' };
    }
    return { ok: true };
  }

  private describeBoundTestCall(
    call: ValidatedToolCall,
    testContext: { allowlist: AllowedTestCommand[]; packageJsonRaw: string; scripts: Record<string, string> },
  ): { ok: true; described: { targets: string[]; body: string; preconditions: Record<string, string> } } | { ok: false; error: string } {
    const id = String((call.args as Record<string, unknown>).commandId ?? '');
    const command = findAllowedCommand(testContext.allowlist, id);
    if (!command || !isDerivedNpmTestCommand(command)) {
      return { ok: false, error: 'That test command is not allowlisted.' };
    }
    const scriptName = derivedNpmScriptName(command) as string;
    const scriptText = testContext.scripts[scriptName] ?? '';
    const described = describeBoundRunTestsAction(id, command, testContext.packageJsonRaw, scriptText, hashContent);
    return { ok: true, described: { targets: described.targets, body: described.body, preconditions: described.preconditions } };
  }

  private async verifyBoundTestStillApproved(
    approved: { body: string; preconditions: Record<string, string> },
    boundRoot?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const fresh = await this.testCommandContext(boundRoot);
    const parsedId = (() => {
      try {
        const body = JSON.parse(approved.body) as { commandId?: unknown };
        return typeof body.commandId === 'string' ? body.commandId : '';
      } catch {
        return '';
      }
    })();
    if (!parsedId) {
      return { ok: false, error: 'Test definition changed since approval; re-propose the action.' };
    }
    const freshCommand = findAllowedCommand(fresh.allowlist, parsedId);
    if (!freshCommand || !isDerivedNpmTestCommand(freshCommand)) {
      return { ok: false, error: 'Test definition changed since approval; re-propose the action.' };
    }
    const scriptName = derivedNpmScriptName(freshCommand) as string;
    const freshScript = fresh.scripts[scriptName] ?? '';
    const stillMatches = boundRunTestsStillMatches(
      approved.body,
      approved.preconditions,
      freshCommand,
      fresh.packageJsonRaw,
      freshScript,
      hashContent,
    );
    if (!stillMatches) {
      return { ok: false, error: 'Test definition changed since approval; re-propose the action.' };
    }
    return { ok: true };
  }

  /** Bind approval to both content and target existence. */
  private async bindPatchApprovalPreconditions(
    call: ValidatedToolCall,
    fs: AgentFs,
    canonicalRoot: string,
  ): Promise<Record<string, string>> {
    const files = ((call.args as Record<string, unknown>).files as Array<{
      path: string;
      expectedHash: string;
    }>) ?? [];
    const bound: Record<string, string> = {};
    for (const file of files) {
      const gate = checkAgentRelPath(file.path);
      if (!gate.ok) {
        throw new Error(gate.error);
      }
      const rel = (gate as { ok: true; rel: string }).rel;
      await guardFsPath(fs, rel, canonicalRoot);
      const stat = await fs.stat(rel);
      bound[rel] = stat.kind === 'missing'
        ? MISSING_FILE_PRECONDITION
        : file.expectedHash;
    }
    return bound;
  }

  // ----- Mission: persistent goal, tasks run one bounded Agent run at a time -----

  /** A strict Mission plan becomes a persistent Mission of the project. */
  private async createMissionFromPlan(threadId: string, plan: MissionPlan): Promise<void> {
    const scope = await this.memoryScopeForUi();
    if (!scope.ok) {
      this.status = `${this.status} The plan was not saved as a Mission: ${scope.error}`;
      return;
    }
    const created = await this.missions.create({
      scopeId: scope.scopeId,
      scopeLabel: scope.label,
      threadId,
      goal: plan.goal,
      steps: plan.steps.map((step) => ({ id: step.id, title: step.title, successCriterion: step.successCriterion })),
      decisions: this.memory.listCurrentDecisions(scope.scopeId).map((entry) => ({ key: entry.key, version: entry.version })),
    });
    this.status = created.ok
      ? `${this.status} Saved as a Mission with ${created.value.tasks.length} task(s); review it and authorize it in the Mission card of this thread.`
      : `${this.status} The plan was not saved as a Mission: ${created.error}`;
  }

  /**
   * Updates of the running Mission are queued so each one reads the
   * revision the previous one wrote; none can be lost to a race.
   */
  private updateActiveMission(change: (mission: MissionRecord) => MissionResult<MissionRecord>): Promise<boolean> {
    const next = this.missionUpdates.then(async () => {
      const active = this.activeMission;
      if (active === null) {
        return false;
      }
      const result = await this.missions.update(active.id, active.revision, change);
      if (result.ok) {
        this.activeMission = { id: result.value.id, revision: result.value.revision };
      }
      return result.ok;
    });
    this.missionUpdates = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Start (or resume) the current task of a Mission: one ordinary bounded
   * Agent run in the Mission's thread. The user starts every run; a resumed
   * task is told what already ran and never writes without approval.
   */
  async runMissionTask(missionId: string, expectedRevision: number): Promise<void> {
    if (this.running || this.agentRunner.isRunning) {
      this.status = 'A request is already running. Cancel it before starting a Mission task.';
      await this.postState();
      return;
    }
    await this.missionRecovery;
    const mission = this.missions.get(missionId);
    const scope = await this.memoryScopeForUi();
    if (mission === null || !scope.ok || mission.scopeId !== scope.scopeId) {
      this.status = 'That Mission does not belong to the open project.';
      await this.postState();
      return;
    }
    if (mission.revision !== expectedRevision) {
      this.status = 'The Mission changed; review it again before continuing.';
      await this.refreshMemoryView();
      await this.postState();
      return;
    }
    const allowed = canRunTask(mission);
    if (!allowed.ok) {
      this.status = allowed.error;
      await this.postState();
      return;
    }
    if (!this.store.get(mission.threadId)) {
      this.status = 'The Mission thread no longer exists.';
      await this.postState();
      return;
    }
    // The prompt is built before the run counter moves, so a task that ran
    // before is presented as resumed with what already happened.
    const resumed = allowed.value.runs > 0;
    const prompt = buildTaskPrompt(mission);
    const decisions = this.memory.listCurrentDecisions(scope.scopeId).map((entry) => ({ key: entry.key, version: entry.version }));
    const started = await this.missions.update(mission.id, mission.revision, (draft) => startTaskRun(draft, decisions, Date.now()));
    if (!started.ok) {
      this.status = started.error;
      await this.postState();
      return;
    }
    this.activeMission = { id: started.value.id, revision: started.value.revision };
    this.missionProfileCap = resumed ? 'safe-auto' : null;
    this.lastAgentOutcome = null;
    this.activeThreadId = mission.threadId;
    this.pinnedRunRoot = scope.root;
    this.hostPromptText = prompt.trim();
    try {
      await this.sendMessage(prompt, 'agent', providerToRuntime(this.settings.provider));
    } finally {
      this.pinnedRunRoot = null;
      this.hostPromptText = null;
      const outcome = this.lastAgentOutcome as { threadId: string; outcome: string; hostRecord: string[]; report: string } | null;
      const reason = this.status;
      if (outcome !== null && outcome.threadId === mission.threadId && outcome.outcome === 'done') {
        await this.updateActiveMission((draft) => completeTask(draft, outcome.hostRecord, outcome.report, Date.now()));
      } else {
        await this.updateActiveMission((draft) =>
          interrupt(draft, `The task run ended without completing: ${reason}`, Date.now(), outcome?.hostRecord ?? []),
        );
      }
      this.activeMission = null;
      this.missionProfileCap = null;
      await this.refreshMemoryView();
      await this.postState();
    }
  }

  // ----- Cascade: local stop → approved Meta advice → local verification -----

  /**
   * After a local capability stop: prepare the exact consultation payload
   * (no file contents) for the user to approve or dismiss. Nothing is sent.
   */
  private offerConsult(input: { threadId: string; root: string; task: string; reason: string; hostRecord: string[]; scopeId: string }): void {
    if (!this.settings.allowCloudEscalation) {
      this.status = `${this.status} Asking Meta for advice needs cloud escalation ON in Settings; nothing was sent.`;
      return;
    }
    const model = this.selectedCloudModel();
    const payload = buildConsultPayload({
      task: input.task,
      reason: input.reason,
      hostRecord: input.hostRecord,
      decisions: this.memory.listCurrentDecisions(input.scopeId).map((entry) => ({ key: entry.key, value: entry.value, version: entry.version })),
    });
    this.consultOffer = {
      threadId: input.threadId,
      root: input.root,
      task: input.task,
      reason: input.reason,
      payload,
      model,
      digest: consultDigest(payload, model, input.threadId),
      createdAt: Date.now(),
      generation: this.agentGeneration,
    };
    this.status = `${this.status} You can ask Meta ${model} for advice with the exact text shown, or dismiss.`;
  }

  /** Host-written record of the cascade, kept in the thread apart from model text. */
  private appendCascadeRecord(threadId: string, text: string, lines: string[]): void {
    const current = this.store.get(threadId);
    if (current) {
      this.store.save(appendAssistantTurn(current, text, undefined, lines.map((line) => `• ${line}`.slice(0, MAX_HOST_RECORD_LINE_LENGTH))));
    }
  }

  /** The user approved this exact payload: ask Meta once, then verify locally. */
  async approveConsult(digest: string): Promise<void> {
    const offer = this.consultOffer;
    const expired = offer !== null && Date.now() - offer.createdAt > CONSULT_OFFER_TTL_MS;
    if (offer === null || offer.digest !== digest || offer.generation !== this.agentGeneration || expired) {
      if (expired) {
        this.consultOffer = null;
      }
      this.status = 'That consultation approval is no longer valid. Nothing was sent.';
      await this.postState();
      return;
    }
    if (this.running || this.missionRunner.isRunning || this.chatRunner.isRunning || this.agentRunner.isRunning) {
      this.status = 'A request is already running. Cancel it or wait before sending to Meta. Nothing was sent.';
      await this.postState();
      return;
    }
    if (!this.settings.allowCloudEscalation) {
      this.status = 'Cloud escalation is OFF. Nothing was sent.';
      await this.postState();
      return;
    }
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      this.status = 'No Meta Model API key is stored. Save one in Settings or choose a local runtime.';
      await this.postState();
      return;
    }
    // One use: from here on this offer can never be approved again.
    this.consultOffer = null;
    const lines = [
      `cascade: the local run stopped for a capability reason: ${offer.reason}`,
      `cascade: you approved sending ${offer.payload.length} characters to Meta ${offer.model} (digest ${offer.digest.slice(0, 12)}…); no file contents were included`,
    ];
    this.activeThreadId = offer.threadId;
    this.running = true;
    this.connection = 'working';
    this.status = `Asking Meta ${offer.model} for advice with the approved text only…`;
    await this.postState();
    let advice: CascadeAdvice;
    try {
      const generation = await this.snapshotGeneration('cloud');
      const { request } = this.generationRequest(generation, { messages: [{ role: 'user', content: offer.payload }] });
      const result = await this.chatRunner.start(async ({ signal }) =>
        createCascadeAdvice({ apiKey, model: offer.model, payload: offer.payload, schema: cascadeAdviceSchema, generation: request, signal }),
      );
      this.recordUsage('cloud', result.usage);
      lines.push(`cascade: Meta ${offer.model} answered (in ${result.usage.inputTokens} / out ${result.usage.outputTokens} tokens)`);
      advice = validateCascadeAdvice(JSON.parse(result.content) as unknown);
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Unknown error.';
      const detail = redactKeyFromText(raw, apiKey).replace(/\s+/g, ' ').trim().slice(0, 200) || 'Unknown error.';
      const cancelled = error instanceof Error && error.name === 'AbortError';
      lines.push(
        cancelled
          ? 'cascade: you cancelled the consultation; the local verification run was not started'
          : `cascade: the advice was not used (${detail}); the local verification run was not started`,
      );
      this.running = false;
      this.connection = cancelled ? 'cancelled' : 'error';
      this.status = cancelled ? 'Request cancelled.' : `The Meta advice could not be used (${detail}). Nothing else was sent and nothing changed.`;
      this.appendCascadeRecord(offer.threadId, 'Cascade stopped before the local verification run.', lines);
      await this.postState();
      return;
    }
    lines.push(`cascade: advice kept only as untrusted data (${advice.steps.length} step(s), ${advice.checks.length} check(s)); it wrote nothing`);
    this.running = false;
    // The local verification run: a normal Agent run in the same project,
    // with the advice quoted as data in a host-written prompt.
    const prompt = buildVerificationPrompt({ task: offer.task, reason: offer.reason, model: offer.model, advice }).slice(0, 7900);
    this.cascadeVerification = { threadId: offer.threadId };
    this.pinnedRunRoot = offer.root;
    this.hostPromptText = prompt.trim();
    this.lastAgentOutcome = null;
    try {
      await this.sendMessage(prompt, 'agent', providerToRuntime('local'));
    } finally {
      this.pinnedRunRoot = null;
      this.hostPromptText = null;
      this.cascadeVerification = null;
    }
    const outcome = this.lastAgentOutcome as RameCodeViewProvider['lastAgentOutcome'];
    if (outcome !== null && outcome.threadId === offer.threadId) {
      const test = outcome.lastTest ? `${outcome.lastTest.commandId} exit=${outcome.lastTest.exitCode ?? 'unknown'}` : 'no test ran';
      lines.push(`cascade: local verification run ${outcome.outcome === 'done' ? 'finished' : `stopped (${outcome.outcome})`}; last test: ${test}`);
    } else {
      lines.push(`cascade: the local verification run did not start (${this.status.slice(0, 160)})`);
    }
    lines.push('cascade: no calibrated policy chose these steps; you approved each one');
    const verified = outcome !== null && outcome.outcome === 'done' && outcome.lastTest?.exitCode === 0;
    this.appendCascadeRecord(
      offer.threadId,
      verified ? 'Cascade finished: the local verification run passed its test.' : 'Cascade finished without a passing local test.',
      lines,
    );
    await this.postState();
  }

  /** The user declined: nothing is sent, and the decision is recorded. */
  async dismissConsult(): Promise<void> {
    const offer = this.consultOffer;
    this.consultOffer = null;
    if (offer !== null) {
      this.appendCascadeRecord(offer.threadId, 'Cascade not used.', [
        `cascade: the local run stopped for a capability reason: ${offer.reason}`,
        'cascade: you dismissed the consultation; nothing was sent to Meta',
      ]);
    }
    this.status = 'Consultation dismissed. Nothing was sent to Meta.';
    await this.postState();
  }

  // ----- Autonomous Mission (R9): bounded internal runs chained by the host -----

  /** Hash of one workspace file now (null when missing or unreadable). */
  private async currentFileHash(fs: AgentFs, file: string): Promise<string | null> {
    const gate = checkAgentRelPath(file);
    if (!gate.ok) {
      return null;
    }
    try {
      const rel = (gate as { ok: true; rel: string }).rel;
      const st = await fs.stat(rel);
      return st.kind === 'file' ? hashContent(await fs.readText(rel)) : null;
    } catch {
      return null;
    }
  }

  /**
   * A target frozen by the running Mission's acceptance check (checked by
   * hash), or inside node_modules (only blocked for RAME's own tools, not
   * hashed: scripts, other processes, or the user can still change it).
   */
  private frozenTarget(targets: readonly string[]): string | null {
    const auto = this.missionAuto;
    if (auto === null) {
      return null;
    }
    const frozen = frozenPaths(this.missions.get(auto.missionId));
    if (frozen.length === 0) {
      return null;
    }
    for (const target of targets) {
      const gate = checkAgentRelPath(target);
      const rel = gate.ok ? (gate as { ok: true; rel: string }).rel : target;
      if (frozen.includes(rel) || rel === 'node_modules' || rel.startsWith('node_modules/')) {
        return rel;
      }
    }
    return null;
  }

  /**
   * The user's acceptance check, run by the host itself (never the model):
   * every frozen file and package.json must still have its granted hash, and
   * the granted command must exit 0.
   */
  private async runAcceptance(
    mission: MissionRecord,
    root: string,
    fs: AgentFs,
  ): Promise<{ passed: boolean; summary: string; output: string; tampered: boolean }> {
    const acceptance = mission.grant?.acceptance ?? null;
    if (acceptance === null) {
      return { passed: true, summary: 'no acceptance check', output: '', tampered: false };
    }
    for (const file of acceptance.files) {
      if ((await this.currentFileHash(fs, file.path)) !== file.hash) {
        return { passed: false, summary: `${file.path} changed since the Mission was authorized`, output: '', tampered: true };
      }
    }
    if ((await this.currentFileHash(fs, 'package.json')) !== acceptance.packageJsonHash) {
      return { passed: false, summary: 'package.json changed since the Mission was authorized', output: '', tampered: true };
    }
    const command = (await this.testCommandContext(root)).allowlist.find((entry) => entry.id === acceptance.commandId);
    if (!command) {
      return { passed: false, summary: `${acceptance.commandId} is no longer allowlisted`, output: '', tampered: true };
    }
    const controller = new AbortController();
    this.acceptanceController = controller;
    try {
      const output = await this.runAllowlistedTest(command, controller.signal, root);
      const exit = /^exit=(\d+)/.exec(output);
      const code = exit ? Number(exit[1]) : null;
      return { passed: code === 0, summary: `${acceptance.commandId} exit=${code ?? 'unknown'} with every frozen file intact`, output, tampered: false };
    } finally {
      this.acceptanceController = null;
    }
  }

  /** Whether the running Mission's grant covers this tool for this exact run. */
  private missionGrantAllows(
    tool: string,
    scopeId: string,
    provider: string,
    model: string,
    test: { commandId: string; packageJsonHash: string },
  ): boolean {
    const auto = this.missionAuto;
    if (auto === null || this.activeMission === null || auto.missionId !== this.activeMission.id || auto.holdAutonomy) {
      return false;
    }
    return grantAllows(this.missions.get(auto.missionId), { missionId: auto.missionId, scopeId, provider, model }, tool, test);
  }

  private isLeaseAlive(lease: MissionLease): boolean {
    if (lease.pid === process.pid) {
      return isLiveMissionLease(lease.token);
    }
    try {
      process.kill(lease.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /**
   * The user authorizes the Mission once (mode, local model, optional Meta
   * consultations) and starts it. Nothing runs before this explicit step.
   */
  async startMission(
    missionId: string,
    expectedRevision: number,
    mode: MissionGrant['mode'],
    escalation: { maxConsultations: number } | null,
    trustedProject = false,
    acceptance: { commandId: string; files: string[] } | null = null,
  ): Promise<void> {
    const mission = this.missions.get(missionId);
    const scope = await this.memoryScopeForUi();
    if (mission === null || !scope.ok || mission.scopeId !== scope.scopeId) {
      this.status = 'That Mission does not belong to the open project.';
      await this.postState();
      return;
    }
    if (escalation !== null && !this.settings.allowCloudEscalation) {
      this.status = 'Meta consultations need cloud escalation ON in Settings. Nothing was authorized.';
      await this.postState();
      return;
    }
    // The test commands are bound to the exact package.json they come from now.
    const testContext = await this.testCommandContext(scope.root);
    // The user's acceptance check is frozen now: its command and its files by hash.
    let frozen: { commandId: string; packageJsonHash: string; files: Array<{ path: string; hash: string }> } | null = null;
    if (acceptance !== null) {
      const files: Array<{ path: string; hash: string }> = [];
      // Also frozen, when present: what decides how the check runs.
      const environment: string[] = [];
      for (const file of ACCEPTANCE_ENVIRONMENT_FILES) {
        if ((await this.currentFileHash(scope.fs, file)) !== null && !acceptance.files.includes(file)) {
          environment.push(file);
        }
      }
      for (const file of [...acceptance.files, ...environment]) {
        const hash = await this.currentFileHash(scope.fs, file);
        const gate = checkAgentRelPath(file);
        if (hash === null || !gate.ok) {
          this.status = `The acceptance file ${file.slice(0, 120)} does not exist in this project. Nothing was authorized.`;
          await this.postState();
          return;
        }
        files.push({ path: (gate as { ok: true; rel: string }).rel, hash });
      }
      if (!testContext.allowlist.some((entry) => entry.id === acceptance.commandId) || testContext.packageJsonRaw.length === 0) {
        this.status = `The acceptance command ${acceptance.commandId.slice(0, 60)} is not an allowlisted test of this project. Nothing was authorized.`;
        await this.postState();
        return;
      }
      frozen = { commandId: acceptance.commandId, packageJsonHash: hashContent(testContext.packageJsonRaw), files };
    }
    const granted = await this.missions.update(missionId, expectedRevision, (draft) =>
      grantMission(
        draft,
        {
          model: this.generationModel('local'),
          mode,
          escalation: escalation === null ? null : { model: this.selectedCloudModel(), maxConsultations: escalation.maxConsultations, maxOutputTokens: MISSION_CONSULT_OUTPUT_TOKENS },
          tests:
            mode === 'autonomous-workspace'
              ? {
                  trustedProject: trustedProject,
                  packageJsonHash: testContext.packageJsonRaw.length > 0 ? hashContent(testContext.packageJsonRaw) : '',
                  commandIds: testContext.allowlist.map((entry) => entry.id),
                }
              : null,
          acceptance: frozen,
        },
        Date.now(),
      ),
    );
    if (!granted.ok) {
      this.status = granted.error;
      await this.refreshMemoryView();
      await this.postState();
      return;
    }
    this.missionStarting = missionId;
    try {
      if (this.missionStartRequest !== null && this.missionStartRequest.missionId === missionId && this.missionStartRequest.state === 'authorizing') {
        // The grant is saved: confirm the click before the first internal run.
        this.missionStartRequest = { ...this.missionStartRequest, state: 'started' };
        this.status = 'Mission started.';
        await this.refreshMemoryView();
        await this.postState();
      }
      await this.runMissionAutonomous(missionId, granted.value.revision);
    } finally {
      this.missionStarting = null;
    }
  }

  /**
   * One click of "Authorize and start": confirmed at once as authorizing,
   * then as started or failed. While one start is being authorized, another
   * (a double click, a second message) changes nothing.
   */
  private async requestMissionStart(requestId: string, start: () => Promise<void>, missionId: string): Promise<void> {
    const current = this.missionStartRequest;
    if (current !== null && (current.state === 'authorizing' || current.requestId === requestId)) {
      await this.postState();
      return;
    }
    if (this.missionAuto !== null && this.missionAuto.missionId === missionId) {
      await this.postState();
      return;
    }
    this.missionStartRequest = { requestId, missionId, state: 'authorizing', error: '' };
    this.status = 'Authorizing the Mission…';
    await this.refreshMemoryView();
    await this.postState();
    try {
      await start();
    } finally {
      const after = this.missionStartRequest;
      if (after !== null && after.requestId === requestId && after.state === 'authorizing') {
        // Nothing was granted: the reason is the host's own status.
        this.missionStartRequest = { ...after, state: 'failed', error: this.status };
        await this.refreshMemoryView();
        await this.postState();
      }
    }
  }

  /** Continue an authorized Mission (after a pause, a block, or a reload). */
  async resumeMission(missionId: string, expectedRevision: number): Promise<void> {
    const mission = this.missions.get(missionId);
    if (mission !== null && mission.grant === null) {
      this.status = 'Authorize the Mission before running it.';
      await this.postState();
      return;
    }
    if (mission !== null && (mission.status === 'paused' || mission.status === 'blocked')) {
      // An explicit resume makes it runnable again; the loop re-checks everything.
      const reopened = await this.missions.update(missionId, expectedRevision, (draft) => {
        draft.status = 'interrupted';
        draft.note = 'Resumed by you.';
        if (draft.auto !== null) {
          draft.auto.noProgressStreak = 0;
        }
        return { ok: true, value: draft };
      });
      if (!reopened.ok) {
        this.status = reopened.error;
        await this.postState();
        return;
      }
      expectedRevision = reopened.value.revision;
    }
    this.missionStarting = missionId;
    try {
      await this.runMissionAutonomous(missionId, expectedRevision);
    } finally {
      this.missionStarting = null;
    }
  }

  /** Pause (resumable) or cancel (final) at once: the current internal run is stopped. */
  async stopMission(missionId: string, kind: 'pause' | 'cancel'): Promise<void> {
    if (this.missionAuto !== null && this.missionAuto.missionId === missionId) {
      this.missionAuto.stop = kind;
      this.cancelRequest();
      this.status = kind === 'pause' ? 'Pausing the Mission…' : 'Cancelling the Mission…';
      await this.postState();
      return;
    }
    const mission = this.missions.get(missionId);
    if (mission === null) {
      this.status = 'That Mission no longer exists or could not be read.';
      await this.postState();
      return;
    }
    const result = await this.missions.update(missionId, mission.revision, (draft) =>
      kind === 'pause' ? pauseMission(draft, Date.now()) : cancelMission(draft, Date.now()),
    );
    this.status = result.ok ? result.value.note : result.error;
    await this.refreshMemoryView();
    await this.postState();
  }

  /**
   * The loop: one bounded Agent run (12 steps) at a time, a checkpoint after
   * each, and the next run started by the host until the goal is verified,
   * an approval is pending, the user stops it, or the host sees no progress.
   */
  async runMissionAutonomous(missionId: string, expectedRevision: number): Promise<void> {
    if (this.running || this.agentRunner.isRunning || this.missionAuto !== null) {
      this.status = 'A request is already running. Cancel it before starting a Mission.';
      await this.postState();
      return;
    }
    await this.missionRecovery;
    const scope = await this.memoryScopeForUi();
    let mission = this.missions.get(missionId);
    if (mission === null || !scope.ok || mission.scopeId !== scope.scopeId) {
      this.status = 'That Mission does not belong to the open project.';
      await this.postState();
      return;
    }
    if (leaseHeldByOther(mission, this.leaseToken, (lease) => this.isLeaseAlive(lease))) {
      this.status = 'This Mission is running in another VS Code window.';
      await this.postState();
      return;
    }
    if (mission.revision !== expectedRevision) {
      this.status = 'The Mission changed; review it again before continuing.';
      await this.refreshMemoryView();
      await this.postState();
      return;
    }
    if (mission.grant === null || mission.grant.model !== this.generationModel('local')) {
      this.status = 'Authorize the Mission for the current local model before running it.';
      await this.postState();
      return;
    }
    if (!this.store.get(mission.threadId)) {
      this.status = 'The Mission thread no longer exists.';
      await this.postState();
      return;
    }
    const leased = await this.missions.update(missionId, expectedRevision, (draft) => {
      if (leaseHeldByOther(draft, this.leaseToken, (lease) => this.isLeaseAlive(lease))) {
        return { ok: false, error: 'This Mission is running in another VS Code window.' };
      }
      draft.lease = { pid: process.pid, token: this.leaseToken, at: Date.now() };
      return { ok: true, value: draft };
    });
    if (!leased.ok) {
      this.status = leased.error;
      await this.postState();
      return;
    }
    registerLiveMissionLease(this.leaseToken);
    mission = leased.value;
    // After an interruption with an unknown result, the first run checks
    // before any automatic write: its writes still ask.
    this.missionAuto = { missionId, stop: null, holdAutonomy: uncertainActions(mission).length > 0 };
    const testCommands = (await this.testCommandContext(scope.root)).allowlist.map((entry) => entry.id);
    let ended = '';
    try {
      for (;;) {
        mission = this.missions.get(missionId);
        if (mission === null) {
          ended = 'The Mission could not be read.';
          break;
        }
        if (this.missionAuto.stop !== null || ['paused', 'cancelled', 'blocked', 'completed', 'failed'].includes(mission.status)) {
          break;
        }
        const allowed = canRunTask(mission);
        if (!allowed.ok) {
          if (currentTask(mission) !== null) {
            await this.missions.update(mission.id, mission.revision, (draft) => blockMission(draft, allowed.error, Date.now()));
          }
          break;
        }
        // The files already read, with their hash as they are now, for the operational summary.
        const fileHashes: Record<string, string | null> = {};
        for (const file of filesReadInMission(mission)) {
          fileHashes[file] = await this.currentFileHash(scope.fs, file);
        }
        const prompt = buildAutoTaskPrompt(mission, testCommands, fileHashes);
        const decisions = this.memory.listCurrentDecisions(scope.scopeId).map((entry) => ({ key: entry.key, version: entry.version }));
        const started = await this.missions.update(mission.id, mission.revision, (draft) => {
          const result = startTaskRun(draft, decisions, Date.now());
          // Advice is quoted in exactly one internal run.
          if (result.ok && result.value.auto !== null) {
            result.value.auto.pendingAdvice = '';
          }
          return result;
        });
        if (!started.ok) {
          ended = started.error;
          break;
        }
        this.activeMission = { id: started.value.id, revision: started.value.revision };
        this.missionProfileCap = null;
        this.lastAgentOutcome = null;
        this.activeThreadId = mission.threadId;
        this.pinnedRunRoot = scope.root;
        this.hostPromptText = prompt.trim();
        try {
          await this.sendMessage(prompt, 'agent', providerToRuntime('local'));
        } finally {
          this.pinnedRunRoot = null;
          this.hostPromptText = null;
        }
        if (this.disposed) {
          // This window is going away (a reload): like a killed process, it
          // writes nothing more; the next window recovers the Mission.
          break;
        }
        this.missionAuto.holdAutonomy = false;
        const stop = this.missionAuto.stop as 'pause' | 'cancel' | null;
        if (stop !== null) {
          await this.updateActiveMission((draft) => (stop === 'pause' ? pauseMission(draft, Date.now()) : cancelMission(draft, Date.now())));
          break;
        }
        const outcome = this.lastAgentOutcome as RameCodeViewProvider['lastAgentOutcome'];
        if (outcome === null || outcome.threadId !== mission.threadId || outcome.outcome === 'rejected' || outcome.outcome === 'stale') {
          const reason = outcome === null ? this.status : outcome.outcome === 'rejected' ? 'You rejected an action.' : this.status;
          await this.updateActiveMission((draft) => interrupt(draft, `The internal run ended without a result: ${reason}`, Date.now(), outcome?.hostRecord ?? []));
          break;
        }
        const current = this.missions.get(missionId);
        const observation: RunObservation = {
          outcome: outcome.outcome,
          writes: outcome.writes ?? [],
          lastTest: outcome.lastTest ?? null,
          wroteAfterLastTest: outcome.wroteAfterLastTest ?? false,
          uncertain: current !== null ? uncertainActions(current).length : 1,
          hostRecord: outcome.hostRecord,
          report: outcome.report,
          repeatedReads: outcome.repeatedReads ?? 0,
        };
        let next = 'continue' as 'complete-task' | 'continue' | 'blocked';
        let assessment = null as RunAssessment | null;
        const recorded = await this.updateActiveMission((draft) => {
          assessment = assessRun(draft, observation);
          const result = recordRun(draft, observation, assessment, Date.now());
          if (!result.ok) {
            return result;
          }
          next = result.value.next;
          // Back to a runnable state between internal runs.
          result.value.mission.status = 'active';
          return { ok: true, value: result.value.mission };
        });
        if (!recorded) {
          ended = 'The Mission checkpoint could not be saved; stopping before the next run.';
          break;
        }
        if (next === 'complete-task') {
          const latest = this.missions.get(missionId);
          const lastTask = latest !== null && latest.tasks.filter((task) => task.status === 'pending').length === 0;
          if (latest !== null && lastTask && latest.grant?.acceptance) {
            // Before the Mission can end, the host runs the user's frozen check.
            this.status = `Running the acceptance check ${latest.grant.acceptance.commandId}…`;
            await this.postState();
            const acceptance = await this.runAcceptance(latest, scope.root, scope.fs);
            if (acceptance.tampered) {
              // The criteria themselves changed: no run of the agent can fix that.
              await this.updateActiveMission((draft) => blockMission(draft, `the acceptance check can no longer be trusted: ${acceptance.summary}.`, Date.now()));
              break;
            }
            if (this.missionAuto.stop !== null) {
              const stopNow = this.missionAuto.stop;
              await this.updateActiveMission((draft) => (stopNow === 'pause' ? pauseMission(draft, Date.now()) : cancelMission(draft, Date.now())));
              break;
            }
            let decision = 'continue' as 'complete-task' | 'continue' | 'blocked';
            await this.updateActiveMission((draft) => {
              const result = recordAcceptance(draft, acceptance, Date.now());
              if (!result.ok) {
                return result;
              }
              decision = result.value.next;
              return { ok: true, value: result.value.mission };
            });
            if (decision === 'blocked') {
              await this.updateActiveMission((draft) => blockMission(draft, `the user's acceptance check kept failing (${acceptance.summary}).`, Date.now()));
              break;
            }
            if (decision === 'continue') {
              continue;
            }
          }
          await this.updateActiveMission((draft) => completeTask(draft, [], outcome.report || 'verified by the host', Date.now()));
          continue;
        }
        if (next === 'blocked') {
          const summary = assessment?.summary ?? '';
          await this.updateActiveMission((draft) =>
            blockMission(draft, `${MAX_NO_PROGRESS_RUNS} internal runs in a row without verifiable progress, or the run ceiling was reached (last: ${summary}).`, Date.now()),
          );
          break;
        }
        if (outcome.capabilityReason) {
          await this.consultForMission(missionId, outcome.capabilityReason, outcome.hostRecord, scope.scopeId);
        }
      }
    } finally {
      this.activeMission = null;
      this.missionProfileCap = null;
      const finalMission = this.disposed ? null : this.missions.get(missionId);
      if (finalMission !== null && finalMission.lease?.token === this.leaseToken) {
        await this.missions.update(missionId, finalMission.revision, (draft) => {
          draft.lease = null;
          return { ok: true, value: draft };
        });
      }
      unregisterLiveMissionLease(this.leaseToken);
      this.missionAuto = null;
      const done = this.disposed ? null : this.missions.get(missionId);
      if (done !== null) {
        this.appendMissionReport(done);
        this.status = ended || done.note;
      }
      await this.refreshMemoryView();
      await this.postState();
    }
  }

  /**
   * One host-written entry for the whole Mission, apart from the internal
   * runs. The final report is written only for a completed Mission and, when
   * the user froze an acceptance check, only after the host's own run of it
   * exited 0; any other stop gets a short status note instead.
   */
  private appendMissionReport(mission: MissionRecord): void {
    const entry = buildMissionReportEntry(mission);
    if (entry === null) {
      return;
    }
    const current = this.store.get(mission.threadId);
    if (current) {
      this.store.save(appendAssistantTurn(current, entry.title, undefined, entry.hostRecord));
    }
  }

  /**
   * Mission escalation: only within the grant (model, count, output budget)
   * and only after a capability stop. The advice is quoted as untrusted data
   * in the next internal run; it never acts.
   */
  private async consultForMission(missionId: string, reason: string, hostRecord: string[], scopeId: string): Promise<void> {
    const mission = this.missions.get(missionId);
    const grant = mission?.grant ?? null;
    if (mission === null || grant === null || grant.escalation === null || grant.escalation.used >= grant.escalation.maxConsultations || !this.settings.allowCloudEscalation) {
      return;
    }
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      return;
    }
    const escalation = grant.escalation;
    const task = currentTask(mission);
    const payload = buildConsultPayload({
      task: `${mission.goal}\nCurrent task: ${task?.title ?? ''}`,
      reason,
      hostRecord,
      decisions: this.memory.listCurrentDecisions(scopeId).map((entry) => ({ key: entry.key, value: entry.value, version: entry.version })),
    });
    // Counted before the call: a consultation that fails still used its slot.
    const counted = await this.missions.update(missionId, mission.revision, (draft) => {
      if (draft.grant?.escalation) {
        draft.grant.escalation.used += 1;
      }
      return { ok: true, value: draft };
    });
    if (!counted.ok) {
      return;
    }
    if (this.activeMission !== null && this.activeMission.id === missionId) {
      this.activeMission = { id: counted.value.id, revision: counted.value.revision };
    }
    let note: string;
    let advice = '';
    try {
      const result = await this.chatRunner.start(async ({ signal }) =>
        createCascadeAdvice({
          apiKey,
          model: escalation.model,
          payload,
          schema: cascadeAdviceSchema,
          generation: { maxCompletionTokens: escalation.maxOutputTokens, reasoning: null, reasoningParam: null },
          signal,
        }),
      );
      this.recordUsage('cloud', result.usage);
      const parsed = validateCascadeAdvice(JSON.parse(result.content) as unknown);
      advice = formatAdvisory(escalation.model, parsed);
      note = `Meta ${escalation.model} consulted (${escalation.used + 1}/${escalation.maxConsultations}, in ${result.usage.inputTokens} / out ${result.usage.outputTokens} tokens); advice kept as untrusted data`;
    } catch (error) {
      const detail = redactKeyFromText(error instanceof Error ? error.message : 'Unknown error.', apiKey).replace(/\s+/g, ' ').slice(0, 160);
      note = `Meta ${escalation.model} consultation ${escalation.used + 1}/${escalation.maxConsultations} not used (${detail})`;
    }
    await this.updateActiveMission((draft) => {
      const current = currentTask(draft);
      if (current) {
        draft.evidence.push({ taskId: current.id, kind: 'note', text: note.slice(0, 300), at: Date.now() });
      }
      if (draft.auto !== null) {
        draft.auto.pendingAdvice = advice.slice(0, 4000);
      }
      return { ok: true, value: draft };
    });
  }

  // ----- Project memory (host-controlled; the model only reads and proposes) -----

  /**
   * The project Settings memory acts on: the open folder chosen in Settings
   * or used by the latest Agent run, else the single open folder. Never a
   * model path; a folder chosen in the view is accepted only when it is
   * exactly one of the open workspace folders.
   */
  private async memoryScopeForUi(): Promise<{ ok: true; root: string; scopeId: string; label: string; fs: AgentFs } | { ok: false; error: string }> {
    let root: string | null = null;
    if (this.memoryRoot !== null && this.isBoundRootStillOpen(this.memoryRoot)) {
      root = this.memoryRoot;
    } else if (this.agentRunWorkspace !== null && this.isBoundRootStillOpen(this.agentRunWorkspace.root)) {
      root = this.agentRunWorkspace.root;
    } else {
      const single = this.heldWorkspaceRoot();
      root = single.ok ? single.root : null;
    }
    if (root === null) {
      return {
        ok: false,
        error: this.listOpenWorkspaceFolders().length > 1
          ? 'Several folders are open. Choose the project above to manage its memory.'
          : 'Open a folder to manage its project memory.',
      };
    }
    const fs = this.agentFsFor(root);
    try {
      const canonical = await this.heldCanonicalRoot(root, fs);
      return { ok: true, root, scopeId: scopeIdForRoot(canonical), label: path.basename(root), fs };
    } catch {
      return { ok: false, error: 'The project folder could not be resolved.' };
    }
  }

  /** Recompute what Settings shows about memory (decisions, history, files, pending). */
  async refreshMemoryView(): Promise<void> {
    const scope = await this.memoryScopeForUi();
    const folders = this.listOpenWorkspaceFolders().map((folder) => ({ name: folder.name, path: folder.path }));
    if (!scope.ok) {
      this.memoryView = { project: null, readable: true, decisions: [], history: [], artifacts: [], corruptKeys: [], pending: null, note: scope.error, mission: null, folders, selectedPath: null };
      return;
    }
    await this.missionRecovery;
    const testContext = await this.testCommandContext(scope.root);
    this.missionTestCommands = testContext.allowlist.map((entry) => entry.id);
    const environmentFiles: string[] = [];
    for (const file of ACCEPTANCE_ENVIRONMENT_FILES) {
      if ((await this.currentFileHash(scope.fs, file)) !== null) {
        environmentFiles.push(file);
      }
    }
    this.missionSetup = {
      scopeId: scope.scopeId,
      testCommands: this.missionTestCommands,
      candidates: await listAcceptanceCandidates(scope.fs),
      environmentFiles,
      packageJsonHash: testContext.packageJsonRaw.length > 0 ? hashContent(testContext.packageJsonRaw) : '',
    };
    const readout = this.memory.readScope(scope.scopeId);
    const artifacts = this.memory.artifactStatuses(scope.scopeId, await this.liveArtifactHashes(scope.scopeId, scope.fs));
    const pending = this.memoryPending !== null && this.memoryPending.proposal.scopeId === scope.scopeId ? this.memoryPending : null;
    this.memoryView = {
      project: scope.label,
      readable: readout.readable,
      decisions: readout.current.map((entry) => ({
        key: entry.key,
        value: JSON.stringify(entry.value),
        version: entry.version,
        source: entry.provenance.source,
        provider: entry.provenance.provider,
        createdAt: entry.createdAt,
      })),
      history: readout.current.map((entry) => ({
        key: entry.key,
        versions: this.memory.getDecisionHistory(scope.scopeId, entry.key).map((version) => ({
          version: version.version,
          value: version.op === 'delete' ? '(removed)' : JSON.stringify(version.value),
          createdAt: version.createdAt,
          source: version.provenance.source,
          provider: version.provenance.provider,
          reason: version.provenance.reason,
        })),
      })),
      artifacts: artifacts.map((entry) => ({
        path: entry.path,
        decisionKey: entry.decisionKey,
        decisionVersion: entry.decisionVersion,
        status: entry.status,
        detail: entry.detail,
      })),
      corruptKeys: readout.corruptKeys,
      pending: pending
        ? { actionId: pending.action.actionId, digest: pending.action.digest, text: describeProposal(pending.proposal) }
        : null,
      note: readout.readable ? '' : 'Project memory could not be read; RAME Code will not overwrite it.',
      mission: this.missionView(scope.scopeId, readout.current),
      folders,
      selectedPath: scope.root,
    };
  }

  /**
   * Settings: the user chooses which open folder's memory to show. Only an
   * exact open workspace folder is accepted; a pending card must be
   * answered first so it can never be approved against another project.
   */
  async selectMemoryProject(rawPath: string): Promise<void> {
    const chosen = validateChosenWorkspace(rawPath, this.listOpenWorkspaceFolders());
    if (chosen === null) {
      this.status = 'That folder is not open in this window.';
    } else if (this.memoryPending !== null) {
      this.status = 'Approve or reject the pending memory change first.';
    } else if (this.activeMission !== null) {
      this.status = 'A Mission task is running. Wait for it to finish before changing the project.';
    } else {
      this.memoryRoot = chosen;
      this.status = `Project memory: ${path.basename(chosen)}.`;
    }
    await this.refreshMemoryView();
    await this.postState();
  }

  /** Interface language of the view; host messages for the model stay English. */
  async setLanguage(language: ViewLanguage): Promise<void> {
    this.settings = { ...this.settings, language };
    this.persistSettings();
    await this.postState();
  }

  private missionView(scopeId: string, current: Array<{ key: string; version: number }>): MissionView | null {
    const mission = this.missions
      .list()
      .filter((entry) => entry.scopeId === scopeId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!mission) {
      return null;
    }
    return buildMissionView(mission, current, this.missionViewRuntime(mission));
  }

  private isAuthorizing(missionId: string): boolean {
    return this.missionStartRequest !== null && this.missionStartRequest.missionId === missionId && this.missionStartRequest.state === 'authorizing';
  }

  /**
   * The live card of the open thread's Mission, from host data only: the
   * phase, progress, acceptance state, controls, and, once completed and
   * accepted, the final report. Computed on every state message so the
   * step and run counters move while the Mission works.
   */
  private missionLiveView(threadId: string | null): MissionLiveView | null {
    if (threadId === null) {
      return null;
    }
    const mission = this.missions
      .list()
      .filter((entry) => entry.threadId === threadId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!mission) {
      if (this.running && this.runThreadId === threadId && this.runKind === 'mission-plan') {
        const thread = this.store.get(threadId);
        const goal = [...(thread?.turns ?? [])].reverse().find((turn) => turn.kind === 'user');
        return buildPlanningMissionLiveView(threadId, goal && 'text' in goal && typeof goal.text === 'string' ? goal.text : '');
      }
      return null;
    }
    return buildMissionLiveView(mission, this.missionViewRuntime(mission));
  }

  /**
   * Retry a blocked Mission with guidance the user typed: it is quoted to the
   * next internal runs, and the Mission resumes under the same grant.
   */
  async retryMission(missionId: string, expectedRevision: number, guidance: string): Promise<void> {
    const mission = this.missions.get(missionId);
    if (mission === null || mission.status !== 'blocked' || mission.auto === null) {
      this.status = 'Only a blocked Mission can be retried with guidance.';
      await this.postState();
      return;
    }
    const guided = await this.missions.update(missionId, expectedRevision, (draft) => {
      if (draft.auto === null) {
        return { ok: false, error: 'This Mission was never started.' };
      }
      draft.auto.userGuidance = guidance.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim().slice(0, MAX_USER_GUIDANCE);
      return { ok: true, value: draft };
    });
    if (!guided.ok) {
      this.status = guided.error;
      await this.postState();
      return;
    }
    await this.resumeMission(missionId, guided.value.revision);
  }

  private missionViewRuntime(mission: MissionRecord): MissionViewRuntime {
    return {
      hostRunning: this.running,
      driving: this.missionAuto?.missionId === mission.id,
      starting: this.missionStarting === mission.id && this.missionAuto === null,
      manualTask: this.activeMission?.id === mission.id,
      agentStep: this.agentStepNow,
      authorizing: this.isAuthorizing(mission.id),
      leaseToken: this.leaseToken,
      isLeaseAlive: (lease) => this.isLeaseAlive(lease),
      cloudEscalationAllowed: this.settings.allowCloudEscalation,
      testCommands: this.missionTestCommands,
      setup: this.missionSetup,
      startRequest: this.missionStartRequest?.missionId === mission.id ? this.missionStartRequest : null,
    };
  }

  /**
   * Settings: the user proposes a value. Nothing is written yet; an exact
   * approval card is shown and only its approval commits the change.
   */
  async proposeUserDecision(key: string, valueType: DecisionValueType, valueText: string): Promise<void> {
    if (this.memoryPending !== null) {
      this.status = 'Approve or reject the pending memory change first.';
      await this.postState();
      return;
    }
    const scope = await this.memoryScopeForUi();
    if (!scope.ok) {
      this.status = scope.error;
      await this.postState();
      return;
    }
    const value = parseDecisionValueText(valueType, valueText);
    if (value === null) {
      this.status = `The value is not a valid ${valueType}.`;
      await this.postState();
      return;
    }
    const latest = this.memory.latestVersion(scope.scopeId, key);
    const prepared = this.memory.preparePut({
      scopeId: scope.scopeId,
      scopeLabel: scope.label,
      key,
      value,
      expectedVersion: latest ?? 0,
      provenance: { source: 'user', provider: 'none', threadId: SETTINGS_MEMORY_THREAD, reason: 'Entered in Settings.' },
    });
    if (!prepared.ok) {
      this.status = `Not proposed: ${prepared.error}`;
      await this.refreshMemoryView();
      await this.postState();
      return;
    }
    const described = this.describeMemoryProposal(prepared.value);
    const action = createPendingAction(
      {
        tool: 'propose_decision',
        targets: described.targets,
        body: described.body,
        provider: 'none',
        workspaceId: scope.root,
        threadId: SETTINGS_MEMORY_THREAD,
        preconditions: described.preconditions,
      },
      this.memoryGeneration,
    );
    this.memoryPending = { action, proposal: prepared.value };
    this.status = 'Review the exact memory change below, then approve or reject it.';
    await this.refreshMemoryView();
    await this.postState();
  }

  /** Approve the exact Settings card: one use, same project, same version. */
  async approveMemoryChange(actionId: string, digest: string): Promise<void> {
    const pending = this.memoryPending;
    if (pending === null || pending.action.actionId !== actionId || pending.action.digest !== digest) {
      this.status = 'That memory approval is no longer valid.';
      await this.postState();
      return;
    }
    const scope = await this.memoryScopeForUi();
    const live = await this.liveApprovalContext(pending.action);
    const drift = memoryDrift(pending.action, live.currentHashes);
    const checked = drift !== null ? { ok: false as const, error: drift } : verifyApproval(pending.action, { actionId, digest }, {
      ...live,
      workspaceId: scope.ok ? scope.root : '',
      threadId: SETTINGS_MEMORY_THREAD,
      provider: 'none',
      generation: this.memoryGeneration,
    });
    this.memoryPending = null;
    if (!checked.ok) {
      this.memory.discardProposals({ proposalId: pending.proposal.proposalId });
      this.status = `Not written: ${checked.error}`;
      await this.refreshMemoryView();
      await this.postState();
      return;
    }
    pending.action.used = true;
    const result = await this.memory.commitAuthorizedChange({
      proposalId: pending.proposal.proposalId,
      proposalDigest: pending.proposal.digest,
      scopeId: pending.proposal.scopeId,
      threadId: SETTINGS_MEMORY_THREAD,
      provider: 'none',
      approvedBy: 'user',
      approvalDigest: pending.action.digest,
      approvedAt: Date.now(),
    });
    this.status = result.ok
      ? 'version' in result.value
        ? `Saved ${result.value.key} v${result.value.version} = ${JSON.stringify(result.value.value)}.`
        : 'Artifact recorded.'
      : `Not written: ${result.error}`;
    await this.refreshMemoryView();
    await this.postState();
  }

  async rejectMemoryChange(actionId: string, digest: string): Promise<void> {
    const pending = this.memoryPending;
    if (pending === null || pending.action.actionId !== actionId || pending.action.digest !== digest) {
      this.status = 'That memory approval is no longer valid.';
      await this.postState();
      return;
    }
    this.memoryPending = null;
    this.memory.discardProposals({ proposalId: pending.proposal.proposalId });
    this.status = 'Memory change rejected. Nothing was written.';
    await this.refreshMemoryView();
    await this.postState();
  }

  /** Bounded labeled snapshot of one project's memory, with live file status. */
  private async memorySnapshotText(scope: { scopeId: string; label: string }, fs: AgentFs): Promise<string> {
    const readout = this.memory.readScope(scope.scopeId);
    const artifacts = this.memory.artifactStatuses(scope.scopeId, await this.liveArtifactHashes(scope.scopeId, fs));
    return buildMemorySnapshot(scope.label, readout, artifacts, this.memory.listPendingProposals(scope.scopeId));
  }

  /** Hash every bound file now (null = missing); unreadable paths are left out. */
  private async liveArtifactHashes(scopeId: string, fs: AgentFs): Promise<Record<string, string | null>> {
    const hashes: Record<string, string | null> = {};
    for (const binding of this.memory.listArtifacts(scopeId)) {
      if (binding.path in hashes) {
        continue;
      }
      const gate = checkAgentRelPath(binding.path);
      if (!gate.ok) {
        continue;
      }
      try {
        const rel = (gate as { ok: true; rel: string }).rel;
        const st = await fs.stat(rel);
        if (st.kind === 'missing') {
          hashes[binding.path] = null;
        } else if (st.kind === 'file') {
          hashes[binding.path] = hashContent(await fs.readText(rel));
        }
      } catch {
        // Left out: reads as unverified, never as current.
      }
    }
    return hashes;
  }

  private prepareModelDecision(
    call: ValidatedToolCall,
    scope: { scopeId: string; label: string },
    threadId: string,
    provider: ProviderId,
  ): { ok: true; value: MemoryProposal } | { ok: false; error: string } {
    const args = call.args as { key: string; valueType: DecisionValueType; value: string; expectedVersion: number; userWords: string; reason: string };
    const value = parseDecisionValueText(args.valueType, args.value);
    if (value === null) {
      return { ok: false, error: `the value is not a valid ${args.valueType}.` };
    }
    // The source must be what the user typed in this thread, checked here.
    const statement = checkUserStatement({ quote: args.userWords, value, userMessages: userWrittenTexts(this.store.get(threadId)) });
    if (!statement.ok) {
      return statement;
    }
    return this.memory.preparePut({
      scopeId: scope.scopeId,
      scopeLabel: scope.label,
      key: args.key,
      value,
      expectedVersion: args.expectedVersion,
      provenance: { source: 'model', provider, threadId, reason: args.reason, quote: statement.quote },
    });
  }

  /**
   * After a passing test: tell the model which files it changed and which
   * decisions are in force, so it can ask to bind the files that implement
   * one. The host never infers the link itself.
   */
  private bindArtifactHint(resultText: string, scopeId: string, changedFiles: ReadonlySet<string>, commandId: string): string {
    if (!/^exit=0\b/.test(resultText) || changedFiles.size === 0) {
      return '';
    }
    const decisions = this.memory.listCurrentDecisions(scopeId);
    if (decisions.length === 0) {
      return '';
    }
    const files = [...changedFiles].slice(0, 20).join(', ');
    const versions = decisions.slice(0, 20).map((entry) => `${entry.key} v${entry.version}`).join(', ');
    return (
      `\n\nHost note: ${commandId} passed and no file changed since. Files you changed in this run: ${files}. ` +
      `Authorized decisions: ${versions}. If one of these files implements one of these decisions, call bind_artifact for it now ` +
      `(commandId ${commandId}, the decision's current version). Do not bind a file that does not implement the decision.`
    );
  }

  /**
   * Prepare an artifact binding from evidence the host itself holds: the
   * file hash it reads now and a passing run_tests of this run with no file
   * change since. The model's claims are not evidence.
   */
  private async prepareModelArtifact(
    call: ValidatedToolCall,
    scope: { scopeId: string; label: string },
    threadId: string,
    provider: ProviderId,
    fs: AgentFs,
    canonicalRoot: string,
    testRuns: ReadonlyArray<{ commandId: string; exitCode: number | null; writes: number; at: number; outputDigest: string }>,
    workspaceWrites: number,
  ): Promise<{ ok: true; value: MemoryProposal } | { ok: false; error: string }> {
    const args = call.args as { path: string; decisionKey: string; decisionVersion: number; commandId: string };
    const gate = checkAgentRelPath(args.path);
    if (!gate.ok) {
      return { ok: false, error: gate.error };
    }
    const rel = (gate as { ok: true; rel: string }).rel;
    let fileHash: string;
    try {
      await guardFsPath(fs, rel, canonicalRoot);
      const st = await fs.stat(rel);
      if (st.kind !== 'file') {
        return { ok: false, error: 'the artifact must be an existing file.' };
      }
      fileHash = hashContent(await fs.readText(rel));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'the artifact could not be read.' };
    }
    const run = [...testRuns].reverse().find((entry) => entry.commandId === args.commandId);
    if (!run) {
      return { ok: false, error: `no run_tests ${args.commandId} ran in this run; run it after your last change, then bind.` };
    }
    if (run.exitCode !== 0) {
      return { ok: false, error: `the last ${args.commandId} run did not pass, so it cannot verify the file.` };
    }
    if (run.writes !== workspaceWrites) {
      return { ok: false, error: `files changed after the last ${args.commandId} run; run it again before binding.` };
    }
    return this.memory.prepareArtifactBinding({
      scopeId: scope.scopeId,
      scopeLabel: scope.label,
      path: rel,
      fileHash,
      decisionKey: args.decisionKey,
      decisionVersion: args.decisionVersion,
      verification: { commandId: args.commandId, exitCode: 0, ranAt: run.at, resultDigest: run.outputDigest },
      provenance: { source: 'model', provider, threadId, reason: '' },
    });
  }

  /** Approval card content: the exact change, bound to the store's digest and versions. */
  private describeMemoryProposal(proposal: MemoryProposal): { targets: string[]; body: string; preconditions: Record<string, string> } {
    const body = `${describeProposal(proposal)}\nProposal ${proposal.proposalId}, digest ${proposal.digest}.`;
    if (proposal.kind === 'decision') {
      return {
        targets: [`memory:${proposal.key}`],
        body,
        preconditions: { [memoryPreconditionKey(proposal.scopeId, proposal.key)]: memoryPreconditionValue(proposal.expectedVersion) },
      };
    }
    return {
      targets: [proposal.path, `memory:${proposal.decisionKey}`],
      body,
      preconditions: {
        [proposal.path]: proposal.fileHash,
        [memoryPreconditionKey(proposal.scopeId, proposal.decisionKey)]: memoryPreconditionValue(proposal.decisionVersion),
      },
    };
  }

  /** Commit a model proposal only with the user's approval of its exact card. */
  private async commitModelProposal(
    proposal: MemoryProposal,
    approved: PendingAgentAction | null,
    threadId: string,
    provider: ProviderId,
  ): Promise<string> {
    if (approved === null || !approved.used) {
      this.memory.discardProposals({ proposalId: proposal.proposalId });
      return 'not written: memory changes need your approval.';
    }
    const authorization: MemoryAuthorization = {
      proposalId: proposal.proposalId,
      proposalDigest: proposal.digest,
      scopeId: proposal.scopeId,
      threadId,
      provider,
      approvedBy: 'user',
      approvalDigest: approved.digest,
      approvedAt: Date.now(),
    };
    const result = await this.memory.commitAuthorizedChange(authorization);
    if (!result.ok) {
      return `not written: ${result.error}`;
    }
    if ('version' in result.value) {
      const entry = result.value;
      return `committed ${entry.key} v${entry.version} = ${entry.op === 'delete' ? '(removed)' : JSON.stringify(entry.value)} (approved by you)`;
    }
    const binding = result.value;
    return `recorded ${binding.path} as verified against ${binding.decisionKey} v${binding.decisionVersion} (approved by you)`;
  }

  private async executeAgentTool(
    call: ValidatedToolCall,
    fs: AgentFs,
    allowlist: AllowedTestCommand[],
    signal: AbortSignal,
    workspaceId: string,
    canonicalRoot?: string | null,
  ): Promise<string> {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    switch (call.tool) {
      case 'list_files':
        return executeListFiles(fs, call, canonicalRoot ?? null);
      case 'inspect_workspace':
        return executeInspectWorkspace(fs, call, canonicalRoot ?? null);
      case 'filesystem_usage':
        return executeFilesystemUsage(fs);
      case 'search_text':
        return executeSearchText(fs, call, canonicalRoot ?? null);
      case 'read_file':
        return executeReadFile(fs, call, canonicalRoot ?? null);
      case 'create_directory':
        return executeCreateDirectory(fs, call, canonicalRoot ?? null);
      case 'move_file':
        return executeMoveFile(fs, call, canonicalRoot ?? null);
      case 'delete_file':
        return executeDeleteFile(fs, call, canonicalRoot ?? null);
      case 'set_executable':
        return executeSetExecutable(fs, call, canonicalRoot ?? null);
      case 'apply_patch': {
        const files = ((call.args as Record<string, unknown>).files as Array<{
          path: string;
          expectedHash: string;
          newContent: string;
        }>) ?? [];
        // Live symlink/canonical guard before the atomic applier runs.
        for (const file of files) {
          const gate = checkAgentRelPath(file.path);
          if (!gate.ok) {
            throw new Error(gate.error);
          }
          await guardFsPath(fs, (gate as { ok: true; rel: string }).rel, canonicalRoot ?? null);
        }
        const host = {
          inspect: (rel: string): { kind: 'file' | 'dir' | 'symlink' | 'missing' | 'other'; bytes: string } => {
            throw new Error(`Async inspect required for ${rel}; use executeAgentTool patch path.`);
          },
          write: (_rel: string, _content: string): void => {
            throw new Error('Async write required.');
          },
        };
        void host;
        void workspaceId;
        return this.applyPatchViaFs(files, fs, signal, canonicalRoot ?? null);
      }
      case 'replace_in_file': {
        // Checked again right before writing; the atomic applier then
        // re-verifies the hash, writes, and rolls back on any failure.
        const checked = await this.checkReplacement(call, fs, canonicalRoot ?? null);
        if (!checked.ok) {
          throw new Error(checked.error);
        }
        const args = call.args as unknown as ReplaceInFileArgs;
        const applied = await this.applyPatchViaFs([{ path: checked.rel, expectedHash: args.expectedHash, newContent: checked.newContent }], fs, signal, canonicalRoot ?? null);
        return `Replaced 1 fragment in ${checked.rel} (${args.oldText.length} -> ${args.newText.length} characters).\n${applied}`;
      }
      case 'read_decisions': {
        const root = canonicalRoot ?? workspaceId;
        return this.memorySnapshotText({ scopeId: scopeIdForRoot(root), label: path.basename(root) }, fs);
      }
      case 'propose_decision':
      case 'bind_artifact':
        // Reached only by a bug: memory writes never run as plain tools.
        throw new Error('Memory changes are committed only through your approval.');
      case 'run_tests': {
        const id = String((call.args as Record<string, unknown>).commandId ?? '');
        const command = findAllowedCommand(allowlist, id);
        if (!command || !isDerivedNpmTestCommand(command)) {
          throw new Error('That test command is not allowlisted.');
        }
        return this.runAllowlistedTest(command, signal, workspaceId);
      }
      default:
        throw new Error('Unknown tool.');
    }
  }

  /**
   * replace_in_file preconditions, read from the workspace now: the file
   * exists with the expected hash and holds oldText exactly once. Returns the
   * whole new content for the atomic applier. Throws only on a path the
   * live guard refuses (symlink or canonical escape).
   */
  private async checkReplacement(
    call: ValidatedToolCall,
    fs: AgentFs,
    canonicalRoot: string | null,
  ): Promise<{ ok: true; rel: string; newContent: string } | { ok: false; error: string }> {
    const args = call.args as unknown as ReplaceInFileArgs;
    const gate = checkAgentRelPath(args.path);
    if (!gate.ok) {
      return { ok: false, error: gate.error };
    }
    const rel = (gate as { ok: true; rel: string }).rel;
    await guardFsPath(fs, rel, canonicalRoot);
    const st = await fs.stat(rel);
    if (st.kind !== 'file') {
      return { ok: false, error: 'That file does not exist.' };
    }
    const text = await fs.readText(rel);
    if (hashContent(text) !== args.expectedHash) {
      return { ok: false, error: 'The file changed; re-read and re-propose the action.' };
    }
    const first = text.indexOf(args.oldText);
    if (first === -1) {
      return { ok: false, error: REPLACE_NOT_FOUND_MESSAGE };
    }
    if (text.indexOf(args.oldText, first + 1) !== -1) {
      return { ok: false, error: REPLACE_NOT_UNIQUE_MESSAGE };
    }
    return { ok: true, rel, newContent: `${text.slice(0, first)}${args.newText}${text.slice(first + args.oldText.length)}` };
  }

  private async applyPatchViaFs(
    files: Array<{ path: string; expectedHash: string; newContent: string }>,
    fs: AgentFs,
    signal?: AbortSignal,
    canonicalRoot?: string | null,
  ): Promise<string> {
    // Phase 1: validate every operation + snapshot preconditions.
    const planned: Array<{ rel: string; expectedHash: string; newContent: string; original: string | null }> = [];
    for (const file of files) {
      const gate = checkAgentRelPath(file.path);
      if (!gate.ok) {
        throw new Error(gate.error);
      }
      const rel = (gate as { ok: true; rel: string }).rel;
      if (rel === '') {
        throw new Error('The patch cannot target the workspace root.');
      }
      await guardFsPath(fs, rel, canonicalRoot ?? null);
      const st = await fs.stat(rel);
      if (st.kind === 'symlink') {
        throw new Error('The patch cannot follow symlinks.');
      }
      if (st.kind === 'dir' || st.kind === 'other') {
        throw new Error('The patch cannot target directories or special files.');
      }
      const current = st.kind === 'file' ? await fs.readText(rel) : '';
      if (hashContent(current) !== file.expectedHash) {
        throw new Error('A target changed since it was read; re-read before patching.');
      }
      planned.push({ rel, expectedHash: file.expectedHash, newContent: file.newContent, original: st.kind === 'file' ? current : null });
    }
    const rollbackAsync = async (written: string[]): Promise<boolean> => {
      try {
        for (const item of planned) {
          if (!written.includes(item.rel)) {
            continue;
          }
          if (item.original === null) {
            // Bounded rollback-only delete for this exact pending patch.
            if (!fs.removeFile) {
              return false;
            }
            await fs.removeFile(item.rel);
          } else {
            await fs.writeText(item.rel, item.original);
          }
        }
      } catch {
        return false;
      }
      try {
        for (const item of planned) {
          if (!written.includes(item.rel)) {
            continue;
          }
          const after = await fs.stat(item.rel);
          if (item.original === null) {
            if (after.kind !== 'missing') {
              return false;
            }
          } else {
            if (after.kind !== 'file') {
              return false;
            }
            const text = await fs.readText(item.rel);
            if (hashContent(text) !== hashContent(item.original)) {
              return false;
            }
          }
        }
      } catch {
        return false;
      }
      return true;
    };
    // Phase 2: write all; restore originals and remove created files on failure.
    const written: string[] = [];
    try {
      for (const item of planned) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        await fs.writeText(item.rel, item.newContent);
        written.push(item.rel);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        const restored = await rollbackAsync(written);
        void restored;
        throw error;
      }
      const restored = await rollbackAsync(written);
      throw new Error(
        restored
          ? 'The patch was interrupted; originals were restored.'
          : 'The patch was interrupted; restore could not be verified.',
      );
    }
    if (signal?.aborted) {
      const restored = await rollbackAsync(written);
      void restored;
      throw new DOMException('Aborted', 'AbortError');
    }
    // Phase 3: verify + return digest metadata only after host verification.
    const lines: string[] = [];
    try {
      for (const item of planned) {
        const after = await fs.readText(item.rel);
        const newHash = hashContent(after);
        if (newHash !== hashContent(item.newContent)) {
          throw new Error('verification failed');
        }
        lines.push(`${item.rel} ${item.expectedHash.slice(0, 12)} -> ${newHash.slice(0, 12)}`);
      }
    } catch {
      const restored = await rollbackAsync(planned.map((item) => item.rel));
      throw new Error(
        restored
          ? 'Patch verification failed; originals were restored.'
          : 'Patch verification failed.',
      );
    }
    // Cross-check the sync atomic applier stays consistent (no-op guard).
    void applyPatchAtomically;
    return `Patched ${planned.length} file(s):\n${lines.join('\n')}`;
  }

  private async handleSendError(
    threadId: string,
    provider: ProviderId,
    error: unknown,
  ): Promise<void> {
    this.running = false;
    this.memory.discardProposals({ threadId });
    if (
      (error instanceof Error && error.name === 'AbortError') ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      this.connection = 'cancelled';
      this.status = 'Request cancelled.';
      const current = this.store.get(threadId);
      if (current) {
        // A shutdown/reload is not a user cancellation.
        this.store.save(appendErrorTurn(current, this.disposed ? INTERRUPTED_RUN_NOTE : 'Request cancelled.'));
      }
      return;
    }
    let apiKey: string | undefined;
    try {
      apiKey = await this.secrets.get(API_KEY_SECRET);
    } catch {
      apiKey = undefined;
    }
    const detail = error instanceof Error ? error.message : 'Unknown error.';
    const redacted = redactKeyFromText(detail, apiKey ?? '');
    const concise = redacted.replace(/\s+/g, ' ').trim().slice(0, 300);
    const safe = concise.length > 0 ? concise : 'Unknown error.';
    const displayEndpoint =
      this.localEndpoint() ?? `http://127.0.0.1:${this.settings.local.port}`;
    const unreachable = localUnreachableMessage(displayEndpoint);
    const looksUnreachable =
      /not running|no external endpoint|not reachable|unreachable|refused|failed to fetch|fetch failed|network|econn|socket|health/i.test(
        safe,
      );
    if (provider === 'local' && this.settings.allowCloudEscalation) {
      // No silent fallback: surface a pending choice the user must approve.
      this.pendingRequest = {
        threadId,
        text: lastUserText(this.store.get(threadId)) ?? '',
        mode: this.settings.mode,
      };
      this.escalation = {
        pending: true,
        reason: looksUnreachable
          ? `${unreachable} You can send this request to Meta explicitly, or dismiss.`
          : `Local work could not complete (${safe}). You can send this request to Meta explicitly, or dismiss.`,
      };
      this.connection = 'error';
      this.status = looksUnreachable
        ? `${unreachable} Escalation is waiting for approval.`
        : 'Local work failed. Escalation is waiting for approval.';
    } else if (provider === 'local') {
      this.connection = 'error';
      this.status = looksUnreachable
        ? `${unreachable} Cloud escalation is OFF, so nothing was sent.`
        : `Local work failed (${safe}). Cloud escalation is OFF, so nothing was sent.`;
    } else {
      this.connection = 'error';
      this.status = `Request failed (${safe}).`;
    }
    const current = this.store.get(threadId);
    if (current) {
      const note =
        provider === 'local' && looksUnreachable ? unreachable : this.status;
      this.store.save(appendErrorTurn(current, note.slice(0, 500)));
    }
  }

  /** Explicit user approval: send the pending request to Meta exactly once. */
  async approveEscalation(): Promise<void> {
    if (!this.escalation.pending || !this.pendingRequest) {
      this.status = 'No escalation is waiting for approval.';
      await this.postState();
      return;
    }
    if (
      this.running ||
      this.missionRunner.isRunning ||
      this.chatRunner.isRunning ||
      this.agentRunner.isRunning
    ) {
      // Keep the choice available; never start a second concurrent run.
      this.status = 'A request is already running. Cancel it or wait before sending to Meta. Nothing was sent.';
      await this.postState();
      return;
    }
    if (!this.settings.allowCloudEscalation) {
      this.status = 'Cloud escalation is OFF. Nothing was sent.';
      await this.postState();
      return;
    }
    const pending = this.pendingRequest;
    this.pendingRequest = null;
    this.escalation = { pending: false, reason: '' };
    const thread = this.store.get(pending.threadId);
    if (!thread) {
      this.status = 'That thread is no longer stored. Nothing was sent.';
      await this.postState();
      return;
    }
    this.activeThreadId = thread.id;
    // Reuse the already-persisted user turn: no duplicate is appended.
    await this.executeSend(thread.id, pending.text, pending.mode, 'cloud');
  }

  async dismissEscalation(): Promise<void> {
    this.pendingRequest = null;
    this.escalation = { pending: false, reason: '' };
    this.status = 'Escalation dismissed. Nothing was sent to Meta.';
    await this.postState();
  }

  /** Cancel the running request. Returns false when nothing was running. */
  cancelRequest(): boolean {
    let cancelled = false;
    if (this.acceptanceController !== null) {
      this.acceptanceController.abort();
      cancelled = true;
    }
    // Aborting the run clears the waiter synchronously; remember it first.
    const hadAgentWait = this.agentPending !== null || this.agentWaiter !== null;
    if (this.missionRunner.isRunning) {
      cancelled = this.missionRunner.cancel() || cancelled;
    }
    if (this.chatRunner.isRunning) {
      cancelled = this.chatRunner.cancel() || cancelled;
    }
    if (this.agentRunner.isRunning) {
      cancelled = this.agentRunner.cancel() || cancelled;
    }
    if (this.memoryPending !== null) {
      // A cancelled Settings card can never commit later.
      this.memory.discardProposals({ proposalId: this.memoryPending.proposal.proposalId });
      this.memoryPending = null;
      this.memoryGeneration += 1;
      cancelled = true;
    }
    // Cancellation invalidates pending Agent approvals exactly once.
    if (hadAgentWait || this.agentPending || this.agentWaiter) {
      this.agentGeneration += 1;
      this.agentPending = null;
      const waiter = this.agentWaiter;
      this.agentWaiter = null;
      waiter?.resolve({ kind: 'cancelled' });
      cancelled = true;
    }
    if (!this.running && !cancelled) {
      this.status = 'No request is running.';
      void this.postState();
      return false;
    }
    this.running = false;
    this.connection = 'cancelled';
    this.status = 'Request cancelled.';
    void this.postState();
    return true;
  }

  // ----- Cloud key management -----

  async saveKey(rawKey: string): Promise<void> {
    const checked = validateApiKeyInput(rawKey);
    if (!checked.ok || checked.apiKey === undefined) {
      this.status = checked.error ?? 'The API key is invalid.';
      await this.postState();
      return;
    }
    await this.secrets.store(API_KEY_SECRET, checked.apiKey);
    this.hasKey = true;
    if (!this.running) {
      this.connection = 'ready';
    }
    this.status = 'API key stored. Refreshing available models…';
    await this.postState();
    // Saving a key triggers a bounded catalog refresh; failures keep the
    // safe fallback catalog with a sanitized message.
    await this.refreshModels(true);
  }

  async clearKey(): Promise<void> {
    await this.secrets.delete(API_KEY_SECRET);
    this.hasKey = false;
    if (!this.running) {
      this.connection = 'missing-key';
    }
    this.status = 'API key cleared. Save a key to run cloud requests.';
    await this.postState();
  }

  // ----- Non-secret settings -----

  async updateSettings(
    runtime: string,
    mode: string,
    allowCloudEscalation: boolean,
  ): Promise<void> {
    const checkedRuntime: RuntimeId | null = parseRuntimeId(runtime);
    if (checkedRuntime === null) {
      this.status = 'Unknown runtime. Choose a runtime in Settings.';
      await this.postState();
      return;
    }
    if (!isSupportedMode(mode)) {
      this.status = 'Unknown mode.';
      await this.postState();
      return;
    }
    const provider = runtimeToProvider(checkedRuntime);
    const model = runtimeToModel(checkedRuntime, this.selectedCloudModel());
    this.settings = {
      ...this.settings,
      provider,
      mode,
      model,
      allowCloudEscalation,
    };
    this.persistSettings();
    this.status = 'Settings saved.';
    const endpoint = provider === 'local' && !this.running ? this.localEndpoint() : null;
    if (endpoint !== null) {
      await this.probeLocalProps(endpoint);
    }
    await this.postState();
  }

  /** Persist a validated subordinate cloud model selection. */
  async selectCloudModel(rawModel: string): Promise<void> {
    const valid = validateCloudModelSelection(rawModel, this.cloudCatalog);
    const requested = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (requested !== valid) {
      // Invalid or unavailable: fall back safely with a visible status.
      // Never silently switch Standard to Contributor: the fallback is the
      // standard `muse-spark-1.3`.
      this.settings = this.reconcileCloudModel(
        { ...this.settings, cloudModel: CLOUD_MODEL_FALLBACK },
        this.cloudCatalog,
      );
      this.persistSettings();
      this.status = `That model is unavailable. Using ${CLOUD_MODEL_FALLBACK}.`;
      await this.postState();
      return;
    }
    const contributorNote = /contrib/i.test(valid)
      ? ' (Contributor — data may be used)'
      : '';
    this.settings = this.reconcileCloudModel(
      { ...this.settings, cloudModel: valid },
      this.cloudCatalog,
    );
    this.persistSettings();
    this.status = `Cloud model selected: ${valid}${contributorNote}.`;
    await this.postState();
  }

  /**
   * Host-side bounded `Refresh available models` action. Reads the API key
   * only from SecretStorage; the key never reaches the webview, logs,
   * state, or errors.
   */
  async refreshModels(fromSaveKey = false): Promise<void> {
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      this.hasKey = false;
      this.cloudCatalog = fallbackCatalog();
      this.settings = {
        ...this.settings,
        cloudCatalogSource: 'fallback',
      };
      this.settings = this.reconcileCloudModel(this.settings, this.cloudCatalog);
      this.persistSettings();
      this.status = fromSaveKey
        ? 'API key stored. No key available for catalog refresh; using fallback catalog.'
        : 'No API key stored. Using fallback catalog.';
      await this.postState();
      return;
    }
    this.status = 'Refreshing available models…';
    await this.postState();
    let result;
    try {
      result = await refreshCompatibleModels({ apiKey });
    } catch {
      result = {
        models: fallbackCatalog(),
        source: 'fallback' as const,
        status: 'Could not refresh models. Using fallback catalog.',
      };
    }
    this.cloudCatalog = result.models;
    const source = result.source === 'live' ? 'live' : 'fallback';
    this.settings = { ...this.settings, cloudCatalogSource: source };
    // If the stored selection is no longer available, fall back visibly.
    const reconciled = validateCloudModelSelection(
      this.settings.cloudModel,
      this.cloudCatalog,
    );
    if (reconciled !== this.settings.cloudModel) {
      this.settings = this.reconcileCloudModel(
        { ...this.settings, cloudModel: CLOUD_MODEL_FALLBACK },
        this.cloudCatalog,
      );
      this.persistSettings();
      this.status = `${result.status} The stored model was unavailable; using ${CLOUD_MODEL_FALLBACK}.`;
      await this.postState();
      return;
    }
    this.settings = this.reconcileCloudModel(this.settings, this.cloudCatalog);
    this.persistSettings();
    this.status = result.status;
    await this.postState();
  }

  async updateLocalSettings(value: {
    executablePath: string;
    modelPath: string;
    projectorPath: string;
    draftModelPath: string;
    modelId: string;
    contextSize: number;
    port: number;
    idleTimeoutSec: number;
  }): Promise<void> {
    const checked = validateLocalSettings(value);
    if (!checked.ok || !checked.settings) {
      this.status = checked.error ?? 'Local settings are invalid.';
      await this.postState();
      return;
    }
    this.settings = { ...this.settings, local: checked.settings };
    this.localSettingsRev += 1;
    this.persistSettings();
    this.status = 'Local settings saved.';
    await this.postState();
  }

  async useSuggestions(): Promise<void> {
    this.settings = { ...this.settings, local: suggestedLocalSettings() };
    this.localSettingsRev += 1;
    this.persistSettings();
    this.status =
      'Detected settings applied. Review the local fields and choose Save or Start.';
    await this.postState();
  }

  async selectExternalEndpoint(rawEndpoint: string): Promise<void> {
    const endpoint = rawEndpoint.trim().replace(/\/+$/, '');
    if (!isLoopbackUrl(endpoint)) {
      this.status = 'The external endpoint must stay on loopback.';
      await this.postState();
      return;
    }
    this.settings = { ...this.settings, externalLocalEndpoint: endpoint };
    this.persistSettings();
    this.local = nextLocalRuntimeStatus(this.local, {
      kind: 'external-selected',
      endpoint,
    });
    this.status = `External endpoint selected: ${endpoint}. RAME does not own its lifecycle.`;
    await this.probeLocalProps(endpoint);
    await this.postState();
  }

  async clearExternalEndpoint(): Promise<void> {
    this.settings = { ...this.settings, externalLocalEndpoint: '' };
    this.persistSettings();
    if (!this.local.owned) {
      this.local = nextLocalRuntimeStatus(this.local, {
        kind: 'external-cleared',
      });
    }
    this.status = 'External endpoint cleared.';
    await this.postState();
  }

  // ----- Local runtime lifecycle -----

  /** Effective loopback endpoint: owned child first, then external. */
  localEndpoint(): string | null {
    if (
      (this.local.lifecycle === 'running' ||
        this.local.lifecycle === 'starting') &&
      this.local.endpoint
    ) {
      return this.local.endpoint;
    }
    const external = this.settings.externalLocalEndpoint.trim();
    if (external.length > 0 && isLoopbackUrl(external)) {
      return external;
    }
    return null;
  }

  /**
   * Atomic local start: validates, persists, and starts the exact visible
   * configuration from the single `startLocal` message. No stale or default
   * paths are used.
   */
  async startLocalRuntime(value?: {
    executablePath: string;
    modelPath: string;
    projectorPath: string;
    draftModelPath: string;
    modelId: string;
    contextSize: number;
    port: number;
    idleTimeoutSec: number;
  }): Promise<void> {
    const checked = validateLocalSettings(value ?? this.settings.local);
    if (!checked.ok || !checked.settings) {
      this.status = checked.error ?? 'Local settings are invalid.';
      await this.postState();
      return;
    }
    // Persist the exact validated configuration before spawning.
    this.settings = { ...this.settings, local: checked.settings };
    this.localSettingsRev += 1;
    this.persistSettings();
    await this.localRuntime.start(checked.settings);
  }

  async stopLocalRuntime(): Promise<void> {
    await this.localRuntime.stop();
  }

  private armIdleShutdown(): void {
    this.localRuntime.armIdleShutdown();
  }

  private isBusy(): boolean {
    return (
      this.running ||
      this.missionRunner.isRunning ||
      this.chatRunner.isRunning ||
      this.agentRunner.isRunning
    );
  }

  // ----- State plumbing -----

  private recordUsage(
    provider: 'cloud' | 'local',
    usage: ProviderUsage,
  ): void {
    this.usageLast = usage;
    this.usage = {
      ...this.usage,
      [provider]: addUsage(this.usage[provider], usage),
    };
    void this.state.update(RAME_USAGE_KEY, this.usage);
  }

  private persistSettings(): void {
    void this.state.update(RAME_SETTINGS_KEY, this.settings);
  }

  private ensureActiveThreadStillExists(): void {
    if (
      this.activeThreadId !== null &&
      !this.store.get(this.activeThreadId)
    ) {
      this.activeThreadId = null;
    }
  }

  private activeTurns(): ChatThread | undefined {
    return this.activeThreadId !== null
      ? this.store.get(this.activeThreadId)
      : undefined;
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let message;
    try {
      message = parseViewInboundMessage(raw);
    } catch {
      this.status = 'Ignoring an invalid view request.';
      await this.postState();
      return;
    }

    switch (message.type) {
      case 'ready':
      case 'refresh':
        await this.refreshAll();
        return;
      case 'navigate':
        await this.navigate(message.screen);
        return;
      case 'newThread':
        await this.newThread();
        return;
      case 'backToList':
        await this.backToList();
        return;
      case 'openThread':
        await this.openThread(message.threadId);
        return;
      case 'deleteThread':
        await this.deleteThread(message.threadId);
        return;
      case 'sendMessage':
        await this.sendMessage(message.text, message.mode, message.runtime);
        return;
      case 'cancel':
        this.cancelRequest();
        return;
      case 'saveKey':
        await this.saveKey(message.apiKey);
        return;
      case 'clearKey':
        await this.clearKey();
        return;
      case 'updateSettings':
        await this.updateSettings(
          message.runtime,
          message.mode,
          message.allowCloudEscalation,
        );
        return;
      case 'updateLocalSettings':
        await this.updateLocalSettings({
          executablePath: message.executablePath,
          modelPath: message.modelPath,
          projectorPath: message.projectorPath,
          draftModelPath: message.draftModelPath,
          modelId: message.modelId,
          contextSize: message.contextSize,
          port: message.port,
          idleTimeoutSec: message.idleTimeoutSec,
        });
        return;
      case 'useSuggestions':
        await this.useSuggestions();
        return;
      case 'selectCloudModel':
        await this.selectCloudModel(message.model);
        return;
      case 'refreshModels':
        await this.refreshModels();
        return;
      case 'startLocal':
        await this.startLocalRuntime({
          executablePath: message.executablePath,
          modelPath: message.modelPath,
          projectorPath: message.projectorPath,
          draftModelPath: message.draftModelPath,
          modelId: message.modelId,
          contextSize: message.contextSize,
          port: message.port,
          idleTimeoutSec: message.idleTimeoutSec,
        });
        return;
      case 'stopLocal':
        await this.stopLocalRuntime();
        return;
      case 'selectExternalEndpoint':
        await this.selectExternalEndpoint(message.endpoint);
        return;
      case 'clearExternalEndpoint':
        await this.clearExternalEndpoint();
        return;
      case 'escalateApprove':
        await this.approveEscalation();
        return;
      case 'escalateDismiss':
        await this.dismissEscalation();
        return;
      case 'setAgentProfile':
        await this.setAgentProfile(message.profile);
        return;
      case 'setReasoning':
        await this.setReasoning(message.provider, message.model, message.level);
        return;
      case 'setMaxOutputTokens':
        await this.setMaxOutputTokens(message.local, message.cloud);
        return;
      case 'proposeDecision':
        await this.proposeUserDecision(message.key, message.valueType, message.value);
        return;
      case 'approveMemoryChange':
        await this.approveMemoryChange(message.actionId, message.digest);
        return;
      case 'runMissionTask':
        await this.runMissionTask(message.missionId, message.revision);
        return;
      case 'rejectMemoryChange':
        await this.rejectMemoryChange(message.actionId, message.digest);
        return;
      case 'selectMemoryProject':
        await this.selectMemoryProject(message.path);
        return;
      case 'setLanguage':
        await this.setLanguage(message.language);
        return;
      case 'missionStart':
        await this.requestMissionStart(message.requestId ?? `req_${randomBytes(8).toString('hex')}`, () =>
          this.startMission(
            message.missionId,
            message.revision,
            message.mode,
            message.maxConsultations > 0 ? { maxConsultations: message.maxConsultations } : null,
            message.trustedProject,
            message.acceptanceCommand.length > 0 ? { commandId: message.acceptanceCommand, files: message.acceptanceFiles } : null,
          ),
          message.missionId,
        );
        return;
      case 'missionResume':
        await this.resumeMission(message.missionId, message.revision);
        return;
      case 'missionPause':
        await this.stopMission(message.missionId, 'pause');
        return;
      case 'missionCancel':
        await this.stopMission(message.missionId, 'cancel');
        return;
      case 'missionRetry':
        await this.retryMission(message.missionId, message.revision, message.guidance);
        return;
      case 'consultApprove':
        await this.approveConsult(message.digest);
        return;
      case 'consultDismiss':
        await this.dismissConsult();
        return;
      case 'approveAgentAction':
        await this.approveAgentAction(message.actionId, message.digest);
        return;
      case 'rejectAgentAction':
        await this.rejectAgentAction(message.actionId, message.digest);
        return;
    }
  }

  private async postState(): Promise<void> {
    if (this.disposed || !this.view) {
      return;
    }
    const threads = this.store.list();
    const active = this.activeTurns();
    // Run-scoped UI: the approval card and Activity belong to the run's
    // thread only, never to whichever other thread is open.
    const inRunThread = active !== undefined && active.id === this.runThreadId;
    const pending = this.agentPending !== null && active !== undefined && this.agentPending.threadId === active.id
      ? this.agentPending
      : null;
    await this.view.webview.postMessage(
      buildViewStateMessage({
        screen: this.screen,
        hasKey: this.hasKey,
        running: this.running,
        status: this.status,
        connection: this.connection,
        runtime: providerToRuntime(this.settings.provider),
        provider: this.settings.provider,
        mode: this.settings.mode,
        model: this.settings.model,
        cloudModel: this.selectedCloudModel(),
        cloudCatalog: this.cloudCatalog.map((entry) => ({ ...entry })),
        cloudCatalogSource:
          this.settings.cloudCatalogSource === 'live' ? 'live' : 'fallback',
        threads,
        activeThreadId: active ? active.id : null,
        turns: active ? active.turns : [],
        usageLast: this.usageLast,
        usageCloud: this.usage.cloud,
        usageLocal: this.usage.local,
        local: {
          ...this.local,
          diagnostics: this.local.diagnostics,
        },
        localSettings: { ...this.settings.local },
        localSettingsRev: this.localSettingsRev,
        escalation: this.escalation,
        allowCloudEscalation: this.settings.allowCloudEscalation,
        externalLocalEndpoint: this.settings.externalLocalEndpoint,
        agentProfile: this.settings.agentProfile,
        agentWorkspace: this.agentRunWorkspace !== null
          ? this.agentRunWorkspace.label
          : this.heldWorkspaceRoot().ok
            ? (this.heldWorkspaceRoot() as { ok: true; root: string }).root
            : null,
        agentPending: pending
          ? {
              actionId: pending.actionId,
              digest: pending.digest,
              tool: pending.tool,
              targets: [...pending.targets],
              provider: pending.provider,
              workspaceId: pending.workspaceId,
              threadId: pending.threadId,
              bodyPreview: pending.body.length > APPROVAL_PREVIEW_CHARS
                ? `${pending.body.slice(0, APPROVAL_PREVIEW_CHARS)}\n…[${pending.body.length - APPROVAL_PREVIEW_CHARS} more characters not shown. Reject if you need to see the whole action first.]`
                : pending.body,
            }
          : null,
        agentLog: inRunThread ? this.agentLogView.map((entry) => ({ ...entry })) : [],
        runThreadId: this.runThreadId,
        generation: this.generationView(),
        memory: this.memoryView,
        language: this.settings.language,
        consult: this.consultOffer !== null && this.consultOffer.threadId === active?.id
          ? { reason: this.consultOffer.reason, payload: this.consultOffer.payload, model: this.consultOffer.model, digest: this.consultOffer.digest }
          : null,
        missionLive: this.missionLiveView(active ? active.id : null),
        runKind: this.runKind,
        about: this.about,
      }),
    );
  }

  private generationView(): GenerationView {
    const provider = this.settings.provider;
    const model = this.generationModel(provider);
    const profile = this.generationProfile(provider, model);
    const reasoning = resolveReasoning(this.settings.generation, provider, model, profile);
    return {
      provider,
      model,
      reasoningOptions: ['default', ...profile.reasoningLevels],
      reasoning: reasoning.level ?? 'default',
      reasoningUnavailable: reasoning.unavailable ? reasoning.stored : null,
      reasoningDefault: profile.reasoningDefault,
      reasoningParam: profile.reasoningParam,
      source: profile.source,
      contextWindow: profile.contextWindow,
      autoOutputTokens: automaticOutputTokens(provider, reasoning.unavailable ? 'default' : reasoning.stored),
      maxOutputTokensLocal: this.settings.generation.maxOutputTokens.local,
      maxOutputTokensCloud: this.settings.generation.maxOutputTokens.cloud,
    };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lastUserText(thread: ChatThread | undefined): string | null {
  if (!thread) {
    return null;
  }
  for (let index = thread.turns.length - 1; index >= 0; index--) {
    const turn = thread.turns[index];
    if (turn && turn.kind === 'user') {
      return turn.text;
    }
  }
  return null;
}

function tryParseMissionPlan(text: string): MissionPlan | null {
  try {
    const decoded: unknown = JSON.parse(text);
    return validateMissionPlan(decoded);
  } catch {
    return null;
  }
}
