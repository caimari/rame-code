/**
 * Remote actions follow the failure, with a simulated Meta only: a stopped
 * or misconfigured local server gets local actions and no Advisory; a
 * delegated run is offered only for a normal Agent request with escalation
 * ON and a stored key; any other case shows it disabled with its reason,
 * and a RAME Code internal run (a Mission) never shows it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { parseViewInboundMessage } from '../src/viewMessages.js';
import * as remote from '../src/remoteController.js';
import type { ProviderHost } from '../src/providerTypes.js';
import { fakeCloud, HostHarness, type PostedState } from './helpers/hostHarness.js';

const API_KEY_SECRET = 'rameCode.metaModelApiKey';
const KEY = 'fake-meta-key-CONTEXT-51b0';

type LocalIssue = { kind: string; canStart: boolean; delegation: string } | null;
type Remote = { consult: unknown; delegation: { digest: string } | null; localIssue: LocalIssue };
const remoteOf = (state: PostedState): Remote => state.remote as Remote;

async function withHarness(settings: Record<string, unknown>, key: boolean, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', ...settings });
  if (key) {
    h.secretValues.set(API_KEY_SECRET, KEY);
  }
  fakeCloud.requests.length = 0;
  fakeCloud.handler = () => Response.json({ error: { message: 'must not be called' } }, { status: 500 });
  try {
    await body(h);
    assert.deepEqual(fakeCloud.requests, [], 'nothing reaches Meta without an explicit approval');
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

const OWNED = { executablePath: '/opt/llama/llama-server', modelPath: '/models/glimmer.gguf', projectorPath: '', draftModelPath: '', modelId: 'local-glimmer', contextSize: 32768, port: 8775, idleTimeoutSec: 900 };

test('a stopped owned server: start it or open its settings; nothing sent or saved, no Advisory, no delegation', async () => {
  await withHarness({ externalLocalEndpoint: '', local: OWNED, allowCloudEscalation: true }, true, async (h) => {
    await h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
    const state = h.last();
    assert.equal((state.threads as unknown[]).length, 0, 'the request is not stored');
    assert.deepEqual(remoteOf(state).localIssue, { kind: 'unreachable', canStart: true, delegation: 'not-sent' });
    assert.equal(remoteOf(state).consult, null);
    assert.equal(remoteOf(state).delegation, null);
    assert.equal(state.escalation.pending, false);
  });
});

test('a misconfigured external endpoint: settings, not start; delegation offered only for an authorized Agent request', async () => {
  await withHarness({ externalLocalEndpoint: 'http://127.0.0.1:9/v1', allowCloudEscalation: true }, true, async (h) => {
    await h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
    const view = remoteOf(h.last());
    assert.deepEqual(view.localIssue, { kind: 'unreachable', canStart: false, delegation: 'offered' });
    assert.equal(view.consult, null, 'a stopped server is never a reason for Advisory');
    assert.ok(view.delegation, 'the delegated run is offered, waiting for approval');
    assert.equal(h.last().escalation.pending, true);
  });
});

test('delegation is disabled with its reason: escalation OFF, no stored key, or not an Agent request', async () => {
  const cases: Array<[Record<string, unknown>, boolean, 'agent' | 'chat', string, RegExp]> = [
    [{ allowCloudEscalation: false }, true, 'agent', 'off', /Cloud escalation is OFF, so nothing was sent\./],
    [{ allowCloudEscalation: true }, false, 'agent', 'no-key', /No Meta Model API key is stored, so nothing was sent\./],
    [{ allowCloudEscalation: true, mode: 'chat' }, true, 'chat', 'not-agent', /Only an Agent request can be run with Meta; nothing was sent\./],
  ];
  for (const [settings, key, mode, delegation, status] of cases) {
    await withHarness(settings, key, async (h) => {
      h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
      await h.provider.sendMessage('Write final into a.txt.', mode, 'local');
      const state = h.last();
      assert.deepEqual(remoteOf(state).localIssue, { kind: 'failed', canStart: false, delegation }, delegation);
      assert.equal(remoteOf(state).delegation, null, delegation);
      assert.equal(state.escalation.pending, false, delegation);
      assert.match(state.status, status);
    });
  }
});

test('"Start Muse Glimmer" is honored only when the host offered it; the message has exact keys', async () => {
  assert.deepEqual(parseViewInboundMessage({ type: 'localIssueStart' }), { type: 'localIssueStart' });
  assert.throws(() => parseViewInboundMessage({ type: 'localIssueStart', executablePath: '/bin/sh' }));
  await withHarness({ allowCloudEscalation: false }, false, async (h) => {
    h.send({ type: 'localIssueStart' });
    await h.waitFor((state) => /Nothing to start/.test(state.status));
  });
});

test('a Mission internal run never offers or shows a delegated run', () => {
  const thread = { id: 't1', turns: [{ kind: 'user', text: 'Mission run 1', timestamp: 1, host: true }] };
  for (const mission of [
    { missionAuto: { missionId: 'm1', stop: null, holdAutonomy: false }, activeMission: null },
    { missionAuto: null, activeMission: { id: 'm1', revision: 1 } },
    { missionAuto: null, activeMission: null },
  ]) {
    const host = {
      ...mission,
      cascadeVerification: null,
      consultOffer: null,
      delegationOffer: null,
      delegationFailure: null,
      localIssue: null,
      settings: { allowCloudEscalation: true, mode: 'agent', externalLocalEndpoint: '', local: OWNED },
      store: { get: (id: string) => (id === 't1' ? thread : undefined) },
    } as unknown as ProviderHost;
    assert.equal(remote.localFailure(host, 't1', false, 'boom', true), 'internal');
    assert.equal(host.delegationOffer, null);
    assert.equal(remote.remoteView(host, 't1').localIssue?.delegation, 'internal');
  }
});

test('a stopped server discards a pending Advisory offer for that thread; a model failure keeps it', () => {
  const thread = { id: 't1', turns: [{ kind: 'user', text: 'Fix it.', timestamp: 1 }] };
  for (const [unreachable, kept] of [[true, false], [false, true]] as const) {
    const offer = { threadId: 't1' };
    const host = {
      missionAuto: { missionId: 'm1', stop: null, holdAutonomy: false },
      activeMission: null,
      cascadeVerification: null,
      consultOffer: offer,
      delegationOffer: null,
      delegationFailure: null,
      localIssue: null,
      settings: { allowCloudEscalation: true, mode: 'agent', externalLocalEndpoint: '', local: OWNED },
      store: { get: () => thread },
    } as unknown as ProviderHost;
    remote.localFailure(host, 't1', unreachable, 'boom', true);
    assert.equal(host.consultOffer === offer, kept, unreachable ? 'unreachable' : 'model failure');
  }
});

/** A minimal DOM: enough for remoteUx to render the local-issue card. */
function renderCard(issue: LocalIssue): Record<string, { hidden: boolean; disabled: boolean; textContent: string }> {
  const nodes: Record<string, { hidden: boolean; disabled: boolean; textContent: string; attributes: Record<string, string> }> = {};
  const node = () => ({ hidden: false, disabled: false, textContent: '', attributes: {} as Record<string, string>, firstChild: null, setAttribute(name: string, value: string) { this.attributes[name] = value; }, addEventListener() {} });
  const document = {
    getElementById: (id: string) => (nodes[id] ??= node()),
    createElement: () => node(),
  };
  const context = { window: {} as { RAME_REMOTE?: { init(h: unknown): void; render(data: unknown): void } }, document };
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  const t = (text: string) => text;
  context.window.RAME_REMOTE?.init({ vscode: { postMessage() {} }, t, tf: t, tHost: t, markPending: () => true, hold() {} });
  context.window.RAME_REMOTE?.render({ remote: { consult: null, delegation: null, delegationFailure: null, localIssue: issue }, escalation: { pending: false, reason: '' } });
  return nodes;
}

test('the card: Start only when startable; delegation disabled with a reason, or absent', () => {
  const stopped = renderCard({ kind: 'unreachable', canStart: true, delegation: 'not-sent' });
  assert.equal(stopped.localIssueBox.hidden, false);
  assert.equal(stopped.localIssueStart.hidden, false);
  assert.equal(stopped.localIssueSettings.hidden, false);
  assert.equal(stopped.localIssueDelegate.hidden, true, 'nothing was stored to delegate');
  assert.match(stopped.localIssueDelegateWhy.textContent, /choose Meta Model API/);
  assert.match(stopped.localIssueHint.textContent, /not a reason to ask Spark for advice/);
  for (const [delegation, why] of [['off', /escalation is OFF/], ['no-key', /no Meta Model API key/], ['not-agent', /only an Agent request/]] as const) {
    const card = renderCard({ kind: 'failed', canStart: false, delegation });
    assert.equal(card.localIssueStart.hidden, true, delegation);
    assert.equal(card.localIssueDelegate.hidden, false, delegation);
    assert.equal(card.localIssueDelegate.disabled, true, delegation);
    assert.match(card.localIssueDelegateWhy.textContent, why);
  }
  for (const delegation of ['internal', 'offered']) {
    const card = renderCard({ kind: 'failed', canStart: false, delegation });
    assert.equal(card.localIssueDelegate.hidden, true, delegation);
    assert.equal(card.localIssueDelegateWhy.hidden, true, delegation);
  }
  assert.equal(renderCard(null).localIssueBox.hidden, true);
});
