/**
 * Web access granted to one Mission: how many searches and page reads its
 * internal runs may make, and, optionally, which domains they may read.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * The budget is part of the Mission grant (bound to that Mission, project,
 * local model and grant), chosen by the user before authorizing, counted by
 * the host before each request and never raised by the model or by any web
 * content. Web access never widens anything else: no write, terminal, memory
 * or file permission comes with it. OFF unless the user turns it on.
 *
 * Because an autonomous Mission does not ask before each request, what can
 * leave the computer is narrowed further than in Agent or Chat:
 *   - a query must be plain words: no line breaks, no code-like punctuation,
 *     at most 200 characters, besides the usual secret and path checks;
 *   - a page can be read only if its URL came from a search of this Mission
 *     or its domain is one the user authorized; with authorized domains,
 *     every redirect must stay inside them too.
 */

export interface MissionWebGrant {
  maxSearches: number;
  maxFetches: number;
  /** Authorized domains for page reads (and their subdomains); empty = any public site found by a search. */
  domains: string[];
  /** Used so far, counted by the host before each request. */
  searches: number;
  fetches: number;
}

export const MISSION_WEB_MAX_SEARCHES = 20;
export const MISSION_WEB_MAX_FETCHES = 40;
export const MISSION_WEB_MAX_DOMAINS = 10;
export const MISSION_QUERY_MAX_CHARS = 200;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface MissionWebRequest {
  enabled: boolean;
  maxSearches: number;
  maxFetches: number;
  domains: string[];
}

export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '').replace(/\.$/, '');
}

/** Validate what the user chose; null grant when web access stays off. */
export function validateMissionWebRequest(request: MissionWebRequest): { ok: true; grant: MissionWebGrant | null } | { ok: false; error: string } {
  if (!request.enabled) {
    return { ok: true, grant: null };
  }
  const inRange = (value: number, max: number) => Number.isInteger(value) && value >= 0 && value <= max;
  if (!inRange(request.maxSearches, MISSION_WEB_MAX_SEARCHES) || !inRange(request.maxFetches, MISSION_WEB_MAX_FETCHES) || request.maxSearches + request.maxFetches === 0) {
    return { ok: false, error: `Mission web access needs 0 to ${MISSION_WEB_MAX_SEARCHES} searches and 0 to ${MISSION_WEB_MAX_FETCHES} page reads, and at least one of them.` };
  }
  const domains = [...new Set(request.domains.map(normalizeDomain).filter((domain) => domain.length > 0))];
  if (domains.length > MISSION_WEB_MAX_DOMAINS || domains.some((domain) => !DOMAIN.test(domain))) {
    return { ok: false, error: `Authorized domains must be up to ${MISSION_WEB_MAX_DOMAINS} names such as nodejs.org or docs.python.org.` };
  }
  return { ok: true, grant: { maxSearches: request.maxSearches, maxFetches: request.maxFetches, domains, searches: 0, fetches: 0 } };
}

/** A stored grant, validated; `undefined` when malformed (the whole grant is refused). */
export function parseMissionWebGrant(raw: unknown): MissionWebGrant | null | undefined {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const v = raw as Record<string, unknown>;
  const count = (value: unknown, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
  if (
    !count(v.maxSearches, MISSION_WEB_MAX_SEARCHES) ||
    !count(v.maxFetches, MISSION_WEB_MAX_FETCHES) ||
    !count(v.searches, MISSION_WEB_MAX_SEARCHES) ||
    !count(v.fetches, MISSION_WEB_MAX_FETCHES) ||
    (v.searches as number) > (v.maxSearches as number) ||
    (v.fetches as number) > (v.maxFetches as number) ||
    !Array.isArray(v.domains) ||
    v.domains.length > MISSION_WEB_MAX_DOMAINS ||
    !v.domains.every((domain) => typeof domain === 'string' && DOMAIN.test(domain))
  ) {
    return undefined;
  }
  return { maxSearches: v.maxSearches as number, maxFetches: v.maxFetches as number, domains: [...(v.domains as string[])], searches: v.searches as number, fetches: v.fetches as number };
}

/** Whether a host belongs to an authorized domain (or one of its subdomains). */
export function domainAllowed(host: string, domains: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return domains.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/**
 * Why a Mission's search query must not leave this computer, beyond the
 * secret and path checks every web call has. A Mission does not ask before
 * each request, so a query must look like a search, not like project data.
 */
export function missionQueryRefusal(query: string): string | null {
  if (query.length > MISSION_QUERY_MAX_CHARS) {
    return `a Mission query is limited to ${MISSION_QUERY_MAX_CHARS} characters`;
  }
  if (/[\r\n]/.test(query)) {
    return 'it spans several lines';
  }
  if (/[{};<>`]|=>|==|\b(?:function|const|let|var|import|class|def|return)\b\s*[\w(]/.test(query)) {
    return 'it looks like code; a Mission searches with plain words only';
  }
  if (/["'][^"']{60,}["']/.test(query)) {
    return 'it quotes a long passage; a Mission searches with plain words only';
  }
  return null;
}

export function describeMissionWeb(grant: MissionWebGrant | null | undefined): string {
  if (!grant) {
    return 'web access: off';
  }
  return `web access: up to ${grant.maxSearches} search(es) and ${grant.maxFetches} page read(s); pages ${grant.domains.length > 0 ? `only on ${grant.domains.join(', ')}` : 'only from this Mission\'s search results'}; used ${grant.searches} search(es) and ${grant.fetches} read(s)`;
}

/** The user's choice in the authorization card, kept per window until the Mission is authorized. */
const requests = new WeakMap<object, Map<string, MissionWebRequest>>();

export function recordMissionWebRequest(host: object, missionId: string, request: MissionWebRequest): void {
  const byMission = requests.get(host) ?? new Map<string, MissionWebRequest>();
  byMission.set(missionId, request);
  requests.set(host, byMission);
}

export function takeMissionWebRequest(host: object, missionId: string): MissionWebRequest | null {
  const byMission = requests.get(host);
  const request = byMission?.get(missionId) ?? null;
  byMission?.delete(missionId);
  return request;
}

/** URLs a Mission's searches returned: the only pages it may read when no domain is authorized. */
const found = new Map<string, Set<string>>();

export function rememberSearchResults(missionId: string, urls: readonly string[]): void {
  const set = found.get(missionId) ?? new Set<string>();
  for (const url of urls.slice(0, 50)) {
    set.add(canonicalUrl(url));
  }
  found.set(missionId, set);
}

export function cameFromSearch(missionId: string, url: string): boolean {
  return found.get(missionId)?.has(canonicalUrl(url)) === true;
}

function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

/** Host-record lines without web searches and page reads: what may go to Meta with a consultation. */
export function withoutWebLines(lines: readonly string[]): string[] {
  return lines.filter((line) => !/\bweb_(?:search|fetch)\b/.test(line));
}
