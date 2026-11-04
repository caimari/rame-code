/**
 * The header's compact runtime line, with simulated servers only:
 * "Glimmer local · …" and "Meta API · …". "connected" needs an answer in
 * this session; a stored key or a saved endpoint is only "configured".
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { buildViewHtml } from '../src/viewHtml.js';
import { assistantText, fakeCloud, HostHarness, type PostedState } from './helpers/hostHarness.js';

const API_KEY_SECRET = 'rameCode.metaModelApiKey';
const KEY = 'fake-meta-key-BADGE-0c4d';
type Runtime = { local: string; cloud: string; selected: string };
const runtimeOf = (state: PostedState): Runtime => (state.remote as { runtime: Runtime }).runtime;

async function withHarness(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start(settings);
  fakeCloud.requests.length = 0;
  fakeCloud.handler = null;
  try {
    await body(h);
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

const OWNED = { executablePath: '/opt/llama/llama-server', modelPath: '/models/glimmer.gguf', projectorPath: '', draftModelPath: '', modelId: 'local-glimmer', contextSize: 32768, port: 8775, idleTimeoutSec: 900 };

test('local: an endpoint is "configured" until it answers, then "connected"; an owned server is "stopped" or "not configured"', async () => {
  await withHarness({}, async (h) => {
    await h.provider.refreshAll();
    assert.equal(runtimeOf(h.last()).local, 'configured', 'saved, /props did not answer');
    h.model.enqueue({ kind: 'json', body: assistantText('Hello.') });
    await h.provider.sendMessage('Hi.', 'chat', 'local');
    assert.equal(runtimeOf(h.last()).local, 'connected', 'it answered a request');
    assert.equal(runtimeOf(h.last()).selected, 'local');
  });
  await withHarness({}, async (h) => {
    h.model.props = { default_generation_settings: { n_ctx: 32768 } };
    await h.provider.refreshAll();
    assert.equal(runtimeOf(h.last()).local, 'connected', '/props answered');
  });
  await withHarness({ externalLocalEndpoint: '', local: OWNED }, async (h) => {
    await h.provider.refreshAll();
    assert.equal(runtimeOf(h.last()).local, 'stopped');
  });
  await withHarness({ externalLocalEndpoint: '' }, async (h) => {
    await h.provider.refreshAll();
    assert.equal(runtimeOf(h.last()).local, 'not-configured');
  });
});

test('Meta API: a stored key is only "configured"; an answer makes it "connected"; an authentication failure or a new key does not stay "connected"', async () => {
  await withHarness({ provider: 'cloud', model: 'muse-spark-1.3', allowCloudEscalation: true }, async (h) => {
    await h.provider.refreshAll();
    assert.equal(runtimeOf(h.last()).cloud, 'not-configured');
    h.secretValues.set(API_KEY_SECRET, KEY);
    await h.provider.refreshAll();
    assert.equal(runtimeOf(h.last()).cloud, 'configured', 'a stored key is not a verified connection');
    fakeCloud.handler = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    await h.provider.sendMessage('Hi.', 'chat', 'cloud');
    assert.equal(fakeCloud.requests.length, 1);
    assert.equal(runtimeOf(h.last()).cloud, 'connected');
    assert.equal(runtimeOf(h.last()).selected, 'cloud');
    // A new key has not answered yet.
    const posted = h.posted.length;
    await h.provider.saveKey('fake-meta-key-BADGE-second-77aa');
    const stored = h.posted.slice(posted).find((state) => /API key stored/.test(state.status));
    assert.ok(stored, 'the state posted as soon as the key is stored');
    assert.equal(runtimeOf(stored).cloud, 'configured', 'not "connected" even before the model refresh ends');
    assert.notEqual(runtimeOf(h.last()).cloud, 'connected');
  });
});

test('the header line: both runtimes, the selected one marked, text only, and safe at a narrow width', () => {
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js' });
  const header = html.slice(html.indexOf('<header class="view-header">'), html.indexOf('</header>'));
  assert.match(header, /<p id="runtimeBadge" role="status"><span id="runtimeBadgeLocal"><\/span><span id="runtimeBadgeCloud"><\/span><\/p>/);
  assert.match(html, /#chatScreen \.view-header \{ flex-wrap: wrap;/);
  // The title shrinks first: the toolbar never wraps under it (seen in Chromium at 200 px).
  assert.match(html, /#chatScreen \.view-header \.view-title \{ flex-basis: 0; \}/);
  assert.match(html, /#runtimeBadge \{ flex: 1 0 100%; order: 3;[^}]*overflow: hidden;[^}]*white-space: nowrap; \}/);
  assert.match(html, /#runtimeBadge span \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; \}/);
  assert.match(html, /#runtimeBadge span\[data-state="running"\], #runtimeBadge span\[data-state="connected"\] \{ color: var\(--vscode-testing-iconPassed/);
  const nodes: Record<string, { textContent: string; attributes: Record<string, string> }> = {};
  const node = () => ({ hidden: false, textContent: '', attributes: {} as Record<string, string>, firstChild: null, setAttribute(name: string, value: string) { this.attributes[name] = value; }, addEventListener() {} });
  const context = {
    window: {} as { RAME_REMOTE?: { init(h: unknown): void; render(data: unknown): void }; RAME_I18N?: { translate(language: string, text: string): string } },
    document: { getElementById: (id: string) => (nodes[id] ??= node()), createElement: () => node() },
  };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  const show = (language: 'en' | 'es', runtime: Runtime) => {
    const t = (text: string) => (language === 'en' ? text : (context.window.RAME_I18N?.translate('es', text) ?? text));
    const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), t(text));
    context.window.RAME_REMOTE?.init({ vscode: { postMessage() {} }, t, tf, tHost: t, markPending: () => true, hold() {} });
    context.window.RAME_REMOTE?.render({ remote: { consult: null, delegation: null, delegationFailure: null, localIssue: null, runtime }, escalation: { pending: false, reason: '' } });
    return [nodes.runtimeBadgeLocal.textContent, nodes.runtimeBadgeCloud.textContent, nodes.runtimeBadgeLocal.attributes['data-selected'], nodes.runtimeBadgeCloud.attributes['data-selected']];
  };
  assert.deepEqual(show('en', { local: 'running', cloud: 'configured', selected: 'local' }), ['Glimmer local · running', 'Meta API · configured', 'true', 'false']);
  assert.equal(nodes.runtimeBadgeLocal.attributes['data-state'], 'running');
  assert.equal(nodes.runtimeBadgeCloud.attributes['data-state'], 'configured');
  assert.deepEqual(show('en', { local: 'not-configured', cloud: 'connected', selected: 'cloud' }), ['Glimmer local · not configured', 'Meta API · connected', 'false', 'true']);
  assert.equal(nodes.runtimeBadgeCloud.attributes['data-state'], 'connected');
  assert.deepEqual(show('es', { local: 'connected', cloud: 'not-configured', selected: 'local' }), ['Glimmer local · conectado', 'Meta API · sin configurar', 'true', 'false']);
  assert.deepEqual(show('es', { local: 'stopped', cloud: 'configured', selected: 'local' }), ['Glimmer local · parado', 'Meta API · configurado', 'true', 'false']);
});
