/**
 * Messages of the Autonomy & Permissions section and what the view shows
 * of it. Every message only asks: the host validates it, and nothing is
 * pre-authorized without the host's modal confirmation.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 */

import { FULL_TOOLS, FULL_VALIDITY_HOURS, META_MAX_CHOICES, META_TOKEN_BUDGETS, VALIDITY_HOURS, type AutonomyMode, type FullTools } from './autonomyPolicy.js';

export type AutonomyMessage =
  | { type: 'autonomyMode'; mode: Exclude<AutonomyMode, 'full'> }
  | { type: 'autonomyMeta'; maxPerMission: number | null; validityHours: number; dataScope: 'instructions' | 'files'; tokenBudget?: number | null }
  /** With its Meta part, the Meta limits come in the same request (one confirmation): -1 / 0 on the wire as for autonomyMeta. */
  | { type: 'autonomyFull'; tools: FullTools; validityHours: number; meta?: FullMetaChoice; metaMain?: true }
  | { type: 'autonomyMissionWeb'; validityHours: number }
  | { type: 'autonomySessionWeb'; maxSearches: number; maxFetches: number; domains: string[]; validityHours: number }
  | { type: 'autonomyRevoke'; what: 'meta' | 'missionWeb' | 'sessionWeb' | 'full' | 'all' }
  | { type: 'missionMetaScopeSet'; missionId: string; files: string[] }
  | { type: 'autonomyRefresh' };

export const AUTONOMY_MESSAGE_TYPES: readonly string[] = ['autonomyMode', 'autonomyMeta', 'autonomyFull', 'autonomyMissionWeb', 'autonomySessionWeb', 'autonomyRevoke', 'missionMetaScopeSet', 'autonomyRefresh'];

function exact(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

const int = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const hours = (value: unknown): value is number => typeof value === 'number' && VALIDITY_HOURS.includes(value);
const names = (value: unknown, max: number, len: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === 'string' && entry.length <= len);

/** The Meta limits a user chooses: count per Mission (or conversation), data scope and total token budget. */
export interface FullMetaChoice {
  maxPerMission: number | null;
  dataScope: 'instructions' | 'files';
  tokenBudget: number | null;
}

/** On the wire, -1 is "no count limit" and 0 (or no field) "no total token budget"; only the listed choices. */
function metaChoice(record: Record<string, unknown>): FullMetaChoice | null {
  const max = record.maxPerMission === -1 ? null : record.maxPerMission;
  const budget = record.tokenBudget === undefined || record.tokenBudget === 0 ? null : record.tokenBudget;
  const count = max === null || (int(max, 1, 1000) && ((max as number) <= 5 || META_MAX_CHOICES.includes(max as number)));
  return count && (record.dataScope === 'instructions' || record.dataScope === 'files') && META_TOKEN_BUDGETS.includes(budget as number | null)
    ? { maxPerMission: max as number | null, dataScope: record.dataScope, tokenBudget: budget as number | null }
    : null;
}

/** Parse one of these messages; null when the type is not one of them; throws when malformed. */
export function parseAutonomyMessage(record: Record<string, unknown>): AutonomyMessage | null {
  const bad = (): never => {
    throw new Error(`Invalid ${String(record.type)} message.`);
  };
  switch (record.type) {
    case 'autonomyMode':
      return exact(record, ['type', 'mode']) && (record.mode === 'ask' || record.mode === 'supervised') ? { type: 'autonomyMode', mode: record.mode } : bad();
    case 'autonomyMeta': {
      const keys = exact(record, ['type', 'maxPerMission', 'validityHours', 'dataScope']) || exact(record, ['type', 'maxPerMission', 'validityHours', 'dataScope', 'tokenBudget']);
      const choice = metaChoice(record);
      return keys && choice !== null && hours(record.validityHours) ? { type: 'autonomyMeta', ...choice, validityHours: record.validityHours as number } : bad();
    }
    case 'autonomyFull': {
      const tools = record.tools as Record<string, unknown> | undefined;
      // "Meta as the main model" is its own choice: present only as true, never implied by a tool part.
      const metaMain = Object.prototype.hasOwnProperty.call(record, 'metaMain');
      if (metaMain && record.metaMain !== true) {
        return bad();
      }
      const valid = typeof record.validityHours === 'number' && FULL_VALIDITY_HOURS.includes(record.validityHours) && typeof tools === 'object' && tools !== null && !Array.isArray(tools) &&
        exact(tools, FULL_TOOLS) && FULL_TOOLS.every((name) => typeof tools[name] === 'boolean') && (metaMain || FULL_TOOLS.some((name) => tools[name] === true));
      if (!valid) {
        return bad();
      }
      const keys = ['type', 'tools', 'validityHours', ...(metaMain ? ['metaMain'] : [])];
      const parsed = { type: 'autonomyFull' as const, tools: Object.fromEntries(FULL_TOOLS.map((name) => [name, tools[name] === true])) as FullTools, validityHours: record.validityHours as number, ...(metaMain ? { metaMain: true as const } : {}) };
      // Its Meta part needs its limits, and only it has them.
      if (tools.meta !== true) {
        return exact(record, keys) ? parsed : bad();
      }
      const meta = record.meta as Record<string, unknown> | undefined;
      const choice = exact(record, [...keys, 'meta']) && typeof meta === 'object' && meta !== null && !Array.isArray(meta) && exact(meta, ['maxPerMission', 'dataScope', 'tokenBudget']) ? metaChoice(meta) : null;
      return choice !== null ? { ...parsed, meta: choice } : bad();
    }
    case 'autonomyMissionWeb':
      return exact(record, ['type', 'validityHours']) && hours(record.validityHours) ? { type: 'autonomyMissionWeb', validityHours: record.validityHours } : bad();
    case 'autonomySessionWeb':
      return exact(record, ['type', 'maxSearches', 'maxFetches', 'domains', 'validityHours']) && int(record.maxSearches, 0, 100) && int(record.maxFetches, 0, 100) && names(record.domains, 20, 253) && hours(record.validityHours)
        ? { type: 'autonomySessionWeb', maxSearches: record.maxSearches, maxFetches: record.maxFetches, domains: [...record.domains], validityHours: record.validityHours }
        : bad();
    case 'autonomyRevoke':
      return exact(record, ['type', 'what']) && ['meta', 'missionWeb', 'sessionWeb', 'full', 'all'].includes(record.what as string)
        ? { type: 'autonomyRevoke', what: record.what as 'meta' | 'missionWeb' | 'sessionWeb' | 'full' | 'all' }
        : bad();
    case 'missionMetaScopeSet':
      return exact(record, ['type', 'missionId', 'files']) && typeof record.missionId === 'string' && /^mis_[0-9a-f]{24}$/.test(record.missionId) && names(record.files, 8, 600)
        ? { type: 'missionMetaScopeSet', missionId: record.missionId, files: [...record.files] }
        : bad();
    case 'autonomyRefresh':
      return exact(record, ['type']) ? { type: 'autonomyRefresh' } : bad();
    default:
      return null;
  }
}

export interface AutonomyView {
  project: string | null;
  /** Where operations run: this computer, a Remote SSH server, … */
  env: string;
  note: string;
  mode: AutonomyMode;
  meta: { model: string; maxPerMission: number | null; dataScope: 'instructions' | 'files'; grantedAt: number; expiresAt: number; tokenBudget: number | null; usedTokens: number; problem: string } | null;
  full: { tools: FullTools; grantedAt: number; expiresAt: number; jobs: number; problem: string; mainModel?: string | null } | null;
  missionWeb: { grantedAt: number; expiresAt: number; problem: string } | null;
  sessionWeb: { maxSearches: number; maxFetches: number; searches: number; fetches: number; domains: string[]; expiresAt: number } | null;
  /** '' when Meta can be pre-authorized now; otherwise why not. */
  metaUnavailable: string;
  model: string;
  /** Pre-authorized external access of each Mission of this workspace that has some. */
  missions: Array<{ missionId: string; text: string }>;
  log: Array<{ at: number; provider: string; destination: string; reason: string; data: string; approval: string; outcome: string; bytes: number | null }>;
  inflight: number;
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const obj = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

export function sanitizeAutonomyView(value: unknown): AutonomyView | null {
  const v = obj(value);
  if (v === null) {
    return null;
  }
  const meta = obj(v.meta);
  const missionWeb = obj(v.missionWeb);
  const session = obj(v.sessionWeb);
  const full = obj(v.full);
  const tools = obj(full?.tools);
  return {
    project: typeof v.project === 'string' ? v.project.slice(0, 200) : null,
    env: text(v.env, 300),
    note: text(v.note, 400),
    mode: v.mode === 'supervised' || v.mode === 'full' ? v.mode : 'ask',
    meta: meta === null ? null : {
      model: text(meta.model, 128), maxPerMission: meta.maxPerMission === null ? null : num(meta.maxPerMission), dataScope: meta.dataScope === 'files' ? 'files' : 'instructions', grantedAt: num(meta.grantedAt), expiresAt: num(meta.expiresAt),
      tokenBudget: meta.tokenBudget === null || meta.tokenBudget === undefined ? null : num(meta.tokenBudget), usedTokens: num(meta.usedTokens), problem: text(meta.problem, 300),
    },
    full: full === null ? null : {
      tools: Object.fromEntries(FULL_TOOLS.map((name) => [name, tools?.[name] === true])) as FullTools, grantedAt: num(full.grantedAt), expiresAt: num(full.expiresAt), jobs: num(full.jobs), problem: text(full.problem, 300), mainModel: typeof full.mainModel === 'string' && /^muse-[A-Za-z0-9._-]{1,120}$/.test(full.mainModel) ? full.mainModel : null,
    },
    missionWeb: missionWeb === null ? null : { grantedAt: num(missionWeb.grantedAt), expiresAt: num(missionWeb.expiresAt), problem: text(missionWeb.problem, 300) },
    sessionWeb: session === null ? null : {
      maxSearches: num(session.maxSearches), maxFetches: num(session.maxFetches), searches: num(session.searches), fetches: num(session.fetches),
      domains: (Array.isArray(session.domains) ? session.domains : []).slice(0, 10).map((entry) => text(entry, 253)), expiresAt: num(session.expiresAt),
    },
    metaUnavailable: text(v.metaUnavailable, 300),
    model: text(v.model, 128),
    missions: (Array.isArray(v.missions) ? v.missions : []).slice(0, 16).flatMap((raw) => {
      const entry = obj(raw);
      return entry && typeof entry.missionId === 'string' ? [{ missionId: entry.missionId.slice(0, 64), text: text(entry.text, 400) }] : [];
    }),
    log: (Array.isArray(v.log) ? v.log : []).slice(0, 30).flatMap((raw) => {
      const entry = obj(raw);
      return entry === null ? [] : [{
        at: num(entry.at), provider: text(entry.provider, 80), destination: text(entry.destination, 200), reason: text(entry.reason, 300), data: text(entry.data, 400),
        approval: text(entry.approval, 40), outcome: text(entry.outcome, 300), bytes: typeof entry.bytes === 'number' ? num(entry.bytes) : null,
      }];
    }),
    inflight: num(v.inflight),
  };
}
