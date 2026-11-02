/**
 * Bounded Meta Model API catalog for compatible chat models.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * The API key is never stored, logged, or echoed here: it only appears in
 * the outbound `Authorization` header built by the host, and every error
 * produced here is a sanitized generic message.
 */

export const META_MODELS_ENDPOINT = 'https://api.meta.ai/v1/models';
export const CLOUD_MODEL_FALLBACK = 'muse-spark-1.3' as const;

export const FALLBACK_CLOUD_MODEL_IDS = [
  'muse-spark-1.3',
  'muse-spark-1.2',
  'muse-spark-1.1',
  'muse-wonder-1.0',
] as const;

export const MAX_CATALOG_RESPONSE_BYTES = 262144;
export const MAX_CATALOG_MODELS = 100;
export const MAX_MODEL_ID_LENGTH = 128;
export const CATALOG_TIMEOUT_MS = 15000;

export interface CloudModelInfo {
  id: string;
  label: string;
  contributor: boolean;
  created?: number;
}

export type CloudCatalogSource = 'live' | 'fallback';

const COMPATIBLE_ID_PATTERN = /^muse-(spark|wonder)-[A-Za-z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for contributor variants (data may be used). Never silent. */
export function isContributorModelId(id: string): boolean {
  return /contrib/i.test(id);
}

/**
 * True only for chat-compatible Meta model ids (`muse-spark-*` or
 * `muse-wonder-*`, bounded, safe characters). Image, Voice, SAM, and other
 * endpoint families never match and are therefore excluded.
 */
export function isCompatibleModelId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_MODEL_ID_LENGTH) {
    return false;
  }
  if (!COMPATIBLE_ID_PATTERN.test(id)) {
    return false;
  }
  const lower = id.toLowerCase();
  if (
    lower.includes('image') ||
    lower.includes('voice') ||
    lower.includes('sam') ||
    lower.includes('segment')
  ) {
    return false;
  }
  return true;
}

function sanitizeCreated(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  if (value > 9999999999) {
    return undefined;
  }
  return value;
}

/** Human label; contributor variants are visibly marked. */
export function cloudModelLabel(id: string): string {
  if (isContributorModelId(id)) {
    return `${id} — Contributor (data may be used)`;
  }
  return id;
}

function toModelInfo(id: string, created: unknown): CloudModelInfo | null {
  if (!isCompatibleModelId(id)) {
    return null;
  }
  const clean = id.trim();
  return {
    id: clean,
    label: cloudModelLabel(clean),
    contributor: isContributorModelId(clean),
    ...(sanitizeCreated(created) !== undefined
      ? { created: sanitizeCreated(created) as number }
      : {}),
  };
}

/** Fallback catalog used before/without a live refresh. */
export function fallbackCatalog(): CloudModelInfo[] {
  return (FALLBACK_CLOUD_MODEL_IDS as readonly string[]).map((id) => ({
    id,
    label: cloudModelLabel(id),
    contributor: false,
  }));
}

/**
 * Parse a raw `/v1/models` response body defensively. Returns only
 * sanitized compatible models, newest-first as returned (API order is
 * preserved; no re-sorting). Throws a generic Error on invalid shapes.
 */
export function parseMetaModelsPayload(rawText: string): CloudModelInfo[] {
  if (rawText.length > MAX_CATALOG_RESPONSE_BYTES) {
    throw new Error('The model catalog response was too large.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawText) as unknown;
  } catch {
    throw new Error('The model catalog response was invalid.');
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.data)) {
    throw new Error('The model catalog response was invalid.');
  }
  const entries = decoded.data.slice(0, MAX_CATALOG_MODELS);
  const seen = new Set<string>();
  const models: CloudModelInfo[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      continue;
    }
    const info = toModelInfo(entry.id, entry.created);
    if (!info || seen.has(info.id)) {
      continue;
    }
    seen.add(info.id);
    models.push(info);
  }
  return models;
}

/**
 * Validate an untrusted selected cloud model against the known catalog.
 * Returns the selection when it is compatible and listed, otherwise the
 * safe fallback `muse-spark-1.3`. Never throws and never echoes secrets
 * (model ids are non-secret; the key is never a parameter here).
 */
export function validateCloudModelSelection(
  value: unknown,
  available: readonly CloudModelInfo[] | readonly string[],
): string {
  const ids = available.map((entry) =>
    typeof entry === 'string' ? entry : entry.id,
  );
  if (typeof value !== 'string') {
    return CLOUD_MODEL_FALLBACK;
  }
  const candidate = value.trim();
  if (!isCompatibleModelId(candidate)) {
    return CLOUD_MODEL_FALLBACK;
  }
  if (ids.includes(candidate)) {
    return candidate;
  }
  const fallbackIds = FALLBACK_CLOUD_MODEL_IDS as readonly string[];
  if ((fallbackIds as readonly string[]).includes(candidate)) {
    return candidate;
  }
  return CLOUD_MODEL_FALLBACK;
}

/** Generic sanitized catalog failure message (never contains the key). */
export function sanitizeCatalogError(error: unknown): string {
  if (error instanceof Error && /HTTP (\d{3})/.test(error.message)) {
    const status = error.message.match(/HTTP (\d{3})/)?.[1] ?? '';
    return status
      ? `Could not refresh models (HTTP ${status}). Using fallback catalog.`
      : 'Could not refresh models. Using fallback catalog.';
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Model catalog refresh timed out. Using fallback catalog.';
  }
  return 'Could not refresh models. Using fallback catalog.';
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RefreshCatalogOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RefreshCatalogResult {
  models: CloudModelInfo[];
  source: CloudCatalogSource;
  /** Sanitized message for display; never contains key material. */
  status: string;
}

/**
 * Host-side bounded `Refresh available models` action. Uses only the API
 * key from SecretStorage (passed in by the caller, never forwarded). The
 * key travels only in the `Authorization` header; it never reaches the
 * webview, logs, state, or errors.
 */
export async function refreshCompatibleModels(
  options: RefreshCatalogOptions,
): Promise<RefreshCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? CATALOG_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      return {
        models: fallbackCatalog(),
        source: 'fallback',
        status: sanitizeCatalogError(
          new DOMException('Aborted', 'AbortError'),
        ),
      };
    }
    options.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    const response = await fetchImpl(META_MODELS_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      return {
        models: fallbackCatalog(),
        source: 'fallback',
        status: sanitizeCatalogError(
          new Error(`Meta Model API returned HTTP ${response.status}.`),
        ),
      };
    }
    try {
      const models = parseMetaModelsPayload(rawText);
      if (models.length === 0) {
        return {
          models: fallbackCatalog(),
          source: 'fallback',
          status: 'No compatible models were returned. Using fallback catalog.',
        };
      }
      return {
        models,
        source: 'live',
        status: `Loaded ${models.length} compatible model(s) from the Meta API.`,
      };
    } catch (error) {
      return {
        models: fallbackCatalog(),
        source: 'fallback',
        status: sanitizeCatalogError(error),
      };
    }
  } catch (error) {
    return {
      models: fallbackCatalog(),
      source: 'fallback',
      status: sanitizeCatalogError(error),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
