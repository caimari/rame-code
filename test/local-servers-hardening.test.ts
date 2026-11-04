/**
 * Codex's P1 findings on external model servers, as regressions
 * (SIMULATED servers on loopback, no internet, no Meta):
 *   1. no local client follows a redirect (307/308): prompts, history and
 *      project content are never resent to another address;
 *   2. destinations are loopback or literal private IPs only (unit tests in
 *      local-servers.test.ts);
 *   3. a model without tools: Agent and Mission send nothing.
 * Plus: approvals void on a context change, bounded discovery.
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';

import { createLocalAgentCompletion } from '../src/agentModel.js';
import { createLocalChatCompletion, createLocalMissionPlan } from '../src/localProvider.js';
import { LOCAL_REDIRECT_REFUSED, scanLocalServer } from '../src/localServers.js';
import { assistantText, HostHarness, toolCallReply } from './helpers/hostHarness.js';

const GEN = { maxCompletionTokens: 256, reasoning: null, reasoningParam: null };

async function serve(handler: http.RequestListener): Promise<{ origin: string; hits: () => number; close(): Promise<void> }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, hits: () => hits, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

for (const status of [307, 308]) {
  test(`P1-1: a ${status} redirect from a model server is refused by every local client; the other address receives nothing`, async () => {
    const elsewhere = await serve((_req, res) => res.end('{}'));
    const redirecting = await serve((req, res) => {
      req.resume();
      res.writeHead(status, { location: `${elsewhere.origin}${req.url}` });
      res.end();
    });
    try {
      const messages = [{ role: 'user' as const, content: 'project secret: the contents of src/app.js' }];
      await assert.rejects(createLocalChatCompletion({ endpoint: redirecting.origin, model: 'm', messages, generation: GEN }), (error: Error) => error.message === LOCAL_REDIRECT_REFUSED);
      await assert.rejects(createLocalAgentCompletion({ endpoint: redirecting.origin, model: 'm', messages, generation: GEN }), (error: Error) => error.message === LOCAL_REDIRECT_REFUSED);
      await assert.rejects(createLocalMissionPlan({ endpoint: redirecting.origin, model: 'm', messages, generation: GEN, planSchema: { type: 'object' } }), (error: Error) => error.message === LOCAL_REDIRECT_REFUSED);
      const scan = await scanLocalServer(redirecting.origin);
      assert.equal(scan.ok, false, 'a scan does not follow it either');
      assert.equal(elsewhere.hits(), 0, 'nothing reached the redirect target');
      assert.ok(redirecting.hits() >= 4);
    } finally {
      await redirecting.close();
      await elsewhere.close();
    }
  });
}

test('discovery is bounded: at most 4 Ollama show requests at a time, and an oversized answer is dropped while it arrives', async () => {
  let active = 0;
  let peak = 0;
  const ollama = await serve((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.32.5' }));
      if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: Array.from({ length: 12 }, (_, i) => ({ name: `m${i}:latest` })) }));
      if (req.url === '/api/show') {
        active += 1;
        peak = Math.max(peak, active);
        setTimeout(() => {
          active -= 1;
          res.end(JSON.stringify(JSON.parse(body).model === 'm0:latest' ? { capabilities: ['completion', 'tools'], pad: 'x'.repeat(5 * 1024 * 1024) } : { capabilities: ['completion', 'tools'] }));
        }, 40);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  try {
    const result = await scanLocalServer(ollama.origin);
    assert.equal(result.ok, true);
    const models = (result as { scan: { models: Array<{ id: string; tools: boolean | null }> } }).scan.models;
    assert.equal(models.length, 12);
    assert.ok(peak <= 4, `peak concurrency ${peak}`);
    assert.equal(models.find((model) => model.id === 'm0:latest')?.tools, null, 'the 5 MiB answer was dropped, not parsed');
    assert.equal(models.find((model) => model.id === 'm1:latest')?.tools, true);
  } finally {
    await ollama.close();
  }
});

const NO_TOOLS = { model: 'gemma3:1b', kind: 'ollama', tools: false, context: 32768, lan: false };

test('P1-3: with a model the server says cannot call tools, Agent and Mission send no request at all; Chat still works', async () => {
  const h = new HostHarness();
  await h.start({ externalLocal: NO_TOOLS });
  try {
    h.provider.settings = { ...h.provider.settings, externalLocalEndpoint: h.model.endpoint };
    for (const mode of ['agent', 'mission']) {
      const before = h.model.requests.length;
      const turns = h.last()?.turns?.length ?? 0;
      await h.provider.sendMessage('Build me a calculator with tests.', mode, 'local');
      assert.equal(h.model.requests.length, before, `${mode}: nothing sent`);
      assert.match(String(h.last().status), /does not support tool calls, so it cannot run Agent or Mission/);
      assert.equal(h.last().turns.length, turns, `${mode}: no thread turn either`);
    }
    await h.provider.startMission('mis_000000000000000000000000', 1, 'autonomous-workspace', null, true, null);
    assert.match(String(h.last().status), /cannot run Agent or Mission/, 'a Mission is not started or resumed either');
    h.model.enqueue({ kind: 'json', body: assistantText('Hello.') });
    await h.provider.sendMessage('Hello there.', 'chat', 'local');
    assert.equal((h.model.requests.at(-1) as { model?: string }).model, 'gemma3:1b');
  } finally {
    await h.dispose();
  }
});

test('a pending approval is void when the profile, model server or active thread changes: the command never runs', async () => {
  for (const change of ['profile', 'server', 'thread'] as const) {
    const h = new HostHarness();
    await h.start({ agentProfile: 'safe-auto', shell: { enabled: true } });
    try {
      h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'c', name: 'run_command', args: { command: 'echo ran > ran.txt' } }]) }, { kind: 'json', body: assistantText('Okay.') });
      const run = h.provider.sendMessage('Write ran.txt.', 'agent', 'local');
      await h.waitFor((state) => state.agentPending !== null && state.agentPending !== undefined, 10000);
      if (change === 'profile') {
        await h.provider.setAgentProfile('workspace-full');
      } else if (change === 'server') {
        // The user chooses a model server again while the card waits.
        h.send({ type: 'selectExternalEndpoint', endpoint: h.model.endpoint });
      } else {
        await h.provider.newThread();
      }
      await run;
      const result = String((h.model.requests as Array<{ messages?: Array<{ tool_call_id?: string; content: string | null }> }>).flatMap((r) => r.messages ?? []).find((m) => m.tool_call_id === 'c')?.content ?? '');
      // The model may not even get the result (the server it ran on was removed); the host record always says it.
      const record = `${result}\n${JSON.stringify(h.last().turns)}`;
      assert.match(record, change === 'profile' ? /approval invalidated \(the permission profile changed\)/ : change === 'server' ? /approval invalidated \(the model server (?:or model )?changed\)/ : /Approval invalidated before execution: the active thread changed/, change);
      await assert.rejects(h.readFile('ran.txt'), `${change}: nothing ran`);
    } finally {
      h.provider.cancelRequest();
      await h.dispose();
    }
  }
});
