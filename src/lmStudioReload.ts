/**
 * "Reload in LM Studio with more context" after a local request failed
 * because the model was loaded with too small a context (seen 2026-11-06:
 * LM Studio loaded Muse Glimmer on demand with 4,096 tokens; an Agent request
 * with a project folder needed about 6,000).
 *
 * RAME never starts or stops a server it does not own. This is the one
 * exception, and only:
 *   - for a server the user chose as LM Studio, at the saved endpoint (a
 *     private-network one only after the user's existing LAN confirmation);
 *   - offered after a context refusal, never by itself;
 *   - on the user's click AND a modal confirmation naming the model, the
 *     server and the context size.
 * It uses LM Studio's documented REST API v1 (LM Studio 0.4.0 or newer):
 * GET /api/v1/models, POST /api/v1/models/unload {instance_id},
 * POST /api/v1/models/load {model, context_length, echo_load_config}.
 * Nothing is sent to Meta. A load that does not fit leaves the model
 * unloaded, and the user is told so.
 */

import * as vscode from 'vscode';

import { withBoundedRequest } from './boundedRequest.js';
import { endpointUsable, isLocalOrPrivateUrl } from './localServers.js';
import type { ProviderHost } from './providerTypes.js';
import { appendHostNoteTurn } from './threadStore.js';

export { lmStudioReloadOffer, reloadTarget, RELOAD_CONTEXT_TOKENS } from './lmStudioReloadOffer.js';

const LIST_TIMEOUT_MS = 10_000;
/** A 17 GB model read from a hard disk can take minutes. */
const LOAD_TIMEOUT_MS = 5 * 60_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LmStudioModelState {
  /** The model's persistent key: what a load names and what RAME should request. */
  key: string;
  instances: Array<{ id: string; context: number | null }>;
  maxContext: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

async function json(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number, what: string): Promise<unknown> {
  return withBoundedRequest(undefined, timeoutMs, `LM Studio did not answer the ${what} request in time.`, async (signal) => {
    const response = await fetchImpl(url, { ...init, signal, redirect: 'manual' });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = isRecord(payload) ? payload.error : null;
      const text = typeof error === 'string' ? error : isRecord(error) && typeof error.message === 'string' ? error.message : '';
      throw new Error(`LM Studio refused the ${what} request (HTTP ${response.status})${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}.`);
    }
    return payload;
  });
}

/** What LM Studio says about `model` (a key, or the id of a loaded instance), or null when it does not list it. */
export async function lmStudioModelState(endpoint: string, model: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<LmStudioModelState | null> {
  const payload = await json(fetchImpl, `${endpoint.replace(/\/+$/, '')}/api/v1/models`, { method: 'GET' }, LIST_TIMEOUT_MS, 'model list');
  const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models.filter(isRecord) : [];
  for (const item of models) {
    if (typeof item.key !== 'string') {
      continue;
    }
    const instances = (Array.isArray(item.loaded_instances) ? item.loaded_instances.filter(isRecord) : [])
      .filter((instance): instance is Record<string, unknown> & { id: string } => typeof instance.id === 'string')
      .map((instance) => ({ id: instance.id, context: positive(isRecord(instance.config) ? instance.config.context_length : null) }));
    if (item.key === model || instances.some((instance) => instance.id === model)) {
      return { key: item.key, instances, maxContext: positive(item.max_context_length) };
    }
  }
  return null;
}

/** Unload every loaded instance of the model, then load it with `contextLength`. */
export async function reloadLmStudioModel(
  endpoint: string,
  state: LmStudioModelState,
  contextLength: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ instanceId: string; contextLength: number; seconds: number | null }> {
  const base = endpoint.replace(/\/+$/, '');
  const post = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  for (const instance of state.instances) {
    await json(fetchImpl, `${base}/api/v1/models/unload`, { ...post, body: JSON.stringify({ instance_id: instance.id }) }, LIST_TIMEOUT_MS, 'unload');
  }
  const loaded = await json(
    fetchImpl,
    `${base}/api/v1/models/load`,
    { ...post, body: JSON.stringify({ model: state.key, context_length: contextLength, echo_load_config: true }) },
    LOAD_TIMEOUT_MS,
    'load',
  );
  const config = isRecord(loaded) && isRecord(loaded.load_config) ? loaded.load_config : null;
  return {
    instanceId: isRecord(loaded) && typeof loaded.instance_id === 'string' ? loaded.instance_id : state.key,
    contextLength: positive(config?.context_length) ?? contextLength,
    seconds: isRecord(loaded) && typeof loaded.load_time_seconds === 'number' ? Math.round(loaded.load_time_seconds) : null,
  };
}

/** The "Reload in LM Studio…" button of a failed request: only when the host offered it, after a modal confirmation. */
export async function reloadAfterLocalIssue(host: ProviderHost, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<void> {
  const issue = host.localIssue;
  const endpoint = host.settings.externalLocalEndpoint.trim();
  const model = host.settings.externalLocal.model.trim();
  const offered = issue !== null && typeof issue.reload === 'number' ? issue.reload : null;
  if (
    offered === null ||
    host.settings.externalLocal.kind !== 'lmstudio' ||
    model.length === 0 ||
    !isLocalOrPrivateUrl(endpoint) ||
    !endpointUsable(endpoint, host.settings.externalLocal.lan) ||
    host.localEndpoint() !== endpoint
  ) {
    host.status = 'Nothing to reload: this is offered only after LM Studio refused a request for lack of context.';
    await host.postState();
    return;
  }
  if (host.running || host.missionRunner.isRunning || host.chatRunner.isRunning || host.agentRunner.isRunning) {
    host.status = 'A request is running. Cancel it or wait before reloading the model in LM Studio. Nothing was changed.';
    await host.postState();
    return;
  }
  let state: LmStudioModelState | null;
  try {
    state = await lmStudioModelState(endpoint, model, fetchImpl);
  } catch (error) {
    host.status = `${error instanceof Error ? error.message : 'LM Studio did not answer.'} Nothing was changed.`;
    await host.postState();
    return;
  }
  if (state === null) {
    host.status = `LM Studio does not list the model "${model}". Nothing was changed. Choose a model in Settings › Runtime › Find models.`;
    await host.postState();
    return;
  }
  const target = state.maxContext !== null ? Math.min(offered, state.maxContext) : offered;
  const answer = await vscode.window.showWarningMessage(
    `Reload ${state.key} in LM Studio with a ${target}-token context?`,
    {
      modal: true,
      detail:
        `LM Studio at ${endpoint} unloads the model and loads it again with a ${target}-token context. ` +
        "It uses that computer's GPU memory: if the larger context does not fit, LM Studio refuses and the model stays unloaded until you load it there. " +
        'Nothing is sent to Meta.',
    },
    'Reload',
  );
  if (answer !== 'Reload') {
    host.status = 'Nothing was changed in LM Studio.';
    await host.postState();
    return;
  }
  const threadId = issue?.threadId ?? null;
  host.status = `Reloading ${state.key} in LM Studio with a ${target}-token context…`;
  await host.postState();
  const record = (title: string, lines: string[]): void => {
    const thread = threadId === null ? undefined : host.store.get(threadId);
    if (thread) {
      host.store.save(appendHostNoteTurn(thread, title, lines.map((line) => `• ${line}`)));
    }
  };
  try {
    const done = await reloadLmStudioModel(endpoint, state, target, fetchImpl);
    host.localIssue = null;
    // A short name exists only while the model is loaded: RAME now asks for its persistent key.
    const renamed = model !== state.key;
    if (renamed) {
      host.settings = { ...host.settings, externalLocal: { ...host.settings.externalLocal, model: state.key } };
      host.persistSettings();
    }
    record('LM Studio reloaded the model at your request.', [
      `model ${state.key}, context ${done.contextLength} tokens${done.seconds !== null ? `, loaded in ${done.seconds} s` : ''}`,
      ...(renamed ? [`RAME now requests ${state.key} instead of "${model}", a name that existed only while the model was loaded`] : []),
      'nothing was sent to Meta',
    ]);
    host.status = `LM Studio reloaded ${state.key} with a ${done.contextLength}-token context. Send your request again.`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'LM Studio did not answer.';
    record('LM Studio could not reload the model.', [detail.slice(0, 300), 'the model may now be unloaded: load it in LM Studio with a smaller context', 'nothing was sent to Meta']);
    host.status = `${detail} The model may now be unloaded in LM Studio; load it there with a smaller context.`;
  }
  await host.postState();
}
