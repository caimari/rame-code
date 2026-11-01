/**
 * Local `llama-server` runtime configuration: pure validation, argument
 * construction, loopback enforcement, and ownership state transitions.
 *
 * Free of the `vscode` API and of `node:child_process` so it can be unit
 * tested with plain `node:test`. The extension host performs the actual
 * `spawn` (always with `shell: false` and an argument array) and owns the
 * resulting child handle; this module only decides *what* is valid to run.
 */

export interface LocalRuntimeSettings {
  executablePath: string;
  modelPath: string;
  projectorPath: string;
  draftModelPath: string;
  modelId: string;
  contextSize: number;
  port: number;
  idleTimeoutSec: number;
}

/**
 * Detected suggestions for this machine only. These are offered in Settings
 * as starting values — never mandatory public assumptions and never written
 * without the user's explicit action.
 */
export const LOCAL_RUNTIME_SUGGESTIONS: Readonly<LocalRuntimeSettings> = {
  executablePath: '/workspace/src/llama.cpp-oficial/build/bin/llama-server',
  modelPath:
    '/disco4tb/catalogo-llm/meta/Muse-Glimmer-30B-GGUF/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf',
  projectorPath:
    '/disco4tb/catalogo-llm/meta/Muse-Glimmer-30B-GGUF/mmproj-Muse-Glimmer-30B-Q4_K_M.gguf',
  draftModelPath:
    '/disco4tb/catalogo-llm/meta/Muse-Glimmer-30B-GGUF/dflash-Muse-Glimmer-30B-Q4_K_M.gguf',
  modelId: 'local-glimmer',
  contextSize: 32768,
  port: 8775,
  idleTimeoutSec: 600,
};

export const MIN_CONTEXT_SIZE = 1024;
export const MAX_CONTEXT_SIZE = 262144;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;
export const MAX_IDLE_TIMEOUT_SEC = 86400;
// Loading a 30B quant plus its projector and draft model can legitimately
// take well over 30 seconds. Keep startup bounded without declaring healthy
// local hardware dead while it is still mapping the model.
export const STARTUP_TIMEOUT_MS = 180000;

export interface LocalSettingsValidation {
  ok: boolean;
  settings?: LocalRuntimeSettings;
  error?: string;
}

function isAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    // Drive (`C:\...`) or UNC (`\\server\share\...`); never drive-relative.
    return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
  }
  return value.startsWith('/');
}

function toPort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }
  if (value < MIN_PORT || value > MAX_PORT) {
    return null;
  }
  return value;
}

/**
 * Validate untrusted local-runtime settings. Optional paths (projector,
 * draft model) may be empty; required paths must be absolute. Numeric
 * ranges are enforced. Never echoes path contents, only generic reasons.
 */
export function validateLocalSettings(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): LocalSettingsValidation {
  const isAbsolute = (candidate: string): boolean => isAbsolutePath(candidate, platform);
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'Local runtime settings are invalid.' };
  }
  const record = value as Record<string, unknown>;
  const executablePath =
    typeof record.executablePath === 'string'
      ? record.executablePath.trim()
      : '';
  const modelPath =
    typeof record.modelPath === 'string' ? record.modelPath.trim() : '';
  const projectorPath =
    typeof record.projectorPath === 'string'
      ? record.projectorPath.trim()
      : '';
  const draftModelPath =
    typeof record.draftModelPath === 'string'
      ? record.draftModelPath.trim()
      : '';
  const modelId =
    typeof record.modelId === 'string' ? record.modelId.trim() : '';

  if (executablePath.length === 0 || !isAbsolute(executablePath)) {
    return {
      ok: false,
      error: 'The llama-server executable path must be an absolute path.',
    };
  }
  if (platform === 'win32' && /\.(bat|cmd)$/i.test(executablePath)) {
    // Batch files only run through cmd.exe; RAME never starts a shell.
    return {
      ok: false,
      error: 'On Windows the llama-server path must point to llama-server.exe, not a .bat/.cmd script.',
    };
  }
  if (modelPath.length === 0 || !isAbsolute(modelPath)) {
    return { ok: false, error: 'The model path must be an absolute path.' };
  }
  if (projectorPath.length > 0 && !isAbsolute(projectorPath)) {
    return {
      ok: false,
      error: 'The projector path must be an absolute path or empty.',
    };
  }
  if (draftModelPath.length > 0 && !isAbsolute(draftModelPath)) {
    return {
      ok: false,
      error: 'The draft-model path must be an absolute path or empty.',
    };
  }
  if (modelId.length === 0 || modelId.length > 128) {
    return { ok: false, error: 'The model/display ID is required.' };
  }
  const contextSize =
    typeof record.contextSize === 'number' &&
    Number.isInteger(record.contextSize)
      ? record.contextSize
      : NaN;
  if (
    !Number.isInteger(contextSize) ||
    contextSize < MIN_CONTEXT_SIZE ||
    contextSize > MAX_CONTEXT_SIZE
  ) {
    return {
      ok: false,
      error: `Context size must be between ${MIN_CONTEXT_SIZE} and ${MAX_CONTEXT_SIZE}.`,
    };
  }
  const port = toPort(record.port);
  if (port === null) {
    return {
      ok: false,
      error: `Port must be between ${MIN_PORT} and ${MAX_PORT}.`,
    };
  }
  const idleTimeoutSec =
    typeof record.idleTimeoutSec === 'number' &&
    Number.isInteger(record.idleTimeoutSec)
      ? record.idleTimeoutSec
      : NaN;
  if (
    !Number.isInteger(idleTimeoutSec) ||
    idleTimeoutSec < 0 ||
    idleTimeoutSec > MAX_IDLE_TIMEOUT_SEC
  ) {
    return {
      ok: false,
      error: 'Idle timeout must be between 0 and 86400 seconds.',
    };
  }
  return {
    ok: true,
    settings: {
      executablePath,
      modelPath,
      projectorPath,
      draftModelPath,
      modelId,
      contextSize,
      port,
      idleTimeoutSec,
    },
  };
}

/**
 * Build the `llama-server` argument array. The caller must pass the array
 * directly to `spawn` with `shell: false`; this function never concatenates
 * a shell command. The server is always bound to `127.0.0.1`.
 */
export function buildLlamaServerArgs(
  settings: LocalRuntimeSettings,
): string[] {
  const args = [
    '--host',
    '127.0.0.1',
    '--port',
    String(settings.port),
    '-m',
    settings.modelPath,
    '-c',
    String(settings.contextSize),
  ];
  if (settings.projectorPath.length > 0) {
    args.push('--mmproj', settings.projectorPath);
  }
  if (settings.draftModelPath.length > 0) {
    args.push('--model-draft', settings.draftModelPath);
  }
  return args;
}

/** Local OpenAI-compatible base URL for a loopback port. */
export function loopbackEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * True only when the URL uses http(s) and resolves to this machine's
 * loopback interface (`127.0.0.1` or `localhost`). Anything else —
 * `0.0.0.0`, LAN addresses, remote hosts — is rejected so the runtime can
 * never be configured to expose the server beyond loopback.
 */
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export type LocalRuntimeLifecycle =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping';

export interface LocalRuntimeStatus {
  lifecycle: LocalRuntimeLifecycle;
  /** True when the child was spawned by this extension instance. */
  owned: boolean;
  endpoint: string | null;
  /** Bounded, sanitized tail of server stderr (never model content). */
  diagnostics: string;
}

/** Initial status: nothing running, nothing owned. */
export function initialLocalRuntimeStatus(): LocalRuntimeStatus {
  return { lifecycle: 'stopped', owned: false, endpoint: null, diagnostics: '' };
}

/**
 * Pure lifecycle transition helper used by the host and tests.
 * Ownership is set only when *we* spawn the child; selecting an external
 * endpoint never marks it owned, so deactivation never kills it.
 */
export function nextLocalRuntimeStatus(
  current: LocalRuntimeStatus,
  event:
    | { kind: 'start-requested'; endpoint: string }
    | { kind: 'started'; endpoint: string }
    | { kind: 'health-failed' }
    | { kind: 'stop-requested' }
    | { kind: 'stopped' }
    | { kind: 'external-selected'; endpoint: string }
    | { kind: 'external-cleared' },
): LocalRuntimeStatus {
  switch (event.kind) {
    case 'start-requested':
      if (current.lifecycle !== 'stopped') {
        return current;
      }
      return {
        lifecycle: 'starting',
        owned: true,
        endpoint: event.endpoint,
        diagnostics: '',
      };
    case 'started':
      if (current.lifecycle !== 'starting') {
        return current;
      }
      return { ...current, lifecycle: 'running', endpoint: event.endpoint };
    case 'health-failed':
      if (current.lifecycle !== 'starting') {
        return current;
      }
      return { ...current, lifecycle: 'stopped', owned: false, endpoint: null };
    case 'stop-requested':
      if (current.lifecycle !== 'running' && current.lifecycle !== 'starting') {
        return current;
      }
      return { ...current, lifecycle: 'stopping' };
    case 'stopped':
      return initialLocalRuntimeStatus();
    case 'external-selected':
      return {
        lifecycle: 'stopped',
        owned: false,
        endpoint: event.endpoint,
        diagnostics: '',
      };
    case 'external-cleared':
      return initialLocalRuntimeStatus();
  }
}

/**
 * Bound and sanitize server diagnostics for display: keep only the tail,
 * strip control characters, and never include more than 2000 characters.
 * Stdout (which may contain arbitrary model content) must never be passed
 * here — only bounded stderr lines.
 */
export function sanitizeDiagnostics(lines: string[]): string {
  const tail = lines.slice(-5).join('\n');
  const stripped = tail.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return stripped.length > 2000 ? stripped.slice(-2000) : stripped;
}
