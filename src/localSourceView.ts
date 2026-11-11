/**
 * What the view is shown about external model servers and web access, and
 * the messages it may send about them. Pure validation in both directions.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 */

import type { LocalServerKind } from './localServers.js';

export interface LocalSourceModelView {
  id: string;
  tools: boolean | null;
  vision: boolean | null;
  loadedContext: number | null;
  maxContext: number | null;
  loaded: boolean;
  agent: boolean;
  note: string;
}

export interface LocalSourceView {
  /** The external server in use ('' = none) and the model chosen on it. */
  endpoint: string;
  model: string;
  kind: LocalServerKind | '';
  lan: boolean;
  scan: { endpoint: string; kind: LocalServerKind; scope: 'loopback' | 'private'; version: string; models: LocalSourceModelView[] } | null;
  scanError: string;
  web: { enabled: boolean; search: 'duckduckgo' | 'searxng'; searxngUrl: string };
  /** Terminal commands: on or off, the isolation level, and why it cannot be applied here ('' = it can; null = not checked yet). */
  shell: { enabled: boolean; isolation: 'total' | 'project' | 'closed'; problem: string | null };
  /** The advisor model for the main model selected now, and every catalog model with whether it may advise it. */
  advisor: { selected: string; main: string; mainProvider: 'local' | 'cloud'; options: Array<{ id: string; eligible: boolean; reason: string }>; problem: string };
}

export type LocalSourceMessage =
  | { type: 'localServerScan'; endpoint: string }
  | { type: 'localServerUse'; endpoint: string; model: string; lan: boolean }
  | { type: 'webAccessSet'; enabled: boolean; search: 'duckduckgo' | 'searxng'; searxngUrl: string }
  | { type: 'shellAccessSet'; enabled: boolean; isolation?: 'total' | 'project' | 'closed' }
  | { type: 'advisorModelSet'; model: string }
  | { type: 'missionRunsSet'; missionId: string; runsPerTask: number }
  | { type: 'missionWebSet'; missionId: string; enabled: boolean; maxSearches: number; maxFetches: number; domains: string[] }
  /** Check the identity of the local server in use, or compute / cancel the SHA-256 of the managed GGUF. */
  | { type: 'localIdentity'; action: 'check' | 'hash' | 'cancel-hash' };

const KINDS: readonly string[] = ['ollama', 'lmstudio', 'llama-server', 'openai-compatible'];
const MODEL_ID = /^[\w.:@/+-]{1,200}$/;

function exact(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

/** Parse one of these messages; null when the type is not one of them; throws when malformed. */
export function parseLocalSourceMessage(record: Record<string, unknown>): LocalSourceMessage | null {
  const url = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
  switch (record.type) {
    case 'localServerScan':
      if (!exact(record, ['type', 'endpoint']) || !url(record.endpoint)) {
        throw new Error('Invalid localServerScan message.');
      }
      return { type: 'localServerScan', endpoint: record.endpoint };
    case 'localServerUse':
      if (!exact(record, ['type', 'endpoint', 'model', 'lan']) || !url(record.endpoint) || typeof record.model !== 'string' || !MODEL_ID.test(record.model) || typeof record.lan !== 'boolean') {
        throw new Error('Invalid localServerUse message.');
      }
      return { type: 'localServerUse', endpoint: record.endpoint, model: record.model, lan: record.lan };
    case 'webAccessSet':
      if (
        !exact(record, ['type', 'enabled', 'search', 'searxngUrl']) ||
        typeof record.enabled !== 'boolean' ||
        (record.search !== 'duckduckgo' && record.search !== 'searxng') ||
        typeof record.searxngUrl !== 'string' ||
        record.searxngUrl.length > 512
      ) {
        throw new Error('Invalid webAccessSet message.');
      }
      return { type: 'webAccessSet', enabled: record.enabled, search: record.search, searxngUrl: record.searxngUrl };
    case 'missionWebSet': {
      const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
      if (
        !exact(record, ['type', 'missionId', 'enabled', 'maxSearches', 'maxFetches', 'domains']) ||
        typeof record.missionId !== 'string' || !/^mis_[0-9a-f]{24}$/.test(record.missionId) ||
        typeof record.enabled !== 'boolean' || !count(record.maxSearches) || !count(record.maxFetches) ||
        !Array.isArray(record.domains) || record.domains.length > 20 || !record.domains.every((domain) => typeof domain === 'string' && domain.length <= 255)
      ) {
        throw new Error('Invalid missionWebSet message.');
      }
      return { type: 'missionWebSet', missionId: record.missionId, enabled: record.enabled, maxSearches: record.maxSearches as number, maxFetches: record.maxFetches as number, domains: [...(record.domains as string[])] };
    }
    case 'localIdentity':
      if (!exact(record, ['type', 'action']) || (record.action !== 'check' && record.action !== 'hash' && record.action !== 'cancel-hash')) {
        throw new Error('Invalid localIdentity message.');
      }
      return { type: 'localIdentity', action: record.action };
    case 'shellAccessSet': {
      const levels = ['total', 'project', 'closed'];
      const withLevel = exact(record, ['type', 'enabled', 'isolation']) && levels.includes(record.isolation as string);
      if ((!exact(record, ['type', 'enabled']) && !withLevel) || typeof record.enabled !== 'boolean') {
        throw new Error('Invalid shellAccessSet message.');
      }
      return withLevel ? { type: 'shellAccessSet', enabled: record.enabled, isolation: record.isolation as 'total' | 'project' | 'closed' } : { type: 'shellAccessSet', enabled: record.enabled };
    }
    case 'missionRunsSet':
      if (!exact(record, ['type', 'missionId', 'runsPerTask']) || typeof record.missionId !== 'string' || !/^mis_[a-z0-9]{1,64}$/.test(record.missionId) || !Number.isInteger(record.runsPerTask) || (record.runsPerTask as number) < 1 || (record.runsPerTask as number) > 8) {
        throw new Error('Invalid missionRunsSet message.');
      }
      return { type: 'missionRunsSet', missionId: record.missionId, runsPerTask: record.runsPerTask as number };
    case 'advisorModelSet':
      if (!exact(record, ['type', 'model']) || typeof record.model !== 'string' || !/^(?:|muse-[A-Za-z0-9._-]{1,120})$/.test(record.model)) {
        throw new Error('Invalid advisorModelSet message.');
      }
      return { type: 'advisorModelSet', model: record.model };
    default:
      return null;
  }
}

const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const size = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 10_000_000 ? value : null);
const kind = (value: unknown): LocalServerKind | '' => (typeof value === 'string' && KINDS.includes(value) ? (value as LocalServerKind) : '');

export function sanitizeLocalSourceView(value: unknown): LocalSourceView | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const scan = typeof v.scan === 'object' && v.scan !== null ? (v.scan as Record<string, unknown>) : null;
  const web = typeof v.web === 'object' && v.web !== null ? (v.web as Record<string, unknown>) : {};
  return {
    endpoint: text(v.endpoint, 512),
    model: text(v.model, 200),
    kind: kind(v.kind),
    lan: v.lan === true,
    scan:
      scan === null || kind(scan.kind) === ''
        ? null
        : {
            endpoint: text(scan.endpoint, 512),
            kind: kind(scan.kind) as LocalServerKind,
            scope: scan.scope === 'private' ? 'private' : 'loopback',
            version: text(scan.version, 40),
            models: (Array.isArray(scan.models) ? scan.models : []).slice(0, 80).flatMap((raw) => {
              const m = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
              return m === null || typeof m.id !== 'string' || !MODEL_ID.test(m.id)
                ? []
                : [{ id: m.id, tools: flag(m.tools), vision: flag(m.vision), loadedContext: size(m.loadedContext), maxContext: size(m.maxContext), loaded: m.loaded === true, agent: m.agent === true, note: text(m.note, 400) }];
            }),
          },
    scanError: text(v.scanError, 400),
    web: { enabled: web.enabled === true, search: web.search === 'searxng' ? 'searxng' : 'duckduckgo', searxngUrl: text(web.searxngUrl, 512) },
    shell: sanitizeShell(v.shell),
    advisor: sanitizeAdvisor(v.advisor),
  };
}

function sanitizeShell(raw: unknown): LocalSourceView['shell'] {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const isolation = v.isolation === 'total' || v.isolation === 'closed' ? v.isolation : 'project';
  return { enabled: v.enabled === true, isolation, problem: typeof v.problem === 'string' ? v.problem.slice(0, 300) : null };
}

function sanitizeAdvisor(raw: unknown): LocalSourceView['advisor'] {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const id = (value: unknown): string => (typeof value === 'string' && /^muse-[A-Za-z0-9._-]{1,120}$/.test(value) ? value : '');
  const words = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
  return {
    selected: id(v.selected),
    main: words(v.main, 200),
    mainProvider: v.mainProvider === 'cloud' ? 'cloud' : 'local',
    options: (Array.isArray(v.options) ? v.options : []).slice(0, 100).flatMap((entry) => {
      const o = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null;
      return o === null || id(o.id) === '' ? [] : [{ id: id(o.id), eligible: o.eligible === true, reason: words(o.reason, 300) }];
    }),
    problem: words(v.problem, 300),
  };
}
