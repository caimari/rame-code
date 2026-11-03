/** Agent execution engine, extracted from RameCodeViewProvider.sendAgent. */

import * as path from 'node:path';

import type { PendingAgentAction } from './agentApproval.js';
import {
  computeActionDigest,
  createPendingAction,
  MISSING_FILE_PRECONDITION,
} from './agentApproval.js';
import {
  boundRunTestsStillMatches,
  derivedNpmScriptName,
  describeBoundRunTestsAction,
  findAllowedCommand,
  isDerivedNpmTestCommand,
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
  type AgentFs,
} from './agentHost.js';
import { buildAgentMessages } from './agentLoop.js';
import {
  AgentOutputTruncatedError,
  assertAgentModelForProvider,
  buildAgentSystemPrompt,
  isAgentToolProtocolError,
  LocalMalformedToolCallError,
  type AgentChatMessage,
  type AgentCompletion,
} from './agentModel.js';
import { hashContent } from './agentPatch.js';
import { checkAgentRelPath, MAX_AGENT_STEPS } from './agentPolicy.js';
import {
  DEFAULT_AGENT_PROFILE,
  isAutoAllowed,
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
  applyPatchViaFs,
  checkReplacement,
} from './agentController.js';
import {
  buildConsultPayload,
  consultDigest,
  type LocalStopKind,
} from './cascade.js';
import { checkUserStatement } from './decisionSource.js';
import {
  describeProposal,
  scopeIdForRoot,
  type MemoryAuthorization,
  type MemoryProposal,
} from './decisionStore.js';
import { GenerationContextError } from './generationSettings.js';
import {
  assistantHistoryText,
  MAX_HOST_RECORD_LINE_LENGTH,
  MAX_HOST_RECORD_LINES,
  NO_HOST_ACTIONS_LINE,
  sanitizeAgentReply,
} from './hostRecord.js';
import { LocalAgentModelProvider, MetaAgentModelProvider } from './modelProviders/agentProvider.js';
import {
  frozenPaths,
  grantAllows,
  journalAction,
  setWaiting,
} from './missionStore.js';
import {
  MEMORY_RULES_TEXT,
} from './projectMemory.js';
import type { ProviderId } from './settingsStore.js';
import { RAME_AUDIT_KEY } from './settingsStore.js';
import {
  appendAssistantTurn,
  appendErrorTurn,
  fitTurnText,
  MAX_ASSISTANT_TEXT_LENGTH,
  userWrittenTexts,
} from './threadStore.js';
import {
  isRecoverableAgentToolError,
  summarizeToolResult,
} from './toolResultSummary.js';
import {
  memoryPreconditionKey,
  memoryPreconditionValue,
} from './projectMemory.js';
import type { AgentDecision, ProviderHost, RunGeneration } from './providerTypes.js';

const AGENT_STEPS_WARNING_REMAINING = 2;
const MISSION_LOW_BUDGET_STEPS = 4;
const MISSION_REPEAT_CHECK_TOOLS = new Set([
  'list_files',
  'inspect_workspace',
  'filesystem_usage',
  'search_text',
  'read_file',
]);
const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'apply_patch',
  'replace_in_file',
  'create_directory',
  'move_file',
  'delete_file',
  'set_executable',
]);
const AGENT_HISTORY_TEXT_LIMIT = 4000;

function capProfile(profile: AgentProfileId, cap: AgentProfileId | null): AgentProfileId {
  if (cap === null) {
    return profile;
  }
  const order: AgentProfileId[] = ['ask', 'safe-auto', 'workspace-full'];
  return order.indexOf(cap) < order.indexOf(profile) ? cap : profile;
}

function historyText(text: string): string {
  if (text.length <= AGENT_HISTORY_TEXT_LIMIT) {
    return text;
  }
  return (
    `${text.slice(0, AGENT_HISTORY_TEXT_LIMIT)}\n` +
    `…[RAME Code shortened this earlier message: ${text.length - AGENT_HISTORY_TEXT_LIMIT} characters left out]`
  );
}

function recordAgentAudit(
  host: ProviderHost,
  pending: PendingAgentAction,
  decision: 'human' | 'profile-auto' | 'rejected' | 'policy',
  result: string,
): void {
  const entry = host.audit.append({
    provider: pending.provider,
    threadId: pending.threadId,
    profile: host.settings.agentProfile,
    tool: pending.tool,
    digest: pending.digest,
    decision,
    result,
  });
  void host.extensionState.update(RAME_AUDIT_KEY, host.audit.list());
  host.agentLogView = [
    ...host.agentLogView,
    {
      tool: entry.tool,
      digest: entry.digest.slice(0, 16),
      decision: entry.decision,
      result: entry.result,
    },
  ].slice(-20);
}

function failAgentWithAudit(
  host: ProviderHost, call: ValidatedToolCall, provider: string,
  threadId: string, workspaceId: string, decision: 'policy' | 'rejected',
  auditResult: string, status: string,
): void {
  const described = describeAgentCall(call);
  const desc = { tool: call.tool, targets: described.targets, body: described.body, provider, workspaceId, threadId, preconditions: described.preconditions };
  const digest = computeActionDigest(desc);
  const pending: PendingAgentAction = {
    ...desc, actionId: `blocked_${digest.slice(0, 16)}`, digest, createdAt: Date.now(), generation: host.agentGeneration, used: true,
  };
  recordAgentAudit(host, pending, decision, auditResult);
  host.status = status;
}

function recordBlockedProposal(
  host: ProviderHost, call: ValidatedToolCall, provider: string,
  threadId: string, workspaceId: string, reason: string,
): void {
  const described = describeAgentCall(call);
  const desc = { tool: call.tool, targets: described.targets, body: described.body, provider, workspaceId, threadId, preconditions: described.preconditions };
  const digest = computeActionDigest(desc);
  recordAgentAudit(host, { ...desc, actionId: `blocked_${digest.slice(0, 16)}`, digest, createdAt: Date.now(), generation: host.agentGeneration, used: true }, 'policy', reason);
}

function autoAuditRecord(
  host: ProviderHost,
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
    generation: host.agentGeneration,
    used: true,
  };
}

async function checkWorkspaceStillHeld(
  host: ProviderHost,
  expectedRoot: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!host.isBoundRootStillOpen(expectedRoot)) {
    return { ok: false, error: 'The workspace changed.' };
  }
  return { ok: true };
}

async function checkCanonicalStillHeld(
  host: ProviderHost,
  fs: AgentFs,
  heldCanonicalRoot: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const current = await host.heldCanonicalRoot(heldCanonicalRoot, fs);
    if (current !== heldCanonicalRoot) {
      return { ok: false, error: 'The workspace changed.' };
    }
  } catch {
    return { ok: false, error: 'The workspace changed.' };
  }
  return { ok: true };
}

function describeBoundTestCall(
  host: ProviderHost,
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

async function verifyBoundTestStillApproved(
  host: ProviderHost,
  approved: { body: string; preconditions: Record<string, string> },
  boundRoot?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fresh = await host.testCommandContext(boundRoot);
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

async function bindPatchApprovalPreconditions(
  _host: ProviderHost,
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

async function executeAgentTool(
  host: ProviderHost,
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
      for (const file of files) {
        const gate = checkAgentRelPath(file.path);
        if (!gate.ok) {
          throw new Error(gate.error);
        }
        await guardFsPath(fs, (gate as { ok: true; rel: string }).rel, canonicalRoot ?? null);
      }
      return applyPatchViaFs(files, fs, signal, canonicalRoot ?? null);
    }
    case 'replace_in_file': {
      const checked = await checkReplacement(call, fs, canonicalRoot ?? null);
      if (!checked.ok) {
        throw new Error(checked.error);
      }
      const args = call.args as unknown as ReplaceInFileArgs;
      const applied = await applyPatchViaFs(
        [{ path: checked.rel, expectedHash: args.expectedHash, newContent: checked.newContent }],
        fs,
        signal,
        canonicalRoot ?? null,
      );
      return `Replaced 1 fragment in ${checked.rel} (${args.oldText.length} -> ${args.newText.length} characters).\n${applied}`;
    }
    case 'read_decisions': {
      const root = canonicalRoot ?? workspaceId;
      return host.memorySnapshotText({ scopeId: scopeIdForRoot(root), label: path.basename(root) }, fs);
    }
    case 'propose_decision':
    case 'bind_artifact':
      throw new Error('Memory changes are committed only through your approval.');
    case 'run_tests': {
      const id = String((call.args as Record<string, unknown>).commandId ?? '');
      const command = findAllowedCommand(allowlist, id);
      if (!command || !isDerivedNpmTestCommand(command)) {
        throw new Error('That test command is not allowlisted.');
      }
      return host.runAllowlistedTest(command, signal, workspaceId);
    }
    default:
      throw new Error('Unknown tool.');
  }
}

function prepareModelDecision(
  host: ProviderHost,
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
  const statement = checkUserStatement({ quote: args.userWords, value, userMessages: userWrittenTexts(host.store.get(threadId)) });
  if (!statement.ok) {
    return statement;
  }
  return host.memory.preparePut({
    scopeId: scope.scopeId,
    scopeLabel: scope.label,
    key: args.key,
    value,
    expectedVersion: args.expectedVersion,
    provenance: { source: 'model', provider, threadId, reason: args.reason, quote: statement.quote },
  });
}

async function prepareModelArtifact(
  host: ProviderHost,
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
  return host.memory.prepareArtifactBinding({
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

function describeMemoryProposal(
  _host: ProviderHost,
  proposal: MemoryProposal,
): { targets: string[]; body: string; preconditions: Record<string, string> } {
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

async function commitModelProposal(
  host: ProviderHost,
  proposal: MemoryProposal,
  approved: PendingAgentAction | null,
  threadId: string,
  provider: ProviderId,
): Promise<string> {
  if (approved === null || !approved.used) {
    host.memory.discardProposals({ proposalId: proposal.proposalId });
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
  const result = await host.memory.commitAuthorizedChange(authorization);
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

function bindArtifactHint(
  host: ProviderHost,
  resultText: string,
  scopeId: string,
  changedFiles: ReadonlySet<string>,
  commandId: string,
): string {
  if (!/^exit=0\b/.test(resultText) || changedFiles.size === 0) {
    return '';
  }
  const decisions = host.memory.listCurrentDecisions(scopeId);
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

function waitForAgentDecision(
  host: ProviderHost,
  pending: PendingAgentAction,
  signal: AbortSignal,
): Promise<AgentDecision> {
  host.agentPending = pending;
  if (host.activeMission !== null) {
    void host.updateActiveMission((mission) => setWaiting(mission, true));
  }
  host.status = `Waiting for your approval: ${pending.tool}.`;
  void host.postState();
  return new Promise<AgentDecision>((resolve) => {
    const waiter = {
      resolve: (choice: AgentDecision): void => {
        signal.removeEventListener('abort', onAbort);
        if (host.activeMission !== null) {
          void host.updateActiveMission((mission) => setWaiting(mission, false));
        }
        resolve(choice);
      },
    };
    const onAbort = (): void => {
      if (host.agentPending?.actionId === pending.actionId) {
        host.agentPending = null;
      }
      host.agentWaiter = null;
      resolve({ kind: 'cancelled' });
    };
    host.agentWaiter = waiter;
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function currentFileHash(fs: AgentFs, file: string): Promise<string | null> {
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

function frozenTarget(
  host: ProviderHost,
  targets: readonly string[],
): string | null {
  const auto = host.missionAuto;
  if (auto === null) {
    return null;
  }
  const frozen = frozenPaths(host.missions.get(auto.missionId));
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

function missionGrantAllows(
  host: ProviderHost,
  tool: string,
  scopeId: string,
  provider: string,
  model: string,
  test: { commandId: string; packageJsonHash: string },
): boolean {
  const auto = host.missionAuto;
  if (auto === null || host.activeMission === null || auto.missionId !== host.activeMission.id || auto.holdAutonomy) {
    return false;
  }
  return grantAllows(host.missions.get(auto.missionId), { missionId: auto.missionId, scopeId, provider, model }, tool, test);
}

function offerConsult(
  host: ProviderHost,
  input: { threadId: string; root: string; task: string; reason: string; hostRecord: string[]; scopeId: string },
): void {
  if (!host.settings.allowCloudEscalation) {
    host.status = `${host.status} Asking Meta for advice needs cloud escalation ON in Settings; nothing was sent.`;
    return;
  }
  const model = host.selectedCloudModel();
  const payload = buildConsultPayload({
    task: input.task,
    reason: input.reason,
    hostRecord: input.hostRecord,
    decisions: host.memory.listCurrentDecisions(input.scopeId).map((entry) => ({ key: entry.key, value: entry.value, version: entry.version })),
  });
  host.consultOffer = {
    threadId: input.threadId,
    root: input.root,
    task: input.task,
    reason: input.reason,
    payload,
    model,
    digest: consultDigest(payload, model, input.threadId),
    createdAt: Date.now(),
    generation: host.agentGeneration,
  };
  host.status = `${host.status} You can ask Meta ${model} for advice with the exact text shown, or dismiss.`;
}

/** Bounded Agent run with the explicitly selected provider only. */
export async function sendAgent(
  host: ProviderHost,
  threadId: string,
  text: string,
  provider: ProviderId,
  generation: RunGeneration,
  resolvedTarget?: { root: string; label: string },
): Promise<void> {
  const profile: AgentProfileId = capProfile(host.settings.agentProfile ?? DEFAULT_AGENT_PROFILE, host.missionProfileCap);
  const target: { ok: true; root: string; label: string } | { ok: false; cancelled: boolean; error: string } = resolvedTarget
    ? { ok: true, root: resolvedTarget.root, label: resolvedTarget.label }
    : await host.resolveAgentRunRoot();
  if (!target.ok) {
    host.running = false;
    if (target.cancelled) {
      host.connection = 'cancelled';
      host.status = target.error;
      await host.postState();
      return;
    }
    host.connection = 'error';
    host.status = target.error;
    const current = host.store.get(threadId);
    if (current) {
      host.store.save(appendErrorTurn(current, target.error));
    }
    await host.offerOpenFolderAction();
    return;
  }
  const workspaceId = target.root;
  host.agentRunWorkspace = { root: target.root, label: target.label };
  if (host.memoryPending === null) {
    host.memoryRoot = target.root;
  }
  await host.postState();
  const model = generation.model;
  try {
    assertAgentModelForProvider(provider, model);
  } catch (error) {
    host.running = false;
    host.connection = 'error';
    const detail = error instanceof Error ? error.message : 'Invalid Agent model.';
    host.status = detail;
    const current = host.store.get(threadId);
    if (current) {
      host.store.save(appendErrorTurn(current, detail));
    }
    return;
  }
  let apiKey = '';
  if (provider === 'cloud') {
    const stored = await host.getApiKey();
    if (!stored) {
      host.hasKey = false;
      host.running = false;
      host.connection = 'missing-key';
      host.status = 'No API key stored. Save a Meta Model API key to begin.';
      const current = host.store.get(threadId);
      if (current) {
        host.store.save(appendErrorTurn(current, 'No API key stored.'));
      }
      return;
    }
    apiKey = stored;
  } else {
    const endpoint = host.localEndpoint();
    if (!endpoint) {
      throw new Error('The local runtime is not running and no external endpoint is selected.');
    }
  }
  const thread = host.store.get(threadId);
  const history: AgentChatMessage[] = [];
  if (thread) {
    const missionRun = host.missionAuto !== null;
    let hostSegment = false;
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
  const fs = host.agentFsFor(workspaceId);
  const heldCanonicalRoot = await host.heldCanonicalRoot(workspaceId, fs);
  const extra: AgentChatMessage[] = [];
  const memoryScope = { scopeId: scopeIdForRoot(heldCanonicalRoot), label: path.basename(target.root) };
  const runTools = [...buildAgentToolDefinitions(), ...buildMemoryToolDefinitions()];
  extra.push({ role: 'system', content: `${MEMORY_RULES_TEXT}\n${await host.memorySnapshotText(memoryScope, fs)}` });
  let workspaceWrites = 0;
  const seenReadResults = new Map<string, { digest: string; step: number }>();
  let repeatedReads = 0;
  let actNudged = false;
  let lowBudgetNoted = false;
  const changedFiles = new Set<string>();
  const testRuns: Array<{ commandId: string; exitCode: number | null; writes: number; at: number; outputDigest: string }> = [];
  const memoryProposals = new Map<string, MemoryProposal>();
  const hostRecord: string[] = [];
  const recordHostAction = (call: ValidatedToolCall, targets: string[], outcome: string): void => {
    if (hostRecord.length < MAX_HOST_RECORD_LINES) {
      const tgt = targets.join(', ').slice(0, 120);
      const line = `\u2022 ${call.tool}${tgt.trim().length > 0 ? ` ${tgt}` : ''} \u2192 ${outcome}`;
      hostRecord.push(line.replace(/[\r\n]+/g, ' ').slice(0, MAX_HOST_RECORD_LINE_LENGTH));
    }
  };
  let steps = 0;
  let lastStepToolCallsRefused = false;
  let protocolRepairs = 0;
  let emptyReplies = 0;
  let stopKind = 'policy' as LocalStopKind;
  let calibration: { chars: number; tokens: number } | null = null;
  let lastBudgetNote: string | null = null;
  const outcome = await host.agentRunner.start(async (signal) => {
    agentSteps: for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      host.agentStepNow = step + 1;
      if (host.missionAuto !== null) {
        await host.postState();
      }
      const stale = await checkWorkspaceStillHeld(host, workspaceId);
      if (!stale.ok) {
        return 'stale';
      }
      const canonicalStale = await checkCanonicalStillHeld(host, fs, heldCanonicalRoot);
      if (!canonicalStale.ok) {
        return 'stale';
      }
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (host.missionAuto !== null && !lowBudgetNoted && MAX_AGENT_STEPS - step <= MISSION_LOW_BUDGET_STEPS && workspaceWrites === 0 && testRuns.length === 0) {
        lowBudgetNoted = true;
        extra.push({
          role: 'system',
          content:
            `Only ${MAX_AGENT_STEPS - step} model steps remain in this internal run and nothing has changed yet. Stop exploring: ` +
            'make the smallest change that meets the task now, run the allowlisted test, then report.',
        });
      }
      if (MAX_AGENT_STEPS - step === AGENT_STEPS_WARNING_REMAINING) {
        extra.push({
          role: 'system',
          content:
            `Only ${AGENT_STEPS_WARNING_REMAINING} model steps remain in this run's budget of ${MAX_AGENT_STEPS}. ` +
            'Use at most one more tool call, and only if it is essential; then return the required final report: ' +
            'what you did, files changed (or none), tests/checks run and their result, and what remains unfinished.',
        });
      }
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
      const toolChoice = lastStep && provider === 'local' ? 'none' : 'auto';
      const messages = buildAgentMessages(workspaceId, history, text, extra);
      const estimateBody = { messages, tools: runTools };
      let stepRequest: ReturnType<ProviderHost['generationRequest']>;
      try {
        stepRequest = host.generationRequest(generation, estimateBody, calibration);
      } catch (error) {
        if (!(error instanceof GenerationContextError)) {
          throw error;
        }
        const detail = `The Agent stopped before model step ${step + 1}: ${error.message}`;
        const current = host.store.get(threadId);
        if (current) {
          host.store.save(appendErrorTurn(current, detail.slice(0, 500)));
        }
        host.status = detail;
        stopKind = 'context';
        return 'policy-stop';
      }
      if (stepRequest.note !== null && stepRequest.note !== lastBudgetNote) {
        lastBudgetNote = stepRequest.note;
        host.status = stepRequest.note;
        await host.postState();
      }
      let completion: AgentCompletion;
      try {
        const modelProvider = provider === 'cloud'
          ? new MetaAgentModelProvider(apiKey)
          : new LocalAgentModelProvider(host.localEndpoint() as string);
        completion = await modelProvider.complete({
          model,
          messages,
          generation: stepRequest.request,
          tools: runTools,
          signal,
          toolChoice,
        });
        host.recordUsage(modelProvider.id, completion.usage);
        if (modelProvider.id === 'local') {
          host.armIdleShutdown();
        }
        if (completion.usage.inputTokens > 0) {
          calibration = { chars: JSON.stringify(estimateBody).length, tokens: completion.usage.inputTokens };
        }
      } catch (error) {
        if (!isAgentToolProtocolError(error)) {
          throw error;
        }
        if (error.usage) {
          host.recordUsage(provider, error.usage);
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
          const current = host.store.get(threadId);
          if (current) {
            host.store.save(appendErrorTurn(current, detail));
          }
          host.status = detail;
          stopKind = truncated ? 'truncation' : 'capability';
          return 'policy-stop';
        }
        const providerLabel = provider === 'local' ? 'local model' : 'Meta cloud model';
        if (truncated) {
          extra.push({
            role: 'system',
            content:
              `Your previous reply was cut off at the ${truncated.maxCompletionTokens}-token output limit before it was complete, so the host discarded it and no action ran. ` +
              'Keep your reasoning short and reply with one small tool call. ' +
              'Split a large edit into several smaller apply_patch calls, and keep the final report brief.',
          });
          host.status = `The ${providerLabel} reply was cut off at its ${truncated.maxCompletionTokens}-token limit; asking for a shorter step (${protocolRepairs}/2)\u2026`;
          await host.postState();
          continue agentSteps;
        }
        if (unparsed) {
          extra.push({
            role: 'system',
            content:
              'The local server could not parse your previous reply as a tool call, so it was not executed and nothing changed. ' +
              'Reply with one smaller, well-formed tool call. To change part of an existing file, use replace_in_file with a short exact fragment instead of rewriting the whole file.',
          });
          host.status = `The local server could not parse the ${providerLabel}'s tool call; nothing ran. Asking for a smaller step (${protocolRepairs}/2)\u2026`;
          await host.postState();
          continue agentSteps;
        }
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
        host.status = `Correcting malformed tool call (${protocolRepairs}/2): waiting for the ${providerLabel} (120 s maximum)\u2026`;
        await host.postState();
        continue agentSteps;
      }
      steps += 1;
      if (lastStep && completion.toolCalls && completion.toolCalls.length > 0) {
        lastStepToolCallsRefused = true;
        break agentSteps;
      }
      protocolRepairs = 0;
      if (!completion.toolCalls || completion.toolCalls.length === 0) {
        const reply = (completion.text ?? '').trim().slice(0, 8000);
        if (reply.length === 0 && emptyReplies < 2) {
          emptyReplies += 1;
          extra.push({
            role: 'system',
            content:
              host.missionAuto !== null && workspaceWrites === 0 && testRuns.length === 0
                ? 'Your previous response was empty. Continue the task with one valid tool call that moves it forward: the change, or the allowlisted test. Do not return an empty response.'
                : 'Your previous response was empty. Continue the task with one valid tool call, or return the required concise final report. Do not return an empty response.',
          });
          host.status = `Retrying an empty Agent response (${emptyReplies}/2)\u2026`;
          await host.postState();
          continue agentSteps;
        }
        if (reply.length === 0) {
          const detail = 'The model repeatedly returned an empty response. No success was claimed.';
          const current = host.store.get(threadId);
          if (current) {
            host.store.save(appendErrorTurn(current, detail));
          }
          host.status = detail;
          stopKind = 'capability';
          return 'policy-stop';
        }
        if (host.missionAuto !== null && !actNudged && workspaceWrites === 0 && testRuns.length === 0 && step < MAX_AGENT_STEPS - AGENT_STEPS_WARNING_REMAINING) {
          actNudged = true;
          extra.push({ role: 'assistant', content: reply.slice(0, 2000) });
          extra.push({
            role: 'system',
            content:
              `Your reply would end this internal run, but no file changed and no test ran, so the host would record no progress. ${MAX_AGENT_STEPS - step - 1} model steps remain. ` +
              'Do not explore again: make the smallest change that meets the task now (read only the file you change if you need its exact text and sha256), run the allowlisted test, then report. ' +
              'If something really blocks the change, say what it is in one sentence.',
          });
          host.status = 'The Agent stopped without a change or a test; asking it to act with the steps left\u2026';
          await host.postState();
          continue agentSteps;
        }
        const lastTestNow = testRuns.length > 0 ? testRuns[testRuns.length - 1] : undefined;
        const untestedChange = workspaceWrites > 0 && (lastTestNow === undefined || workspaceWrites > lastTestNow.writes);
        if (host.missionAuto !== null && !actNudged && untestedChange && step < MAX_AGENT_STEPS - AGENT_STEPS_WARNING_REMAINING) {
          actNudged = true;
          extra.push({ role: 'assistant', content: reply.slice(0, 2000) });
          extra.push({
            role: 'system',
            content:
              `Your reply would end this internal run, but no allowlisted test ran after your last change, so the host cannot accept the task. ${MAX_AGENT_STEPS - step - 1} model steps remain. ` +
              'Run the allowlisted test now; if it fails, fix the change and run it again; then report.',
          });
          host.status = 'The Agent changed files without running the test; asking it to run the test now\u2026';
          await host.postState();
          continue agentSteps;
        }
        const current = host.store.get(threadId);
        if (current) {
          const prefix = `Agent (${profile}, ${provider}): `;
          const prose = sanitizeAgentReply(reply).text;
          host.lastAgentOutcome = { threadId, outcome: 'done', hostRecord: [...hostRecord], report: prose.slice(0, 1200) };
          const record = hostRecord.length > 0 ? hostRecord : [NO_HOST_ACTIONS_LINE];
          host.store.save(
            appendAssistantTurn(current, `${prefix}${fitTurnText(prose, MAX_ASSISTANT_TEXT_LENGTH - prefix.length)}`, undefined, record),
          );
        }
        // pushAgentLog is a no-op in the original; kept inline.
        void profile;
        void provider;
        void threadId;
        return 'done';
      }
      for (const call of completion.toolCalls) {
        if (signal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const testContext = await host.testCommandContext(workspaceId);
        const gate = policyGateForCall(call, testContext.allowlist);
        if (!gate.ok) {
          recordBlockedProposal(host, call, provider, threadId, workspaceId, gate.error);
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
          host.status = `Correcting a blocked ${call.tool} proposal\u2026`;
          await host.postState();
          continue agentSteps;
        }
        let described = describeAgentCall(call);
        if (call.tool === 'run_tests') {
          const bound = describeBoundTestCall(host, call, testContext);
          if (!bound.ok) {
            failAgentWithAudit(host, call, provider, threadId, workspaceId, 'policy', bound.error, 'Policy blocked the action.');
            return 'policy-stop';
          }
          described = { targets: bound.described.targets, body: bound.described.body, preconditions: bound.described.preconditions };
        } else if (call.tool === 'apply_patch') {
          described = {
            ...described,
            preconditions: await bindPatchApprovalPreconditions(host, call, fs, heldCanonicalRoot),
          };
        }
        const frozenHit = WORKSPACE_WRITE_TOOLS.has(call.tool) ? frozenTarget(host, described.targets) : null;
        if (frozenHit !== null) {
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
          host.status = dependencies
            ? 'A change inside node_modules was refused; returning the reason to the Agent\u2026'
            : 'A change to a frozen acceptance file was refused; returning the reason to the Agent\u2026';
          await host.postState();
          continue agentSteps;
        }
        if (call.tool === 'replace_in_file') {
          let check: { ok: true; rel: string; newContent: string } | { ok: false; error: string };
          try {
            check = await checkReplacement(call, fs, heldCanonicalRoot);
          } catch (error) {
            const detail = error instanceof Error ? error.message : 'The path is not allowed.';
            failAgentWithAudit(host, call, provider, threadId, workspaceId, 'policy', detail, `Agent tool failed (${detail}).`);
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
            host.status = 'The replace_in_file proposal was not prepared; returning the reason to the Agent\u2026';
            await host.postState();
            continue agentSteps;
          }
        } else if (call.tool === 'create_directory') {
          const tgt = String((call.args as Record<string, unknown>).path ?? '');
          described = {
            ...described,
            preconditions: { [tgt]: MISSING_FILE_PRECONDITION },
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
        let memoryProposal: MemoryProposal | null = null;
        if (call.tool === 'propose_decision' || call.tool === 'bind_artifact') {
          const prepared =
            call.tool === 'propose_decision'
              ? prepareModelDecision(host, call, memoryScope, threadId, provider)
              : await prepareModelArtifact(host, call, memoryScope, threadId, provider, fs, heldCanonicalRoot, testRuns, workspaceWrites);
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
            host.status = `The ${call.tool} proposal was not prepared; returning the reason to the Agent\u2026`;
            await host.postState();
            continue agentSteps;
          }
          memoryProposal = prepared.value;
          memoryProposals.set(call.id, memoryProposal);
          described = describeMemoryProposal(host, memoryProposal);
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
        const auto =
          isAutoAllowed(profile, call.tool) ||
          missionGrantAllows(host, call.tool, memoryScope.scopeId, provider, model, {
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
            host.agentGeneration,
          );
          if (pending.digest !== digest) {
            failAgentWithAudit(host, call, provider, threadId, workspaceId, 'policy', 'Digest mismatch.', 'Approval binding failed.');
            return 'policy-stop';
          }
          const choice = await waitForAgentDecision(host, pending, signal);
          if (choice.kind === 'cancelled') {
            host.memory.discardProposals({ threadId });
            recordAgentAudit(host, pending, 'rejected', 'cancelled before approval');
            throw new DOMException('Aborted', 'AbortError');
          }
          if (choice.kind === 'stale') {
            if (memoryProposal !== null) {
              host.memory.discardProposals({ proposalId: memoryProposal.proposalId });
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
            host.status = 'A precondition changed; asking the Agent to re-read and re-propose\u2026';
            await host.postState();
            continue agentSteps;
          }
          if (choice.kind !== 'approve') {
            approvedPending = null;
            host.memory.discardProposals({ threadId });
            const current = host.store.get(threadId);
            if (current) {
              host.store.save(appendErrorTurn(current, 'Action rejected by user. No changes were made.'));
            }
            host.status = 'Action rejected by user. No changes were made.';
            host.running = false;
            host.connection = 'cancelled';
            return 'rejected';
          }
          approvedPending = pending;
          if (call.tool === 'run_tests') {
            const reverified = await verifyBoundTestStillApproved(
              host,
              { body: described.body, preconditions: described.preconditions },
              workspaceId,
            );
            if (!reverified.ok) {
              failAgentWithAudit(host, call, provider, threadId, workspaceId, 'policy', reverified.error, 'Test definition changed since approval; re-propose the action.');
              return 'policy-stop';
            }
          }
        } else if (call.tool === 'run_tests') {
          const reverified = await verifyBoundTestStillApproved(
            host,
            { body: described.body, preconditions: described.preconditions },
            workspaceId,
          );
          if (!reverified.ok) {
            failAgentWithAudit(host, call, provider, threadId, workspaceId, 'policy', reverified.error, 'Test definition changed; re-propose the action.');
            return 'policy-stop';
          }
        }
        const journalId = `act-${digest.slice(0, 12)}`;
        if (host.activeMission !== null) {
          const journaled = await host.updateActiveMission((mission) =>
            journalAction(mission, 'started', journalId, `${call.tool} ${described.targets.join(', ')}`.slice(0, 200), Date.now()),
          );
          if (!journaled) {
            const detail = 'The Mission could not record this action before running it, so it did not run.';
            recordHostAction(call, described.targets, `did not run: ${detail}`);
            const current = host.store.get(threadId);
            if (current) {
              host.store.save(appendErrorTurn(current, detail));
            }
            host.status = detail;
            return 'policy-stop';
          }
        }
        let resultText: string;
        try {
          resultText =
            memoryProposal !== null
              ? await commitModelProposal(host, memoryProposal, approvedPending, threadId, provider)
              : await executeAgentTool(host, call, fs, testContext.allowlist, signal, workspaceId, heldCanonicalRoot);
        } catch (error) {
          if (
            (error instanceof Error && error.name === 'AbortError') ||
            (error instanceof DOMException && error.name === 'AbortError')
          ) {
            throw error;
          }
          const detail = error instanceof Error ? error.message : 'Tool failed.';
          if (host.activeMission !== null) {
            await host.updateActiveMission((mission) => journalAction(mission, 'finished', journalId, `did not complete: ${detail}`.slice(0, 200), Date.now()));
          }
          if (isRecoverableAgentToolError(detail)) {
            const regexStopped = detail === REGEX_SEARCH_TIMEOUT_MESSAGE;
            const recorded = `${regexStopped ? 'stopped' : 'did not run'}: ${detail}`;
            recordAgentAudit(
              host,
              approvedPending ?? autoAuditRecord(host, call, described, provider, workspaceId, threadId, digest),
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
            host.status = regexStopped
              ? 'The regex search was stopped by its time budget; returning that to the Agent\u2026'
              : `The workspace state differed; asking the Agent to inspect and retry\u2026`;
            await host.postState();
            continue agentSteps;
          }
          failAgentWithAudit(host, call, provider, threadId, workspaceId, 'policy', detail, `Agent tool failed (${detail}).`);
          return 'policy-stop';
        }
        recordAgentAudit(
          host,
          approvedPending ?? autoAuditRecord(host, call, described, provider, workspaceId, threadId, digest),
          approvedPending ? 'human' : 'profile-auto',
          summarizeToolResult(call.tool, resultText),
        );
        recordHostAction(call, described.targets, summarizeToolResult(call.tool, resultText));
        if (host.activeMission !== null) {
          await host.updateActiveMission((mission) => journalAction(mission, 'finished', journalId, summarizeToolResult(call.tool, resultText), Date.now()));
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
          described.targets.forEach((tgt) => changedFiles.add(tgt));
        }
        extra.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: call.id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } },
          ],
        });
        const bHint = call.tool === 'run_tests' ? bindArtifactHint(host, resultText, memoryScope.scopeId, changedFiles, String((call.args as Record<string, unknown>).commandId ?? '')) : '';
        let toolContent = truncateToolOutput(resultText) + bHint;
        if (host.missionAuto !== null && MISSION_REPEAT_CHECK_TOOLS.has(call.tool)) {
          const key = `${call.tool} ${JSON.stringify(call.args)}`;
          const readDigest = hashContent(resultText);
          const earlier = seenReadResults.get(key);
          if (earlier !== undefined && earlier.digest === readDigest) {
            repeatedReads += 1;
            toolContent =
              call.tool === 'read_file'
                ? `No new information: this is exactly what you read at step ${earlier.step} of this run (same sha256). Do not read it again; act on it now.\n\n${toolContent}`
                : `No new information: identical to your ${call.tool} at step ${earlier.step} of this run, shown above. Do not repeat it; make the change, then run the test.`;
            host.status = `A repeated ${call.tool} returned nothing new; telling the Agent\u2026`;
          } else {
            seenReadResults.set(key, { digest: readDigest, step: step + 1 });
          }
        }
        extra.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
        await host.postState();
      }
    }
    return 'budget-stop';
  });
  if (outcome === 'done' || outcome === 'rejected') {
    host.running = false;
    host.connection = outcome === 'done' ? 'verified' : 'cancelled';
    host.status = outcome === 'done' ? 'Agent reply ready.' : host.status;
  } else if (outcome === 'stale') {
    host.running = false;
    host.connection = 'error';
    host.status = 'The workspace changed; the Agent run stopped.';
    const current = host.store.get(threadId);
    if (current) {
      host.store.save(appendErrorTurn(current, 'The workspace changed; the Agent run stopped.'));
    }
  } else if (outcome === 'budget-stop') {
    host.running = false;
    host.connection = 'error';
    const detail =
      `Agent stopped at its step budget (${MAX_AGENT_STEPS} model steps) without a final report. ` +
      (lastStepToolCallsRefused ? 'Tools were disabled on the last step, but the model still proposed one; it did not run. ' : '') +
      'Check Activity for the actions that ran.';
    host.status = detail;
    const current = host.store.get(threadId);
    if (current) {
      host.store.save(appendErrorTurn(current, detail));
    }
  } else if (outcome === 'policy-stop') {
    host.running = false;
    host.connection = 'error';
  }
  host.memory.discardProposals({ threadId });
  if (outcome !== 'done') {
    host.lastAgentOutcome = { threadId, outcome, hostRecord: [...hostRecord], report: '' };
  }
  const lastTestRun = testRuns.length > 0 ? testRuns[testRuns.length - 1] : undefined;
  const lastTest = lastTestRun ? { commandId: lastTestRun.commandId, exitCode: lastTestRun.exitCode } : null;
  host.agentStepNow = null;
  if (host.lastAgentOutcome !== null && host.lastAgentOutcome.threadId === threadId) {
    const writes: Array<{ path: string; hash: string | null }> = [];
    for (const file of [...changedFiles].slice(0, 50)) {
      writes.push({ path: file, hash: await currentFileHash(fs, file) });
    }
    host.lastAgentOutcome = {
      ...host.lastAgentOutcome,
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
    capabilityReason = host.status.slice(0, 300);
  } else if (outcome === 'done' && lastTest !== null && lastTest.exitCode !== 0) {
    capabilityReason = `the run ended with ${lastTest.commandId} still failing (exit ${lastTest.exitCode ?? 'unknown'})`;
  }
  if (host.lastAgentOutcome !== null && host.lastAgentOutcome.threadId === threadId) {
    host.lastAgentOutcome = { ...host.lastAgentOutcome, capabilityReason };
  }
  if (provider === 'local' && capabilityReason !== null && host.cascadeVerification === null && host.activeMission === null) {
    offerConsult(host, { threadId, root: target.root, task: text, reason: capabilityReason, hostRecord: [...hostRecord], scopeId: memoryScope.scopeId });
  }
  void steps;
  void buildAgentSystemPrompt;
}
