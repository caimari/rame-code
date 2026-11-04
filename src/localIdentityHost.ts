/**
 * The host side of local model identity: the last identity check of the
 * local endpoint in use, and the SHA-256 of the GGUF RAME passes to its own
 * llama-server. Kept per window, for this session only.
 *
 * Nothing here blocks Chat, Agent or Mission: an external server that cannot
 * prove which weights it runs is still usable; Model evidence says what was
 * and was not verified.
 */

import { statSync } from 'node:fs';

import { artifactStillMatches, hashArtifact, type ArtifactHash } from './artifactHash.js';
import { endpointLabel, evidenceServer, probeLocalIdentity, requestedLocalModel, type ArtifactView, type EvidenceServer, type LocalIdentity, type LocalIdentityView } from './localIdentity.js';
import type { LocalServerKind } from './localServers.js';
import type { ProviderHost } from './providerTypes.js';

interface IdentityState {
  /** The identity of `key` (endpoint + requested model) checked in this session. */
  identity: { key: string; value: LocalIdentity } | null;
  /** The hash of `path`, computed in this session. */
  artifact: { path: string; hash: ArtifactHash } | null;
  hashing: { path: string; controller: AbortController; read: number; total: number } | null;
  /** The outcome of the last hash attempt that did not produce a hash. */
  hashError: string;
}

const states = new WeakMap<object, IdentityState>();

function stateOf(host: ProviderHost): IdentityState {
  let state = states.get(host);
  if (!state) {
    state = { identity: null, artifact: null, hashing: null, hashError: '' };
    states.set(host, state);
  }
  return state;
}

function keyOf(endpoint: string, model: string): string {
  return `${endpoint}\u0000${model}`;
}

function declaredKind(host: ProviderHost): LocalServerKind | '' {
  return host.settings.externalLocal?.kind ?? '';
}

function launchedHere(host: ProviderHost, endpoint: string | null): boolean {
  return endpoint !== null && host.localLaunch !== null && host.localLaunch.endpoint === endpoint;
}

/** The identity checked for the endpoint and model in use now; null when none was checked (or they changed since). */
export function currentIdentity(host: ProviderHost): LocalIdentity | null {
  const endpoint = host.localEndpoint();
  const identity = stateOf(host).identity;
  if (endpoint === null || identity === null) {
    return null;
  }
  return identity.key === keyOf(endpoint, requestedLocalModel(host.settings, endpoint)) ? identity.value : null;
}

/** Ask the local server in use what it is; metadata only. */
export async function checkLocalIdentity(host: ProviderHost, fetchImpl?: Parameters<typeof probeLocalIdentity>[1]): Promise<void> {
  const endpoint = host.localEndpoint();
  if (endpoint === null) {
    host.status = 'No local model server is in use: start Muse Glimmer or choose a model server first.';
    await host.postState();
    return;
  }
  const requested = requestedLocalModel(host.settings, endpoint);
  host.status = 'Checking the identity of the local model server…';
  await host.postState();
  const result = await probeLocalIdentity({ endpoint, requestedModel: requested, declaredKind: declaredKind(host), launchedByRame: launchedHere(host, endpoint) }, fetchImpl);
  if (!result.ok) {
    host.status = result.error;
    await host.postState();
    return;
  }
  stateOf(host).identity = { key: keyOf(endpoint, requested), value: result.identity };
  host.status = result.identity.basis === 'declared'
    ? 'The local model server did not answer any identity request; it is shown as you chose it, not verified.'
    : `Local model server identified from its own API: ${result.identity.kind}. What it says about the model is not a cryptographic proof.`;
  await host.postState();
}

/** Hash the GGUF configured for RAME's llama-server, block by block; cancellable. */
export async function startArtifactHash(host: ProviderHost, options: { chunkBytes?: number; postEvery?: number } = {}): Promise<void> {
  const state = stateOf(host);
  const path = host.settings.local.modelPath.trim();
  if (path.length === 0) {
    host.status = 'Set the model file of Muse Glimmer (Runtime) before computing its SHA-256.';
    await host.postState();
    return;
  }
  if (state.hashing !== null) {
    host.status = 'The SHA-256 of the model file is already being computed.';
    await host.postState();
    return;
  }
  const controller = new AbortController();
  const hashing = { path, controller, read: 0, total: 0 };
  state.hashing = hashing;
  state.hashError = '';
  host.status = 'Computing the SHA-256 of the model file…';
  await host.postState();
  let lastPost = Date.now();
  const postEvery = options.postEvery ?? 1000;
  try {
    const hash = await hashArtifact(path, {
      signal: controller.signal,
      chunkBytes: options.chunkBytes,
      onProgress: (read, total) => {
        hashing.read = read;
        hashing.total = total;
        if (Date.now() - lastPost >= postEvery) {
          lastPost = Date.now();
          void host.postState();
        }
      },
    });
    state.artifact = { path, hash };
    host.status = `SHA-256 of ${hash.file} computed (${hash.size} bytes).`;
  } catch (error) {
    const cancelled = error instanceof Error && error.name === 'AbortError';
    state.hashError = cancelled ? 'cancelled' : error instanceof Error ? error.message : 'The model file could not be read.';
    host.status = cancelled ? 'SHA-256 computation cancelled; nothing was recorded.' : state.hashError;
  } finally {
    state.hashing = null;
  }
  await host.postState();
}

export async function cancelArtifactHash(host: ProviderHost): Promise<void> {
  const hashing = stateOf(host).hashing;
  if (hashing === null) {
    host.status = 'No SHA-256 computation is running.';
    await host.postState();
    return;
  }
  hashing.controller.abort();
}

/** The hash of the configured GGUF, checked against the file as it is now. */
export function artifactView(host: ProviderHost, stat: (path: string) => { size: number; mtimeMs: number; isFile(): boolean } | null = safeStat): ArtifactView {
  const state = stateOf(host);
  const path = host.settings.local.modelPath.trim();
  if (state.hashing !== null) {
    const total = state.hashing.total;
    return { state: 'hashing', file: state.hashing.path.split(/[\\/]/).pop() || 'model file', percent: total > 0 ? Math.min(100, Math.floor((state.hashing.read / total) * 100)) : 0 };
  }
  if (state.artifact === null) {
    return state.hashError && state.hashError !== 'cancelled' ? { state: 'failed', reason: state.hashError } : { state: 'none' };
  }
  const { hash } = state.artifact;
  const match = state.artifact.path === path ? artifactStillMatches(hash, path, stat(path)) : { ok: false as const, reason: 'another model file is configured now' };
  if (!match.ok) {
    return { state: 'stale', file: hash.file, sha256: hash.sha256, reason: match.reason };
  }
  const endpoint = host.localEndpoint();
  return { state: 'verified', file: hash.file, size: hash.size, sha256: hash.sha256, computedAt: hash.computedAt, inUse: launchedHere(host, endpoint) && host.localLaunch?.model === hash.file };
}

function safeStat(path: string): { size: number; mtimeMs: number; isFile(): boolean } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** The server facts stored with a local inference. */
export function serverForEvidence(host: ProviderHost, responded: string | null): EvidenceServer | undefined {
  const endpoint = host.localEndpoint();
  if (endpoint === null) {
    return undefined;
  }
  const scope = endpointLabel(endpoint)?.scope ?? 'loopback';
  return evidenceServer(currentIdentity(host), declaredKind(host), launchedHere(host, endpoint), scope, responded);
}

export function localIdentityView(host: ProviderHost, responseObserved: boolean): LocalIdentityView {
  const endpoint = host.localEndpoint();
  const identity = currentIdentity(host);
  const artifact = artifactView(host);
  const configured = endpoint !== null || host.settings.local.modelPath.trim().length > 0;
  return {
    identity,
    artifact,
    levels: {
      configured,
      endpointVerified: identity !== null && identity.basis !== 'declared',
      artifactVerified: artifact.state === 'verified' && artifact.inUse,
      responseObserved,
    },
  };
}
