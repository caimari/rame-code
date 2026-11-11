/**
 * The host side of Autonomy & Permissions (see `autonomyPolicy.ts`).
 *
 * Every pre-authorization and Full Access grant is created here, only from
 * a message of the view and only after the host's modal confirmation
 * (`host.confirmAutonomy`; a host without it refuses). The model has no
 * tool and no message that reaches this module. The checks that matter run
 * right before each operation, reading the stored policy afresh, in this
 * environment: `metaRefusalNow`, `missionWebRefusalNow`, `useAgentWebNow`
 * for Agent and Chat web calls and `fullAccessNow` for the Agent's tools.
 *
 * Revoking aborts what was running under it, in this window at once and in
 * the other windows of the same workspace and environment at their next
 * check (each window watches the store while something of it is running):
 * requests being sent, the Agent or Mission run that used Full Access, and
 * the long jobs started under it. What already left or already happened
 * cannot be taken back.
 */

import * as os from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  commandNeedsCard,
  describeMetaMax,
  describeScopedFile,
  FULL_TOOL_WORDS,
  FULL_TOOLS,
  fullConfirmation,
  fullMetaRefusal,
  fullRefusal,
  fullMainModelRefusal,
  MAX_ADVICE_KEYS,
  META_PROVIDER,
  metaConfirmation,
  metaRefusal,
  missionCountRefusal,
  missionWebConfirmation,
  missionWebGrantId,
  missionWebRefusal,
  newPreauthId,
  parseScopedFiles,
  sessionWebConfirmation,
  UNTIL_TURNED_OFF,
  untilTurnedOff,
  useAgentWeb,
  validateSessionWeb,
  type ExternalApproval,
  type ExternalEntry,
  type FullMetaNeed,
  type FullTool,
  type GrantContext,
  type MetaBinding,
  type MetaPreauth,
  type ScopedFile,
  type WorkspaceAutonomy,
} from './autonomyPolicy.js';
import { advisorFor, advisorModelNow } from './advisorHost.js';
import type { AutonomyStore } from './autonomyStore.js';
import type { AutonomyMessage, AutonomyView } from './autonomyView.js';
import { checkAgentRelPath, isProtectedRelPath } from './agentPolicy.js';
import type { AgentFs } from './agentHost.js';
import { redactSecrets } from './cloudEgress.js';
import { scopeIdForRoot } from './decisionStore.js';
import { domainAllowed, missionQueryRefusal, validateMissionWebRequest } from './missionWeb.js';
import type { MissionRecord } from './missionStore.js';
import type { ProviderHost } from './providerTypes.js';
import { HOST_SPEC_FILE } from './referenceCheck.js';
import { egressRefusal } from './webAccess.js';

/** What this module needs of the host; every field is optional so a partial host refuses instead of failing. */
type AutonomyHost = ProviderHost & {
  autonomy?: AutonomyStore;
  confirmAutonomy?: (request: { message: string; detail: string; action: string }) => Promise<boolean>;
  stopMission?: (missionId: string, action: 'pause' | 'cancel') => Promise<void>;
};

export const MAX_FRAGMENT_CHARS = 8000;
const HOUR = 3_600_000;
const WATCH_MS = 1000;

export function osUser(): string {
  try {
    return os.userInfo().username || 'unknown';
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

const storeOf = (host: object): AutonomyStore | undefined => (host as AutonomyHost).autonomy;

function contextFor(store: AutonomyStore, scopeId: string): GrantContext {
  return { now: Date.now(), user: osUser(), scopeId, envId: store.env().id };
}

// ----- The open workspace, as Settings last resolved it -----

const scopes = new WeakMap<object, { scopeId: string; root: string; label: string } | null>();

export function rememberAutonomyScope(host: object, scope: { scopeId: string; root: string; label: string } | null): void {
  scopes.set(host, scope === null ? null : { scopeId: scope.scopeId, root: scope.root, label: scope.label });
}

/** The workspace scope a request outside a Mission is recorded under. */
export function currentScopeId(host: object): string {
  return scopes.get(host)?.scopeId ?? '';
}

/** The scope of the folder an Agent or Chat run works in. */
async function scopeForRoot(host: ProviderHost, root: string): Promise<string> {
  if (typeof host.heldCanonicalRoot !== 'function') {
    return currentScopeId(host);
  }
  try {
    return scopeIdForRoot(await host.heldCanonicalRoot(root, host.agentFsFor(root)));
  } catch {
    // A folder that cannot be resolved is not the workspace anything was given for.
    return '';
  }
}

// ----- What is running under a grant, and the watch that stops it -----

const inflight = new Map<string, { scopeId: string; store: AutonomyStore | undefined; controllers: Set<AbortController> }>();
/** Each window's run that used Full Access: stopped when that grant is no longer in force. */
const fullRuns = new Map<object, { id: string; scopeId: string }>();
let watch: ReturnType<typeof setInterval> | null = null;

/**
 * A signal aborted when the grant `id` is revoked: at once in this window,
 * and within a second when another window revokes it (with `host`, this
 * window watches the shared store while the request runs). Call `done`
 * when the request ends.
 */
export function trackPreauthorized(id: string, scopeId = '', host?: object): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const entry = inflight.get(id) ?? { scopeId, store: host === undefined ? undefined : storeOf(host), controllers: new Set<AbortController>() };
  entry.controllers.add(controller);
  inflight.set(id, entry);
  if (entry.store !== undefined && entry.scopeId !== '') {
    ensureWatch();
  }
  return {
    signal: controller.signal,
    done: () => {
      entry.controllers.delete(controller);
      if (entry.controllers.size === 0) {
        inflight.delete(id);
      }
    },
  };
}

function abortPreauthorized(ids: ReadonlyArray<string | null | undefined>): number {
  let aborted = 0;
  for (const id of ids) {
    for (const controller of (id ? inflight.get(id)?.controllers : undefined) ?? []) {
      controller.abort(new DOMException('The pre-authorization was revoked.', 'AbortError'));
      aborted += 1;
    }
  }
  return aborted;
}

const inflightCount = (): number => [...inflight.values()].reduce((sum, entry) => sum + entry.controllers.size, 0);

/** The ids of the grants in force now for one workspace in this environment. */
function liveIds(store: AutonomyStore, scopeId: string): Set<string> {
  const policy = store.get(scopeId);
  const now = Date.now();
  const ids = new Set<string>();
  for (const grant of [policy.meta, policy.missionWeb, policy.agentWeb, policy.full]) {
    if (grant !== null && now < grant.expiresAt && grant.user === osUser()) {
      ids.add(grant.id);
    }
  }
  return ids;
}

async function stopRunOf(host: AutonomyHost): Promise<boolean> {
  fullRuns.delete(host);
  const missionId = host.missionAuto?.missionId ?? null;
  if (missionId !== null && typeof host.stopMission === 'function') {
    await host.stopMission(missionId, 'pause').catch(() => undefined);
  }
  return typeof host.cancelRequest === 'function' ? host.cancelRequest() : false;
}

/**
 * One look at the shared store: abort what runs in this window under a
 * grant that is no longer in force (revoked in any window, expired or
 * replaced). The watch calls it every second while something runs.
 */
export async function checkRevocations(): Promise<number> {
  let stopped = 0;
  for (const [id, entry] of [...inflight]) {
    if (entry.store !== undefined && entry.scopeId !== '' && !liveIds(entry.store, entry.scopeId).has(id)) {
      stopped += abortPreauthorized([id]);
    }
  }
  for (const [host, run] of [...fullRuns]) {
    const self = host as AutonomyHost;
    const own = storeOf(host);
    if (!self.running && self.missionAuto === null) {
      fullRuns.delete(host);
    } else if (own !== undefined && !liveIds(own, run.scopeId).has(run.id)) {
      stopped += (await stopRunOf(self)) ? 1 : 0;
      self.status = 'Full Access was revoked or expired: the run that used it was stopped. What already ran cannot be undone.';
      await self.postState?.().catch(() => undefined);
    }
  }
  if (inflight.size === 0 && fullRuns.size === 0 && watch !== null) {
    clearInterval(watch);
    watch = null;
  }
  return stopped;
}

function ensureWatch(): void {
  if (watch === null) {
    watch = setInterval(() => void checkRevocations().catch(() => undefined), WATCH_MS);
    watch.unref?.();
  }
}

// ----- Meta -----

function metaContext(host: AutonomyHost, store: AutonomyStore, scopeId: string): Parameters<typeof metaRefusal>[2] {
  return {
    ...contextFor(store, scopeId),
    // Consultations go to the advisor of the main model (advisorHost.ts): that is the model a pre-authorization covers.
    model: advisorModelNow(host),
    credentialRevision: typeof host.metaCredential === 'string' ? host.metaCredential : '',
    cloudEscalation: host.settings?.allowCloudEscalation === true,
  };
}

/** Why a Meta consultation may not be sent without a card now (fresh read of the stored policy), or null. */
export function metaRefusalNow(host: ProviderHost, scopeId: string, binding: MetaBinding | null): string | null {
  const store = storeOf(host);
  if (store === undefined) {
    return 'no Meta pre-authorization is in force for this workspace';
  }
  return metaRefusal(store.get(scopeId), binding, metaContext(host as AutonomyHost, store, scopeId));
}

/** The pre-authorization in force for Missions of this workspace now, or null. */
export function metaInForce(host: ProviderHost, scopeId: string): MetaPreauth | null {
  return metaRefusalNow(host, scopeId, null) === null ? (storeOf(host)?.get(scopeId).meta ?? null) : null;
}

/** The most consultations a Mission of this workspace may be given now: 0 when none, null when no count limit. */
export function metaAllowance(host: ProviderHost, scopeId: string): number | null {
  const meta = metaInForce(host, scopeId);
  return meta === null ? 0 : meta.maxPerMission;
}

/**
 * Reserve, before a consultation is sent, `bound` tokens of the
 * pre-authorization's total budget (when it has one); false when it would
 * go over. Atomic across windows: inside the store's exclusive update.
 */
export async function reserveMetaTokens(host: ProviderHost, scopeId: string, preauthId: string, bound: number): Promise<string | null> {
  const store = storeOf(host);
  if (store === undefined) {
    return 'no Meta pre-authorization is in force for this workspace';
  }
  return store.change(scopeId, (policy) => {
    const meta = policy.meta;
    if (meta === null || meta.id !== preauthId) {
      return 'this Mission was authorized under an earlier pre-authorization that was revoked or replaced';
    }
    if (meta.tokenBudget !== null && meta.usedTokens + bound > meta.tokenBudget) {
      return `the consultation could use up to ${bound} tokens and only ${Math.max(0, meta.tokenBudget - meta.usedTokens)} of the pre-authorization's ${meta.tokenBudget}-token budget remain`;
    }
    meta.usedTokens += bound;
    return null;
  });
}

/** Give back what a consultation reserved but did not use (what Meta reported replaces the bound). */
export async function settleMetaTokens(host: ProviderHost, scopeId: string, preauthId: string, reserved: number, used: number): Promise<void> {
  await storeOf(host)?.change(scopeId, (policy) => {
    if (policy.meta !== null && policy.meta.id === preauthId) {
      policy.meta.usedTokens = Math.max(0, policy.meta.usedTokens - reserved + Math.max(0, used));
    }
  }).catch(() => undefined);
}

// ----- Meta under Full Access (Agent's advice, the acceptance review) -----

/** Why Full Access does not send this consultation without its card now (fresh read, nothing written), or null. */
export function fullMetaRefusalNow(host: ProviderHost, scopeId: string, need: FullMetaNeed): string | null {
  const store = storeOf(host);
  if (store === undefined || scopeId === '') {
    return 'Full Access is not available here';
  }
  return fullMetaRefusal(store.get(scopeId), metaContext(host as AutonomyHost, store, scopeId), need);
}

/** Whether Full Access in force includes `part` now (to say why a card still shows). */
export function fullIncludesNow(host: ProviderHost, scopeId: string, part: FullTool): boolean {
  const store = storeOf(host);
  return store !== undefined && scopeId !== '' && fullRefusal(store.get(scopeId), contextFor(store, scopeId), part) === null;
}

/**
 * Whether an Agent run with Meta as the main model may go without the
 * disclosure card under Full Access now: only its "Meta as the main model"
 * part, for the Meta model selected now and this API key (fresh read of the
 * stored, sealed policy). Its tool parts never authorize it.
 */
export function fullMainModelNow(host: ProviderHost, scopeId: string): boolean {
  const store = storeOf(host);
  return store !== undefined && scopeId !== '' && fullMainModelRefusal(store.get(scopeId), contextFor(store, scopeId), { model: host.selectedCloudModel(), credentialRevision: host.metaCredential }) === null;
}

/** A consultation let through by Full Access: both grants it runs under, and the tokens it reserved. */
export interface FullMetaUse {
  fullId: string;
  metaId: string;
  reserved: number;
}

/**
 * Right before a consultation leaves: check Full Access and the Meta
 * pre-authorization again and, in the same exclusive step of the shared
 * store, reserve `bound` tokens of its budget and count the consultation
 * (for Agent's advice, against its conversation). Two windows can never
 * share the last consultation or the last tokens.
 */
export async function fullMetaNow(host: ProviderHost, scopeId: string, need: FullMetaNeed, bound: number): Promise<{ ok: true; use: FullMetaUse } | { ok: false; why: string }> {
  const store = storeOf(host);
  if (store === undefined || scopeId === '' || !Number.isFinite(bound) || bound < 0) {
    return { ok: false, why: 'Full Access is not available here' };
  }
  const self = host as AutonomyHost;
  try {
    return await store.change(scopeId, (policy): { ok: true; use: FullMetaUse } | { ok: false; why: string } => {
      const refusal = fullMetaRefusal(policy, metaContext(self, store, scopeId), need);
      const meta = policy.meta;
      if (refusal !== null || meta === null || policy.full === null) {
        return { ok: false, why: refusal ?? 'no Meta pre-authorization is in force for this workspace' };
      }
      if (meta.tokenBudget !== null && meta.usedTokens + bound > meta.tokenBudget) {
        return { ok: false, why: `the consultation could use up to ${bound} tokens and only ${Math.max(0, meta.tokenBudget - meta.usedTokens)} of the pre-authorization's ${meta.tokenBudget}-token budget remain` };
      }
      meta.usedTokens += bound;
      if (need.key !== undefined) {
        meta.adviceUses[need.key] = (meta.adviceUses[need.key] ?? 0) + 1;
        for (const key of Object.keys(meta.adviceUses).slice(0, Math.max(0, Object.keys(meta.adviceUses).length - MAX_ADVICE_KEYS))) {
          delete meta.adviceUses[key];
        }
      }
      return { ok: true, use: { fullId: policy.full.id, metaId: meta.id, reserved: bound } };
    });
  } catch {
    return { ok: false, why: 'Autonomy & Permissions could not be read or written' };
  }
}

/** Aborted when either grant is revoked, here or in another window of this workspace; call `done` when the request ends. */
export function trackFullMeta(host: ProviderHost, scopeId: string, use: FullMetaUse): { signal: AbortSignal; done: () => void } {
  const full = trackPreauthorized(use.fullId, scopeId, host);
  const meta = trackPreauthorized(use.metaId, scopeId, host);
  return { signal: AbortSignal.any([full.signal, meta.signal]), done: () => { full.done(); meta.done(); } };
}

const metaScopes = new WeakMap<object, Map<string, string[]>>();

export function takeMissionMetaScope(host: object, missionId: string): string[] {
  const byMission = metaScopes.get(host);
  const files = byMission?.get(missionId) ?? [];
  byMission?.delete(missionId);
  return files;
}

/** Files Meta may never receive automatically: the verifier's, the host's descriptions, protected paths. */
function scopedFileRefusal(file: string, excluded: ReadonlySet<string>): string | null {
  const gate = checkAgentRelPath(file);
  if (!gate.ok || isProtectedRelPath(file)) {
    return `${file} is outside the project or protected`;
  }
  if (HOST_SPEC_FILE.test(file) || excluded.has(gate.rel)) {
    return `${file} belongs to the acceptance check or the host's own description (hidden from the agent and never sent)`;
  }
  return null;
}

/**
 * The binding of a Mission's escalation, checked when the Mission is
 * authorized: under the pre-authorization in force, within its maximum
 * (null: no count limit), with files only when its scope allows them, and
 * never one of the verifier's files.
 */
export async function missionMetaBinding(
  host: ProviderHost,
  scopeId: string,
  maxConsultations: number | null,
  rawFiles: readonly string[],
  fs: AgentFs,
  excluded: ReadonlySet<string>,
): Promise<{ ok: true; binding: MetaBinding } | { ok: false; error: string }> {
  const refusal = metaRefusalNow(host, scopeId, null);
  const meta = storeOf(host)?.get(scopeId).meta ?? null;
  if (refusal !== null || meta === null) {
    return { ok: false, error: `Meta consultations in a Mission need a pre-authorization in Settings → Security → Autonomy & Permissions: ${refusal ?? 'none is in force'}.` };
  }
  const over = missionCountRefusal(meta, maxConsultations);
  if (over !== null) {
    return { ok: false, error: over };
  }
  const parsed = parseScopedFiles(rawFiles);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  if (parsed.files.length > 0 && meta.dataScope !== 'files') {
    return { ok: false, error: 'The Meta pre-authorization covers only the Mission instructions; files need a pre-authorization that includes them.' };
  }
  for (const file of parsed.files) {
    const why = scopedFileRefusal(file.path, excluded);
    if (why !== null) {
      return { ok: false, error: `Meta cannot be given ${why}.` };
    }
    if ((await fs.stat(file.path).catch(() => ({ kind: 'missing' as const }))).kind !== 'file') {
      return { ok: false, error: `${file.path.slice(0, 120)} is not a file of this project.` };
    }
  }
  return {
    ok: true,
    binding: { preauthId: meta.id, user: meta.user, scopeId, envId: meta.envId, provider: META_PROVIDER, model: meta.model, credentialRevision: meta.credentialRevision, expiresAt: meta.expiresAt, files: parsed.files },
  };
}

/**
 * The files of a binding as they are now, for one consultation. Not sent
 * (null and why) when a file is gone, became protected or now holds
 * something that looks like a secret: that would need a new approval of
 * the exact text, never an automatic send.
 */
export async function scopedFilesSection(fs: AgentFs, project: string, files: readonly ScopedFile[], excluded: ReadonlySet<string>): Promise<{ ok: true; text: string; names: string[] } | { ok: false; error: string }> {
  const parts: string[] = [];
  for (const file of files) {
    const why = scopedFileRefusal(file.path, excluded);
    if (why !== null) {
      return { ok: false, error: why };
    }
    let content: string;
    try {
      content = await fs.readText(file.path);
    } catch {
      return { ok: false, error: `${file.path} can no longer be read` };
    }
    if (file.start !== undefined && file.end !== undefined) {
      content = content.split('\n').slice(file.start - 1, file.end).join('\n');
    }
    if (redactSecrets(content).found.length > 0) {
      return { ok: false, error: `${describeScopedFile(file)} now contains something that looks like a key, token or password` };
    }
    const shown = content.slice(0, MAX_FRAGMENT_CHARS);
    parts.push(`--- ${describeScopedFile(file)}${shown.length < content.length ? ` (first ${MAX_FRAGMENT_CHARS} characters)` : ''}\n${shown}`);
  }
  return parts.length === 0
    ? { ok: true, text: '', names: [] }
    : { ok: true, text: `\n\nProject files the user pre-authorized for this Mission's consultations (project ${project}):\n${parts.join('\n')}`, names: files.map(describeScopedFile) };
}

// ----- Web for autonomous Missions -----

export function missionWebRefusalNow(host: ProviderHost, scopeId: string, preauthId: string | null): string | null {
  const store = storeOf(host);
  if (store === undefined) {
    return 'web budgets for autonomous Missions are not pre-authorized for this workspace (Autonomy & Permissions)';
  }
  return missionWebRefusal(store.get(scopeId), preauthId, contextFor(store, scopeId));
}

/** The grant an autonomous Mission's web budget is bound to now (its own pre-authorization, or Full Access with web), or null. */
export function missionWebPreauthId(host: ProviderHost, scopeId: string): string | null {
  const store = storeOf(host);
  return store === undefined ? null : missionWebGrantId(store.get(scopeId), contextFor(store, scopeId));
}

// ----- Web for Agent and Chat, shared by every window of the workspace -----

const canonical = (raw: string): string => {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
};

const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
};

/** Which grant let the web call about to run through, by host and call (read once by the web tool). */
const webUses = new WeakMap<object, Map<string, { approval: 'full-access' | 'pre-authorized'; id: string; scopeId: string }>>();

/**
 * Agent or Chat is about to make a web call: true when Full Access with web,
 * or the Agent and Chat web pre-authorization, lets it through (one slot
 * consumed inside the store's exclusive update, so two calls from any
 * windows never share one). Otherwise the call shows its card.
 */
const webQueues = new WeakMap<object, Promise<unknown>>();

export function useAgentWebNow(host: object, tool: string, args: Record<string, unknown>, root: string): Promise<boolean> {
  // In the order the calls were made: the first one asked is the first one served.
  const next = (webQueues.get(host) ?? Promise.resolve()).then(() => useAgentWebInOrder(host, tool, args, root));
  webQueues.set(host, next.catch(() => undefined));
  return next;
}

async function useAgentWebInOrder(host: object, tool: string, args: Record<string, unknown>, root: string): Promise<boolean> {
  const store = storeOf(host);
  if ((tool !== 'web_search' && tool !== 'web_fetch') || (host as ProviderHost).missionAuto || store === undefined || root.length === 0) {
    return false;
  }
  const query = String(args.query ?? '');
  const url = String(args.url ?? '');
  const scopeId = await scopeForRoot(host as ProviderHost, root);
  if (scopeId === '') {
    return false;
  }
  const use = await store.change(scopeId, (policy) =>
    useAgentWeb(
      policy,
      { tool, queryRefusal: tool === 'web_search' ? (egressRefusal(query) ?? missionQueryRefusal(query)) : egressRefusal(url), host: hostnameOf(url), url: canonical(url) },
      contextFor(store, scopeId),
      domainAllowed,
    ),
  ).catch(() => null);
  if (use === null) {
    return false;
  }
  const byCall = webUses.get(host) ?? new Map();
  byCall.set(`${tool}:${tool === 'web_search' ? query : url}`, { ...use, scopeId });
  webUses.set(host, byCall);
  if (use.approval === 'full-access') {
    noteFullRun(host as AutonomyHost, use.id, scopeId);
  }
  return true;
}

/** How the web call about to run was let through, without using it up (the run reads it once with takeWebUse). */
export function peekWebUse(host: object, tool: string, value: string): 'full-access' | 'pre-authorized' | null {
  return webUses.get(host)?.get(`${tool}:${value}`)?.approval ?? null;
}

/** The grant that let the web call about to run through (read once), or null when it ran by card or profile. */
export function takeWebUse(host: object, tool: string, value: string): { approval: 'full-access' | 'pre-authorized'; id: string; scopeId: string } | null {
  const byCall = webUses.get(host);
  const use = byCall?.get(`${tool}:${value}`) ?? null;
  byCall?.delete(`${tool}:${value}`);
  return use;
}

/** URLs a pre-authorized search returned: the only pages the Agent and Chat pre-authorization may read when it lists no domain. */
export async function rememberAgentResults(host: object, scopeId: string, urls: readonly string[]): Promise<void> {
  const store = storeOf(host);
  if (store === undefined || scopeId === '' || urls.length === 0 || store.get(scopeId).agentWeb === null) {
    return;
  }
  await store.change(scopeId, (policy) => {
    if (policy.agentWeb !== null) {
      policy.agentWeb.found = [...new Set([...policy.agentWeb.found, ...urls.slice(0, 50).map(canonical)])].slice(-200);
    }
  }).catch(() => undefined);
}

// ----- Full Access for the Agent's tools -----

const READ_ONLY_TOOLS = new Set(['list_files', 'inspect_workspace', 'filesystem_usage', 'search_history', 'search_text', 'read_file', 'read_original']);
const FILE_TOOLS = new Set([...READ_ONLY_TOOLS, 'create_directory', 'move_file', 'delete_file', 'set_executable', 'apply_patch', 'replace_in_file']);

/** The part of Full Access a tool needs; null for tools it never covers (project memory, the folder dialog). */
export function fullToolFor(tool: string): FullTool | null {
  if (FILE_TOOLS.has(tool)) {
    return 'files';
  }
  switch (tool) {
    case 'run_tests':
      return 'tests';
    case 'run_command':
      return 'commands';
    case 'install_package':
    case 'check_installed':
      return 'installs';
    case 'start_job':
    case 'job_status':
      return 'jobs';
    case 'web_search':
    case 'web_fetch':
      return 'web';
    default:
      return null;
  }
}

function noteFullRun(host: AutonomyHost, id: string, scopeId: string): void {
  fullRuns.set(host, { id, scopeId });
  ensureWatch();
}

/**
 * Whether Full Access lets this Agent call run without its card now:
 * checked on the stored policy, for this workspace, environment and user,
 * right before the call. Calls it does not cover, or that still need their
 * card (privilege elevation, RAME Code's own state), return why not.
 */
export async function fullAccessNow(host: ProviderHost, tool: string, args: Record<string, unknown>, root: string): Promise<{ ok: true; id: string; scopeId: string } | { ok: false; why: string }> {
  const store = storeOf(host);
  const part = fullToolFor(tool);
  if (store === undefined || part === null || root.length === 0) {
    return { ok: false, why: part === null ? `${tool} always needs its card` : 'Full Access is not available here' };
  }
  const scopeId = await scopeForRoot(host, root);
  const policy = store.get(scopeId);
  const refusal = fullRefusal(policy, contextFor(store, scopeId), part);
  if (refusal !== null || policy.full === null) {
    return { ok: false, why: refusal ?? 'Full Access is not on for this workspace' };
  }
  if (part === 'commands') {
    const why = commandNeedsCard(String(args.command ?? ''), store.runtime.statePaths ?? []);
    if (why !== null) {
      return { ok: false, why: `the command still needs its card: ${why}` };
    }
  }
  noteFullRun(host as AutonomyHost, policy.full.id, scopeId);
  return { ok: true, id: policy.full.id, scopeId };
}

/** Calls the engine let through by Full Access (for the audit: approved by Full Access, not by the profile). */
const fullApproved = new WeakSet<object>();
export const markFullApproved = (call: object): void => void fullApproved.add(call);
export const isFullApproved = (call: object): boolean => fullApproved.has(call);

/** Remember a long job started under Full Access, so revoking it stops the job too (from any window, also after a reload). */
export async function rememberFullJob(host: ProviderHost, scopeId: string, grantId: string, jobId: string): Promise<void> {
  await storeOf(host)?.change(scopeId, (policy) => {
    if (policy.full !== null && policy.full.id === grantId && !policy.full.jobs.includes(jobId)) {
      policy.full.jobs = [...policy.full.jobs, jobId].slice(-50);
    }
  }).catch(() => undefined);
}

// ----- The record of what left this computer -----

/** Record a request before it is sent; returns its id ('' when this host keeps no record). */
export async function recordExternal(host: ProviderHost, scopeId: string, entry: Omit<ExternalEntry, 'id' | 'at' | 'outcome'> & { outcome?: string }): Promise<string> {
  const store = storeOf(host);
  if (store === undefined) {
    return '';
  }
  const id = `ext_${randomBytes(6).toString('hex')}`;
  await store.change(scopeId, (policy) => {
    policy.log.push({ ...entry, id, at: Date.now(), outcome: entry.outcome ?? 'sending' });
  }).catch(() => undefined);
  return id;
}

export async function finishExternal(host: ProviderHost, scopeId: string, id: string, outcome: string): Promise<void> {
  const store = storeOf(host);
  if (store === undefined || id === '') {
    return;
  }
  await store.change(scopeId, (policy) => {
    const entry = policy.log.find((candidate) => candidate.id === id);
    if (entry) {
      entry.outcome = outcome.slice(0, 300);
    }
  }).catch(() => undefined);
}

// ----- Settings messages -----

async function confirm(host: AutonomyHost, request: { message: string; detail: string; action: string }): Promise<boolean> {
  return host.confirmAutonomy ? (await host.confirmAutonomy(request)) === true : false;
}

async function say(host: ProviderHost, status: string): Promise<void> {
  host.status = status;
  await host.postState();
}

/** Revoke grants of one workspace in this environment: removed from the store at once, then what ran under them is stopped. */
async function revoke(host: AutonomyHost, store: AutonomyStore, scopeId: string, what: ReadonlyArray<'meta' | 'missionWeb' | 'agentWeb' | 'full'>, toAsk: boolean): Promise<{ aborted: number; jobs: number }> {
  let removed: WorkspaceAutonomy | null = null;
  await store.change(scopeId, (policy) => {
    removed = JSON.parse(JSON.stringify(policy)) as WorkspaceAutonomy;
    // A Meta pre-authorization given with Full Access goes with it.
    if (what.includes('full') && policy.meta?.fullId !== undefined && policy.meta.fullId === policy.full?.id) {
      policy.meta = null;
    }
    for (const part of what) {
      policy[part] = null;
    }
    policy.mode = toAsk ? 'ask' : policy.mode === 'full' && what.includes('full') ? 'supervised' : policy.mode;
  });
  const before = removed as WorkspaceAutonomy | null;
  const ids = what.map((part) => before?.[part]?.id ?? null);
  if (what.includes('full') && before?.meta?.fullId !== undefined && before.meta.fullId === before.full?.id) {
    ids.push(before.meta.id);
  }
  let aborted = abortPreauthorized(ids);
  const run = fullRuns.get(host);
  if (run !== undefined && ids.includes(run.id)) {
    aborted += (await stopRunOf(host)) ? 1 : 0;
  }
  let jobs = 0;
  for (const jobId of what.includes('full') ? (before?.full?.jobs ?? []) : []) {
    const job = host.jobs?.get?.(jobId);
    if (job && (job.status === 'starting' || job.status === 'running')) {
      jobs += (await host.jobs.cancel(jobId).catch(() => ({ ok: false }))).ok ? 1 : 0;
    }
  }
  return { aborted, jobs };
}

const stopped = (result: { aborted: number; jobs: number }): string =>
  `${result.aborted > 0 ? `, and ${result.aborted} operation(s) running under it were cancelled where possible (what already left or ran cannot be taken back)` : ''}${result.jobs > 0 ? `; ${result.jobs} long job(s) it started were stopped` : ''}`;

function metaWords(meta: MetaPreauth): string {
  return `Meta ${meta.model}, ${describeMetaMax(meta.maxPerMission)} consultation(s) per Mission, ${meta.dataScope === 'files' ? 'instructions and the files each card chooses' : 'instructions only'}${meta.tokenBudget !== null ? `, at most ${meta.tokenBudget} tokens in total` : ''}, ${untilWords(meta.expiresAt)}`;
}

/** "until <date>", or "until you turn it off" for a grant with no expiry. */
function untilWords(at: number): string {
  return untilTurnedOff(at) ? 'until you turn it off' : `until ${new Date(at).toLocaleString()}`;
}

export async function handleAutonomyMessage(host: ProviderHost, message: AutonomyMessage, resolveScope: () => Promise<{ ok: true; scopeId: string; root: string; label: string } | { ok: false; error: string }>): Promise<void> {
  const self = host as AutonomyHost;
  if (message.type === 'missionMetaScopeSet') {
    // Kept until this Mission is authorized; validated again there and bound to its grant.
    const byMission = metaScopes.get(host) ?? new Map<string, string[]>();
    byMission.set(message.missionId, message.files);
    metaScopes.set(host, byMission);
    return;
  }
  const scope = await resolveScope();
  rememberAutonomyScope(host, scope.ok ? scope : null);
  if (message.type === 'autonomyRefresh') {
    await host.postState();
    return;
  }
  if (!scope.ok || self.autonomy === undefined) {
    await say(host, `${scope.ok ? 'Autonomy & Permissions are not available here.' : scope.error} Nothing was pre-authorized.`);
    return;
  }
  const store = self.autonomy;
  const env = store.env();
  const now = Date.now();
  const current = store.get(scope.scopeId);
  const base = () => ({ id: newPreauthId(), user: osUser(), envId: env.id, envLabel: env.label, scopeId: scope.scopeId });
  switch (message.type) {
    case 'autonomyMode': {
      if (message.mode === 'ask') {
        const result = await revoke(self, store, scope.scopeId, ['meta', 'missionWeb', 'agentWeb', 'full'], true);
        await say(host, `Autonomy & Permissions: Ask always for ${scope.label} on ${env.label}. Every pre-authorization of this workspace was revoked${stopped(result)}; each Meta consultation and each action shows its card again.`);
        return;
      }
      if (current.mode === 'full') {
        const result = await revoke(self, store, scope.scopeId, ['full'], false);
        await say(host, `Full Access was turned off for ${scope.label}${stopped(result)}. Supervised autonomy: only the pre-authorizations below apply; everything else shows its card.`);
        return;
      }
      await store.change(scope.scopeId, (policy) => {
        policy.mode = 'supervised';
      });
      await say(host, `Autonomy & Permissions: supervised autonomy for ${scope.label} on ${env.label}. Nothing is pre-authorized yet: choose below what RAME may do without a card, and for how long.`);
      return;
    }
    case 'autonomyMeta': {
      const model = advisorModelNow(host);
      if (current.mode === 'ask') {
        await say(host, 'Choose supervised autonomy first (or Full Access). Nothing was pre-authorized.');
        return;
      }
      if (!host.settings.allowCloudEscalation || !host.hasKey || model.length === 0) {
        await say(host, `Pre-authorizing Meta needs cloud escalation ON, a saved Meta API key and an advisor model for the main model${model.length === 0 ? ` (${advisorWhyNot(host)})` : ''}. Nothing was pre-authorized.`);
        return;
      }
      const validityMs = message.validityHours * HOUR;
      const confirmed = await confirm(self, metaConfirmation({ project: scope.label, model, maxPerMission: message.maxPerMission, validityMs, dataScope: message.dataScope, now, env: env.label, tokenBudget: message.tokenBudget ?? null }));
      if (!confirmed || host.disposed) {
        await say(host, 'Meta was not pre-authorized: the confirmation was not accepted. Each consultation still shows its card.');
        return;
      }
      const at = Date.now();
      abortPreauthorized([current.meta?.id]);
      const meta: MetaPreauth = {
        ...base(), project: scope.label, provider: META_PROVIDER, model, credentialRevision: host.metaCredential,
        maxPerMission: message.maxPerMission, dataScope: message.dataScope, tokenBudget: message.tokenBudget ?? null, usedTokens: 0, adviceUses: {}, grantedAt: at, expiresAt: at + validityMs,
      };
      await store.change(scope.scopeId, (policy) => {
        policy.meta = meta;
      });
      await say(host, `Pre-authorized for Missions of ${scope.label} on ${env.label}: ${metaWords(meta)}. Each Mission's card still chooses how many (0 by default).`);
      return;
    }
    case 'autonomyMissionWeb': {
      if (current.mode === 'ask') {
        await say(host, 'Choose supervised autonomy first (or Full Access). Nothing was pre-authorized.');
        return;
      }
      const validityMs = message.validityHours * HOUR;
      if (!(await confirm(self, missionWebConfirmation({ project: scope.label, validityMs, now, env: env.label }))) || host.disposed) {
        await say(host, 'Web for Missions was not pre-authorized: the confirmation was not accepted.');
        return;
      }
      const at = Date.now();
      await store.change(scope.scopeId, (policy) => {
        policy.missionWeb = { ...base(), grantedAt: at, expiresAt: at + validityMs };
      });
      await say(host, `Web budgets may be given to autonomous Missions of ${scope.label} until ${new Date(at + validityMs).toLocaleString()}; each Mission's card sets its own budget.`);
      return;
    }
    case 'autonomySessionWeb': {
      if (current.mode === 'ask') {
        await say(host, 'Choose supervised autonomy first (or Full Access). Nothing was pre-authorized.');
        return;
      }
      if (host.settings.web?.enabled !== true) {
        await say(host, 'Turn on Web access first (Settings → Security → Web access). Nothing was pre-authorized.');
        return;
      }
      const invalid = validateSessionWeb(message);
      const checked = validateMissionWebRequest({ enabled: true, maxSearches: message.maxSearches, maxFetches: message.maxFetches, domains: message.domains });
      if (invalid !== null || !checked.ok) {
        await say(host, `${invalid ?? (checked.ok ? '' : checked.error)} Nothing was pre-authorized.`);
        return;
      }
      const domains = checked.grant?.domains ?? [];
      const validityMs = message.validityHours * HOUR;
      if (!(await confirm(self, sessionWebConfirmation({ project: scope.label, maxSearches: message.maxSearches, maxFetches: message.maxFetches, domains, validityMs, now, env: env.label }))) || host.disposed) {
        await say(host, 'Web searches were not pre-authorized: the confirmation was not accepted. Each one still shows its card.');
        return;
      }
      const at = Date.now();
      abortPreauthorized([current.agentWeb?.id]);
      await store.change(scope.scopeId, (policy) => {
        policy.agentWeb = { ...base(), project: scope.label, maxSearches: message.maxSearches, maxFetches: message.maxFetches, searches: 0, fetches: 0, domains, found: [], grantedAt: at, expiresAt: at + validityMs };
      });
      await say(host, `Web pre-authorized for Agent and Chat in ${scope.label}, every window of this workspace on ${env.label}: up to ${message.maxSearches} search(es) and ${message.maxFetches} page read(s) without a card, until ${new Date(at + validityMs).toLocaleString()}.`);
      return;
    }
    case 'autonomyFull': {
      const validityMs = message.validityHours * HOUR;
      // 0 hours: until the user turns it off (never expires by itself).
      const endsAt = (from: number): number => (message.validityHours === 0 ? UNTIL_TURNED_OFF : from + validityMs);
      const model = advisorModelNow(host);
      if (message.tools.meta && (!host.settings.allowCloudEscalation || !host.hasKey || model.length === 0 || message.meta === undefined)) {
        await say(host, `Full Access was not turned on: its Meta part needs cloud escalation ON, a saved Meta API key and an advisor model for the main model${model.length === 0 ? ` (${advisorWhyNot(host)})` : ''}. Nothing changed.`);
        return;
      }
      // Meta as the main model: for the Meta model selected now and this API key, chosen on its own.
      const mainModel = message.metaMain === true ? host.selectedCloudModel() : null;
      if (mainModel !== null && (!host.hasKey || mainModel.length === 0)) {
        await say(host, 'Full Access was not turned on: "Meta as the main model" needs a saved Meta API key and a selected Meta model. Nothing changed.');
        return;
      }
      // With its Meta part, the Meta pre-authorization is given in the same confirmation, for the selected model, provider, key and this environment.
      const at0 = Date.now();
      const withMeta: MetaPreauth | null = message.tools.meta && message.meta !== undefined
        ? {
            ...base(), project: scope.label, provider: META_PROVIDER, model, credentialRevision: host.metaCredential, maxPerMission: message.meta.maxPerMission,
            dataScope: message.meta.dataScope, tokenBudget: message.meta.tokenBudget, usedTokens: 0, adviceUses: {}, grantedAt: at0, expiresAt: endsAt(at0),
          }
        : null;
      const meta = withMeta ?? metaInForce(host, scope.scopeId);
      const request = fullConfirmation({
        project: scope.label, env: env.label, tools: message.tools, validityMs, now,
        enabled: { commands: host.settings.shell?.enabled === true, installs: host.settings.installs?.enabled !== false, jobs: host.settings.jobs?.enabled === true, web: host.settings.web?.enabled === true },
        meta: meta === null ? null : metaWords(meta),
        mainModel,
        isolation: host.settings.shell?.isolation ?? 'project',
      });
      if (!(await confirm(self, request)) || host.disposed) {
        await say(host, 'Full Access was not turned on: the confirmation was not accepted. Every card still appears as before.');
        return;
      }
      const at = Date.now();
      const replacedMeta = current.meta !== null && (withMeta !== null || (current.meta.fullId !== undefined && current.meta.fullId === current.full?.id)) ? current.meta.id : null;
      abortPreauthorized([current.full?.id, replacedMeta]);
      await store.change(scope.scopeId, (policy) => {
        const previous = policy.full?.id;
        policy.mode = 'full';
        policy.full = {
          ...base(), project: scope.label, tools: { ...message.tools }, jobs: [], grantedAt: at, expiresAt: endsAt(at),
          mainModel: mainModel === null ? null : { model: mainModel, credentialRevision: host.metaCredential },
        };
        if (withMeta !== null) {
          policy.meta = { ...withMeta, fullId: policy.full.id, grantedAt: at, expiresAt: endsAt(at) };
        } else if (policy.meta?.fullId !== undefined && policy.meta.fullId === previous) {
          // Given with the Full Access this one replaces, without a Meta part now: it goes with it.
          policy.meta = null;
        }
      });
      const parts = [
        ...FULL_TOOLS.filter((tool) => message.tools[tool]).map((tool) => (tool === 'meta' && withMeta !== null ? `${FULL_TOOL_WORDS.meta} (${metaWords(withMeta)})` : FULL_TOOL_WORDS[tool])),
        ...(mainModel === null ? [] : [`Agent with Meta ${mainModel} as the main model (its requests and tool results go to Meta)`]),
      ];
      await say(host, `Full Access is on for ${scope.label} on ${env.label} ${untilWords(endsAt(at))}: ${parts.join(', ')} run without their cards. Project memory, privilege elevation and the Mission authorization still ask; revoke it at any time.`);
      return;
    }
    case 'autonomyRevoke': {
      const what = message.what;
      const parts = what === 'all' ? (['meta', 'missionWeb', 'agentWeb', 'full'] as const) : what === 'sessionWeb' ? (['agentWeb'] as const) : ([what] as const);
      const result = await revoke(self, store, scope.scopeId, parts, false);
      const label = what === 'all' ? 'Every pre-authorization of this workspace' : what === 'meta' ? 'The Meta pre-authorization' : what === 'missionWeb' ? 'The web pre-authorization for Missions' : what === 'full' ? 'Full Access' : 'The web pre-authorization of Agent and Chat';
      await say(host, `${label} was revoked in every window of this workspace on ${env.label}: no new operation runs under it${stopped(result)}. Anything else shows its card.`);
      return;
    }
  }
}

// ----- What the view shows -----

function missionAccess(host: AutonomyHost, mission: MissionRecord): string {
  const parts: string[] = [];
  const escalation = mission.grant?.escalation;
  if (escalation?.preauth) {
    const problem = metaRefusalNow(host, mission.scopeId, escalation.preauth);
    const count = escalation.maxConsultations === null ? `${escalation.used} consultation(s) used, no count limit` : `${escalation.used} of ${escalation.maxConsultations} consultation(s) used`;
    parts.push(`Meta ${escalation.model}: ${count}, without a card ${untilWords(escalation.preauth.expiresAt)}; data: ${escalation.preauth.files.length > 0 ? `instructions and ${escalation.preauth.files.map(describeScopedFile).join(', ')}` : 'instructions only'}${problem !== null ? ` — not in force: ${problem}` : ''}`);
  }
  const web = mission.grant?.web;
  if (web && mission.grant?.mode === 'autonomous-workspace') {
    const problem = missionWebRefusalNow(host, mission.scopeId, web.preauthId ?? null);
    parts.push(`web: ${web.searches}/${web.maxSearches} search(es), ${web.fetches}/${web.maxFetches} page read(s)${problem !== null ? ` — not in force: ${problem}` : ''}`);
  }
  return parts.length > 0 ? `External access pre-authorized for this Mission: ${parts.join(' · ')}.` : '';
}

export function autonomyView(host: ProviderHost): AutonomyView | null {
  const self = host as AutonomyHost;
  const scope = scopes.get(host) ?? null;
  const store = self.autonomy;
  if (store === undefined) {
    return null;
  }
  const env = store.env();
  const metaUnavailable = !host.settings.allowCloudEscalation ? 'Turn on cloud escalation first.' : !host.hasKey ? 'Save a Meta API key first.' : '';
  if (scope === null) {
    return { project: null, env: env.label, note: 'Open a project folder to set its Autonomy & Permissions.', mode: 'ask', meta: null, missionWeb: null, sessionWeb: null, full: null, metaUnavailable, model: '', missions: [], log: [], inflight: inflightCount() };
  }
  const policy = store.get(scope.scopeId);
  const ctx = contextFor(store, scope.scopeId);
  const metaProblem = metaRefusalNow(host, scope.scopeId, null);
  const webProblem = policy.missionWeb === null ? null : missionWebRefusal({ ...policy, full: null }, null, ctx);
  const agentWeb = policy.agentWeb !== null && ctx.now < policy.agentWeb.expiresAt ? policy.agentWeb : null;
  const missions = host.missions.list().filter((mission) => mission.scopeId === scope.scopeId && mission.grant !== null).slice(-16);
  const full = policy.full;
  return {
    project: scope.label,
    env: env.label,
    note: '',
    mode: policy.mode,
    meta: policy.meta === null ? null : {
      model: policy.meta.model, maxPerMission: policy.meta.maxPerMission, dataScope: policy.meta.dataScope, grantedAt: policy.meta.grantedAt, expiresAt: policy.meta.expiresAt,
      tokenBudget: policy.meta.tokenBudget, usedTokens: policy.meta.usedTokens, problem: metaProblem ?? '',
    },
    missionWeb: policy.missionWeb === null ? null : { grantedAt: policy.missionWeb.grantedAt, expiresAt: policy.missionWeb.expiresAt, problem: webProblem ?? '' },
    sessionWeb: agentWeb === null ? null : { maxSearches: agentWeb.maxSearches, maxFetches: agentWeb.maxFetches, searches: agentWeb.searches, fetches: agentWeb.fetches, domains: [...agentWeb.domains], expiresAt: agentWeb.expiresAt },
    full: full === null ? null : { tools: { ...full.tools }, grantedAt: full.grantedAt, expiresAt: full.expiresAt, jobs: full.jobs.length, problem: (FULL_TOOLS.some((tool) => full.tools[tool]) ? fullRefusal(policy, ctx, FULL_TOOLS.find((tool) => full.tools[tool]) ?? 'files') : null) ?? '', mainModel: full.mainModel?.model ?? null },
    metaUnavailable,
    model: advisorModelNow(host),
    missions: missions.flatMap((mission) => {
      const text = missionAccess(self, mission);
      return text.length > 0 ? [{ missionId: mission.id, text }] : [];
    }),
    log: [...policy.log].reverse().slice(0, 30).map((entry) => ({ at: entry.at, provider: entry.provider, destination: entry.destination, reason: entry.reason, data: entry.data, approval: entry.approval, outcome: entry.outcome, bytes: entry.bytes })),
    inflight: inflightCount(),
  };
}

export type { ExternalApproval };

/** Why there is no advisor now, for a status. */
function advisorWhyNot(host: ProviderHost): string {
  try {
    const advisor = advisorFor(host);
    return advisor.ok ? 'it is available' : advisor.reason;
  } catch {
    return 'no advisor model is chosen';
  }
}
