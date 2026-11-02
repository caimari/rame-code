import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildAgentRequestBody, createLocalAgentCompletion, createMetaAgentCompletion } from '../src/agentModel.js';
import { MAX_AGENT_STEPS } from '../src/agentPolicy.js';
import { buildAgentToolDefinitions } from '../src/agentTools.js';
import {
  CLOUD_AUTO_OUTPUT_TOKENS,
  CONTEXT_SAFETY_TOKENS,
  GenerationContextError,
  LOCAL_AUTO_OUTPUT_TOKENS,
  META_CONTEXT_WINDOW,
  META_OUTPUT_LIMIT,
  MIN_OUTPUT_TOKENS,
  OutputCutOffError,
  automaticOutputTokens,
  cloudGenerationProfile,
  describeBudgetLimit,
  estimatePromptTokens,
  generationRequestFields,
  localContextRefusal,
  localGenerationProfile,
  parseLlamaServerProps,
  parseManualMaxOutput,
  resolveOutputBudget,
  resolveReasoning,
  stoppedAtLength,
  validateGenerationSettings,
  withReasoningChoice,
  type GenerationRequest,
} from '../src/generationSettings.js';
import { createLocalChatCompletion } from '../src/localProvider.js';
import { createChatCompletion, createMissionPlanWithUsage } from '../src/meta-provider.js';
import { validateSettings } from '../src/settingsStore.js';
import { parseViewInboundMessage } from '../src/viewMessages.js';

/** The two template lines that make Muse Glimmer's reasoning control (verbatim). */
const GLIMMER_TEMPLATE_EXCERPT =
  "{%- macro render_reasoning() -%}\n" +
  "    {%- set rs = reasoning_strength if reasoning_strength is defined and reasoning_strength else 'high' -%}\n" +
  "    {{- 'Reasoning strength: ' + rs + '.' -}}\n" +
  '{%- endmacro -%}';

const glimmerProps = (nCtx: number) => ({ default_generation_settings: { n_ctx: nCtx }, chat_template: GLIMMER_TEMPLATE_EXCERPT });

function capture(sent: Record<string, unknown>[], reply: unknown) {
  return async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json(reply);
  };
}

const textReply = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }] };

test('Meta profiles offer only documented levels; reasoning can never be switched off', () => {
  for (const model of ['muse-spark-1.1', 'muse-spark-1.2']) {
    const profile = cloudGenerationProfile(model);
    assert.deepEqual(profile.reasoningLevels, ['minimal', 'low', 'medium', 'high', 'xhigh']);
    assert.equal(profile.reasoningParam, 'reasoning_effort');
    assert.equal(profile.contextWindow, META_CONTEXT_WINDOW);
    assert.equal(profile.maxOutputTokens, null);
    assert.equal(profile.autoOutputTokens, CLOUD_AUTO_OUTPUT_TOKENS);
  }
  assert.deepEqual(cloudGenerationProfile('muse-spark-1.3').reasoningLevels, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(cloudGenerationProfile('muse-wonder-1.0').reasoningLevels, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(cloudGenerationProfile('muse-spark-1.3').maxOutputTokens, META_OUTPUT_LIMIT);
  // Contributor variants keep the documented context but do not support max.
  assert.equal(cloudGenerationProfile('muse-spark-1.3-contributor').contextWindow, META_CONTEXT_WINDOW);
  assert.equal(cloudGenerationProfile('muse-spark-1.3-contributor').reasoningLevels.includes('max'), false);
  // An id the docs do not cover gets no reasoning control at all.
  const unknown = cloudGenerationProfile('muse-spark-9.9');
  assert.deepEqual(unknown.reasoningLevels, []);
  assert.equal(unknown.reasoningParam, null);
  for (const model of ['muse-spark-1.3-contributor', 'muse-spark-9.9']) {
    const levels = cloudGenerationProfile(model).reasoningLevels as readonly string[];
    for (const unsupported of ['none', 'off', 'max']) {
      assert.equal(levels.includes(unsupported), false, `${model} must not offer ${unsupported}`);
    }
  }
});

test('Meta automatic output budget scales with reasoning while local stays bounded', () => {
  assert.equal(automaticOutputTokens('cloud', 'minimal'), 8192);
  assert.equal(automaticOutputTokens('cloud', 'low'), 8192);
  assert.equal(automaticOutputTokens('cloud', 'medium'), 16384);
  assert.equal(automaticOutputTokens('cloud', 'default'), 32768);
  assert.equal(automaticOutputTokens('cloud', 'high'), 32768);
  assert.equal(automaticOutputTokens('cloud', 'xhigh'), 65536);
  assert.equal(automaticOutputTokens('cloud', 'max'), META_OUTPUT_LIMIT);
  assert.equal(automaticOutputTokens('local', 'xhigh'), LOCAL_AUTO_OUTPUT_TOKENS);
});

test('local reasoning levels come only from a verified Muse Glimmer template on the server', () => {
  const glimmer = parseLlamaServerProps(glimmerProps(32768));
  assert.deepEqual(glimmer, { contextWindow: 32768, template: 'muse-glimmer' });
  const profile = localGenerationProfile(glimmer, null);
  assert.deepEqual(profile.reasoningLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(profile.reasoningParam, 'chat_template_kwargs.reasoning_strength');
  assert.equal(profile.reasoningDefault, 'high');
  assert.equal(profile.contextWindow, 32768);
  // A template that merely reads reasoning_effort is not Glimmer's control.
  const other = parseLlamaServerProps({ default_generation_settings: { n_ctx: 8192 }, chat_template: '{{ reasoning_effort }}' });
  assert.equal(other.template, 'other');
  assert.deepEqual(localGenerationProfile(other, null).reasoningLevels, []);
  assert.equal(localGenerationProfile(other, null).reasoningParam, null);
  // Not llama-server (no /props) or a malformed reply: unknown, no levels.
  for (const payload of [null, 'x', [], {}, { default_generation_settings: { n_ctx: -1 } }, { default_generation_settings: { n_ctx: 1.5 } }]) {
    const props = parseLlamaServerProps(payload);
    assert.equal(props.contextWindow, null);
    assert.deepEqual(localGenerationProfile(props, null).reasoningLevels, []);
  }
  // RAME's own -c value is a fallback only when the server reported nothing.
  assert.equal(localGenerationProfile(null, 16384).contextWindow, 16384);
  assert.equal(localGenerationProfile(glimmer, 16384).contextWindow, 32768);
});

test('request fields: one real parameter per provider, nothing for Model default', () => {
  assert.deepEqual(
    generationRequestFields({ maxCompletionTokens: 3000, reasoning: 'high', reasoningParam: 'reasoning_effort' }),
    { max_completion_tokens: 3000, reasoning_effort: 'high' },
  );
  assert.deepEqual(
    generationRequestFields({ maxCompletionTokens: 4096, reasoning: 'low', reasoningParam: 'chat_template_kwargs.reasoning_strength' }),
    { max_completion_tokens: 4096, chat_template_kwargs: { reasoning_strength: 'low' } },
  );
  assert.deepEqual(generationRequestFields({ maxCompletionTokens: 4096, reasoning: null, reasoningParam: 'reasoning_effort' }), {
    max_completion_tokens: 4096,
  });
  // A level with no verified parameter sends nothing extra.
  assert.deepEqual(generationRequestFields({ maxCompletionTokens: 512, reasoning: 'low', reasoningParam: null }), { max_completion_tokens: 512 });
});

test('exact Agent payloads for Meta and local', async () => {
  const sent: Record<string, unknown>[] = [];
  const messages = [{ role: 'user' as const, content: 'List files.' }];
  const tools = buildAgentToolDefinitions();
  await createMetaAgentCompletion({
    apiKey: 'test-key',
    model: 'muse-spark-1.3',
    messages,
    generation: { maxCompletionTokens: 2000, reasoning: 'xhigh', reasoningParam: 'reasoning_effort' },
    fetchImpl: capture(sent, textReply),
  });
  await createLocalAgentCompletion({
    endpoint: 'http://127.0.0.1:9',
    model: 'local-glimmer',
    messages,
    generation: { maxCompletionTokens: 4096, reasoning: 'medium', reasoningParam: 'chat_template_kwargs.reasoning_strength' },
    toolChoice: 'none',
    fetchImpl: capture(sent, textReply),
  });
  assert.deepEqual(sent[0], {
    model: 'muse-spark-1.3',
    messages,
    tools,
    tool_choice: 'auto',
    max_completion_tokens: 2000,
    reasoning_effort: 'xhigh',
    store: false,
    stream: false,
  });
  assert.deepEqual(sent[1], {
    model: 'local-glimmer',
    messages,
    tools,
    tool_choice: 'none',
    max_completion_tokens: 4096,
    chat_template_kwargs: { reasoning_strength: 'medium' },
    store: false,
    stream: false,
  });
  // No universal 1200 survives anywhere in the Agent body.
  assert.equal(JSON.stringify(buildAgentRequestBody('m', [], { maxCompletionTokens: 777, reasoning: null, reasoningParam: null })).includes('1200'), false);
});

test('exact Chat and Mission payloads for Meta and local Chat', async () => {
  const sent: Record<string, unknown>[] = [];
  const generation: GenerationRequest = { maxCompletionTokens: 6000, reasoning: 'low', reasoningParam: 'reasoning_effort' };
  const messages = [{ role: 'user' as const, content: 'Hi.' }];
  await createChatCompletion({ apiKey: 'test-key', goal: 'Hi.', messages, model: 'muse-spark-1.2', generation, fetchImpl: capture(sent, textReply) });
  assert.deepEqual(sent[0], { model: 'muse-spark-1.2', messages, max_completion_tokens: 6000, reasoning_effort: 'low', store: false });
  const plan = { goal: 'g', assumptions: [], steps: [{ id: 's1', title: 't', successCriterion: 'c' }], risks: [] };
  await createMissionPlanWithUsage({
    apiKey: 'test-key',
    goal: 'Plan it.',
    generation,
    fetchImpl: capture(sent, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }] }),
  });
  assert.equal(sent[1]?.max_completion_tokens, 6000);
  assert.equal(sent[1]?.reasoning_effort, 'low');
  assert.ok('response_format' in (sent[1] ?? {}));
  // Callers without generation settings (legacy panels) get the automatic Meta budget, not 1200.
  await createChatCompletion({ apiKey: 'test-key', goal: 'Hi.', messages, fetchImpl: capture(sent, textReply) });
  assert.deepEqual(sent[2], { model: 'muse-spark-1.3', messages, max_completion_tokens: CLOUD_AUTO_OUTPUT_TOKENS, store: false });
  await createLocalChatCompletion({
    endpoint: 'http://127.0.0.1:9',
    model: 'local-glimmer',
    messages,
    generation: { maxCompletionTokens: 4096, reasoning: 'xhigh', reasoningParam: 'chat_template_kwargs.reasoning_strength' },
    fetchImpl: capture(sent, textReply),
  });
  assert.deepEqual(sent[3], {
    model: 'local-glimmer',
    messages,
    max_completion_tokens: 4096,
    chat_template_kwargs: { reasoning_strength: 'xhigh' },
    stream: false,
  });
});

test('finish_reason length is a cut-off in Chat and Mission too: no partial reply is used', async () => {
  const cut = { choices: [{ finish_reason: 'length', message: { content: 'Partial answ' } }] };
  const generation: GenerationRequest = { maxCompletionTokens: 900, reasoning: null, reasoningParam: null };
  const isCutOff = (error: unknown) => error instanceof OutputCutOffError && error.maxCompletionTokens === 900;
  await assert.rejects(createChatCompletion({ apiKey: 'k', goal: 'g', messages: [], generation, fetchImpl: async () => Response.json(cut) }), isCutOff);
  await assert.rejects(createMissionPlanWithUsage({ apiKey: 'k', goal: 'Plan it.', generation, fetchImpl: async () => Response.json(cut) }), isCutOff);
  await assert.rejects(
    createLocalChatCompletion({ endpoint: 'http://127.0.0.1:9', model: 'm', messages: [], generation, fetchImpl: async () => Response.json(cut) }),
    isCutOff,
  );
  assert.equal(stoppedAtLength(cut), true);
  assert.equal(stoppedAtLength(textReply), false);
  assert.equal(stoppedAtLength({ choices: [] }), false);
});

test('the output budget fits the context without ever shortening the input', () => {
  const profile = localGenerationProfile(parseLlamaServerProps(glimmerProps(32768)), null);
  assert.deepEqual(resolveOutputBudget('local', profile, null, 1000), {
    maxCompletionTokens: LOCAL_AUTO_OUTPUT_TOKENS,
    requested: LOCAL_AUTO_OUTPUT_TOKENS,
    source: 'automatic',
    limitedBy: null,
  });
  assert.equal(resolveOutputBudget('local', profile, 12000, 1000).maxCompletionTokens, 12000);
  // Manual maximum above the free context: lowered, visibly.
  const clamped = resolveOutputBudget('local', profile, 20000, 20000);
  assert.equal(clamped.maxCompletionTokens, 32768 - 20000 - CONTEXT_SAFETY_TOKENS);
  assert.equal(clamped.limitedBy, 'context');
  assert.match(describeBudgetLimit(clamped) ?? '', /reduced from 20000 \(manual\) to 12512 tokens to fit the free context/);
  assert.equal(describeBudgetLimit(resolveOutputBudget('local', profile, null, 1000)), null);
  // Not enough room for a useful reply: refused, nothing cut.
  assert.throws(
    () => resolveOutputBudget('local', profile, null, 32768 - CONTEXT_SAFETY_TOKENS - MIN_OUTPUT_TOKENS + 1),
    (error: unknown) =>
      error instanceof GenerationContextError &&
      /Nothing was cut and nothing was sent\./.test(error.message) &&
      /raise the local context size/.test(error.message),
  );
  // Exactly the minimum still goes out.
  assert.equal(resolveOutputBudget('local', profile, null, 32768 - CONTEXT_SAFETY_TOKENS - MIN_OUTPUT_TOKENS).maxCompletionTokens, MIN_OUTPUT_TOKENS);
  // Unknown context: no context clamp, the requested budget is used.
  assert.equal(resolveOutputBudget('local', localGenerationProfile(null, null), null, 900000).maxCompletionTokens, LOCAL_AUTO_OUTPUT_TOKENS);
  // Meta context window bounds the cloud budget the same way.
  const cloud = cloudGenerationProfile('muse-spark-1.3');
  assert.equal(resolveOutputBudget('cloud', cloud, null, 10).maxCompletionTokens, CLOUD_AUTO_OUTPUT_TOKENS);
  assert.throws(() => resolveOutputBudget('cloud', cloud, null, META_CONTEXT_WINDOW), /shorter request/);
  // A documented model maximum (none exists today) would cap first.
  assert.equal(resolveOutputBudget('cloud', { ...cloud, maxOutputTokens: 3000 }, 9000, 10).limitedBy, 'model');
});

test('the input estimate is conservative and only tightens from a real measurement', () => {
  const body = { messages: [{ role: 'user', content: 'x'.repeat(3000) }] };
  const chars = JSON.stringify(body).length;
  assert.equal(estimatePromptTokens(body), Math.ceil(chars / 3));
  // A measured ratio is used with a 10 % margin...
  assert.equal(estimatePromptTokens(body, { chars: 1000, tokens: 300 }), Math.ceil(chars * ((300 / 1000) * 1.1)));
  assert.ok(estimatePromptTokens(body, { chars: 1000, tokens: 300 }) < estimatePromptTokens(body));
  // ...but never below 4 characters per token, even after an odd measurement.
  assert.equal(estimatePromptTokens(body, { chars: 1000, tokens: 1 }), Math.ceil(chars / 4));
});

test('the local server context refusal becomes a clear error with its own numbers', () => {
  const error = localContextRefusal({ error: { code: 400, type: 'exceed_context_size_error', message: 'x', n_prompt_tokens: 40000, n_ctx: 32768 } });
  assert.ok(error instanceof GenerationContextError);
  assert.match(error.message, /40000 input tokens for a 32768-token context/);
  assert.match(error.message, /Nothing was cut and no action ran\./);
  assert.equal(localContextRefusal({ error: { type: 'server_error' } }), null);
  assert.equal(localContextRefusal(null), null);
});

test('stored choices are validated per provider/model; incompatible values are dropped', () => {
  const stored = validateGenerationSettings({
    reasoningByModel: {
      'cloud:muse-spark-1.3': 'xhigh',
      'local:local-glimmer': 'low',
      'cloud:muse-spark-1.2': 'none',
      'local:x': 'off',
      'cloud:muse-wonder-1.0': 'max',
      'bad key': 'low',
      'cloud:': 'low',
    },
    maxOutputTokens: { local: 100, cloud: 5000 },
  });
  assert.deepEqual(stored.reasoningByModel, {
    'cloud:muse-spark-1.3': 'xhigh',
    'local:local-glimmer': 'low',
    'cloud:muse-wonder-1.0': 'max',
  });
  assert.deepEqual(stored.maxOutputTokens, { local: null, cloud: 5000 });
  // Persisted through the settings store and back.
  const settings = validateSettings({ provider: 'cloud', generation: stored });
  assert.deepEqual(validateSettings(JSON.parse(JSON.stringify(settings))).generation, stored);
  // Old settings without the field load with defaults.
  assert.deepEqual(validateSettings({ provider: 'local' }).generation, { reasoningByModel: {}, maxOutputTokens: { local: null, cloud: null } });
  // Choosing Model default removes the entry.
  assert.deepEqual(withReasoningChoice(stored, 'cloud', 'muse-spark-1.3', 'default').reasoningByModel, {
    'local:local-glimmer': 'low',
    'cloud:muse-wonder-1.0': 'max',
  });
});

test('a stored level is applied only where the exact provider/model accepts it', () => {
  const settings = withReasoningChoice(validateGenerationSettings({}), 'local', 'local-glimmer', 'low');
  const glimmer = localGenerationProfile(parseLlamaServerProps(glimmerProps(32768)), null);
  assert.deepEqual(resolveReasoning(settings, 'local', 'local-glimmer', glimmer), { level: 'low', stored: 'low', unavailable: false });
  // Same stored level, but the server is not Glimmer: not sent, and reported.
  assert.deepEqual(resolveReasoning(settings, 'local', 'local-glimmer', localGenerationProfile(null, 32768)), {
    level: null,
    stored: 'low',
    unavailable: true,
  });
  // Stored per model: another model keeps Model default.
  assert.deepEqual(resolveReasoning(settings, 'local', 'other-model', glimmer), { level: null, stored: 'default', unavailable: false });
  assert.deepEqual(resolveReasoning(settings, 'cloud', 'local-glimmer', cloudGenerationProfile('local-glimmer')), {
    level: null,
    stored: 'default',
    unavailable: false,
  });
});

test('the view protocol accepts only exact generation messages', () => {
  assert.deepEqual(parseViewInboundMessage({ type: 'setReasoning', provider: 'cloud', model: 'muse-spark-1.3', level: 'xhigh' }), {
    type: 'setReasoning',
    provider: 'cloud',
    model: 'muse-spark-1.3',
    level: 'xhigh',
  });
  assert.deepEqual(parseViewInboundMessage({ type: 'setMaxOutputTokens', local: null, cloud: 4096 }), {
    type: 'setMaxOutputTokens',
    local: null,
    cloud: 4096,
  });
  assert.deepEqual(parseViewInboundMessage({ type: 'setReasoning', provider: 'cloud', model: 'muse-spark-1.3', level: 'max' }), {
    type: 'setReasoning', provider: 'cloud', model: 'muse-spark-1.3', level: 'max',
  });
  for (const bad of [
    { type: 'setReasoning', provider: 'cloud', model: 'muse-spark-1.3', level: 'none' },
    { type: 'setReasoning', provider: 'cloud', model: 'muse-spark-1.3', level: 'turbo' },
    { type: 'setReasoning', provider: 'meta', model: 'muse-spark-1.3', level: 'low' },
    { type: 'setReasoning', provider: 'cloud', model: '../x', level: 'low' },
    { type: 'setReasoning', provider: 'cloud', model: 'muse-spark-1.3', level: 'low', extra: 1 },
    { type: 'setMaxOutputTokens', local: 1.5, cloud: null },
    { type: 'setMaxOutputTokens', local: '4096', cloud: null },
    { type: 'setMaxOutputTokens', local: 4096 },
    { type: 'setMaxOutputTokens', provider: 'local', value: 4096 },
  ]) {
    assert.throws(() => parseViewInboundMessage(bad), /^Error: Invalid (setReasoning|setMaxOutputTokens) message\.$/);
  }
});

test('Settings shows a discrete reasoning selector built only from host-sent options', () => {
  const html = readFileSync('src/viewHtml.ts', 'utf8');
  assert.match(html, /<select id="reasoningSelect" aria-label="Reasoning effort">/);
  assert.match(html, /id="maxOutputLocal"/);
  assert.match(html, /id="maxOutputCloud"/);
  assert.match(html, /Reasoning effort, output budget, context window, and the Agent's 12-step budget are separate settings\./);
  const script = readFileSync('media/main.js', 'utf8');
  const render = script.slice(script.indexOf('function renderGeneration'), script.indexOf('function readMaxOutput'));
  assert.ok(render.length > 0);
  assert.doesNotMatch(render, /innerHTML/);
  assert.match(render, /gen\.reasoningOptions/);
  // The option list comes from the host; labels only render those values.
});

test('manual maximums are bounded per provider and kept apart from the 12-step budget', () => {
  assert.equal(parseManualMaxOutput('local', null), null);
  assert.equal(parseManualMaxOutput('local', 256), 256);
  assert.equal(parseManualMaxOutput('local', 262144), 262144);
  assert.equal(parseManualMaxOutput('cloud', META_OUTPUT_LIMIT), META_OUTPUT_LIMIT);
  for (const [provider, value] of [['local', 255], ['local', 262145], ['cloud', META_OUTPUT_LIMIT + 1], ['cloud', 1000.5], ['cloud', '4096']] as const) {
    assert.throws(() => parseManualMaxOutput(provider, value), /whole number from 256/);
  }
  assert.equal(MAX_AGENT_STEPS, 12);
});
