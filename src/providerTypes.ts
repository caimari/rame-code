/**
 * Typed host interface for extracted controllers.
 *
 * RameCodeViewProvider implements this interface. Extracted controller
 * functions receive it as their first parameter, avoiding circular
 * imports and keeping the controllers free of the vscode API.
 */

import type { AgentAuditLog } from './agentAudit.js';
import type { PendingAgentAction } from './agentApproval.js';
import type { AllowedTestCommand } from './agentCommands.js';
import type { AgentFs } from './agentHost.js';
import type { AgentRunner } from './agentLoop.js';
import type { AgentChatMessage } from './agentModel.js';
import type { AgentProfileId } from './agentProfiles.js';
import type { ValidatedToolCall } from './agentTools.js';
import type { ChatRunner } from './chatRunner.js';
import type { DecisionStore, MemoryProposal } from './decisionStore.js';
import type {
  GenerationRequest,
  GenerationProviderId,
  LocalServerProps,
  ModelGenerationProfile,
  ReasoningLevel,
} from './generationSettings.js';
import type { MissionRunner } from './missionRunner.js';
import type {
  MissionGrant,
  MissionLease,
  MissionRecord,
  MissionResult,
  MissionStore,
} from './missionStore.js';
import type { ThreadStore, ChatThread } from './threadStore.js';
import type { ProviderId, RameSettings, UsageTotals } from './settingsStore.js';
import type { ProviderUsage } from './usage.js';
import type {
  EscalationState,
  MemoryView,
  MissionLiveView,
  MissionView,
  RunKind,
  ViewScreen,
  AboutView,
  ViewConnection,
} from './viewMessages.js';
import type { CloudModelInfo } from './metaCatalog.js';
import type { OpenWorkspaceFolder } from './workspaceSelect.js';
import type { MissionPlan } from './types.js';
import type { MissionViewRuntime } from './missionViews.js';
import type { LocalRuntimeStatus } from './localRuntime.js';

/**
 * Generation parameters fixed when a run starts.
 */
export interface RunGeneration {
  provider: GenerationProviderId;
  model: string;
  profile: ModelGenerationProfile;
  reasoning: ReasoningLevel | null;
  manualMax: number | null;
  notes: string[];
}

export type AgentDecision =
  | { kind: 'approve' }
  | { kind: 'reject' }
  | { kind: 'cancelled' }
  | { kind: 'stale'; reason: string };

export interface PendingEscalation {
  threadId: string;
  text: string;
  mode: string;
}

/**
 * Outcome of the latest Agent run, read by the Mission runner.
 */
export interface AgentOutcomeRecord {
  threadId: string;
  outcome: string;
  hostRecord: string[];
  report: string;
  lastTest?: { commandId: string; exitCode: number | null } | null;
  writes?: Array<{ path: string; hash: string | null }>;
  wroteAfterLastTest?: boolean;
  capabilityReason?: string | null;
  repeatedReads?: number;
}

/**
 * The host interface that extracted controllers receive.
 * RameCodeViewProvider implements this.
 */
export interface ProviderHost {
  // ----- State fields -----
  disposed: boolean;
  running: boolean;
  status: string;
  connection: ViewConnection | string;
  hasKey: boolean;
  settings: RameSettings;
  activeThreadId: string | null;
  runThreadId: string | null;
  runKind: RunKind;
  agentGeneration: number;
  agentPending: PendingAgentAction | null;
  agentWaiter: { resolve: (choice: AgentDecision) => void } | null;
  agentLogView: Array<{ tool: string; digest: string; decision: string; result: string }>;
  agentRunWorkspace: { root: string; label: string } | null;
  agentStepNow: number | null;
  escalation: EscalationState;
  pendingRequest: PendingEscalation | null;
  memoryRoot: string | null;
  memoryPending: { action: PendingAgentAction; proposal: MemoryProposal } | null;
  memoryGeneration: number;
  memoryView: MemoryView | null;
  activeMission: { id: string; revision: number } | null;
  missionProfileCap: AgentProfileId | null;
  missionAuto: { missionId: string; stop: 'pause' | 'cancel' | null; holdAutonomy: boolean } | null;
  missionStarting: string | null;
  missionStartRequest: { requestId: string; missionId: string; state: 'authorizing' | 'started' | 'failed'; error: string } | null;
  missionTestCommands: string[];
  missionSetup: { scopeId: string; testCommands: string[]; candidates: string[]; environmentFiles: string[]; packageJsonHash: string } | null;
  lastAgentOutcome: AgentOutcomeRecord | null;
  acceptanceController: AbortController | null;
  hostPromptText: string | null;
  pinnedRunRoot: string | null;
  consultOffer: {
    threadId: string;
    root: string;
    task: string;
    reason: string;
    payload: string;
    model: string;
    digest: string;
    createdAt: number;
    generation: number;
  } | null;
  cascadeVerification: { threadId: string } | null;
  localProps: { endpoint: string; props: LocalServerProps } | null;
  missionRecovery: Promise<number>;

  // ----- Services -----
  readonly store: ThreadStore;
  readonly extensionState: { get(key: string): unknown; update(key: string, value: unknown): unknown };
  readonly memory: DecisionStore;
  readonly missions: MissionStore;
  readonly audit: AgentAuditLog;
  readonly agentRunner: AgentRunner;
  readonly chatRunner: ChatRunner;
  readonly missionRunner: MissionRunner;
  readonly leaseToken: string;
  readonly outputChannel: { clear(): void; appendLine(line: string): void; show(preserve: boolean): void };

  // ----- Callbacks -----
  postState(): Promise<void>;
  persistSettings(): void;
  refreshMemoryView(): Promise<void>;
  recordUsage(provider: 'cloud' | 'local', usage: ProviderUsage): void;
  selectedCloudModel(): string;
  localEndpoint(): string | null;
  armIdleShutdown(): void;
  agentFsFor(root: string): AgentFs;
  heldCanonicalRoot(labelRoot: string, fs: AgentFs): Promise<string>;
  getApiKey(): Promise<string | undefined>;
  listOpenWorkspaceFolders(): OpenWorkspaceFolder[];
  isBoundRootStillOpen(root: string): boolean;
  heldWorkspaceRoot(): { ok: true; root: string } | { ok: false; error: string };
  localStatus(): { owned: boolean; endpoint: string | null };

  // ----- VS Code / process-specific operations -----
  resolveAgentRunRoot(): Promise<
    { ok: true; root: string; label: string } | { ok: false; cancelled: boolean; error: string }
  >;
  offerOpenFolderAction(): Promise<void>;
  runAllowlistedTest(command: AllowedTestCommand, signal: AbortSignal, boundRoot?: string): Promise<string>;
  cancelRequest(): boolean;
  isLeaseAlive(lease: MissionLease): boolean;

  // ----- Delegation to other extracted modules -----
  createMissionFromPlan(threadId: string, plan: MissionPlan): Promise<void>;
  snapshotGeneration(provider: ProviderId): Promise<RunGeneration>;
  generationModel(provider: ProviderId): string;
  generationRequest(
    run: RunGeneration,
    body: unknown,
    calibration?: { chars: number; tokens: number } | null,
  ): { request: GenerationRequest; note: string | null };
  testCommandContext(boundRoot?: string): Promise<{
    allowlist: AllowedTestCommand[];
    packageJsonRaw: string;
    scripts: Record<string, string>;
  }>;
  memorySnapshotText(scope: { scopeId: string; label: string }, fs: AgentFs): Promise<string>;
  liveApprovalContext(pending: PendingAgentAction): Promise<{
    workspaceId: string;
    threadId: string;
    provider: string;
    generation: number;
    currentHashes: Record<string, string>;
  }>;
  liveArtifactHashes(scopeId: string, fs: AgentFs): Promise<Record<string, string | null>>;
  updateActiveMission(change: (mission: MissionRecord) => MissionResult<MissionRecord>): Promise<boolean>;
  sendMessage(rawText: string, rawMode: string, rawRuntime: string): Promise<void>;
}
