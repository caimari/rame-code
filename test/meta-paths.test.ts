/**
 * The two Meta paths outside Missions, with a simulated Meta only:
 * Advisory ("Ask Spark for advice — Glimmer remains in control") and
 * Delegated ("Run this request with Spark — Spark directs the agent").
 * They stay apart, are bound to what was approved, fail without false
 * recovery or silent retries, and never widen permissions or leak data.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_AGENT_STEPS } from '../src/agentPolicy.js';
import { classifyMetaFailure, MetaHttpError, sanitizeFailureDetail } from '../src/metaFailures.js';
import { OutputCutOffError } from '../src/generationSettings.js';
import { assistantText, fakeCloud, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const API_KEY_SECRET = 'rameCode.metaModelApiKey';
const KEY = 'fake-meta-key-PATHS-7d1e';
const SECRET = 'FILE-CONTENT-SECRET-4411';
const ADVICE = { diagnosis: 'The constant is wrong.', steps: ['Set it to 60.'], checks: ['npm:test passes.'] };

type Consult = { digest: string; payload: string; model: string; reason: string };
type Remote = {
  consult: { localModel: string; model: string; fileCandidates: string[]; authorizedFiles: string[]; attempts: number; lastFailure: string | null; dataClasses: string[] } | null;
  delegation: { model: string; profile: string; budget: string; dataClasses: string[]; digest: string } | null;
  delegationFailure: { category: string; confirmedActions: number } | null;
};
const consultOf = (state: PostedState): Consult | null => (state.consult as Consult | null) ?? null;
const remoteOf = (state: PostedState): Remote => state.remote as Remote;
const adviceReply = () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(ADVICE) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } });
const metaError = (status: number, message: string) => Response.json({ error: { message } }, { status });

async function withHarness(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true, ...settings });
  h.secretValues.set(API_KEY_SECRET, KEY);
  fakeCloud.requests.length = 0;
  fakeCloud.handler = null;
  try {
    await h.writeFile('notes.txt', `${SECRET}\n`);
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node t.js' } }));
    await h.writeFile('t.js', "require('node:assert').equal(require('node:fs').readFileSync('a.txt','utf8'), 'final');\n");
    await body(h);
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

/** A local run that stops for capability: a failing test, then reads until the step budget ends. */
async function stuck(h: HostHarness): Promise<Consult> {
  h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 't0', name: 'run_tests', args: { commandId: 'npm:test' } }]) });
  for (let step = 1; step < MAX_AGENT_STEPS; step++) {
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: `s${step}`, name: 'read_file', args: { path: 'notes.txt', maxBytes: 4096 } }]) });
  }
  const run = h.provider.sendMessage('Write final into a.txt and make the test pass.', 'agent', 'local');
  // safe-auto: the test needs its card.
  await h.waitFor((state) => (state.agentPending as { tool: string } | null)?.tool === 'run_tests');
  const card = h.last().agentPending as { actionId: string; digest: string };
  await h.provider.approveAgentAction(card.actionId, card.digest);
  await run;
  const offer = consultOf(h.last());
  assert.ok(offer, 'an Advisory offer after a capability stop');
  assert.equal((h.last().remote as { localIssue: unknown }).localIssue, null, 'a capability stop is not a local server problem');
  return offer;
}

// ----- Error model -----

test('Meta failures are classified from what the adapter observes, sanitized, and never invented', () => {
  const cases: Array<[unknown, string]> = [
    [new MetaHttpError(401, 'Meta Model API returned HTTP 401: invalid key'), 'authentication'],
    [new MetaHttpError(403, 'Meta Model API returned HTTP 403.'), 'authentication'],
    [new MetaHttpError(402, 'Meta Model API returned HTTP 402.'), 'credit'],
    [new MetaHttpError(429, 'Meta Model API returned HTTP 429: You exceeded your current quota'), 'credit'],
    [new MetaHttpError(429, 'Meta Model API returned HTTP 429: Too many requests'), 'rate-limit'],
    [new MetaHttpError(504, 'Meta Model API returned HTTP 504.'), 'timeout'],
    [new MetaHttpError(500, 'Meta Model API returned HTTP 500.'), 'remote-error'],
    [new MetaHttpError(400, 'Meta Model API returned HTTP 400: bad request'), 'remote-error'],
    [new Error('Meta Model API request timed out after 120 seconds.'), 'timeout'],
    [new TypeError('fetch failed'), 'network'],
    [Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }), 'cancelled'],
    [new SyntaxError('Unexpected token < in JSON'), 'invalid-response'],
    [new Error('Meta Model API returned no advice.'), 'invalid-response'],
    [new OutputCutOffError(2048), 'invalid-response'],
    [new Error('The advice does not have exactly diagnosis, steps, and checks.'), 'invalid-response'],
    [new Error('something odd'), 'unknown'],
  ];
  for (const [error, category] of cases) {
    assert.equal(classifyMetaFailure(error).category, category, String((error as Error).message));
  }
  const leaked = classifyMetaFailure(new MetaHttpError(401, `Meta Model API returned HTTP 401: key ${KEY} is invalid; Bearer abc.def`), [KEY]);
  assert.ok(!leaked.detail.includes(KEY) && !leaked.detail.includes('abc.def'), leaked.detail);
  assert.ok(sanitizeFailureDetail('x'.repeat(1000), []).length <= 200);
});

// ----- Advisory -----

test('Advisory sends no tools and no file contents by default, and Glimmer keeps control', async () => {
  await withHarness({}, async (h) => {
    const offer = await stuck(h);
    const remote = remoteOf(h.last()).consult;
    assert.ok(remote);
    assert.equal(remote.localModel, 'local-glimmer');
    assert.deepEqual(remote.fileCandidates, ['notes.txt'], 'only files this run read can be offered');
    assert.deepEqual(remote.authorizedFiles, []);
    assert.equal(offer.payload.includes(SECRET), false, 'no file contents by default');
    assert.match(offer.payload, /Failing check: npm:test exit=1 \(its output is not included\)/);
    fakeCloud.handler = adviceReply;
    h.model.enqueue({ kind: 'json', body: assistantText('Glimmer looked at the hints.') });
    await h.provider.approveConsult(offer.digest);
    assert.equal(fakeCloud.requests.length, 1);
    const sent = fakeCloud.requests[0]?.body as Record<string, unknown>;
    assert.equal('tools' in sent, false, 'Spark gets no tools');
    assert.equal(JSON.stringify(sent).includes(SECRET), false);
    // The work after the advice is a local run with the local tools.
    const local = h.model.requests.at(-1) as { tools?: unknown[] };
    assert.ok(Array.isArray(local.tools) && local.tools.length > 0, 'the verification run is local, with its own tools');
    const record = (h.last().turns as Array<{ hostRecord?: string[] }>).flatMap((turn) => turn.hostRecord ?? []).join('\n');
    assert.match(record, /advisory: Ask Spark for advice — Glimmer remains in control; local-glimmer keeps the tools, Meta muse-spark-1\.3 gets none/);
    assert.match(record, /no file contents were included/);
  });
});

test('Advisory with file contents only after the user authorizes those exact files, which needs a new approval', async () => {
  await withHarness({}, async (h) => {
    const offer = await stuck(h);
    // A file this run did not read is refused.
    await h.provider.includeConsultFiles(offer.digest, ['package.json']);
    assert.match(h.last().status, /Only files this run read can be included/);
    await h.provider.includeConsultFiles(offer.digest, ['notes.txt']);
    const updated = consultOf(h.last()) as Consult;
    assert.notEqual(updated.digest, offer.digest, 'the text changed, so the approval changed');
    assert.match(updated.payload, new RegExp(`File contents the user authorized for this consultation \\(project ws\\):\\n--- notes\\.txt \\(sha256 [0-9a-f]{64}\\)\\n${SECRET}`));
    assert.deepEqual(remoteOf(h.last()).consult?.authorizedFiles, ['notes.txt']);
    // The old approval no longer sends anything.
    fakeCloud.handler = adviceReply;
    await h.provider.approveConsult(offer.digest);
    assert.equal(fakeCloud.requests.length, 0);
    h.model.enqueue({ kind: 'json', body: assistantText('ok') });
    await h.provider.approveConsult(updated.digest);
    assert.equal(fakeCloud.requests.length, 1);
    assert.ok(JSON.stringify(fakeCloud.requests[0]?.body).includes(SECRET), 'exactly the authorized content was sent');
    const record = (h.last().turns as Array<{ hostRecord?: string[] }>).flatMap((turn) => turn.hostRecord ?? []).join('\n');
    assert.match(record, /file contents you authorized: notes\.txt/);
  });
});

test('Advisory failures: classified, not retried, no partial use, no false recovery, and a new approval to retry', async () => {
  const failures: Array<[() => Response, string]> = [
    [() => metaError(401, 'invalid api key'), 'authentication failed'],
    [() => metaError(402, 'payment required'), 'credit, balance, or quota exhausted'],
    [() => metaError(429, 'You exceeded your current quota, please check your billing'), 'credit, balance, or quota exhausted'],
    [() => metaError(429, 'Too many requests'), 'rate limited'],
    [() => {
      throw new Error('Meta Model API request timed out after 120 seconds.');
    }, 'timed out'],
    [() => {
      throw new TypeError('fetch failed');
    }, 'network error'],
    [() => Response.json({ choices: [{ message: { role: 'assistant', content: '{"diagnosis":"x"' }, finish_reason: 'length' }] }), 'invalid or incomplete response'],
    [() => Response.json({ choices: [{ message: { role: 'assistant', content: 'not json' }, finish_reason: 'stop' }] }), 'invalid or incomplete response'],
  ];
  for (const [handler, label] of failures) {
    await withHarness({}, async (h) => {
      const offer = await stuck(h);
      const localCalls = h.model.requests.length;
      fakeCloud.handler = handler;
      await h.provider.approveConsult(offer.digest);
      assert.equal(fakeCloud.requests.length, 1, `${label}: one attempt, no automatic retry`);
      assert.equal(h.model.requests.length, localCalls, `${label}: no local verification run on a failure`);
      assert.match(h.last().status, new RegExp(`^The Meta advice failed \\(${label.replace(/[(),]/g, (c) => `\\${c}`)}\\)\\. Nothing was retried and nothing changed\\.`));
      const again = consultOf(h.last()) as Consult;
      assert.ok(again && again.digest !== offer.digest, 'retrying needs a new approval');
      assert.equal(remoteOf(h.last()).consult?.attempts, 1);
      const record = (h.last().turns as Array<{ text?: string; hostRecord?: string[] }>).at(-1);
      assert.equal(record?.text, 'Cascade stopped before the local verification run.');
      assert.match((record?.hostRecord ?? []).join('\n'), /the stop that motivated it is not resolved/);
      assert.equal(JSON.stringify(h.last()).includes(KEY), false, 'the key never reaches the view');
    });
  }
});

test('cancelling an Advisory call that was already sent counts it, never uses it, and offers no automatic retry', async () => {
  await withHarness({}, async (h) => {
    const offer = await stuck(h);
    fakeCloud.handler = () => new Promise<Response>(() => {}) as unknown as Response;
    const sending = h.provider.approveConsult(offer.digest);
    await h.waitFor(() => fakeCloud.requests.length === 1);
    h.provider.cancelRequest();
    await sending;
    assert.equal(h.last().status, 'Request cancelled.');
    assert.equal(consultOf(h.last()), null, 'a cancellation is the user stopping, not a failure to retry');
    const record = (h.last().turns as Array<{ hostRecord?: string[] }>).at(-1)?.hostRecord?.join('\n') ?? '';
    assert.match(record, /attempt 1: cancelled: /);
  });
});

// ----- Delegated -----

async function failLocally(h: HostHarness): Promise<NonNullable<Remote['delegation']>> {
  h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
  await h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
  const offer = remoteOf(h.last()).delegation;
  assert.ok(offer, 'a delegated run is offered after a local failure');
  return offer;
}

test('Delegated: bound to its digest, model, profile, and project; Spark proposes, the host checks with the same permissions', async () => {
  await withHarness({ agentProfile: 'ask' }, async (h) => {
    const offer = await failLocally(h);
    assert.equal(offer.profile, 'ask');
    assert.equal(offer.budget, `this one request, up to ${MAX_AGENT_STEPS} model steps`);
    assert.deepEqual(offer.dataClasses, ['your request', "this thread's recent messages", 'the output of each tool it runs, including the contents of files it reads']);
    // A wrong digest sends nothing.
    await h.provider.approveEscalation('0'.repeat(64));
    assert.equal(fakeCloud.requests.length, 0);
    const localTools = ((h.model.requests[0] as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map((entry) => entry.function.name).sort();
    fakeCloud.handler = () =>
      Response.json({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ files: [{ path: 'a.txt', expectedHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', newContent: 'final' }] }) } }] }, finish_reason: 'tool_calls' }],
      });
    const run = h.provider.approveEscalation(offer.digest);
    // Ask profile: Spark's write still needs the user's approval card.
    const card = await h.waitFor((state) => (state.agentPending as { tool: string } | null)?.tool === 'apply_patch');
    assert.equal((card.agentPending as unknown as { provider: string }).provider, 'cloud');
    assert.equal(await h.readFile('a.txt').catch(() => null), null, 'nothing written without approval');
    const cloudTools = ((fakeCloud.requests[0]?.body as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map((entry) => entry.function.name).sort();
    assert.deepEqual(cloudTools, localTools.filter((name) => name !== 'search_history'), 'the local run\'s tools minus history search (it never returns local history to Meta): no extra capability');
    const pending = h.last().agentPending as { actionId: string; digest: string };
    await h.provider.rejectAgentAction(pending.actionId, pending.digest);
    await run;
    const record = (h.last().turns as Array<{ hostRecord?: string[] }>).flatMap((turn) => turn.hostRecord ?? []).join('\n');
    assert.match(record, /delegated: Run this request with Spark — Spark directs the agent; Meta muse-spark-1\.3 proposes the tools, RAME Code checks each one with the ask profile/);
  });
  await withHarness({ agentProfile: 'ask' }, async (h) => {
    const offer = await failLocally(h);
    // The approval covers that profile only: widening it afterwards voids it.
    h.send({ type: 'setAgentProfile', profile: 'workspace-full' });
    await h.waitFor((state) => state.agentProfile === 'workspace-full');
    await h.provider.approveEscalation(offer.digest);
    assert.equal(fakeCloud.requests.length, 0);
    assert.match(h.last().status, /^The model, permission profile, or project changed since this was offered\. Nothing was sent; ask again\./);
  });
});

test('a delegated run that fails at Meta keeps confirmed actions, is not retried, does not switch to Glimmer, and offers a local run', async () => {
  await withHarness({ agentProfile: 'workspace-full' }, async (h) => {
    const offer = await failLocally(h);
    let call = 0;
    fakeCloud.handler = () => {
      call += 1;
      return call === 1
        ? Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ files: [{ path: 'a.txt', expectedHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', newContent: 'draft' }] }) } }] }, finish_reason: 'tool_calls' }] })
        : metaError(429, 'You exceeded your current quota');
    };
    const localBefore = h.model.requests.length;
    await h.provider.approveEscalation(offer.digest);
    assert.equal(await h.readFile('a.txt'), 'draft', 'the confirmed action stays');
    assert.equal(fakeCloud.requests.length, 2, 'no retry after the failure');
    assert.equal(h.model.requests.length, localBefore, 'no silent switch to Glimmer');
    assert.match(h.last().status, /^The delegated run with Meta stopped \(credit, balance, or quota exhausted\)\. It was not retried and did not switch to Glimmer\./);
    assert.deepEqual(remoteOf(h.last()).delegationFailure, { category: 'credit', confirmedActions: 1 });
    // The user chooses to continue locally: the same request, with Glimmer, nothing undone or repeated by the host.
    h.model.enqueue({ kind: 'json', body: assistantText('Continuing locally.') });
    await h.provider.runDelegationLocally();
    assert.equal(h.model.requests.length, localBefore + 1);
    assert.equal(fakeCloud.requests.length, 2);
    assert.equal(await h.readFile('a.txt'), 'draft');
    assert.equal(JSON.stringify(h.last()).includes(KEY), false);
  });
});

test('Advisory can never become Delegated: a verification run that fails offers no delegated run', async () => {
  await withHarness({}, async (h) => {
    const offer = await stuck(h);
    fakeCloud.handler = adviceReply;
    // The local verification run after the advice fails at the local server.
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.approveConsult(offer.digest);
    assert.equal(remoteOf(h.last()).delegation, null);
    assert.equal(h.last().escalation.pending, false);
    assert.match(h.last().status, /A RAME Code internal run is never delegated to Meta; nothing was sent\./);
    assert.equal(fakeCloud.requests.length, 1, 'only the advice was ever sent');
    assert.equal('tools' in (fakeCloud.requests[0]?.body as Record<string, unknown>), false);
  });
});

test('the two paths are labeled unmistakably, in English and Spanish, and the cards use text only', async () => {
  const { buildViewHtml } = await import('../src/viewHtml.js');
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js' });
  assert.match(html, /<h3 id="consult-heading">Ask Spark for advice — Glimmer remains in control<\/h3>/);
  assert.match(html, /<h3 id="escalation-heading">Run this request with Spark — Spark directs the agent<\/h3>/);
  assert.match(html, /<dl id="missionRemote" class="mission-facts" aria-label="Remote advice and causal recovery" hidden><\/dl>/);
  // A hidden action row stays hidden even inside a flex .row (seen in Chromium).
  const hiddenRule = /([^{}]*)\{ display: none; \}/g;
  const hiddenSelectors = [...html.matchAll(hiddenRule)].flatMap((rule) => rule[1].split(',').map((selector) => selector.trim()));
  for (const selector of ['#escalationActions[hidden]', '#consultFilesBox[hidden]', '#delegationFailure[hidden]', '#consultResult[hidden]', '#missionRemote[hidden]', '#localIssueBox button[hidden]']) {
    assert.ok(hiddenSelectors.includes(selector), selector);
  }
  const context = { window: {} as { RAME_I18N?: { translate(language: string, text: string): string } } };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  const es = (key: string): string => context.window.RAME_I18N?.translate('es', key) ?? '';
  assert.equal(es('Ask Spark for advice — Glimmer remains in control'), 'Pedir consejo a Spark — Glimmer conserva el control');
  assert.equal(es('Run this request with Spark — Spark directs the agent'), 'Ejecutar esta petición con Spark — Spark dirige al agente');
  const module = readFileSync('media/remoteUx.js', 'utf8');
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(module), false);
});
