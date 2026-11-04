/**
 * Extracted agent-controller functions.
 *
 * Every function receives `host: ProviderHost` as its first parameter.
 * No vscode imports — the host interface abstracts everything needed.
 */

import * as path from 'node:path';

import {
  computeActionDigest,
  MISSING_FILE_PRECONDITION,
  verifyApproval,
  type PendingAgentAction,
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
  type AgentFs,
} from './agentHost.js';
import { applyPatchAtomically, hashContent } from './agentPatch.js';
import { checkAgentRelPath } from './agentPolicy.js';
import {
  describeAgentProfile,
  isAgentProfileId,
  parseAgentProfile,
  type AgentProfileId,
} from './agentProfiles.js';
import {
  parseDecisionValueText,
  type DecisionValueType,
  type ReplaceInFileArgs,
  type ValidatedToolCall,
} from './agentTools.js';
import {
  describeProposal,
  scopeIdForRoot,
  type MemoryAuthorization,
  type MemoryProposal,
} from './decisionStore.js';
import { checkUserStatement } from './decisionSource.js';
import { setWaiting } from './missionStore.js';
import {
  memoryPreconditionKey,
  memoryPreconditionValue,
  parseMemoryPreconditionKey,
} from './projectMemory.js';
import type { ProviderHost, AgentDecision } from './providerTypes.js';
import { RAME_AUDIT_KEY, type ProviderId } from './settingsStore.js';
import { appendErrorTurn, userWrittenTexts } from './threadStore.js';
import {
  REPLACE_NOT_FOUND_MESSAGE,
  REPLACE_NOT_UNIQUE_MESSAGE,
} from './toolResultSummary.js';
import { validateChosenWorkspace } from './workspaceSelect.js';

// ---- Local constants ----

/** Thread id recorded for changes the user makes in Settings. */
const SETTINGS_MEMORY_THREAD = 'settings';
/** Tools whose success changes workspace files (voids earlier test evidence). */
const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'apply_patch', 'replace_in_file', 'create_directory', 'move_file', 'delete_file', 'set_executable',
]);
const APPROVAL_PREVIEW_CHARS = 2000;
// ---------------------------------------------------------------------------
// 1. Free functions (no `this`)
// ---------------------------------------------------------------------------

/** Plain reason when a decision moved on since its approval card was shown. */
export function memoryDrift(pending: PendingAgentAction, currentHashes: Record<string, string>): string | null {
  for (const [key, expected] of Object.entries(pending.preconditions)) {
    const parsed = parseMemoryPreconditionKey(key);
    if (parsed !== null && currentHashes[key] !== expected) {
      return `${parsed.key} changed since this proposal was shown, so nothing was written; propose it again from the current version.`;
    }
  }
  return null;
}

/** The more restrictive of the chosen profile and a temporary cap. */
export function capProfile(profile: AgentProfileId, cap: AgentProfileId | null): AgentProfileId {
  if (cap === null) {
    return profile;
  }
  const order: AgentProfileId[] = ['ask', 'safe-auto', 'workspace-full'];
  return order.indexOf(cap) < order.indexOf(profile) ? cap : profile;
}

export { historyText } from './agentHistoryText.js';

// ---------------------------------------------------------------------------
// 2. Agent approval
// ---------------------------------------------------------------------------

/** Select the Agent permission profile; persists only the profile id. */
export async function setAgentProfile(host: ProviderHost, rawProfile: string): Promise<void> {
  const next = parseAgentProfile(rawProfile);
  if (!isAgentProfileId(rawProfile) && rawProfile !== next) {
    host.status = 'Unknown permission profile. Kept Ask (safest).';
  } else {
    host.status =
      next === 'workspace-full'
        ? 'Workspace-full selected (high risk). Policy-checked patches and allowlisted tests can run without prompts. Tests run with your OS permissions and may access files, network, or shells. Select Ask to return instantly.'
        : `Permission profile: ${describeAgentProfile(next)}.`;
  }
  if (next !== host.settings.agentProfile) {
    invalidatePendingApproval(host, 'the permission profile changed');
  }
  host.settings = { ...host.settings, agentProfile: next };
  host.persistSettings();
  await host.postState();
}

/**
 * A pending approval is bound to the exact action, project and thread (its
 * digest) and to the context it was shown in: if the permission profile,
 * the runtime, the model or the model server changes while it waits, it is
 * void and the action does not run.
 */
export function invalidatePendingApproval(host: ProviderHost, reason: string): void {
  const waiter = host.agentWaiter;
  if (host.agentPending === null || waiter === null) {
    return;
  }
  host.agentGeneration += 1;
  host.agentPending = null;
  host.agentWaiter = null;
  waiter.resolve({ kind: 'stale', reason });
}

/** Terminal approval is always complete; large patches keep an explicit bounded preview. */
export function approvalBodyPreview(pending: PendingAgentAction): string {
  if (pending.tool === 'run_command' || pending.body.length <= APPROVAL_PREVIEW_CHARS) return pending.body;
  return `${pending.body.slice(0, APPROVAL_PREVIEW_CHARS)}\n…[${pending.body.length - APPROVAL_PREVIEW_CHARS} more characters not shown. Reject if you need to see the whole action first.]`;
}

/** Approve one pending Agent action (one approval authorizes one action). */
export async function approveAgentAction(host: ProviderHost, actionId: string, digest: string): Promise<void> {
  const pending = host.agentPending;
  if (!pending || !host.agentWaiter) {
    host.status = 'No Agent action is waiting for approval.';
    await host.postState();
    return;
  }
  if (pending.actionId !== actionId || pending.digest !== digest) {
    // An obsolete or replayed card: ignore it and keep the action that
    // is really pending. It can never authorize anything else.
    host.status = 'That approval is no longer valid.';
    await host.postState();
    return;
  }
  const live = await host.liveApprovalContext(pending);
  const drift = memoryDrift(pending, live.currentHashes);
  const checked = drift !== null ? { ok: false as const, error: drift } : verifyApproval(
    pending,
    { actionId, digest },
    live,
  );
  if (!checked.ok) {
    recordAgentAudit(host, pending, 'rejected', checked.error);
    host.agentPending = null;
    const waiter = host.agentWaiter;
    host.agentWaiter = null;
    waiter.resolve({ kind: 'stale', reason: checked.error });
    host.status = checked.error;
    await host.postState();
    return;
  }
  pending.used = true;
  host.agentPending = null;
  const waiter = host.agentWaiter;
  host.agentWaiter = null;
  recordAgentAudit(host, pending, 'human', 'approved by user');
  waiter.resolve({ kind: 'approve' });
  await host.postState();
}

/** Reject one pending Agent action. */
export async function rejectAgentAction(host: ProviderHost, actionId: string, digest: string): Promise<void> {
  const pending = host.agentPending;
  if (!pending || !host.agentWaiter) {
    host.status = 'No Agent action is waiting for approval.';
    await host.postState();
    return;
  }
  if (pending.actionId !== actionId || pending.digest !== digest) {
    host.status = 'That approval is no longer valid.';
    await host.postState();
    return;
  }
  recordAgentAudit(host, pending, 'rejected', 'rejected by user');
  host.agentPending = null;
  const waiter = host.agentWaiter;
  host.agentWaiter = null;
  waiter.resolve({ kind: 'reject' });
  host.status = 'Agent action rejected.';
  await host.postState();
}

export function recordAgentAudit(
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

export async function liveApprovalContext(host: ProviderHost, pending: PendingAgentAction): Promise<{
  workspaceId: string;
  threadId: string;
  provider: string;
  generation: number;
  currentHashes: Record<string, string>;
}> {
  // The approval binds to the exact workspace held for the run. Prefer
  // the pending bound root when it is still open; fall back to the
  // single-folder root otherwise. Never accept a webview/model path.
  const open = host.listOpenWorkspaceFolders();
  const boundValid = validateChosenWorkspace(pending.workspaceId, open);
  const single = host.heldWorkspaceRoot();
  const heldRoot = boundValid ?? (single.ok ? single.root : null);
  const workspaceId = heldRoot ?? '';
  const currentHashes: Record<string, string> = {};
  if (heldRoot !== null) {
    const fs = host.agentFsFor(heldRoot);
    for (const rawPath of Object.keys(pending.preconditions)) {
      const memoryKey = parseMemoryPreconditionKey(rawPath);
      if (memoryKey !== null) {
        // A decision that moved on since the proposal voids the approval.
        const latest = host.memory.latestVersion(memoryKey.scopeId, memoryKey.key);
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
    // Approval is valid only while the user is still looking at the run's
    // thread. A hidden/replayed card from a thread that was left cannot run.
    threadId: host.activeThreadId === pending.threadId ? (host.runThreadId ?? '') : '',
    provider: host.settings.provider,
    generation: host.agentGeneration,
    currentHashes,
  };
}

export function waitForAgentDecision(host: ProviderHost, pending: PendingAgentAction, signal: AbortSignal): Promise<AgentDecision> {
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

// ---------------------------------------------------------------------------
// 3. Agent helpers
// ---------------------------------------------------------------------------

export function failAgentWithAudit(
  host: ProviderHost,
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
    generation: host.agentGeneration,
    used: true,
  };
  recordAgentAudit(host, pending, decision, auditResult);
  const current = host.store.get(threadId);
  if (current) {
    host.store.save(appendErrorTurn(current, status));
  }
  host.running = false;
  host.connection = 'error';
  host.status = status;
}

/** Audit a rejected proposal without ending the bounded Agent run. */
export function recordBlockedProposal(
  host: ProviderHost,
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
  recordAgentAudit(
    host,
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
      generation: host.agentGeneration,
      used: true,
    },
    'policy',
    reason,
  );
}

export function autoAuditRecord(
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

export function pushAgentLog(
  _host: ProviderHost,
  profile: string,
  provider: string,
  threadId: string,
): void {
  void profile;
  void provider;
  void threadId;
}

export async function checkWorkspaceStillHeld(
  host: ProviderHost,
  expectedRoot: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!host.isBoundRootStillOpen(expectedRoot)) {
    return { ok: false, error: 'The workspace changed.' };
  }
  return { ok: true };
}

export async function checkCanonicalStillHeld(
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

export function describeBoundTestCall(
  _host: ProviderHost,
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

export async function verifyBoundTestStillApproved(
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

/** Bind approval to both content and target existence. */
export async function bindPatchApprovalPreconditions(
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

// ---------------------------------------------------------------------------
// 4. Tool execution
// ---------------------------------------------------------------------------

export async function executeAgentTool(
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
      // Live symlink/canonical guard before the atomic applier runs.
      for (const file of files) {
        const gate = checkAgentRelPath(file.path);
        if (!gate.ok) {
          throw new Error(gate.error);
        }
        await guardFsPath(fs, (gate as { ok: true; rel: string }).rel, canonicalRoot ?? null);
      }
      const patchHost = {
        inspect: (rel: string): { kind: 'file' | 'dir' | 'symlink' | 'missing' | 'other'; bytes: string } => {
          throw new Error(`Async inspect required for ${rel}; use executeAgentTool patch path.`);
        },
        write: (_rel: string, _content: string): void => {
          throw new Error('Async write required.');
        },
      };
      void patchHost;
      void workspaceId;
      return applyPatchViaFs(files, fs, signal, canonicalRoot ?? null);
    }
    case 'replace_in_file': {
      // Checked again right before writing; the atomic applier then
      // re-verifies the hash, writes, and rolls back on any failure.
      const checked = await checkReplacement(call, fs, canonicalRoot ?? null);
      if (!checked.ok) {
        throw new Error(checked.error);
      }
      const args = call.args as unknown as ReplaceInFileArgs;
      const applied = await applyPatchViaFs([{ path: checked.rel, expectedHash: args.expectedHash, newContent: checked.newContent }], fs, signal, canonicalRoot ?? null);
      return `Replaced 1 fragment in ${checked.rel} (${args.oldText.length} -> ${args.newText.length} characters).\n${applied}`;
    }
    case 'read_decisions': {
      const root = canonicalRoot ?? workspaceId;
      return host.memorySnapshotText({ scopeId: scopeIdForRoot(root), label: path.basename(root) }, fs);
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
      return host.runAllowlistedTest(command, signal, workspaceId);
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
export async function checkReplacement(
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

export async function applyPatchViaFs(
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

// ---------------------------------------------------------------------------
// 5. Memory proposal helpers
// ---------------------------------------------------------------------------

export function prepareModelDecision(
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
  // The source must be what the user typed in this thread, checked here.
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

/**
 * After a passing test: tell the model which files it changed and which
 * decisions are in force, so it can ask to bind the files that implement
 * one. The host never infers the link itself.
 */
export function bindArtifactHint(host: ProviderHost, resultText: string, scopeId: string, changedFiles: ReadonlySet<string>, commandId: string): string {
  if (!/^exit=0\b/.test(resultText) || changedFiles.size === 0) {
    return '';
  }
  const decisions = host.memory.listCurrentDecisions(scopeId);
  if (decisions.length === 0) {
    return '';
  }
  const filesStr = [...changedFiles].slice(0, 20).join(', ');
  const versions = decisions.slice(0, 20).map((entry) => `${entry.key} v${entry.version}`).join(', ');
  return (
    `\n\nHost note: ${commandId} passed and no file changed since. Files you changed in this run: ${filesStr}. ` +
    `Authorized decisions: ${versions}. If one of these files implements one of these decisions, call bind_artifact for it now ` +
    `(commandId ${commandId}, the decision's current version). Do not bind a file that does not implement the decision.`
  );
}

/**
 * Prepare an artifact binding from evidence the host itself holds: the
 * file hash it reads now and a passing run_tests of this run with no file
 * change since. The model's claims are not evidence.
 */
export async function prepareModelArtifact(
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

/** Approval card content: the exact change, bound to the store's digest and versions. */
export function describeMemoryProposal(proposal: MemoryProposal): { targets: string[]; body: string; preconditions: Record<string, string> } {
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
export async function commitModelProposal(
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

// ---------------------------------------------------------------------------
// 6. Utility
// ---------------------------------------------------------------------------

/** Hash of one workspace file now (null when missing or unreadable). */
export async function currentFileHash(fs: AgentFs, file: string): Promise<string | null> {
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
