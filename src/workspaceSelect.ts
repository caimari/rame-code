/**
 * Pure multi-root workspace selection policy for Agent runs.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * The extension host owns the native QuickPick UI; this module owns the
 * policy:
 * - Zero folders: friendly empty state, never a silent default.
 * - Exactly one folder: use it (no prompt).
 * - Several folders: the user must explicitly choose; cancellation is a
 *   concise cancelled status, never an error transcript, and the first
 *   folder is never chosen silently.
 * - A folder/path supplied by the model or webview is never accepted: only
 *   a path that exactly matches a currently open folder (after
 *   normalization) validates.
 */

export interface OpenWorkspaceFolder {
  name: string;
  path: string;
}

export interface WorkspacePickItem {
  label: string;
  description: string;
  detail: string;
}

function normalizeRootPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed;
}

function folderDisplayName(folder: OpenWorkspaceFolder): string {
  return typeof folder.name === 'string' && folder.name.trim().length > 0
    ? folder.name.trim()
    : folder.path;
}

/**
 * Normalize open folders, dropping entries with empty paths. Name is kept
 * for display; matching always uses the normalized path.
 */
export function normalizeOpenFolders(
  folders: readonly OpenWorkspaceFolder[] | undefined | null,
): OpenWorkspaceFolder[] {
  if (!Array.isArray(folders)) {
    return [];
  }
  const out: OpenWorkspaceFolder[] = [];
  for (const folder of folders) {
    if (
      typeof folder !== 'object' ||
      folder === null ||
      Array.isArray(folder)
    ) {
      continue;
    }
    const path = normalizeRootPath((folder as OpenWorkspaceFolder).path);
    if (path === null) {
      continue;
    }
    const rawName = (folder as OpenWorkspaceFolder).name;
    out.push({
      name:
        typeof rawName === 'string' && rawName.trim().length > 0
          ? rawName.trim().slice(0, 128)
          : path,
      path,
    });
  }
  return out;
}

/** Discriminator the host uses to decide prompt / auto / empty-state. */
export function workspaceCountPolicy(
  folders: readonly OpenWorkspaceFolder[] | undefined | null,
): 'none' | 'single' | 'multi' {
  const open = normalizeOpenFolders(folders);
  if (open.length === 0) {
    return 'none';
  }
  if (open.length === 1) {
    return 'single';
  }
  return 'multi';
}

/**
 * Build QuickPick items showing folder name plus the full filesystem path.
 * Label is the folder name; description and detail both carry the full path
 * so the target stays verifiable in narrow sidebars.
 */
export function buildWorkspacePickItems(
  folders: readonly OpenWorkspaceFolder[],
): WorkspacePickItem[] {
  return normalizeOpenFolders(folders).map((folder) => ({
    label: folderDisplayName(folder),
    description: folder.path,
    detail: folder.path,
  }));
}

/**
 * Validate an explicitly picked workspace path against currently open
 * folders. Returns the canonical normalized root only when it exactly
 * matches one open folder. Anything else (model/webview-supplied paths,
 * empty, unknown) returns null and must be rejected by the caller.
 */
export function validateChosenWorkspace(
  chosenPath: unknown,
  openFolders: readonly OpenWorkspaceFolder[] | undefined | null,
): string | null {
  const normalized = normalizeRootPath(chosenPath);
  if (normalized === null) {
    return null;
  }
  const open = normalizeOpenFolders(openFolders);
  for (const folder of open) {
    if (folder.path === normalized) {
      return folder.path;
    }
  }
  return null;
}

/** Compact display label: `name — path`, or the path alone. */
export function workspaceDisplayLabel(
  folder: OpenWorkspaceFolder | null | undefined,
): string | null {
  if (!folder) {
    return null;
  }
  const path = normalizeRootPath(folder.path);
  if (path === null) {
    return null;
  }
  const name = folderDisplayName({ name: folder.name, path });
  return name === path ? path : `${name} — ${path}`;
}

/** Friendly empty-state when no folder is open (never a hard error). */
export const NO_WORKSPACE_MESSAGE =
  'No workspace folder is open. Open a folder to run Agent.';

/** Concise cancelled status when the user dismisses the folder picker. */
export const WORKSPACE_PICK_CANCELLED =
  'Agent run cancelled — no workspace selected.';
