/**
 * Installing what a task needs, with the user's permission (roadmap 6.2):
 * system packages (apt on Ubuntu/Debian, winget on Windows), npm and pip
 * packages, and container images. This module is pure: from the model's
 * request it builds the exact commands the card shows, says whether they
 * need administrator rights or download anything, and how RAME checks the
 * result afterwards. Nothing here runs a command.
 *
 * Rules:
 *   - executable plus argv, never a shell line built from the request; the
 *     executables are resolved by the host from absolute PATH entries outside
 *     the project (installTool.ts), so a program planted in the project or in a
 *     relative PATH entry never runs;
 *   - names and versions are strictly validated per package manager;
 *   - administrator rights always go through the operating system's own
 *     prompt (the user types the sudo password in a terminal; Windows shows
 *     UAC): RAME never stores or types a password;
 *   - an image already in Docker is copied locally into Podman instead of
 *     being downloaded again.
 */

export type InstallManager = 'apt' | 'winget' | 'npm' | 'pip' | 'image';
export const INSTALL_MANAGERS: readonly InstallManager[] = ['apt', 'winget', 'npm', 'pip', 'image'];

export interface InstallRequest {
  manager: InstallManager;
  name: string;
  version?: string;
  /** image only: the container runtime that needs it. */
  runtime?: 'podman' | 'docker';
}

export interface InstallStep {
  executable: string;
  argv: string[];
  /** Needs administrator rights (sudo / an elevated installer). */
  elevated: boolean;
  /** `docker save <image> | podman load`: a local copy, nothing downloaded. */
  pipeTo?: { executable: string; argv: string[] };
}

export interface InstallPlan {
  request: InstallRequest;
  steps: InstallStep[];
  check: { executable: string; argv: string[] };
  elevated: boolean;
  downloads: boolean;
  /** What the card says, one line per fact. */
  lines: string[];
}

const NAMES: Record<InstallManager, RegExp> = {
  apt: /^[a-z0-9][a-z0-9+.-]{0,99}$/,
  winget: /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/,
  npm: /^(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/,
  pip: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
  image: /^[a-z0-9][a-z0-9._\/:@-]{0,199}$/,
};
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+~:_-]{0,63}$/;

/** The request the model sent, validated; the error says what is wrong. */
export function validateInstallRequest(raw: unknown): { ok: true; request: InstallRequest } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'an install needs manager and name' };
  }
  const record = raw as Record<string, unknown>;
  const manager = record.manager as InstallManager;
  if (!INSTALL_MANAGERS.includes(manager)) {
    return { ok: false, error: `manager must be one of ${INSTALL_MANAGERS.join(', ')}` };
  }
  if (typeof record.name !== 'string' || !NAMES[manager].test(record.name) || record.name.startsWith('-')) {
    return { ok: false, error: `${String(record.name).slice(0, 80)} is not a valid ${manager} name` };
  }
  if (record.version !== undefined && (typeof record.version !== 'string' || !VERSION.test(record.version) || manager === 'image')) {
    return { ok: false, error: manager === 'image' ? 'an image has its tag in its name' : 'the version has characters a version cannot have' };
  }
  if (manager === 'image' ? record.runtime !== 'podman' && record.runtime !== 'docker' : record.runtime !== undefined) {
    return { ok: false, error: manager === 'image' ? 'an image needs runtime podman or docker' : 'runtime is only for images' };
  }
  return { ok: true, request: { manager, name: record.name, ...(typeof record.version === 'string' ? { version: record.version } : {}), ...(manager === 'image' ? { runtime: record.runtime as 'podman' | 'docker' } : {}) } };
}

export interface InstallContext {
  platform: NodeJS.Platform;
  /** image only: the image is already in Docker, so Podman can load it locally. */
  dockerHasImage?: boolean;
  /** image only: the exact Docker image (its id) the local copy takes. */
  dockerImageId?: string;
}

/** The exact commands for this request on this computer, or why it cannot be installed here. */
export function planInstall(request: InstallRequest, context: InstallContext): { ok: true; plan: InstallPlan } | { ok: false; error: string } {
  const windows = context.platform === 'win32';
  const { name, version } = request;
  switch (request.manager) {
    case 'apt': {
      if (context.platform !== 'linux') {
        return { ok: false, error: 'apt is for Ubuntu or Debian; use winget on Windows' };
      }
      const target = version ? `${name}=${version}` : name;
      return done(request, [{ executable: 'sudo', argv: ['apt-get', 'install', '-y', '--no-install-recommends', target], elevated: true }], { executable: 'dpkg-query', argv: ['-W', '-f=${Status} ${Version}', name] }, true, [
        `system package ${target} from the configured apt sources (Ubuntu/Debian)`,
        'needs administrator rights: you type the sudo password yourself in a terminal; RAME Code never sees it',
      ]);
    }
    case 'winget': {
      if (!windows) {
        return { ok: false, error: 'winget is for Windows; use apt on Ubuntu' };
      }
      return done(
        request,
        [{ executable: 'winget', argv: ['install', '--id', name, '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', ...(version ? ['--version', version] : [])], elevated: true }],
        { executable: 'winget', argv: ['list', '--id', name, '--exact', '--source', 'winget'] },
        true,
        [
          `Windows program ${name}${version ? ` ${version}` : ''} from the winget community repository (not the Microsoft Store)`,
          'it accepts the package\'s license and the source\'s agreements for you (--accept-package-agreements, --accept-source-agreements): approve only if you accept them',
          'if the installer needs administrator rights, Windows asks you itself (UAC)',
        ],
      );
    }
    case 'npm': {
      const target = version ? `${name}@${version}` : name;
      return done(request, [{ executable: 'npm', argv: ['install', '--global', '--ignore-scripts', target], elevated: false }], { executable: 'npm', argv: ['ls', '--global', '--depth=0', '--json', name] }, true, [
        `npm package ${target}, installed globally for your user (its install scripts do not run)`,
      ]);
    }
    case 'pip': {
      const target = version ? `${name}==${version}` : name;
      const python = windows ? 'py' : 'python3';
      return done(request, [{ executable: python, argv: ['-m', 'pip', 'install', '--user', '--only-binary', ':all:', target], elevated: false }], { executable: python, argv: ['-m', 'pip', 'show', name] }, true, [
        `Python package ${target}, installed for your user with pip`,
        'wheels only (--only-binary :all:): no package code runs while it installs; a package published only as source is refused',
      ]);
    }
    case 'image': {
      const runtime = request.runtime as 'podman' | 'docker';
      if (runtime === 'podman' && context.dockerHasImage === true) {
        return done(request, [{ executable: 'docker', argv: ['save', name], elevated: false, pipeTo: { executable: 'podman', argv: ['load'] } }], { executable: 'podman', argv: ['image', 'inspect', name] }, false, [
          `container image ${name}, copied from Docker into Podman on this computer: nothing is downloaded`,
          ...(context.dockerImageId ? [`source: the Docker image ${context.dockerImageId.replace(/^sha256:/, '').slice(0, 16)}…; RAME checks that Podman then has the same image`] : []),
        ]);
      }
      return done(request, [{ executable: runtime, argv: ['pull', name], elevated: false }], { executable: runtime, argv: ['image', 'inspect', name] }, true, [`container image ${name}, downloaded by ${runtime} from its registry`]);
    }
  }
}

function done(request: InstallRequest, steps: InstallStep[], check: InstallPlan['check'], downloads: boolean, facts: string[]): { ok: true; plan: InstallPlan } {
  const commands = steps.map((step) => [step.executable, ...step.argv].join(' ') + (step.pipeTo ? ` | ${[step.pipeTo.executable, ...step.pipeTo.argv].join(' ')}` : ''));
  const elevated = steps.some((step) => step.elevated);
  return {
    ok: true,
    plan: {
      request,
      steps,
      check,
      elevated,
      downloads,
      lines: [
        `install: ${commands.join(' && ')}`,
        ...facts,
        `afterwards RAME Code checks it: ${[check.executable, ...check.argv].join(' ')}`,
        'installing it does not authorize running it: jobs, commands and Missions that use it still ask',
      ],
    },
  };
}

/** What `check` printed means installed (and which version), or not installed. */
export function readInstalled(request: InstallRequest, exitCode: number | null, stdout: string): { installed: boolean; version: string | null } {
  if (exitCode !== 0) {
    return { installed: false, version: null };
  }
  switch (request.manager) {
    case 'apt': {
      const match = /install ok installed (\S+)/.exec(stdout);
      return { installed: match !== null, version: match?.[1] ?? null };
    }
    case 'winget':
      return { installed: stdout.toLowerCase().includes(request.name.toLowerCase()), version: null };
    case 'npm': {
      try {
        const version = (JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> }).dependencies?.[request.name]?.version ?? null;
        return { installed: version !== null, version };
      } catch {
        return { installed: false, version: null };
      }
    }
    case 'pip': {
      const match = /^Version:\s*(\S+)/m.exec(stdout);
      return { installed: match !== null, version: match?.[1] ?? null };
    }
    case 'image':
      return { installed: stdout.trim().startsWith('['), version: null };
  }
}

/**
 * May this install run without a card? Only when the user turned on
 * automatic installs and chose Workspace full, and only for a local copy
 * that downloads nothing and needs no administrator rights (today: an image
 * already in Docker copied into Podman). Anything downloaded from a public
 * registry (npm, pip, image pulls, apt, winget) always waits for a card.
 */
export function installRunsWithoutCard(plan: InstallPlan, settings: { enabled: boolean; auto: boolean }, profile: string): boolean {
  return settings.enabled && settings.auto && profile === 'workspace-full' && !plan.elevated && !plan.downloads;
}
