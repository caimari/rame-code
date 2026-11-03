/**
 * Project Memory controller: extracted from mainProvider.ts to own the
 * Settings-side memory lifecycle (scope resolution, view refresh,
 * proposal, approval, rejection, snapshots, and live artifact hashes).
 *
 * Free of the `vscode` API; every function receives {@link ProviderHost}
 * as its first parameter.
 */

import * as path from 'node:path';

import {
  createPendingAction,
  verifyApproval,
  type PendingAgentAction,
} from './agentApproval.js';
import type { AgentFs } from './agentHost.js';
import { hashContent } from './agentPatch.js';
import { checkAgentRelPath } from './agentPolicy.js';
import {
  parseDecisionValueText,
  type DecisionValueType,
} from './agentTools.js';
import {
  currentFileHash,
  describeMemoryProposal,
  memoryDrift,
} from './agentController.js';
import {
  describeProposal,
  scopeIdForRoot,
  type ArtifactView,
  type CurrentDecision,
  type DecisionVersion,
  type MemoryProposal,
} from './decisionStore.js';
import {
  ACCEPTANCE_ENVIRONMENT_FILES,
  listAcceptanceCandidates,
} from './projectAdapters/npmProjectAdapter.js';
import {
  buildMemorySnapshot,
} from './projectMemory.js';
import {
  validateChosenWorkspace,
} from './workspaceSelect.js';
import type { ProviderHost } from './providerTypes.js';
import type { MissionView } from './viewMessages.js';

// ---- Constants ----

const SETTINGS_MEMORY_THREAD = 'settings';

// ---- Extracted functions ----

/**
 * The project Settings memory acts on: the open folder chosen in Settings
 * or used by the latest Agent run, else the single open folder. Never a
 * model path; a folder chosen in the view is accepted only when it is
 * exactly one of the open workspace folders.
 */
export async function memoryScopeForUi(
  host: ProviderHost,
): Promise<{ ok: true; root: string; scopeId: string; label: string; fs: AgentFs } | { ok: false; error: string }> {
  let root: string | null = null;
  if (host.memoryRoot !== null && host.isBoundRootStillOpen(host.memoryRoot)) {
    root = host.memoryRoot;
  } else if (host.agentRunWorkspace !== null && host.isBoundRootStillOpen(host.agentRunWorkspace.root)) {
    root = host.agentRunWorkspace.root;
  } else {
    const single = host.heldWorkspaceRoot();
    root = single.ok ? single.root : null;
  }
  if (root === null) {
    return {
      ok: false,
      error: host.listOpenWorkspaceFolders().length > 1
        ? 'Several folders are open. Choose the project above to manage its memory.'
        : 'Open a folder to manage its project memory.',
    };
  }
  const fs = host.agentFsFor(root);
  try {
    const canonical = await host.heldCanonicalRoot(root, fs);
    return { ok: true, root, scopeId: scopeIdForRoot(canonical), label: path.basename(root), fs };
  } catch {
    return { ok: false, error: 'The project folder could not be resolved.' };
  }
}

/**
 * Recompute what Settings shows about memory (decisions, history, files, pending).
 *
 * The caller provides a `missionView` callback so the memory controller
 * does not depend on Mission internals.
 */
export async function refreshMemoryView(
  host: ProviderHost,
  missionView: (scopeId: string, current: Array<{ key: string; version: number }>) => MissionView | null,
): Promise<void> {
  const scope = await memoryScopeForUi(host);
  const folders = host.listOpenWorkspaceFolders().map((folder) => ({ name: folder.name, path: folder.path }));
  if (!scope.ok) {
    host.memoryView = { project: null, readable: true, decisions: [], history: [], artifacts: [], corruptKeys: [], pending: null, note: scope.error, mission: null, folders, selectedPath: null };
    return;
  }
  await host.missionRecovery;
  const testContext = await host.testCommandContext(scope.root);
  host.missionTestCommands = testContext.allowlist.map((entry) => entry.id);
  const environmentFiles: string[] = [];
  for (const file of ACCEPTANCE_ENVIRONMENT_FILES) {
    if ((await currentFileHash(scope.fs, file)) !== null) {
      environmentFiles.push(file);
    }
  }
  host.missionSetup = {
    scopeId: scope.scopeId,
    testCommands: host.missionTestCommands,
    candidates: await listAcceptanceCandidates(scope.fs),
    environmentFiles,
    packageJsonHash: testContext.packageJsonRaw.length > 0 ? hashContent(testContext.packageJsonRaw) : '',
  };
  const readout = host.memory.readScope(scope.scopeId);
  const artifacts = host.memory.artifactStatuses(scope.scopeId, await liveArtifactHashes(host, scope.scopeId, scope.fs));
  const pending = host.memoryPending !== null && host.memoryPending.proposal.scopeId === scope.scopeId ? host.memoryPending : null;
  host.memoryView = {
    project: scope.label,
    readable: readout.readable,
    decisions: readout.current.map((entry: CurrentDecision) => ({
      key: entry.key,
      value: JSON.stringify(entry.value),
      version: entry.version,
      source: entry.provenance.source,
      provider: entry.provenance.provider,
      createdAt: entry.createdAt,
    })),
    history: readout.current.map((entry: CurrentDecision) => ({
      key: entry.key,
      versions: host.memory.getDecisionHistory(scope.scopeId, entry.key).map((version: DecisionVersion) => ({
        version: version.version,
        value: version.op === 'delete' ? '(removed)' : JSON.stringify(version.value),
        createdAt: version.createdAt,
        source: version.provenance.source,
        provider: version.provenance.provider,
        reason: version.provenance.reason,
      })),
    })),
    artifacts: artifacts.map((entry: ArtifactView) => ({
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
    mission: missionView(scope.scopeId, readout.current),
    folders,
    selectedPath: scope.root,
  };
}

/**
 * Settings: the user chooses which open folder's memory to show. Only an
 * exact open workspace folder is accepted; a pending card must be
 * answered first so it can never be approved against another project.
 */
export async function selectMemoryProject(
  host: ProviderHost,
  rawPath: string,
  missionView: (scopeId: string, current: Array<{ key: string; version: number }>) => MissionView | null,
): Promise<void> {
  const chosen = validateChosenWorkspace(rawPath, host.listOpenWorkspaceFolders());
  if (chosen === null) {
    host.status = 'That folder is not open in this window.';
  } else if (host.memoryPending !== null) {
    host.status = 'Approve or reject the pending memory change first.';
  } else if (host.activeMission !== null) {
    host.status = 'A Mission task is running. Wait for it to finish before changing the project.';
  } else {
    host.memoryRoot = chosen;
    host.status = `Project memory: ${path.basename(chosen)}.`;
  }
  await refreshMemoryView(host, missionView);
  await host.postState();
}

/**
 * Settings: the user proposes a value. Nothing is written yet; an exact
 * approval card is shown and only its approval commits the change.
 */
export async function proposeUserDecision(
  host: ProviderHost,
  key: string,
  valueType: DecisionValueType,
  valueText: string,
  missionView: (scopeId: string, current: Array<{ key: string; version: number }>) => MissionView | null,
): Promise<void> {
  if (host.memoryPending !== null) {
    host.status = 'Approve or reject the pending memory change first.';
    await host.postState();
    return;
  }
  const scope = await memoryScopeForUi(host);
  if (!scope.ok) {
    host.status = scope.error;
    await host.postState();
    return;
  }
  const value = parseDecisionValueText(valueType, valueText);
  if (value === null) {
    host.status = `The value is not a valid ${valueType}.`;
    await host.postState();
    return;
  }
  const latest = host.memory.latestVersion(scope.scopeId, key);
  const prepared = host.memory.preparePut({
    scopeId: scope.scopeId,
    scopeLabel: scope.label,
    key,
    value,
    expectedVersion: latest ?? 0,
    provenance: { source: 'user', provider: 'none', threadId: SETTINGS_MEMORY_THREAD, reason: 'Entered in Settings.' },
  });
  if (!prepared.ok) {
    host.status = `Not proposed: ${prepared.error}`;
    await refreshMemoryView(host, missionView);
    await host.postState();
    return;
  }
  const described = describeMemoryProposal(prepared.value);
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
    host.memoryGeneration,
  );
  host.memoryPending = { action, proposal: prepared.value };
  host.status = 'Review the exact memory change below, then approve or reject it.';
  await refreshMemoryView(host, missionView);
  await host.postState();
}

/** Approve the exact Settings card: one use, same project, same version. */
export async function approveMemoryChange(
  host: ProviderHost,
  actionId: string,
  digest: string,
  missionView: (scopeId: string, current: Array<{ key: string; version: number }>) => MissionView | null,
): Promise<void> {
  const pending = host.memoryPending;
  if (pending === null || pending.action.actionId !== actionId || pending.action.digest !== digest) {
    host.status = 'That memory approval is no longer valid.';
    await host.postState();
    return;
  }
  const scope = await memoryScopeForUi(host);
  const live = await host.liveApprovalContext(pending.action);
  const drift = memoryDrift(pending.action, live.currentHashes);
  const checked = drift !== null ? { ok: false as const, error: drift } : verifyApproval(pending.action, { actionId, digest }, {
    ...live,
    workspaceId: scope.ok ? scope.root : '',
    threadId: SETTINGS_MEMORY_THREAD,
    provider: 'none',
    generation: host.memoryGeneration,
  });
  host.memoryPending = null;
  if (!checked.ok) {
    host.memory.discardProposals({ proposalId: pending.proposal.proposalId });
    host.status = `Not written: ${checked.error}`;
    await refreshMemoryView(host, missionView);
    await host.postState();
    return;
  }
  pending.action.used = true;
  const result = await host.memory.commitAuthorizedChange({
    proposalId: pending.proposal.proposalId,
    proposalDigest: pending.proposal.digest,
    scopeId: pending.proposal.scopeId,
    threadId: SETTINGS_MEMORY_THREAD,
    provider: 'none',
    approvedBy: 'user',
    approvalDigest: pending.action.digest,
    approvedAt: Date.now(),
  });
  host.status = result.ok
    ? 'version' in result.value
      ? `Saved ${result.value.key} v${result.value.version} = ${JSON.stringify(result.value.value)}.`
      : 'Artifact recorded.'
    : `Not written: ${result.error}`;
  await refreshMemoryView(host, missionView);
  await host.postState();
}

export async function rejectMemoryChange(
  host: ProviderHost,
  actionId: string,
  digest: string,
  missionView: (scopeId: string, current: Array<{ key: string; version: number }>) => MissionView | null,
): Promise<void> {
  const pending = host.memoryPending;
  if (pending === null || pending.action.actionId !== actionId || pending.action.digest !== digest) {
    host.status = 'That memory approval is no longer valid.';
    await host.postState();
    return;
  }
  host.memoryPending = null;
  host.memory.discardProposals({ proposalId: pending.proposal.proposalId });
  host.status = 'Memory change rejected. Nothing was written.';
  await refreshMemoryView(host, missionView);
  await host.postState();
}

/** Bounded labeled snapshot of one project's memory, with live file status. */
export async function memorySnapshotText(
  host: ProviderHost,
  scope: { scopeId: string; label: string },
  fs: AgentFs,
): Promise<string> {
  const readout = host.memory.readScope(scope.scopeId);
  const artifacts = host.memory.artifactStatuses(scope.scopeId, await liveArtifactHashes(host, scope.scopeId, fs));
  return buildMemorySnapshot(scope.label, readout, artifacts, host.memory.listPendingProposals(scope.scopeId));
}

/** Hash every bound file now (null = missing); unreadable paths are left out. */
export async function liveArtifactHashes(
  host: ProviderHost,
  scopeId: string,
  fs: AgentFs,
): Promise<Record<string, string | null>> {
  const hashes: Record<string, string | null> = {};
  for (const binding of host.memory.listArtifacts(scopeId)) {
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
