/**
 * Which project folder an Agent or Mission thread works in.
 *
 *   - A thread already bound to a folder keeps it while it is open; if it was
 *     closed, the user is asked: RAME never moves a thread to another folder
 *     by itself (not even when only one other folder is open).
 *   - A new local Agent thread with exactly one folder open uses it.
 *   - A new local Agent thread with no folder, or with several, starts
 *     WITHOUT a project: only web_search / web_fetch (when web access is on)
 *     and request_project_folder, which asks the user to choose one. No file,
 *     test, terminal or memory tool, and no project decision in context.
 *   - Mission, and Agent with Meta, always need an explicit project folder.
 *
 * Choosing a folder grants nothing: permissions still come from the profile,
 * and approvals are bound to the folder they were made in.
 */

import * as vscode from 'vscode';

import type { ProviderHost } from './providerTypes.js';
import type { ProviderId } from './settingsStore.js';
import type { ChatThread } from './threadStore.js';
import {
  buildWorkspacePickItems,
  NO_WORKSPACE_MESSAGE,
  validateChosenWorkspace,
  workspaceDisplayLabel,
  WORKSPACE_PICK_CANCELLED,
  type OpenWorkspaceFolder,
} from './workspaceSelect.js';

export type RunRoot = { ok: true; root: string; label: string } | { ok: false; cancelled: boolean; error: string };

/** The marker for an Agent run without a project folder (root ''). */
export const NO_PROJECT_TARGET = { root: '', label: '' } as const;

function found(open: readonly OpenWorkspaceFolder[], path: string): RunRoot {
  const folder = open.find((entry) => entry.path === path) as OpenWorkspaceFolder;
  return { ok: true, root: path, label: workspaceDisplayLabel(folder) ?? path };
}

/** Ask the user to choose one open folder. Cancel is never a choice. */
export async function pickProjectFolder(host: ProviderHost, placeHolder: string): Promise<RunRoot> {
  const open = host.listOpenWorkspaceFolders();
  if (open.length === 0) {
    return { ok: false, cancelled: false, error: NO_WORKSPACE_MESSAGE };
  }
  const items = buildWorkspacePickItems(open).map((item) => ({ label: item.label, description: item.description, detail: item.detail }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder, ignoreFocusOut: true });
  const validated = picked ? validateChosenWorkspace(picked.description, open) : null;
  return validated === null ? { ok: false, cancelled: true, error: WORKSPACE_PICK_CANCELLED } : found(open, validated);
}

/**
 * The folder of a run that needs one (Mission, Agent with Meta, a pinned
 * run). A thread's own folder wins while it is open; a closed one is never
 * replaced by another folder without asking.
 */
export async function resolveRunRoot(host: ProviderHost, preferredRoot?: string | null): Promise<RunRoot> {
  const open = host.listOpenWorkspaceFolders();
  if (open.length === 0) {
    return { ok: false, cancelled: false, error: NO_WORKSPACE_MESSAGE };
  }
  if (host.pinnedRunRoot !== null) {
    const pinned = validateChosenWorkspace(host.pinnedRunRoot, open);
    return pinned !== null ? found(open, pinned) : { ok: false, cancelled: false, error: 'The project folder of this run is no longer open.' };
  }
  if (preferredRoot) {
    const validated = validateChosenWorkspace(preferredRoot, open);
    if (validated !== null) {
      return found(open, validated);
    }
    // The thread's folder was closed: ask, even when a single other folder is open.
    return pickProjectFolder(host, "This thread's project folder is no longer open: choose the folder to continue in");
  }
  if (open.length === 1) {
    return found(open, (open[0] as OpenWorkspaceFolder).path);
  }
  return pickProjectFolder(host, 'Select workspace folder for this Agent run');
}

export type FolderChoice = { kind: 'bound'; root: string; label: string } | { kind: 'no-project' } | { kind: 'failed'; cancelled: boolean; error: string };

/** The folder for a new Agent or Mission message, by the rules above. */
export async function chooseRunFolder(host: ProviderHost, thread: ChatThread | undefined, mode: string, provider: ProviderId): Promise<FolderChoice> {
  const open = host.listOpenWorkspaceFolders();
  const localAgent = mode === 'agent' && provider === 'local' && host.pinnedRunRoot === null;
  if (localAgent && !thread?.workspaceRoot && open.length !== 1) {
    return { kind: 'no-project' };
  }
  const target = await resolveRunRoot(host, thread?.workspaceRoot ?? null);
  return target.ok ? { kind: 'bound', root: target.root, label: target.label } : { kind: 'failed', cancelled: target.cancelled, error: target.error };
}
