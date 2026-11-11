/**
 * Autonomy & Permissions: what the user pre-authorized, per workspace and
 * execution environment, so that some operations run without a card.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Three modes, per workspace and environment (never inherited by another
 * project, computer or Remote SSH server), independent of the Agent's tool
 * profile (choosing Workspace full never turns any of them on):
 *   - `ask` (default): every Meta consultation and every action that needs
 *     an authorization shows its card;
 *   - `supervised`: separate, bounded, expiring pre-authorizations for Meta
 *     consultations in Missions, for web budgets in autonomous Missions, and
 *     for web searches and page reads in Agent and Chat;
 *   - `full` (Full Access): on top of those, the parts the user chose
 *     (files, tests, terminal commands, installs, long jobs, web) run
 *     without their cards. It never bypasses the operating system's
 *     permissions (a command that elevates privileges shows its card), the
 *     provider's permissions, protected files, the verifier's files and
 *     acceptance check, the Mission's authorization card, project memory
 *     (always a card) or the time and output limits of each tool.
 * Each one is given only by the user, through the view and a modal
 * confirmation of the host, never by the model. Each has a random id and is
 * bound to the user, the environment and the workspace (Meta: also the
 * provider, the model and the key revision). Revoking one, or giving a new
 * one, makes every earlier binding invalid. The host checks all of it right
 * before each operation, reading the stored policy afresh.
 */

import { randomBytes } from 'node:crypto';

export const AUTONOMY_STATE_KEY = 'rameCode.autonomy.v1';
export type AutonomyMode = 'ask' | 'supervised' | 'full';
export const META_PROVIDER = 'Meta Model API';
export const VALIDITY_HOURS: readonly number[] = [1, 8, 24, 168, 720];
/** Full Access may also last until the user turns it off (0 hours): stored as the last instant a Date can hold, so every expiry check still applies. */
export const FULL_VALIDITY_HOURS: readonly number[] = [0, ...VALIDITY_HOURS];
export const UNTIL_TURNED_OFF = 8_640_000_000_000_000;
export const untilTurnedOff = (at: number): boolean => at >= UNTIL_TURNED_OFF;
export const MAX_SCOPED_FILES = 3;
export const MAX_FRAGMENT_LINES = 400;
export const MAX_LOG_ENTRIES = 200;
export const SESSION_WEB_MAX_SEARCHES = 20;
export const SESSION_WEB_MAX_FETCHES = 40;
/** What a Meta pre-authorization may allow per Mission; null = no count limit (the byte and token limits remain). */
export const META_MAX_CHOICES: ReadonlyArray<number | null> = [1, 5, 10, 100, 1000, null];
/** What a Mission's card may choose; -1 = no count limit (within the pre-authorization). */
export const MISSION_CONSULT_CHOICES: readonly number[] = [0, 1, 2, 3, 4, 5, 10, 100, 1000, -1];
export const MAX_FINITE_CONSULTATIONS = 1000;
/** A total of remote tokens for every Mission under one pre-authorization; null = only each Mission's own limits. */
export const META_TOKEN_BUDGETS: ReadonlyArray<number | null> = [null, 100_000, 1_000_000, 10_000_000];
const MAX_FOUND_URLS = 200;
const MAX_FULL_JOBS = 50;

/**
 * The parts of Full Access. `meta`: Agent's advice after the main model stops and a
 * Mission's acceptance review are sent without their card, only within the
 * Meta pre-authorization in force (provider, model, key, data scope, counts
 * and token budget); without one it allows nothing.
 */
export const FULL_TOOLS = ['files', 'tests', 'commands', 'installs', 'jobs', 'web', 'meta'] as const;
export type FullTool = (typeof FULL_TOOLS)[number];
export type FullTools = Record<FullTool, boolean>;

/** Where a grant applies: the environment's id and how the user saw it. */
interface Bound {
  id: string;
  /** The operating-system user who gave it. */
  user: string;
  envId: string;
  envLabel: string;
  scopeId: string;
  grantedAt: number;
  expiresAt: number;
}

export interface MetaPreauth extends Bound {
  project: string;
  provider: typeof META_PROVIDER;
  model: string;
  /** Revision of the stored Meta API key: a new key never inherits it. */
  credentialRevision: string;
  /** The most a Mission may be given; null = no count limit. Each Mission's card chooses 0 to this. */
  maxPerMission: number | null;
  /** `instructions`: the Mission's text and the host's notes; `files`: also files chosen on each Mission's card. */
  dataScope: 'instructions' | 'files';
  /** Remote tokens all its Missions may use together; null = only each Mission's limits. */
  tokenBudget: number | null;
  usedTokens: number;
  /** Consultations sent under Full Access outside a Mission's own escalation, by Agent conversation or Mission: each within `maxPerMission`. */
  adviceUses: Record<string, number>;
  /** Given with Full Access (its Meta part, one confirmation): revoked and replaced with that grant. */
  fullId?: string;
}

/** Permission to give autonomous Missions of this workspace a web budget. */
export type MissionWebPreauth = Bound;

/** Web searches and page reads for Agent and Chat, shared by every window of this workspace and environment. */
export interface AgentWebPreauth extends Bound {
  project: string;
  maxSearches: number;
  maxFetches: number;
  searches: number;
  fetches: number;
  domains: string[];
  /** URLs its searches returned: the only pages it may read when no domain is listed. */
  found: string[];
}

/** Full Access: the parts the user chose run without their cards. */
export interface FullAccess extends Bound {
  project: string;
  tools: FullTools;
  /**
   * Meta as the main model (its own choice, apart from the tool parts): an
   * Agent run with this exact Meta model and API key sends its request and
   * its tools' results without the disclosure card. Null (or absent, in a
   * grant stored before it existed): not included, the card stays.
   */
  mainModel?: { model: string; credentialRevision: string } | null;
  /** Long jobs started under it, stopped when it is revoked (from any window, also after a reload). */
  jobs: string[];
}

export type ExternalApproval = 'card' | 'pre-authorized' | 'mission-grant' | 'profile' | 'full-access';

/** One request that left this computer, recorded before it was sent. */
export interface ExternalEntry {
  id: string;
  at: number;
  provider: string;
  destination: string;
  reason: string;
  /** What was sent, in words (never the content itself). */
  data: string;
  approval: ExternalApproval;
  preauthId: string | null;
  missionId: string | null;
  bytes: number | null;
  outcome: string;
}

export interface WorkspaceAutonomy {
  mode: AutonomyMode;
  meta: MetaPreauth | null;
  missionWeb: MissionWebPreauth | null;
  agentWeb: AgentWebPreauth | null;
  full: FullAccess | null;
  log: ExternalEntry[];
}

/** A file or fragment a Mission's card allows Meta to receive. */
export interface ScopedFile {
  path: string;
  start?: number;
  end?: number;
}

/** What a Mission's escalation was authorized under. */
export interface MetaBinding {
  preauthId: string;
  user: string;
  scopeId: string;
  envId?: string;
  provider: typeof META_PROVIDER;
  model: string;
  credentialRevision: string;
  expiresAt: number;
  files: ScopedFile[];
}

export const emptyAutonomy = (): WorkspaceAutonomy => ({ mode: 'ask', meta: null, missionWeb: null, agentWeb: null, full: null, log: [] });

export const newPreauthId = (): string => `pre_${randomBytes(8).toString('hex')}`;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const ID = /^pre_[0-9a-f]{16}$/;
const ENV = /^env_[0-9a-f]{16}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The common part of every grant, or null when it is not one of this workspace and environment. */
function parseBound(raw: unknown, scopeId: string, envId: string): Bound | null {
  if (
    !isRecord(raw) || typeof raw.id !== 'string' || !ID.test(raw.id) || !str(raw.user, 128) || raw.scopeId !== scopeId ||
    typeof raw.envId !== 'string' || !ENV.test(raw.envId) || raw.envId !== envId || !str(raw.envLabel, 300) ||
    !time(raw.grantedAt) || !time(raw.expiresAt) || raw.expiresAt <= raw.grantedAt
  ) {
    return null;
  }
  return { id: raw.id, user: raw.user, envId: raw.envId, envLabel: raw.envLabel, scopeId, grantedAt: raw.grantedAt, expiresAt: raw.expiresAt };
}

/** Conversations and Missions whose Full Access consultations are counted (the oldest are forgotten first). */
export const MAX_ADVICE_KEYS = 64;
/** A blocked Mission is retried with Meta's advice under Full Access at most this many times in a row (then it waits for the user). */
export const MAX_AUTO_RETRIES = 3;

export const isMetaMax = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_FINITE_CONSULTATIONS);

function parseMeta(raw: unknown, scopeId: string, envId: string): MetaPreauth | null {
  const bound = parseBound(raw, scopeId, envId);
  if (
    bound === null || !isRecord(raw) || typeof raw.project !== 'string' || raw.provider !== META_PROVIDER || !str(raw.model, 128) || !str(raw.credentialRevision, 64) ||
    !isMetaMax(raw.maxPerMission) || (raw.dataScope !== 'instructions' && raw.dataScope !== 'files') ||
    !(raw.tokenBudget === null || (time(raw.tokenBudget) && raw.tokenBudget > 0)) || !time(raw.usedTokens) ||
    !(raw.adviceUses === undefined || (isRecord(raw.adviceUses) && Object.keys(raw.adviceUses).length <= MAX_ADVICE_KEYS && Object.entries(raw.adviceUses).every(([key, used]) => key.length > 0 && key.length <= 64 && time(used) && used <= MAX_FINITE_CONSULTATIONS)))
  ) {
    return null;
  }
  return {
    ...bound, project: raw.project.slice(0, 200), provider: META_PROVIDER, model: raw.model, credentialRevision: raw.credentialRevision,
    maxPerMission: raw.maxPerMission, dataScope: raw.dataScope, tokenBudget: raw.tokenBudget, usedTokens: raw.usedTokens,
    adviceUses: { ...((raw.adviceUses as Record<string, number> | undefined) ?? {}) },
    ...(typeof raw.fullId === 'string' && ID.test(raw.fullId) ? { fullId: raw.fullId } : {}),
  };
}

function parseAgentWeb(raw: unknown, scopeId: string, envId: string): AgentWebPreauth | null {
  const bound = parseBound(raw, scopeId, envId);
  const count = (value: unknown, max: number) => time(value) && value <= max;
  if (
    bound === null || !isRecord(raw) || typeof raw.project !== 'string' ||
    !count(raw.maxSearches, SESSION_WEB_MAX_SEARCHES) || !count(raw.maxFetches, SESSION_WEB_MAX_FETCHES) ||
    !count(raw.searches, raw.maxSearches as number) || !count(raw.fetches, raw.maxFetches as number) ||
    !Array.isArray(raw.domains) || raw.domains.length > 10 || !raw.domains.every((domain) => typeof domain === 'string' && DOMAIN.test(domain)) ||
    !Array.isArray(raw.found) || !raw.found.every((url) => typeof url === 'string' && url.length <= 2048)
  ) {
    return null;
  }
  return {
    ...bound, project: raw.project.slice(0, 200), maxSearches: raw.maxSearches as number, maxFetches: raw.maxFetches as number, searches: raw.searches as number, fetches: raw.fetches as number,
    domains: [...(raw.domains as string[])], found: (raw.found as string[]).slice(-MAX_FOUND_URLS),
  };
}

function parseFull(raw: unknown, scopeId: string, envId: string): FullAccess | null {
  const bound = parseBound(raw, scopeId, envId);
  if (bound === null || !isRecord(raw) || typeof raw.project !== 'string' || !isRecord(raw.tools) || !Array.isArray(raw.jobs)) {
    return null;
  }
  const tools = raw.tools;
  const main = raw.mainModel === undefined || raw.mainModel === null ? null : parseMainModel(raw.mainModel);
  if (main === undefined || Object.keys(tools).length !== FULL_TOOLS.length || !FULL_TOOLS.every((name) => typeof tools[name] === 'boolean') || (!FULL_TOOLS.some((name) => tools[name] === true) && main === null)) {
    return null;
  }
  if (!raw.jobs.every((job) => typeof job === 'string' && job.length <= 64)) {
    return null;
  }
  return { ...bound, project: raw.project.slice(0, 200), tools: Object.fromEntries(FULL_TOOLS.map((name) => [name, tools[name] === true])) as FullTools, jobs: (raw.jobs as string[]).slice(-MAX_FULL_JOBS), mainModel: main };
}

/** A stored "Meta as the main model" part; undefined when it is malformed (the whole grant is then refused). */
function parseMainModel(raw: unknown): { model: string; credentialRevision: string } | undefined {
  return isRecord(raw) && Object.keys(raw).length === 2 && typeof raw.model === 'string' && /^muse-[A-Za-z0-9._-]{1,120}$/.test(raw.model) && typeof raw.credentialRevision === 'string' && raw.credentialRevision.length > 0 && raw.credentialRevision.length <= 64
    ? { model: raw.model, credentialRevision: raw.credentialRevision }
    : undefined;
}

function parseEntry(raw: unknown): ExternalEntry | null {
  if (!isRecord(raw) || !str(raw.id, 40) || !time(raw.at)) {
    return null;
  }
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');
  const approval: ExternalApproval = (['card', 'pre-authorized', 'mission-grant', 'profile', 'full-access'] as const).find((known) => known === raw.approval) ?? 'card';
  return {
    id: raw.id, at: raw.at, provider: text(raw.provider, 80), destination: text(raw.destination, 200), reason: text(raw.reason, 300), data: text(raw.data, 400), approval,
    preauthId: typeof raw.preauthId === 'string' && ID.test(raw.preauthId) ? raw.preauthId : null,
    missionId: typeof raw.missionId === 'string' && raw.missionId.length <= 64 ? raw.missionId : null,
    bytes: time(raw.bytes) ? raw.bytes : null,
    outcome: text(raw.outcome, 300),
  };
}

/**
 * The stored policy of one workspace in one environment. Anything
 * malformed, or given in another environment, is dropped to the safe side:
 * no pre-authorization, mode `ask`. `full` without its grant reads as
 * `supervised`.
 */
export function parseWorkspaceAutonomy(raw: unknown, scopeId: string, envId: string): WorkspaceAutonomy {
  if (!isRecord(raw)) {
    return emptyAutonomy();
  }
  const log = Array.isArray(raw.log) ? raw.log.slice(-MAX_LOG_ENTRIES).map(parseEntry).filter((entry): entry is ExternalEntry => entry !== null) : [];
  const open = raw.mode === 'supervised' || raw.mode === 'full';
  const full = raw.mode === 'full' ? parseFull(raw.full, scopeId, envId) : null;
  return {
    mode: full !== null ? 'full' : open ? 'supervised' : 'ask',
    meta: open ? parseMeta(raw.meta, scopeId, envId) : null,
    missionWeb: open ? parseBound(raw.missionWeb, scopeId, envId) : null,
    agentWeb: open ? parseAgentWeb(raw.agentWeb, scopeId, envId) : null,
    full,
    log,
  };
}

/** What every check knows about the moment of the operation. */
export interface GrantContext {
  now: number;
  user: string;
  scopeId: string;
  envId: string;
}

/** Why a grant does not apply in this context, or null. */
function boundRefusal(grant: Bound, ctx: GrantContext, what: string): string | null {
  if (grant.scopeId !== ctx.scopeId) {
    return `the ${what} was given for another workspace`;
  }
  if (ctx.now >= grant.expiresAt) {
    return `the ${what} expired at ${new Date(grant.expiresAt).toISOString()}`;
  }
  if (grant.envId !== ctx.envId) {
    return `the ${what} was given on another computer or server (${grant.envLabel})`;
  }
  if (grant.user !== ctx.user) {
    return `the ${what} was given by another user of this computer`;
  }
  return null;
}

/** Everything the host knows at the moment of a Meta request. */
export interface MetaContext extends GrantContext {
  /** The advisor model a consultation would go to now (advisorHost.ts). */
  model: string;
  credentialRevision: string;
  cloudEscalation: boolean;
}

/**
 * Why no Meta consultation may be sent without a card now, or null. With a
 * binding, also checks that the Mission was authorized under this very
 * pre-authorization and that its files stay within its scope.
 */
export function metaRefusal(policy: WorkspaceAutonomy, binding: MetaBinding | null, ctx: MetaContext): string | null {
  const meta = policy.meta;
  if (policy.mode === 'ask') {
    return 'Autonomy & Permissions is set to Ask always for this workspace';
  }
  if (meta === null) {
    return 'no Meta pre-authorization is in force for this workspace (never given, revoked or replaced)';
  }
  const bound = boundRefusal(meta, ctx, 'Meta pre-authorization');
  if (bound !== null) {
    return bound;
  }
  if (meta.credentialRevision !== ctx.credentialRevision) {
    return 'the Meta API key changed after the pre-authorization was given';
  }
  if (meta.model !== ctx.model) {
    return `the pre-authorization covers Meta ${meta.model}, and the advisor model now is ${ctx.model || 'none'}`;
  }
  if (!ctx.cloudEscalation) {
    return 'cloud escalation is OFF in Settings';
  }
  if (meta.tokenBudget !== null && meta.usedTokens >= meta.tokenBudget) {
    return `the pre-authorization's budget of ${meta.tokenBudget} remote tokens is used up`;
  }
  if (binding !== null) {
    if (binding.preauthId !== meta.id) {
      return 'this Mission was authorized under an earlier pre-authorization that was revoked or replaced';
    }
    if (binding.scopeId !== meta.scopeId || binding.user !== meta.user || binding.model !== meta.model || binding.provider !== meta.provider || binding.credentialRevision !== meta.credentialRevision || (binding.envId !== undefined && binding.envId !== meta.envId)) {
      return 'this Mission was authorized for another workspace, computer, user, provider, model or key';
    }
    if (binding.files.length > 0 && meta.dataScope !== 'files') {
      return 'the pre-authorization covers only the Mission instructions, not files';
    }
  }
  return null;
}

/** A Mission's count as the pre-authorization sees it: within it, or why not. */
export function missionCountRefusal(meta: MetaPreauth, maxConsultations: number | null): string | null {
  if (meta.maxPerMission === null) {
    return null;
  }
  return maxConsultations === null || maxConsultations > meta.maxPerMission ? `The Meta pre-authorization allows at most ${meta.maxPerMission} consultation(s) per Mission.` : null;
}

/** Why Full Access does not cover `tool` now, or null. */
export function fullRefusal(policy: WorkspaceAutonomy, ctx: GrantContext, tool: FullTool): string | null {
  const full = policy.full;
  if (policy.mode !== 'full' || full === null) {
    return 'Full Access is not on for this workspace';
  }
  const bound = boundRefusal(full, ctx, 'Full Access');
  if (bound !== null) {
    return bound;
  }
  return full.tools[tool] ? null : `Full Access does not include ${FULL_TOOL_WORDS[tool]}`;
}

/**
 * Why Full Access does not let an Agent run with Meta as the main model go
 * without the disclosure card now (null when it does): it must include that
 * part, for this very Meta model and API key, in this workspace and
 * environment, and be in force. Its tool parts never do.
 */
export function fullMainModelRefusal(policy: WorkspaceAutonomy, ctx: GrantContext, now: { model: string; credentialRevision: string }): string | null {
  const full = policy.full;
  if (policy.mode !== 'full' || full === null) {
    return 'Full Access is not on for this workspace';
  }
  const bound = boundRefusal(full, ctx, 'Full Access');
  if (bound !== null) {
    return bound;
  }
  const main = full.mainModel ?? null;
  if (main === null) {
    return 'Full Access does not include Meta as the main model (its other parts authorize local tools only)';
  }
  if (main.model !== now.model) {
    return `Full Access covers Meta ${main.model} as the main model, and the main model now is ${now.model}`;
  }
  return main.credentialRevision === now.credentialRevision ? null : 'Full Access was given for another Meta API key';
}

/** What a consultation sent under Full Access needs of the Meta pre-authorization. */
export interface FullMetaNeed {
  /** `files`: it carries project files (the acceptance review's test fragments). */
  dataScope: 'instructions' | 'files';
  /** Agent's advice: the conversation (or Mission) whose consultations are counted against `maxPerMission`. */
  key?: string;
  /** The acceptance review: the count the user chose for it, which must fit `maxPerMission` (null = no count limit). */
  count?: number | null;
}

/**
 * Why a Meta consultation outside a Mission's own escalation may not be sent
 * without its card now, or null: Full Access must include Meta, and the Meta
 * pre-authorization in force must cover this provider, model, key,
 * environment, data scope, count and token budget.
 */
export function fullMetaRefusal(policy: WorkspaceAutonomy, ctx: MetaContext, need: FullMetaNeed): string | null {
  const full = fullRefusal(policy, ctx, 'meta');
  if (full !== null) {
    return full;
  }
  const meta = metaRefusal(policy, null, ctx);
  if (meta !== null || policy.meta === null) {
    return meta ?? 'no Meta pre-authorization is in force for this workspace';
  }
  if (need.dataScope === 'files' && policy.meta.dataScope !== 'files') {
    return 'the Meta pre-authorization covers only instructions and the host\'s notes, not project files';
  }
  if (need.count !== undefined) {
    const over = missionCountRefusal(policy.meta, need.count);
    if (over !== null) {
      return over.replace(/\.$/, '');
    }
  }
  if (need.key !== undefined && policy.meta.maxPerMission !== null && (policy.meta.adviceUses[need.key] ?? 0) >= policy.meta.maxPerMission) {
    return `the Meta pre-authorization allows at most ${policy.meta.maxPerMission} consultation(s) per Mission or Agent conversation, and this one has used them`;
  }
  return null;
}

/** Why web budgets for autonomous Missions are not pre-authorized now, or null; Full Access with web counts as one. */
export function missionWebRefusal(policy: WorkspaceAutonomy, preauthId: string | null, ctx: GrantContext): string | null {
  const none = 'web budgets for autonomous Missions are not pre-authorized for this workspace (Autonomy & Permissions)';
  if (policy.mode === 'ask') {
    return none;
  }
  const web = policy.missionWeb;
  const what = 'web pre-authorization for Missions';
  const fullId = fullRefusal(policy, ctx, 'web') === null ? (policy.full?.id ?? null) : null;
  const webId = web !== null && boundRefusal(web, ctx, what) === null ? web.id : null;
  if (preauthId === null) {
    return fullId !== null || webId !== null ? null : web !== null ? boundRefusal(web, ctx, what) : none;
  }
  if (preauthId === fullId || preauthId === webId) {
    return null;
  }
  if (web !== null && preauthId === web.id) {
    return boundRefusal(web, ctx, what);
  }
  if (policy.full !== null && preauthId === policy.full.id) {
    return fullRefusal(policy, ctx, 'web');
  }
  return 'this Mission was authorized under an earlier web pre-authorization that was revoked or replaced';
}

/** The id an autonomous Mission's web budget is bound to now: the Missions web pre-authorization, or Full Access with web. */
export function missionWebGrantId(policy: WorkspaceAutonomy, ctx: GrantContext): string | null {
  if (policy.missionWeb !== null && policy.mode !== 'ask' && boundRefusal(policy.missionWeb, ctx, 'web') === null) {
    return policy.missionWeb.id;
  }
  return fullRefusal(policy, ctx, 'web') === null ? (policy.full?.id ?? null) : null;
}

/**
 * A web call of Agent or Chat the host is about to make: which grant lets
 * it through without a card, or null (it shows its card). Under the Agent
 * and Chat web pre-authorization it consumes one slot of `policy`, which
 * the caller changes inside the store's queued, exclusive update, so two
 * calls, from any windows, never share a slot.
 */
export function useAgentWeb(
  policy: WorkspaceAutonomy,
  request: { tool: 'web_search' | 'web_fetch'; queryRefusal: string | null; host: string; url: string },
  ctx: GrantContext,
  domainAllowed: (host: string, domains: readonly string[]) => boolean,
): { approval: 'full-access' | 'pre-authorized'; id: string } | null {
  // Full Access with web asks nothing: what must never leave is removed (a query) or refused (an address) when the call runs.
  if (fullRefusal(policy, ctx, 'web') === null && policy.full !== null) {
    return { approval: 'full-access', id: policy.full.id };
  }
  if (request.queryRefusal !== null) {
    return null;
  }
  const grant = policy.agentWeb;
  if (policy.mode === 'ask' || grant === null || boundRefusal(grant, ctx, 'web pre-authorization') !== null) {
    return null;
  }
  if (request.tool === 'web_search') {
    if (grant.searches >= grant.maxSearches) {
      return null;
    }
    grant.searches += 1;
    return { approval: 'pre-authorized', id: grant.id };
  }
  const readable = grant.domains.length > 0 ? domainAllowed(request.host, grant.domains) : grant.found.includes(request.url);
  if (!readable || grant.fetches >= grant.maxFetches) {
    return null;
  }
  grant.fetches += 1;
  return { approval: 'pre-authorized', id: grant.id };
}

/** Parse what a Mission's card lists: `path` or `path:10-80`; at most 3, no duplicates. */
export function parseScopedFiles(raw: readonly string[]): { ok: true; files: ScopedFile[] } | { ok: false; error: string } {
  const files: ScopedFile[] = [];
  for (const entry of raw.map((value) => value.trim()).filter((value) => value.length > 0)) {
    const match = /^(.+?)(?::(\d{1,6})-(\d{1,6}))?$/.exec(entry);
    const file = match?.[1]?.replace(/\\/g, '/').replace(/^\.\//, '') ?? '';
    if (file.length === 0 || file.length > 512) {
      return { ok: false, error: `"${entry.slice(0, 80)}" is not a project path.` };
    }
    const start = match?.[2] === undefined ? undefined : Number(match[2]);
    const end = match?.[3] === undefined ? undefined : Number(match[3]);
    if (start !== undefined && end !== undefined && (start < 1 || end < start || end - start + 1 > MAX_FRAGMENT_LINES)) {
      return { ok: false, error: `The fragment ${entry.slice(0, 80)} must be lines from 1 on, at most ${MAX_FRAGMENT_LINES} of them.` };
    }
    if (files.some((known) => known.path === file && known.start === start)) {
      continue;
    }
    files.push({ path: file, ...(start !== undefined && end !== undefined ? { start, end } : {}) });
  }
  if (files.length > MAX_SCOPED_FILES) {
    return { ok: false, error: `At most ${MAX_SCOPED_FILES} files or fragments can be given to Meta.` };
  }
  return { ok: true, files };
}

export const describeScopedFile = (file: ScopedFile): string => (file.start !== undefined ? `${file.path}:${file.start}-${file.end}` : file.path);

/** A stored binding; null when absent, undefined when malformed (the whole grant is refused). */
export function parseMetaBinding(raw: unknown): MetaBinding | null | undefined {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (
    !isRecord(raw) || typeof raw.preauthId !== 'string' || !ID.test(raw.preauthId) || !str(raw.user, 128) || !str(raw.scopeId, 200) ||
    raw.provider !== META_PROVIDER || !str(raw.model, 128) || !str(raw.credentialRevision, 64) || !time(raw.expiresAt) || !Array.isArray(raw.files) || raw.files.length > MAX_SCOPED_FILES ||
    (raw.envId !== undefined && (typeof raw.envId !== 'string' || !ENV.test(raw.envId)))
  ) {
    return undefined;
  }
  const files: ScopedFile[] = [];
  for (const file of raw.files as unknown[]) {
    if (!isRecord(file) || !str(file.path, 512)) {
      return undefined;
    }
    const range = file.start !== undefined || file.end !== undefined;
    if (range && (!time(file.start) || !time(file.end) || file.start < 1 || file.end < file.start)) {
      return undefined;
    }
    files.push({ path: file.path, ...(range ? { start: file.start as number, end: file.end as number } : {}) });
  }
  return {
    preauthId: raw.preauthId, user: raw.user, scopeId: raw.scopeId, ...(typeof raw.envId === 'string' ? { envId: raw.envId } : {}),
    provider: META_PROVIDER, model: raw.model, credentialRevision: raw.credentialRevision, expiresAt: raw.expiresAt, files,
  };
}

// ----- What the user reads before saying yes -----

const when = (at: number): string => new Date(at).toLocaleString();
const hours = (ms: number): string => (ms % 86_400_000 === 0 ? `${ms / 86_400_000} day(s)` : `${Math.round(ms / 3_600_000)} hour(s)`);
export const describeMetaMax = (max: number | null): string => (max === null ? 'no count limit' : `at most ${max}`);
const REVOKE = 'You can revoke it at any time in Settings → Security → Autonomy & Permissions, from any window of this workspace on this computer or server.';

/** The modal confirmation of a Meta pre-authorization: every point the user must know. */
export function metaConfirmation(input: {
  project: string; model: string; maxPerMission: number | null; validityMs: number; dataScope: 'instructions' | 'files'; now: number; env?: string; tokenBudget?: number | null;
}): { message: string; detail: string; action: string } {
  const budget = input.tokenBudget ?? null;
  return {
    message: `Allow RAME Code to consult Meta ${input.model} without asking each time, in the Missions of ${input.project}?`,
    detail: [
      `• Information leaves this computer: it is sent to ${META_PROVIDER} (Meta), model ${input.model}${input.env ? `, from ${input.env}` : ''}.`,
      input.dataScope === 'files'
        ? '• It can include code and fragments of project files: the Mission goal and instructions, the host\'s notes on the run, the failing check, project decisions, and the files or fragments you choose on each Mission\'s card.'
        : '• It can include code and fragments of project files quoted in the Mission goal and instructions, the host\'s notes on the run, the failing check and project decisions. No file is attached.',
      '• Never sent automatically: secrets or credentials, the verifier\'s hidden files, seeds, protected records, web pages. A consultation that would need more than this asks again with the exact text.',
      '• Consultations use your Meta API key and may be billed by Meta. RAME Code has no Meta price list, so it cannot cap the cost in money: it caps tokens.',
      input.maxPerMission === null
        ? '• No count limit per Mission: each Mission\'s card chooses how many (0 by default, or no count limit). Each consultation keeps its limits of bytes and tokens, and each Mission its totals.'
        : `• At most ${input.maxPerMission} consultation(s) per Mission (each Mission's card chooses 0 to ${input.maxPerMission}; 0 by default).`,
      budget === null ? '• No total token budget across Missions: each Mission\'s own byte and token limits apply.' : `• At most ${budget} remote tokens in total, across every Mission under this pre-authorization.`,
      '• Outside Missions it allows nothing by itself. Only if you also turn on Full Access with its Meta part, Agent\'s advice after the main model stops and the acceptance review use these same limits (per Agent conversation or Mission) without their card.',
      `• Valid for ${hours(input.validityMs)}, until ${when(input.now + input.validityMs)}, for this workspace, ${input.env ?? 'this computer'}, your user, this API key and this model only. Other projects, computers and servers do not inherit it.`,
      `• ${REVOKE} A consultation being sent is cancelled when possible; what was already sent cannot be taken back.`,
      '• RAME never switches the main model of a Mission: the advisor only advises, receives no tools, and the host\'s checks still decide.',
    ].join('\n'),
    action: 'Pre-authorize Meta',
  };
}

export function missionWebConfirmation(input: { project: string; validityMs: number; now: number; env?: string }): { message: string; detail: string; action: string } {
  return {
    message: `Allow autonomous Missions of ${input.project} to be given a web budget?`,
    detail: [
      '• Searches and page reads leave this computer to the search engine and the sites read, without a card for each one, within the budget each Mission\'s card sets.',
      '• Queries must be plain words: never code, keys, credentials or file paths. Nothing else is sent: no files, no Meta, no write, terminal or memory permission comes with it.',
      `• Valid for ${hours(input.validityMs)}, until ${when(input.now + input.validityMs)}, for this workspace, ${input.env ?? 'this computer'} and your user only.`,
      `• ${REVOKE}`,
    ].join('\n'),
    action: 'Pre-authorize web for Missions',
  };
}

export function sessionWebConfirmation(input: { project: string; maxSearches: number; maxFetches: number; domains: string[]; validityMs: number; now: number; env?: string }): { message: string; detail: string; action: string } {
  return {
    message: `Allow Agent and Chat in ${input.project} to search and read web pages without a card each time?`,
    detail: [
      `• Up to ${input.maxSearches} search(es) and ${input.maxFetches} page read(s) in total, shared by every window of this workspace on ${input.env ?? 'this computer'}, until ${when(input.now + input.validityMs)}.`,
      input.domains.length > 0
        ? `• Pages are read without a card only on ${input.domains.join(', ')}; any other page shows its card.`
        : '• Pages are read without a card only when one of these searches returned them; any other page shows its card.',
      '• A query is sent without a card only if it is plain words: code, keys, credentials, file paths or long quotes show the card (or are refused).',
      '• Only the query or the address leaves this computer: no file, no credential, no private information. Web access stays read-only (GET); nothing is published or changed.',
      `• ${REVOKE}`,
    ].join('\n'),
    action: 'Pre-authorize web searches',
  };
}

export const FULL_TOOL_WORDS: Readonly<Record<FullTool, string>> = {
  files: 'workspace file operations',
  tests: 'allowlisted tests',
  commands: 'terminal commands',
  installs: 'installs',
  jobs: 'long jobs',
  web: 'web searches and page reads',
  meta: 'Meta consultations when the main model cannot finish',
};

/** What Full Access tells the user before it is turned on: every point they asked to know. */
export function fullConfirmation(input: {
  project: string; env: string; tools: FullTools; validityMs: number; now: number;
  /** Whether each optional tool is turned on in Settings now. */
  enabled: { commands: boolean; installs: boolean; jobs: boolean; web: boolean };
  /** The Meta pre-authorization in force, in words, or null. */
  meta: string | null;
  /** Meta as the main model: the Meta model it covers, or null when not chosen. */
  mainModel?: string | null;
  /** The isolation level of terminal commands now (shellIsolation.ts). */
  isolation?: 'total' | 'project' | 'closed';
}): { message: string; detail: string; action: string } {
  const main = input.mainModel ?? null;
  const isolation = input.isolation === 'total'
    ? 'Their isolation level is Total: a command can change any file you can, use the network or start programs.'
    : input.isolation === 'closed'
      ? 'Their isolation level is Closed (Linux): writes only in the project, temporary and package-cache folders, and no network; where it cannot be applied a command does not run.'
      : 'Their isolation level is Project (Linux): writes only in the project, temporary and package-cache folders, network allowed; where it cannot be applied a command does not run.';
  const on = (tool: FullTool) => input.tools[tool];
  const offNote = (tool: 'commands' | 'installs' | 'jobs' | 'web') => (input.enabled[tool] ? '' : ' (the tool itself is OFF in Settings now; Full Access does not turn it on)');
  const lines = [
    `• Where: every operation runs on ${input.env}, in the folder of ${input.project}. Another computer, Remote SSH server, user or workspace does not inherit it.`,
    on('files')
      ? '• Files: Agent and Mission runs read, create, change, move and delete files of this workspace without a card. Protected files (.git, .env, keys, credentials), paths outside the workspace and the frozen files of a Mission\'s acceptance check stay refused.'
      : '• Files: not included; each write shows its card as the profile says.',
    on('tests') ? '• Tests: the allowlisted test scripts of package.json run without a card, with your user permissions.' : '• Tests: not included.',
    on('commands')
      ? `• Terminal commands: run without a card, in the project folder, with your user permissions and their time and output limits${offNote('commands')}. ${isolation} A command that elevates privileges (sudo, su, doas, pkexec, runas) or touches RAME Code's own state still shows its card; commands that can only destroy stay refused.`
      : '• Terminal commands: not included; each one shows its card.',
    on('installs')
      ? `• Installs: packages that need no administrator rights (npm without scripts, pip for your user, container images) are downloaded from their registry and installed without a card${offNote('installs')}. Installs that need administrator rights (apt, an elevated installer) still show their card.`
      : '• Installs: not included.',
    on('jobs') ? `• Long jobs: start without a card${offNote('jobs')}; they are stopped when you revoke Full Access.` : '• Long jobs: not included.',
    on('web')
      ? `• Internet: web searches and page reads (read-only) run without a card in Agent and Chat, and autonomous Missions may be given a web budget${offNote('web')}. A query may carry code, an error message or a file path; keys, tokens and passwords are removed from it, and your home and project folders hidden, before it leaves. A page whose address carries a key or a local path is not requested, and local or private addresses are refused. Publishing or changing anything online is not part of it.`
      : '• Internet: not included.',
    on('meta')
      ? `• Meta: when the main model cannot finish, RAME consults ${META_PROVIDER} without a card: Agent's advice after the main model stops, a blocked Mission's consultation (the Mission is then retried with the advice, at most ${MAX_AUTO_RETRIES} times) and a Mission's acceptance review; each Mission's card offers its consultations by default. All within: ${input.meta ?? 'none'}, given and revoked with Full Access. The advice carries the run's or the Mission's text and the host's notes, never a file; the acceptance review carries the test fragments you choose when you prepare it, only if the data scope includes files. Secrets are removed and local paths hidden first. A failed consultation is not retried by itself. Delegating a run to Spark (Meta running the tools) is not part of it.`
      : input.meta === null
        ? `• Meta: not included. ${main === null ? 'Nothing is sent to Meta under Full Access; consultations' : 'No consultation of the advisor is sent under Full Access; they'} need their own pre-authorization below, with its limits and data scope.`
        : `• Meta: not included outside Missions (Agent's advice and the acceptance review keep their cards). Missions keep their own pre-authorization: ${input.meta}.`,
    main !== null
      ? `• Meta as the main model: Agent runs with Meta ${main} in this workspace send, without the card that asks what may go to Meta, your request and the results of the tools ${main} uses (the content of the files it reads, test and command output, web pages it reads): that is how it works. Earlier local messages and project memory are not sent without their own card. Another Meta model or another API key needs a new authorization; Chat keeps its card.`
      : '• Meta as the main model: not included. An Agent run with Meta as the main model keeps the card that asks what may be sent to Meta.',
    `• Costs: Full Access itself costs nothing. ${main === null ? '' : `Every step of ${main} as the main model uses your API key and is billed by Meta, with no budget of this part (see Usage). `}${input.meta === null ? '' : 'Meta consultations use your API key and may be billed; RAME has no Meta price list, so the limit is the pre-authorization\'s tokens. '}Commands and installs may download content or use paid services you are signed in to.`,
    '• Never bypassed: your operating system\'s permissions, your providers\' permissions, project memory (always a card), the Mission authorization card, the verifier\'s hidden files and the acceptance check, each tool\'s time and output limits.',
    input.validityMs === 0
      ? '• Valid until you turn it off: choose a lower level in the chat\'s permission selector, or turn it off in Autonomy & Permissions. It does not expire by itself.'
      : `• Valid for ${hours(input.validityMs)}, until ${when(input.now + input.validityMs)}.`,
    `• ${REVOKE} Revoking stops the running Agent or Mission that used it, and the long jobs it started, where possible; what already happened cannot be undone.`,
  ];
  return { message: `Turn on Full Access for ${input.project} on ${input.env}?`, detail: lines.join('\n'), action: 'Turn on Full Access' };
}

export function validateSessionWeb(input: { maxSearches: number; maxFetches: number; validityHours: number }): string | null {
  const inRange = (value: number, max: number) => Number.isInteger(value) && value >= 0 && value <= max;
  if (!inRange(input.maxSearches, SESSION_WEB_MAX_SEARCHES) || !inRange(input.maxFetches, SESSION_WEB_MAX_FETCHES) || input.maxSearches + input.maxFetches === 0) {
    return `Pre-authorized web access needs 0 to ${SESSION_WEB_MAX_SEARCHES} searches and 0 to ${SESSION_WEB_MAX_FETCHES} page reads, and at least one of them.`;
  }
  return VALIDITY_HOURS.includes(input.validityHours) ? null : 'Choose how long the pre-authorization lasts: 1, 8 or 24 hours, 7 or 30 days.';
}

/** Commands that still show their card under Full Access: privilege elevation, RAME Code's own state, the system's stored secrets. */
export function commandNeedsCard(command: string, statePaths: readonly string[]): string | null {
  // Preceded by anything but a word character or a dash (a path, a quote, a subshell), followed by its arguments or the end.
  if (/(?:^|[^\w-])(?:sudo|su|doas|pkexec|runas|gsudo)(?=$|[\s"';)&|`])/i.test(command) || /Start-Process\b[^\n]*-Verb\s+RunAs/i.test(command)) {
    return 'it elevates privileges';
  }
  const lower = command.toLowerCase();
  if (/globalstorage|shared-state|ramecode\.autonomy/.test(lower) || statePaths.some((entry) => entry.length > 0 && lower.includes(entry.toLowerCase()))) {
    return "it mentions RAME Code's own state";
  }
  if (/\b(?:secret-tool|gnome-keyring|kwallet|security\s+(?:find|dump)-\w+|cmdkey|vaultcmd)\b|credential\s*manager/i.test(command)) {
    return "it reads the system's stored secrets";
  }
  return null;
}
