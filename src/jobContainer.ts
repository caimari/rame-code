/**
 * Container isolation for long jobs (piece D of the long-Mission plan).
 *
 * A job can run inside a container (Podman, preferably rootless, or Docker)
 * the user configured, instead of on the computer with the user's permissions:
 *   - no network (`--network none`);
 *   - bounded memory (swap included), CPUs and processes;
 *   - no capabilities, no privilege escalation, a read-only root filesystem;
 *   - the project mounted READ-ONLY, except one output folder;
 *   - the image is never pulled (`--pull never`): only an image already on
 *     the machine runs, so nothing is downloaded behind the user's back;
 *   - a unique container name, so stopping it never depends on a pid.
 *
 * Rootless Podman maps the user's own uid into the container
 * (`--userns=keep-id`); Docker runs the job as the user's uid:gid. Note that
 * being in the `docker` group is equivalent to root on the machine: the
 * container bounds the job, not RAME itself. Rootless Podman does not have
 * that problem.
 *
 * Pure: builds the `run` argv and the card's description.
 */

import * as path from 'node:path';

import { DEFAULT_JOB_HEARTBEAT_MS, DEFAULT_JOB_LOG_BYTES, type JobSpec } from './jobRecord.js';

export interface JobToolMount {
  /** Absolute folder on the computer, mounted read-only (e.g. a Node.js install). */
  hostPath: string;
  /** Absolute folder inside the container. */
  containerPath: string;
}

export type ContainerRuntime = 'docker' | 'podman';

export interface JobContainerSettings {
  runtime: ContainerRuntime;
  image: string;
  memoryMb: number;
  cpus: number;
  /** Project-relative folder the job may write to (created if missing). */
  outputDir: string;
  toolMounts: JobToolMount[];
  /** PATH inside the container. */
  pathEnv: string;
}

export const CONTAINER_WORKDIR = '/work';
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const PROTECTED_OUTPUT = /^(?:\.git|\.vscode|\.env[^/]*|node_modules|\.ssh|\.rame[^/]*)(?:\/|$)/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isAbsolutePosix = (value: unknown): value is string => typeof value === 'string' && path.posix.isAbsolute(value) && !value.split('/').includes('..') && !/[\0\n:,]/.test(value);

/** Validate the user's container settings; the error says what is wrong. */
export function validateContainerSettings(raw: unknown): { ok: true; settings: JobContainerSettings } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: 'container settings are missing' };
  }
  const runtime = raw.runtime === undefined ? 'docker' : raw.runtime;
  if (runtime !== 'docker' && runtime !== 'podman') {
    return { ok: false, error: 'the container runtime must be podman or docker' };
  }
  if (typeof raw.image !== 'string' || !/^[a-z0-9][a-z0-9._\/:@-]{0,199}$/i.test(raw.image) || raw.image.startsWith('-')) {
    return { ok: false, error: 'the image must be a local image name such as ubuntu:24.04' };
  }
  if (!Number.isInteger(raw.memoryMb) || (raw.memoryMb as number) < 64 || (raw.memoryMb as number) > 262_144) {
    return { ok: false, error: 'memory must be 64 to 262144 MB' };
  }
  if (typeof raw.cpus !== 'number' || !Number.isFinite(raw.cpus) || raw.cpus < 0.1 || raw.cpus > 256) {
    return { ok: false, error: 'CPUs must be 0.1 to 256' };
  }
  const outputDir = typeof raw.outputDir === 'string' ? raw.outputDir.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  if (outputDir === '' || outputDir === '.' || path.posix.isAbsolute(outputDir) || outputDir.split('/').some((part) => part === '..' || part === '') || PROTECTED_OUTPUT.test(outputDir) || /[\0\n:,]/.test(outputDir)) {
    return { ok: false, error: 'the output folder must be a plain folder inside the project (not .git, .vscode, .env, node_modules)' };
  }
  const mounts = raw.toolMounts === undefined ? [] : raw.toolMounts;
  if (!Array.isArray(mounts) || mounts.length > 8 || !mounts.every((entry) => isRecord(entry) && isAbsolutePosix(entry.hostPath) && isAbsolutePosix(entry.containerPath) && entry.containerPath !== CONTAINER_WORKDIR && !String(entry.containerPath).startsWith(`${CONTAINER_WORKDIR}/`))) {
    return { ok: false, error: 'tool folders need absolute paths on both sides, outside /work' };
  }
  const pathEnv = raw.pathEnv === undefined ? DEFAULT_PATH : raw.pathEnv;
  if (typeof pathEnv !== 'string' || pathEnv.length === 0 || pathEnv.length > 1024 || !pathEnv.split(':').every((entry) => path.posix.isAbsolute(entry))) {
    return { ok: false, error: 'PATH must list absolute folders' };
  }
  return {
    ok: true,
    settings: {
      runtime,
      image: raw.image,
      memoryMb: raw.memoryMb as number,
      cpus: raw.cpus,
      outputDir,
      toolMounts: (mounts as JobToolMount[]).map((entry) => ({ hostPath: entry.hostPath, containerPath: entry.containerPath })),
      pathEnv,
    },
  };
}

/** One line for the approval card; it is part of what the user approves. */
export function describeIsolation(container: JobContainerSettings | null): string {
  if (container === null) {
    return 'isolation: none — it runs on this computer with your permissions (network, files, processes); there is no sandbox';
  }
  const tools = container.toolMounts.length > 0 ? `; read-only tools: ${container.toolMounts.map((entry) => `${entry.hostPath} → ${entry.containerPath}`).join(', ')}` : '';
  const runtime = container.runtime === 'podman' ? `${typeof process.getuid === 'function' && process.getuid() !== 0 ? 'rootless ' : ''}podman ` : '';
  return `isolation: ${runtime}container ${container.image} (local image only, never pulled): no network, ${container.memoryMb} MB of memory, ${container.cpus} CPU(s), the project read-only except ${container.outputDir}/${tools}`;
}

export interface ContainerJobInput {
  /** The command inside the container, run in /work. */
  executable: string;
  argv: string[];
  projectRoot: string;
  timeoutMs: number;
  /** Unique, e.g. `rame-job-<random>`. */
  containerName: string;
  /** Docker: POSIX uid:gid to run as; `null` keeps the image's user. Podman maps the user's own uid. */
  user: string | null;
  /** The runtime's executable; default: the configured runtime name. */
  docker?: string;
  /** Host-owned folders mounted read-write outside /work (e.g. the host's results folder). */
  extraMounts?: JobToolMount[];
  /** Extra environment inside the container. */
  env?: Record<string, string>;
  /** Project files whose names may be visible but whose contents are host-only. */
  hiddenFiles?: string[];
}

/** The job spec that runs `input` inside the configured container. */
export function buildContainerJob(input: ContainerJobInput, container: JobContainerSettings): JobSpec {
  const docker = input.docker ?? container.runtime;
  const output = path.join(input.projectRoot, ...container.outputDir.split('/'));
  const argv = [
    'run', '--rm', '--init', '--pull', 'never',
    '--name', input.containerName,
    '--network', 'none',
    '--memory', `${container.memoryMb}m`, '--memory-swap', `${container.memoryMb}m`,
    '--cpus', String(container.cpus), '--pids-limit', '512',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--read-only', '--tmpfs', '/tmp:rw,size=256m',
    ...(container.runtime === 'podman' ? ['--userns=keep-id'] : input.user !== null ? ['--user', input.user] : []),
    '-e', 'HOME=/tmp', '-e', `PATH=${container.pathEnv}`, '-e', 'npm_config_cache=/tmp/.npm', '-e', 'npm_config_update_notifier=false', '-e', 'RAME_JOB=1',
    '-v', `${input.projectRoot}:${CONTAINER_WORKDIR}:ro`,
    '-v', `${output}:${CONTAINER_WORKDIR}/${container.outputDir}:rw`,
    ...(input.hiddenFiles ?? []).flatMap((file) => ['-v', `/dev/null:${CONTAINER_WORKDIR}/${file}:ro`]),
    ...container.toolMounts.flatMap((entry) => ['-v', `${entry.hostPath}:${entry.containerPath}:ro`]),
    ...(input.extraMounts ?? []).flatMap((entry) => ['-v', `${entry.hostPath}:${entry.containerPath}:rw`]),
    ...Object.entries(input.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    '-w', CONTAINER_WORKDIR,
    '--', container.image, input.executable, ...input.argv,
  ];
  return {
    executable: docker,
    argv,
    cwd: input.projectRoot,
    timeoutMs: input.timeoutMs,
    maxLogBytes: DEFAULT_JOB_LOG_BYTES,
    heartbeatMs: DEFAULT_JOB_HEARTBEAT_MS,
    env: {},
    keepElectronRunAsNode: false,
    // Stopping the docker client does not always stop the container: remove it by its unique name.
    cleanup: { executable: docker, argv: ['rm', '-f', input.containerName] },
  };
}
