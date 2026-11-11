/**
 * The last check before anything reaches Meta: the request RAME actually
 * built, after every selection and recovery, not the plan for it.
 *
 * - A request that would carry a local-session message the user has not
 *   disclosed (or a host note) is stopped; nothing is sent.
 * - Absolute paths of the open project folders and of the user's home folder
 *   are replaced in every message.
 * - Agent tool results are sent only when this session allows them (or the
 *   user approved a delegated run, whose card lists them); otherwise the
 *   result is replaced by a note. Values that look like secrets are redacted
 *   from the results that are sent, and Activity says so.
 *
 * It complements the disclosure card (cloudDisclosure.ts): the card decides
 * what may go; this module checks what is about to go.
 */

import * as os from 'node:os';

import type { AgentChatMessage } from './agentModel.js';
import { cloudVisibleThread, protectedLocalTexts, threadDisclosure } from './cloudDisclosure.js';
import { runScope } from './cloudScope.js';
import { MetaAgentModelProvider, type AgentModelProvider } from './modelProviders/agentProvider.js';
import type { ProviderHost } from './providerTypes.js';
import { RAME_AUDIT_KEY } from './settingsStore.js';

export class CloudEgressBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudEgressBlocked';
  }
}

export const TOOL_RESULTS_WITHHELD =
  'Withheld by RAME Code: the user has not allowed tool results (file contents, searches, test output) to be sent to Meta in this thread for this session. The tool ran locally; continue without its output or ask the user.';

const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['API key', /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g],
];
/** The password part of a URL with credentials (postgres://user:password@host). */
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi;
/** The value of a name that suggests a secret (`DB_PASSWORD=…`, `custom-auth: …`). */
const SECRET_ASSIGNMENT = /\b[A-Za-z0-9_.-]*(?:secret|token|password|passwd|pwd|api[_-]?key|private[_-]?key|credential|auth|cookie|session)[A-Za-z0-9_.-]*\s*[:=]\s*["']?([^\s"',;]{8,})/gi;

/**
 * Redact values that look like secrets, in one pass over the original text:
 * every pattern marks a range, overlapping ranges merge, and each merged
 * range becomes one well-formed marker. Pattern-based: it reduces, but cannot
 * exclude, secrets in what is sent; it may also redact harmless values.
 */
export function redactSecrets(text: string): { text: string; found: string[] } {
  const ranges: Array<{ start: number; end: number; kind: string }> = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      ranges.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, kind });
    }
  }
  for (const [kind, pattern] of [['URL credentials', URL_CREDENTIALS], ['secret value', SECRET_ASSIGNMENT]] as const) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] as string;
      const start = (match.index ?? 0) + match[0].lastIndexOf(value);
      ranges.push({ start, end: start + value.length, kind });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number; kinds: string[] }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start < last.end) {
      last.end = Math.max(last.end, range.end);
      if (!last.kinds.includes(range.kind)) {
        last.kinds.push(range.kind);
      }
    } else {
      merged.push({ start: range.start, end: range.end, kinds: [range.kind] });
    }
  }
  let out = text;
  for (const range of [...merged].reverse()) {
    out = `${out.slice(0, range.start)}[redacted by RAME Code: ${range.kinds.join(', ')}]${out.slice(range.end)}`;
  }
  return { text: out, found: merged.flatMap((range) => range.kinds) };
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A few spread windows of a protected text: enough to catch any excerpt of it. */
function windows(text: string): string[] {
  const clean = normalized(text);
  if (clean.length < 24) {
    return [];
  }
  if (clean.length <= 64) {
    return [clean];
  }
  const size = 48;
  const last = clean.length - size;
  return [0, Math.floor(last / 4), Math.floor(last / 2), Math.floor((3 * last) / 4), last].map((start) => clean.slice(start, start + size));
}

/** Absolute local paths to keep out of a Meta request, longest first. */
function localPaths(host: ProviderHost, root: string | undefined): Array<readonly [string, string]> {
  const paths: Array<readonly [string, string]> = [];
  for (const folder of host.listOpenWorkspaceFolders()) {
    paths.push([folder.path, '<project folder>']);
  }
  if (root) {
    paths.push([root, '<project folder>']);
  }
  const home = os.homedir();
  if (home.length > 3) {
    paths.push([home, '~']);
  }
  return paths.filter(([path]) => path.length > 3).sort((a, b) => b[0].length - a[0].length);
}

/** A Windows path (drive letter or UNC): matched without case and with either separator. */
function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
}

/**
 * Replace each known absolute path where it stands as a whole path or a
 * path prefix: `C:\Users\ana` is replaced in `c:/users/ana/x` but not in
 * `C:\Users\anabel`. Windows paths ignore case and accept `\`, `/`, or
 * doubled separators (as in JSON strings); POSIX paths are case-sensitive.
 * Only the paths given are replaced: an absolute path to anywhere else, in
 * content the user allowed, is sent as it is.
 */
export function scrubLocalPaths(text: string, paths: ReadonlyArray<readonly [string, string]>): string {
  let out = text;
  for (const [path, label] of paths) {
    const windows = isWindowsPath(path);
    const parts = path.replace(/[\\/]+$/, '').split(/[\\/]+/);
    const lead = windows && /^[\\/]{2}/.test(path) ? '(?:\\\\{1,2}|/){2}' : path.startsWith('/') ? '/' : '';
    const body = parts.filter((part) => part.length > 0).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(windows ? '(?:\\\\{1,2}|/)' : '/');
    if (body.length === 0) {
      continue;
    }
    // A dot right after the path ends it when nothing of a name follows (the end of a sentence: "in /home/ana/shop."),
    // while "/home/ana/shop.bak" is another path and stays as it is.
    const pattern = new RegExp(`(?<![A-Za-z0-9._~-])${lead}${body}(?![A-Za-z0-9_~-]|\\.[A-Za-z0-9_~-])`, windows ? 'gi' : 'g');
    out = out.replace(pattern, label);
  }
  return out;
}

function note(host: ProviderHost, threadId: string, result: string): void {
  // One note per run and kind (its first word), kept current: a new note at every model step would only accumulate.
  const kind = result.split(' ')[0];
  const shown = host.agentLogView.findIndex((entry) => entry.tool === 'meta_privacy' && entry.result.split(' ')[0] === kind);
  if (shown !== -1) {
    host.agentLogView = host.agentLogView.map((entry, index) => (index === shown ? { ...entry, result } : entry));
    return;
  }
  const entry = host.audit.append({
    provider: 'cloud',
    threadId,
    profile: host.settings.agentProfile,
    tool: 'meta_privacy',
    digest: '0'.repeat(64),
    decision: 'policy',
    result,
  });
  void host.extensionState.update(RAME_AUDIT_KEY, host.audit.list());
  host.agentLogView = [...host.agentLogView, { tool: entry.tool, digest: entry.digest.slice(0, 16), decision: entry.decision, result: entry.result }].slice(-20);
}

/**
 * Check and prepare the messages of one Meta request. Throws
 * {@link CloudEgressBlocked} (nothing is sent) when they would carry local
 * content the user has not disclosed.
 */
export function guardCloudMessages<T extends { role: string; content: string | null }>(
  host: ProviderHost,
  threadId: string,
  text: string,
  messages: readonly T[],
): T[] {
  // A Meta API key saved or cleared during this request: its answers belonged to the previous key.
  if (host.cloudRun !== null && host.cloudRun.threadId === threadId && host.cloudRun.credential !== host.metaCredential) {
    throw new CloudEgressBlocked('RAME Code stopped this request before sending more: the Meta API key changed while it was running, and its approvals belonged to the previous key. Nothing more was sent.');
  }
  const full = host.store.get(threadId);
  const paths = localPaths(host, full?.workspaceRoot);
  const toolResults = host.cloudRun?.threadId === threadId && host.cloudRun.toolResults;
  let withheld = 0;
  const redacted: string[] = [];
  const prepared = messages.map((message) => {
    let content = message.content;
    if (typeof content !== 'string') {
      return message;
    }
    if (message.role === 'tool') {
      if (!toolResults) {
        withheld += 1;
        return { ...message, content: TOOL_RESULTS_WITHHELD };
      }
      const secrets = redactSecrets(content);
      content = secrets.text;
      redacted.push(...secrets.found);
    }
    return { ...message, content: scrubLocalPaths(content, paths) };
  });
  if (full !== undefined) {
    const record = threadDisclosure(host.cloudDisclosure, threadId, runScope(host, threadId));
    const visible = cloudVisibleThread(full, text, record);
    const allowed = normalized(
      [
        text,
        ...visible.turns.flatMap((turn) =>
          turn.kind === 'user' ? [turn.text] : turn.kind === 'assistant' ? [turn.text, ...(turn.hostRecord ?? [])] : turn.kind === 'plan' ? [turn.plan.goal, ...turn.plan.steps.map((step) => step.title)] : [],
        ),
      ].join('\n'),
    );
    // Tool results are governed above; every other message must hold no undisclosed local text.
    const haystack = normalized(prepared.filter((message) => message.role !== 'tool').map((message) => message.content ?? '').join('\n'));
    const leaked = protectedLocalTexts(full, text, record).filter((protectedText) =>
      windows(protectedText).some((window) => haystack.includes(window) && !allowed.includes(window)),
    );
    if (leaked.length > 0) {
      note(host, threadId, `stopped a Meta request: it would have carried ${leaked.length} local item(s) you have not approved`);
      throw new CloudEgressBlocked(
        `RAME Code stopped this request before sending it: it would have carried ${leaked.length} local item(s) you have not approved for Meta. Nothing was sent.`,
      );
    }
  }
  if (redacted.length > 0) {
    note(host, threadId, `redacted ${redacted.length} value(s) that look like secrets (${[...new Set(redacted)].join(', ')}) from tool results before sending them to Meta`);
  }
  if (withheld > 0) {
    note(host, threadId, `withheld ${withheld} tool result(s) from Meta: tool results are not allowed in this thread for this session`);
  }
  return prepared;
}

/**
 * The Meta Agent provider behind the egress check: tools Meta cannot use are
 * not offered (history search never returns local history to Meta), and the
 * checked messages are the ones sent. Meta's API does not document
 * tool_choice "none", so on the last step the tools stay offered and the
 * instruction says what the host really does: a tool call is refused.
 */
export function guardedMetaAgent(host: ProviderHost, threadId: string, text: string, apiKey: string): AgentModelProvider {
  const inner = new MetaAgentModelProvider(apiKey);
  return {
    id: 'cloud',
    complete: (request) => {
      const messages = request.toolChoice !== 'none'
        ? request.messages
        : request.messages.map((message) =>
            message.role === 'system' && typeof message.content === 'string'
              ? { ...message, content: message.content.replace('and tools are disabled for it.', 'and any tool call on it will be refused by RAME Code.') }
              : message,
          );
      return inner.complete({
        ...request,
        toolChoice: 'auto',
        tools: request.tools.filter((tool) => tool.function.name !== 'search_history'),
        messages: guardCloudMessages<AgentChatMessage>(host, threadId, text, messages),
      });
    },
  };
}
