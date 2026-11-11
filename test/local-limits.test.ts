/**
 * B-30: idle and total limits of a local model request, per model, and the
 * user's cancellation apart from both. A real HTTP server plays the model
 * (streamed answers, silence, keep-alive comments, blank or repeated text);
 * the limits are shortened so the tests run fast.
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createLocalAgentCompletion, LocalMalformedToolCallError, LOCAL_MALFORMED_TOOL_CALL_MESSAGE } from '../src/agentModel.js';
import { parseLimitsAnswer } from '../src/jobCommands.js';
import { DEFAULT_LOCAL_LIMITS, isRepeating, limitMessage, limitsForModel, LocalLimitError, parseLimitsByModel, validateLocalLimits } from '../src/localLimits.js';
import { LocalAgentModelProvider } from '../src/modelProviders/agentProvider.js';
import { defaultSettings, validateSettings } from '../src/settingsStore.js';
import { LocalContextTooSmallError, LocalServerSetupError } from '../src/localServerErrors.js';

const GEN = { maxCompletionTokens: 512, reasoning: null, reasoningParam: null };
const FAST = { idleMs: 300, totalMs: 3000 };

type Script = (res: http.ServerResponse, body: Record<string, unknown>) => void;
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ model: 'glimmer-test', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;

async function server(script: Script): Promise<{ endpoint: string; bodies: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (part) => (raw += part));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      script(res, body);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    bodies,
    close: () => new Promise<void>((resolve) => { srv.closeAllConnections(); srv.close(() => resolve()); }),
  };
}

/** Send `piece()` every `ms` until the connection closes. */
function every(res: http.ServerResponse, ms: number, piece: (n: number) => string): void {
  let n = 0;
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      clearInterval(timer);
      return;
    }
    res.write(piece(n++));
  }, ms);
  res.on('close', () => clearInterval(timer));
}

const sse = (res: http.ServerResponse) => res.writeHead(200, { 'Content-Type': 'text/event-stream' });
const run = (endpoint: string, extra: Record<string, unknown> = {}) =>
  createLocalAgentCompletion({ endpoint, model: 'glimmer-test', messages: [{ role: 'user', content: 'Go.' }], generation: GEN, limits: FAST, ...extra });

async function stoppedBy(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof LocalLimitError ? error.stop : error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

test('limits are per model, within ranges, never removed: defaults 180 s idle and 10 min total', () => {
  assert.deepEqual(DEFAULT_LOCAL_LIMITS, { idleMs: 180_000, totalMs: 600_000 });
  assert.deepEqual(validateLocalLimits({ idleSec: 180, totalSec: 600 }), { idleMs: 180_000, totalMs: 600_000 });
  for (const bad of [{ idleSec: 0, totalSec: 600 }, { idleSec: 29, totalSec: 600 }, { idleSec: 180, totalSec: 3601 }, { idleSec: 700, totalSec: 600 }, { idleSec: 180.5, totalSec: 600 }, { idleSec: '180', totalSec: 600 }, null]) {
    assert.equal(validateLocalLimits(bad), null, JSON.stringify(bad));
  }
  const stored = parseLimitsByModel({ 'muse-glimmer-30b': { idleSec: 240, totalSec: 900 }, broken: { idleSec: 1, totalSec: 2 }, '': { idleSec: 60, totalSec: 60 } });
  assert.deepEqual(stored, { 'muse-glimmer-30b': { idleSec: 240, totalSec: 900 } });
  assert.deepEqual(limitsForModel(stored, 'muse-glimmer-30b'), { idleMs: 240_000, totalMs: 900_000 });
  assert.deepEqual(limitsForModel(stored, 'another-model'), DEFAULT_LOCAL_LIMITS);
  assert.deepEqual(defaultSettings().localLimits, {});
  assert.deepEqual(validateSettings({ ...defaultSettings(), localLimits: { m: { idleSec: 90, totalSec: 120 }, x: 'no' } }).localLimits, { m: { idleSec: 90, totalSec: 120 } });
  assert.deepEqual(parseLimitsAnswer('240, 900'), { idleSec: 240, totalSec: 900 });
  assert.equal(parseLimitsAnswer('0, 0'), null, 'a limit cannot be switched off');
  assert.equal(parseLimitsAnswer('600, 300'), null);
  // Each stop says which limit, how long, and that nothing was concluded.
  assert.match(limitMessage('first-output', DEFAULT_LOCAL_LIMITS), /sent no output for 3 min after the request \(idle limit for this model\).*Nothing was concluded/);
  assert.match(limitMessage('idle', DEFAULT_LOCAL_LIMITS), /stopped sending new output for 3 min \(idle limit/);
  assert.match(limitMessage('repetition', DEFAULT_LOCAL_LIMITS), /only sent blank or repeated text, which RAME does not count as progress/);
  assert.match(limitMessage('total', DEFAULT_LOCAL_LIMITS), /total limit of 10 min for this model, although output was still arriving/);
});

test('repetition: one short piece repeated is not progress; varied text is', () => {
  assert.equal(isRepeating('ab'.repeat(400)), true);
  assert.equal(isRepeating('Let me think. '.repeat(60)), true);
  assert.equal(isRepeating('x'.repeat(599)), false, 'too short to judge');
  const varied = Array.from({ length: 200 }, (_, i) => `step ${i}: n=${i * 7919 % 1000003};`).join(' ');
  assert.equal(isRepeating(varied), false);
});

test('a streamed answer is rebuilt like a non-streamed one: reasoning, tool call, usage, model; the request asks for the stream', async () => {
  const srv = await server((res) => {
    sse(res);
    res.write(': keep-alive\n\n');
    res.write(chunk({ role: 'assistant', content: '' }));
    res.write(chunk({ reasoning_content: 'The float form loses precision above 2^53, ' }));
    res.write(chunk({ reasoning_content: 'so reduce before multiplying.' }));
    res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] }));
    res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"lib/' } }] }));
    res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: 'report.js","maxBytes":4096}' } }] }));
    res.write(`data: ${JSON.stringify({ model: 'glimmer-test', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ model: 'glimmer-test', choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  try {
    const completion = await run(srv.endpoint);
    assert.equal(srv.bodies[0]?.stream, true);
    assert.deepEqual(srv.bodies[0]?.stream_options, { include_usage: true });
    assert.deepEqual(completion.toolCalls?.map((entry) => [entry.tool, entry.args]), [['read_file', { path: 'lib/report.js', maxBytes: 4096 }]]);
    assert.equal(completion.usage.inputTokens, 120);
    assert.equal(completion.usage.outputTokens, 30);
    assert.equal(completion.responseModel, 'glimmer-test');
    assert.equal(completion.finish, 'tool_calls');
  } finally {
    await srv.close();
  }
});

test('a model that keeps producing useful output past the idle limit is not stopped (long reasoning is progress)', async () => {
  const srv = await server((res) => {
    sse(res);
    let n = 0;
    const timer = setInterval(() => {
      if (n < 12) {
        res.write(chunk({ reasoning_content: `step ${n}: checking n=${n * 104729} against the original; ` }));
        n += 1;
      } else {
        clearInterval(timer);
        res.write(chunk({ content: 'Exact now.' }));
        res.end('data: [DONE]\n\n');
      }
    }, 100);
  });
  try {
    // 12 × 100 ms = 1.2 s, four times the 300 ms idle limit, well within the total.
    const completion = await run(srv.endpoint);
    assert.equal(completion.text, 'Exact now.');
  } finally {
    await srv.close();
  }
});

test('idle limit: silence before the first token, and silence after some output, are reported apart', async () => {
  const silent = await server((res) => sse(res));
  const quiet = await server((res) => {
    sse(res);
    res.write(chunk({ reasoning_content: 'Let me look at the inputs first.' }));
  });
  try {
    const started = Date.now();
    assert.equal(await stoppedBy(run(silent.endpoint)), 'first-output');
    assert.ok(Date.now() - started < 2000, 'stopped at the idle limit, not the total');
    assert.equal(await stoppedBy(run(quiet.endpoint)), 'idle');
  } finally {
    await silent.close();
    await quiet.close();
  }
});

test('not every token is progress: keep-alive comments, blank deltas and a repeated loop all hit the idle limit', async () => {
  const keepAlive = await server((res) => {
    sse(res);
    every(res, 50, () => ': ping\n\n');
  });
  const blank = await server((res) => {
    sse(res);
    every(res, 50, () => chunk({ content: ' \n' }));
  });
  const loop = await server((res) => {
    sse(res);
    res.write(chunk({ reasoning_content: 'First a real thought about the precision of the closed form. ' }));
    every(res, 20, () => chunk({ reasoning_content: 'Wait, let me reconsider. ' }));
  });
  try {
    assert.equal(await stoppedBy(run(keepAlive.endpoint)), 'first-output', 'comments are not output');
    assert.equal(await stoppedBy(run(blank.endpoint)), 'repetition', 'blank text is not progress');
    const looped = await stoppedBy(run(loop.endpoint));
    assert.equal(looped, 'repetition', 'the same sentence over and over is not progress');
  } finally {
    await keepAlive.close();
    await blank.close();
    await loop.close();
  }
});

test('total limit: output that keeps arriving cannot run past the total', async () => {
  const srv = await server((res) => {
    sse(res);
    every(res, 50, (n) => chunk({ reasoning_content: `new thought ${n} about input ${n * 7919}; ` }));
  });
  try {
    const started = Date.now();
    const stop = await stoppedBy(createLocalAgentCompletion({ endpoint: srv.endpoint, model: 'glimmer-test', messages: [], generation: GEN, limits: { idleMs: 300, totalMs: 900 } }));
    assert.equal(stop, 'total');
    assert.ok(Date.now() - started >= 850);
  } finally {
    await srv.close();
  }
});

test('the user cancelling is a cancellation, never reported as a limit', async () => {
  const srv = await server((res) => {
    sse(res);
    every(res, 30, (n) => chunk({ reasoning_content: `thinking ${n}; ` }));
  });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const outcome = await stoppedBy(run(srv.endpoint, { signal: controller.signal }));
    assert.match(outcome, /^AbortError/);
  } finally {
    await srv.close();
  }
});

test('a server that ignores stream answers in one piece: parsed as before, only the total limit applies after its headers', async () => {
  const late = await server((res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    // Longer than the idle limit, shorter than the total: no progress can be seen, so idle cannot apply.
    setTimeout(() => res.end(JSON.stringify({ model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Whole answer.' } }] })), 600);
  });
  try {
    assert.equal((await run(late.endpoint)).text, 'Whole answer.');
  } finally {
    await late.close();
  }
});

test('errors sent inside the stream are errors, not answers', async () => {
  const malformed = await server((res) => {
    sse(res);
    res.end(`data: ${JSON.stringify({ error: { type: 'server_error', message: LOCAL_MALFORMED_TOOL_CALL_MESSAGE } })}\n\n`);
  });
  const other = await server((res) => {
    sse(res);
    res.end(`data: ${JSON.stringify({ error: { message: 'model crashed' } })}\n\n`);
  });
  const http500 = await server((res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'server_error', message: LOCAL_MALFORMED_TOOL_CALL_MESSAGE } }));
  });
  try {
    await assert.rejects(run(malformed.endpoint), LocalMalformedToolCallError);
    await assert.rejects(run(other.endpoint), /The local runtime reported an error: model crashed\./);
    await assert.rejects(run(http500.endpoint), LocalMalformedToolCallError);
  } finally {
    await malformed.close();
    await other.close();
    await http500.close();
  }
});

test('without limits nothing changes: the old non-streamed request; the Agent provider passes the model limits', async () => {
  const srv = await server((res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }));
  });
  try {
    await createLocalAgentCompletion({ endpoint: srv.endpoint, model: 'glimmer-test', messages: [], generation: GEN });
    assert.equal(srv.bodies[0]?.stream, false);
    assert.equal('stream_options' in (srv.bodies[0] ?? {}), false);
  } finally {
    await srv.close();
  }
  const seen: Array<Record<string, unknown>> = [];
  const provider = new LocalAgentModelProvider('http://127.0.0.1:9', async (options) => {
    seen.push(options as unknown as Record<string, unknown>);
    return { text: 'ok', toolCalls: null, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 }, finish: 'stop', responseModel: null } as never;
  }, { idleMs: 240_000, totalMs: 900_000 });
  await provider.complete({ model: 'm', messages: [], generation: GEN, tools: [], signal: new AbortController().signal, toolChoice: 'auto' });
  assert.deepEqual(seen[0]?.limits, { idleMs: 240_000, totalMs: 900_000 });
});

test('a context or setup refusal sent inside the stream keeps its meaning (LM Studio, seen 2026-11-10)', async () => {
  // LM Studio answered HTTP 200 and put llama.cpp's refusal in the stream: it was shown as a bare
  // "The local runtime reported an error", with no reload button and a card saying Glimmer answered.
  const refusal = 'Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (6828 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":6828,"n_ctx":4096}}';
  const context = await server((res) => {
    sse(res);
    res.end(`data: ${JSON.stringify({ error: { message: refusal } })}\n\n`);
  });
  const setup = await server((res) => {
    sse(res);
    res.end(`data: ${JSON.stringify({ error: { message: "No models loaded. Please load a model in the developer page or use the 'lms load' command." } })}\n\n`);
  });
  try {
    const error = await run(context.endpoint).then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof LocalContextTooSmallError, String(error));
    assert.equal(error.needed, 6828);
    assert.equal(error.available, 4096);
    assert.match(error.message, /context is too small for this request \(6828 input tokens for a 4096-token context\)\. Nothing was cut and no action ran\./);
    await assert.rejects(run(setup.endpoint), (caught: unknown) => caught instanceof LocalServerSetupError && caught.problem === 'no-model-loaded');
  } finally {
    await context.close();
    await setup.close();
  }
});
