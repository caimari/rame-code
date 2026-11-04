/**
 * Who answers a local run: the kind of model server, its network scope, and
 * what it says about the model RAME asks for. Free of the `vscode` API.
 *
 * Everything here is what a server SAYS through its documented metadata API
 * (llama-server /props and /v1/models; Ollama /api/version, /api/tags,
 * /api/ps, /api/show; LM Studio /api/v1/models, else /api/v0/models). None of
 * it proves which weights an external server really ran: a server can report
 * anything. Missing data stays null ("unknown"), never guessed. The only
 * cryptographic check RAME can make is the SHA-256 of a GGUF file it reads
 * itself (artifactHash.ts), for the llama-server it launches.
 *
 * Requests reuse the scanner's bounded client (localServers.ts): loopback or
 * private-network addresses only, redirects never followed, 4 MiB and a
 * timeout per answer, metadata requests only (no prompt, history, file or
 * secret is sent). What is kept never holds an address or an absolute path:
 * the endpoint becomes "loopback" / "private network" plus its port, and a
 * model path its file name.
 */

import { classifyEndpoint, getJson, type FetchLike, type LocalServerKind } from './localServers.js';

export type IdentityKind = 'rame-llama-server' | 'llama-server' | 'ollama' | 'lmstudio' | 'openai-compatible' | 'unknown';
/** launched: RAME started the process. detected: the server's own API answered as that kind. declared: only the user's choice says so. */
export type KindBasis = 'launched' | 'detected' | 'declared';
export type NetworkScope = 'loopback' | 'private-network';

/** Kept with each local inference: which server answered, and the model id it put in its answer. */
export interface EvidenceServer {
  kind: IdentityKind;
  basis: KindBasis;
  scope: NetworkScope;
  /** The `model` field of the server's answer, as the server wrote it; null when absent. Not a weights proof. */
  responded: string | null;
}

export interface LocalIdentity {
  kind: IdentityKind;
  basis: KindBasis;
  scope: NetworkScope;
  /** "loopback, port 1234" or "private network, port 1235": never the address itself. */
  endpointLabel: string;
  /** Documented version or build string (Ollama /api/version, llama-server build_info); null when the API has none. */
  serverVersion: string | null;
  /** The model id RAME puts in its requests. */
  requestedModel: string;
  /** Whether the server lists that id; null when it publishes no list. */
  listed: boolean | null;
  /** The model the server says it has loaded for that id (a file name for llama-server); null when it does not say. */
  servedModel: string | null;
  family: string | null;
  parameters: string | null;
  quantization: string | null;
  format: string | null;
  sizeBytes: number | null;
  /** The context the server reports for the loaded model, and the context the model was trained for. */
  contextReported: number | null;
  contextTrained: number | null;
  capabilities: string[];
  /** A digest the server announces for the model (Ollama only); never verified by RAME and not a GGUF file hash. */
  announcedDigest: string | null;
  /** What could not be checked, or does not match. */
  notes: string[];
  checkedAt: number;
}

const TEXT = /^[\w .:@/+()[\]-]{1,160}$/;
const HEX64 = /^(?:sha256:)?([0-9a-f]{64})$/;

const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, 400) : []);
const count = (value: unknown, max = 10_000_000): number | null => (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max ? value : null);
const bytes = (value: unknown): number | null => count(value, 4 * 1024 ** 4);

/** A short, printable server string; anything else is unknown. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const text = value.trim().slice(0, 160);
  return TEXT.test(text) ? text : null;
}

/** The file name of a path a server reports: the directories (and so the user's paths) are dropped. */
export function fileNameOnly(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return null;
  }
  return cleanText(value.split(/[\\/]/).pop() ?? '');
}

export function announcedDigestOf(value: unknown): string | null {
  return typeof value === 'string' ? (HEX64.exec(value.trim().toLowerCase())?.[1] ?? null) : null;
}

/** "loopback, port 1234" / "private network, port 1235": what evidence may show of an endpoint. */
export function endpointLabel(endpoint: string): { scope: NetworkScope; label: string } | null {
  const classified = classifyEndpoint(endpoint);
  if (!classified.ok) {
    return null;
  }
  const url = new URL(classified.endpoint);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const scope: NetworkScope = classified.scope === 'private' ? 'private-network' : 'loopback';
  return { scope, label: `${scope === 'loopback' ? 'loopback' : 'private network'}, port ${port}` };
}

/** The model id a local request asks for: the model chosen on an external server, else the configured id. */
export function requestedLocalModel(settings: { externalLocalEndpoint: string; externalLocal: { model: string }; local: { modelId: string } }, localEndpoint: string | null): string {
  const external = settings.externalLocal.model;
  if (external.length > 0 && settings.externalLocalEndpoint.trim().length > 0 && localEndpoint === settings.externalLocalEndpoint.trim()) {
    return external;
  }
  return settings.local.modelId.trim() || 'local-glimmer';
}

const DECLARED: Record<LocalServerKind | '', IdentityKind> = { ollama: 'ollama', lmstudio: 'lmstudio', 'llama-server': 'llama-server', 'openai-compatible': 'openai-compatible', '': 'unknown' };

/** The model id a server puts in a completion answer, cleaned; null when absent or odd. */
export function respondedModelOf(payload: unknown): string | null {
  return cleanText(record(payload)?.model);
}

function emptyIdentity(kind: IdentityKind, basis: KindBasis, scope: NetworkScope, label: string, requested: string, now: number): LocalIdentity {
  return {
    kind, basis, scope, endpointLabel: label, serverVersion: null, requestedModel: requested, listed: null, servedModel: null,
    family: null, parameters: null, quantization: null, format: null, sizeBytes: null, contextReported: null, contextTrained: null,
    capabilities: [], announcedDigest: null, notes: [], checkedAt: now,
  };
}

function paramsFrom(n: unknown): string | null {
  const value = count(n, 10 ** 13);
  return value === null ? null : value >= 1e9 ? `${(value / 1e9).toFixed(1)}B` : `${(value / 1e6).toFixed(0)}M`;
}

async function asOllama(fetchImpl: FetchLike, endpoint: string, timeoutMs: number, id: LocalIdentity): Promise<boolean> {
  const version = record(await getJson(fetchImpl, `${endpoint}/api/version`, timeoutMs));
  if (version === null || typeof version.version !== 'string') {
    return false;
  }
  id.kind = 'ollama';
  id.serverVersion = cleanText(version.version);
  const tags = record(await getJson(fetchImpl, `${endpoint}/api/tags`, timeoutMs));
  const running = record(await getJson(fetchImpl, `${endpoint}/api/ps`, timeoutMs));
  const matches = (entry: unknown) => {
    const item = record(entry);
    return item !== null && (item.name === id.requestedModel || item.model === id.requestedModel) ? item : null;
  };
  const tag = list(tags?.models).map(matches).find((item) => item !== null) ?? null;
  const loaded = list(running?.models).map(matches).find((item) => item !== null) ?? null;
  id.listed = tags === null ? null : tag !== null;
  id.servedModel = loaded !== null ? cleanText(loaded.name) : null;
  const details = record(tag?.details) ?? record(loaded?.details);
  id.family = cleanText(details?.family);
  id.parameters = cleanText(details?.parameter_size);
  id.quantization = cleanText(details?.quantization_level);
  id.format = cleanText(details?.format);
  id.sizeBytes = bytes(tag?.size) ?? bytes(loaded?.size);
  id.contextReported = count(loaded?.context_length);
  id.announcedDigest = announcedDigestOf(tag?.digest) ?? announcedDigestOf(loaded?.digest);
  if (tag !== null || loaded !== null) {
    const show = record(await getJson(fetchImpl, `${endpoint}/api/show`, timeoutMs, { model: id.requestedModel }));
    const info = record(show?.model_info);
    id.contextTrained = info === null ? null : Object.entries(info).filter(([key]) => key.endsWith('.context_length')).map(([, value]) => count(value)).find((value) => value !== null) ?? null;
    id.capabilities = list(show?.capabilities).map(cleanText).filter((cap): cap is string => cap !== null).slice(0, 12);
  }
  if (loaded === null) {
    id.notes.push('Ollama does not list this model as loaded now; it may load it on the next request.');
  }
  return true;
}

async function asLmStudio(fetchImpl: FetchLike, endpoint: string, timeoutMs: number, id: LocalIdentity): Promise<boolean> {
  const v1 = record(await getJson(fetchImpl, `${endpoint}/api/v1/models`, timeoutMs));
  const models = list(v1?.models).map(record).filter((item): item is Record<string, unknown> => item !== null && typeof item.key === 'string');
  if (models.length > 0) {
    id.kind = 'lmstudio';
    const wanted = id.requestedModel;
    const hit = models.find((item) =>
      item.key === wanted || item.selected_variant === wanted || list(item.variants).includes(wanted) || list(item.loaded_instances).some((instance) => record(instance)?.id === wanted)) ?? null;
    id.listed = hit !== null;
    if (hit !== null) {
      const instance = list(hit.loaded_instances).map(record).find((entry) => entry !== null && (entry.id === wanted || hit.key === wanted)) ?? null;
      id.servedModel = instance !== null ? cleanText(instance.id) : null;
      id.family = cleanText(hit.architecture);
      id.parameters = cleanText(hit.params_string);
      id.quantization = cleanText(record(hit.quantization)?.name);
      id.format = cleanText(hit.format);
      id.sizeBytes = bytes(hit.size_bytes);
      id.contextReported = count(record(instance?.config)?.context_length);
      id.contextTrained = count(hit.max_context_length);
      const caps = record(hit.capabilities);
      id.capabilities = [caps?.vision === true ? 'vision' : null, caps?.trained_for_tool_use === true ? 'tools' : null].filter((cap): cap is string => cap !== null);
      if (instance === null) {
        id.notes.push('LM Studio does not list this model as loaded now.');
      }
    }
    return true;
  }
  const v0 = record(await getJson(fetchImpl, `${endpoint}/api/v0/models`, timeoutMs));
  const data = list(v0?.data).map(record).filter((item): item is Record<string, unknown> => item !== null && typeof item.type === 'string' && typeof item.id === 'string');
  if (data.length === 0) {
    return false;
  }
  id.kind = 'lmstudio';
  const hit = data.find((item) => item.id === id.requestedModel) ?? null;
  id.listed = hit !== null;
  if (hit !== null) {
    id.servedModel = hit.state === 'loaded' ? cleanText(hit.id) : null;
    id.family = cleanText(hit.arch);
    id.quantization = cleanText(hit.quantization);
    id.format = cleanText(hit.compatibility_type);
    id.contextReported = count(hit.loaded_context_length);
    id.contextTrained = count(hit.max_context_length);
  }
  return true;
}

async function asOpenAi(fetchImpl: FetchLike, endpoint: string, timeoutMs: number, id: LocalIdentity, launched: boolean): Promise<boolean> {
  const models = record(await getJson(fetchImpl, `${endpoint}/v1/models`, timeoutMs));
  const props = record(await getJson(fetchImpl, `${endpoint}/props`, timeoutMs));
  const data = list(models?.data).map(record).filter((item): item is Record<string, unknown> => item !== null && typeof item.id === 'string');
  const llama = props !== null && (typeof props.model_path === 'string' || record(props.default_generation_settings) !== null);
  if (data.length === 0 && !llama) {
    return false;
  }
  id.kind = launched ? 'rame-llama-server' : llama ? 'llama-server' : 'openai-compatible';
  const ids = data.map((item) => item.id as string);
  id.listed = data.length === 0 ? null : ids.includes(id.requestedModel);
  if (llama) {
    // llama-server serves the one model it loaded, whatever id a request names.
    id.servedModel = fileNameOnly(props.model_path) ?? fileNameOnly(ids[0]);
    id.serverVersion = cleanText(props.build_info);
    id.contextReported = count(record(props.default_generation_settings)?.n_ctx) ?? count(props.n_ctx);
    const meta = record(data[0]?.meta);
    id.parameters = paramsFrom(meta?.n_params);
    id.sizeBytes = bytes(meta?.size);
    id.contextTrained = count(meta?.n_ctx_train);
    id.format = id.servedModel !== null && /\.gguf$/i.test(id.servedModel) ? 'gguf' : null;
    if (!launched && id.listed === false) {
      id.notes.push('llama-server answers every request with the one model it loaded, whatever id is requested.');
    }
  } else if (ids.length === 1) {
    id.notes.push('The server lists one model; it does not say which model answers a request.');
  }
  return true;
}

/**
 * Ask a local or private-network server what it is and what it says about
 * `requestedModel`. Metadata only, bounded; never throws.
 */
export async function probeLocalIdentity(
  options: { endpoint: string; requestedModel: string; declaredKind: LocalServerKind | ''; launchedByRame: boolean },
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 5000,
  now: () => number = Date.now,
): Promise<{ ok: true; identity: LocalIdentity } | { ok: false; error: string }> {
  const where = endpointLabel(options.endpoint.trim().replace(/\/+$/, ''));
  if (where === null) {
    return { ok: false, error: 'Only a server on this computer or on your private network can be checked.' };
  }
  const endpoint = classifyEndpoint(options.endpoint.trim().replace(/\/+$/, '')) as { ok: true; endpoint: string };
  const requested = cleanText(options.requestedModel) ?? 'local-glimmer';
  const id = emptyIdentity(DECLARED[options.declaredKind], options.launchedByRame ? 'launched' : 'detected', where.scope, where.label, requested, now());
  const answered = options.launchedByRame
    ? await asOpenAi(fetchImpl, endpoint.endpoint, timeoutMs, id, true)
    : (await asOllama(fetchImpl, endpoint.endpoint, timeoutMs, id)) ||
      (await asLmStudio(fetchImpl, endpoint.endpoint, timeoutMs, id)) ||
      (await asOpenAi(fetchImpl, endpoint.endpoint, timeoutMs, id, false));
  if (!answered) {
    id.basis = 'declared';
    id.kind = options.launchedByRame ? 'rame-llama-server' : DECLARED[options.declaredKind];
    id.notes.push('The server did not answer any documented identity request.');
  } else if (!options.launchedByRame && options.declaredKind !== '' && DECLARED[options.declaredKind] !== id.kind && !(options.declaredKind === 'openai-compatible')) {
    id.notes.push(`Chosen as ${options.declaredKind}, but the server answers as ${id.kind}.`);
  }
  if (id.listed === false) {
    id.notes.push(`The server does not list the requested id "${requested}".`);
  }
  return { ok: true, identity: id };
}

/** Kind for an inference record, from a check of this endpoint when there is one, else the user's choice. */
export function evidenceServer(identity: LocalIdentity | null, declaredKind: LocalServerKind | '', launched: boolean, scope: NetworkScope, responded: string | null): EvidenceServer {
  if (launched) {
    return { kind: 'rame-llama-server', basis: 'launched', scope: 'loopback', responded };
  }
  if (identity !== null && identity.basis === 'detected') {
    return { kind: identity.kind, basis: 'detected', scope, responded };
  }
  return { kind: DECLARED[declaredKind], basis: 'declared', scope, responded };
}

const KINDS: readonly IdentityKind[] = ['rame-llama-server', 'llama-server', 'ollama', 'lmstudio', 'openai-compatible', 'unknown'];

export function isEvidenceServer(value: unknown): value is EvidenceServer {
  const v = record(value);
  return (
    v !== null &&
    Object.keys(v).length === 4 &&
    KINDS.includes(v.kind as IdentityKind) &&
    (v.basis === 'launched' || v.basis === 'detected' || v.basis === 'declared') &&
    (v.scope === 'loopback' || v.scope === 'private-network') &&
    (v.responded === null || (typeof v.responded === 'string' && TEXT.test(v.responded))) &&
    // Only RAME's own launch is "launched", and it is always loopback.
    (v.basis === 'launched') === (v.kind === 'rame-llama-server') &&
    (v.kind !== 'rame-llama-server' || v.scope === 'loopback')
  );
}

/** A posted identity, re-validated at the webview boundary; anything malformed is dropped. */
export function sanitizeIdentity(value: unknown): LocalIdentity | null {
  const v = record(value);
  if (v === null || !KINDS.includes(v.kind as IdentityKind) || !['launched', 'detected', 'declared'].includes(v.basis as string) || (v.scope !== 'loopback' && v.scope !== 'private-network')) {
    return null;
  }
  const label = typeof v.endpointLabel === 'string' && /^(?:loopback|private network), port \d{1,5}$/.test(v.endpointLabel) ? v.endpointLabel : null;
  if (label === null) {
    return null;
  }
  return {
    kind: v.kind as IdentityKind,
    basis: v.basis as KindBasis,
    scope: v.scope as NetworkScope,
    endpointLabel: label,
    serverVersion: cleanText(v.serverVersion),
    requestedModel: cleanText(v.requestedModel) ?? 'unknown',
    listed: typeof v.listed === 'boolean' ? v.listed : null,
    servedModel: cleanText(v.servedModel),
    family: cleanText(v.family),
    parameters: cleanText(v.parameters),
    quantization: cleanText(v.quantization),
    format: cleanText(v.format),
    sizeBytes: bytes(v.sizeBytes),
    contextReported: count(v.contextReported),
    contextTrained: count(v.contextTrained),
    capabilities: list(v.capabilities).map(cleanText).filter((cap): cap is string => cap !== null).slice(0, 12),
    announcedDigest: announcedDigestOf(v.announcedDigest),
    notes: list(v.notes).filter((note): note is string => typeof note === 'string').map((note) => note.slice(0, 240)).slice(0, 6),
    checkedAt: count(v.checkedAt, 8_640_000_000_000_000) ?? 0,
  };
}

export type ArtifactView =
  | { state: 'none' }
  | { state: 'hashing'; file: string; percent: number }
  | { state: 'verified'; file: string; size: number; sha256: string; computedAt: number; inUse: boolean }
  | { state: 'stale'; file: string; sha256: string; reason: string }
  | { state: 'failed'; reason: string };

export interface IdentityLevels {
  /** RAME has a local model selected. */
  configured: boolean;
  /** The server answered and identified itself through its documented API in this session. */
  endpointVerified: boolean;
  /** RAME hashed the model file of the llama-server it launched, and the file has not changed since. */
  artifactVerified: boolean;
  /** A local response was received in this session. */
  responseObserved: boolean;
}

export interface LocalIdentityView {
  identity: LocalIdentity | null;
  artifact: ArtifactView;
  levels: IdentityLevels;
}

const SHA = /^[0-9a-f]{64}$/;

function sanitizeArtifact(value: unknown): ArtifactView {
  const v = record(value);
  const file = fileNameOnly(v?.file);
  switch (v?.state) {
    case 'hashing':
      return file !== null && typeof v.percent === 'number' && v.percent >= 0 && v.percent <= 100 ? { state: 'hashing', file, percent: Math.floor(v.percent) } : { state: 'none' };
    case 'verified':
      return file !== null && typeof v.sha256 === 'string' && SHA.test(v.sha256) && bytes(v.size) !== null
        ? { state: 'verified', file, size: v.size as number, sha256: v.sha256, computedAt: count(v.computedAt, 8_640_000_000_000_000) ?? 0, inUse: v.inUse === true }
        : { state: 'none' };
    case 'stale':
      return file !== null && typeof v.sha256 === 'string' && SHA.test(v.sha256) && typeof v.reason === 'string'
        ? { state: 'stale', file, sha256: v.sha256, reason: v.reason.slice(0, 160) }
        : { state: 'none' };
    case 'failed':
      return typeof v.reason === 'string' ? { state: 'failed', reason: v.reason.slice(0, 200) } : { state: 'none' };
    default:
      return { state: 'none' };
  }
}

/** The identity view, re-validated at the webview boundary. */
export function sanitizeIdentityView(value: unknown): LocalIdentityView | undefined {
  const v = record(value);
  if (v === null) {
    return undefined;
  }
  const levels = record(v.levels);
  const identity = sanitizeIdentity(v.identity);
  const artifact = sanitizeArtifact(v.artifact);
  return {
    identity,
    artifact,
    levels: {
      configured: levels?.configured === true,
      // A level is only shown when what it rests on is there too.
      endpointVerified: levels?.endpointVerified === true && identity !== null && identity.basis !== 'declared',
      artifactVerified: levels?.artifactVerified === true && artifact.state === 'verified' && artifact.inUse,
      responseObserved: levels?.responseObserved === true,
    },
  };
}
