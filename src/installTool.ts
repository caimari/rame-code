/**
 * The Agent's install tools (roadmap 6.2), built on `installPlan.ts`:
 *   - `install_package` says what the task needs and asks for permission on
 *     a card with the exact command; with permission RAME installs it and
 *     checks the result itself;
 *   - `check_installed` (a read) checks whether something is installed, and
 *     can wait for an install the user is finishing in a terminal.
 *
 * Rules:
 *   - offered by default in Agent, never in a Mission run;
 *   - every install waits for the user's approval, unless the user turned on
 *     automatic installs and chose Workspace full; even then, anything that
 *     needs administrator rights waits, and goes through the OS prompt;
 *   - `sudo` runs with `-n` (it never waits for a password); when it needs
 *     one, the command opens in a VS Code terminal where the user types it;
 *   - an install is reported as done only when the check finds it.
 */

import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveTestInvocation } from './agentCommands.js';
import { isWithinRoot } from './agentPolicy.js';

import { runBoundedProcess } from './agentProcess.js';
import type { AgentToolDefinition, ValidatedToolCall } from './agentTools.js';
import { type InstallPlan, installRunsWithoutCard, planInstall, readInstalled, validateInstallRequest } from './installPlan.js';
import type { ProviderHost } from './providerTypes.js';
import { ISOLATION_WORDS, isolatedInvocation, isolationRefusal, isolationSupport, isolationUnavailableText } from './shellIsolation.js';
import type { CommandIsolation } from './settingsStore.js';

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT = 64 * 1024;

let openTerminal: ((title: string, commandLine: string) => void) | null = null;

/** The extension gives RAME a way to open a terminal with a command for the user to run. */
export function setInstallTerminal(open: ((title: string, commandLine: string) => void) | null): void {
  openTerminal = open;
}

export function installToolsOffered(host: ProviderHost): boolean {
  return host.settings.installs?.enabled !== false && host.missionAuto === null && host.activeMission === null;
}

const REQUEST_PROPERTIES = {
  manager: { type: 'string', enum: ['apt', 'winget', 'npm', 'pip', 'image'] },
  name: { type: 'string' },
  version: { type: 'string' },
  runtime: { type: 'string', enum: ['podman', 'docker'] },
};

export function installToolDefinitions(host: ProviderHost): AgentToolDefinition[] {
  if (!installToolsOffered(host)) {
    return [];
  }
  return [
    {
      type: 'function',
      function: {
        name: 'install_package',
        description:
          'Install something the task needs, with the user\'s permission: a system package (manager apt on Ubuntu/Debian, winget on Windows), an npm package (global, for the user), a Python package (pip, for the user), or a container image (manager image, with runtime podman or docker). ' +
          'Say why in reason. The user sees the exact command and approves it; administrator rights go through the user\'s own password or UAC prompt. RAME checks the result itself. Check first with check_installed; install only what is missing.',
        parameters: { type: 'object', properties: { ...REQUEST_PROPERTIES, reason: { type: 'string' } }, required: ['manager', 'name', 'reason'], additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_installed',
        description: 'Check whether a package, program or image is installed (and its version). With waitSec (0 to 120), wait up to that long for an install the user is finishing.',
        parameters: { type: 'object', properties: { ...REQUEST_PROPERTIES, waitSec: { type: 'integer' } }, required: ['manager', 'name'], additionalProperties: false },
      },
    },
  ];
}

function requestOf(call: ValidatedToolCall): ReturnType<typeof validateInstallRequest> {
  const { reason: _reason, waitSec: _wait, ...request } = call.args as Record<string, unknown>;
  return validateInstallRequest(request);
}

const isFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const real = (target: string): string | null => {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
};

/**
 * POSIX: a folder or program anyone may change, or one owned by another
 * user (neither root nor the user), is not trusted. Windows: not checked.
 */
function untrustedOwnerOrMode(target: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return false;
  }
  try {
    const stat = statSync(target);
    const worldWritable = (stat.mode & 0o002) !== 0 && (stat.mode & 0o1000) === 0;
    const me = typeof process.getuid === 'function' ? process.getuid() : -1;
    return worldWritable || (stat.uid !== 0 && stat.uid !== me);
  } catch {
    return true;
  }
}

/**
 * The program that really runs: found only in absolute PATH entries outside
 * the project, so a `sudo` or `pip` the agent wrote into the project (or one
 * reachable through a relative entry such as `.`) is never executed. The
 * folder and the program are also followed through symbolic links (neither
 * may lead into the project) and must not be writable by anyone or owned by
 * another user. npm on Windows runs as node.exe + npm-cli.js (a .cmd cannot
 * run without a shell).
 */
export function trustedInvocation(executable: string, argv: readonly string[], root: string, platform: NodeJS.Platform = process.platform, pathEnv: string | undefined = process.env.PATH): { executable: string; argv: string[] } {
  if (platform === 'win32' && executable === 'npm') {
    return resolveTestInvocation({ executable, argv }, { platform, pathEnv, cwd: root, isFile });
  }
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const absolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  const roots = [root, real(root)].filter((entry): entry is string => entry !== null);
  const inProject = (target: string): boolean => roots.some((projectRoot) => isWithinRoot(projectRoot, target, platform));
  for (const dir of (pathEnv ?? '').split(platform === 'win32' ? ';' : ':')) {
    const entry = dir.trim().replace(/^"(.*)"$/, '$1');
    if (entry.length === 0 || !absolute(entry) || inProject(entry)) {
      continue;
    }
    const realEntry = real(entry);
    if (realEntry === null || inProject(realEntry) || untrustedOwnerOrMode(realEntry, platform)) {
      continue;
    }
    for (const suffix of platform === 'win32' ? ['.exe'] : ['']) {
      const candidate = join(entry, `${executable}${suffix}`);
      if (!isFile(candidate)) {
        continue;
      }
      const realCandidate = real(candidate);
      if (realCandidate === null || inProject(realCandidate) || untrustedOwnerOrMode(realCandidate, platform)) {
        continue;
      }
      return { executable: candidate, argv: [...argv] };
    }
  }
  throw new Error(`${executable} was not found in a safe PATH entry (relative entries and folders inside the project are ignored)`);
}

async function runTrusted(executable: string, argv: readonly string[], root: string, timeoutMs: number, signal?: AbortSignal, isolation: CommandIsolation = 'total', extraWrites: readonly string[] = []): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  let invocation: { executable: string; argv: string[] };
  try {
    invocation = trustedInvocation(executable, argv, root);
  } catch (error) {
    return { exitCode: null, stdout: '', stderr: String((error as Error)?.message ?? error), timedOut: false };
  }
  const isolated = isolatedInvocation(isolation, invocation.executable, invocation.argv, root, undefined, undefined, extraWrites);
  return runBoundedProcess({ executable: isolated.executable, argv: isolated.argv, timeoutMs, maxOutputBytes: MAX_OUTPUT }, signal).catch((error: unknown) => ({ exitCode: null, stdout: '', stderr: String((error as Error)?.message ?? error), timedOut: false }));
}

type InstallExecution = { plan: InstallPlan; isolation: CommandIsolation; writes: string[] };

async function installExecution(host: ProviderHost, plan: InstallPlan, root: string): Promise<{ ok: true; value: InstallExecution } | { ok: false; error: string }> {
  const isolation = host.settings.shell?.isolation ?? 'project';
  if (plan.elevated) {
    return { ok: true, value: { plan, isolation: 'total', writes: [] } };
  }
  const refusal = isolationRefusal(isolation, isolation === 'total' ? { ok: true, abi: 0 } : await isolationSupport());
  if (refusal !== null) {
    return { ok: false, error: isolationUnavailableText('installs', isolation, refusal) };
  }
  if (isolation === 'closed' && plan.downloads) {
    return { ok: false, error: 'Not run: this install downloads data, but Closed isolation blocks the network. Choose Project to keep file isolation with network, or Total consciously.' };
  }
  if (isolation !== 'total' && plan.request.manager === 'image') {
    return { ok: false, error: 'Not run: container runtimes write to storage managed outside the project, and RAME cannot safely grant only that storage. Choose Total consciously, or use an already configured container job.' };
  }
  const writes: string[] = [];
  if (isolation !== 'total' && plan.request.manager === 'npm') {
    const prefix = await runTrusted('npm', ['prefix', '--global'], root, 20_000);
    const folder = prefix.exitCode === 0 ? prefix.stdout.trim() : '';
    // If npm cannot report a prefix, grant no extra folder: Landlock then
    // makes the install fail safely instead of widening the sandbox.
    if (path.isAbsolute(folder)) writes.push(folder);
  }
  if (isolation !== 'total' && plan.request.manager === 'pip') {
    const python = process.platform === 'win32' ? 'py' : 'python3';
    const locations = await runTrusted(python, ['-c', 'import site; print(site.getuserbase()); print(site.getusersitepackages())'], root, 20_000);
    const folders = locations.exitCode === 0 ? locations.stdout.split(/\r?\n/).map((part) => part.trim()).filter((part) => path.isAbsolute(part)) : [];
    if (folders.length >= 2) writes.push(...folders, path.join(folders[0] as string, 'bin'));
  }
  return { ok: true, value: { plan, isolation, writes } };
}

/** The image's id in that runtime (without `sha256:`), or `null` when it is not there. */
async function imageId(runtime: 'docker' | 'podman', name: string, root: string): Promise<string | null> {
  const result = await runTrusted(runtime, ['image', 'inspect', '--format', '{{.Id}}', name], root, 20_000);
  const id = result.stdout.trim().replace(/^sha256:/, '');
  return result.exitCode === 0 && /^[0-9a-f]{64}$/.test(id) ? id : null;
}

async function planFor(call: ValidatedToolCall, root: string): Promise<{ ok: true; plan: InstallPlan } | { ok: false; error: string }> {
  const request = requestOf(call);
  if (!request.ok) {
    return request;
  }
  const source = request.request.manager === 'image' && request.request.runtime === 'podman' ? await imageId('docker', request.request.name, root) : null;
  return planInstall(request.request, { platform: process.platform, dockerHasImage: source !== null, ...(source !== null ? { dockerImageId: source } : {}) });
}

/** The approval card: why, and exactly what runs. */
export async function prepareInstallCard(host: ProviderHost, call: ValidatedToolCall, root: string): Promise<{ ok: true; described: { targets: string[]; body: string; preconditions: Record<string, string> } } | { ok: false; error: string }> {
  if (!installToolsOffered(host)) {
    return { ok: false, error: 'installs are off for this run (the user turned them off, or this is a Mission run)' };
  }
  const planned = await planFor(call, root);
  if (!planned.ok) {
    return planned;
  }
  const execution = await installExecution(host, planned.plan, root);
  if (!execution.ok) {
    return execution;
  }
  const reason = String((call.args as { reason?: unknown }).reason ?? '').slice(0, 300);
  const isolation = planned.plan.elevated ? 'not isolated: administrator installation opens in the VS Code terminal and runs only after the user acts' : ISOLATION_WORDS[execution.value.isolation];
  return { ok: true, described: { targets: [`why: ${reason}`, ...planned.plan.lines, `isolation: ${isolation}`], body: JSON.stringify({ reason, plan: planned.plan, isolation: execution.value.isolation, writes: execution.value.writes }), preconditions: {} } };
}

const approved = new WeakMap<ValidatedToolCall, InstallExecution>();

/** Right after the approval: the plan rebuilt now must still be the one the card showed. */
export async function confirmInstallApproval(host: ProviderHost, call: ValidatedToolCall, approvedBody: string, root: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const planned = await planFor(call, root);
  if (!planned.ok) {
    return { ok: false, error: `The install can no longer run: ${planned.error}. Nothing was installed.` };
  }
  const execution = await installExecution(host, planned.plan, root);
  // Compare below with the actual setting embedded in the approved body; the
  // host calls this immediately, so a settings change invalidates the card.
  const reason = String((call.args as { reason?: unknown }).reason ?? '').slice(0, 300);
  let shown: { isolation?: CommandIsolation; writes?: string[] };
  try { shown = JSON.parse(approvedBody) as typeof shown; } catch { return { ok: false, error: 'The install approval is not valid. Nothing was installed.' }; }
  const level = shown.isolation ?? 'project';
  const current = execution.ok && level === execution.value.isolation ? execution.value : null;
  if (current === null || JSON.stringify({ reason, plan: planned.plan, isolation: current.isolation, writes: current.writes }) !== approvedBody) {
    return { ok: false, error: 'The install changed after it was approved. Nothing was installed; propose it again.' };
  }
  approved.set(call, current);
  return { ok: true };
}

const autoPlans = new WeakMap<ValidatedToolCall, InstallExecution>();

/**
 * Automatic installs: only when the user turned them on, in Workspace full,
 * and only for a local copy (no download, no administrator rights). The
 * plan checked here is kept and must still be the same when it runs.
 */
export async function installAuto(host: ProviderHost, profile: string, call: ValidatedToolCall, root: string, fullAccess = false): Promise<boolean> {
  if (call.tool !== 'install_package' || !installToolsOffered(host) || (!fullAccess && (host.settings.installs?.auto !== true || profile !== 'workspace-full'))) {
    return false;
  }
  const planned = await planFor(call, root);
  // Full Access (Autonomy & Permissions): what a package manager downloads, never administrator rights.
  if (!planned.ok || (fullAccess ? planned.plan.elevated : !installRunsWithoutCard(planned.plan, { enabled: true, auto: true }, profile))) {
    return false;
  }
  const execution = await installExecution(host, planned.plan, root);
  if (!execution.ok) return false;
  autoPlans.set(call, execution.value);
  return true;
}

function pipe(step: NonNullable<InstallPlan['steps'][number]>, root: string, signal: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
  let source: { executable: string; argv: string[] };
  let sink: { executable: string; argv: string[] };
  try {
    source = trustedInvocation(step.executable, step.argv, root);
    sink = trustedInvocation(step.pipeTo!.executable, step.pipeTo!.argv, root);
  } catch (error) {
    return Promise.resolve({ exitCode: null, output: String((error as Error)?.message ?? error) });
  }
  return new Promise((resolve) => {
    const from = spawn(source.executable, source.argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const to = spawn(sink.executable, sink.argv, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const keep = (chunk: Buffer) => (output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT));
    from.stdout.pipe(to.stdin);
    from.stderr.on('data', keep);
    to.stdout.on('data', keep);
    to.stderr.on('data', keep);
    const stop = () => (from.kill('SIGKILL'), to.kill('SIGKILL'));
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, INSTALL_TIMEOUT_MS);
    let first: number | null = null;
    from.on('error', () => stop());
    to.on('error', () => (clearTimeout(timer), resolve({ exitCode: null, output })));
    from.on('exit', (code) => (first = code));
    to.on('exit', (code) => (clearTimeout(timer), signal.removeEventListener('abort', stop), resolve({ exitCode: first === 0 ? code : first ?? code, output })));
  });
}

async function check(plan: InstallPlan, root: string, signal?: AbortSignal): Promise<{ installed: boolean; version: string | null }> {
  const result = await runTrusted(plan.check.executable, plan.check.argv, root, 60_000, signal);
  return readInstalled(plan.request, result.exitCode, result.stdout);
}

const what = (plan: InstallPlan): string => `${plan.request.manager} ${plan.request.name}${plan.request.version ? ` ${plan.request.version}` : ''}`;
const verified = (plan: InstallPlan, state: { version: string | null }): string => `Installed and verified by RAME Code: ${what(plan)}${state.version ? ` (version ${state.version})` : ''}.`;

export async function executeInstallTool(host: ProviderHost, call: ValidatedToolCall, root: string, profile: string, signal: AbortSignal): Promise<string> {
  if (!installToolsOffered(host)) {
    return 'Installs are off for this run: the user turned them off, or this is a Mission run.';
  }
  if (call.tool === 'check_installed') {
    const planned = await planFor(call, root);
    if (!planned.ok) {
      return `Not checked: ${planned.error}.`;
    }
    const deadline = Date.now() + Number((call.args as { waitSec?: number }).waitSec ?? 0) * 1000;
    let state = await check(planned.plan, root, signal);
    while (!state.installed && Date.now() < deadline && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      state = await check(planned.plan, root, signal);
    }
    return state.installed ? `Installed: ${what(planned.plan)}${state.version ? ` (version ${state.version})` : ''}.` : `Not installed: ${what(planned.plan)}.`;
  }
  let execution = approved.get(call) ?? null;
  approved.delete(call);
  const auto = autoPlans.get(call) ?? null;
  autoPlans.delete(call);
  if (execution === null && auto !== null) {
    // Automatic: the plan must still be the one checked when the call was let through.
    const planned = await planFor(call, root);
    if (!planned.ok || JSON.stringify(planned.plan) !== JSON.stringify(auto.plan)) {
      return 'Not installed: the install changed between the check and the run; propose it again.';
    }
    execution = auto;
  }
  if (execution === null) {
    return 'Not installed: this install was not approved on a card.';
  }
  const { plan } = execution;
  if ((await check(plan, root, signal)).installed && plan.request.version === undefined) {
    return `Nothing to do: ${what(plan)} is already installed.`;
  }
  if (plan.elevated) {
    const step = plan.steps[0];
    if (step === undefined) return 'Not installed: the approved installation has no command.';
    let line: string;
    try {
      line = [trustedInvocation(step.executable, [], root).executable, ...step.argv].join(' ');
    } catch (error) {
      return `Not installed: ${String((error as Error)?.message ?? error)}.`;
    }
    openTerminal?.('RAME Code: install (not isolated)', line);
    return `Waiting for the user: ${what(plan)} needs administrator rights. Its approved command was opened in the VS Code terminal and is not Landlock-isolated; RAME Code never types or sees the password. Call check_installed after the user finishes.`;
  }
  for (const step of plan.steps) {
    if (step.pipeTo) {
      const result = await pipe(step, root, signal);
      if (result.exitCode !== 0) {
        return `The install failed (exit ${result.exitCode ?? 'unknown'}): ${result.output.slice(-1500)}`;
      }
      // The copy must be exactly the Docker image the plan named.
      const expected = /source: the Docker image ([0-9a-f]{16})…/.exec(plan.lines.join('\n'))?.[1] ?? null;
      const copied = await imageId('podman', plan.request.name, root);
      if (expected !== null && (copied === null || !copied.startsWith(expected))) {
        return `The copy is not the image the card named: Podman has ${copied?.slice(0, 16) ?? 'nothing'}…, the card said ${expected}…. Check it before using it.`;
      }
      continue;
    }
    // sudo never waits for a password here: -n fails at once when it needs one.
    const argv = step.executable === 'sudo' ? ['-n', ...step.argv] : step.argv;
    const result = await runTrusted(step.executable, argv, root, INSTALL_TIMEOUT_MS, signal, execution.isolation, execution.writes);
    if (step.executable === 'sudo' && result.exitCode !== 0 && /password|terminal is required|askpass/i.test(result.stderr)) {
      // The terminal's shell would look `sudo` up on the user's PATH, from the project folder: name the trusted one.
      let line: string;
      try {
        line = [trustedInvocation('sudo', [], root).executable, ...step.argv].join(' ');
      } catch (error) {
        return `Not installed: ${String((error as Error)?.message ?? error)}.`;
      }
      if (openTerminal !== null) {
        openTerminal('RAME Code: install', line);
        return `Waiting for the user: ${what(plan)} needs administrator rights, so the command is open in the terminal "RAME Code: install" and the user types the password there (RAME Code never sees it). Call check_installed with waitSec 120 to see when it is done; do not install it again.`;
      }
      return `Needs administrator rights: ask the user to run this command in a terminal, then call check_installed: ${line}`;
    }
    if (result.exitCode !== 0) {
      return `The install failed (exit ${result.exitCode ?? (result.timedOut ? 'timeout' : 'unknown')}): ${(result.stderr || result.stdout).slice(-1500)}`;
    }
  }
  const state = await check(plan, root, signal);
  return state.installed ? `${verified(plan, state)} Isolation: ${ISOLATION_WORDS[execution.isolation]}.` : `The install command finished under ${ISOLATION_WORDS[execution.isolation]}, but RAME Code could not find ${what(plan)} afterwards: it is not installed.`;
}
