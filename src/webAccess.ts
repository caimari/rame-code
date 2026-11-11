/**
 * Read-only web access for the Agent: one bounded search and one bounded
 * page read, nothing else.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * What a request may reach, checked on every hop:
 *   - http or https, no credentials in the URL, GET only, no cookies;
 *   - a hostname whose every DNS answer is a public address: loopback,
 *     private, link-local, CGNAT, multicast, documentation and other
 *     reserved ranges are refused (also as IPv4-mapped or NAT64 IPv6);
 *   - the connection goes to the very address that was checked (no second
 *     lookup the server could answer differently);
 *   - at most 4 redirects, each checked the same way; 15 s; 2 MiB read
 *     (compressed or not); text, HTML, JSON or XML only.
 *
 * What the agent may send out: a search query or a URL, refused when it
 * holds a secret-like value or a local path (see `egressRefusal`). Page
 * text comes back as untrusted data, never as instructions.
 */

import * as dns from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as zlib from 'node:zlib';

import { redactSecrets, scrubLocalPaths } from './cloudEgress.js';

export const WEB_TIMEOUT_MS = 15_000;
export const WEB_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_MAX_REDIRECTS = 4;
export const WEB_MAX_TEXT_CHARS = 20_000;
export const MAX_QUERY_CHARS = 300;
export const MAX_URL_CHARS = 2048;
const USER_AGENT = 'Mozilla/5.0 (compatible; RAME-Code/0.2; read-only agent web access)';

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return null;
  }
  return parts.map(Number);
}

function publicIpv4(ip: string): boolean {
  const p = ipv4Parts(ip);
  if (p === null) {
    return false;
  }
  const [a, b, c] = p as [number, number, number, number];
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** True only for a globally routable unicast address. */
export function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] as string;
  if (net.isIPv4(ip)) {
    return publicIpv4(ip);
  }
  if (!net.isIPv6(ip)) {
    return false;
  }
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) {
    return publicIpv4(mapped[1] as string);
  }
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1] as string, 16);
    const lo = parseInt(hexMapped[2] as string, 16);
    return publicIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (ip === '::' || ip === '::1') {
    return false;
  }
  const first = parseInt(ip.split(':')[0] || '0', 16);
  // Only 2000::/3 is global unicast; within it, documentation and NAT64 local use are refused.
  if (first < 0x2000 || first > 0x3fff) {
    return false;
  }
  return !/^2001:0?db8:/.test(ip) && !/^64:ff9b:1:/.test(ip);
}

export type CheckedUrl = { ok: true; url: URL } | { ok: false; error: string };

export function validateWebUrl(raw: string): CheckedUrl {
  if (raw.length === 0 || raw.length > MAX_URL_CHARS) {
    return { ok: false, error: `The URL must be 1 to ${MAX_URL_CHARS} characters.` };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https pages can be read.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'URLs with credentials are refused.' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0 && !isPublicAddress(host)) {
    return { ok: false, error: 'That address is local or private: web access only reaches the public internet.' };
  }
  if (net.isIP(host) === 0 && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || !host.includes('.'))) {
    return { ok: false, error: 'That host name is local: web access only reaches the public internet.' };
  }
  url.hash = '';
  return { ok: true, url };
}

export function validateSearxngUrl(raw: string): CheckedUrl {
  if (raw.length === 0) {
    return { ok: false, error: 'Enter the address of your SearXNG instance (with its JSON format enabled).' };
  }
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return { ok: false, error: 'The SearXNG address must be http(s) and carry no credentials.' };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, error: 'The SearXNG address is not a valid URL.' };
  }
}

/** Why a query or URL must not leave this computer, or null. */
export function egressRefusal(text: string): string | null {
  if (redactSecrets(text).found.length > 0) {
    return 'it contains something that looks like a key, token or password';
  }
  if (/(?:^|[\s"'=(])(?:\/(?:home|Users|root|etc|var|tmp|workspace|mnt|opt)\/|[A-Za-z]:\\|~\/|\\\\[^\\\s]+\\)/.test(decodeURIComponentSafe(text))) {
    return 'it contains a local file path';
  }
  return null;
}

/**
 * Under Full Access with web: the query that may leave without a card. Keys,
 * tokens and passwords are removed (never sent, never asked about), and the
 * user's home and project folders hidden; code, error text and other paths
 * stay, so a technical search still works. Empty when nothing is left.
 */
export function fullAccessQuery(text: string, folders: ReadonlyArray<readonly [string, string]>): string {
  const withoutSecrets = redactSecrets(text).text.replace(/\[redacted by RAME Code:[^\]]*\]/g, ' ');
  return scrubLocalPaths(withoutSecrets, folders).replace(/\s+/g, ' ').trim();
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const systemLookup: Lookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  redirects: string[];
}

export interface WebFetchOptions {
  signal?: AbortSignal;
  lookup?: Lookup;
  /** Origins the user configured themselves (their SearXNG) that may be private. */
  trustedOrigins?: readonly string[];
  /** Test seam: allow non-public addresses (never used by the product). */
  allowNonPublicForTests?: boolean;
  /** Only these hosts may be reached, on the first request and on every redirect (a Mission's authorized domains). */
  allowHost?: (host: string) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
}

const TEXTUAL = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript)|$)/i;

/** One bounded GET, following checked redirects. */
export async function safeFetch(rawUrl: string, options: WebFetchOptions = {}): Promise<{ ok: true; page: FetchedPage } | { ok: false; error: string }> {
  const lookup = options.lookup ?? systemLookup;
  const redirects: string[] = [];
  let current = rawUrl;
  for (let hop = 0; hop <= WEB_MAX_REDIRECTS; hop += 1) {
    const trusted = (() => {
      try {
        return (options.trustedOrigins ?? []).includes(new URL(current).origin);
      } catch {
        return false;
      }
    })();
    const checked = trusted || options.allowNonPublicForTests ? (() => {
      try {
        return { ok: true as const, url: new URL(current) };
      } catch {
        return { ok: false as const, error: 'That is not a valid URL.' };
      }
    })() : validateWebUrl(current);
    if (!checked.ok) {
      return checked;
    }
    const url = checked.url;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (options.allowHost && !options.allowHost(host)) {
      return { ok: false, error: `${host} is not one of the domains authorized for this run${redirects.length > 0 ? ' (reached by a redirect)' : ''}.` };
    }
    let address: { address: string; family: number };
    try {
      const answers = net.isIP(host) !== 0 ? [{ address: host, family: net.isIP(host) }] : await lookup(host);
      if (answers.length === 0) {
        return { ok: false, error: `${host} did not resolve.` };
      }
      if (!trusted && !options.allowNonPublicForTests && answers.some((answer) => !isPublicAddress(answer.address))) {
        return { ok: false, error: `${host} resolves to a local or private address: refused.` };
      }
      address = answers[0] as { address: string; family: number };
    } catch {
      return { ok: false, error: `${host} could not be resolved.` };
    }
    const response = await requestOnce(url, address, options);
    if (!response.ok) {
      return response;
    }
    const { status, location } = response;
    if (status >= 300 && status < 400 && location) {
      if (hop === WEB_MAX_REDIRECTS) {
        return { ok: false, error: `More than ${WEB_MAX_REDIRECTS} redirects.` };
      }
      try {
        current = new URL(location, url).toString();
      } catch {
        return { ok: false, error: 'The page redirected to an invalid URL.' };
      }
      redirects.push(current);
      continue;
    }
    if (status >= 400) {
      return { ok: false, error: `The server answered HTTP ${status}.` };
    }
    if (!TEXTUAL.test(response.contentType)) {
      return { ok: false, error: `That is not a text page (${response.contentType.slice(0, 60)}).` };
    }
    return { ok: true, page: { url: url.toString(), status, contentType: response.contentType, body: response.body, truncated: response.truncated, redirects } };
  }
  return { ok: false, error: 'Too many redirects.' };
}

function requestOnce(
  url: URL,
  address: { address: string; family: number },
  options: WebFetchOptions,
): Promise<{ ok: true; status: number; location: string | null; contentType: string; body: string; truncated: boolean } | { ok: false; error: string }> {
  const maxBytes = options.maxBytes ?? WEB_MAX_BYTES;
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ok: false, error: 'Stopped.' });
      return;
    }
    let settled = false;
    const finish = (value: Parameters<typeof resolve>[0]) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(value);
      }
    };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        // Connect to the address that was checked; TLS still verifies the host name.
        lookup: ((_host: string, opts: { all?: boolean }, callback: (error: Error | null, address: unknown, family?: number) => void) =>
          opts?.all ? callback(null, [{ address: address.address, family: address.family }]) : callback(null, address.address, address.family)) as unknown as net.LookupFunction,
        headers: { 'user-agent': USER_AGENT, accept: options.accept ?? 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en,es;q=0.8' },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = String(response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (status >= 300 && status < 400) {
          response.resume();
          finish({ ok: true, status, location: typeof response.headers.location === 'string' ? response.headers.location : null, contentType, body: '', truncated: false });
          return;
        }
        const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
        const stream =
          encoding === 'gzip' ? response.pipe(zlib.createGunzip()) : encoding === 'deflate' ? response.pipe(zlib.createInflate()) : encoding === 'br' ? response.pipe(zlib.createBrotliDecompress()) : response;
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on('data', (chunk: Buffer) => {
          if (truncated) {
            return;
          }
          size += chunk.length;
          if (size > maxBytes) {
            chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
            truncated = true;
            request.destroy();
            finish({ ok: true, status, location: null, contentType, body: Buffer.concat(chunks).toString('utf8'), truncated: true });
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () => finish({ ok: true, status, location: null, contentType, body: Buffer.concat(chunks).toString('utf8'), truncated }));
        stream.on('error', () => finish({ ok: false, error: 'The page could not be read (bad compression or a dropped connection).' }));
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish({ ok: false, error: `No complete answer within ${Math.round((options.timeoutMs ?? WEB_TIMEOUT_MS) / 1000)} s.` });
    }, options.timeoutMs ?? WEB_TIMEOUT_MS);
    const onAbort = () => {
      request.destroy();
      finish({ ok: false, error: 'Stopped.' });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    request.on('error', (error) => finish({ ok: false, error: `The connection failed (${(error as NodeJS.ErrnoException).code ?? 'error'}).` }));
    request.end();
  });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Readable text of an HTML page: no scripts, styles or markup. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim()).slice(0, 300);
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(?:p|div|tr|h[1-6]|section|article|pre|blockquote|table|ul|ol)\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n${'#'.repeat(Number(level))} `)
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Results of DuckDuckGo's HTML endpoint (no key). */
export function parseDuckDuckGoHtml(html: string, max = 8): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ?? /<a[^>]+href="([^"]+)"[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) {
      continue;
    }
    let href = decodeEntities(link[1] as string);
    const wrapped = /[?&]uddg=([^&]+)/.exec(href);
    if (wrapped) {
      href = decodeURIComponentSafe(wrapped[1] as string);
    } else if (href.startsWith('//')) {
      href = `https:${href}`;
    }
    if (!/^https?:\/\//i.test(href) || /duckduckgo\.com\/y\.js/.test(href)) {
      continue; // ads and internal links
    }
    const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(block)?.[1] ?? '';
    results.push({ title: htmlToText(link[2] as string).text.slice(0, 200), url: href.slice(0, MAX_URL_CHARS), snippet: htmlToText(snippet).text.slice(0, 400) });
    if (results.length >= max) {
      break;
    }
  }
  return results;
}

export function parseSearxngJson(text: string, max = 8): SearchResult[] {
  try {
    const data = JSON.parse(text) as { results?: unknown };
    return (Array.isArray(data.results) ? data.results : []).flatMap((raw) => {
      const entry = raw as Record<string, unknown>;
      return typeof entry?.url === 'string' && /^https?:\/\//.test(entry.url)
        ? [{ title: String(entry.title ?? '').slice(0, 200), url: entry.url.slice(0, MAX_URL_CHARS), snippet: String(entry.content ?? '').slice(0, 400) }]
        : [];
    }).slice(0, max);
  } catch {
    return [];
  }
}

export async function webSearch(
  query: string,
  settings: { search: 'duckduckgo' | 'searxng'; searxngUrl: string },
  options: WebFetchOptions & { max?: number } = {},
): Promise<{ ok: true; engine: string; results: SearchResult[] } | { ok: false; error: string }> {
  const max = options.max ?? 8;
  if (settings.search === 'searxng') {
    const base = validateSearxngUrl(settings.searxngUrl);
    if (!base.ok) {
      return base;
    }
    const url = new URL('search', base.url.toString().endsWith('/') ? base.url : new URL(`${base.url.toString()}/`));
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const fetched = await safeFetch(url.toString(), { ...options, trustedOrigins: [base.url.origin], accept: 'application/json' });
    return fetched.ok ? { ok: true, engine: 'SearXNG', results: parseSearxngJson(fetched.page.body, max) } : fetched;
  }
  const fetched = await safeFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, options);
  return fetched.ok ? { ok: true, engine: 'DuckDuckGo', results: parseDuckDuckGoHtml(fetched.page.body, max) } : fetched;
}
