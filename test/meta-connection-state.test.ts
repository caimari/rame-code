/**
 * The Meta connection state the view shows (Scope / boundaries line and
 * header) after real answers, failures and key changes, reproduced with the
 * simulated Meta API (no real call). Human validation of e383ea4 showed
 * "Key stored — live connection not yet verified" after two valid Meta
 * replies, while the header said "connected".
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { idleConnection } from '../src/connectionState.js';
import { viewConnectionLabel } from '../src/viewMessages.js';
import { fakeCloud, HostHarness, type PostedState } from './helpers/hostHarness.js';

const KEY = 'fake-meta-key-CONNECTION-STATE-1';
const ok = (text = 'A valid answer.') => () => Response.json({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
const cloudState = (state: PostedState) => (state.remote as { runtime: { cloud: string } }).runtime.cloud;
const evidenceCloud = (state: PostedState) => (state.modelEvidence as { now: { cloud: { observed: boolean } } }).now.cloud.observed;
const toolCall = (name: string, args: unknown) => () =>
  Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });

async function withCloud(body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ provider: 'cloud', model: 'muse-spark-1.3', cloudModel: 'muse-spark-1.3', mode: 'chat' });
  h.secretValues.set('rameCode.metaModelApiKey', KEY);
  fakeCloud.requests.length = 0;
  fakeCloud.handler = null;
  try {
    await h.provider.refreshAll();
    await body(h);
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

/** Run to the end, answering "withhold" to any disclosure card (there is no earlier local text here). */
async function settle(h: HostHarness): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    const state = await h.waitFor((s) => !s.running || (s.remote as { disclosure: unknown }).disclosure !== null, 8000);
    const card = (state.remote as { disclosure: { digest: string } | null }).disclosure;
    if (card === null) {
      return;
    }
    h.send({ type: 'disclosureDecide', digest: card.digest, choice: 'withhold', toolResults: true });
    await h.waitFor((s) => (s.remote as { disclosure: { digest: string } | null }).disclosure?.digest !== card.digest, 8000);
  }
  await h.waitFor((s) => !s.running, 8000);
}

async function chat(h: HostHarness, text: string): Promise<void> {
  await h.provider.sendMessage(text, 'chat', 'cloud');
  await h.waitFor((state) => !state.running, 8000);
}

test('a stored key with no answer is not verified; a valid Meta answer is, and stays verified after the view reloads', async () => {
  await withCloud(async (h) => {
    assert.equal(h.last().connection, 'ready');
    assert.equal(viewConnectionLabel('ready'), 'Key stored — live connection not yet verified');
    assert.equal(cloudState(h.last()), 'configured');
    fakeCloud.handler = ok();
    await chat(h, 'Explain what a WAV file is in one sentence.');
    await chat(h, 'Who am I talking to?');
    assert.equal(fakeCloud.requests.length, 2, 'two simulated Meta answers');
    assert.equal(h.last().connection, 'verified');
    assert.equal(cloudState(h.last()), 'connected');
    // The bug: refreshing the view reset the line to "Key stored — live connection not yet verified".
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'verified', 'Scope / boundaries and the header agree after a reload');
    assert.equal(cloudState(h.last()), 'connected');
    await h.provider.refreshHasKey();
    assert.equal(h.last().connection, 'verified');
  });
});

test('a failed, cancelled or malformed Meta request never marks the connection verified', async () => {
  await withCloud(async (h) => {
    fakeCloud.handler = () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    await chat(h, 'First request with a rejected key.');
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'ready');
    assert.equal(cloudState(h.last()), 'configured');
    fakeCloud.handler = () => Response.json({ choices: [] });
    await chat(h, 'A malformed answer this time.');
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'ready', 'malformed');
    // The fake API also accepts a pending answer (it resolves promises like the real fetch).
    fakeCloud.handler = (() => new Promise<Response>(() => undefined)) as unknown as () => Response;
    const run = h.provider.sendMessage('A request that will be cancelled.', 'chat', 'cloud');
    await h.waitFor(() => fakeCloud.requests.length === 3, 8000);
    h.provider.cancelRequest();
    await run;
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'ready', 'cancelled');
    assert.equal(cloudState(h.last()), 'configured');
  });
});

test('a new key, a removed key or an authentication failure ends an earlier verification', async () => {
  await withCloud(async (h) => {
    fakeCloud.handler = ok();
    await chat(h, 'A valid request first.');
    assert.equal(h.last().connection, 'verified');
    await h.provider.saveKey('fake-meta-key-REPLACED-2');
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'ready', 'a replaced key is not verified by the old answer');
    assert.equal(cloudState(h.last()), 'configured');
    await chat(h, 'Valid again with the new key.');
    assert.equal(h.last().connection, 'verified');
    fakeCloud.handler = () => new Response(JSON.stringify({ error: { message: 'revoked' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    await chat(h, 'Now the key was revoked.');
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'ready', 'an authentication failure ends the verification');
    assert.equal(cloudState(h.last()), 'configured');
    await h.provider.clearKey();
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'missing-key');
    assert.equal(cloudState(h.last()), 'not-configured');
  });
});

test('the idle state follows the selected runtime only', () => {
  const base = { running: false, hasKey: true, cloudConfirmed: false, localConfirmed: null, localEndpoint: null };
  assert.equal(idleConnection({ ...base, provider: 'cloud' }), 'ready');
  assert.equal(idleConnection({ ...base, provider: 'cloud', cloudConfirmed: true }), 'verified');
  assert.equal(idleConnection({ ...base, provider: 'cloud', hasKey: false, cloudConfirmed: true }), 'missing-key');
  assert.equal(idleConnection({ ...base, provider: 'cloud', running: true, cloudConfirmed: true }), 'working');
  assert.equal(idleConnection({ ...base, provider: 'local', cloudConfirmed: true, localEndpoint: 'http://127.0.0.1:8775' }), 'ready', 'a Meta answer does not verify the local runtime');
  assert.equal(idleConnection({ ...base, provider: 'local', localEndpoint: 'http://127.0.0.1:8775', localConfirmed: 'http://127.0.0.1:8775' }), 'verified');
  assert.equal(idleConnection({ ...base, provider: 'local', localEndpoint: 'http://127.0.0.1:8775', localConfirmed: 'http://127.0.0.1:9999' }), 'ready', 'another endpoint answered');
});

test('Agent with Meta: a valid step verifies; a malformed reply does not; Model evidence says the same as the header', async () => {
  await withCloud(async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true }));
    fakeCloud.handler = () => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: '{not json' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    await h.provider.sendMessage('Look at package.json.', 'agent', 'cloud');
    await settle(h);
    assert.ok(fakeCloud.requests.length >= 1, 'Meta was asked');
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'ready', 'a malformed Agent reply is not a verified connection');
    assert.equal(cloudState(h.last()), 'configured');
    assert.equal(evidenceCloud(h.last()), false);
    let n = 0;
    fakeCloud.handler = (body) => {
      n += 1;
      return n === 1 ? toolCall('read_file', { path: 'package.json' })() : ok('package.json names the project p.')();
    };
    await h.provider.sendMessage('Read package.json and tell me its name.', 'agent', 'cloud');
    await settle(h);
    assert.ok(n >= 2, 'Agent ran a step with Meta');
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'verified');
    assert.equal(cloudState(h.last()), 'connected');
    assert.equal(evidenceCloud(h.last()), true);
  });
});

test('a Mission plan from Meta verifies the connection; a failed or invalid plan request does not', async () => {
  await withCloud(async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node t.js' } }));
    fakeCloud.handler = () => new Response('{}', { status: 500 });
    await h.provider.sendMessage('Plan a small cleanup.', 'mission', 'cloud');
    await settle(h);
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'ready', 'HTTP 500');
    fakeCloud.handler = ok(JSON.stringify({ goal: 'Clean up', assumptions: [], steps: [{ id: 's1', title: 'Tidy' }], risks: [] }));
    await h.provider.sendMessage('Plan a small cleanup.', 'mission', 'cloud');
    await settle(h);
    assert.match(h.last().status, /invalid step/);
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'ready', 'an invalid plan is not a verified connection');
    assert.equal(cloudState(h.last()), 'configured');
    const plan = { goal: 'Clean up the project.', assumptions: [], steps: [{ id: 't1', title: 'Remove dead code', successCriterion: 'npm:test passes' }], risks: [] };
    fakeCloud.handler = ok(JSON.stringify(plan));
    await h.provider.sendMessage('Plan a small cleanup.', 'mission', 'cloud');
    await settle(h);
    assert.match(h.last().status, /Plan ready/);
    await h.provider.refreshAll();
    assert.equal(h.last().connection, 'verified');
    assert.equal(cloudState(h.last()), 'connected');
  });
});

test('the conversation chip describes the selected runtime, in English and Spanish', () => {
  const nodes: Record<string, { textContent: string; attributes: Record<string, string> }> = {};
  const node = () => ({ hidden: false, textContent: '', attributes: {} as Record<string, string>, firstChild: null, setAttribute(name: string, value: string) { this.attributes[name] = value; }, addEventListener() {} });
  const context = {
    window: {} as { RAME_REMOTE?: { init(h: unknown): void; render(data: unknown): void }; RAME_I18N?: { translate(language: string, text: string): string } },
    document: { getElementById: (id: string) => (nodes[id] ??= node()), createElement: () => node() },
  };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  const chip = (language: 'en' | 'es', connection: string, runtime: { local: string; cloud: string; selected: string }) => {
    const t = (text: string) => (language === 'en' ? text : (context.window.RAME_I18N?.translate('es', text) ?? text));
    const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), t(text));
    nodes.connection = node();
    nodes.connection.textContent = `main.js: ${connection}`;
    context.window.RAME_REMOTE?.init({ vscode: { postMessage() {} }, t, tf, tHost: t, markPending: () => true, hold() {} });
    context.window.RAME_REMOTE?.render({ connection, remote: { consult: null, delegation: null, delegationFailure: null, localIssue: null, runtime }, escalation: { pending: false, reason: '' } });
    return nodes.connection.textContent;
  };
  // The reported case: Glimmer local selected, Meta answered (Advisory or Agent): no "Key stored" line.
  assert.equal(chip('en', 'ready', { local: 'running', cloud: 'connected', selected: 'local' }), 'Glimmer local — running, not verified yet');
  assert.equal(chip('en', 'verified', { local: 'running', cloud: 'connected', selected: 'local' }), 'Glimmer local — verified: it answered in this session');
  assert.equal(chip('en', 'ready', { local: 'connected', cloud: 'configured', selected: 'local' }), 'Glimmer local — verified: it answered in this session');
  assert.equal(chip('en', 'missing-key', { local: 'not-configured', cloud: 'not-configured', selected: 'local' }), 'Glimmer local — not configured');
  assert.equal(chip('es', 'ready', { local: 'configured', cloud: 'connected', selected: 'local' }), 'Glimmer local — configurado, aún sin verificar');
  assert.equal(chip('es', 'verified', { local: 'running', cloud: 'connected', selected: 'local' }), 'Glimmer local — verificado: respondió en esta sesión');
  // Meta selected, or a run in progress: main.js's own line stays.
  assert.equal(chip('en', 'ready', { local: 'running', cloud: 'configured', selected: 'cloud' }), 'main.js: ready');
  assert.equal(chip('en', 'working', { local: 'running', cloud: 'connected', selected: 'local' }), 'main.js: working');
  // The Meta lines main.js shows have their Spanish text.
  const es = (text: string) => context.window.RAME_I18N?.translate('es', text);
  assert.equal(es('Key stored — live connection not yet verified'), 'Clave guardada — conexión aún sin verificar');
  assert.equal(es('Connected — verified'), 'Conectado — verificado');
  assert.equal(es('Connection verified — Meta API responded in this session'), 'Conexión verificada — Meta API respondió en esta sesión');
});
