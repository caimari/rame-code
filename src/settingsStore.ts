/**
 * Versioned non-secret settings for the single RAME Code view.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * The Meta API key is never part of these settings: it lives exclusively in
 * SecretStorage. These settings (provider choice, mode, model, local
 * runtime paths, escalation preference, usage totals) may persist in
 * `globalState` through the versioned {@link RAME_SETTINGS_KEY}.
 */

import { type JobContainerSettings, validateContainerSettings } from './jobContainer.js';
import { parseLimitsByModel } from './localLimits.js';
import {
  LOCAL_RUNTIME_SUGGESTIONS,
  validateLocalSettings,
  type LocalRuntimeSettings,
} from './localRuntime.js';
import {
  AGENT_MODE_ID,
  DEFAULT_CHAT_MODE,
  MISSION_MODE_ID,
  type ChatModeId,
} from './modes.js';
import {
  DEFAULT_AGENT_PROFILE,
  parseAgentProfile,
  type AgentProfileId,
} from './agentProfiles.js';
import {
  defaultGenerationSettings,
  validateGenerationSettings,
  type GenerationSettings,
} from './generationSettings.js';
import { EMPTY_USAGE, type ProviderUsage } from './usage.js';
import { DEFAULT_ADVISOR, legacyAdvisor, parseAdvisorModel } from './advisorModels.js';

export const RAME_SETTINGS_KEY = 'rameCode.settings.v1';
export const RAME_USAGE_KEY = 'rameCode.usage.v1';
export const SETTINGS_VERSION = 2;

export type ProviderId = 'cloud' | 'local';

/**
 * Single provider-level runtime choice. The cloud model is a subordinate
 * cloud-only selection (`cloudModel`); it never creates a second
 * conflicting provider/model selector.
 * - `cloud` => Meta Model API (cloud model selected separately)
 * - `local` => Muse Glimmer local runtime
 */
export const RUNTIME_CLOUD_ID = 'cloud' as const;
export const RUNTIME_LOCAL_ID = 'local' as const;
export type RuntimeId = typeof RUNTIME_CLOUD_ID | typeof RUNTIME_LOCAL_ID;

export const RUNTIME_OPTIONS: readonly { id: RuntimeId; label: string }[] = [
  { id: RUNTIME_CLOUD_ID, label: 'Meta Model API — Cloud' },
  { id: RUNTIME_LOCAL_ID, label: 'Muse Glimmer — Local' },
];

/** True only for the two exact provider-level runtime ids. */
export function isRuntimeId(value: unknown): value is RuntimeId {
  return value === RUNTIME_CLOUD_ID || value === RUNTIME_LOCAL_ID;
}

/** Parse an untrusted runtime value; returns null when invalid. */
export function parseRuntimeId(value: unknown): RuntimeId | null {
  return isRuntimeId(value) ? value : null;
}

/** Derive the provider for one exact runtime choice (identity). */
export function runtimeToProvider(runtime: RuntimeId): ProviderId {
  return runtime === RUNTIME_LOCAL_ID ? 'local' : 'cloud';
}

/**
 * Derive the model for one runtime choice. Local always maps to
 * `local-glimmer`; cloud maps to the validated `cloudModel` selection with
 * a safe fallback to `muse-spark-1.3`.
 */
export function runtimeToModel(
  runtime: RuntimeId,
  cloudModel?: unknown,
): string {
  if (runtime === RUNTIME_LOCAL_ID) {
    return 'local-glimmer';
  }
  if (typeof cloudModel === 'string' && isCompatibleCloudModelIdShallow(cloudModel)) {
    return cloudModel.trim();
  }
  return 'muse-spark-1.3';
}

function isCompatibleCloudModelIdShallow(value: string): boolean {
  const id = value.trim();
  if (id.length === 0 || id.length > 128) {
    return false;
  }
  return /^muse-(spark|wonder)-[A-Za-z0-9._-]+$/.test(id);
}

/** Map a stored provider onto its runtime. */
export function providerToRuntime(provider: ProviderId): RuntimeId {
  return provider === 'local' ? RUNTIME_LOCAL_ID : RUNTIME_CLOUD_ID;
}

export const RAME_AUDIT_KEY = 'rameCode.agentAudit.v1';

export interface RameSettings {
  version: number;
  provider: ProviderId;
  mode: ChatModeId;
  /** Effective model: `local-glimmer` for local, selected cloud model otherwise. */
  model: string;
  /** Validated subordinate cloud-only model selection. */
  cloudModel: string;
  /** Whether the last catalog load came from the live API or fallback. */
  cloudCatalogSource: 'live' | 'fallback';
  local: LocalRuntimeSettings;
  /** Optional separately-running model server RAME does not own (Ollama, LM Studio, llama-server). */
  externalLocalEndpoint: string;
  /** The model chosen on that server, and what the server said about it. */
  externalLocal: ExternalLocalChoice;
  /** Read-only web access for Agent (web_search, web_fetch). Default OFF. */
  web: WebSettings;
  /** Terminal commands for Agent (run_command). Default OFF; isolation `project` (shellIsolation.ts). */
  shell: { enabled: boolean; isolation: CommandIsolation };
  /** Long background jobs for Agent (start_job, job_status). Default OFF; container isolation optional. */
  jobs: JobSettings;
  /** Installs with permission for Agent (install_package, check_installed). ON (each one on a card); `auto` lets Workspace full install without a card when no administrator rights are needed. */
  installs: { enabled: boolean; auto: boolean };
  /** Idle and total limits of Agent requests, per local model id (localLimits.ts); a model not listed gets 180 s idle and 10 min total. */
  localLimits: Record<string, { idleSec: number; totalSec: number }>;
  /**
   * Cloud escalation preference. Default OFF. Escalation is only ever a
   * pending user-visible choice; silent fallback is not implemented.
   */
  allowCloudEscalation: boolean;
  /** The model the main model may consult when stuck ('' = none); never the main model itself (advisorModels.ts). */
  advisorModel: string;
  /** Persisted Agent permission profile id only (never transient approvals). */
  agentProfile: AgentProfileId;
  /** Reasoning level per provider/model and manual output maxima. */
  generation: GenerationSettings;
  /** Interface language of the view only; text sent to models stays English. */
  language: ViewLanguage;
}

export type ViewLanguage = 'en' | 'es';

/** What the system lets a terminal command do: `total` = no isolation, `project` = writes only in the project and temporary folders, `closed` = that and no network. */
export type CommandIsolation = 'total' | 'project' | 'closed';

export function parseCommandIsolation(value: unknown): CommandIsolation {
  return value === 'total' || value === 'closed' ? value : 'project';
}

export interface JobSettings {
  enabled: boolean;
  /** `null`: jobs run on this computer with the user's permissions. */
  container: JobContainerSettings | null;
}

function parseJobs(raw: unknown): JobSettings {
  if (!isRecord(raw)) {
    return { enabled: false, container: null };
  }
  const container = raw.container == null ? null : validateContainerSettings(raw.container);
  return { enabled: raw.enabled === true, container: container !== null && container.ok ? container.settings : null };
}

export interface ExternalLocalChoice {
  /** '' = send the configured local model id. */
  model: string;
  kind: 'ollama' | 'lmstudio' | 'llama-server' | 'openai-compatible' | '';
  /** Tool calls: what the server said; null when it did not say. */
  tools: boolean | null;
  context: number | null;
  /** The user confirmed sending local work to this server on another computer of the private network. */
  lan: boolean;
}

export interface WebSettings {
  enabled: boolean;
  search: 'duckduckgo' | 'searxng';
  /** Base URL of the user's SearXNG instance (JSON API enabled). */
  searxngUrl: string;
}

export const EMPTY_EXTERNAL_LOCAL: ExternalLocalChoice = { model: '', kind: '', tools: null, context: null, lan: false };
export const DEFAULT_WEB: WebSettings = { enabled: false, search: 'duckduckgo', searxngUrl: '' };

function parseExternalLocal(raw: unknown): ExternalLocalChoice {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const kinds = ['ollama', 'lmstudio', 'llama-server', 'openai-compatible'];
  return {
    model: typeof v.model === 'string' && /^[\w.:@/+-]{0,200}$/.test(v.model) ? v.model : '',
    kind: typeof v.kind === 'string' && kinds.includes(v.kind) ? (v.kind as ExternalLocalChoice['kind']) : '',
    tools: typeof v.tools === 'boolean' ? v.tools : null,
    context: typeof v.context === 'number' && Number.isInteger(v.context) && v.context > 0 && v.context <= 10_000_000 ? v.context : null,
    lan: v.lan === true,
  };
}

function parseWeb(raw: unknown): WebSettings {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    enabled: v.enabled === true,
    search: v.search === 'searxng' ? 'searxng' : 'duckduckgo',
    searxngUrl: typeof v.searxngUrl === 'string' && v.searxngUrl.length <= 512 ? v.searxngUrl : '',
  };
}

export function isViewLanguage(value: unknown): value is ViewLanguage {
  return value === 'en' || value === 'es';
}

function defaultLocal(): LocalRuntimeSettings {
  return {
    executablePath: '',
    modelPath: '',
    projectorPath: '',
    draftModelPath: '',
    modelId: 'local-glimmer',
    contextSize: 32768,
    port: 8775,
    idleTimeoutSec: 900,
  };
}

/** Safe defaults: cloud provider, Agent mode, escalation OFF, Ask profile. */
export function defaultSettings(): RameSettings {
  return {
    version: SETTINGS_VERSION,
    provider: 'cloud',
    mode: DEFAULT_CHAT_MODE,
    model: 'muse-spark-1.3',
    cloudModel: 'muse-spark-1.3',
    cloudCatalogSource: 'fallback',
    local: defaultLocal(),
    externalLocalEndpoint: '',
    externalLocal: { ...EMPTY_EXTERNAL_LOCAL },
    web: { ...DEFAULT_WEB },
    shell: { enabled: false, isolation: 'project' },
    jobs: { enabled: false, container: null },
    installs: { enabled: true, auto: false },
    localLimits: {},
    allowCloudEscalation: false,
    advisorModel: DEFAULT_ADVISOR,
    agentProfile: DEFAULT_AGENT_PROFILE,
    generation: defaultGenerationSettings(),
    language: 'en',
  };
}

/** Machine-detected starting values, offered as suggestions only. */
export function suggestedLocalSettings(): LocalRuntimeSettings {
  return { ...LOCAL_RUNTIME_SUGGESTIONS };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUsage(value: unknown): value is ProviderUsage {
  if (!isRecord(value)) {
    return false;
  }
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cachedTokens',
    'totalTokens',
  ]) {
    const entry = value[key];
    if (
      typeof entry !== 'number' ||
      !Number.isFinite(entry) ||
      entry < 0 ||
      entry > Number.MAX_SAFE_INTEGER
    ) {
      return false;
    }
  }
  return true;
}

export interface UsageTotals {
  cloud: ProviderUsage;
  local: ProviderUsage;
}

export function defaultUsageTotals(): UsageTotals {
  return { cloud: { ...EMPTY_USAGE }, local: { ...EMPTY_USAGE } };
}

/** Validate untrusted persisted usage totals; invalid entries become zero. */
export function validateUsageTotals(value: unknown): UsageTotals {
  if (!isRecord(value)) {
    return defaultUsageTotals();
  }
  return {
    cloud: isUsage(value.cloud) ? value.cloud : { ...EMPTY_USAGE },
    local: isUsage(value.local) ? value.local : { ...EMPTY_USAGE },
  };
}

/**
 * Validate untrusted persisted settings into safe defaults. Unknown fields
 * are dropped; an invalid provider/mode falls back to cloud/Chat; invalid
 * local settings fall back to blank defaults (suggestions are never forced
 * in); escalation defaults to OFF unless explicitly `true`. An invalid or
 * arbitrary cloud model falls back to `muse-spark-1.3`.
 */
export function validateSettings(value: unknown): RameSettings {
  const fallback = defaultSettings();
  if (!isRecord(value)) {
    return fallback;
  }
  // A persisted provider-level `runtime` id wins when present; legacy
  // `cloud:<model>` / `local:<model>` values migrate to their provider.
  // Otherwise fall back to the legacy provider field.
  const rawRuntime = (value as Record<string, unknown>).runtime;
  let runtime = parseRuntimeId(rawRuntime);
  if (runtime === null && rawRuntime === 'cloud:muse-spark-1.3') {
    runtime = RUNTIME_CLOUD_ID;
  } else if (runtime === null && rawRuntime === 'local:local-glimmer') {
    runtime = RUNTIME_LOCAL_ID;
  }
  const provider: ProviderId =
    runtime !== null
      ? runtimeToProvider(runtime)
      : value.provider === 'local'
        ? 'local'
        : 'cloud';
  const mode: ChatModeId =
    value.mode === MISSION_MODE_ID
      ? MISSION_MODE_ID
      : value.mode === AGENT_MODE_ID
        ? AGENT_MODE_ID
        : value.mode === 'chat'
          ? 'chat'
          : DEFAULT_CHAT_MODE;
  // The cloud model is a validated subordinate selection; arbitrary or
  // mismatched stored values fall back safely. Legacy `model` is honored
  // only when it is itself a compatible cloud id.
  const cloudModel = validateStoredCloudModel(value.cloudModel ?? value.model);
  const model = provider === 'local' ? 'local-glimmer' : cloudModel;
  void fallback;
  const checkedLocal = validateLocalSettings(value.local);
  let local = checkedLocal.ok && checkedLocal.settings
    ? checkedLocal.settings
    : defaultLocal();
  // v1 used ten minutes as its default. Migrate only that exact old default;
  // once saved as v2, an explicit ten-minute choice remains ten minutes.
  if (value.version === 1 && local.idleTimeoutSec === 600) {
    local = { ...local, idleTimeoutSec: 900 };
  }
  const externalLocalEndpoint =
    typeof value.externalLocalEndpoint === 'string'
      ? value.externalLocalEndpoint.slice(0, 512)
      : '';
  const cloudCatalogSource =
    value.cloudCatalogSource === 'live' ? 'live' : 'fallback';
  return {
    version: SETTINGS_VERSION,
    provider,
    mode,
    model,
    cloudModel,
    cloudCatalogSource,
    local,
    externalLocalEndpoint,
    externalLocal: parseExternalLocal(value.externalLocal),
    web: parseWeb(value.web),
    shell: { enabled: isRecord(value.shell) && value.shell.enabled === true, isolation: parseCommandIsolation(isRecord(value.shell) ? value.shell.isolation : undefined) },
    jobs: parseJobs(value.jobs),
    installs: { enabled: !(isRecord(value.installs) && value.installs.enabled === false), auto: isRecord(value.installs) && value.installs.auto === true },
    localLimits: parseLimitsByModel(value.localLimits),
    allowCloudEscalation: value.allowCloudEscalation === true,
    advisorModel: parseAdvisorModel(value.advisorModel) ?? legacyAdvisor(cloudModel),
    agentProfile: parseAgentProfile(value.agentProfile),
    generation: validateGenerationSettings(value.generation),
    language: isViewLanguage(value.language) ? value.language : 'en',
  };
}

function validateStoredCloudModel(value: unknown): string {
  if (typeof value !== 'string') {
    return 'muse-spark-1.3';
  }
  const id = value.trim();
  if (id.length === 0 || id.length > 128) {
    return 'muse-spark-1.3';
  }
  if (!/^muse-(spark|wonder)-[A-Za-z0-9._-]+$/.test(id)) {
    return 'muse-spark-1.3';
  }
  return id;
}
