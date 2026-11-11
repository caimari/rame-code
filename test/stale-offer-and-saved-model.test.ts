/**
 * Two things seen in human validation on 2026-11-06 (Windows, LM Studio):
 *   - the "Run this request with Spark" card stayed on screen after its offer
 *     expired (offers last 15 minutes); clicking it only printed "That
 *     approval does not match a waiting delegated run" and nothing changed;
 *   - Settings → Model servers showed an empty model selector after a
 *     reload, although a model was saved ("In use: muse-glimmer").
 * Simulated local server and simulated Meta only; no network, no GPU.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { DELEGATION_OFFER_TTL_MS } from '../src/remoteAuthority.js';
import { fakeCloud, HostHarness } from './helpers/hostHarness.js';

const API_KEY_SECRET = 'rameCode.metaModelApiKey';

test('an expired Spark offer: approving it withdraws the card and says why; nothing reaches Meta', async () => {
  const h = new HostHarness({ folders: 1 });
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true });
  h.secretValues.set(API_KEY_SECRET, 'fake-meta-key-STALE-4410');
  fakeCloud.requests.length = 0;
  fakeCloud.handler = () => Response.json({ error: { message: 'must not be called' } }, { status: 500 });
  try {
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
    assert.equal(h.last().escalation.pending, true, 'offered');
    const offer = h.provider.delegationOffer;
    assert.ok(offer);
    offer.createdAt -= DELEGATION_OFFER_TTL_MS + 1000;
    h.send({ type: 'escalateApprove', digest: offer.digest });
    const state = await h.waitFor((s) => /expired/.test(s.status));
    assert.match(state.status, /^That offer to run the request with Spark expired \(offers last 15 minutes\)\. Nothing was sent; send the request again to get a new one\.$/);
    assert.equal(state.escalation.pending, false, 'the card leaves the view');
    assert.equal((state.remote as { delegation: unknown }).delegation, null);
    assert.equal(h.provider.delegationOffer, null);
    assert.deepEqual(fakeCloud.requests, []);
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('an expired Spark offer leaves the view on the next refresh, without a click', async () => {
  const h = new HostHarness({ folders: 1 });
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true });
  h.secretValues.set(API_KEY_SECRET, 'fake-meta-key-STALE-4411');
  fakeCloud.requests.length = 0;
  try {
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
    const offer = h.provider.delegationOffer;
    assert.ok(offer);
    offer.createdAt -= DELEGATION_OFFER_TTL_MS + 1000;
    await h.provider.postState();
    assert.equal(h.last().escalation.pending, false);
    assert.equal(h.provider.delegationOffer, null);
    assert.deepEqual(fakeCloud.requests, []);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

/** The model selector of Settings → Model servers, with a select that behaves like the DOM's. */
function renderSelector(servers: Record<string, unknown>, language: 'en' | 'es' = 'en') {
  type Option = { value: string; textContent: string };
  const nodes: Record<string, Record<string, unknown>> = {};
  const plain = () => {
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
  const options: Option[] = [];
  let index = -1;
  const select = Object.assign(plain(), {
    options,
    get firstChild() { return options[0] ?? null; },
    appendChild(option: Option) { options.push(option); },
    removeChild(option: Option) { options.splice(options.indexOf(option), 1); index = -1; },
    get value() { return options[index]?.value ?? ''; },
    set value(value: string) { index = options.findIndex((option) => option.value === value); },
    get selectedIndex() { return index; },
    set selectedIndex(value: number) { index = value; },
  });
  nodes.serverModel = select as unknown as Record<string, unknown>;
  const document = {
    getElementById: (id: string) => (nodes[id] ??= plain()),
    createElement: () => ({ value: '', textContent: '' }),
    addEventListener() {},
    querySelectorAll: () => [],
    activeElement: null,
  };
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
  remote.render({
    status: '',
    externalLocalEndpoint: servers.endpoint,
    localSettings: { modelPath: '', modelId: 'local-glimmer' },
    remote: { runtime: { local: 'connected', cloud: 'not-configured', selected: 'local' }, servers: { lan: true, scanError: '', web: {}, shell: {}, kind: 'lmstudio', ...servers } },
    escalation: { pending: false, reason: '' },
  });
  return { select: select as unknown as { value: string; disabled: boolean }, options };
}

const ENDPOINT = 'http://10.0.0.2:1235';
const FULL_KEY = 'lmstudio-community/muse-glimmer-30b-gguf/muse-glimmer-30b-kquant-17gb-q4_k_m.gguf';

test('after a reload (no scan yet) the saved model is shown and selected, not an empty selector', () => {
  const { select, options } = renderSelector({ endpoint: ENDPOINT, model: 'muse-glimmer', scan: null });
  assert.equal(options.length, 1);
  assert.equal(select.value, 'muse-glimmer');
  assert.equal(options[0]?.textContent, 'muse-glimmer (in use — Find models lists the others)');
  assert.equal(select.disabled, true, 'nothing else to choose until Find models');
  const es = renderSelector({ endpoint: ENDPOINT, model: 'muse-glimmer', scan: null }, 'es');
  assert.equal(es.options[0]?.textContent, 'muse-glimmer (en uso — «Buscar modelos» lista los demás)');
});

test('the server no longer lists the saved model (an LM Studio name that existed only while loaded): it says so, and the full names are offered', () => {
  const scan = { kind: 'lmstudio', endpoint: ENDPOINT, scope: 'private', version: '', models: [{ id: FULL_KEY, tools: true, vision: true, loadedContext: null, maxContext: 131072, loaded: false }] };
  const { select, options } = renderSelector({ endpoint: ENDPOINT, model: 'muse-glimmer', scan });
  assert.deepEqual(options.map((option) => option.value), ['muse-glimmer', FULL_KEY]);
  assert.equal(options[0]?.textContent, 'muse-glimmer (in use — the server does not list it now)');
  assert.equal(select.value, 'muse-glimmer', 'still shows what is saved');
  assert.equal(select.disabled, false, 'another model can be chosen');
});

test('a listed saved model appears once, with its server facts', () => {
  const scan = { kind: 'lmstudio', endpoint: ENDPOINT, scope: 'private', version: '', models: [{ id: 'muse-glimmer', tools: true, vision: false, loadedContext: 32768, maxContext: 131072, loaded: true }] };
  const { select, options } = renderSelector({ endpoint: ENDPOINT, model: 'muse-glimmer', scan });
  assert.equal(options.length, 1);
  assert.match(options[0]?.textContent ?? '', /^muse-glimmer \(tools, loaded, context 32768\)$/);
  assert.equal(select.value, 'muse-glimmer');
});

test('the Spark card stays in the thread whose request failed: a new thread never shows it, and coming back does', async () => {
  const h = new HostHarness({ folders: 1 });
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true });
  h.secretValues.set(API_KEY_SECRET, 'fake-meta-key-STALE-4412');
  fakeCloud.requests.length = 0;
  try {
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
    const failed = h.last().activeThreadId as string;
    assert.equal(h.last().escalation.pending, true);
    await h.provider.newThread();
    assert.equal(h.last().escalation.pending, false, 'not shown in another thread (seen 2026-11-06: its button did nothing there)');
    assert.equal((h.last().remote as { delegation: unknown }).delegation, null);
    h.send({ type: 'openThread', threadId: failed });
    const back = await h.waitFor((s) => s.activeThreadId === failed);
    assert.equal(back.escalation.pending, true, 'still offered where it belongs, until it expires');
    assert.ok((back.remote as { delegation: unknown }).delegation);
    assert.deepEqual(fakeCloud.requests, []);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});
