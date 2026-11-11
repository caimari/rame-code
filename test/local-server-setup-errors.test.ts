/**
 * A local server that answers "no model loaded" (human validation,
 * 2026-11-05: LM Studio replied HTTP 400 "No models loaded. Please load a
 * model in the developer page or use the 'lms load' command." and RAME showed
 * only "HTTP 400" plus an offer to run the request with Spark):
 *   - the thread and the status say what the server said and what to do;
 *   - it is a setup problem of that server: no delegated run with Spark and
 *     no Advisory are offered, even with escalation ON and a key stored;
 *   - any other HTTP error keeps the server's own words, is never read as
 *     "unreachable", and keeps the existing delegation rules.
 * Simulated local server and simulated Meta only; no network, no GPU.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { GenerationContextError } from '../src/generationSettings.js';
import { LocalServerHttpError, LocalServerSetupError, localHttpError, localServerErrorText } from '../src/localServerErrors.js';
import { assistantText, fakeCloud, HostHarness, type PostedState } from './helpers/hostHarness.js';

const API_KEY_SECRET = 'rameCode.metaModelApiKey';
const KEY = 'fake-meta-key-SETUP-7c21';
const LM_STUDIO_NO_MODEL = "No models loaded. Please load a model in the developer page or use the 'lms load' command.";
const OLLAMA_MISSING = 'model "muse-glimmer" not found, try pulling it first';

type LocalIssue = { kind: string; canStart: boolean; delegation: string } | null;
type Remote = { consult: unknown; delegation: unknown; localIssue: LocalIssue };
const remoteOf = (state: PostedState): Remote => state.remote as Remote;
const turnsOf = (state: PostedState) => JSON.stringify(state.turns);

async function withHarness(folders: number, settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness({ folders });
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true, ...settings });
  h.secretValues.set(API_KEY_SECRET, KEY);
  fakeCloud.requests.length = 0;
  fakeCloud.handler = () => Response.json({ error: { message: 'must not be called' } }, { status: 500 });
  try {
    await body(h);
    assert.deepEqual(fakeCloud.requests, [], 'nothing reaches Meta');
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

test("the server's words: cleaned, one line, capped; none when the reply has no text", () => {
  assert.equal(localServerErrorText({ error: LM_STUDIO_NO_MODEL }), LM_STUDIO_NO_MODEL, 'LM Studio: error as a string');
  assert.equal(localServerErrorText({ error: { message: 'Bad\u0000 request\n\tnow ', code: 400 } }), 'Bad request now', 'llama-server: error.message');
  assert.equal(localServerErrorText({ message: 'plain' }), 'plain');
  assert.equal(localServerErrorText({ error: { code: 400 } }), null);
  assert.equal(localServerErrorText(null), null);
  assert.equal(localServerErrorText({ error: '   ' }), null);
  const long = localServerErrorText({ error: 'x'.repeat(5000) }) as string;
  assert.equal(long.length, 240);
  assert.ok(long.endsWith('…'));
});

test('classification: context refusal first, then setup (no model loaded / model missing), then the HTTP status with the text', () => {
  const context = localHttpError(400, { error: { type: 'exceed_context_size_error', n_prompt_tokens: 40000, n_ctx: 32768, message: 'model not loaded' } }, 'm');
  assert.ok(context instanceof GenerationContextError, 'the context refusal keeps priority');

  const noModel = localHttpError(400, { error: LM_STUDIO_NO_MODEL }, 'muse-glimmer');
  assert.ok(noModel instanceof LocalServerSetupError);
  assert.equal(noModel.problem, 'no-model-loaded');
  assert.match(noModel.message, /^The local server has no model loaded, so it could not answer\. Nothing ran and nothing was sent to Meta\./);
  assert.match(noModel.message, /Load the model in the server \(in LM Studio: Developer → Load model, or lms load\), then send again\./);
  assert.match(noModel.message, /RAME asked for "muse-glimmer"; if the server loads models on demand, choose a model it lists in the runtime settings\./);
  assert.ok(noModel.message.endsWith(`The server said: "${LM_STUDIO_NO_MODEL}"`));
  assert.ok(localHttpError(400, { error: { message: LM_STUDIO_NO_MODEL } }, 'm') instanceof LocalServerSetupError, 'also as error.message');

  for (const payload of [{ error: { message: OLLAMA_MISSING, type: 'api_error' } }, { error: 'Invalid model identifier "x".' }, { error: { message: 'unknown', code: 'model_not_found' } }]) {
    const missing = localHttpError(404, payload, 'muse-glimmer');
    assert.ok(missing instanceof LocalServerSetupError, JSON.stringify(payload));
    assert.equal(missing.problem, 'model-missing');
    assert.match(missing.message, /^The local server does not have the model "muse-glimmer" ready/);
  }

  const other = localHttpError(500, { error: { message: 'Network socket refused by backend' } }, 'm');
  assert.ok(other instanceof LocalServerHttpError && !(other instanceof LocalServerSetupError));
  assert.equal(other.message, 'The local runtime returned HTTP 500: "Network socket refused by backend"');
  assert.equal(localHttpError(502, {}, 'm').message, 'The local runtime returned HTTP 502.', 'no text: the status alone');
});

for (const [label, folders, mode, settings] of [
  ['Agent without a folder (the reported case)', 0, 'agent', {}],
  ['Agent with one folder', 1, 'agent', {}],
  ['Chat', 1, 'chat', { mode: 'chat' }],
] as const) {
  test(`${label}: "no model loaded" is shown with what to do; no Spark run and no Advisory, even with escalation ON and a key`, async () => {
    await withHarness(folders, settings, async (h) => {
      h.model.enqueue({ kind: 'json', status: 400, body: { error: LM_STUDIO_NO_MODEL } });
      await h.provider.sendMessage('tienes acceso a las carpetas de mi pc, puedes verificar?', mode, 'local');
      const state = h.last();
      assert.deepEqual(remoteOf(state).localIssue, { kind: 'setup', canStart: false, delegation: 'setup' });
      assert.equal(remoteOf(state).delegation, null, 'no delegated run is offered');
      assert.equal(remoteOf(state).consult, null, 'no Advisory');
      assert.equal(state.escalation.pending, false);
      assert.match(state.status, /^The local server has no model loaded/);
      assert.doesNotMatch(state.status, /^Local work failed \(The local runtime returned HTTP 400\.\)/);
      assert.match(turnsOf(state), /The local server has no model loaded, so it could not answer\. Nothing ran and nothing was sent to Meta\./, 'the thread records it');
      assert.equal(state.running, false);
      assert.equal(h.model.requests.length, 1, 'no retry');
    });
  });
}

test('a model the server does not have: setup problem, no Spark', async () => {
  await withHarness(1, {}, async (h) => {
    h.model.enqueue({ kind: 'json', status: 404, body: { error: { message: OLLAMA_MISSING, type: 'api_error' } } });
    await h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
    assert.deepEqual(remoteOf(h.last()).localIssue, { kind: 'setup', canStart: false, delegation: 'setup' });
    assert.equal(h.last().escalation.pending, false);
    assert.match(h.last().status, /does not have the model .* ready/);
  });
});

test('any other HTTP error: the server is reached (never "unreachable"), its words are shown, delegation rules unchanged', async () => {
  await withHarness(1, {}, async (h) => {
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'network socket refused by backend' } } });
    await h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
    const state = h.last();
    assert.deepEqual(remoteOf(state).localIssue, { kind: 'failed', canStart: false, delegation: 'offered' }, 'a model failure still offers the explicit Spark run');
    assert.equal(state.escalation.pending, true, 'waiting for the user, nothing sent');
    assert.match(turnsOf(state), /The local runtime returned HTTP 500: \\"network socket refused by backend\\"/);
  });
});

test('after loading the model, the next request runs normally and the setup card goes away', async () => {
  await withHarness(1, {}, async (h) => {
    h.model.enqueue({ kind: 'json', status: 400, body: { error: LM_STUDIO_NO_MODEL } });
    await h.provider.sendMessage('Hello?', 'agent', 'local');
    assert.equal(remoteOf(h.last()).localIssue?.kind, 'setup');
    h.model.enqueue({ kind: 'json', body: assistantText('Hello.') });
    await h.provider.sendMessage('Hello again?', 'agent', 'local');
    assert.equal(remoteOf(h.last()).localIssue, null);
    assert.match(turnsOf(h.last()), /Hello\./);
  });
});

/** A minimal DOM for remoteUx.js and localServersUx.js, in the view's order. */
function renderCard(issue: LocalIssue, language: 'en' | 'es') {
  type FakeNode = { id: string; hidden: boolean; disabled: boolean; checked: boolean; textContent: string; value: string; attributes: Record<string, string>; [key: string]: unknown };
  const nodes: Record<string, FakeNode> = {};
  const make = (id: string): FakeNode => {
    const classes = new Set<string>();
    const node: FakeNode = { id, hidden: false, disabled: false, checked: false, textContent: '', value: '', attributes: {}, options: [], firstChild: null, style: {} };
    return Object.assign(node, {
      appendChild() {},
      removeChild() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      classList: { add: (...n: string[]) => n.forEach((x) => classes.add(x)), remove: (...n: string[]) => n.forEach((x) => classes.delete(x)), contains: (x: string) => classes.has(x) },
      setAttribute(name: string, value: string) { node.attributes[name] = value; },
      getAttribute(name: string) { return node.attributes[name] ?? null; },
      hasAttribute(name: string) { return name in node.attributes; },
      removeAttribute(name: string) { delete node.attributes[name]; },
      addEventListener() {},
      closest: () => null,
    });
  };
  const document = { getElementById: (id: string) => (nodes[id] ??= make(id)), createElement: () => make(''), addEventListener() {}, querySelectorAll: () => [], activeElement: null };
  const window: Record<string, unknown> = {};
  const context = { window, document, setTimeout, clearTimeout, Date };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/localServersUx.js', 'utf8'), context);
  const i18n = window.RAME_I18N as { translate(language: string, text: string): string };
  const t = (text: string) => (language === 'en' ? text : i18n.translate('es', text));
  const remote = window.RAME_REMOTE as { init(h: unknown): void; render(data: unknown): void };
  remote.init({ vscode: { postMessage() {} }, t, tf: t, tHost: t, markPending: () => true, hold() {} });
  remote.render({ remote: { consult: null, delegation: null, delegationFailure: null, localIssue: issue, runtime: { local: 'connected', cloud: 'unknown', selected: 'local' } }, escalation: { pending: false, reason: '' } });
  return nodes;
}

test('the card for a setup problem: what to do in the server, runtime settings, and no Spark button (English and Spanish)', () => {
  const card = renderCard({ kind: 'setup', canStart: false, delegation: 'setup' }, 'en');
  assert.equal(card.localIssueBox.hidden, false);
  assert.equal(card['local-issue-heading'].textContent, 'The local server has no model ready');
  assert.match(card.localIssueHint.textContent, /Load the model in the server \(in LM Studio: Developer → Load model, or lms load\)/);
  assert.match(card.localIssueHint.textContent, /not a reason to run the request with Spark/);
  assert.equal(card.localIssueSettings.hidden, false, 'the runtime settings stay at hand');
  assert.equal(card.localIssueStart.hidden, true);
  assert.equal(card.localIssueDelegate.hidden, true, 'no Spark button, not even disabled');
  assert.equal(card.localIssueDelegateWhy.hidden, true);

  const es = renderCard({ kind: 'setup', canStart: false, delegation: 'setup' }, 'es');
  assert.equal(es['local-issue-heading'].textContent, 'El servidor local no tiene ningún modelo listo');
  assert.match(es.localIssueHint.textContent, /^El servidor respondió, pero no tiene ningún modelo cargado/);

  const failed = renderCard({ kind: 'failed', canStart: false, delegation: 'off' }, 'en');
  assert.equal(failed['local-issue-heading'].textContent, 'The local request failed', 'other failures keep their card');
});

const LM_STUDIO_CONTEXT =
  'Error: Channel Error - Caused By: EngineProtocolHttpError: Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (5917 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":5917,"n_ctx":4096}}';

test('a context refusal wrapped by LM Studio (model loaded on demand with 4,096 tokens) is recognized, with its sizes and what to do', () => {
  for (const payload of [{ error: LM_STUDIO_CONTEXT }, { error: { message: LM_STUDIO_CONTEXT } }, LM_STUDIO_CONTEXT]) {
    const error = localHttpError(400, payload, 'm');
    assert.ok(error instanceof GenerationContextError, JSON.stringify(payload).slice(0, 40));
    assert.equal(
      error.message,
      "The local server's context is too small for this request (5917 input tokens for a 4096-token context). Nothing was cut and no action ran. " +
        'Load the model in the server with a larger context (Agent needs about 16,384 tokens; in LM Studio, set the context length when loading the model), then send again.',
    );
  }
  assert.match(localHttpError(400, { error: 'exceeds the available context size' }, 'm').message, /^The local server's context is too small for this request\. /, 'no sizes: none invented');
});

test('host: Agent with a folder against a 4,096-token LM Studio model says the context is too small, not a bare HTTP 400', async () => {
  await withHarness(1, { allowCloudEscalation: false }, async (h) => {
    h.model.enqueue({ kind: 'json', status: 400, body: { error: LM_STUDIO_CONTEXT } });
    await h.provider.sendMessage('ahora puedes?', 'agent', 'local');
    const state = h.last();
    assert.match(state.status, /^Local work failed \(The local server's context is too small for this request \(5917 input tokens for a 4096-token context\)/);
    assert.match(state.status, /Cloud escalation is OFF, so nothing was sent\.$/);
    assert.deepEqual(remoteOf(state).localIssue, { kind: 'failed', canStart: false, delegation: 'off', context: true }, 'a context refusal: the card says so, with no reload (not a server chosen as LM Studio)');
  });
});
