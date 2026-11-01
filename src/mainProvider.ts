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

import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { chmod as nodeChmod, realpath as nodeRealpath, stat as nodeStat, statfs as nodeStatfs } from 'node:fs/promises';
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
  deriveAllowedCommands,
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
  WINDOWS_SET_EXECUTABLE_ERROR,
  resolveCanonicalRoot,
  type AgentFs,
} from './agentHost.js';
import { AgentRunner, buildAgentMessages } from './agentLoop.js';
import {
  assertAgentModelForProvider,
  buildAgentSystemPrompt,
  createLocalAgentCompletion,
  createMetaAgentCompletion,
  isAgentToolProtocolError,
  type AgentCompletion,
  type AgentChatMessage,
} from './agentModel.js';
import { applyPatchAtomically, hashContent } from './agentPatch.js';
import { formatProcessResult, runBoundedProcess } from './agentProcess.js';
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
import { truncateToolOutput, type ValidatedToolCall } from './agentTools.js';
import { ChatRunner } from './chatRunner.js';
import { createLocalChatCompletion } from './localProvider.js';
import {
  buildLlamaServerArgs,
  initialLocalRuntimeStatus,
  isLoopbackUrl,
  loopbackEndpoint,
  nextLocalRuntimeStatus,
  sanitizeDiagnostics,
  STARTUP_TIMEOUT_MS,
  validateLocalSettings,
  type LocalRuntimeStatus,
} from './localRuntime.js';
import {
  CLOUD_MODEL_FALLBACK,
  fallbackCatalog,
  refreshCompatibleModels,
  validateCloudModelSelection,
  type CloudModelInfo,
} from './metaCatalog.js';
import { createChatCompletion, validateMissionPlan } from './meta-provider.js';
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
} from './settingsStore.js';
import {
  appendErrorTurn,
  appendPlanTurn,
  appendAssistantTurn,
  appendUserTurn,
  fitTurnText,
  MAX_ASSISTANT_TEXT_LENGTH,
  ThreadStore,
  type ChatThread,
} from './threadStore.js';
import { addUsage, EMPTY_USAGE, type ProviderUsage } from './usage.js';
import {
  buildViewStateMessage,
  localUnreachableMessage,
  type EscalationState,
  type ViewConnection,
  type ViewScreen,
} from './viewMessages.js';
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

const MAX_DIAGNOSTIC_BYTES = 8192;
const APPROVAL_PREVIEW_CHARS = 2000;
const MAX_HOST_RECORD_LINES = 24;

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
  private local: LocalRuntimeStatus = initialLocalRuntimeStatus();
  private escalation: EscalationState = { pending: false, reason: '' };
  private pendingRequest: PendingEscalation | null = null;
  private activeThreadId: string | null = null;
  private disposed = false;
  private child: ChildProcess | null = null;
  private stderrTail: string[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
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
  ) {
    this.settings = validateSettings(this.state.get(RAME_SETTINGS_KEY));
    this.settings = this.reconcileCloudModel(this.settings, this.cloudCatalog);
    this.usage = validateUsageTotals(this.state.get(RAME_USAGE_KEY));
    // The durable audit is loaded for appending only: entries from earlier
    // sessions are never shown as the current run's Activity.
    this.audit.load(this.state.get(RAME_AUDIT_KEY));
    this.recoverInterruptedRun();
  }

  /**
   * A run marker left by an extension host that is gone (reload, crash,
   * window close) means its thread never received an outcome: record that
   * explicitly. A marker owned by another live window is left alone.
   */
  private recoverInterruptedRun(): void {
    const raw = this.state.get(RAME_ACTIVE_RUN_KEY);
    if (raw === undefined || raw === null) {
      return;
    }
    const record = typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const threadId = typeof record.threadId === 'string' ? record.threadId : null;
    const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : null;
    if (pid !== null && pid !== process.pid && isProcessAlive(pid)) {
      return;
    }
    void this.state.update(RAME_ACTIVE_RUN_KEY, undefined);
    const thread = threadId !== null ? this.store.get(threadId) : undefined;
    const lastTurn = thread?.turns[thread.turns.length - 1];
    if (thread && lastTurn?.kind === 'user') {
      this.store.save(appendErrorTurn(thread, INTERRUPTED_RUN_NOTE));
    }
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
    this.clearIdleTimer();
    this.stopOwnedChild();
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
      thread = this.store.create(text);
      this.activeThreadId = thread.id;
    } else {
      thread = appendUserTurn(thread, text);
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

    try {
      if (mode === 'agent') {
        await this.sendAgent(threadId, text, provider, agentTarget);
      } else if (provider === 'cloud') {
        await this.sendCloud(threadId, text, mode);
      } else {
        await this.sendLocal(threadId, text, mode);
      }
    } catch (error) {
      await this.handleSendError(threadId, provider, error);
    }
    if (!this.disposed) {
      void this.state.update(RAME_ACTIVE_RUN_KEY, undefined);
    }
    await this.postState();
  }

  private async sendCloud(
    threadId: string,
    text: string,
    mode: string,
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
    const cloudModel = this.selectedCloudModel();
    if (mode === 'mission') {
      const result = await this.missionRunner.startWithUsage({
        apiKey,
        goal: text,
        fetchImpl: undefined,
        model: cloudModel,
      });
      void built;
      this.recordUsage('cloud', result.usage);
      this.running = false;
      this.connection = 'verified';
      this.status = 'Plan ready.';
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendPlanTurn(current, result.plan));
      }
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
        }).then((completion) => {
          this.recordUsage('cloud', completion.usage);
          return completion.text;
        }),
      );
      this.running = false;
      this.connection = 'verified';
      this.status = 'Reply ready.';
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
    const modelId =
      this.settings.local.modelId.trim().length > 0
        ? this.settings.local.modelId.trim()
        : 'local-glimmer';
    const result = await this.chatRunner.start(async ({ signal }) =>
      createLocalChatCompletion({
        endpoint,
        model: modelId,
        messages: built.messages,
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
        this.status = 'Plan ready.';
      } else {
        if (current) {
          this.store.save(appendAssistantTurn(current, result));
        }
        this.status =
          'The local model did not return a strict plan; its reply is shown as prose.';
      }
    } else {
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendAssistantTurn(current, result));
      }
      this.status = 'Reply ready.';
    }
    this.running = false;
    this.connection = 'verified';
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
    const checked = verifyApproval(
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
    const rootUri = vscode.Uri.file(root);
    const join = (rel: string): vscode.Uri =>
      rel === '' ? rootUri : vscode.Uri.joinPath(rootUri, ...rel.split('/'));
    const fsPathFor = (rel: string): string =>
      rel === '' ? root : path.join(root, ...rel.split('/'));
    const canonicalRealpath = async (rel: string): Promise<string> =>
      nodeRealpath(fsPathFor(rel));
    return {
      async listEntries(rel: string) {
        const entries = await vscode.workspace.fs.readDirectory(join(rel));
        return entries.map(([name, type]) => ({
          name,
          isFile: (type & vscode.FileType.File) !== 0,
          isDir: (type & vscode.FileType.Directory) !== 0,
          isSymlink: (type & vscode.FileType.SymbolicLink) !== 0,
        }));
      },
      async readText(rel: string) {
        const bytes = await vscode.workspace.fs.readFile(join(rel));
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      },
      async stat(rel: string) {
        try {
          const info = await vscode.workspace.fs.stat(join(rel));
          if ((info.type & vscode.FileType.SymbolicLink) !== 0) {
            return { kind: 'symlink' as const };
          }
          if ((info.type & vscode.FileType.Directory) !== 0) {
            return { kind: 'dir' as const, size: info.size };
          }
          if ((info.type & vscode.FileType.File) !== 0) {
            const native = await nodeStat(fsPathFor(rel));
            return {
              kind: 'file' as const,
              size: info.size,
              ownerExecutable: (native.mode & 0o100) !== 0,
            };
          }
          return { kind: 'other' as const };
        } catch {
          return { kind: 'missing' as const };
        }
      },
      async writeText(rel: string, content: string) {
        await vscode.workspace.fs.writeFile(
          join(rel),
          new TextEncoder().encode(content),
        );
      },
      async createDirectory(rel: string) {
        await vscode.workspace.fs.createDirectory(join(rel));
      },
      async moveFile(source: string, destination: string) {
        await vscode.workspace.fs.rename(join(source), join(destination), { overwrite: false });
      },
      async deleteFile(rel: string) {
        await vscode.workspace.fs.delete(join(rel), { recursive: false, useTrash: false });
      },
      // Windows has no owner-executable bit: leave the capability out so
      // the host reports it as unavailable instead of faking a change.
      ...(process.platform === 'win32'
        ? {}
        : {
          async setOwnerExecutable(rel: string, executable: boolean) {
            const absolute = fsPathFor(rel);
            const info = await nodeStat(absolute);
            const nextMode = executable ? (info.mode | 0o100) : (info.mode & ~0o100);
            await nodeChmod(absolute, nextMode);
          },
        }),
      async filesystemUsage() {
        const info = await nodeStatfs(root, { bigint: true });
        const total = info.bsize * info.blocks;
        const free = info.bsize * info.bfree;
        const available = info.bsize * info.bavail;
        return {
          totalBytes: total.toString(),
          usedBytes: (total - free).toString(),
          freeBytes: free.toString(),
          availableBytes: available.toString(),
        };
      },
      // Bounded rollback-only delete: called solely for files created by the
      // exact pending patch during rollback. Never exposed as an Agent tool.
      async removeFile(rel: string) {
        await vscode.workspace.fs.delete(join(rel), { recursive: false });
      },
      // Direct Node canonicalization for local file workspaces. Retained
      // behind the testable AgentFs abstraction used by agentHost guards.
      async realpath(rel: string) {
        return canonicalRealpath(rel);
      },
      async realpathRoot() {
        return nodeRealpath(root);
      },
    };
  }

  /** Canonical root held for the run; falls back to the label when unavailable. */
  private async heldCanonicalRoot(labelRoot: string, fs: AgentFs): Promise<string> {
    return resolveCanonicalRoot(fs, labelRoot);
  }

  private async allowedTestCommands(): Promise<AllowedTestCommand[]> {
    return (await this.testCommandContext()).allowlist;
  }

  private parsePackageScripts(raw: string): Record<string, string> | undefined {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.scripts === 'object' && record.scripts !== null) {
          const scripts: Record<string, string> = {};
          for (const [key, value] of Object.entries(record.scripts as Record<string, unknown>)) {
            if (typeof value === 'string') {
              scripts[key] = value;
            }
          }
          return scripts;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async testCommandContext(boundRoot?: string): Promise<{
    allowlist: AllowedTestCommand[];
    packageJsonRaw: string;
    scripts: Record<string, string>;
  }> {
    let packageJsonRaw = '';
    let scripts: Record<string, string> = {};
    const root = boundRoot ?? (this.heldWorkspaceRoot().ok
      ? (this.heldWorkspaceRoot() as { ok: true; root: string }).root
      : null);
    if (root !== null) {
      try {
        const fs = this.agentFsFor(root);
        const raw = await fs.readText('package.json');
        packageJsonRaw = raw;
        scripts = this.parsePackageScripts(raw) ?? {};
      } catch {
        packageJsonRaw = '';
        scripts = {};
      }
    }
    // No explicit executable settings in this slice: derive only from
    // package.json safe scripts.
    return { allowlist: deriveAllowedCommands(scripts, []), packageJsonRaw, scripts };
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
    this.status = `Waiting for your approval: ${pending.tool}.`;
    void this.postState();
    return new Promise<AgentDecision>((resolve) => {
      const waiter = {
        resolve: (choice: AgentDecision): void => {
          signal.removeEventListener('abort', onAbort);
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
    resolvedTarget?: { root: string; label: string },
  ): Promise<void> {
    const profile: AgentProfileId = this.settings.agentProfile ?? DEFAULT_AGENT_PROFILE;
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
    await this.postState();
    const model =
      provider === 'cloud'
        ? this.selectedCloudModel()
        : this.settings.local.modelId.trim().length > 0
          ? this.settings.local.modelId.trim()
          : 'local-glimmer';
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
      for (const turn of thread.turns.slice(-20)) {
        if (turn.kind === 'user') {
          history.push({ role: 'user', content: turn.text.slice(0, 4000) });
        } else if (turn.kind === 'assistant') {
          history.push({ role: 'assistant', content: turn.text.slice(0, 4000) });
        }
      }
    }
    const fs = this.agentFsFor(workspaceId);
    const heldCanonicalRoot = await this.heldCanonicalRoot(workspaceId, fs);
    const extra: AgentChatMessage[] = [];
    // Host-verified record of every action this run executed (or that did
    // not run), appended to the final report so the persisted thread never
    // rests on the model's own claims alone.
    const hostRecord: string[] = [];
    const recordHostAction = (call: ValidatedToolCall, targets: string[], outcome: string): void => {
      if (hostRecord.length < MAX_HOST_RECORD_LINES) {
        hostRecord.push(`• ${call.tool} ${targets.join(', ').slice(0, 120)} → ${outcome}`.slice(0, 240));
      }
    };
    let steps = 0;
    let protocolRepairs = 0;
    let emptyReplies = 0;
    const outcome = await this.agentRunner.start(async (signal) => {
      agentSteps: for (let step = 0; step < MAX_AGENT_STEPS; step++) {
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
        const messages = buildAgentMessages(workspaceId, history, text, extra);
        let completion: AgentCompletion;
        try {
          completion = provider === 'cloud'
            ? await createMetaAgentCompletion({ apiKey, model, messages, signal }).then((result) => {
                this.recordUsage('cloud', result.usage);
                return result;
              })
            : await createLocalAgentCompletion({
                endpoint: this.localEndpoint() as string,
                model,
                messages,
                signal,
              }).then((result) => {
                this.recordUsage('local', result.usage);
                this.armIdleShutdown();
                return result;
              });
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
          if (protocolRepairs > 2) {
            const detail = 'The model repeatedly produced invalid tool arguments. No invalid action ran.';
            const current = this.store.get(threadId);
            if (current) {
              this.store.save(appendErrorTurn(current, detail));
            }
            this.status = detail;
            return 'policy-stop';
          }
          extra.push({
            role: 'system',
            content:
              'Your previous tool proposal was rejected before execution because it did not exactly match the declared JSON schema. ' +
              'Return one corrected allowlisted tool call with every required key and no extra keys. ' +
              'For filesystem_usage, use exactly {} as its arguments. ' +
              'For apply_patch, use {"files":[{"path":"relative/path","expectedHash":"the sha256 returned by read_file, or e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 for a new file","newContent":"full replacement text"}]}.',
          });
          const providerLabel = provider === 'local' ? 'local model' : 'Meta cloud model';
          this.status = `Correcting malformed tool call (${protocolRepairs}/2): waiting for the ${providerLabel} (120 s maximum)…`;
          await this.postState();
          continue agentSteps;
        }
        steps += 1;
        if (!completion.toolCalls || completion.toolCalls.length === 0) {
          const reply = (completion.text ?? '').trim().slice(0, 8000);
          if (reply.length === 0 && emptyReplies < 2) {
            emptyReplies += 1;
            extra.push({
              role: 'system',
              content:
                'Your previous response was empty. Continue the task with one valid tool call, or return the required concise final report. Do not return an empty response.',
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
            return 'policy-stop';
          }
          const current = this.store.get(threadId);
          if (current) {
            const record = hostRecord.length > 0 ? hostRecord.join('\n') : '• No tool actions ran.';
            const prefix = `Agent (${profile}, ${provider}): `;
            const recordBlock = `\n\nHost record (verified by RAME Code, not written by the model):\n${record}`;
            // If anything must be shortened to fit storage, it is the model's
            // prose, never the host-verified record.
            const room = MAX_ASSISTANT_TEXT_LENGTH - prefix.length - recordBlock.length;
            this.store.save(appendAssistantTurn(current, `${prefix}${fitTurnText(reply, Math.max(200, room))}${recordBlock}`));
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
          const digest = computeActionDigest({
            tool: call.tool,
            targets: described.targets,
            body: described.body,
            provider,
            workspaceId,
            threadId,
            preconditions: described.preconditions,
          });
          const auto = isAutoAllowed(profile, call.tool);
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
              this.recordAgentAudit(pending, 'rejected', 'cancelled before approval');
              throw new DOMException('Aborted', 'AbortError');
            }
            if (choice.kind === 'stale') {
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
          let resultText: string;
          try {
            resultText = await this.executeAgentTool(call, fs, testContext.allowlist, signal, workspaceId, heldCanonicalRoot);
          } catch (error) {
            if (
              (error instanceof Error && error.name === 'AbortError') ||
              (error instanceof DOMException && error.name === 'AbortError')
            ) {
              throw error;
            }
            const detail = error instanceof Error ? error.message : 'Tool failed.';
            if (isRecoverableAgentToolError(detail)) {
              // Show that the approved/auto action did not run, and why.
              this.recordAgentAudit(
                approvedPending ?? this.autoAuditRecord(call, described, provider, workspaceId, threadId, digest),
                approvedPending ? 'human' : 'profile-auto',
                `did not run: ${detail}`,
              );
              recordHostAction(call, described.targets, `did not run: ${detail}`);
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
                  `The tool did not run: ${detail} Inspect the current workspace state, then propose a corrected action.`,
                ),
              });
              this.status = `The workspace state differed; asking the Agent to inspect and retry…`;
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
          extra.push({
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: call.id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } },
            ],
          });
          extra.push({ role: 'tool', tool_call_id: call.id, content: truncateToolOutput(resultText) });
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
      const detail = `Agent stopped at its step budget (${MAX_AGENT_STEPS} model steps) without a final report. Check Activity for the actions that ran.`;
      this.status = detail;
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendErrorTurn(current, detail));
      }
    } else if (outcome === 'policy-stop') {
      this.running = false;
      this.connection = 'error';
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
    if (this.local.lifecycle === 'running' || this.local.lifecycle === 'starting') {
      this.status = 'The local runtime is already starting or running.';
      await this.postState();
      return;
    }
    if (this.local.lifecycle === 'stopping') {
      this.status = 'The local runtime is stopping. Try again in a moment.';
      await this.postState();
      return;
    }
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
    const endpoint = loopbackEndpoint(checked.settings.port);
    this.local = nextLocalRuntimeStatus(this.local, {
      kind: 'start-requested',
      endpoint,
    });
    this.status = `Starting the local runtime on ${endpoint}…`;
    await this.postState();

    const args = buildLlamaServerArgs(checked.settings);
    let child: ChildProcess;
    try {
      // Direct spawn with an argument array; never a shell command string.
      child = spawn(checked.settings.executablePath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      this.local = nextLocalRuntimeStatus(this.local, {
        kind: 'health-failed',
      });
      this.status = 'Could not start the local runtime executable.';
      await this.postState();
      return;
    }
    this.child = child;
    this.stderrTail = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const joined = (this.stderrTail.join('\n') + '\n' + text).slice(
        -MAX_DIAGNOSTIC_BYTES,
      );
      this.stderrTail = joined.split('\n').slice(-40);
    });
    // Spawn failures (e.g. missing executable) surface as an async 'error'
    // event, not a synchronous throw: handle it so a bad path can never
    // crash the host with an unhandled error event.
    child.on('error', () => {
      if (this.child === child) {
        this.child = null;
        this.clearIdleTimer();
        this.local = nextLocalRuntimeStatus(this.local, { kind: 'stopped' });
        this.local = {
          ...this.local,
          diagnostics: sanitizeDiagnostics(this.stderrTail),
        };
        this.status = 'Could not start the local runtime executable.';
        void this.postState();
      }
    });
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.clearIdleTimer();
        if (
          this.local.lifecycle === 'running' ||
          this.local.lifecycle === 'starting' ||
          this.local.lifecycle === 'stopping'
        ) {
          this.local = nextLocalRuntimeStatus(this.local, { kind: 'stopped' });
          this.local = {
            ...this.local,
            diagnostics: sanitizeDiagnostics(this.stderrTail),
          };
          this.status = 'The local runtime stopped.';
          void this.postState();
        }
      }
    });

    const healthy = await this.waitForHealth(endpoint, STARTUP_TIMEOUT_MS);
    if (this.child !== child) {
      return; // Stopped or replaced while waiting.
    }
    if (!healthy) {
      this.stopOwnedChild();
      this.local = nextLocalRuntimeStatus(this.local, {
        kind: 'health-failed',
      });
      this.local = {
        ...this.local,
        diagnostics: sanitizeDiagnostics(this.stderrTail),
      };
      this.status = `The local runtime did not become healthy within ${STARTUP_TIMEOUT_MS / 1000}s.`;
      await this.postState();
      return;
    }
    this.local = nextLocalRuntimeStatus(this.local, {
      kind: 'started',
      endpoint,
    });
    this.status = `Local runtime running on ${endpoint}.`;
    this.armIdleShutdown();
    await this.postState();
  }

  async stopLocalRuntime(): Promise<void> {
    if (!this.local.owned || !this.child) {
      this.status =
        'Nothing owned to stop. An external endpoint is never stopped by RAME.';
      await this.postState();
      return;
    }
    this.local = nextLocalRuntimeStatus(this.local, { kind: 'stop-requested' });
    this.status = 'Stopping the local runtime…';
    await this.postState();
    this.stopOwnedChild();
    this.local = nextLocalRuntimeStatus(this.local, { kind: 'stopped' });
    this.local = {
      ...this.local,
      diagnostics: sanitizeDiagnostics(this.stderrTail),
    };
    this.status = 'Local runtime stopped.';
    await this.postState();
  }

  private stopOwnedChild(): void {
    // Only the tracked child handle is signalled: never kill by port or
    // name, so unrelated processes are never touched.
    const owned = this.child;
    this.child = null;
    this.clearIdleTimer();
    try {
      owned?.kill();
    } catch {
      // The child may already have exited; deactivation still completes.
    }
  }

  private async waitForHealth(
    endpoint: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child === null) {
        return false; // Cancelled/stopped while waiting.
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
          const response = await fetch(`${endpoint}/health`, {
            signal: controller.signal,
          });
          if (response.ok) {
            return true;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Not up yet; retry until the deadline.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  private armIdleShutdown(): void {
    this.clearIdleTimer();
    const idleSec = this.settings.local.idleTimeoutSec;
    if (!this.local.owned || idleSec <= 0) {
      return;
    }
    this.idleTimer = setTimeout(
      () => {
        // A run waiting for approval or a test is not idle: stopping the
        // runtime now would fail its next model call.
        if (this.isBusy()) {
          this.armIdleShutdown();
          return;
        }
        void this.stopLocalRuntime();
      },
      idleSec * 1000,
    );
    const timer = this.idleTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private isBusy(): boolean {
    return (
      this.running ||
      this.missionRunner.isRunning ||
      this.chatRunner.isRunning ||
      this.agentRunner.isRunning
    );
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
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
      }),
    );
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

/**
 * Content-free one-line outcome for Activity/audit. Tool output may hold
 * file text or matched lines, so only its structural first line (or a
 * count) is kept.
 */
function summarizeToolResult(tool: string, resultText: string): string {
  const lines = resultText.split('\n');
  let summary: string;
  if (tool === 'search_text') {
    summary = resultText.trim() === '(no matches)' ? 'no matches' : `${lines.filter((line) => line.length > 0).length} matching line(s)`;
  } else if (tool === 'list_files') {
    summary = resultText.trim() === '(empty directory)' ? 'empty directory' : `${lines.filter((line) => line.length > 0).length} entr(ies) listed`;
  } else if (tool === 'read_file') {
    summary = `read ${(lines[0] ?? '').replace(/^path: /, '')}`;
  } else {
    summary = lines[0] ?? '';
  }
  return summary.slice(0, 120);
}

/** Failures with no side effects that the bounded loop may inspect and repair. */
function isRecoverableAgentToolError(detail: string): boolean {
  return [
    'That file does not exist.',
    'That directory does not exist.',
    'The source file does not exist.',
    'The target already exists; inspect and re-propose the action.',
    'The destination already exists; overwrite is not allowed.',
    'The source changed; re-read and re-propose the action.',
    'The file changed; re-read and re-propose the action.',
  ].includes(detail);
}
