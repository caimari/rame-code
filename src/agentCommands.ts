/**
 * Allowlisted test-command derivation and spawn specification.
 *
 * Free of the `vscode` API and of `node:child_process` so it can be unit
 * tested with plain `node:test`. The host spawns `executable` plus `argv`
 * with `shell: false`; this module never builds a shell command string.
 */

import * as path from 'node:path';

import {
  type HostPlatform,
  isWithinRoot,
  MAX_TEST_DURATION_MS,
  MAX_TEST_OUTPUT_BYTES,
} from './agentPolicy.js';

export interface AllowedTestCommand {
  /** Stable id the model proposes, e.g. `npm:test`. */
  id: string;
  executable: string;
  argv: string[];
  description: string;
}

export interface TestSpawnSpec {
  executable: string;
  argv: string[];
  shell: false;
  timeoutMs: number;
  maxOutputBytes: number;
}

/** Package scripts considered safe to expose as named test commands. */
export const SAFE_SCRIPT_NAMES: readonly string[] = [
  'test',
  'check',
  'compile',
  'lint',
  'typecheck',
];

/**
 * npm runs `pre<name>`/`post<name>` lifecycle scripts around `npm run
 * <name>`. Those hooks are not the approved script, so derived commands
 * pass `--ignore-scripts`, which still runs exactly the named script.
 */
export const NPM_RUN_ARGV_PREFIX: readonly string[] = ['run', '--ignore-scripts'];

/**
 * Derive the allowlist from safe `package.json` scripts plus explicit
 * settings entries. Script commands are never executed as strings: each
 * entry becomes `{ executable: 'npm', argv: ['run', '--ignore-scripts', name] }`.
 */
export function deriveAllowedCommands(
  packageScripts: Record<string, string> | undefined | null,
  explicit: readonly AllowedTestCommand[] | undefined | null,
): AllowedTestCommand[] {
  const out: AllowedTestCommand[] = [];
  const seen = new Set<string>();
  if (packageScripts && typeof packageScripts === 'object') {
    for (const name of SAFE_SCRIPT_NAMES) {
      if (typeof packageScripts[name] === 'string') {
        const id = `npm:${name}`;
        if (!seen.has(id)) {
          seen.add(id);
          out.push({
            id,
            executable: 'npm',
            argv: [...NPM_RUN_ARGV_PREFIX, name],
            description: `Package script "${name}".`,
          });
        }
      }
    }
  }
  if (explicit) {
    for (const entry of explicit) {
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        typeof entry.executable !== 'string' ||
        !Array.isArray(entry.argv) ||
        entry.id.length === 0 ||
        entry.id.length > 128 ||
        entry.executable.length === 0 ||
        entry.executable.length > 256
      ) {
        continue;
      }
      // Explicit entries must still be executable+argv (no command string,
      // no shell metacharacters, bounded argv).
      if (/[;&|`$><\n]/.test(entry.executable)) {
        continue;
      }
      if (entry.argv.length > 16 || entry.argv.some((part) => typeof part !== 'string' || part.length > 256 || /[;&|`$><\n\0]/.test(part))) {
        continue;
      }
      if (seen.has(entry.id)) {
        continue;
      }
      seen.add(entry.id);
      out.push({
        id: entry.id,
        executable: entry.executable,
        argv: [...entry.argv],
        description:
          typeof entry.description === 'string'
            ? entry.description.slice(0, 256)
            : 'Explicit allowlisted command.',
      });
    }
  }
  return out;
}

/** Find an allowlisted command by exact id; `null` when not allowlisted. */
export function findAllowedCommand(
  allowlist: readonly AllowedTestCommand[],
  commandId: string,
): AllowedTestCommand | null {
  for (const entry of allowlist) {
    if (entry.id === commandId) {
      return entry;
    }
  }
  return null;
}

/**
 * Build the spawn specification for an allowlisted command. Always
 * `shell: false` with time/output limits; the caller wires `signal` for
 * cancellation.
 */
export function buildTestSpawnSpec(command: AllowedTestCommand): TestSpawnSpec {
  return {
    executable: command.executable,
    argv: [...command.argv],
    shell: false,
    timeoutMs: MAX_TEST_DURATION_MS,
    maxOutputBytes: MAX_TEST_OUTPUT_BYTES,
  };
}

export interface TestInvocation {
  executable: string;
  argv: string[];
}

export interface TestInvocationContext {
  platform: HostPlatform;
  /** The host's PATH value. */
  pathEnv: string | undefined;
  /** Workspace the command runs in; PATH entries inside it are ignored. */
  cwd: string | undefined;
  /** True when the absolute path is an existing regular file. */
  isFile(absolutePath: string): boolean;
}

export const NPM_NOT_FOUND_MESSAGE =
  'npm was not found on PATH (Windows needs node.exe with its bundled npm, or npm.exe). No test ran.';

/**
 * Turn an approved spawn spec into the process the host actually starts.
 * POSIX keeps `npm` as is. Windows cannot start `npm.cmd` without a shell,
 * and its process search tries the working directory (the workspace) first,
 * so `npm` is resolved here to absolute paths from PATH only: relative
 * entries and entries inside the workspace are skipped, and the command
 * becomes `node.exe <npm-cli.js> <argv>` (or a real `npm.exe`). The argv the
 * user approved is passed through unchanged. Throws when nothing is found.
 */
export function resolveTestInvocation(
  spec: { executable: string; argv: readonly string[] },
  context: TestInvocationContext,
): TestInvocation {
  if (context.platform !== 'win32' || spec.executable !== 'npm') {
    return { executable: spec.executable, argv: [...spec.argv] };
  }
  const win = path.win32;
  const dirs = (context.pathEnv ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => /^([A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(entry))
    .filter((entry) => !(context.cwd && isWithinRoot(context.cwd, entry, 'win32')));
  const npmCliIn = (dir: string): string | null => {
    const cli = win.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return context.isFile(cli) ? cli : null;
  };
  let nodeExe: string | null = null;
  for (const dir of dirs) {
    const candidate = win.join(dir, 'node.exe');
    if (!context.isFile(candidate)) {
      continue;
    }
    nodeExe ??= candidate;
    const cli = npmCliIn(dir);
    if (cli !== null) {
      return { executable: candidate, argv: [cli, ...spec.argv] };
    }
  }
  for (const dir of dirs) {
    const exe = win.join(dir, 'npm.exe');
    if (context.isFile(exe)) {
      return { executable: exe, argv: [...spec.argv] };
    }
    // A globally updated npm (`npm i -g npm`) lives next to npm.cmd.
    if (nodeExe !== null && context.isFile(win.join(dir, 'npm.cmd'))) {
      const cli = npmCliIn(dir);
      if (cli !== null) {
        return { executable: nodeExe, argv: [cli, ...spec.argv] };
      }
    }
  }
  throw new Error(NPM_NOT_FOUND_MESSAGE);
}

/** Bounded script text included in the approval digest (never the full file). */
export const MAX_BOUND_SCRIPT_CHARS = 500;

/** Bound one package script for display/approval without echoing secrets. */
export function boundScriptText(script: string): string {
  const clean = script.replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return clean.length > MAX_BOUND_SCRIPT_CHARS
    ? clean.slice(0, MAX_BOUND_SCRIPT_CHARS)
    : clean;
}

export interface BoundRunTestsAction {
  targets: string[];
  body: string;
  preconditions: Record<string, string>;
  commandId: string;
  executable: string;
  argv: string[];
  script: string;
  packageJsonHash: string;
}

/**
 * Describe the exact resolved test action for approval binding. The digest
 * covers the stable id, executable, argv, bounded package script text, and
 * the package.json precondition hash used to derive it. The UI shows
 * `body` (commandId + executable + argv + script) so the user authorizes
 * the actual resolved action, not only the model-provided id.
 */
export function describeBoundRunTestsAction(
  commandId: string,
  command: AllowedTestCommand,
  packageJsonRaw: string,
  scriptText: string,
  hashFor: (text: string) => string,
): BoundRunTestsAction {
  const script = boundScriptText(scriptText);
  const packageJsonHash = hashFor(packageJsonRaw);
  const body = JSON.stringify({
    commandId,
    executable: command.executable,
    argv: command.argv,
    script,
  });
  return {
    targets: [commandId],
    body,
    preconditions: { 'package.json': packageJsonHash },
    commandId,
    executable: command.executable,
    argv: [...command.argv],
    script,
    packageJsonHash,
  };
}

/** Parse a bound run_tests body; `null` when the shape is unexpected. */
export function parseBoundRunTestsBody(body: string): {
  commandId: string;
  executable: string;
  argv: string[];
  script: string;
} | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.commandId !== 'string' ||
      typeof record.executable !== 'string' ||
      !Array.isArray(record.argv) ||
      typeof record.script !== 'string'
    ) {
      return null;
    }
    if (!record.argv.every((part) => typeof part === 'string')) {
      return null;
    }
    return {
      commandId: record.commandId,
      executable: record.executable,
      argv: [...(record.argv as string[])],
      script: record.script,
    };
  } catch {
    return null;
  }
}

/**
 * Verify a freshly-derived allowlist entry still matches the approved bound
 * action. Returns false when package.json changed (hash mismatch), the
 * command vanished, or executable/argv/script drifted: the caller must stop
 * and require re-proposal.
 */
export function boundRunTestsStillMatches(
  approvedBody: string,
  approvedPreconditions: Record<string, string>,
  freshCommand: AllowedTestCommand | null,
  freshPackageJsonRaw: string,
  freshScriptText: string,
  hashFor: (text: string) => string,
): boolean {
  const approved = parseBoundRunTestsBody(approvedBody);
  if (!approved || !freshCommand) {
    return false;
  }
  if (approved.commandId !== freshCommand.id) {
    return false;
  }
  if (approved.executable !== freshCommand.executable) {
    return false;
  }
  if (
    approved.argv.length !== freshCommand.argv.length ||
    approved.argv.some((part, index) => part !== freshCommand.argv[index])
  ) {
    return false;
  }
  if (approved.script !== boundScriptText(freshScriptText)) {
    return false;
  }
  const freshHash = hashFor(freshPackageJsonRaw);
  if (approvedPreconditions['package.json'] !== freshHash) {
    return false;
  }
  return true;
}

/**
 * True only for derived npm script commands
 * (`npm run --ignore-scripts <safe-name>`). Explicit executable settings are
 * not accepted in this slice.
 */
export function isDerivedNpmTestCommand(command: AllowedTestCommand): boolean {
  if (command.executable !== 'npm') {
    return false;
  }
  const prefix = NPM_RUN_ARGV_PREFIX.length;
  if (
    command.argv.length !== prefix + 1 ||
    NPM_RUN_ARGV_PREFIX.some((part, index) => command.argv[index] !== part)
  ) {
    return false;
  }
  return (SAFE_SCRIPT_NAMES as readonly string[]).includes(command.argv[prefix] as string);
}

/** Script name of a derived npm command; `null` for anything else. */
export function derivedNpmScriptName(command: AllowedTestCommand): string | null {
  return isDerivedNpmTestCommand(command) ? (command.argv[NPM_RUN_ARGV_PREFIX.length] as string) : null;
}
