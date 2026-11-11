/**
 * The user's controls for long jobs, as a VS Code command ("RAME Code: Long
 * Jobs"): see every job, read the end of its log, stop it, settle an
 * uncertain one (check again / abandon), turn long jobs on or off, and
 * choose where they run (this computer or a container). Only the user takes
 * these actions; the model can only start a job through its approval card.
 *
 * Free of the `vscode` API: the window functions are passed in.
 */

import { LIMIT_RANGES, limitsForModel, parseLimitsByModel, validateLocalLimits } from './localLimits.js';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { type JobContainerSettings, validateContainerSettings } from './jobContainer.js';
import { isFinalJob, type JobRecord } from './jobRecord.js';
import type { ProviderHost } from './providerTypes.js';

export interface JobsUi {
  showQuickPick<T extends { label: string }>(items: T[], options?: { placeHolder?: string; title?: string }): PromiseLike<T | undefined>;
  showInputBox(options: { title?: string; prompt?: string; value?: string; validateInput?: (value: string) => string | undefined | null }): PromiseLike<string | undefined>;
  showWarningMessage(message: string, options: { modal?: boolean; detail?: string }, ...actions: string[]): PromiseLike<string | undefined>;
  showInformationMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
}

type JobsHost = Pick<ProviderHost, 'jobs' | 'settings' | 'persistSettings' | 'postState' | 'outputChannel'> & { settings: ProviderHost['settings'] };

const ICON: Record<string, string> = { starting: '$(loading~spin)', running: '$(sync~spin)', uncertain: '$(warning)', finished: '$(check)', cancelled: '$(circle-slash)', timed_out: '$(clock)', refused: '$(error)', abandoned: '$(trash)' };

function jobItem(job: JobRecord): { label: string; description: string; detail: string; job: JobRecord } {
  const exit = job.exit?.exitCode;
  return {
    label: `${ICON[job.status] ?? ''} ${job.label} — ${job.status}${job.status === 'finished' && exit != null ? ` (exit ${exit})` : ''}`.trim(),
    description: `${path.basename(job.spec.cwd)} · ${job.spec.cleanup ? 'container' : 'this computer'} · ${new Date(job.createdAt).toLocaleString()}`,
    detail: job.note,
    job,
  };
}

/**
 * A starting point for the container settings: a Node.js install from PATH
 * (preferably one with npm), mounted read-only at /opt/node. Only a
 * suggestion: the user sees and edits it before it is saved.
 */
export function suggestedContainerSettings(pathEnv: string | undefined = process.env.PATH): JobContainerSettings {
  const dirs = process.platform === 'win32' ? [] : (pathEnv ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir) && existsSync(path.join(dir, 'node')));
  const nodeBin = dirs.find((dir) => existsSync(path.join(dir, 'npm'))) ?? dirs[0];
  // <prefix>/bin/node (nvm, distributions): mount the prefix, so npm finds its modules.
  const toolMounts = nodeBin === undefined ? [] : path.basename(nodeBin) === 'bin' ? [{ hostPath: path.dirname(nodeBin), containerPath: '/opt/node' }] : [{ hostPath: nodeBin, containerPath: '/opt/node/bin' }];
  const onPath = (name: string): boolean => (pathEnv ?? '').split(path.delimiter).some((dir) => path.isAbsolute(dir) && existsSync(path.join(dir, process.platform === 'win32' ? `${name}.exe` : name)));
  return {
    runtime: onPath('podman') ? 'podman' : 'docker',
    image: 'ubuntu:24.04',
    memoryMb: 2048,
    cpus: 2,
    outputDir: 'job-output',
    toolMounts,
    pathEnv: `${toolMounts.length > 0 ? '/opt/node/bin:' : ''}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  };
}

async function saveJobSettings(host: JobsHost, jobs: ProviderHost['settings']['jobs']): Promise<void> {
  host.settings = { ...host.settings, jobs };
  host.persistSettings();
  await host.postState();
}

async function jobActions(host: JobsHost, ui: JobsUi, job: JobRecord): Promise<void> {
  const actions = [
    { label: 'Show the end of its log', id: 'log' },
    ...(job.status === 'running' || job.status === 'starting' ? [{ label: 'Stop it', id: 'stop' }] : []),
    ...(job.status === 'uncertain' ? [{ label: 'Check again', id: 'check' }] : []),
    ...(job.status === 'uncertain' && job.spec.cleanup ? [{ label: 'Stop it (remove its container)', id: 'stop' }] : []),
    ...(job.status === 'uncertain' ? [{ label: 'Abandon it (its result stays unknown; nothing is restarted)', id: 'abandon' }] : []),
  ];
  const chosen = await ui.showQuickPick(actions, { title: `${job.label} — ${job.status}`, placeHolder: job.note });
  if (chosen === undefined) {
    return;
  }
  if (chosen.id === 'log') {
    host.outputChannel.clear();
    host.outputChannel.appendLine(`${job.label} (${job.id}) — ${job.status}: ${job.note}`);
    host.outputChannel.appendLine((await host.jobs.tail(job.id, 16_384)) || '(no output yet)');
    host.outputChannel.show(true);
    return;
  }
  if (chosen.id === 'check') {
    const result = await host.jobs.decide(job.id, 'check-again');
    await ui.showInformationMessage(result.ok ? `${result.value.label}: ${result.value.status}. ${result.value.note}` : result.error);
    return;
  }
  const verb = chosen.id === 'stop' ? 'Stop' : 'Abandon';
  const sure = await ui.showWarningMessage(`${verb} the job ${job.label}?`, { modal: true, detail: job.note }, verb);
  if (sure !== verb) {
    return;
  }
  const result = chosen.id === 'stop' ? await host.jobs.cancel(job.id) : await host.jobs.decide(job.id, 'abandon');
  await ui.showInformationMessage(result.ok ? `${result.value.label}: ${result.value.note}` : result.error);
}

async function chooseIsolation(host: JobsHost, ui: JobsUi): Promise<void> {
  const where = await ui.showQuickPick(
    [
      { label: 'On this computer', detail: 'Jobs run with your permissions (network, files, processes). No sandbox.', id: 'host' },
      { label: 'In a container (Podman or Docker)…', detail: 'No network, limited memory and CPUs, the project read-only except one output folder. The image must already be on this machine. Rootless Podman is preferred: being in the docker group is equivalent to root.', id: 'container' },
    ],
    { title: 'Where long jobs run' },
  );
  if (where === undefined) {
    return;
  }
  if (where.id === 'host') {
    await saveJobSettings(host, { ...host.settings.jobs, container: null });
    return;
  }
  const value = await ui.showInputBox({
    title: 'Container for long jobs (JSON)',
    prompt: 'runtime (podman or docker), image, memoryMb, cpus, outputDir (inside the project), toolMounts (read-only), pathEnv',
    value: JSON.stringify(host.settings.jobs.container ?? suggestedContainerSettings()),
    validateInput: (text) => {
      try {
        const checked = validateContainerSettings(JSON.parse(text));
        return checked.ok ? null : checked.error;
      } catch {
        return 'not valid JSON';
      }
    },
  });
  if (value === undefined) {
    return;
  }
  const checked = validateContainerSettings(JSON.parse(value));
  if (checked.ok) {
    await saveJobSettings(host, { ...host.settings.jobs, container: checked.settings });
  }
}

export async function runJobsMenu(host: JobsHost, ui: JobsUi): Promise<void> {
  const jobs = host.jobs.list();
  await Promise.all(jobs.filter((job) => job.status === 'running' || job.status === 'starting').map((job) => host.jobs.refresh(job.id)));
  const current = host.jobs.list().reverse();
  const shown = [...current.filter((job) => !isFinalJob(job.status)), ...current.filter((job) => isFinalJob(job.status)).slice(0, 15)];
  const settings = host.settings.jobs;
  const chosen = await ui.showQuickPick<{ label: string; description?: string; detail?: string; job?: JobRecord; id?: string }>(
    [
      ...shown.map(jobItem),
      { label: settings.enabled ? '$(debug-pause) Long jobs for Agent: ON — turn off' : '$(play) Long jobs for Agent: OFF — turn on', id: 'toggle' },
      { label: `$(server) Where jobs run: ${settings.container ? `container ${settings.container.image}` : 'this computer (no sandbox)'} — change`, id: 'isolation' },
    ],
    { title: 'RAME Code: Long Jobs', placeHolder: shown.length === 0 ? 'No long jobs yet.' : 'Choose a job to see its log, stop it or settle it.' },
  );
  if (chosen === undefined) {
    return;
  }
  if (chosen.job !== undefined) {
    await jobActions(host, ui, chosen.job);
  } else if (chosen.id === 'toggle') {
    if (settings.enabled) {
      await saveJobSettings(host, { ...settings, enabled: false });
      return;
    }
    const sure = await ui.showWarningMessage(
      'Turn on long jobs for Agent?',
      {
        modal: true,
        detail: `Agent may then propose package scripts (bench, build, test…) that run in the background, keep running if the window reloads, and are never started twice. Each job waits for your approval on a card. ${settings.container ? `They run in the container ${settings.container.image}.` : 'They run on this computer with your permissions: there is no sandbox unless you choose a container.'}`,
      },
      'Turn on',
    );
    if (sure === 'Turn on') {
      await saveJobSettings(host, { ...settings, enabled: true });
    }
  } else if (chosen.id === 'isolation') {
    await chooseIsolation(host, ui);
  }
}

/** After a reload: tell the user about jobs whose result RAME no longer knows. */
export async function noticeUncertainJobs(host: JobsHost, ui: JobsUi): Promise<void> {
  const uncertain = host.jobs.list().filter((job) => job.status === 'uncertain');
  if (uncertain.length === 0) {
    return;
  }
  const answer = await ui.showInformationMessage(
    `RAME Code lost track of ${uncertain.length === 1 ? `the long job ${uncertain[0]?.label}` : `${uncertain.length} long jobs`}; nothing was restarted. Review ${uncertain.length === 1 ? 'it' : 'them'}?`,
    'Review',
  );
  if (answer === 'Review') {
    await runJobsMenu(host, ui);
  }
}

/** "RAME Code: Installs": turn installs with permission on or off, and the automatic mode. */
export async function runInstallsMenu(host: JobsHost, ui: JobsUi): Promise<void> {
  const installs = host.settings.installs;
  const chosen = await ui.showQuickPick(
    [
      { label: installs.enabled ? '$(check) Installs for Agent: ON (each one on a card) — turn off' : '$(circle-slash) Installs for Agent: OFF — turn on', id: 'enabled' },
      { label: installs.auto ? '$(zap) Automatic installs in Workspace full: ON — turn off' : '$(lock) Automatic installs in Workspace full: OFF — turn on', id: 'auto' },
    ],
    { title: 'RAME Code: Installs', placeHolder: 'Administrator rights always go through your own password or UAC prompt.' },
  );
  if (chosen === undefined) {
    return;
  }
  if (chosen.id === 'enabled') {
    host.settings = { ...host.settings, installs: { enabled: !installs.enabled, auto: installs.enabled ? false : installs.auto } };
  } else if (installs.auto) {
    host.settings = { ...host.settings, installs: { ...installs, auto: false } };
  } else {
    const sure = await ui.showWarningMessage(
      'Let Agent install without a card in Workspace full?',
      { modal: true, detail: 'npm and pip packages and container images (including downloads) would then install without asking, each one still recorded and checked. Anything that needs administrator rights still waits for your approval and your own password or UAC prompt.' },
      'Turn on',
    );
    if (sure !== 'Turn on') {
      return;
    }
    host.settings = { ...host.settings, installs: { enabled: true, auto: true } };
  }
  host.persistSettings();
  await host.postState();
}

/**
 * The idle and total limits of Agent requests to one local model (B-30).
 * Asked as "idle seconds, total seconds"; an empty answer goes back to the
 * defaults (180 s and 10 min). The limits are never removed, only set within
 * their ranges.
 */
export async function runLocalLimitsMenu(host: JobsHost & { generationModel(provider: 'local'): string }, ui: JobsUi): Promise<void> {
  const model = host.generationModel('local').trim();
  if (model.length === 0) {
    await ui.showInformationMessage('Choose a local model first.');
    return;
  }
  const current = limitsForModel(host.settings.localLimits, model);
  const answer = await ui.showInputBox({
    title: `RAME Code: limits for ${model}`,
    prompt: `Idle seconds (no new output, including the wait for the first token), then total seconds of one request. Empty = 180, 600. Ranges: ${LIMIT_RANGES}. Cancel always works.`,
    value: `${current.idleMs / 1000}, ${current.totalMs / 1000}`,
    validateInput: (value) => (value.trim() === '' || parseLimitsAnswer(value) !== null ? null : `Two whole numbers, for example 180, 600 (${LIMIT_RANGES}).`),
  });
  if (answer === undefined) {
    return;
  }
  const limits = { ...host.settings.localLimits };
  const parsed = parseLimitsAnswer(answer);
  if (answer.trim() === '' || parsed === null) {
    delete limits[model];
  } else {
    limits[model] = parsed;
  }
  host.settings = { ...host.settings, localLimits: parseLimitsByModel(limits) };
  host.persistSettings();
  await host.postState();
}

export function parseLimitsAnswer(value: string): { idleSec: number; totalSec: number } | null {
  const match = /^\s*(\d{1,5})\s*[,; ]\s*(\d{1,5})\s*$/.exec(value);
  if (match === null) {
    return null;
  }
  const limits = validateLocalLimits({ idleSec: Number(match[1]), totalSec: Number(match[2]) });
  return limits === null ? null : { idleSec: limits.idleMs / 1000, totalSec: limits.totalMs / 1000 };
}
