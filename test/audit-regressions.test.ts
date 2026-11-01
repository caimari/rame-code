/**
 * Regressions for defects confirmed in the full-audit pass: unbounded model
 * response bodies, test-process trees that outlive their deadline, npm
 * lifecycle hooks, catastrophic regexes, unprotected secret files, and the
 * tool-message order of the reference loop.
 */

import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { runAgentLoop } from '../src/agentLoop.js';
import { createLocalAgentCompletion, createMetaAgentCompletion } from '../src/agentModel.js';
import { checkAgentRelPath } from '../src/agentPolicy.js';
import { formatProcessResult, runBoundedProcess } from '../src/agentProcess.js';
import {
  AgentToolProtocolError,
  isBacktrackingRiskPattern,
  parseAssistantToolCalls,
  validateSearchTextArgs,
} from '../src/agentTools.js';
import { createLocalChatCompletion } from '../src/localProvider.js';
import { createChatCompletion, createMissionPlanWithUsage } from '../src/meta-provider.js';
import type { AgentChatMessage } from '../src/agentModel.js';

/** Loopback server that sends headers and a partial body, then stalls. */
async function stallingServer(): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"choices":[');
    open.add(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const res of open) {
        res.destroy();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ state: 'resolved' | 'rejected' | 'hung'; error?: Error }> {
  return Promise.race([
    promise.then(
      () => ({ state: 'resolved' as const }),
      (error: Error) => ({ state: 'rejected' as const, error }),
    ),
    new Promise<{ state: 'hung' }>((resolve) => setTimeout(() => resolve({ state: 'hung' }), ms)),
  ]);
}

test('agent model calls time out even when the body never finishes', async () => {
  const stall = await stallingServer();
  try {
    const local = await settleWithin(
      createLocalAgentCompletion({ endpoint: stall.endpoint, model: 'local-glimmer', messages: [], timeoutMs: 150 }),
      3000,
    );
    assert.equal(local.state, 'rejected');
    assert.match(local.error?.message ?? '', /did not answer within/);
    const cloud = await settleWithin(
      createMetaAgentCompletion({ apiKey: 'k', model: 'muse-spark-1.3', messages: [], endpoint: `${stall.endpoint}/v1/chat/completions`, timeoutMs: 150 }),
      3000,
    );
    assert.equal(cloud.state, 'rejected');
    assert.match(cloud.error?.message ?? '', /timed out/);
  } finally {
    await stall.close();
  }
});

test('cancelling an agent model call while its body streams surfaces as AbortError', async () => {
  const stall = await stallingServer();
  try {
    const controller = new AbortController();
    const pending = createLocalAgentCompletion({ endpoint: stall.endpoint, model: 'local-glimmer', messages: [], signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const outcome = await settleWithin(pending, 3000);
    assert.equal(outcome.state, 'rejected');
    assert.equal(outcome.error?.name, 'AbortError');
  } finally {
    await stall.close();
  }
});

test('chat and mission calls are bounded too (cloud and local)', async () => {
  const stall = await stallingServer();
  try {
    const endpoint = `${stall.endpoint}/v1/chat/completions`;
    const chat = await settleWithin(createChatCompletion({ apiKey: 'k', goal: 'g', messages: [], endpoint, timeoutMs: 150 }), 3000);
    assert.equal(chat.state, 'rejected');
    assert.match(chat.error?.message ?? '', /timed out/);
    const mission = await settleWithin(createMissionPlanWithUsage({ apiKey: 'k', goal: 'goal text', endpoint, timeoutMs: 150 }), 3000);
    assert.equal(mission.state, 'rejected');
    assert.match(mission.error?.message ?? '', /timed out/);
    const local = await settleWithin(createLocalChatCompletion({ endpoint: stall.endpoint, model: 'm', messages: [], timeoutMs: 150 }), 3000);
    assert.equal(local.state, 'rejected');
    assert.match(local.error?.message ?? '', /did not answer within/);
  } finally {
    await stall.close();
  }
});

test('a rejected malformed tool reply keeps its usage for accounting', async () => {
  const body = {
    choices: [{ message: { tool_calls: [{ id: 'x', type: 'function', function: { name: 'read_file', arguments: '{' } }] } }],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  };
  assert.throws(() => parseAssistantToolCalls(body), AgentToolProtocolError);
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const outcome = await settleWithin(
      createLocalAgentCompletion({ endpoint: `http://127.0.0.1:${port}`, model: 'local-glimmer', messages: [] }),
      3000,
    );
    assert.equal(outcome.state, 'rejected');
    assert.ok(outcome.error instanceof AgentToolProtocolError);
    assert.equal((outcome.error as AgentToolProtocolError).usage?.inputTokens, 7);
    assert.equal((outcome.error as AgentToolProtocolError).usage?.totalTokens, 9);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** True while `pid` exists (signal 0 only checks; works on POSIX and Windows). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Pids still alive after up to `waitMs` (the Windows tree kill is asynchronous). */
async function survivors(pids: number[], waitMs = 2000): Promise<number[]> {
  const deadline = Date.now() + waitMs;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    alive = alive.filter(isAlive);
  }
  return alive;
}

function killAll(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * A parent that spawns a grandchild sharing its stdout, records both pids
 * in `pidFile`, then both idle. Pids instead of `ps` keep this portable.
 */
function treeArgv(pidFile: string): string[] {
  return [
    '-e',
    `const c=require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + c.pid); setInterval(()=>{},1000)`,
  ];
}

async function treePids(pidFile: string, waitMs = 3000): Promise<number[]> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const pids = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
      if (pids.length === 2 && pids.every((pid) => pid > 0)) {
        return pids;
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

function pidFileFor(label: string): string {
  return path.join(os.tmpdir(), `rame-tree-${label}-${process.pid}-${Date.now()}.pids`);
}

test('a test command that outlives its deadline is killed as a whole tree and reported as a timeout', async () => {
  const pidFile = pidFileFor('timeout');
  const started = Date.now();
  const run = runBoundedProcess({ executable: process.execPath, argv: treeArgv(pidFile), timeoutMs: 1500, maxOutputBytes: 1024, killGraceMs: 200 });
  const pids = await treePids(pidFile);
  const outcome = await settleWithin(run, 6000);
  const left = await survivors(pids);
  killAll(left);
  rmSync(pidFile, { force: true });
  assert.equal(pids.length, 2, 'the parent and the grandchild both started');
  assert.equal(outcome.state, 'resolved', 'the run settles instead of waiting on a held pipe');
  assert.ok(Date.now() - started < 6000);
  assert.deepEqual(left, [], 'no grandchild survives the timeout');
  const result = await runBoundedProcess({ executable: process.execPath, argv: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 200, maxOutputBytes: 64, killGraceMs: 100 });
  assert.equal(result.timedOut, true);
  const text = formatProcessResult(result, 120_000, 64);
  assert.match(text, /^exit=timeout/);
  assert.doesNotMatch(text, /^exit=0/);
});

test('cancelling a test command tree rejects with AbortError and leaves no process behind', async () => {
  const pidFile = pidFileFor('abort');
  const controller = new AbortController();
  const pending = runBoundedProcess({ executable: process.execPath, argv: treeArgv(pidFile), timeoutMs: 60_000, maxOutputBytes: 1024, killGraceMs: 200 }, controller.signal);
  const pids = await treePids(pidFile);
  controller.abort();
  const outcome = await settleWithin(pending, 4000);
  const left = await survivors(pids);
  killAll(left);
  rmSync(pidFile, { force: true });
  assert.equal(pids.length, 2, 'the parent and the grandchild both started');
  assert.equal(outcome.state, 'rejected');
  assert.equal(outcome.error?.name, 'AbortError');
  assert.deepEqual(left, []);
});

test('a normal test command reports its real exit code and output', async () => {
  const pass = await runBoundedProcess({ executable: process.execPath, argv: ['-e', 'console.log("hi")'], timeoutMs: 10_000, maxOutputBytes: 64 });
  assert.equal(pass.exitCode, 0);
  assert.equal(pass.timedOut, false);
  assert.match(formatProcessResult(pass, 10_000, 64), /^exit=0\nstdout:\nhi/);
  const fail = await runBoundedProcess({ executable: process.execPath, argv: ['-e', 'process.exit(3)'], timeoutMs: 10_000, maxOutputBytes: 64 });
  assert.match(formatProcessResult(fail, 10_000, 64), /^exit=3/);
});

test('search_text rejects regexes that can backtrack catastrophically', () => {
  for (const risky of ['(a+)+$', '(a*)*b', '(a|aa)+', '(.*x){20}', '((ab)*c)+', '(\\w+\\s?)*$', '(x)\\1', '.*a.*b.*c']) {
    assert.equal(isBacktrackingRiskPattern(risky), true, risky);
    assert.throws(() => validateSearchTextArgs({ query: risky, dir: '', isRegex: true, maxResults: 5 }), AgentToolProtocolError, risky);
  }
  for (const safe of ['foo\\d+bar', '^export (function|const) ', 'TODO:?\\s*\\w+', '(ab)?c+', '[(]+x', 'a{2,4}b']) {
    assert.equal(isBacktrackingRiskPattern(safe), false, safe);
    validateSearchTextArgs({ query: safe, dir: '', isRegex: true, maxResults: 5 });
  }
  // Literal searches are never screened.
  validateSearchTextArgs({ query: '(a+)+$', dir: '', isRegex: false, maxResults: 5 });
});

test('package-manager tokens, SSH keys, and cloud credential folders are protected', () => {
  for (const rel of ['.npmrc', 'sub/.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.pgpass', '.ssh/config', '.ssh/id_rsa', 'id_ed25519', 'keys/id_ecdsa_sk', '.aws/config', '.docker/config.json', '.kube/config', '.gnupg/pubring.kbx', 'release.jks', 'app.keystore']) {
    assert.equal(checkAgentRelPath(rel).ok, false, rel);
  }
  for (const rel of ['id_rsa.pub', 'src/ssh-client.ts', 'docs/npmrc-guide.md', 'aws.ts', 'package.json']) {
    assert.equal(checkAgentRelPath(rel).ok, true, rel);
  }
});

test('the reference loop sends each assistant tool call before its tool result', async () => {
  const seen: AgentChatMessage[][] = [];
  let turn = 0;
  await runAgentLoop({
    transport: async ({ messages }) => {
      seen.push(messages);
      turn += 1;
      return turn === 1
        ? { text: '', toolCalls: [{ id: 'c1', tool: 'read_file', args: { path: 'a.ts', maxBytes: 10 } }], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2 } }
        : { text: 'done', toolCalls: null, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2 } };
    },
    policyGate: () => ({ ok: true }),
    executeTool: async () => 'file text',
    decide: async () => 'approve',
    profile: 'workspace-full',
    provider: 'local',
    model: 'local-glimmer',
    threadId: 't',
    workspaceId: '/ws',
    goal: 'Read a.ts.',
  });
  const tail = (seen[1] ?? []).slice(-2);
  assert.equal(tail[0]?.role, 'assistant');
  assert.equal(tail[1]?.role, 'tool');
  assert.equal(tail[1]?.tool_call_id, 'c1');
});
