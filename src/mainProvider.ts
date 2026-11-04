/**
 * Extension-host side of the single `RAME Code` webview view.
 *
 * Delegation shell for VS Code lifecycle, state, routing, and controllers.
 *
 * Key-handling contract:
 * - The key is read from `vscode.SecretStorage` at call time and never
 *   leaves the extension host except inside the Meta HTTPS request.
 * - The webview receives only the boolean `hasKey` flag.
 * - Errors are redacted before display; the key never appears in HTML,
 *   postMessage state, logs, diagnostics, tests, or persisted data.
 *
 * Turns persist immediately. The local runtime is loopback-only, shell-free,
 * and stops only its tracked child, never an external endpoint.
 */

import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { AgentAuditLog } from './agentAudit.js';
import { chooseRunFolder, NO_PROJECT_TARGET, resolveRunRoot, type RunRoot } from './agentFolder.js';
import type { PendingAgentAction } from './agentApproval.js';
import {
  buildTestSpawnSpec,
  resolveTestInvocation,
  type AllowedTestCommand,
} from './agentCommands.js';
import {
  resolveCanonicalRoot,
  type AgentFs,
} from './agentHost.js';
import { AgentRunner } from './agentLoop.js';
import type { AgentChatMessage } from './agentModel.js';
import { formatProcessResult, runBoundedProcess } from './agentProcess.js';
import {
  MAX_TEST_OUTPUT_BYTES,
  resolveSingleWorkspaceRoot,
} from './agentPolicy.js';
import type { AgentProfileId } from './agentProfiles.js';
import { truncateToolOutput, type ValidatedToolCall } from './agentTools.js';
import {
  buildVerificationPrompt,
  cascadeAdviceSchema,
  CONSULT_OFFER_TTL_MS,
  validateCascadeAdvice,
  type CascadeAdvice,
} from './cascade.js';
import { createCascadeAdvice } from './meta-provider.js';
import {
  DecisionStore,
  type MemoryProposal,
} from './decisionStore.js';
import { SharedJsonFileBackend } from './sharedStateFile.js';
import type { MissionGrant, MissionLease, MissionRecord, MissionResult } from './missionStore.js';
import { MissionStore, setWaiting } from './missionStore.js';
import { isLiveMissionLease, unregisterLiveMissionLease } from './missionRuntime.js';
import { LocalAgentModelProvider, MetaAgentModelProvider } from './modelProviders/agentProvider.js';
import { npmTestContext } from './projectAdapters/npmProjectAdapter.js';
import { createVscodeWorkspaceFs } from './projectAdapters/vscodeWorkspaceFs.js';
import { guardDisposedWrites } from './hostLifecycle.js';
import { confirmAcceptanceScopeChangeDialog, confirmAcceptanceScopeDialog } from './acceptanceScopeDialog.js';
import { withBoundedRequest } from './boundedRequest.js';
import { ChatRunner } from './chatRunner.js';
import {
  REASONING_LABELS,
  automaticOutputTokens,
  isReasoningChoice,
  parseManualMaxOutput,
  resolveReasoning,
  withReasoningChoice,
  type GenerationProviderId,
  type GenerationRequest,
  type LocalServerProps,
} from './generationSettings.js';
import {
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
import { MissionRunner } from './missionRunner.js';
import { DEFAULT_CHAT_MODE, isSupportedMode } from './modes.js';
import {
  normalizeOpenFolders,
  NO_WORKSPACE_MESSAGE,
  validateChosenWorkspace,
  type OpenWorkspaceFolder,
} from './workspaceSelect.js';
import {
  MAX_HOST_RECORD_LINE_LENGTH,
} from './hostRecord.js';
import {
  appendAssistantTurn,
  appendErrorTurn,
  appendUserTurn,
  bindThreadWorkspace,
  ThreadStore,
  type ChatThread,
} from './threadStore.js';
import { addUsage, EMPTY_USAGE, type ProviderUsage } from './usage.js';
import {
  buildViewStateMessage,
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
import type { MissionPlan } from './types.js';
import type {
  ProviderHost,
  RunGeneration,
  AgentDecision,
  PendingEscalation,
  AgentOutcomeRecord,
} from './providerTypes.js';
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

// Extracted controller modules — all delegation goes through ProviderHost.
import * as genCtrl from './generationController.js';
import * as memCtrl from './memoryController.js';
import * as agentCtrl from './agentController.js';
import * as missionCoord from './missionCoordinator.js';
import * as remote from './remoteController.js';
import * as acceptanceReview from './missionAcceptanceReviewHost.js';
import * as localSource from './localSource.js';
import { idleConnectionOf } from './connectionState.js';
import { endpointUsable } from './localServers.js';
import { externalToolsRefusal } from './localSourceState.js';
import { CLOUD_DISCLOSURE_KEY, loadDisclosure, type CloudDisclosureOffer, type CloudRun, type DisclosureState } from './cloudDisclosure.js';
import { cloudGate, cloudMemoryText, credentialChanged, decideDisclosure, stopSharing } from './cloudDisclosureHost.js';
import { loadCredentialRevision, rotateCredentialRevision } from './metaRecipient.js';
import { launchFacts, ModelEvidenceStore, type LocalLaunchFacts } from './modelEvidence.js';
import { evidenceView } from './modelEvidenceRecorder.js';
import { ContinuityLogStore, continuityLogView } from './continuityLog.js';
import type { ChosenAdvisoryLimits } from './missionAdvisoryLimits.js';
import type { ConsultOffer, DelegationFailure, DelegationOffer, LocalIssue } from './remoteAuthority.js';
import { sendAgent as sendAgentFn } from './agentEngine.js';

export const API_KEY_SECRET = 'rameCode.metaModelApiKey';

export const MAIN_VIEW_ID = 'rameCode.main';

/** Non-secret marker of the run in flight: `{ threadId, pid, startedAt }`. */
export const RAME_ACTIVE_RUN_KEY = 'rameCode.activeRun.v1';

const INTERRUPTED_RUN_NOTE =
  'This run was interrupted because VS Code reloaded or closed before it finished. Its outcome was not recorded; check the workspace before retrying.';

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class RameCodeViewProvider implements vscode.WebviewViewProvider, ProviderHost {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private screen: ViewScreen = 'chat';
  hasKey = false;
  running = false;
  status = 'Starting…';
  connection: ViewConnection | string = 'missing-key';
  settings: RameSettings = defaultSettings();
  private usage: UsageTotals = defaultUsageTotals();
  private usageLast: ProviderUsage = { ...EMPTY_USAGE };
  private cloudCatalog: CloudModelInfo[] = fallbackCatalog();
  private localSettingsRev = 1;
  private readonly localRuntime = new LocalRuntimeManager({
    publish: async (status, message) => {
      this.localRuntime.replaceStatus(status);
      this.status = message;
      if (status.lifecycle === 'stopped') {
        this.localLaunch = null;
      }
      if (status.lifecycle === 'running' && this.localIssue?.kind === 'unreachable') {
        this.localIssue = null;
      }
      await this.postState();
    },
    probe: async (endpoint) => {
      await genCtrl.probeLocalProps(this, endpoint);
      // What /props confirmed (context, template) reaches the view without waiting for another event.
      await this.postState();
    },
    isBusy: () => this.isBusy(),
    idleTimeoutSeconds: () => this.settings.local.idleTimeoutSec,
  });
  escalation: EscalationState = { pending: false, reason: '' };
  pendingRequest: PendingEscalation | null = null;
  activeThreadId: string | null = null;
  disposed = false;
  readonly agentRunner = new AgentRunner();
  readonly audit = new AgentAuditLog();
  agentPending: PendingAgentAction | null = null;
  agentGeneration = 0;
  agentWaiter: { resolve: (choice: AgentDecision) => void } | null = null;
  agentLogView: Array<{ tool: string; digest: string; decision: string; result: string }> = [];
  agentRunWorkspace: { root: string; label: string } | null = null;
  runThreadId: string | null = null;
  localProps: { endpoint: string; props: LocalServerProps } | null = null;
  localLaunch: LocalLaunchFacts | null = null;
  readonly modelEvidence: ModelEvidenceStore;
  readonly continuityLog: ContinuityLogStore;
  readonly memory: DecisionStore;
  memoryPending: { action: PendingAgentAction; proposal: MemoryProposal } | null = null;
  memoryGeneration = 0;
  memoryView: MemoryView | null = null;
  memoryRoot: string | null = null;
  pinnedRunRoot: string | null = null;
  consultOffer: ConsultOffer | null = null;
  delegationOffer: DelegationOffer | null = null;
  delegationFailure: DelegationFailure | null = null;
  localIssue: LocalIssue | null = null;
  cloudConfirmed = false;
  cloudDisclosure: DisclosureState;
  cloudDisclosureOffer: CloudDisclosureOffer | null = null;
  cloudRun: CloudRun | null = null;
  readonly cloudToolGrants = new Map<string, boolean>();
  metaCredential: string;
  localConfirmed: string | null = null;
  delegatedRun: { threadId: string; root: string | null; text: string; mode: string } | null = null;
  cascadeVerification: { threadId: string } | null = null;
  hostPromptText: string | null = null;
  readonly missions: MissionStore;
  missionRecovery: Promise<number> = Promise.resolve(0);
  activeMission: { id: string; revision: number } | null = null;
  missionProfileCap: AgentProfileId | null = null;
  missionAuto: { missionId: string; stop: 'pause' | 'cancel' | null; holdAutonomy: boolean } | null = null;
  lastAgentOutcome: AgentOutcomeRecord | null = null;
  agentStepNow: number | null = null;
  missionTestCommands: string[] = [];
  missionSetup: { scopeId: string; testCommands: string[]; candidates: string[]; environmentFiles: string[]; packageJsonHash: string } | null = null;
  missionStartRequest: { requestId: string; missionId: string; state: 'authorizing' | 'started' | 'failed'; error: string } | null = null;
  missionStarting: string | null = null;
  runKind: RunKind = null;
  private readonly about: AboutView;
  acceptanceController: AbortController | null = null;
  readonly leaseToken = randomBytes(12).toString('hex');
  readonly extensionState: { get(key: string): unknown; update(key: string, value: unknown): unknown };
  readonly outputChannel: { clear(): void; appendLine(line: string): void; show(preserve: boolean): void };

  private get local(): LocalRuntimeStatus {
    return this.localRuntime.status;
  }

  private set local(status: LocalRuntimeStatus) {
    if (status.endpoint !== this.local.endpoint) agentCtrl.invalidatePendingApproval(this, 'the model server changed');
    this.localRuntime.replaceStatus(status);
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    readonly missionRunner: MissionRunner,
    readonly chatRunner: ChatRunner,
    readonly store: ThreadStore,
    state: {
      get(key: string): unknown;
      update(key: string, value: unknown): unknown;
    },
    output: vscode.OutputChannel,
    sharedStateDir?: string,
  ) {
    this.extensionState = state;
    this.outputChannel = output;
    const backend = sharedStateDir
      ? new SharedJsonFileBackend(sharedStateDir)
      : {
          get: (key: string) => state.get(key),
          update: async (key: string, value: unknown) => {
            await state.update(key, value);
          },
        };
    this.memory = new DecisionStore(backend);
    this.missions = new MissionStore(backend);
    this.about = readBuildInfo(this.extensionUri.fsPath);
    this.settings = validateSettings(state.get(RAME_SETTINGS_KEY));
    this.settings = this.reconcileCloudModel(this.settings, this.cloudCatalog);
    this.usage = validateUsageTotals(state.get(RAME_USAGE_KEY));
    this.audit.load(state.get(RAME_AUDIT_KEY));
    this.cloudDisclosure = loadDisclosure(state.get(CLOUD_DISCLOSURE_KEY));
    this.metaCredential = loadCredentialRevision(state);
    this.modelEvidence = new ModelEvidenceStore(state);
    this.continuityLog = new ContinuityLogStore(state);
    const runningElsewhere = this.recoverInterruptedRun();
    if (!runningElsewhere) {
      this.missionRecovery = this.missions.recoverInterrupted((lease) => this.isLeaseAlive(lease));
    }
  }

  // ----- VS Code lifecycle -----

  private recoverInterruptedRun(): boolean {
    const raw = this.extensionState.get(RAME_ACTIVE_RUN_KEY);
    if (raw === undefined || raw === null) {
      return false;
    }
    const record = typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const threadId = typeof record.threadId === 'string' ? record.threadId : null;
    const pid = typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : null;
    if (pid !== null && pid !== process.pid && isProcessAlive(pid)) {
      return true;
    }
    void this.extensionState.update(RAME_ACTIVE_RUN_KEY, undefined);
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
      settingsTabsUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settingsTabs.js'))
        .toString(),
      composerUxUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'composerUx.js'))
        .toString(),
      remoteUxUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'remoteUx.js')).toString(),
      evidenceUxUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'evidenceUx.js')).toString(),
      localServersUxUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'localServersUx.js')).toString(),
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
    this.chatRunner.close();
    this.cancelRequest();
    unregisterLiveMissionLease(this.leaseToken);
    this.localRuntime.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
    this.view = undefined;
  }

  // ----- ProviderHost callback implementations -----

  selectedCloudModel(): string {
    return validateCloudModelSelection(this.settings.cloudModel, this.cloudCatalog);
  }

  localEndpoint(): string | null {
    if (
      (this.local.lifecycle === 'running' ||
        this.local.lifecycle === 'starting') &&
      this.local.endpoint
    ) {
      return this.local.endpoint;
    }
    const external = this.settings.externalLocalEndpoint.trim();
    if (external.length > 0 && endpointUsable(external, this.settings.externalLocal.lan)) {
      return external;
    }
    return null;
  }

  armIdleShutdown(): void {
    this.localRuntime.armIdleShutdown();
  }

  agentFsFor(root: string): AgentFs {
    return guardDisposedWrites(createVscodeWorkspaceFs(root), () => this.disposed);
  }

  async heldCanonicalRoot(labelRoot: string, fs: AgentFs): Promise<string> {
    return resolveCanonicalRoot(fs, labelRoot);
  }

  async getApiKey(): Promise<string | undefined> {
    return this.secrets.get(API_KEY_SECRET);
  }

  listOpenWorkspaceFolders(): OpenWorkspaceFolder[] {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return normalizeOpenFolders(
      folders.map((folder) => ({ name: folder.name, path: folder.uri.fsPath })),
    );
  }

  /** The open project a Chat thread joins: the only open folder, else the one chosen in Settings; never a prompt. */
  chatProjectRoot(): string | undefined {
    const open = this.listOpenWorkspaceFolders();
    const chosen = this.memoryRoot !== null ? validateChosenWorkspace(this.memoryRoot, open) : null;
    return open.length === 1 ? (open[0] as OpenWorkspaceFolder).path : chosen ?? undefined;
  }

  isBoundRootStillOpen(boundRoot: string): boolean {
    return validateChosenWorkspace(boundRoot, this.listOpenWorkspaceFolders()) !== null;
  }

  heldWorkspaceRoot(): { ok: true; root: string } | { ok: false; error: string } {
    const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    return resolveSingleWorkspaceRoot(folders);
  }

  localStatus(): { owned: boolean; endpoint: string | null } {
    return { owned: this.local.owned, endpoint: this.local.endpoint };
  }

  async resolveAgentRunRoot(preferredRoot?: string | null): Promise<RunRoot> {
    return resolveRunRoot(this, preferredRoot);
  }

  async offerOpenFolderAction(): Promise<void> {
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

  async runAllowlistedTest(
    command: AllowedTestCommand,
    signal: AbortSignal,
    boundRoot?: string,
    env?: Record<string, string>,
  ): Promise<string> {
    if (this.disposed) {
      return 'not started: this RAME Code window was closed or reloaded';
    }
    const spec = buildTestSpawnSpec(command);
    const held = this.heldWorkspaceRoot();
    const cwd = boundRoot ?? (held.ok ? held.root : undefined);
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
    const result = await runBoundedProcess(
      {
        executable: invocation.executable,
        argv: invocation.argv,
        cwd,
        timeoutMs: spec.timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
        ...(env ? { env } : {}),
      },
      signal,
    );
    return truncateToolOutput(formatProcessResult(result, spec.timeoutMs, MAX_TEST_OUTPUT_BYTES));
  }

  confirmAcceptanceScope = confirmAcceptanceScopeDialog;
  confirmAcceptanceScopeChange = confirmAcceptanceScopeChangeDialog;

  recordUsage(provider: 'cloud' | 'local', usage: ProviderUsage): void {
    if (provider === 'local') {
      this.localConfirmed = this.localEndpoint();
    }
    this.usageLast = usage;
    this.usage = {
      ...this.usage,
      [provider]: addUsage(this.usage[provider], usage),
    };
    void this.extensionState.update(RAME_USAGE_KEY, this.usage);
  }

  persistSettings(): void {
    void this.extensionState.update(RAME_SETTINGS_KEY, this.settings);
  }

  async testCommandContext(boundRoot?: string): Promise<{
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

  // ----- Delegation to extracted generation controller -----

  generationModel(provider: ProviderId): string {
    return genCtrl.generationModel(this, provider);
  }

  snapshotGeneration(provider: ProviderId): Promise<RunGeneration> {
    return genCtrl.snapshotGeneration(this, provider);
  }

  generationRequest(
    run: RunGeneration,
    body: unknown,
    calibration?: { chars: number; tokens: number } | null,
  ): { request: GenerationRequest; note: string | null } {
    return genCtrl.generationRequest(run, body, calibration);
  }

  // ----- Delegation to extracted memory controller -----

  async refreshMemoryView(): Promise<void> {
    return memCtrl.refreshMemoryView(
      this,
      (scopeId, current) => missionCoord.missionView(this, scopeId, current),
    );
  }

  async memorySnapshotText(scope: { scopeId: string; label: string }, fs: AgentFs): Promise<string> {
    return cloudMemoryText(this, scope.label) ?? memCtrl.memorySnapshotText(this, scope, fs);
  }

  async liveArtifactHashes(scopeId: string, fs: AgentFs): Promise<Record<string, string | null>> {
    return memCtrl.liveArtifactHashes(this, scopeId, fs);
  }

  // ----- Delegation to extracted agent controller -----

  async liveApprovalContext(pending: PendingAgentAction): Promise<{
    workspaceId: string;
    threadId: string;
    provider: string;
    generation: number;
    currentHashes: Record<string, string>;
  }> {
    return agentCtrl.liveApprovalContext(this, pending);
  }

  // ----- Delegation to extracted mission coordinator -----

  async createMissionFromPlan(threadId: string, plan: MissionPlan): Promise<void> {
    return missionCoord.createMissionFromPlan(this, threadId, plan);
  }

  updateActiveMission(change: (mission: MissionRecord) => MissionResult<MissionRecord>): Promise<boolean> {
    return missionCoord.updateActiveMission(this, change);
  }

  isLeaseAlive(lease: MissionLease): boolean {
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

  // ----- Shell: navigation and threading -----

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

  async refreshAll(): Promise<void> {
    this.store.load();
    this.settings = validateSettings(this.extensionState.get(RAME_SETTINGS_KEY));
    this.settings = this.reconcileCloudModel(this.settings, this.cloudCatalog);
    this.localSettingsRev += 1;
    this.usage = validateUsageTotals(this.extensionState.get(RAME_USAGE_KEY));
    const stored = await this.secrets.get(API_KEY_SECRET);
    this.hasKey = stored !== undefined;
    this.connection = idleConnectionOf(this);
    this.ensureActiveThreadStillExists();
    const endpoint = this.settings.provider === 'local' && !this.running ? this.localEndpoint() : null;
    if (endpoint !== null) {
      await genCtrl.probeLocalProps(this, endpoint);
    }
    await this.refreshMemoryView();
    await this.postState();
  }

  async refreshHasKey(): Promise<void> {
    const stored = await this.secrets.get(API_KEY_SECRET);
    this.hasKey = stored !== undefined;
    this.connection = idleConnectionOf(this);
    await this.postState();
  }

  async newThread(): Promise<void> {
    agentCtrl.invalidatePendingApproval(this, 'the active thread changed');
    this.activeThreadId = null;
    this.agentRunWorkspace = null;
    if (!this.running) {
      this.status = 'New Agent thread started. Type a message below.';
    }
    if (this.settings.mode !== DEFAULT_CHAT_MODE) {
      this.settings = { ...this.settings, mode: DEFAULT_CHAT_MODE };
      this.persistSettings();
    }
    await this.postState();
  }

  async openThread(threadId: string): Promise<void> {
    const thread = this.store.get(threadId);
    if (!thread) {
      this.status = 'That thread is no longer stored.';
      await this.postState();
      return;
    }
    // Leaving a card's thread voids it; opening the thread a card waits in never does (that looped and left the run stuck).
    if (this.agentPending !== null && this.agentPending.threadId !== thread.id) {
      agentCtrl.invalidatePendingApproval(this, 'the active thread changed');
    }
    this.activeThreadId = thread.id;
    // Settings follows the folder already bound to the opened thread. This
    // changes only the memory inspector; a pending approval remains pinned.
    if (
      this.memoryPending === null &&
      thread.workspaceRoot !== undefined &&
      this.isBoundRootStillOpen(thread.workspaceRoot)
    ) {
      this.memoryRoot = thread.workspaceRoot;
    }
    this.status = `Opened "${thread.title}".`;
    await this.postState();
  }

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

  async backToList(): Promise<void> {
    agentCtrl.invalidatePendingApproval(this, 'the active thread changed');
    this.activeThreadId = null;
    this.agentRunWorkspace = null;
    if (!this.running) {
      this.status = 'Showing thread list.';
    }
    await this.postState();
  }

  async navigate(screen: ViewScreen): Promise<void> {
    this.screen = screen;
    if (screen === 'settings') {
      await this.refreshMemoryView();
    }
    await this.postState();
  }

  // ----- Shell: send message dispatch -----

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
        endpointUsable(this.settings.externalLocalEndpoint, this.settings.externalLocal.lan);
      const noTools = rawMode !== 'chat' ? externalToolsRefusal(this) : null;
      if (noTools !== null) {
        this.status = noTools;
        await this.postState();
        return;
      }
      if (!ownedReady && !externalReady) {
        this.connection = 'error';
        this.status =
          this.local.lifecycle === 'starting'
            ? 'Muse Glimmer is still starting. Wait for Running before sending.'
            : 'The local model is not running. Start Muse Glimmer, choose Meta Model API, or configure an external OpenAI-compatible loopback server.';
        if (this.local.lifecycle !== 'starting') {
          remote.localNotRunning(this, this.activeThreadId);
        }
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

    let thread = this.activeThreadId !== null
      ? this.store.get(this.activeThreadId)
      : undefined;
    let agentTarget: { root: string; label: string } | undefined;
    if (rawMode === 'agent' || rawMode === 'mission') {
      this.running = true;
      this.connection = 'working';
      this.status = `Selecting the project for this ${rawMode === 'mission' ? 'Mission' : 'Agent'} thread…`;
      await this.postState();
      // Agent without a folder runs without a project (web only); see agentFolder.ts.
      const target = await chooseRunFolder(this, thread, rawMode, provider);
      if (!this.running) {
        return;
      }
      if (target.kind === 'failed') {
        this.running = false;
        this.connection = target.cancelled ? 'cancelled' : 'error';
        this.status = target.error;
        await this.postState();
        if (!target.cancelled) {
          await this.offerOpenFolderAction();
        }
        return;
      }
      agentTarget = target.kind === 'bound' ? { root: target.root, label: target.label } : { ...NO_PROJECT_TARGET };
      if (rawMode === 'mission' && target.kind === 'bound') {
        // Planning itself reads no project files, but the saved Mission must
        // belong to the same user-selected project as its thread.
        this.memoryRoot = target.root;
      }
    }

    this.settings = {
      ...this.settings,
      provider,
      mode: rawMode,
      model,
    };
    this.persistSettings();

    // Chat joins the open project when that is unambiguous: no tools, only its decisions.
    const project = agentTarget?.root || (rawMode === 'chat' && !thread?.workspaceRoot ? this.chatProjectRoot() : undefined);
    if (!thread) {
      thread = this.store.create(text, rawMode, project);
      this.activeThreadId = thread.id;
    } else {
      // An internal Mission run is a Mission message (it runs through Agent's engine with the Mission's own permissions).
      thread = appendUserTurn(thread, text, undefined, { host: this.hostPromptText === text, mode: this.hostPromptText === text && this.activeMission !== null ? 'mission' : rawMode });
      if (project !== undefined && thread.workspaceRoot !== project) {
        thread = bindThreadWorkspace(thread, project);
      }
      this.store.save(thread);
    }
    const threadId = thread.id;

    await this.executeSend(threadId, text, rawMode, provider, agentTarget);
  }

  async executeSend(
    threadId: string,
    text: string,
    mode: string,
    provider: ProviderId,
    agentTarget?: { root: string; label: string },
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (provider === 'cloud' && !(await cloudGate(this, threadId, text, mode, agentTarget))) {
      return;
    }
    this.agentLogView = [];
    this.localIssue = null;
    this.runThreadId = threadId;
    this.runKind = this.missionAuto !== null || this.activeMission !== null ? 'mission-run' : mode === 'mission' ? 'mission-plan' : 'other';
    void this.extensionState.update(RAME_ACTIVE_RUN_KEY, { threadId, pid: process.pid, startedAt: Date.now() });
    this.running = true;
    this.connection = 'working';
    this.status =
      provider === 'cloud'
        ? `Working with ${this.selectedCloudModel()}…`
        : 'Working with the local runtime…';
    await this.postState();

    let generationNote: string | null = null;
    try {
      const generation = await this.snapshotGeneration(provider);
      if (generation.notes.length > 0) {
        generationNote = generation.notes.join(' ');
        this.status = `${this.status} ${generationNote}`;
        await this.postState();
      }
      if (mode === 'agent') {
        await sendAgentFn(this, threadId, text, provider, generation, agentTarget);
      } else if (provider === 'cloud') {
        await genCtrl.sendCloud(this, threadId, text, mode, generation);
      } else {
        await genCtrl.sendLocal(this, threadId, text, mode, generation);
      }
    } catch (error) {
      await genCtrl.handleSendError(this, threadId, provider, error);
    }
    if (generationNote !== null && !this.status.includes(generationNote)) {
      this.status = `${this.status} ${generationNote}`;
    }
    this.cloudRun = null;
    if (!this.disposed) {
      void this.extensionState.update(RAME_ACTIVE_RUN_KEY, undefined);
    }
    await this.refreshMemoryView();
    await this.postState();
  }

  // ----- Shell: generation settings -----

  async setReasoning(provider: ProviderId, model: string, rawLevel: string): Promise<void> {
    const current = this.generationModel(this.settings.provider);
    if (provider !== this.settings.provider || model !== current || !isReasoningChoice(rawLevel)) {
      this.status = 'Reasoning was not changed: the selection no longer matches the current runtime.';
      await this.postState();
      return;
    }
    const profile = genCtrl.generationProfile(this, provider, model);
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

  // ----- Shell: agent delegation -----

  async setAgentProfile(rawProfile: string): Promise<void> {
    return agentCtrl.setAgentProfile(this, rawProfile);
  }

  async approveAgentAction(actionId: string, digest: string): Promise<void> {
    return agentCtrl.approveAgentAction(this, actionId, digest);
  }

  async rejectAgentAction(actionId: string, digest: string): Promise<void> {
    return agentCtrl.rejectAgentAction(this, actionId, digest);
  }

  // ----- Shell: memory delegation -----

  async selectMemoryProject(rawPath: string): Promise<void> {
    return memCtrl.selectMemoryProject(
      this,
      rawPath,
      (scopeId, current) => missionCoord.missionView(this, scopeId, current),
    );
  }

  async proposeUserDecision(key: string, valueType: string, valueText: string): Promise<void> {
    return memCtrl.proposeUserDecision(
      this,
      key,
      valueType as import('./agentTools.js').DecisionValueType,
      valueText,
      (scopeId, current) => missionCoord.missionView(this, scopeId, current),
    );
  }

  async approveMemoryChange(actionId: string, digest: string): Promise<void> {
    return memCtrl.approveMemoryChange(
      this,
      actionId,
      digest,
      (scopeId, current) => missionCoord.missionView(this, scopeId, current),
    );
  }

  async rejectMemoryChange(actionId: string, digest: string): Promise<void> {
    return memCtrl.rejectMemoryChange(
      this,
      actionId,
      digest,
      (scopeId, current) => missionCoord.missionView(this, scopeId, current),
    );
  }

  // ----- Shell: mission delegation -----

  async runMissionTask(missionId: string, expectedRevision: number): Promise<void> {
    return missionCoord.runMissionTask(this, missionId, expectedRevision);
  }

  async startMission(
    missionId: string,
    expectedRevision: number,
    mode: MissionGrant['mode'],
    consultConfig: { maxConsultations: number; limits?: ChosenAdvisoryLimits | null } | null,
    trustedProject = false,
    acceptance: { commandId: string; files: string[] } | null = null,
  ): Promise<void> {
    return missionCoord.startMission(this, missionId, expectedRevision, mode, consultConfig, trustedProject, acceptance);
  }

  async requestMissionStart(
    requestId: string,
    starter: () => Promise<void>,
    missionId: string,
  ): Promise<void> {
    return missionCoord.requestMissionStart(this, requestId, starter, missionId);
  }

  async resumeMission(missionId: string, expectedRevision: number): Promise<void> {
    return missionCoord.resumeMission(this, missionId, expectedRevision);
  }

  async stopMission(missionId: string, action: 'pause' | 'cancel'): Promise<void> {
    return missionCoord.stopMission(this, missionId, action);
  }

  async retryMission(missionId: string, expectedRevision: number, guidance: string): Promise<void> {
    return missionCoord.retryMission(this, missionId, expectedRevision, guidance);
  }

  // ----- Shell: Meta paths (Advisory and delegated; see remoteController) -----

  async approveConsult(digest: string): Promise<void> {
    return remote.approveConsult(this, digest);
  }

  async dismissConsult(): Promise<void> {
    return remote.dismissConsult(this);
  }

  async includeConsultFiles(digest: string, files: string[]): Promise<void> {
    return remote.includeConsultFiles(this, digest, files);
  }

  // ----- Shell: language -----

  async setLanguage(language: ViewLanguage): Promise<void> {
    this.settings = { ...this.settings, language };
    this.persistSettings();
    await this.postState();
  }

  async approveEscalation(digest: string): Promise<void> {
    return remote.approveDelegation(this, digest);
  }

  async dismissEscalation(): Promise<void> {
    return remote.dismissDelegation(this);
  }

  async runDelegationLocally(): Promise<void> {
    return remote.runDelegationLocally(this);
  }

  cancelRequest(): boolean {
    let cancelled = false;
    if (this.acceptanceController !== null) {
      this.acceptanceController.abort();
      cancelled = true;
    }
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
      this.memory.discardProposals({ proposalId: this.memoryPending.proposal.proposalId });
      this.memoryPending = null;
      this.memoryGeneration += 1;
      cancelled = true;
    }
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

  // ----- Shell: cloud key management -----

  async saveKey(rawKey: string): Promise<void> {
    const checked = validateApiKeyInput(rawKey);
    if (!checked.ok || checked.apiKey === undefined) {
      this.status = checked.error ?? 'The API key is invalid.';
      await this.postState();
      return;
    }
    // The new revision is persisted before the key: approvals under the old key never apply to the new one.
    credentialChanged(this, rotateCredentialRevision(this.extensionState));
    await this.secrets.store(API_KEY_SECRET, checked.apiKey);
    this.hasKey = true;
    this.cloudConfirmed = false;
    if (!this.running) {
      this.connection = 'ready';
    }
    this.status = 'API key stored. Refreshing available models…';
    await this.postState();
    await this.refreshModels('save');
  }

  async clearKey(): Promise<void> {
    credentialChanged(this, rotateCredentialRevision(this.extensionState));
    await this.secrets.delete(API_KEY_SECRET);
    this.hasKey = false;
    this.cloudConfirmed = false;
    if (!this.running) {
      this.connection = 'missing-key';
    }
    this.status = 'API key cleared. Save a key to run cloud requests.';
    await this.postState();
  }

  // ----- Shell: non-secret settings -----

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
    if (provider !== this.settings.provider || model !== this.settings.model) agentCtrl.invalidatePendingApproval(this, 'the runtime or model changed');
    this.settings = {
      ...this.settings,
      provider,
      mode,
      model,
      allowCloudEscalation,
    };
    this.persistSettings();
    this.status = 'Settings saved.';
    this.connection = idleConnectionOf(this);
    const endpoint = provider === 'local' && !this.running ? this.localEndpoint() : null;
    if (endpoint !== null) {
      await genCtrl.probeLocalProps(this, endpoint);
    }
    await this.postState();
  }

  async selectCloudModel(rawModel: string): Promise<void> {
    const valid = validateCloudModelSelection(rawModel, this.cloudCatalog);
    const requested = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (requested !== valid) {
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

  async refreshModels(intent: 'refresh' | 'save' | 'test' = 'refresh'): Promise<void> {
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
      this.status = intent === 'save'
        ? 'API key stored. No key available for catalog refresh; using fallback catalog.'
        : intent === 'test'
          ? 'Meta connection not tested: save an API key first.'
          : 'No API key stored. Using fallback catalog.';
      await this.postState();
      return;
    }
    if (intent !== 'test') {
      this.status = 'Refreshing available models…';
      await this.postState();
    }
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
    this.cloudConfirmed = source === 'live';
    this.settings = { ...this.settings, cloudCatalogSource: source };
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
    this.status = intent === 'test'
      ? source === 'live'
        ? 'Meta connection verified. Live model catalog loaded.'
        : 'Meta connection test failed. Check the key, balance, network, and Meta service status.'
      : result.status;
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

  localTransition(event: Parameters<typeof nextLocalRuntimeStatus>[1]): void {
    this.local = nextLocalRuntimeStatus(this.local, event);
  }

  // ----- Shell: local runtime lifecycle -----

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
    this.settings = { ...this.settings, local: checked.settings };
    this.localSettingsRev += 1;
    this.persistSettings();
    if (this.local.lifecycle === 'stopped') {
      // Kept only while the process launched with these arguments lives.
      this.localLaunch = launchFacts(checked.settings);
    }
    await this.localRuntime.start(checked.settings);
  }

  /** "Start Muse Glimmer" on a failed request: the saved settings, only when offered. */
  async startAfterLocalIssue(): Promise<void> {
    if (this.localIssue === null || !this.localIssue.canStart) {
      this.status = 'Nothing to start: open the runtime settings to configure Muse Glimmer.';
      await this.postState();
      return;
    }
    this.localIssue = null;
    await this.startLocalRuntime();
  }

  async stopLocalRuntime(): Promise<void> {
    await this.localRuntime.stop();
  }

  private isBusy(): boolean {
    return (
      this.running ||
      this.missionRunner.isRunning ||
      this.chatRunner.isRunning ||
      this.agentRunner.isRunning
    );
  }

  // ----- Shell: state plumbing -----

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
      case 'testMetaConnection':
        await this.refreshModels('test');
        return;
      case 'openRepository':
        await vscode.env.openExternal(vscode.Uri.parse('https://github.com/caimari/rame-code'));
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
      case 'clearExternalEndpoint':
      case 'localServerScan':
      case 'localServerUse':
      case 'webAccessSet':
      case 'shellAccessSet':
      case 'missionWebSet':
      case 'localIdentity':
        await localSource.handleLocalSourceMessage(this, message);
        return;
      case 'escalateApprove':
        await this.approveEscalation(message.digest);
        return;
      case 'delegationRunLocal':
        await this.runDelegationLocally();
        return;
      case 'disclosureDecide':
        await decideDisclosure(this, message.digest, message.choice, message.toolResults === true);
        return;
      case 'disclosureStop':
        await stopSharing(this, this.activeThreadId);
        return;
      case 'localIssueStart':
        await this.startAfterLocalIssue();
        return;
      case 'acceptanceReviewPrepare':
      case 'acceptanceReviewSend':
      case 'acceptanceReviewCancel':
      case 'acceptanceReviewDecide':
        await acceptanceReview.handleAcceptanceReviewMessage(this, message);
        return;
      case 'consultIncludeFiles':
        await this.includeConsultFiles(message.digest, message.files);
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
            message.maxConsultations > 0 ? { maxConsultations: message.maxConsultations, limits: message.advisoryLimits ?? null } : null,
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

  async postState(): Promise<void> {
    if (this.disposed || !this.view) {
      return;
    }
    const threads = this.store.list();
    const active = this.activeTurns();
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
        connection: this.connection as ViewConnection,
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
        // The run's folder, else the open thread's own folder, else the only open folder; null = no project.
        agentWorkspace: this.agentRunWorkspace?.label
          ?? (active?.workspaceRoot && this.isBoundRootStillOpen(active.workspaceRoot) ? active.workspaceRoot
          : this.heldWorkspaceRoot().ok ? (this.heldWorkspaceRoot() as { ok: true; root: string }).root : null),
        agentPending: pending
          ? {
              actionId: pending.actionId,
              digest: pending.digest,
              tool: pending.tool,
              targets: [...pending.targets],
              provider: pending.provider,
              workspaceId: pending.workspaceId,
              threadId: pending.threadId,
              bodyPreview: agentCtrl.approvalBodyPreview(pending),
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
        missionLive: missionCoord.missionLiveView(this, active ? active.id : null),
        runKind: this.runKind,
        about: this.about,
        remote: remote.remoteView(this, active ? active.id : null, this.local.lifecycle),
        modelEvidence: evidenceView(this, active ? active.id : null, this.local.lifecycle, this.local.owned),
        continuityLog: continuityLogView(this.continuityLog.state, active ? active.id : null, this.continuityLog.discarded),
      }),
    );
  }

  private generationView(): GenerationView {
    const provider = this.settings.provider;
    const model = this.generationModel(provider);
    const profile = genCtrl.generationProfile(this, provider, model);
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

// ---------------------------------------------------------------------------
// Free functions
// ---------------------------------------------------------------------------

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
