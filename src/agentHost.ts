/**
 * Host execution for Agent tools with policy enforcement.
 *
 * Free of the `vscode` API: the extension host adapts
 * `vscode.workspace.fs` and `node:child_process.spawn` to the small
 * injected interfaces here, while `node:test` uses in-memory doubles.
 * Direct APIs/spawn only; nothing is ever interpolated into a shell.
 */

import * as vm from 'node:vm';

import {
  checkAgentRelPath,
  type HostPlatform,
  isWithinRoot,
  MAX_DIR_ENTRIES,
  MAX_FILE_BYTES,
  MAX_SEARCH_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_TOOL_OUTPUT_BYTES,
} from './agentPolicy.js';
import type { AllowedTestCommand } from './agentCommands.js';
import { findAllowedCommand } from './agentCommands.js';
import { hashContent } from './agentPatch.js';
import type { ValidatedToolCall } from './agentTools.js';
import { truncateToolOutput } from './agentTools.js';

const MAX_REGEX_LINE_CHARS = 2000;
/** Total regex time one search_text call may spend on the extension host. */
export const REGEX_SEARCH_BUDGET_MS = 1000;
export const REGEX_SEARCH_TIMEOUT_MESSAGE =
  'The regex search was stopped after 1 s (the pattern backtracks too much). No results were returned; use a simpler pattern or isRegex false.';

const MATCH_SCRIPT = new vm.Script(
  'out = []; for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) { out.push(i); } }',
);

/**
 * Regex matching runs synchronously on the extension host, where a
 * pathological pattern such as `(a+)+$` would freeze every extension,
 * Cancel included. Patterns are not guessed at by shape (that rejected
 * ordinary searches); each call instead runs in a `vm` context whose
 * timeout V8 enforces inside the regex engine. The budget is shared by the
 * whole search but counts only time spent matching: reading and listing
 * files between calls does not consume it. Only data enters the context:
 * the pattern is compiled with `RegExp`, never evaluated as code.
 */
export function createBudgetedRegexSearch(
  pattern: string,
  budgetMs: number,
  now: () => number = () => performance.now(),
): (lines: string[]) => number[] {
  const context = vm.createContext({ re: new RegExp(pattern), lines: [] as string[], out: [] as number[] });
  let spentMs = 0;
  return (lines) => {
    // vm timeouts are whole milliseconds; below 1 ms the budget is spent.
    const remaining = Math.floor(budgetMs - spentMs);
    if (remaining < 1) {
      throw new Error(REGEX_SEARCH_TIMEOUT_MESSAGE);
    }
    context.lines = lines;
    const started = now();
    try {
      MATCH_SCRIPT.runInContext(context, { timeout: remaining });
    } catch (error) {
      if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        spentMs = budgetMs;
        throw new Error(REGEX_SEARCH_TIMEOUT_MESSAGE);
      }
      throw error;
    } finally {
      spentMs += now() - started;
    }
    return Array.from(context.out as number[]);
  };
}
export interface AgentFsEntry {
  name: string;
  isFile: boolean;
  isDir: boolean;
  isSymlink: boolean;
}

export interface AgentFs {
  listEntries(rel: string): Promise<AgentFsEntry[]>;
  readText(rel: string): Promise<string>;
  stat(rel: string): Promise<{
    kind: 'file' | 'dir' | 'symlink' | 'missing' | 'other';
    size?: number;
    ownerExecutable?: boolean;
  }>;
  writeText(rel: string, content: string): Promise<void>;
  createDirectory?(rel: string): Promise<void>;
  moveFile?(source: string, destination: string): Promise<void>;
  deleteFile?(rel: string): Promise<void>;
  setOwnerExecutable?(rel: string, executable: boolean): Promise<void>;
  filesystemUsage?(): Promise<{
    totalBytes: string;
    usedBytes: string;
    freeBytes: string;
    availableBytes: string;
  }>;
  /**
   * Bounded rollback-only delete for files created by the exact pending
   * patch. Must never be used outside patch rollback.
   */
  removeFile?(rel: string): Promise<void>;
  /** Canonical absolute path of an existing `rel`; throws when missing. */
  realpath?(rel: string): Promise<string>;
  /** Canonical absolute path of the held workspace root. */
  realpathRoot?(): Promise<string>;
}

export interface CanonicalScope {
  /** Canonical absolute root held for the run. */
  rootReal: string;
}

export interface AgentSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface AgentSpawner {
  (spec: {
    executable: string;
    argv: string[];
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
  }): Promise<AgentSpawnResult>;
}

/** Pure digest descriptor shared by the loop and the approval UI. */
export function describeAgentCall(call: ValidatedToolCall): {
  targets: string[];
  body: string;
  preconditions: Record<string, string>;
} {
  const body = JSON.stringify(call.args);
  switch (call.tool) {
    case 'list_files': {
      const dir = typeof (call.args as Record<string, unknown>).dir === 'string'
        ? ((call.args as Record<string, unknown>).dir as string)
        : '.';
      return { targets: [dir], body, preconditions: {} };
    }
    case 'inspect_workspace': {
      const dir = typeof (call.args as Record<string, unknown>).dir === 'string'
        ? ((call.args as Record<string, unknown>).dir as string)
        : '.';
      return { targets: [dir], body, preconditions: {} };
    }
    case 'filesystem_usage':
      return { targets: ['selected workspace filesystem'], body, preconditions: {} };
    case 'search_text': {
      const dir = typeof (call.args as Record<string, unknown>).dir === 'string'
        ? ((call.args as Record<string, unknown>).dir as string)
        : '.';
      const query = String((call.args as Record<string, unknown>).query ?? '');
      return { targets: [`${dir}:${query.slice(0, 80)}`], body, preconditions: {} };
    }
    case 'read_file': {
      const path = String((call.args as Record<string, unknown>).path ?? '');
      return { targets: [path], body, preconditions: {} };
    }
    case 'create_directory': {
      const target = String((call.args as Record<string, unknown>).path ?? '');
      return { targets: [target], body, preconditions: {} };
    }
    case 'move_file': {
      const args = call.args as Record<string, unknown>;
      return {
        targets: [String(args.source ?? ''), String(args.destination ?? '')],
        body,
        preconditions: { [String(args.source ?? '')]: String(args.expectedHash ?? '') },
      };
    }
    case 'delete_file': {
      const args = call.args as Record<string, unknown>;
      return {
        targets: [String(args.path ?? '')],
        body,
        preconditions: { [String(args.path ?? '')]: String(args.expectedHash ?? '') },
      };
    }
    case 'set_executable': {
      const args = call.args as Record<string, unknown>;
      return {
        targets: [String(args.path ?? '')],
        body,
        preconditions: { [String(args.path ?? '')]: String(args.expectedHash ?? '') },
      };
    }
    case 'apply_patch': {
      const files = ((call.args as Record<string, unknown>).files as Array<{
        path: string;
        expectedHash: string;
      }>) ?? [];
      const targets = files.map((file) => String(file.path));
      const preconditions: Record<string, string> = {};
      for (const file of files) {
        preconditions[String(file.path)] = String(file.expectedHash);
      }
      return { targets, body, preconditions };
    }
    case 'run_tests': {
      const id = String((call.args as Record<string, unknown>).commandId ?? '');
      return { targets: [id], body, preconditions: {} };
    }
    default:
      return { targets: [call.id], body, preconditions: {} };
  }
}

export const WINDOWS_SET_EXECUTABLE_ERROR = 'set_executable is not supported on Windows.';

/** Pure policy gate: path shape + protected paths (live symlink checks later). */
export function policyGateForCall(
  call: ValidatedToolCall,
  allowlist?: readonly AllowedTestCommand[],
  platform: HostPlatform = process.platform,
): { ok: true } | { ok: false; error: string } {
  if (call.tool === 'set_executable' && platform === 'win32') {
    // Windows has no owner-executable bit; refuse before asking for approval.
    return { ok: false, error: WINDOWS_SET_EXECUTABLE_ERROR };
  }
  const paths: string[] = [];
  if (call.tool === 'list_files' || call.tool === 'inspect_workspace') {
    paths.push(String((call.args as Record<string, unknown>).dir ?? '.'));
  } else if (call.tool === 'search_text') {
    paths.push(String((call.args as Record<string, unknown>).dir ?? '.'));
  } else if (call.tool === 'read_file') {
    paths.push(String((call.args as Record<string, unknown>).path ?? ''));
  } else if (call.tool === 'create_directory' || call.tool === 'delete_file' || call.tool === 'set_executable') {
    paths.push(String((call.args as Record<string, unknown>).path ?? ''));
  } else if (call.tool === 'move_file') {
    paths.push(String((call.args as Record<string, unknown>).source ?? ''));
    paths.push(String((call.args as Record<string, unknown>).destination ?? ''));
  } else if (call.tool === 'apply_patch') {
    const files = ((call.args as Record<string, unknown>).files as Array<{ path: string }>) ?? [];
    for (const file of files) {
      paths.push(String(file.path));
    }
  } else if (call.tool === 'run_tests') {
    const id = String((call.args as Record<string, unknown>).commandId ?? '');
    if (id.length === 0 || /[;&|`$><\n\0]/.test(id)) {
      return { ok: false, error: 'That test command is not allowlisted.' };
    }
    if (!allowlist || findAllowedCommand(allowlist, id) === null) {
      return { ok: false, error: 'That test command is not allowlisted.' };
    }
    return { ok: true };
  }
  for (const candidate of paths) {
    // Allow the workspace root itself for listing/searching.
    if (candidate === '' || candidate === '.' || candidate === './') {
      continue;
    }
    const gate = checkAgentRelPath(candidate, platform);
    if (!gate.ok) {
      return gate;
    }
  }
  if (
    (call.tool === 'create_directory' || call.tool === 'delete_file' || call.tool === 'set_executable' || call.tool === 'move_file') &&
    paths.some((candidate) => candidate === '' || candidate === '.' || candidate === './')
  ) {
    return { ok: false, error: 'That operation cannot target the workspace root.' };
  }
  return { ok: true };
}

function normalizeDir(rel: string): string {
  return rel === '.' || rel === './' ? '' : rel;
}

/** All non-empty prefixes of `rel`, including `rel` itself. */
function prefixesForRel(rel: string): string[] {
  if (rel === '') {
    return [];
  }
  const parts = rel.split('/');
  const out: string[] = [];
  for (let index = 1; index <= parts.length; index++) {
    out.push(parts.slice(0, index).join('/'));
  }
  return out;
}

/** Parent prefixes of `rel`, excluding the final component. */
function parentPrefixesForRel(rel: string): string[] {
  const all = prefixesForRel(rel);
  return all.slice(0, Math.max(0, all.length - 1));
}

/**
 * Reject any symlink component along the parent chain of `cleanRel`.
 * Uses only `stat` on each ancestor so parent symlinks such as
 * `linked-dir/secret` are blocked even when the final target reports a
 * different kind. Missing ancestors are ignored here; canonical
 * containment below validates the nearest existing parent instead.
 */
export async function ensureNoSymlinkParents(fs: AgentFs, cleanRel: string): Promise<void> {
  for (const parent of parentPrefixesForRel(cleanRel)) {
    let kind: string;
    try {
      kind = (await fs.stat(parent)).kind;
    } catch {
      throw new Error('The workspace changed; re-read before continuing.');
    }
    if (kind === 'symlink') {
      throw new Error('Symlinks are not followed.');
    }
  }
}

/** Resolve the held canonical root through the fs when available. */
export async function resolveCanonicalRoot(fs: AgentFs, fallbackRoot: string): Promise<string> {
  try {
    if (fs.realpathRoot) {
      return await fs.realpathRoot();
    }
    if (fs.realpath) {
      return await fs.realpath('');
    }
  } catch {
    // Fall through to the fallback below.
  }
  return fallbackRoot;
}

/**
 * Enforce canonical containment for `cleanRel` (already normalized).
 * Existing targets must resolve inside `rootReal`. Missing targets
 * validate their nearest existing parent inside `rootReal`. Throws on
 * symlink parents/components, canonical escape, or unresolvable scope.
 * When the fs offers no `realpath`, parent-component `stat` checks still
 * apply and containment falls back to those checks.
 */
export async function ensureCanonicalScope(
  fs: AgentFs,
  cleanRel: string,
  rootReal: string | null | undefined,
): Promise<void> {
  await ensureNoSymlinkParents(fs, cleanRel);
  if (!rootReal || !fs.realpath) {
    return;
  }
  const within = async (candidateReal: string): Promise<boolean> =>
    isWithinRoot(rootReal, candidateReal);
  // Existing target: resolve it directly.
  let targetKind: string;
  try {
    targetKind = (await fs.stat(cleanRel)).kind;
  } catch {
    throw new Error('The workspace changed; re-read before continuing.');
  }
  if (targetKind !== 'missing') {
    // The final component itself must not be a symlink.
    if (targetKind === 'symlink') {
      throw new Error('Symlinks are not followed.');
    }
    // Every component including the final must not hide a symlink; the
    // parent walk above plus this final check covers the full chain.
    for (const prefix of prefixesForRel(cleanRel)) {
      try {
        if ((await fs.stat(prefix)).kind === 'symlink') {
          throw new Error('Symlinks are not followed.');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Symlinks are not followed.') {
          throw error;
        }
        throw new Error('The workspace changed; re-read before continuing.');
      }
    }
    try {
      const targetReal = await fs.realpath(cleanRel);
      if (!(await within(targetReal))) {
        throw new Error('The path escapes the active workspace.');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'The path escapes the active workspace.') {
        throw error;
      }
      throw new Error('The workspace changed; re-read before continuing.');
    }
    return;
  }
  // Missing target (patch create): validate the nearest existing parent.
  const prefixes = prefixesForRel(cleanRel);
  for (let index = prefixes.length - 1; index >= 0; index--) {
    const ancestor = prefixes[index] as string;
    let kind: string;
    try {
      kind = (await fs.stat(ancestor)).kind;
    } catch {
      throw new Error('The workspace changed; re-read before continuing.');
    }
    if (kind === 'symlink') {
      throw new Error('Symlinks are not followed.');
    }
    if (kind === 'missing') {
      continue;
    }
    try {
      const ancestorReal = await fs.realpath(ancestor);
      if (!(await within(ancestorReal))) {
        throw new Error('The path escapes the active workspace.');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'The path escapes the active workspace.') {
        throw error;
      }
      throw new Error('The workspace changed; re-read before continuing.');
    }
    return;
  }
  // No existing ancestor below the root: resolve the root itself.
  try {
    const rootResolved = fs.realpathRoot ? await fs.realpathRoot() : rootReal;
    if (!(await within(rootResolved))) {
      throw new Error('The path escapes the active workspace.');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'The path escapes the active workspace.') {
      throw error;
    }
    throw new Error('The workspace changed; re-read before continuing.');
  }
}

/**
 * Guard a normalized rel for read/list/search/write: parent symlinks plus
 * canonical containment when a scope is held.
 */
export async function guardFsPath(
  fs: AgentFs,
  cleanRel: string,
  canonicalRoot?: string | null,
): Promise<void> {
  if (cleanRel === '') {
    return;
  }
  await ensureCanonicalScope(fs, cleanRel, canonicalRoot ?? null);
}

export async function executeListFiles(
  fs: AgentFs,
  call: ValidatedToolCall,
  canonicalRoot?: string | null,
): Promise<string> {
  const dir = normalizeDir(String((call.args as Record<string, unknown>).dir ?? ''));
  const limit = Number((call.args as Record<string, unknown>).limit ?? 50);
  if (dir !== '') {
    const gate = checkAgentRelPath(dir);
    if (!gate.ok) {
      throw new Error(gate.error);
    }
    const clean = (gate as { ok: true; rel: string }).rel;
    await guardFsPath(fs, clean, canonicalRoot ?? null);
    const st = await fs.stat(clean);
    if (st.kind === 'symlink') {
      throw new Error('Symlinks are not followed.');
    }
    if (st.kind !== 'dir') {
      throw new Error('That directory does not exist.');
    }
  } else if (canonicalRoot && fs.realpathRoot) {
    try {
      const held = await fs.realpathRoot();
      if (!isWithinRoot(canonicalRoot, held) || held !== canonicalRoot) {
        throw new Error('The workspace changed; the Agent run stopped.');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'The workspace changed; the Agent run stopped.') {
        throw error;
      }
    }
  }
  const entries = await fs.listEntries(dir);
  const names = entries
    .filter((entry) => !entry.isSymlink)
    .map((entry) => (dir === '' ? entry.name : `${dir}/${entry.name}`))
    .slice(0, Math.min(limit, MAX_DIR_ENTRIES));
  return truncateToolOutput(
    names.length > 0 ? names.join('\n') : '(empty directory)',
    MAX_TOOL_OUTPUT_BYTES,
  );
}
/** Bounded recursive inventory: counts only, never returns file contents. */
export async function executeInspectWorkspace(
  fs: AgentFs,
  call: ValidatedToolCall,
  canonicalRoot?: string | null,
): Promise<string> {
  const args = call.args as Record<string, unknown>;
  const requestedDir = normalizeDir(String(args.dir ?? ''));
  const maxDepth = Math.min(Math.max(Number(args.maxDepth ?? 4), 0), 12);
  const maxEntries = Math.min(Math.max(Number(args.maxEntries ?? 500), 1), 2000);
  let root = requestedDir;
  if (root !== '') {
    const gate = checkAgentRelPath(root);
    if (!gate.ok) {
      throw new Error(gate.error);
    }
    root = (gate as { ok: true; rel: string }).rel;
    await guardFsPath(fs, root, canonicalRoot ?? null);
    if ((await fs.stat(root)).kind !== 'dir') {
      throw new Error('That directory does not exist.');
    }
  }
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let files = 0;
  let directories = 0;
  let symlinksSkipped = 0;
  let protectedSkipped = 0;
  let totalBytes = 0;
  let visited = 0;
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift() as { dir: string; depth: number };
    let entries: AgentFsEntry[];
    try {
      entries = await fs.listEntries(current.dir);
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (visited >= maxEntries) {
        truncated = true;
        queue.length = 0;
        break;
      }
      visited += 1;
      const rel = current.dir === '' ? entry.name : `${current.dir}/${entry.name}`;
      const gate = checkAgentRelPath(rel);
      if (!gate.ok) {
        protectedSkipped += 1;
        continue;
      }
      if (entry.isSymlink) {
        symlinksSkipped += 1;
        continue;
      }
      const clean = (gate as { ok: true; rel: string }).rel;
      try {
        await guardFsPath(fs, clean, canonicalRoot ?? null);
      } catch {
        symlinksSkipped += 1;
        continue;
      }
      if (entry.isDir) {
        directories += 1;
        if (current.depth < maxDepth) {
          queue.push({ dir: clean, depth: current.depth + 1 });
        }
      } else if (entry.isFile) {
        files += 1;
        const st = await fs.stat(clean);
        if (st.kind === 'file' && Number.isSafeInteger(st.size) && (st.size as number) >= 0) {
          totalBytes += st.size as number;
        }
      }
    }
  }
  if (queue.length > 0) {
    truncated = true;
  }
  return [
    `directory: ${root || '.'}`,
    `files: ${files}`,
    `directories: ${directories}`,
    `totalBytes: ${totalBytes}`,
    `entriesVisited: ${visited}`,
    `symlinksSkipped: ${symlinksSkipped}`,
    `protectedSkipped: ${protectedSkipped}`,
    `truncated: ${truncated}`,
  ].join('\n');
}

export async function executeFilesystemUsage(
  fs: AgentFs,
): Promise<string> {
  if (!fs.filesystemUsage) {
    throw new Error('Filesystem usage information is unavailable.');
  }
  const usage = await fs.filesystemUsage();
  for (const value of Object.values(usage)) {
    if (!/^\d+$/.test(value)) {
      throw new Error('Filesystem usage returned invalid data.');
    }
  }
  return [
    `totalBytes: ${usage.totalBytes}`,
    `usedBytes: ${usage.usedBytes}`,
    `freeBytes: ${usage.freeBytes}`,
    `availableBytes: ${usage.availableBytes}`,
  ].join('\n');
}

async function exactWritableRel(fs: AgentFs, raw: string, canonicalRoot?: string | null): Promise<string> {
  const gate = checkAgentRelPath(raw);
  if (!gate.ok) {
    throw new Error(gate.error);
  }
  const rel = (gate as { ok: true; rel: string }).rel;
  if (rel === '') {
    throw new Error('That operation cannot target the workspace root.');
  }
  await guardFsPath(fs, rel, canonicalRoot ?? null);
  return rel;
}

export async function executeCreateDirectory(
  fs: AgentFs,
  call: ValidatedToolCall,
  canonicalRoot?: string | null,
): Promise<string> {
  if (!fs.createDirectory) {
    throw new Error('Directory creation is unavailable.');
  }
  const rel = await exactWritableRel(fs, String((call.args as Record<string, unknown>).path ?? ''), canonicalRoot);
  if ((await fs.stat(rel)).kind !== 'missing') {
    throw new Error('The target already exists; inspect and re-propose the action.');
  }
  await fs.createDirectory(rel);
  if ((await fs.stat(rel)).kind !== 'dir') {
    throw new Error('The directory was not created.');
  }
  return `created directory: ${rel}`;
}

export async function executeMoveFile(
  fs: AgentFs,
  call: ValidatedToolCall,
  canonicalRoot?: string | null,
): Promise<string> {
  if (!fs.moveFile) {
    throw new Error('File moves are unavailable.');
  }
  const args = call.args as Record<string, unknown>;
  const source = await exactWritableRel(fs, String(args.source ?? ''), canonicalRoot);
  const destination = await exactWritableRel(fs, String(args.destination ?? ''), canonicalRoot);
  if (source === destination) {
    throw new Error('Source and destination must differ.');
  }
  if ((await fs.stat(source)).kind !== 'file') {
    throw new Error('The source file does not exist.');
  }
  if ((await fs.stat(destination)).kind !== 'missing') {
    throw new Error('The destination already exists; overwrite is not allowed.');
  }
  const current = await fs.readText(source);
  if (hashContent(current) !== String(args.expectedHash ?? '')) {
    throw new Error('The source changed; re-read and re-propose the action.');
  }
  await fs.moveFile(source, destination);
  return `moved file: ${source} -> ${destination}`;
}

export async function executeDeleteFile(
  fs: AgentFs,
  call: ValidatedToolCall,
  canonicalRoot?: string | null,
): Promise<string> {
  if (!fs.deleteFile) {
    throw new Error('File deletion is unavailable.');
  }
  const args = call.args as Record<string, unknown>;
  const rel = await exactWritableRel(fs, String(args.path ?? ''), canonicalRoot);
  if ((await fs.stat(rel)).kind !== 'file') {
    throw new Error('That file does not exist or is not a regular file.');
  }
  const current = await fs.readText(rel);
  if (hashContent(current) !== String(args.expectedHash ?? '')) {
    throw new Error('The file changed; re-read and re-propose the action.');
  }
  await fs.deleteFile(rel);
  return `deleted file: ${rel}`;
}

export async function executeSetExecutable(
  fs: AgentFs,
  call: ValidatedToolCall,
  canonicalRoot?: string | null,
): Promise<string> {
  if (!fs.setOwnerExecutable) {
    throw new Error('Executable permission changes are unavailable.');
  }
  const args = call.args as Record<string, unknown>;
  const rel = await exactWritableRel(fs, String(args.path ?? ''), canonicalRoot);
  if ((await fs.stat(rel)).kind !== 'file') {
    throw new Error('That file does not exist or is not a regular file.');
  }
  const current = await fs.readText(rel);
  if (hashContent(current) !== String(args.expectedHash ?? '')) {
    throw new Error('The file changed; re-read and re-propose the action.');
  }
  const executable = args.executable === true;
  await fs.setOwnerExecutable(rel, executable);
  const verified = await fs.stat(rel);
  if (verified.kind !== 'file' || verified.ownerExecutable !== executable) {
    throw new Error('The executable permission change could not be verified.');
  }
  return `${executable ? 'enabled' : 'disabled'} owner executable permission: ${rel}`;
}

async function walkTextFiles(
  fs: AgentFs,
  dir: string,
  budget: number,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0 && out.length < budget) {
    const current = stack.pop() as string;
    let entries: AgentFsEntry[];
    try {
      entries = await fs.listEntries(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymlink) {
        continue;
      }
      const rel = current === '' ? entry.name : `${current}/${entry.name}`;
      if (entry.isDir) {
        if (out.length + stack.length < budget * 2) {
          stack.push(rel);
        }
      } else if (entry.isFile) {
        out.push(rel);
        if (out.length >= budget) {
          break;
        }
      }
    }
  }
  return out;
}

export async function executeSearchText(
  fs: AgentFs,
  call: ValidatedToolCall,
  canonicalRoot?: string | null,
): Promise<string> {
  const args = call.args as Record<string, unknown>;
  const query = String(args.query ?? '');
  const dir = normalizeDir(String(args.dir ?? ''));
  const isRegex = args.isRegex === true;
  const maxResults = Math.min(Number(args.maxResults ?? 20), MAX_SEARCH_RESULTS);
  if (dir !== '') {
    const gate = checkAgentRelPath(dir);
    if (!gate.ok) {
      throw new Error(gate.error);
    }
    await guardFsPath(fs, (gate as { ok: true; rel: string }).rel, canonicalRoot ?? null);
  }
  let matchLines: (lines: string[]) => number[];
  if (isRegex) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(query);
    } catch {
      throw new Error('That search pattern is invalid.');
    }
    const regexSearch = createBudgetedRegexSearch(query, REGEX_SEARCH_BUDGET_MS);
    matchLines = (lines) =>
      regexSearch(lines.map((line) => (line.length > MAX_REGEX_LINE_CHARS ? line.slice(0, MAX_REGEX_LINE_CHARS) : line)));
  } else {
    matchLines = (lines) => {
      const out: number[] = [];
      lines.forEach((line, index) => {
        if (line.includes(query)) {
          out.push(index);
        }
      });
      return out;
    };
  }
  const candidates = await walkTextFiles(fs, dir, MAX_DIR_ENTRIES);
  const hits: string[] = [];
  let bytes = 0;
  for (const rel of candidates) {
    const gate = checkAgentRelPath(rel);
    if (!gate.ok) {
      continue;
    }
    const clean = (gate as { ok: true; rel: string }).rel;
    try {
      await guardFsPath(fs, clean, canonicalRoot ?? null);
    } catch {
      continue;
    }
    const st = await fs.stat(clean);
    if (st.kind !== 'file') {
      continue;
    }
    let text: string;
    try {
      text = await fs.readText(rel);
    } catch {
      continue;
    }
    if (text.length > MAX_FILE_BYTES) {
      continue;
    }
    const lines = text.split('\n');
    for (const index of matchLines(lines)) {
      const line = lines[index] as string;
      const hit = `${rel}:${index + 1}:${line.slice(0, 240)}`;
      hits.push(hit);
      bytes += hit.length;
      if (hits.length >= maxResults || bytes > MAX_SEARCH_BYTES) {
        return truncateToolOutput(hits.join('\n'), MAX_TOOL_OUTPUT_BYTES);
      }
    }
  }
  return truncateToolOutput(hits.length > 0 ? hits.join('\n') : '(no matches)', MAX_TOOL_OUTPUT_BYTES);
}

export async function executeReadFile(
  fs: AgentFs,
  call: ValidatedToolCall,
  canonicalRoot?: string | null,
): Promise<string> {
  const args = call.args as Record<string, unknown>;
  const rel = String(args.path ?? '');
  const maxBytes = Math.min(Number(args.maxBytes ?? 65536), MAX_FILE_BYTES);
  const gate = checkAgentRelPath(rel);
  if (!gate.ok) {
    throw new Error(gate.error);
  }
  const clean = (gate as { ok: true; rel: string }).rel;
  if (clean === '') {
    throw new Error('That path is a directory.');
  }
  await guardFsPath(fs, clean, canonicalRoot ?? null);
  const st = await fs.stat(clean);
  if (st.kind === 'symlink') {
    throw new Error('Symlinks are not followed.');
  }
  if (st.kind !== 'file') {
    throw new Error('That file does not exist.');
  }
  const text = await fs.readText(clean);
  // Treat content as untrusted data; enforce UTF-8 and size bounds.
  if (text.includes('\0')) {
    throw new Error('That file is not UTF-8 text.');
  }
  const content = text.slice(0, maxBytes);
  return truncateToolOutput(
    `path: ${clean}\nsha256: ${hashContent(text)}\nownerExecutable: ${st.ownerExecutable === true}\ncontent:\n${content}`,
    MAX_TOOL_OUTPUT_BYTES,
  );
}


