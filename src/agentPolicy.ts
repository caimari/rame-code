/**
 * Workspace policy boundary for Agent mode.
 *
 * Free of the `vscode` API and of `node:fs` so it can be unit tested with
 * plain `node:test`. Real filesystem checks (realpath, symlink, stat) are
 * injected by the host through tiny callbacks; this module owns the rules.
 *
 * Confinement rules:
 * - One held workspace root; no-workspace and multi-root are explicit errors.
 * - No absolute paths, no `..` escape, no NUL, no canonical/realpath escape,
 *   no symlink escape, no non-regular target where inappropriate, no write
 *   outside the held workspace identity.
 * - Protected control/secret paths are blocked even inside the workspace.
 */

export const MAX_AGENT_REL_LENGTH = 512;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_DIR_ENTRIES = 200;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_SEARCH_BYTES = 64 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
export const MAX_TOOL_CALLS_PER_TURN = 4;
export const MAX_AGENT_STEPS = 12;
export const MAX_PATCH_FILES = 10;
export const MAX_PATCH_BYTES = 128 * 1024;
export const MAX_TEST_DURATION_MS = 120_000;
export const MAX_TEST_OUTPUT_BYTES = 64 * 1024;
export const MAX_TRANSCRIPT_ENTRIES = 100;
export const MAX_AUDIT_ENTRIES = 200;
export const MAX_ACTION_LOG_ENTRIES = 50;

export type RelCheck =
  | { ok: true; rel: string }
  | { ok: false; error: string };

/** Host platform; parameters default to the running process. */
export type HostPlatform = NodeJS.Platform;

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * Windows-only segment rules. Win32 path handling silently rewrites some
 * names, which could alias a protected path (`.git.` and `.git ` open
 * `.git`, `GIT~1` is its 8.3 short name, `.env::$DATA` is its data stream)
 * or open a device instead of a file (`NUL`, `con.txt`). Such segments are
 * rejected outright instead of being normalized.
 */
function windowsSegmentError(segment: string): string | null {
  if (segment.includes(':')) {
    return 'The path is invalid on Windows (drive or stream syntax is not allowed).';
  }
  if (/[<>"|?*\x01-\x1f]/.test(segment)) {
    return 'The path is invalid on Windows (reserved character).';
  }
  if (segment.endsWith('.') || segment.endsWith(' ')) {
    return 'The path is invalid on Windows (a name cannot end with a dot or a space).';
  }
  if (WINDOWS_RESERVED_NAME.test(segment)) {
    return 'The path is invalid on Windows (reserved device name).';
  }
  if (/~[0-9]/.test(segment)) {
    return 'Short (8.3) file names are not allowed on Windows; use the full name.';
  }
  return null;
}

/**
 * Normalize an untrusted workspace-relative path. Returns the cleaned
 * `a/b/c` form (`''` means the workspace root). Rejects absolute paths,
 * `..` escapes, NUL bytes, and over-long input with generic errors that do
 * not echo secret material. On Windows, names that Win32 would rewrite
 * (trailing dot/space, 8.3 short names, streams, devices) are rejected.
 */
export function normalizeAgentRelPath(
  requested: unknown,
  platform: HostPlatform = process.platform,
): RelCheck {
  if (typeof requested !== 'string') {
    return { ok: false, error: 'The path is invalid.' };
  }
  if (requested.includes('\0')) {
    return { ok: false, error: 'The path is invalid.' };
  }
  const trimmed = requested.trim();
  if (trimmed.length === 0 || trimmed === '.' || trimmed === './') {
    return { ok: true, rel: '' };
  }
  if (trimmed.length > MAX_AGENT_REL_LENGTH) {
    return { ok: false, error: 'The path is too long.' };
  }
  // Absolute paths (posix, windows drive, UNC, tilde) never enter the workspace.
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('\\\\') ||
    trimmed.startsWith('~')
  ) {
    return { ok: false, error: 'Absolute paths are not allowed.' };
  }
  const rawSegments = trimmed.replace(/\\/g, '/').split('/');
  const kept: string[] = [];
  for (const segment of rawSegments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (platform === 'win32' && segment !== '..') {
      const windowsError = windowsSegmentError(segment);
      if (windowsError !== null) {
        return { ok: false, error: windowsError };
      }
    }
    if (segment === '..') {
      if (kept.length === 0) {
        return { ok: false, error: 'The path escapes the active workspace.' };
      }
      kept.pop();
      continue;
    }
    if (segment.length > 255) {
      return { ok: false, error: 'The path is invalid.' };
    }
    kept.push(segment);
  }
  if (kept.length === 0) {
    return { ok: true, rel: '' };
  }
  const rel = kept.join('/');
  if (rel.length > MAX_AGENT_REL_LENGTH) {
    return { ok: false, error: 'The path is too long.' };
  }
  return { ok: true, rel };
}

const CONTROL_BASENAMES = new Set([
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.netrc',
  '_netrc',
  'credentials.json',
  'auth.json',
  // Package-manager and database client files that commonly hold tokens.
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.pgpass',
]);

/** Directories that hold user-level keys or cloud credentials. */
const SECRET_DIR_SEGMENTS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker']);

/** SSH private-key basenames (`id_rsa`, `id_ed25519`, ... but not `.pub`). */
function isSshPrivateKeyName(base: string): boolean {
  return /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/.test(base);
}

/**
 * True when a normalized relative path targets protected secret/control
 * material. Centralized so every tool shares the same boundary.
 */
export function isProtectedRelPath(rel: string): boolean {
  const lower = rel.toLowerCase();
  const segments = lower.split('/').filter((part) => part.length > 0);
  for (const segment of segments) {
    if (
      segment === '.git' ||
      segment === '.hg' ||
      segment === '.svn' ||
      segment === '.vscode' ||
      segment === '.github'
    ) {
      return true;
    }
    if (segment.startsWith('.env')) {
      return true;
    }
    if (SECRET_DIR_SEGMENTS.has(segment)) {
      return true;
    }
  }
  const base = segments.length > 0 ? segments[segments.length - 1] as string : '';
  if (CONTROL_BASENAMES.has(base) || isSshPrivateKeyName(base)) {
    return true;
  }
  if (
    base.endsWith('.pem') ||
    base.endsWith('.key') ||
    base.endsWith('.p12') ||
    base.endsWith('.pfx') ||
    base.endsWith('.jks') ||
    base.endsWith('.keystore')
  ) {
    return true;
  }
  if (
    base.includes('credential') ||
    base.includes('secret') ||
    base.includes('private-key') ||
    base.includes('private_key') ||
    base.includes('api-key') ||
    base.includes('api_key')
  ) {
    return true;
  }
  if (rel === '' ) {
    return false;
  }
  return false;
}

export type WorkspaceRootCheck =
  | { ok: true; root: string }
  | { ok: false; error: string };

/**
 * Resolve and hold the single active workspace root. Rejects the two
 * ambiguous states with distinct messages so the UI can explain them.
 */
export function resolveSingleWorkspaceRoot(
  roots: readonly string[] | undefined | null,
  platform: HostPlatform = process.platform,
): WorkspaceRootCheck {
  if (!roots || roots.length === 0) {
    return { ok: false, error: 'No workspace folder is open.' };
  }
  if (roots.length > 1) {
    return {
      ok: false,
      error: 'Several workspace folders are open; open one folder only.',
    };
  }
  const trimmed = (roots[0] as string).trim();
  let root: string;
  if (platform === 'win32') {
    // Keep `C:\` intact: `C:` alone would mean "current dir on drive C".
    root = /^[A-Za-z]:[\\/]+$/.test(trimmed)
      ? `${trimmed.slice(0, 2)}\\`
      : trimmed.replace(/[\\/]+$/, '');
  } else {
    root = trimmed.replace(/\/+$/, '');
  }
  if (root.length === 0) {
    return { ok: false, error: 'No workspace folder is open.' };
  }
  return { ok: true, root };
}

/**
 * Comparable form of a canonical Windows path: forward slashes, no `\\?\`
 * prefix, upper-case drive letter, no trailing separator. Case is otherwise
 * kept, because both sides come from realpath, which returns the on-disk
 * case; folding case would merge distinct folders in case-sensitive
 * directories.
 */
function comparableWindowsPath(value: string): string {
  let out = value.replace(/\\/g, '/');
  if (out.startsWith('//?/UNC/')) {
    out = `//${out.slice('//?/UNC/'.length)}`;
  } else if (out.startsWith('//?/')) {
    out = out.slice('//?/'.length);
  }
  if (/^[a-z]:/.test(out)) {
    out = (out[0] as string).toUpperCase() + out.slice(1);
  }
  return out.replace(/\/+$/, '');
}

/**
 * Canonical containment check for injected realpath results. Both inputs are
 * already-resolved absolute paths. True only when the target is the root
 * itself or lives strictly beneath it. On Windows, `\` and `/` are
 * equivalent separators.
 */
export function isWithinRoot(
  rootReal: string,
  targetReal: string,
  platform: HostPlatform = process.platform,
): boolean {
  const comparable = platform === 'win32'
    ? comparableWindowsPath
    : (value: string): string => value.replace(/\/+$/, '');
  const root = comparable(rootReal);
  const target = comparable(targetReal);
  if (platform === 'win32' && !/^([A-Z]:|\/\/[^/]+\/[^/]+)/.test(root)) {
    // Not a drive or UNC path: fail closed rather than guess.
    return false;
  }
  if (target === root) {
    return true;
  }
  return target.startsWith(root + '/');
}

/**
 * Full relative-path gate used by every tool: normalize, then reject
 * protected paths. Canonical/symlink escape against live realpaths is
 * checked by the host after this pure gate passes.
 */
export function checkAgentRelPath(
  requested: unknown,
  platform: HostPlatform = process.platform,
): RelCheck {
  const normalized = normalizeAgentRelPath(requested, platform);
  if (!normalized.ok) {
    return normalized;
  }
  if (normalized.rel !== '' && isProtectedRelPath(normalized.rel)) {
    return { ok: false, error: 'That path is protected.' };
  }
  return normalized;
}
