/**
 * Host behavior of the generation controls (reasoning effort, output
 * budget, context), driven through the in-process `vscode` double. Meta is
 * only ever the in-process stand-in: no request leaves the machine.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_AGENT_STEPS } from '../src/agentPolicy.js';
import { assistantText, blockedFetches, fakeCloud, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const API_KEY_SECRET = 'rameCode.metaModelApiKey';
const GLIMMER_TEMPLATE_EXCERPT =
  "{%- set rs = reasoning_strength if reasoning_strength is defined and reasoning_strength else 'high' -%}" +
  "{{- 'Reasoning strength: ' + rs + '.' -}}";

const glimmerProps = (nCtx: number) => ({ default_generation_settings: { n_ctx: nCtx }, chat_template: GLIMMER_TEMPLATE_EXCERPT });

interface GenerationState {
  provider: string;
  model: string;
  reasoningOptions: string[];
  reasoning: string;
  reasoningUnavailable: string | null;
  reasoningParam: string | null;
  contextWindow: number | null;
  maxOutputTokensLocal: number | null;
  maxOutputTokensCloud: number | null;
}

const generationOf = (state: PostedState): GenerationState => state.generation as GenerationState;
const storedGeneration = (h: HostHarness) =>
  (h.memento.get('rameCode.settings.v1') as { generation: { reasoningByModel: Record<string, string>; maxOutputTokens: Record<string, number | null> } })
    .generation;

function lastTurn(state: PostedState): PostedState['turns'][number] | undefined {
  return state.turns[state.turns.length - 1];
}

function generationSettings(reasoningByModel: Record<string, string>, local: number | null = null, cloud: number | null = null) {
  return { generation: { reasoningByModel, maxOutputTokens: { local, cloud } } };
}

async function withHarness(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start(settings);
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    fakeCloud.handler = null;
    await h.dispose();
  }
}

test('local Glimmer: the stored level goes out as chat_template_kwargs.reasoning_strength with the automatic budget', async () => {
  await withHarness(generationSettings({ 'local:local-glimmer': 'low' }), async (h) => {
    h.model.props = glimmerProps(32768);
    h.model.enqueue({ kind: 'json', body: assistantText('Nothing to change. Files changed: none.') });
    await h.provider.sendMessage('Say hello.', 'agent', 'local');
    const body = h.model.requests[0] ?? {};
    assert.deepEqual(body.chat_template_kwargs, { reasoning_strength: 'low' });
    assert.equal(body.max_completion_tokens, 4096);
    assert.equal('reasoning_effort' in body, false, 'Glimmer ignores reasoning_effort, so it is never sent');
    assert.ok(h.model.propsRequests >= 1);
    const gen = generationOf(h.last());
    assert.deepEqual(gen.reasoningOptions, ['default', 'low', 'medium', 'high', 'xhigh']);
    assert.equal(gen.reasoning, 'low');
    assert.equal(gen.reasoningParam, 'chat_template_kwargs.reasoning_strength');
    assert.equal(gen.contextWindow, 32768);
  });
});

test('a stored level the running server cannot honor is not sent, and the run says so', async () => {
  await withHarness(generationSettings({ 'local:local-glimmer': 'low' }), async (h) => {
    // props stays null: the endpoint is not llama-server, nothing is verified.
    h.model.enqueue({ kind: 'json', body: assistantText('Done. Files changed: none.') });
    await h.provider.sendMessage('Say hello.', 'agent', 'local');
    const body = h.model.requests[0] ?? {};
    assert.equal('chat_template_kwargs' in body, false);
    assert.equal('reasoning_effort' in body, false);
    const state = h.last();
    assert.match(state.status, /Reasoning Low is not available for local-glimmer .*this run uses Model default\./);
    assert.deepEqual(generationOf(state).reasoningOptions, ['default']);
    assert.equal(generationOf(state).reasoningUnavailable, 'low');
    // The stored choice is kept for when a Glimmer server is selected again.
    assert.equal(storedGeneration(h).reasoningByModel['local:local-glimmer'], 'low');
  });
});

test('Meta: reasoning_effort and the manual maximum on every step, tool_choice always auto, nothing of the run dropped', async () => {
  const settings = {
    provider: 'cloud',
    model: 'muse-spark-1.3',
    cloudModel: 'muse-spark-1.3',
    agentProfile: 'safe-auto',
    ...generationSettings({ 'cloud:muse-spark-1.3': 'xhigh' }, null, 2000),
  };
  await withHarness(settings, async (h) => {
    h.secretValues.set(API_KEY_SECRET, 'fake-meta-key-generation-test');
    await h.writeFile('a.txt', 'alpha');
    fakeCloud.requests.length = 0;
    let step = 0;
    // Four reads per step: 11 executed steps produce 88 exchange messages,
    // far past the old silent 40-message cut.
    fakeCloud.handler = () => {
      step += 1;
      return Response.json(
        toolCallReply(
          [0, 1, 2, 3].map((index) => ({ id: `c${step}-${index}`, name: 'list_files', args: { dir: '', limit: 10 } })),
        ),
      );
    };
    await h.provider.sendMessage('List the workspace again and again.', 'agent', 'cloud');
    assert.equal(fakeCloud.requests.length, MAX_AGENT_STEPS);
    for (const request of fakeCloud.requests) {
      assert.equal(request.body.tool_choice, 'auto', 'Meta documents only tool_choice auto');
      assert.equal(request.body.reasoning_effort, 'xhigh');
      assert.equal(request.body.max_completion_tokens, 2000);
      assert.equal('chat_template_kwargs' in request.body, false);
    }
    const last = fakeCloud.requests[MAX_AGENT_STEPS - 1]?.body.messages as Array<{ role: string; content: string; tool_call_id?: string }>;
    assert.ok(last.some((m) => m.role === 'system' && /This is the last model step of the budget of 12/.test(m.content)));
    const toolResults = last.filter((m) => m.role === 'tool');
    assert.equal(toolResults.length, (MAX_AGENT_STEPS - 1) * 4, 'every earlier tool result is still in the last request');
    assert.equal(toolResults[0]?.tool_call_id, 'c1-0');
    assert.match(lastTurn(h.last())?.message ?? '', /Tools were disabled on the last step, but the model still proposed one; it did not run\./);
    assert.deepEqual(blockedFetches.filter((url) => url.includes('meta')), []);
  });
});

test('a request that cannot fit the local context is refused before sending, with the input intact', async () => {
  await withHarness({}, async (h) => {
    h.model.props = glimmerProps(2000);
    const text = `Review this request carefully: ${'details '.repeat(200)}`.trim();
    await h.provider.sendMessage(text, 'agent', 'local');
    assert.equal(h.model.requests.length, 0, 'nothing was sent');
    const state = h.last();
    const error = lastTurn(state)?.message ?? '';
    assert.match(error, /The Agent stopped before model step 1: This request needs about \d+ input tokens, which leaves \d+ of the 2000-token context/);
    assert.match(error, /Nothing was cut and nothing was sent\./);
    const userTurn = state.turns.find((turn) => turn.kind === 'user');
    assert.equal(userTurn?.text, text, 'the request itself was not shortened');
  });
});

test('when the free context is smaller than the budget, the budget shrinks visibly and the input is untouched', async () => {
  await withHarness({}, async (h) => {
    // A context a little larger than the Agent's fixed prompt and tools (about
    // 3,400 tokens since replace_in_file), so the free space is below 4096.
    h.model.props = glimmerProps(4500);
    h.model.enqueue({ kind: 'json', body: assistantText('Done. Files changed: none.') });
    await h.provider.sendMessage('Say hello.', 'agent', 'local');
    const sent = h.model.requests[0]?.max_completion_tokens as number;
    assert.ok(sent >= 512 && sent < 4096, `budget ${sent}`);
    const notes = h.posted.map((state) => state.status).filter((status) => /Output budget reduced/.test(status));
    assert.ok(notes.some((status) => status.includes(`Output budget reduced from 4096 (automatic) to ${sent} tokens to fit the free context.`)));
    const messages = h.model.requests[0]?.messages as Array<{ role: string; content: string }>;
    assert.equal(messages.find((m) => m.role === 'user')?.content, 'Say hello.');
  });
});

test('the local server refusing an oversized input stops with its own numbers and runs nothing', async () => {
  await withHarness({}, async (h) => {
    h.model.enqueue({
      kind: 'json',
      status: 400,
      body: { error: { code: 400, type: 'exceed_context_size_error', message: 'request exceeds the available context size', n_prompt_tokens: 40000, n_ctx: 32768 } },
    });
    await h.provider.sendMessage('Say hello.', 'agent', 'local');
    assert.equal(h.model.requests.length, 1);
    const state = h.last();
    assert.match(state.status, /does not fit its context \(40000 input tokens for a 32768-token context\)\. Nothing was cut and no action ran\./);
    assert.equal(state.turns.some((turn) => turn.kind === 'assistant'), false);
  });
});

test('local Chat cut off at the output limit stores no partial answer', async () => {
  await withHarness({ mode: 'chat' }, async (h) => {
    h.model.enqueue({
      kind: 'json',
      body: { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'The answer is' } }], usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106 } },
    });
    await h.provider.sendMessage('Explain closures.', 'chat', 'local');
    const state = h.last();
    assert.equal(h.model.requests[0]?.max_completion_tokens, 4096);
    assert.match(lastTurn(state)?.message ?? '', /cut off at the 4096-token output limit, so it was discarded/);
    assert.equal(state.turns.some((turn) => turn.kind === 'assistant'), false);
  });
});

test('reasoning is saved per provider/model, survives a reload, and rejects incompatible choices', async () => {
  const settings = { provider: 'cloud', model: 'muse-spark-1.3', cloudModel: 'muse-spark-1.3', mode: 'chat' };
  await withHarness(settings, async (h) => {
    h.send({ type: 'setReasoning', provider: 'cloud', model: 'muse-spark-1.3', level: 'medium' });
    await h.waitFor((state) => generationOf(state)?.reasoning === 'medium');
    assert.deepEqual(storedGeneration(h).reasoningByModel, { 'cloud:muse-spark-1.3': 'medium' });
    // "none" and "off" are not accepted; Spark 1.3 supports minimal and max.
    for (const level of ['none', 'off']) {
      h.send({ type: 'setReasoning', provider: 'cloud', model: 'muse-spark-1.3', level });
      await h.waitFor((state) => state.status === 'Ignoring an invalid view request.');
    }
    h.send({ type: 'setReasoning', provider: 'cloud', model: 'muse-spark-1.3', level: 'max' });
    await h.waitFor((state) => state.status === 'Reasoning set to Max for muse-spark-1.3.');
    h.send({ type: 'setReasoning', provider: 'cloud', model: 'muse-spark-1.3', level: 'medium' });
    await h.waitFor((state) => state.status === 'Reasoning set to Medium for muse-spark-1.3.');
    // A selection for a provider/model that is not the current one is refused.
    h.send({ type: 'setReasoning', provider: 'local', model: 'local-glimmer', level: 'low' });
    await h.waitFor((state) => /no longer matches the current runtime/.test(state.status));
    assert.deepEqual(storedGeneration(h).reasoningByModel, { 'cloud:muse-spark-1.3': 'medium' });
    // Another model has its own choice.
    await h.provider.selectCloudModel('muse-spark-1.2');
    assert.equal(generationOf(h.last()).model, 'muse-spark-1.2');
    assert.equal(generationOf(h.last()).reasoning, 'default');
    await h.provider.selectCloudModel('muse-spark-1.3');
    // Reload over the same persisted state.
    h.createProvider();
    h.send({ type: 'ready' });
    const reloaded = await h.waitFor((state) => generationOf(state)?.model === 'muse-spark-1.3');
    assert.equal(generationOf(reloaded).reasoning, 'medium');
  });
});

test('a level the local server does not support cannot be stored', async () => {
  await withHarness({}, async (h) => {
    h.send({ type: 'setReasoning', provider: 'local', model: 'local-glimmer', level: 'low' });
    await h.waitFor((state) => /Reasoning Low is not available for local-glimmer\./.test(state.status));
    assert.deepEqual(storedGeneration(h).reasoningByModel, {});
  });
});

test('manual maximums are saved together or not at all, and persist', async () => {
  await withHarness({}, async (h) => {
    h.send({ type: 'setMaxOutputTokens', local: 100, cloud: 5000 });
    await h.waitFor((state) => /Local maximum not saved, so nothing changed/.test(state.status));
    assert.deepEqual(storedGeneration(h).maxOutputTokens, { local: null, cloud: null });
    h.send({ type: 'setMaxOutputTokens', local: 8192, cloud: 5000.5 });
    await h.waitFor((state) => state.status === 'Ignoring an invalid view request.');
    h.send({ type: 'setMaxOutputTokens', local: 8192, cloud: null });
    await h.waitFor((state) => state.status === 'Maximum output: Local 8192 tokens, Meta automatic.');
    assert.deepEqual(storedGeneration(h).maxOutputTokens, { local: 8192, cloud: null });
    h.createProvider();
    h.send({ type: 'ready' });
    const reloaded = await h.waitFor((state) => generationOf(state)?.maxOutputTokensLocal === 8192);
    assert.equal(generationOf(reloaded).maxOutputTokensCloud, null);
    // Applied to the next request, clamped to nothing because the context is unknown.
    h.model.enqueue({ kind: 'json', body: assistantText('Done. Files changed: none.') });
    await h.provider.sendMessage('Say hello.', 'agent', 'local');
    assert.equal(h.model.requests[0]?.max_completion_tokens, 8192);
  });
});

test('changing reasoning or the maximum during a run never alters that run', async () => {
  await withHarness(generationSettings({ 'local:local-glimmer': 'low' }), async (h) => {
    h.model.props = glimmerProps(32768);
    await h.writeFile('a.txt', 'alpha');
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'r1', name: 'read_file', args: { path: 'a.txt', maxBytes: 4096 } }]) },
      { kind: 'json', body: assistantText('Read a.txt. Files changed: none.') },
    );
    const run = h.provider.sendMessage('Read a.txt.', 'agent', 'local');
    const waiting = await h.waitFor((state) => state.agentPending !== null);
    h.send({ type: 'setReasoning', provider: 'local', model: 'local-glimmer', level: 'high' });
    await h.waitFor((state) => /current run keeps its settings/.test(state.status));
    h.send({ type: 'setMaxOutputTokens', local: 1024, cloud: null });
    await h.waitFor((state) => /Local 1024 tokens.*current run keeps its settings/.test(state.status));
    const pending = waiting.agentPending as { actionId: string; digest: string };
    await h.provider.approveAgentAction(pending.actionId, pending.digest);
    await run;
    assert.equal(h.model.requests.length, 2);
    for (const body of h.model.requests) {
      assert.deepEqual(body.chat_template_kwargs, { reasoning_strength: 'low' });
      assert.equal(body.max_completion_tokens, 4096);
    }
    // The next run uses the new choices.
    h.model.enqueue({ kind: 'json', body: assistantText('Done. Files changed: none.') });
    await h.provider.sendMessage('Say hello.', 'agent', 'local');
    assert.deepEqual(h.model.requests[2]?.chat_template_kwargs, { reasoning_strength: 'high' });
    assert.equal(h.model.requests[2]?.max_completion_tokens, 1024);
  });
});

test('earlier thread text that is shortened carries a visible marker instead of vanishing', async () => {
  await withHarness({}, async (h) => {
    const long = `Start ${'a'.repeat(5000)}`;
    h.model.enqueue(
      { kind: 'json', body: assistantText('Noted. Files changed: none.') },
      { kind: 'json', body: assistantText('Done. Files changed: none.') },
    );
    await h.provider.sendMessage(long, 'agent', 'local');
    await h.provider.sendMessage('Continue.', 'agent', 'local');
    const messages = h.model.requests[1]?.messages as Array<{ role: string; content: string }>;
    const earlier = messages.find((m) => m.role === 'user' && m.content.startsWith('Start '));
    assert.match(earlier?.content ?? '', /…\[RAME Code shortened this earlier message: \d+ characters left out\]$/);
    // The current request is sent whole.
    assert.equal(messages.filter((m) => m.role === 'user').pop()?.content, 'Continue.');
  });
});
