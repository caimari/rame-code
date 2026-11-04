/**
 * Local model servers RAME connects to without launching them: Ollama,
 * LM Studio, a llama-server started by the user, or any other server with
 * an OpenAI-compatible `/v1/chat/completions`.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Where a server may be:
 *   - loopback (`127.0.0.1`, `localhost`, `::1`): always allowed;
 *   - a private network address written as a literal IP (10/8, 172.16/12,
 *     192.168/16, fd00::/8): only after the user confirms that prompts,
 *     history and project content will go to that other computer. Host
 *     names other than `localhost` are refused: a name could resolve to a
 *     public address, now or later, and a literal address cannot change;
 *   - anything else (a public address): never. RAME does not send local
 *     work to a server on the internet through this path.
 *
 * Detection reads only metadata (model lists, capabilities, context); it
 * never generates. The server kind is told apart by the content of its
 * answers, not by status codes: LM Studio answers 200 with an error body
 * to Ollama's paths.
 */

/**
 * Requests to a model server carry prompts, history and project content:
 * they are never resent to another address. Every client asks for manual
 * redirects and refuses any 3xx answer.
 */
export const LOCAL_REDIRECT_REFUSED = 'The model server answered with a redirect; RAME does not resend local work to another address. Use the address the server really listens on.';

export function refuseRedirect(response: { status: number }): void {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(LOCAL_REDIRECT_REFUSED);
  }
}

export type LocalServerKind = 'ollama' | 'lmstudio' | 'llama-server' | 'openai-compatible';
export type EndpointScope = 'loopback' | 'private';

export interface LocalServerModel {
  id: string;
  /** Tool calls: true / false when the server says so, null when it does not tell. */
  tools: boolean | null;
  vision: boolean | null;
  /** The context the model is loaded with now, if the server reports it. */
  loadedContext: number | null;
  /** The longest context the model supports, if the server reports it. */
  maxContext: number | null;
  loaded: boolean;
}

export interface LocalServerScan {
  kind: LocalServerKind;
  endpoint: string;
  scope: EndpointScope;
  version: string;
  models: LocalServerModel[];
}

export const MAX_SCANNED_MODELS = 80;
const ID = /^[\w.:@/+-]{1,200}$/;

/** Classify an endpoint the user typed. The path is dropped; `/v1` is added by the clients. */
export function classifyEndpoint(raw: string): { ok: true; endpoint: string; scope: EndpointScope } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'That is not a valid URL (for example http://127.0.0.1:11434).' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// or https:// servers are supported.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Do not put credentials in the server URL.' };
  }
  const scope = endpointScope(url.hostname);
  if (scope === null) {
    return { ok: false, error: 'The model server must be on this computer (127.0.0.1, localhost) or a private IP address of your network (10.x, 172.16-31.x, 192.168.x), written as numbers; RAME never sends local work to a public address or a host name this way.' };
  }
  return { ok: true, endpoint: `${url.protocol}//${url.host}`, scope };
}

export function endpointScope(hostname: string): EndpointScope | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    return 'loopback';
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([v4[1], v4[2], v4[3], v4[4]].some((part) => Number(part) > 255)) {
      return null;
    }
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return 'private';
    }
    return null;
  }
  if (/^fd[0-9a-f]{2}:[0-9a-f:]*$/.test(host)) {
    return 'private'; // IPv6 unique local, as a literal address
  }
  // Names (studio.local, box.lan…) are refused: a name can resolve to a
  // public address, now or after the user approved it. Literal addresses only.
  return null;
}

/** Whether a stored endpoint may be used: loopback always, private only with the user's confirmation. */
export function endpointUsable(endpoint: string, lanConfirmed: boolean): boolean {
  const classified = classifyEndpoint(endpoint);
  return classified.ok && (classified.scope === 'loopback' || lanConfirmed);
}

/** For the HTTP clients: loopback or private network, never public. */
export function isLocalOrPrivateUrl(value: string): boolean {
  return classifyEndpoint(value).ok;
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'manual' }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; body?: unknown }>;

export async function getJson(fetchImpl: FetchLike, url: string, timeoutMs: number, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, body === undefined
      ? { signal: controller.signal, redirect: 'manual' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, redirect: 'manual' });
    if (!response.ok) {
      // A redirect is not ok either: it is never followed.
      return null;
    }
    const text = await boundedText(response, MAX_METADATA_BYTES);
    return text === null ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const MAX_METADATA_BYTES = 4 * 1024 * 1024;
/** Whole scan budget: a server with many models never holds the view for minutes. */
export const SCAN_DEADLINE_MS = 20_000;
const SHOW_CONCURRENCY = 4;

/** The body as text, stopping as soon as it passes `max` bytes (null then). */
async function boundedText(response: { text(): Promise<string>; body?: unknown }, max: number): Promise<string | null> {
  const stream = response.body as { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null | undefined;
  if (!stream || typeof stream.getReader !== 'function') {
    const text = await response.text();
    return text.length > max ? null : text;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value?.length ?? 0;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    if (value) {
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const positive = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 10_000_000 ? value : null);

/** Read what kind of server this is and which models it offers. Metadata only. */
export async function scanLocalServer(rawEndpoint: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 5000): Promise<{ ok: true; scan: LocalServerScan } | { ok: false; error: string }> {
  const classified = classifyEndpoint(rawEndpoint);
  if (!classified.ok) {
    return classified;
  }
  const { endpoint, scope } = classified;
  // Ollama: {"version": "..."} at /api/version.
  const version = record(await getJson(fetchImpl, `${endpoint}/api/version`, timeoutMs));
  if (version && typeof version.version === 'string') {
    const tags = record(await getJson(fetchImpl, `${endpoint}/api/tags`, timeoutMs));
    const running = record(await getJson(fetchImpl, `${endpoint}/api/ps`, timeoutMs));
    const loaded = new Map<string, number | null>();
    for (const entry of Array.isArray(running?.models) ? running.models : []) {
      const item = record(entry);
      if (item && typeof item.name === 'string') {
        loaded.set(item.name, positive(item.context_length));
      }
    }
    const names = (Array.isArray(tags?.models) ? tags.models : [])
      .map((entry) => record(entry)?.name)
      .filter((name): name is string => typeof name === 'string' && ID.test(name))
      .slice(0, MAX_SCANNED_MODELS);
    // At most SHOW_CONCURRENCY requests at a time, and none after the scan deadline.
    const deadline = Date.now() + SCAN_DEADLINE_MS;
    const shows = new Map<string, Record<string, unknown> | null>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, names.length) }, async () => {
      while (next < names.length && Date.now() < deadline) {
        const name = names[next++] as string;
        shows.set(name, record(await getJson(fetchImpl, `${endpoint}/api/show`, Math.min(timeoutMs, Math.max(1, deadline - Date.now())), { model: name })));
      }
    }));
    const models: LocalServerModel[] = [];
    for (const name of names) {
      const show = shows.get(name) ?? null;
      const capabilities = Array.isArray(show?.capabilities) ? (show.capabilities as unknown[]).filter((cap): cap is string => typeof cap === 'string') : null;
      if (capabilities !== null && !capabilities.includes('completion')) {
        continue; // embedding-only
      }
      const info = record(show?.model_info);
      const maxContext = info === null ? null : Object.entries(info).filter(([key]) => key.endsWith('.context_length')).map(([, value]) => positive(value)).find((value) => value !== null) ?? null;
      models.push({
        id: name,
        tools: capabilities === null ? null : capabilities.includes('tools'),
        vision: capabilities === null ? null : capabilities.includes('vision'),
        loadedContext: loaded.get(name) ?? null,
        maxContext,
        loaded: loaded.has(name),
      });
    }
    return { ok: true, scan: { kind: 'ollama', endpoint, scope, version: version.version.slice(0, 40), models } };
  }
  // LM Studio: {"data": [{id, type, arch, state, capabilities, ...}]} at /api/v0/models.
  const lmstudio = record(await getJson(fetchImpl, `${endpoint}/api/v0/models`, timeoutMs));
  if (lmstudio && Array.isArray(lmstudio.data) && lmstudio.data.some((entry) => typeof record(entry)?.type === 'string')) {
    const models: LocalServerModel[] = [];
    for (const entry of lmstudio.data.slice(0, MAX_SCANNED_MODELS * 2)) {
      const item = record(entry);
      if (item === null || typeof item.id !== 'string' || !ID.test(item.id) || (item.type !== 'llm' && item.type !== 'vlm') || item.arch === 'dflash') {
        continue; // embeddings, and DFlash draft models, are not chat models
      }
      const capabilities = Array.isArray(item.capabilities) ? (item.capabilities as unknown[]) : null;
      models.push({
        id: item.id,
        tools: capabilities === null ? null : capabilities.includes('tool_use'),
        vision: item.type === 'vlm',
        loadedContext: positive(item.loaded_context_length),
        maxContext: positive(item.max_context_length),
        loaded: item.state === 'loaded',
      });
    }
    return { ok: true, scan: { kind: 'lmstudio', endpoint, scope, version: '', models: models.slice(0, MAX_SCANNED_MODELS) } };
  }
  // Anything with an OpenAI-compatible model list; llama-server also answers /props.
  const list = record(await getJson(fetchImpl, `${endpoint}/v1/models`, timeoutMs));
  if (list && Array.isArray(list.data)) {
    const props = record(await getJson(fetchImpl, `${endpoint}/props`, timeoutMs));
    const settings = record(props?.default_generation_settings);
    const context = positive(settings?.n_ctx) ?? positive(props?.n_ctx);
    const models = list.data
      .map((entry) => record(entry)?.id)
      .filter((id): id is string => typeof id === 'string' && ID.test(id))
      .slice(0, MAX_SCANNED_MODELS)
      .map((id) => ({ id, tools: null, vision: null, loadedContext: context, maxContext: null, loaded: props !== null }));
    return { ok: true, scan: { kind: props !== null ? 'llama-server' : 'openai-compatible', endpoint, scope, version: '', models } };
  }
  return { ok: false, error: `No model server answered at ${endpoint} (tried Ollama, LM Studio and OpenAI-compatible paths). Start it, or check the address and port.` };
}

/** RAME's Agent needs about this much context for its instructions, tools and a useful history. */
export const AGENT_MIN_CONTEXT = 16_384;

/** A short, honest note on what the chosen model can do in RAME. */
export function modelFitness(model: LocalServerModel, kind: LocalServerKind): { agent: boolean; note: string } {
  const context = model.loadedContext;
  const contextNote =
    context !== null && context < AGENT_MIN_CONTEXT
      ? ` It is loaded with a ${context}-token context; Agent needs about ${AGENT_MIN_CONTEXT}${kind === 'ollama' ? ' (start Ollama with OLLAMA_CONTEXT_LENGTH=32768, or set the context length in its settings)' : kind === 'lmstudio' ? ' (load it with a larger context length in LM Studio)' : ''}, or the server will cut the conversation.`
      : context === null && kind === 'ollama'
        ? ` Ollama loads it with its own context length (often 4096 tokens) unless OLLAMA_CONTEXT_LENGTH is set; Agent needs about ${AGENT_MIN_CONTEXT}.`
        : '';
  if (model.tools === false) {
    return { agent: false, note: `This model does not support tool calls: use it in Chat only.${contextNote}` };
  }
  if (model.tools === null) {
    return { agent: true, note: `The server does not say whether this model supports tool calls; Agent will stop with a clear message if it cannot call tools.${contextNote}` };
  }
  return { agent: true, note: `Supports tool calls: Chat, Agent and Mission.${contextNote}` };
}
