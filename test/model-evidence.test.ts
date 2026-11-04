/**
 * Model evidence, with simulated servers only (a scripted loopback model, a
 * stand-in llama-server that RAME launches for real, and a fake Meta API):
 * configured, running, and response observed stay distinct; each tool call
 * is linked to its inference, the host action by its real digest, and the
 * check the host ran afterwards; a passing command, the frozen acceptance,
 * and the Mission's completion are separate; nothing private is stored.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { MAX_AGENT_STEPS } from '../src/agentPolicy.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import {
  appendInference,
  beginEvidenceRun,
  buildEvidenceView,
  EMPTY_EVIDENCE_VIEW,
  loadModelEvidence,
  MAX_EVIDENCE_THREADS,
  MAX_INFERENCES_PER_THREAD,
  MAX_TOOL_CALLS_PER_INFERENCE,
  MODEL_EVIDENCE_KEY,
  sanitizeEvidenceView,
  type InferenceEvidence,
  type ModelEvidenceState,
  type ModelEvidenceView,
  type NewInference,
} from '../src/modelEvidence.js';
import { evidenceNow } from '../src/modelEvidenceRecorder.js';
import { buildViewHtml } from '../src/viewHtml.js';
import { assistantText, fakeCloud, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const API_KEY_SECRET = 'rameCode.metaModelApiKey';
const KEY = 'fake-meta-key-EVIDENCE-5e1f';
const SECRET = 'FILE-CONTENT-SECRET-7a91';
const GGUF = 'Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const GLIMMER_TEMPLATE = '{% set reasoning_strength = reasoning_strength | default("medium") %}Reasoning strength: {{ reasoning_strength }}';
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const evidenceOf = (state: PostedState): ModelEvidenceView => state.modelEvidence as ModelEvidenceView;
const all = (state: PostedState): InferenceEvidence[] => [...evidenceOf(state).decisive, ...evidenceOf(state).other].sort((a, b) => a.seq - b.seq);
const byId = (state: PostedState, id: string): InferenceEvidence => all(state).find((entry) => entry.inferenceId === id) as InferenceEvidence;
const stored = (h: HostHarness): string => JSON.stringify(h.memento.get(MODEL_EVIDENCE_KEY) ?? null);
const tool = (id: string, name: string, args: Record<string, unknown>, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => ({
  kind: 'json' as const,
  body: toolCallReply([{ id, name, args }], usage),
});
const text = (body: string) => ({ kind: 'json' as const, body: assistantText(body) });
const finished = (body: string) => ({
  kind: 'json' as const,
  body: { choices: [{ message: { role: 'assistant', content: body }, finish_reason: 'stop' }], usage: { prompt_tokens: 2427, completion_tokens: 98, total_tokens: 2525 } },
});

async function withHarness(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true, ...settings });
  fakeCloud.requests.length = 0;
  fakeCloud.handler = null;
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node t.js' } }));
    await h.writeFile('t.js', "require('node:assert').equal(require('node:fs').readFileSync('a.txt','utf8'), 'final');\n");
    await body(h);
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The webview's own formatter (media/evidenceUx.js) over the Spanish table, as in the real view. */
function loadFormatter(): (view: ModelEvidenceView, language: 'en' | 'es') => { now: string[]; mission: string[]; decisive: Array<{ lines: string[]; calls: string[][] }>; other: Array<{ lines: string[]; calls: string[][] }>; [key: string]: unknown } {
  type Helpers = { t(text: string): string; tf(text: string, ...values: unknown[]): string };
  const context = { window: {} as { RAME_EVIDENCE?: { format(view: unknown, language: string, t: unknown, tf: unknown): never; helpersFor(language: string): Helpers } } };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/evidenceUx.js', 'utf8'), context);
  const module = context.window.RAME_EVIDENCE;
  assert.ok(module);
  return (view, language) => {
    const helpers = module.helpersFor(language);
    return module.format(view, language, helpers.t, helpers.tf);
  };
}

const format = loadFormatter();
const flat = (view: ModelEvidenceView, language: 'en' | 'es' = 'en'): string => {
  const out = format(view, language);
  return [...out.now, ...out.mission, ...[...out.decisive, ...out.other].flatMap((entry) => [...entry.lines, ...entry.calls.flat()])].join('\n');
};

// ----- 1–5: configured, running, response observed, basename, external endpoint -----

test('configured is never "response observed": a stopped owned server and an unreachable endpoint record no response', async () => {
  const owned = { executablePath: '/opt/llama/llama-server', modelPath: `/home/someone/private-models/${GGUF}`, projectorPath: '/home/someone/mmproj.gguf', draftModelPath: '', modelId: 'local-glimmer', contextSize: 32768, port: 8775, idleTimeoutSec: 900 };
  await withHarness({ externalLocalEndpoint: '', local: owned }, async (h) => {
    await h.provider.refreshAll();
    const now = evidenceOf(h.last()).now;
    assert.deepEqual(now.local.configured, { kind: 'owned', model: GGUF, context: 32768, projector: true, draft: false });
    assert.equal(now.local.running, null, 'configured is not running');
    assert.equal(now.local.observed, false);
    await h.provider.sendMessage('Hi.', 'agent', 'local');
    assert.equal(evidenceOf(h.last()).total, 0, 'a stopped server sends nothing, so nothing is recorded');
    const lines = flat(evidenceOf(h.last()));
    assert.match(lines, /Configured: Muse-Glimmer-30B-KQuant-17GB-Q4_K_M\.gguf · context 32768 · mmproj yes · DFlash draft no/);
    assert.match(lines, /Running: no\nVerified response: none in this session/);
  });
  await withHarness({ externalLocalEndpoint: `http://127.0.0.1:${await freePort()}` }, async (h) => {
    await h.provider.sendMessage('Hi.', 'agent', 'local');
    const [entry] = all(h.last());
    assert.ok(entry);
    assert.equal(entry.response, 'failed');
    assert.equal(entry.failure, 'unreachable');
    assert.equal(entry.identity, 'configured', 'a saved endpoint that never answered is only configured');
    assert.equal(evidenceOf(h.last()).now.local.observed, false);
    assert.match(flat(evidenceOf(h.last())), /Identity: server\/model identity not verified · configured only · no response\n.*\nNo response: unreachable/);
  });
});

test('a RAME-launched llama-server: its -m basename, /props context and template, and a response observed — never a cryptographic claim', async (t) => {
  if (process.platform === 'win32') {
    t.skip('harness limitation: no fake llama-server.exe on Windows');
    return;
  }
  await withHarness({ externalLocalEndpoint: '' }, async (h) => {
    h.model.props = { default_generation_settings: { n_ctx: 32768 }, chat_template: GLIMMER_TEMPLATE };
    const executablePath = await h.writeFakeLlamaServer();
    await h.provider.startLocalRuntime({
      executablePath,
      modelPath: path.join(h.root, 'private-models', GGUF),
      projectorPath: path.join(h.root, 'private-models', 'mmproj.gguf'),
      draftModelPath: path.join(h.root, 'private-models', 'dflash-draft.gguf'),
      modelId: 'local-glimmer',
      contextSize: 32768,
      port: await freePort(),
      idleTimeoutSec: 900,
    });
    assert.equal((h.last().local as { lifecycle: string }).lifecycle, 'running');
    // Running: launched and owned by RAME, /props answered — still no response observed.
    const running = evidenceOf(h.last()).now;
    assert.deepEqual(running.local.running, { kind: 'rame-launched', contextConfirmed: 32768, template: 'muse-glimmer' });
    assert.equal(running.local.observed, false, 'running is not a response');
    const runningLines = flat(evidenceOf(h.last()));
    assert.match(runningLines, /Running: llama-server launched by RAME · loopback · context 32768 confirmed by \/props · Muse Glimmer template confirmed by \/props/);
    assert.match(runningLines, /Verified response: none in this session/);
    assert.match(runningLines, /the weights are not verified cryptographically/);
    assert.doesNotMatch(runningLines, /proved|weights (are|were) verified|verified weights/i);
    // A real inference makes it "response observed".
    h.model.enqueue(finished('Hello.'));
    await h.provider.sendMessage('Hi.', 'agent', 'local');
    const [entry] = all(h.last());
    assert.ok(entry);
    // The server facts are stored with the record too: RAME launched it, on loopback; this fake server writes no model id in its answer.
    assert.deepEqual(entry.runtime, {
      kind: 'rame-launched', model: GGUF, contextConfigured: 32768, contextConfirmed: 32768, template: 'muse-glimmer', projector: true, draft: true,
      server: { kind: 'rame-llama-server', basis: 'launched', scope: 'loopback', responded: null },
    });
    assert.equal(entry.identity, 'response-observed');
    assert.deepEqual(entry.usage, { input: 2427, output: 98 });
    assert.equal(entry.finish, 'stop');
    assert.equal(entry.response, 'text');
    assert.equal(entry.final, true);
    assert.equal(evidenceOf(h.last()).now.local.observed, true);
    const lines = flat(evidenceOf(h.last()));
    assert.match(lines, /Inference #1 · Agent\nProvider: local llama-server\nConfigured model: Muse-Glimmer-30B-KQuant-17GB-Q4_K_M\.gguf\nIdentity: RAME-launched process · response observed\nObserved usage: 2,427 input · 98 output tokens · finish: stop\nResponse: text — the reply kept in the conversation/);
    // Only the basename: never the directory it was launched from.
    for (const leak of [h.root, 'private-models', path.sep + GGUF]) {
      assert.equal(stored(h).includes(leak), false, leak);
      assert.equal(JSON.stringify(h.last().modelEvidence).includes(leak), false, leak);
    }
    await h.provider.stopLocalRuntime();
    assert.equal(evidenceOf(h.last()).now.local.running, null, 'stopped: no longer running');
  });
});

test('an external OpenAI-compatible endpoint stays "identity not verified", even after it answers', async () => {
  await withHarness({}, async (h) => {
    h.model.enqueue(text('Hello.'));
    await h.provider.sendMessage('Hi.', 'agent', 'local');
    const [entry] = all(h.last());
    assert.ok(entry);
    assert.equal(entry.runtime.kind, 'external-endpoint');
    assert.equal(entry.runtime.model, 'local-glimmer', 'the model id RAME requested, not a confirmed identity');
    assert.equal(entry.identity, 'response-observed');
    assert.equal(entry.finish, null, 'no finish_reason reported: none is invented');
    const lines = flat(evidenceOf(h.last()));
    assert.match(lines, /Provider: OpenAI-compatible loopback endpoint\nRequested model id: local-glimmer\nIdentity: server\/model identity not verified · response observed/);
    assert.match(lines, /Configured: external endpoint · requested model id local-glimmer/);
    assert.doesNotMatch(lines, /llama-server launched by RAME|Provider: local llama-server/);
  });
});

test('"running" means a process RAME launched and owns that is running, not one still starting or another one', () => {
  const host = (localLaunch: unknown) =>
    ({
      settings: { externalLocalEndpoint: '', local: { modelPath: `/x/${GGUF}`, contextSize: 32768, projectorPath: '', draftModelPath: '', modelId: 'local-glimmer' } },
      localEndpoint: () => 'http://127.0.0.1:8775',
      localLaunch,
      localProps: null,
      localConfirmed: null,
      modelEvidence: { observed: { local: false, cloud: false } },
      selectedCloudModel: () => 'muse-spark-1.3',
      hasKey: false,
    }) as never;
  const launch = { endpoint: 'http://127.0.0.1:8775', model: GGUF, contextSize: 32768, projector: false, draft: false };
  assert.equal(evidenceNow(host(launch), 'running', true).local.running?.kind, 'rame-launched');
  assert.equal(evidenceNow(host(launch), 'starting', true).local.running, null, 'starting is not running');
  assert.equal(evidenceNow(host(launch), 'running', false).local.running, null, 'not owned: not launched by this RAME');
  assert.equal(evidenceNow(host(null), 'running', true).local.running, null, 'no launch arguments known');
  assert.equal(evidenceNow(host({ ...launch, endpoint: 'http://127.0.0.1:9999' }), 'running', true).local.running, null, 'another endpoint');
});

// ----- 6–8: tool call, approval and action, verification afterwards -----

test('each tool call is linked to its inference, and the host action to its real Activity digest and approval', async () => {
  await withHarness({ agentProfile: 'ask' }, async (h) => {
    await h.writeFile('a.txt', 'draft');
    h.model.enqueue(
      tool('c1', 'read_file', { path: 'a.txt', maxBytes: 4096 }),
      tool('c2', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: sha('draft'), newContent: 'final' }] }),
      text('Done.'),
    );
    const run = h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
    const cards: Array<{ actionId: string; digest: string; tool: string }> = [];
    for (let index = 0; index < 2; index++) {
      const state = await h.waitFor((s) => s.agentPending !== null && !cards.some((card) => card.actionId === s.agentPending?.actionId));
      const pending = state.agentPending as NonNullable<PostedState['agentPending']>;
      cards.push(pending);
      await h.provider.approveAgentAction(pending.actionId, pending.digest);
    }
    await run;
    const read = byId(h.last(), 'inf-1');
    const patch = byId(h.last(), 'inf-2');
    assert.deepEqual(read.toolCalls.map((call) => [call.n, call.callId, call.tool]), [[1, 'c1', 'read_file']]);
    assert.deepEqual(patch.toolCalls.map((call) => [call.n, call.callId, call.tool]), [[1, 'c2', 'apply_patch']]);
    assert.equal(patch.response, 'tool-calls');
    // The digest is the one on the approval card and in Activity: a real host id.
    assert.equal(patch.toolCalls[0]?.action?.digest, cards[1]?.digest);
    const audit = h.memento.get('rameCode.agentAudit.v1') as Array<{ digest: string; tool: string; decision: string }>;
    assert.ok(audit.some((entry) => entry.digest === cards[1]?.digest && entry.tool === 'apply_patch' && entry.decision === 'human'));
    assert.deepEqual({ ...patch.toolCalls[0]?.action, digest: null }, { digest: null, approval: 'human', result: 'applied', write: true, commandId: null, exitCode: null });
    assert.equal(read.toolCalls[0]?.action?.approval, 'human');
    assert.equal(byId(h.last(), 'inf-3').final, true);
    const lines = flat(evidenceOf(h.last()));
    assert.match(lines, new RegExp(`Tool call 1: apply_patch\\nHost action: approved by you and applied · digest ${cards[1]?.digest.slice(0, 12)}…\\nNo linked verification recorded`));
  });
});

test('a rejected or policy-blocked proposal is linked as such, and nothing is shown as applied', async () => {
  await withHarness({ agentProfile: 'ask' }, async (h) => {
    h.model.enqueue(
      tool('bad', 'read_file', { path: '/etc/passwd', maxBytes: 10 }),
      tool('w', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: 'x' }] }),
    );
    const run = h.provider.sendMessage('Write a.txt.', 'agent', 'local');
    const state = await h.waitFor((s) => s.agentPending?.tool === 'apply_patch');
    const pending = state.agentPending as NonNullable<PostedState['agentPending']>;
    await h.provider.rejectAgentAction(pending.actionId, pending.digest);
    await run;
    assert.equal(byId(h.last(), 'inf-1').toolCalls[0]?.action?.result, 'blocked-by-policy');
    assert.deepEqual(byId(h.last(), 'inf-2').toolCalls[0]?.action, { digest: null, approval: 'human', result: 'rejected-by-user', write: true, commandId: null, exitCode: null });
    const lines = flat(evidenceOf(h.last()));
    assert.match(lines, /Host action: blocked by host policy; nothing ran/);
    assert.match(lines, /Host action: rejected by you; nothing ran/);
    assert.doesNotMatch(lines, /and applied/);
  });
});

test('the check the host ran afterwards is linked to the change it followed, in the same run', async () => {
  await withHarness({ agentProfile: 'workspace-full' }, async (h) => {
    h.model.enqueue(
      tool('w1', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: 'draft' }] }),
      tool('t1', 'run_tests', { commandId: 'npm:test' }),
      tool('w2', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: sha('draft'), newContent: 'final' }] }),
      tool('t2', 'run_tests', { commandId: 'npm:test' }),
      text('Done.'),
    );
    await h.provider.sendMessage('Write final into a.txt and run the test.', 'agent', 'local');
    const state = h.last();
    assert.deepEqual(byId(state, 'inf-1').toolCalls[0]?.verification, { inferenceId: 'inf-2', n: 1, commandId: 'npm:test', exitCode: 1 });
    assert.deepEqual(byId(state, 'inf-3').toolCalls[0]?.verification, { inferenceId: 'inf-4', n: 1, commandId: 'npm:test', exitCode: 0 });
    assert.equal(byId(state, 'inf-2').toolCalls[0]?.action?.approval, 'profile');
    assert.equal(byId(state, 'inf-4').toolCalls[0]?.action?.exitCode, 0);
    const lines = flat(evidenceOf(state));
    assert.match(lines, /Tool call 1: apply_patch\nHost action: allowed by the permission profile and applied · digest [0-9a-f]{12}…\nChecked afterwards in this run: npm:test exit=1 \(inference #2\)/);
    assert.match(lines, /Checked afterwards in this run: npm:test exit=0 \(inference #4\)/);
    assert.match(lines, /Tool call 1: run_tests\nHost action: allowed by the permission profile and ran · npm:test exit=0 · digest/);
    // A change is linked only to a check of its own run: not to one an earlier or a later run ran.
    h.model.enqueue(tool('w3', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: sha('final'), newContent: 'final!' }] }), text('Changed.'));
    await h.provider.sendMessage('Add an exclamation mark.', 'agent', 'local');
    h.model.enqueue(tool('t3', 'run_tests', { commandId: 'npm:test' }), text('Tested.'));
    await h.provider.sendMessage('Run the test.', 'agent', 'local');
    const later = all(h.last()).find((entry) => entry.toolCalls[0]?.callId === 'w3');
    assert.equal(later?.toolCalls[0]?.verification, null);
    assert.match(flat(evidenceOf(h.last())), /Tool call 1: apply_patch\nHost action: allowed by the permission profile and applied · digest [0-9a-f]{12}…\nNo linked verification recorded/);
  });
});

// ----- 9–10: command passed, frozen acceptance, Mission completed -----

const ONE_TASK = { goal: 'Make the check pass.', assumptions: [], steps: [{ id: 't1', title: 'Write a.txt', successCriterion: 'npm:test passes' }], risks: [] };

async function createMission(h: HostHarness): Promise<MissionRecord> {
  h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: ONE_TASK }]) });
  await h.provider.sendMessage('Make the check pass by writing final into a.txt.', 'mission', 'local');
  return (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;
}

const missionRecord = (h: HostHarness): MissionRecord => (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;

test('a passing command does not mark the Mission completed: the frozen acceptance and the host decide', async () => {
  await withHarness({ mode: 'mission' }, async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node t.js', check: 'node acceptance/accept.js' } }));
    await h.writeFile('t.js', "require('node:fs').statSync('a.txt');\n");
    await h.writeFile('acceptance/accept.js', "require('node:assert').equal(require('node:fs').readFileSync('a.txt', 'utf8'), 'final');\n");
    const mission = await createMission(h);
    h.model.enqueue(
      tool('w1', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: 'draft' }] }),
      tool('t1', 'run_tests', { commandId: 'npm:test' }),
      text('Done, npm:test passes.'),
    );
    const run = h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/accept.js'] });
    // After the first internal run: the agent's test passed, the host's acceptance failed.
    await h.waitFor(() => /acceptance \(run by the host\): npm:check exit=1/.test(missionRecord(h).evidence.map((entry) => entry.text).join('\n')));
    await h.provider.stopMission(mission.id, 'pause');
    await run;
    await h.provider.refreshAll();
    const view = evidenceOf(h.last());
    assert.ok(view.mission);
    assert.deepEqual(view.mission.lastCommand, { commandId: 'npm:test', exitCode: 0 });
    assert.equal(view.mission.acceptance, 'failed');
    assert.equal(view.mission.completedByHost, false);
    const lines = flat(view);
    assert.match(lines, /Command passed: npm:test exit=0\nFrozen acceptance failed: npm:check\nMission not completed by host\nA passing command alone does not mean the goal was met\./);
    assert.doesNotMatch(lines, /Mission completed by host/);
    const step = all(h.last()).find((entry) => entry.toolCalls[0]?.callId === 't1');
    assert.deepEqual(step?.mission, { missionId: mission.id, run: 1, step: 2 });
    assert.equal(step?.mode, 'mission');
  });
});

test('frozen acceptance passed and Mission completed by host are shown separately; a Standard Mission says it has no frozen check', async () => {
  await withHarness({ mode: 'mission' }, async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node t.js', check: 'node acceptance/accept.js' } }));
    await h.writeFile('acceptance/accept.js', "require('node:assert').equal(require('node:fs').readFileSync('a.txt', 'utf8'), 'final');\n");
    const mission = await createMission(h);
    h.model.enqueue(tool('w1', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: 'final' }] }), tool('t1', 'run_tests', { commandId: 'npm:test' }), text('Done.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/accept.js'] });
    assert.equal(missionRecord(h).status, 'completed', missionRecord(h).note);
    const view = evidenceOf(h.last());
    assert.equal(view.mission?.acceptance, 'passed');
    assert.equal(view.mission?.completedByHost, true);
    assert.match(flat(view), /Command passed: npm:test exit=0\nFrozen acceptance passed: npm:check\nMission completed by host/);
    const report = (h.last().turns.at(-1) as { hostRecord: string[] }).hostRecord.join('\n');
    assert.match(report, /mission: model evidence — local local-glimmer|mission: model evidence — endpoint local-glimmer; \d+ local inference\(s\), \d+ with a response observed; 0 Meta consultation\(s\)/);
    assert.match(report, /mission: 2\/2 proposed tool call\(s\) linked to a host action; checks the host ran: npm:test exit=0/);
    // 13: a reload restores the same evidence and repeats nothing.
    const before = { evidence: stored(h), requests: h.model.requests.length, file: await h.readFile('a.txt'), audit: JSON.stringify(h.memento.get('rameCode.agentAudit.v1')) };
    const view1 = JSON.stringify(view);
    h.createProvider();
    h.send({ type: 'openThread', threadId: mission.threadId });
    await h.waitFor((state) => state.activeThreadId === mission.threadId);
    const records = (v: ModelEvidenceView) => JSON.stringify({ decisive: v.decisive, other: v.other, total: v.total, mission: v.mission });
    assert.equal(records(evidenceOf(h.last())), records(JSON.parse(view1) as ModelEvidenceView), 'the same records after a reload');
    assert.equal(evidenceOf(h.last()).now.local.observed, false, '"in this session" starts over: an old record is not a new response');
    assert.equal(evidenceOf(h.last()).now.local.running, null);
    assert.equal(stored(h), before.evidence);
    assert.equal(h.model.requests.length, before.requests, 'nothing was sent again');
    assert.equal(await h.readFile('a.txt'), before.file);
    assert.equal(JSON.stringify(h.memento.get('rameCode.agentAudit.v1')), before.audit, 'no action was repeated');
  });
  await withHarness({ mode: 'mission' }, async (h) => {
    const mission = await createMission(h);
    h.model.enqueue(tool('w1', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: 'final' }] }), tool('t1', 'run_tests', { commandId: 'npm:test' }), text('Done.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    assert.equal(missionRecord(h).status, 'completed', missionRecord(h).note);
    assert.match(flat(evidenceOf(h.last())), /Command passed: npm:test exit=0\nNo frozen acceptance check\nMission completed by host/);
  });
});

// ----- 11–12: Advisory, Delegated, and a Meta failure -----

const ADVICE = { diagnosis: 'a.txt must say final.', steps: ['Write final into a.txt.'], checks: ['npm:test passes.'] };
const adviceReply = () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(ADVICE) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } });

test('Advisory: Meta answered with no tools and Glimmer kept the tools; a Meta failure is never a response observed', async () => {
  for (const handler of [adviceReply, () => Response.json({ error: { message: `quota exceeded for ${KEY}` } }, { status: 402 })]) {
    await withHarness({}, async (h) => {
      h.secretValues.set(API_KEY_SECRET, KEY);
      h.model.enqueue(tool('t0', 'run_tests', { commandId: 'npm:test' }));
      for (let step = 1; step < MAX_AGENT_STEPS; step++) {
        h.model.enqueue(tool(`s${step}`, 'read_file', { path: 't.js', maxBytes: 4096 }));
      }
      const run = h.provider.sendMessage('Write final into a.txt and make the test pass.', 'agent', 'local');
      const card = await h.waitFor((state) => state.agentPending?.tool === 'run_tests');
      await h.provider.approveAgentAction(card.agentPending!.actionId, card.agentPending!.digest);
      await run;
      const offer = h.last().consult as { digest: string };
      fakeCloud.handler = handler;
      h.model.enqueue(text('Glimmer looked at the hints.'));
      await h.provider.approveConsult(offer.digest);
      const meta = all(h.last()).filter((entry) => entry.provider === 'cloud');
      assert.equal(meta.length, 1);
      const entry = meta[0] as InferenceEvidence;
      assert.equal(entry.authority, 'advisory');
      assert.equal(entry.request, 'advisory');
      assert.deepEqual(entry.toolCalls, [], 'Spark gets no tools');
      assert.equal(entry.runtime.kind, 'meta-api');
      assert.equal(entry.runtime.model, 'muse-spark-1.3');
      if (handler === adviceReply) {
        assert.equal(entry.identity, 'response-observed');
        assert.deepEqual(entry.usage, { input: 50, output: 10 });
        assert.match(flat(evidenceOf(h.last())), /Provider: Meta Model API\nModel: muse-spark-1\.3\nAuthority: Advisory — Glimmer retained tool control\nResponse observed: yes\nObserved usage: 50 input · 10 output tokens/);
        assert.equal(evidenceOf(h.last()).now.cloud.observed, true);
      } else {
        assert.equal(entry.response, 'failed');
        assert.equal(entry.failure, 'credit');
        assert.notEqual(entry.identity, 'response-observed');
        assert.equal(entry.usage, null);
        assert.match(flat(evidenceOf(h.last())), /Authority: Advisory — Glimmer retained tool control\nResponse observed: no\nObserved usage: not reported\nNo response: credit/);
        assert.equal(evidenceOf(h.last()).now.cloud.observed, false, 'a failure is not an answer');
      }
      assert.equal(stored(h).includes(KEY), false);
      assert.equal(stored(h).includes('quota exceeded'), false, 'only the category is kept');
    });
  }
});

test('Delegated: Spark proposed the tool, RAME applied the existing profile; a later Meta failure is recorded as a failure', async () => {
  await withHarness({ agentProfile: 'workspace-full' }, async (h) => {
    h.secretValues.set(API_KEY_SECRET, KEY);
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { message: 'boom' } } });
    await h.provider.sendMessage('Write final into a.txt.', 'agent', 'local');
    const offer = (h.last().remote as { delegation: { digest: string } | null }).delegation;
    assert.ok(offer);
    let call = 0;
    fakeCloud.handler = () => {
      call += 1;
      return call === 1
        ? Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: 'draft' }] }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 } })
        : Response.json({ error: { message: 'You exceeded your current quota' } }, { status: 429 });
    };
    await h.provider.approveEscalation(offer.digest);
    const meta = all(h.last()).filter((entry) => entry.provider === 'cloud');
    assert.equal(meta.length, 2);
    const [proposed, failed] = meta as [InferenceEvidence, InferenceEvidence];
    assert.equal(proposed.authority, 'delegated');
    assert.equal(proposed.identity, 'response-observed');
    assert.equal(proposed.finish, 'tool_calls');
    assert.deepEqual(proposed.toolCalls[0]?.action && { ...proposed.toolCalls[0].action, digest: null }, { digest: null, approval: 'profile', result: 'applied', write: true, commandId: null, exitCode: null });
    assert.equal(failed.authority, 'delegated');
    assert.equal(failed.response, 'failed');
    assert.equal(failed.failure, 'credit');
    assert.equal(failed.identity, 'configured', 'a stored key that failed is not a response observed');
    const lines = flat(evidenceOf(h.last()));
    assert.match(lines, /Authority: Delegated — Spark proposed tools; RAME applied the existing permission profile\nResponse observed: yes/);
    assert.match(lines, /Authority: Delegated — Spark proposed tools; RAME applied the existing permission profile\nResponse observed: no\nObserved usage: not reported\nNo response: credit/);
    // The local failure before it is a sanitized failure too, never a response.
    const local = all(h.last()).find((entry) => entry.provider === 'local');
    assert.equal(local?.response, 'failed');
    assert.equal(local?.failure, 'local-error');
    assert.equal(stored(h).includes(KEY), false);
  });
});

// ----- 13–16: persistence, corruption, limits, privacy -----

test('a Mission with an Advisory consultation keeps its Advisory evidence in Mission mode, across a reload', async () => {
  await withHarness({ mode: 'mission', agentProfile: 'safe-auto' }, async (h) => {
    h.secretValues.set(API_KEY_SECRET, KEY);
    await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { test: 'node t.js', check: 'node c.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await h.writeFile('c.js', "process.exit(require('node:fs').existsSync('a.txt') && require('node:fs').readFileSync('a.txt', 'utf8') === 'final' ? 0 : 1);\n");
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: { goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'Fix a.txt', successCriterion: 'npm:check passes' }], risks: [] } }]) });
    await h.provider.sendMessage('Make npm:check pass.', 'mission', 'local');
    const mission = missionRecord(h);
    fakeCloud.handler = adviceReply;
    h.model.enqueue(tool('c1', 'run_tests', { commandId: 'npm:check' }));
    for (let step = 1; step < MAX_AGENT_STEPS; step++) {
      h.model.enqueue(tool(`r${step}`, 'read_file', { path: 'c.js', maxBytes: 4096 }));
    }
    h.model.enqueue(tool('w', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: 'final' }] }), tool('c2', 'run_tests', { commandId: 'npm:check' }), text('Done.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 1 }, true);
    assert.equal(missionRecord(h).status, 'completed', missionRecord(h).note);
    const advisory = all(h.last()).filter((entry) => entry.authority === 'advisory');
    assert.equal(advisory.length, 1);
    assert.equal(advisory[0]?.mode, 'mission');
    assert.equal(advisory[0]?.mission?.missionId, mission.id);
    assert.ok(evidenceOf(h.last()).decisive.some((entry) => entry.authority === 'advisory'), 'Advisory is always decisive');
    const report = (h.last().turns.at(-1) as { hostRecord: string[] }).hostRecord.join('\n');
    assert.match(report, /1 Meta consultation\(s\) \(1 answered\)/);
    const before = stored(h);
    const requests = { local: h.model.requests.length, cloud: fakeCloud.requests.length };
    h.createProvider();
    await h.provider.refreshAll();
    assert.equal(stored(h), before);
    assert.deepEqual({ local: h.model.requests.length, cloud: fakeCloud.requests.length }, requests, 'restoring evidence sends nothing');
    h.send({ type: 'openThread', threadId: mission.threadId });
    await h.waitFor((state) => state.activeThreadId === mission.threadId);
    assert.equal(all(h.last()).filter((entry) => entry.authority === 'advisory').length, 1);
  });
});

function sample(overrides: Partial<NewInference> = {}): NewInference {
  return {
    run: 1,
    provider: 'local',
    runtime: { kind: 'external-endpoint', model: 'local-glimmer', contextConfigured: null, contextConfirmed: null, template: 'unknown', projector: false, draft: false },
    identity: 'response-observed',
    authority: 'local',
    mode: 'agent',
    mission: null,
    request: 'agent-step',
    response: 'tool-calls',
    failure: null,
    usage: { input: 10, output: 2 },
    finish: 'tool_calls',
    toolCalls: [{ callId: 'c1', tool: 'read_file' }],
    ...overrides,
  };
}

test('stored evidence that is corrupt, of another version, or carries extra fields fails closed: dropped whole, never rebuilt', async () => {
  const state: ModelEvidenceState = { version: 1, threads: [] };
  appendInference(state, 't-good', sample(), 1000);
  const good = structuredClone(state.threads[0]);
  const variants: Array<[string, (thread: Record<string, unknown>) => void]> = [
    ['an extra field (a prompt)', (thread) => ((thread.inferences as Array<Record<string, unknown>>)[0]!.prompt = 'You are RAME Code')],
    ['a failure shown as a response observed', (thread) => Object.assign((thread.inferences as Array<Record<string, unknown>>)[0]!, { response: 'failed', failure: 'network', toolCalls: [] })],
    ['an absolute path as the model', (thread) => (((thread.inferences as Array<Record<string, unknown>>)[0]!.runtime as Record<string, unknown>).model = '/home/someone/model.gguf')],
    ['a non-hex digest', (thread) => (((thread.inferences as Array<Record<string, unknown>>)[0]!.toolCalls as Array<Record<string, unknown>>)[0]!.action = { digest: 'zz', approval: 'human', result: 'applied', write: false, commandId: null, exitCode: null })],
    ['Meta on a local runtime', (thread) => ((thread.inferences as Array<Record<string, unknown>>)[0]!.provider = 'cloud')],
    ['too many inferences', (thread) => ((thread.inferences as unknown[]).push(...Array.from({ length: MAX_INFERENCES_PER_THREAD }, () => (thread.inferences as unknown[])[0])))],
  ];
  for (const [label, corrupt] of variants) {
    const bad = structuredClone(good) as unknown as Record<string, unknown>;
    bad.threadId = 't-bad';
    corrupt(bad);
    const loaded = loadModelEvidence({ version: 1, threads: [good, bad] });
    assert.deepEqual(loaded.state.threads.map((thread) => thread.threadId), ['t-good'], label);
    assert.equal(loaded.discarded, 1, label);
  }
  for (const raw of [{ version: 2, threads: [good] }, { threads: [good] }, 'garbage', [good], { version: 1, threads: 'x' }]) {
    const loaded = loadModelEvidence(raw);
    assert.deepEqual(loaded.state, { version: 1, threads: [] }, JSON.stringify(raw).slice(0, 40));
    assert.equal(loaded.discarded, 1);
  }
  assert.deepEqual(loadModelEvidence(undefined), { state: { version: 1, threads: [] }, discarded: 0 }, 'an older state without evidence is simply empty');
  // In the extension: it loads, says so, and works on.
  await withHarness({}, async (h) => {
    h.memento.set(MODEL_EVIDENCE_KEY, { version: 1, threads: [{ ...good, inferences: [{ ...good?.inferences[0], identity: 'running' }] }] });
    h.createProvider();
    await h.provider.refreshAll();
    assert.equal(evidenceOf(h.last()).discarded, true);
    assert.match(format(evidenceOf(h.last()), 'en').discarded as string, /unreadable and was discarded; nothing was rebuilt or rerun/);
    h.model.enqueue(text('Hello.'));
    await h.provider.sendMessage('Hi.', 'agent', 'local');
    assert.equal(all(h.last()).length, 1);
    assert.equal((h.memento.get(MODEL_EVIDENCE_KEY) as ModelEvidenceState).threads.length, 1, 'the unreadable thread is gone, the new one is stored');
  });
  // The webview boundary re-validates too: an invalid entry is dropped, not repaired.
  const posted = sanitizeEvidenceView({ ...EMPTY_EVIDENCE_VIEW, decisive: [good?.inferences[0], { ...good?.inferences[0], usage: { input: -1, output: 0 } }] });
  assert.equal(posted.decisive.length, 1);
});

test('limits: inferences per thread (exploratory ones go first), threads, tool calls, model names, and what the view shows', () => {
  const state: ModelEvidenceState = { version: 1, threads: [] };
  const run = beginEvidenceRun(state, 't-1', 1);
  const decisive = appendInference(state, 't-1', sample({ run, toolCalls: [{ callId: 'w', tool: 'apply_patch' }] }), 2);
  for (let index = 0; index < MAX_INFERENCES_PER_THREAD + 20; index++) {
    appendInference(state, 't-1', sample({ run }), 3 + index);
  }
  const thread = state.threads[0]!;
  assert.equal(thread.inferences.length, MAX_INFERENCES_PER_THREAD);
  assert.ok(thread.inferences.some((entry) => entry.inferenceId === decisive), 'the decisive entry outlives exploratory ones');
  assert.equal(thread.inferences.at(-1)?.seq, MAX_INFERENCES_PER_THREAD + 21, 'ids keep counting; none is reused');
  const view = buildEvidenceView(state, 't-1', EMPTY_EVIDENCE_VIEW.now, null, false);
  assert.equal(view.decisive.length, 1);
  assert.equal(view.other.length, 12);
  assert.equal(view.otherHidden, MAX_INFERENCES_PER_THREAD - 1 - 12);
  assert.match(format(view, 'en').hidden as string, /older exploratory inference\(s\) not shown/);
  for (let index = 0; index < MAX_EVIDENCE_THREADS + 5; index++) {
    appendInference(state, `t-x${index}`, sample(), 100 + index);
  }
  assert.equal(state.threads.length, MAX_EVIDENCE_THREADS);
  const many = appendInference(state, 't-many', sample({ toolCalls: Array.from({ length: 20 }, (_, index) => ({ callId: `c${index}`, tool: 'read_file' })) }), 500);
  assert.equal(state.threads.find((entry) => entry.threadId === 't-many')?.inferences.find((entry) => entry.inferenceId === many)?.toolCalls.length, MAX_TOOL_CALLS_PER_INFERENCE);
  const long = 'M'.repeat(300) + '.gguf';
  appendInference(state, 't-long', sample({ runtime: { ...sample().runtime, model: `/very/private/${long}` } }), 600);
  const model = state.threads.find((entry) => entry.threadId === 't-long')?.inferences[0]?.runtime.model ?? '';
  assert.equal(model.length, 96);
  assert.equal(model.includes('private'), false);
  // An unsafe protocol id is not kept; the host's position still links the call.
  appendInference(state, 't-ids', sample({ toolCalls: [{ callId: 'call <script>', tool: 'read_file' }] }), 700);
  assert.deepEqual(state.threads.find((entry) => entry.threadId === 't-ids')?.inferences[0]?.toolCalls[0], { n: 1, callId: null, tool: 'read_file', action: null, verification: null });
  assert.equal(loadModelEvidence(JSON.parse(JSON.stringify(state))).discarded, 0, 'whatever is written loads back');
});

test('nothing private is stored: no key, absolute path, system prompt, reasoning, reply text, or file content', async () => {
  await withHarness({ agentProfile: 'workspace-full' }, async (h) => {
    h.secretValues.set(API_KEY_SECRET, KEY);
    await h.writeFile('notes.txt', `${SECRET}\n`);
    h.model.enqueue(
      { kind: 'json', body: { choices: [{ message: { role: 'assistant', content: 'THINKING-OUT-LOUD', reasoning_content: 'REASONING-TRACE-MARKER', tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt', maxBytes: 4096 }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } } },
      tool('w1', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: `copied ${SECRET}` }] }),
      text(`REPLY-TEXT-MARKER ${SECRET}`),
    );
    await h.provider.sendMessage(`USER-PROMPT-MARKER ${SECRET}`, 'agent', 'local');
    h.model.enqueue(text('CHAT-REPLY-MARKER'));
    await h.provider.sendMessage('CHAT-PROMPT-MARKER', 'chat', 'local');
    assert.ok(all(h.last()).length >= 4);
    assert.ok(all(h.last()).some((entry) => entry.mode === 'chat' && entry.request === 'chat' && entry.final));
    const persisted = stored(h);
    const posted = JSON.stringify(h.last().modelEvidence);
    for (const leak of [KEY, SECRET, h.root, h.workspace, 'You are RAME Code', 'THINKING-OUT-LOUD', 'REASONING-TRACE-MARKER', 'REPLY-TEXT-MARKER', 'USER-PROMPT-MARKER', 'CHAT-REPLY-MARKER', 'CHAT-PROMPT-MARKER', 'notes.txt', 'a.txt', 'Bearer']) {
      assert.equal(persisted.includes(leak), false, `stored: ${leak}`);
      assert.equal(posted.includes(leak), false, `posted: ${leak}`);
    }
  });
});

// ----- 17–18: English and Spanish; narrow panels -----

test('English and Spanish: every line of the evidence is translated, and values stay as recorded', async () => {
  await withHarness({ agentProfile: 'workspace-full' }, async (h) => {
    h.model.enqueue(
      tool('w1', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: EMPTY, newContent: 'final' }] }, { prompt_tokens: 2427, completion_tokens: 98, total_tokens: 2525 }),
      tool('t1', 'run_tests', { commandId: 'npm:test' }),
      text('Done.'),
    );
    await h.provider.sendMessage('Write final into a.txt and run the test.', 'agent', 'local');
    const view = evidenceOf(h.last());
    const en = format(view, 'en');
    const es = format(view, 'es');
    const lines = (out: typeof en) => [...out.now, ...[...out.decisive, ...out.other].flatMap((entry) => [...entry.lines, ...entry.calls.flat()])];
    const enLines = lines(en);
    const esLines = lines(es);
    assert.equal(esLines.length, enLines.length);
    enLines.forEach((line, index) => {
      if (!/^Tool call|^Inference/.test(line) || index === 0) {
        assert.notEqual(esLines[index], line, `untranslated: ${line}`);
      }
    });
    const joined = esLines.join('\n');
    assert.match(joined, /Proveedor: endpoint loopback compatible con OpenAI\nId de modelo solicitado: local-glimmer\nIdentidad: identidad del servidor\/modelo no verificada · respuesta observada/);
    assert.match(joined, /Uso observado: 2427 tokens de entrada · 98 de salida/);
    assert.match(joined, /Acción del host: permitida por el perfil de permisos y aplicada · digest [0-9a-f]{12}…\nComprobado después en esta ejecución: npm:test exit=0 \(inferencia n\.º 2\)/);
    assert.match(joined, /Respuesta: texto — la respuesta que queda en la conversación/);
    const mission = format({ ...view, mission: { status: 'completed', completedByHost: true, acceptance: 'none', acceptanceCommand: null, lastCommand: { commandId: 'npm:test', exitCode: 0 } } }, 'es').mission;
    assert.deepEqual(JSON.parse(JSON.stringify(mission)), ['Misión: completada', 'Comando superado: npm:test exit=0', 'Sin comprobación de aceptación congelada', 'Misión completada por el host', 'Un comando superado no significa por sí solo que se cumpliera el objetivo.']);
  });
});

test('the block lives inside Run details, starts folded, and wraps long names instead of scrolling sideways', () => {
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js', evidenceUxUri: 'evidenceUx.js' });
  const runDetails = html.slice(html.indexOf('<details id="runDetails">'), html.indexOf('</details>\n    </div>'));
  assert.match(runDetails, /<details id="modelEvidence">\s*<summary>Model evidence — recorded by RAME Code<\/summary>/, 'folded: no "open" attribute');
  assert.match(runDetails, /<details id="modelEvidenceOther" hidden>/, 'exploratory inferences one level further down');
  assert.match(html, /#modelEvidence p, #modelEvidence li \{ margin: 2px 0; overflow-wrap: anywhere; \}/);
  assert.ok(html.indexOf('src="i18n.js"') < html.indexOf('src="evidenceUx.js"') && html.indexOf('src="evidenceUx.js"') < html.indexOf('src="main.js"'));
  const source = readFileSync('media/evidenceUx.js', 'utf8');
  assert.equal(/innerHTML|insertAdjacentHTML|outerHTML/.test(source), false, 'text only');
});
