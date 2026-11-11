/**
 * "Reload in LM Studio with more context" (human validation, 2026-11-06:
 * LM Studio loaded Muse Glimmer on demand with 4,096 tokens and refused an
 * Agent request of about 6,000 with HTTP 400):
 *   - offered only after a context refusal from a server chosen as LM Studio;
 *   - nothing happens without the user's click AND the modal confirmation;
 *   - it unloads the loaded instances and loads the model's persistent key
 *     with the offered context (LM Studio REST API v1), then RAME requests
 *     that key; the thread records it; nothing reaches Meta;
 *   - with cloud escalation ON, Spark is still offered beside it.
 * Simulated LM Studio and simulated Meta only; no network, no GPU.
 */

import { lmStudioLoadedContext } from '../src/lmStudioContext.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The harness registers the fake vscode module: it loads before modules that import vscode.
import { fakeCloud, fakeWindow, HostHarness, type PostedState } from './helpers/hostHarness.js';
import { lmStudioModelState, reloadLmStudioModel, reloadTarget, RELOAD_CONTEXT_TOKENS } from '../src/lmStudioReload.js';
import { parseViewInboundMessage } from '../src/viewMessages.js';

const FULL_KEY = 'lmstudio-community/muse-glimmer-30b-gguf/muse-glimmer-30b-kquant-17gb-q4_k_m.gguf';
const CONTEXT_REFUSAL =
  'Error: Channel Error - Caused By: EngineProtocolHttpError: Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (5917 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":5917,"n_ctx":4096}}';
const MODELS = (loaded: Array<{ id: string; context: number }>) => ({
  models: [
    { type: 'llm', key: 'other/model', loaded_instances: [], max_context_length: 8192 },
    { type: 'llm', key: FULL_KEY, max_context_length: 131072, loaded_instances: loaded.map((entry) => ({ id: entry.id, config: { context_length: entry.context } })) },
  ],
});

type Issue = { kind: string; canStart: boolean; delegation: string; reload?: number; context?: true } | null;
const issueOf = (state: PostedState): Issue => (state.remote as { localIssue: Issue }).localIssue;

test('the loaded context LM Studio reports: by instance id, else the smallest instance of the key; null when unknown', () => {
  const two = { models: [{ key: FULL_KEY, loaded_instances: [{ id: FULL_KEY, config: { context_length: 32768 } }, { id: `${FULL_KEY}:2`, config: { context_length: 4096 } }] }] };
  assert.equal(lmStudioLoadedContext(two, `${FULL_KEY}:2`), 4096);
  assert.equal(lmStudioLoadedContext(two, FULL_KEY), 32768, 'the instance named exactly');
  assert.equal(lmStudioLoadedContext({ models: [{ key: FULL_KEY, loaded_instances: [{ id: 'a', config: { context_length: 32768 } }, { id: 'b', config: { context_length: 4096 } }] }] }, FULL_KEY), 4096, 'any instance of the key may answer');
  assert.equal(lmStudioLoadedContext(MODELS([]), FULL_KEY), null, 'not loaded');
  assert.equal(lmStudioLoadedContext(MODELS([{ id: 'muse-glimmer', context: 0 }]), 'muse-glimmer'), null, 'no context given');
  assert.equal(lmStudioLoadedContext({ data: [] }, FULL_KEY), null, 'not the v1 list');
});

test('the offered context: 32,768, or more when the refused request needs it, in 8,192 steps', () => {
  assert.equal(RELOAD_CONTEXT_TOKENS, 32768);
  assert.equal(reloadTarget(null), 32768);
  assert.equal(reloadTarget(5917), 32768);
  assert.equal(reloadTarget(30000), 49152, '30,000 × 1.5 rounded up to 8,192 steps');
});

test('LM Studio API: the model is found by key or by a loaded instance id; unload then load with the context', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/api/v1/models')) return Response.json(MODELS([{ id: 'muse-glimmer', context: 4096 }]));
    if (url.endsWith('/unload')) return Response.json({ instance_id: 'muse-glimmer' });
    return Response.json({ type: 'llm', instance_id: FULL_KEY, load_time_seconds: 8.4, status: 'loaded', load_config: { context_length: 32768 } });
  };
  const byInstance = await lmStudioModelState('http://127.0.0.1:1234', 'muse-glimmer', fetchImpl);
  assert.deepEqual(byInstance, { key: FULL_KEY, instances: [{ id: 'muse-glimmer', context: 4096 }], maxContext: 131072 });
  assert.equal((await lmStudioModelState('http://127.0.0.1:1234', FULL_KEY, fetchImpl))?.key, FULL_KEY);
  assert.equal(await lmStudioModelState('http://127.0.0.1:1234', 'missing', fetchImpl), null);
  calls.length = 0;
  const done = await reloadLmStudioModel('http://127.0.0.1:1234/', byInstance!, 32768, fetchImpl);
  assert.deepEqual(done, { instanceId: FULL_KEY, contextLength: 32768, seconds: 8 });
  assert.deepEqual(calls, [
    { url: 'http://127.0.0.1:1234/api/v1/models/unload', method: 'POST', body: { instance_id: 'muse-glimmer' } },
    { url: 'http://127.0.0.1:1234/api/v1/models/load', method: 'POST', body: { model: FULL_KEY, context_length: 32768, echo_load_config: true } },
  ]);
});

test('a refused load says so with LM Studio\'s words', async () => {
  const fetchImpl = async (url: string) =>
    url.endsWith('/load') ? Response.json({ error: { message: 'Failed to load model: insufficient VRAM' } }, { status: 500 }) : Response.json({});
  await assert.rejects(
    reloadLmStudioModel('http://127.0.0.1:1234', { key: FULL_KEY, instances: [], maxContext: null }, 32768, fetchImpl),
    /^Error: LM Studio refused the load request \(HTTP 500\): Failed to load model: insufficient VRAM\.$/,
  );
});

test('the view message has exact keys', () => {
  assert.deepEqual(parseViewInboundMessage({ type: 'localIssueReload' }), { type: 'localIssueReload' });
  assert.throws(() => parseViewInboundMessage({ type: 'localIssueReload', context: 131072 }), 'the host decides the context, never the view');
});

/**
 * `reportedContext`: the context LM Studio's model list gives for the loaded instance. 0 = it says
 * nothing (an older LM Studio), so the request reaches the server and the server refuses it; a size
 * makes RAME refuse before sending (lmStudioContext.ts).
 */
async function withLmStudio(settings: Record<string, unknown>, body: (h: HostHarness, calls: Array<{ method: string; url: string; body: unknown }>) => Promise<void>, reportedContext = 0): Promise<void> {
  const h = new HostHarness({ folders: 1 });
  await h.start({ agentProfile: 'safe-auto', externalLocal: { model: 'muse-glimmer', kind: 'lmstudio', tools: true, context: 4096, lan: false }, ...settings });
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let loaded = [{ id: 'muse-glimmer', context: reportedContext }];
  h.model.metadata = (method, url, raw) => {
    if (url.startsWith('/api/v1/models')) {
      calls.push({ method, url, body: raw ? JSON.parse(raw) : null });
      if (url === '/api/v1/models/unload') {
        loaded = [];
        return { instance_id: 'muse-glimmer' };
      }
      if (url === '/api/v1/models/load') {
        loaded = [{ id: FULL_KEY, context: 32768 }];
        return { type: 'llm', instance_id: FULL_KEY, load_time_seconds: 7.6, status: 'loaded', load_config: { context_length: 32768 } };
      }
      return MODELS(loaded);
    }
    return method === 'GET' && url === '/v1/models' ? { data: loaded.map((entry) => ({ id: entry.id })) } : undefined;
  };
  fakeCloud.requests.length = 0;
  fakeCloud.handler = () => Response.json({ error: { message: 'must not be called' } }, { status: 500 });
  fakeWindow.warningAnswers.length = 0;
  fakeWindow.warningCalls.length = 0;
  try {
    await body(h, calls);
    assert.deepEqual(fakeCloud.requests, [], 'nothing reaches Meta');
  } finally {
    fakeCloud.handler = null;
    fakeWindow.warningAnswers.length = 0;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

const mutating = (calls: Array<{ method: string; url: string; body: unknown }>) => calls.filter((call) => call.method === 'POST');

test('host: a context refusal from LM Studio offers the reload; confirmed, it reloads with 32,768 and RAME then requests the full key', async () => {
  await withLmStudio({}, async (h, calls) => {
    h.model.enqueue({ kind: 'json', status: 400, body: { error: CONTEXT_REFUSAL } });
    await h.provider.sendMessage('ahora puedes?', 'agent', 'local');
    assert.deepEqual(issueOf(h.last()), { kind: 'failed', canStart: false, delegation: 'off', reload: 32768, context: true });
    assert.deepEqual(mutating(calls), [], 'nothing touched LM Studio before the click');
    h.send({ type: 'localIssueReload' });
    const state = await h.waitFor((s) => /^LM Studio reloaded/.test(s.status));
    assert.equal(state.status, `LM Studio reloaded ${FULL_KEY} with a 32768-token context. Send your request again.`);
    assert.equal(fakeWindow.warningCalls.length, 1, 'a modal confirmation came first');
    assert.match(fakeWindow.warningCalls[0]?.message ?? '', new RegExp(`^Reload ${FULL_KEY.replace(/[./]/g, '\\$&')} in LM Studio with a 32768-token context\\?$`));
    assert.match(fakeWindow.warningCalls[0]?.detail ?? '', /uses that computer's GPU memory: if the larger context does not fit, LM Studio refuses and the model stays unloaded/);
    assert.deepEqual(mutating(calls).map((call) => [call.url, call.body]), [
      ['/api/v1/models/unload', { instance_id: 'muse-glimmer' }],
      ['/api/v1/models/load', { model: FULL_KEY, context_length: 32768, echo_load_config: true }],
    ]);
    assert.equal(issueOf(state), null);
    assert.equal(h.provider.settings.externalLocal.model, FULL_KEY, 'the persistent key replaces the name that existed only while loaded');
    assert.match(JSON.stringify(state.turns), /LM Studio reloaded the model at your request\./);
    assert.match(JSON.stringify(state.turns), /nothing was sent to Meta/);
  });
});

test('host: the same refusal sent inside an HTTP 200 stream (as LM Studio sent it on 2026-11-10) offers the same reload', async () => {
  await withLmStudio({}, async (h, calls) => {
    h.model.enqueue({ kind: 'stream-error', error: { message: CONTEXT_REFUSAL.replace(/^.*?(Engine protocol)/, '$1').replace(/5917/g, '6828') } });
    await h.provider.sendMessage('Ahora añade también divide(a, b)', 'agent', 'local');
    const state = h.last();
    assert.deepEqual(issueOf(state), { kind: 'failed', canStart: false, delegation: 'off', reload: 32768, context: true });
    assert.doesNotMatch(state.status, /reported an error/);
    assert.match(state.status, /context is too small for this request \(6828 input tokens for a 4096-token context\)/);
    assert.deepEqual(mutating(calls), [], 'nothing touched LM Studio before the click');
  });
});

test('host: when LM Studio reports the loaded context, a request that does not fit is refused before sending (LM Studio would cut it and answer the cut conversation)', async () => {
  await withLmStudio({}, async (h, calls) => {
    await h.provider.sendMessage('Ahora añade también divide(a, b)', 'agent', 'local');
    const state = h.last();
    assert.equal(h.model.requests.length, 0, 'nothing reached LM Studio, so it had nothing to cut');
    assert.match(state.status, /The Agent stopped before model step 1: This request needs about \d+ input tokens, which leaves \d+ of the 4096-token context/);
    assert.match(state.status, /Nothing was cut and nothing was sent\./);
    assert.deepEqual(issueOf(state), { kind: 'failed', canStart: false, delegation: 'off', reload: 32768, context: true });
    assert.deepEqual(mutating(calls), []);
  }, 4096);
  await withLmStudio({}, async (h) => {
    h.model.enqueue({ kind: 'json', body: { choices: [{ message: { role: 'assistant', content: 'Hola.' } }] } });
    await h.provider.sendMessage('Di hola.', 'agent', 'local');
    assert.equal(h.model.requests.length, 1, 'with 32,768 loaded the same kind of request is sent');
    assert.equal(issueOf(h.last()), null);
  }, 32768);
});

test('host: declining the confirmation changes nothing in LM Studio', async () => {
  await withLmStudio({}, async (h, calls) => {
    h.model.enqueue({ kind: 'json', status: 400, body: { error: CONTEXT_REFUSAL } });
    await h.provider.sendMessage('ahora puedes?', 'agent', 'local');
    fakeWindow.warningAnswers.push(undefined);
    h.send({ type: 'localIssueReload' });
    const state = await h.waitFor((s) => s.status === 'Nothing was changed in LM Studio.');
    assert.deepEqual(mutating(calls), []);
    assert.equal(issueOf(state)?.reload, 32768, 'still offered');
    assert.equal(h.provider.settings.externalLocal.model, 'muse-glimmer');
  });
});

test('host: with cloud escalation ON and a key, Spark is offered beside the reload', async () => {
  await withLmStudio({ allowCloudEscalation: true }, async (h) => {
    h.secretValues.set('rameCode.metaModelApiKey', 'fake-meta-key-RELOAD-2201');
    h.model.enqueue({ kind: 'json', status: 400, body: { error: CONTEXT_REFUSAL } });
    await h.provider.sendMessage('ahora puedes?', 'agent', 'local');
    const state = h.last();
    assert.deepEqual(issueOf(state), { kind: 'failed', canStart: false, delegation: 'offered', reload: 32768, context: true });
    assert.equal(state.escalation.pending, true, 'Spark, with its 1M-token context, waits for approval; nothing sent');
  });
});

test('host: escalation turned ON in Settings after the failure offers Spark on the same card; OFF withdraws it; nothing is sent', async () => {
  await withLmStudio({}, async (h) => {
    h.secretValues.set('rameCode.metaModelApiKey', 'fake-meta-key-LATER-3302');
    (h.provider as unknown as { hasKey: boolean }).hasKey = true;
    h.model.enqueue({ kind: 'json', status: 400, body: { error: CONTEXT_REFUSAL } });
    await h.provider.sendMessage('Ahora añade también divide(a, b)', 'agent', 'local');
    assert.equal(issueOf(h.last())?.delegation, 'off');
    assert.equal(h.last().escalation.pending, false);
    h.send({ type: 'updateSettings', runtime: 'local', mode: 'agent', allowCloudEscalation: true });
    const on = await h.waitFor((s) => s.status === 'Settings saved.' && issueOf(s)?.delegation === 'offered');
    assert.deepEqual(issueOf(on), { kind: 'failed', canStart: false, delegation: 'offered', reload: 32768, context: true }, 'the reload stays beside it; the reason stays in the host');
    assert.equal(on.escalation.pending, true, 'Spark waits for the approval of the user');
    assert.match(on.escalation.reason, /context is too small for this request \(5917 input tokens for a 4096-token context\)/);
    h.send({ type: 'updateSettings', runtime: 'local', mode: 'agent', allowCloudEscalation: false });
    const off = await h.waitFor((s) => s.status === 'Settings saved.' && issueOf(s)?.delegation === 'off');
    assert.equal(off.escalation.pending, false, 'the waiting offer is withdrawn');
  });
});

test('host: not offered for other servers or other failures; an unoffered click changes nothing', async () => {
  const h = new HostHarness({ folders: 1 });
  await h.start({ agentProfile: 'safe-auto' });
  try {
    h.model.enqueue({ kind: 'json', status: 400, body: { error: CONTEXT_REFUSAL } });
    await h.provider.sendMessage('ahora puedes?', 'agent', 'local');
    assert.equal(issueOf(h.last())?.reload, undefined, 'not a server chosen as LM Studio');
    h.send({ type: 'localIssueReload' });
    await h.waitFor((s) => /^Nothing to reload/.test(s.status));
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
  await withLmStudio({}, async (h) => {
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.sendMessage('Hello?', 'agent', 'local');
    assert.equal(issueOf(h.last())?.reload, undefined, 'a failure that is not about context');
  });
});

function renderCard(issue: Issue, language: 'en' | 'es') {
  const nodes: Record<string, Record<string, unknown>> = {};
  const make = () => {
    const attributes: Record<string, string> = {};
    const classes = new Set<string>();
    return {
      hidden: false, disabled: false, checked: false, textContent: '', value: '', style: {}, options: [], firstChild: null,
      appendChild() {}, removeChild() {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, closest: () => null,
      setAttribute(name: string, value: string) { attributes[name] = value; },
      getAttribute(name: string) { return attributes[name] ?? null; },
      hasAttribute(name: string) { return name in attributes; },
      removeAttribute(name: string) { delete attributes[name]; },
      classList: { add: (...n: string[]) => n.forEach((x) => classes.add(x)), remove: (...n: string[]) => n.forEach((x) => classes.delete(x)), contains: (x: string) => classes.has(x) },
    };
  };
  const document = { getElementById: (id: string) => (nodes[id] ??= make()), createElement: () => make(), addEventListener() {}, querySelectorAll: () => [], activeElement: null };
  const window: Record<string, unknown> = {};
  const context = { window, document, setTimeout, clearTimeout, Date };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/localServersUx.js', 'utf8'), context);
  const i18n = window.RAME_I18N as { translate(language: string, text: string): string };
  const t = (text: string) => (language === 'en' ? text : i18n.translate('es', text));
  const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, i) => out.replace(`{${i}}`, String(value)), t(text));
  const remote = window.RAME_REMOTE as { init(h: unknown): void; render(data: unknown): void };
  remote.init({ vscode: { postMessage() {} }, t, tf, tHost: t, markPending: () => true, hold() {} });
  remote.render({ remote: { consult: null, delegation: null, delegationFailure: null, localIssue: issue, runtime: { local: 'connected', cloud: 'unknown', selected: 'local' } }, escalation: { pending: false, reason: '' } });
  return nodes;
}

test('the card: the reload button shows the offered context, only when offered (English and Spanish)', () => {
  const card = renderCard({ kind: 'failed', canStart: false, delegation: 'off', reload: 32768 }, 'en');
  assert.equal(card.localIssueReload?.hidden, false);
  assert.equal(card.localIssueReload?.textContent, 'Reload in LM Studio with a 32768-token context');
  assert.equal(renderCard({ kind: 'failed', canStart: false, delegation: 'off', reload: 32768 }, 'es').localIssueReload?.textContent, 'Recargar en LM Studio con 32768 tokens de contexto');
  assert.equal(renderCard({ kind: 'failed', canStart: false, delegation: 'off' }, 'en').localIssueReload?.hidden, true);
});

test('the card: a context refusal says so instead of "Glimmer answered" (English and Spanish)', () => {
  const offered = renderCard({ kind: 'failed', canStart: false, delegation: 'off', reload: 32768, context: true }, 'en');
  assert.equal(offered['local-issue-heading']?.textContent, "The request does not fit the local model's context");
  assert.match(String(offered.localIssueHint?.textContent), /too little context for this thread\. Nothing was cut\. Reload it with more context using the button below/);
  const elsewhere = renderCard({ kind: 'failed', canStart: false, delegation: 'off', context: true }, 'en');
  assert.match(String(elsewhere.localIssueHint?.textContent), /Load it with a larger context in its server/);
  assert.equal(elsewhere.localIssueReload?.hidden, true);
  const es = renderCard({ kind: 'failed', canStart: false, delegation: 'off', reload: 32768, context: true }, 'es');
  assert.equal(es['local-issue-heading']?.textContent, 'La petición no cabe en el contexto del modelo local');
  assert.match(String(es.localIssueHint?.textContent), /^El modelo está cargado con muy poco contexto para este hilo\. No se recortó nada\./);
  const other = renderCard({ kind: 'failed', canStart: false, delegation: 'off' }, 'en');
  assert.equal(other.localIssueHint?.textContent, 'Glimmer answered but the request could not complete. Check the runtime settings, or try again.');
});
