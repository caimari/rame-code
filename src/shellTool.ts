/**
 * The Agent's terminal tool: `run_command` runs one shell command line in
 * the project folder, like typing it in a terminal.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Unlike every other tool, this is not a bounded, typed action: with the
 * isolation level "Total" the command runs with the user's permissions and
 * can read or change any file, use the network, install packages or start
 * programs. The default level, "Project", lets it write only in the project,
 * temporary and package-cache folders, and "Closed" also blocks the network
 * (shellIsolation.ts); where that cannot be applied the command is not run.
 * RAME cannot check what a command does, only show it before it runs. So:
 *   - it is OFF unless the user turns it on in Settings;
 *   - it is offered to the main model of an Agent run, local or Meta (with
 *     Meta, its output goes to Meta like every tool result), and never in a
 *     Mission's internal runs (a Mission's grant does not cover it);
 *   - every command is shown, exactly as it will run, and waits for the
 *     user's approval in every profile, Workspace full included: no profile
 *     or model change ever authorizes a command silently;
 *   - the card also says what the line itself does not show: several
 *     commands chained, a command substituted, a script whose content is
 *     not shown, sudo, network, package installs, writes outside the
 *     project (see `commandNotes`). Seeing the line is not knowing all its
 *     effects;
 *   - it runs in the project folder with a time limit (default 120 s, at
 *     most 600 s), RAME signals its normal process group on timeout or Stop,
 *     and its output is bounded. A command can deliberately detach another
 *     process from that group, which keeps the isolation it was started with;
 *   - a few commands that can only destroy (formatting a disk, wiping the
 *     root folder, a fork bomb, shutting down) are refused. That short list
 *     is a seat belt, not a sandbox.
 */

import { existsSync } from 'node:fs';

import { formatProcessResult, runBoundedProcess } from './agentProcess.js';
import type { AgentToolDefinition } from './agentTools.js';
export { commandNotes } from './commandNotes.js';
import type { ProviderHost } from './providerTypes.js';
import type { ProviderId } from './settingsStore.js';
import { ISOLATION_WORDS, isolatedInvocation, isolationRefusal, isolationSupport, notIsolatedText } from './shellIsolation.js';

export const DEFAULT_COMMAND_TIMEOUT_SEC = 120;
export const MAX_COMMAND_TIMEOUT_SEC = 600;
export const MAX_COMMAND_CHARS = 4000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export function shellToolOffered(host: ProviderHost, provider: ProviderId): boolean {
  void provider;
  return host.settings.shell?.enabled === true && host.missionAuto === null;
}

export function shellToolDefinitions(host: ProviderHost, provider: ProviderId): AgentToolDefinition[] {
  if (!shellToolOffered(host, provider)) {
    return [];
  }
  return [
    {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          'Run one shell command line in the project folder, like a terminal (bash or sh; PowerShell on Windows), for example to build, install a dependency, run a script or use git. ' +
          'The user sees the exact command first and approves it unless they gave Full Access. Depending on the user\'s isolation setting it may only write inside the project, temporary and package-cache folders, or have no network; never run destructive commands, never print or send secrets. ' +
          'Prefer the file tools to read or change files. Output is bounded; timeoutSec is 1 to 600 (default 120).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeoutSec: { type: 'integer' },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
  ];
}

/** Commands that can only destroy. Not a defence against every variant: the approval card is. */
const NEVER: Array<[RegExp, string]> = [
  [/\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME)(?:\s|$|\*)/, 'it would delete the root or home folder'],
  [/\bmkfs(?:\.\w+)?\b|\bformat(?:\.com)?\s+[a-z]:/i, 'it would format a disk'],
  [/\bdd\b[^\n]*\bof=\/dev\/(?!null\b)/, 'it would write raw data to a device'],
  [/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'it is a fork bomb'],
  [/(?:^|[;&|(]\s*|\bsudo\s+)(?:shutdown|reboot|poweroff|halt)\b|\b(?:Stop|Restart)-Computer\b/i, 'it would shut down or restart the computer'],
  [/\bchmod\s+-R\s+0?777\s+\/(?:\s|$)/, 'it would open every file of the system'],
  [/>\s*\/dev\/(?:sd[a-z]|nvme\d|disk\d)/, 'it would overwrite a disk'],
];

export function commandRefusal(command: string): string | null {
  for (const [pattern, reason] of NEVER) {
    if (pattern.test(command)) {
      return reason;
    }
  }
  return null;
}

/** The shell RAME uses for a command line on this platform. */
export function shellFor(platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync): { executable: string; argv: (command: string) => string[]; name: string } {
  if (platform === 'win32') {
    return { executable: 'powershell.exe', argv: (command) => ['-NoProfile', '-NonInteractive', '-Command', command], name: 'PowerShell' };
  }
  const bash = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find(exists);
  return bash ? { executable: bash, argv: (command) => ['-c', command], name: 'bash' } : { executable: '/bin/sh', argv: (command) => ['-c', command], name: 'sh' };
}

export async function executeShellTool(host: ProviderHost, args: Record<string, unknown>, provider: ProviderId, root: string, signal: AbortSignal): Promise<string> {
  if (!shellToolOffered(host, provider)) {
    return 'Terminal commands are off for this run: the user has not enabled them in Settings, or this is a Mission run.';
  }
  const command = String(args.command ?? '');
  const refusal = commandRefusal(command);
  if (refusal !== null) {
    return `Not run: RAME refuses this command because ${refusal}.`;
  }
  const timeoutSec = typeof args.timeoutSec === 'number' ? args.timeoutSec : DEFAULT_COMMAND_TIMEOUT_SEC;
  const shell = shellFor();
  const level = host.settings.shell?.isolation ?? 'project';
  const cannot = isolationRefusal(level, level === 'total' ? { ok: true, abi: 0 } : await isolationSupport());
  if (cannot !== null) {
    return notIsolatedText(level, cannot);
  }
  const run = isolatedInvocation(level, shell.executable, shell.argv(command), root);
  const result = await runBoundedProcess(
    {
      executable: run.executable,
      argv: run.argv,
      cwd: root,
      timeoutMs: timeoutSec * 1000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      // runBoundedProcess drops NODE_TEST_CONTEXT (see childEnvironment); the rest is the user's environment.
      env: { RAME_AGENT_COMMAND: '1' },
    },
    signal,
  );
  const formatted = formatProcessResult(result, timeoutSec * 1000, MAX_OUTPUT_BYTES).replace(/^exit=timeout \(stopped after (\d+) s; the tests did not finish\)/, 'exit=timeout (stopped after $1 s; the command did not finish)');
  const exit = /^exit=(\S+)/.exec(formatted)?.[1] ?? 'unknown';
  const blocked = /^rame-isolate: .*$/m.exec(formatted)?.[0];
  return `${shell.name} in the project folder, ${ISOLATION_WORDS[level]} (exit=${exit}): ${command.slice(0, 300)}\n${blocked ? `${blocked}\nThe isolation could not be applied, so the command did not run.\n` : ''}${formatted}`;
}
