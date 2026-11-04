/**
 * Local model identity and evidence levels (localIdentity.ts, artifactHash.ts,
 * localIdentityHost.ts, evidenceUx.js). Simulated servers and temporary files
 * only. What a server says is labelled as its claim; the only cryptographic
 * check is the SHA-256 RAME computes of the GGUF it launches.
 *
 * Human validation of the candidate: LM Studio on another computer of the LAN
 * was shown as "OpenAI-compatible loopback endpoint", and the -m / GGUF note
 * appeared although RAME launched no llama-server.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ArtifactReadError, artifactStillMatches, hashArtifact, type ArtifactFs } from '../src/artifactHash.js';
import { endpointLabel, evidenceServer, fileNameOnly, isEvidenceServer, probeLocalIdentity, requestedLocalModel, sanitizeIdentityView } from '../src/localIdentity.js';
import type { FetchLike } from '../src/localServers.js';
import { isValidInference, type InferenceEvidence, type ModelEvidenceView } from '../src/modelEvidence.js';
import { assistantText, HostHarness, type PostedState } from './helpers/hostHarness.js';

/** A fake server: path → JSON body (or a status). Records every request. */
function server(routes: Record<string, unknown>, seen: string[] = []): FetchLike {
  return (async (url: string, init?: { method?: string; body?: string }) => {
    const pathname = new URL(url).pathname;
    seen.push(`${init?.method ?? 'GET'} ${pathname}${init?.body ? ` ${init.body}` : ''}`);
    const body = routes[pathname];
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => '' };
    }
    if (typeof body === 'number') {
      return { ok: false, status: body, text: async () => '' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  }) as unknown as FetchLike;
}

const LAN = 'http://192.168.1.158:1235';
const LOOP = 'http://127.0.0.1:11434';
const DIGEST = 'a'.repeat(64);

test('LM Studio on another computer of the LAN: private network (never "loopback"), requested vs loaded model kept apart, no digest', async () => {
  const seen: string[] = [];
  const lm = server({
    '/api/v1/models': {
      models: [
        { type: 'llm', key: 'muse-glimmer', display_name: 'Muse Glimmer 30B', architecture: 'qwen3moe', quantization: { name: 'Q4_K_M', bits_per_weight: 4 }, size_bytes: 17_000_000_000, params_string: '30B-A3B', format: 'gguf', max_context_length: 262144, loaded_instances: [{ id: 'muse-glimmer', config: { context_length: 32768 } }], capabilities: { vision: true, trained_for_tool_use: true } },
      ],
    },
  }, seen);
  const result = await probeLocalIdentity({ endpoint: LAN, requestedModel: 'muse-glimmer', declaredKind: 'lmstudio', launchedByRame: false }, lm, 1000, () => 1);
  assert.ok(result.ok);
  const id = result.identity;
  assert.equal(id.kind, 'lmstudio');
  assert.equal(id.basis, 'detected');
  assert.equal(id.scope, 'private-network');
  assert.equal(id.endpointLabel, 'private network, port 1235', 'never the address');
  assert.equal(id.requestedModel, 'muse-glimmer');
  assert.equal(id.servedModel, 'muse-glimmer');
  assert.equal(id.listed, true);
  assert.equal(id.quantization, 'Q4_K_M');
  assert.equal(id.contextReported, 32768);
  assert.equal(id.contextTrained, 262144);
  assert.deepEqual(id.capabilities, ['vision', 'tools']);
  assert.equal(id.announcedDigest, null, 'LM Studio announces no digest: none is made up');
  assert.equal(id.serverVersion, null, 'no documented version endpoint: unknown');
  assert.ok(seen.every((line) => line.startsWith('GET ') || line.startsWith('POST /api/show')), 'metadata requests only');
  assert.doesNotMatch(JSON.stringify(id), /192\.168/);
});

test('a requested id the server does not list is said so; a loaded model is not taken for the requested one', async () => {
  const lm = server({ '/api/v1/models': { models: [{ type: 'llm', key: 'qwen3-8b', loaded_instances: [{ id: 'qwen3-8b', config: { context_length: 8192 } }] }] } });
  const result = await probeLocalIdentity({ endpoint: LAN, requestedModel: 'local-glimmer', declaredKind: 'lmstudio', launchedByRame: false }, lm);
  assert.ok(result.ok);
  assert.equal(result.identity.listed, false);
  assert.equal(result.identity.servedModel, null, 'the loaded qwen3-8b is not "the model" for local-glimmer');
  assert.match(result.identity.notes.join(' '), /does not list the requested id "local-glimmer"/);
});

test('Ollama on loopback: version, details and the digest it announces — labelled as announced, never as verified', async () => {
  const seen: string[] = [];
  const ollama = server({
    '/api/version': { version: '0.32.5' },
    '/api/tags': { models: [{ name: 'muse-glimmer:latest', model: 'muse-glimmer:latest', size: 18_000_000_000, digest: DIGEST, details: { format: 'gguf', family: 'qwen3moe', parameter_size: '30.5B', quantization_level: 'Q4_K_M' } }] },
    '/api/ps': { models: [{ name: 'muse-glimmer:latest', digest: DIGEST, context_length: 16384 }] },
    '/api/show': { model_info: { 'qwen3moe.context_length': 262144 }, capabilities: ['completion', 'tools'] },
  }, seen);
  const result = await probeLocalIdentity({ endpoint: LOOP, requestedModel: 'muse-glimmer:latest', declaredKind: 'ollama', launchedByRame: false }, ollama);
  assert.ok(result.ok);
  const id = result.identity;
  assert.equal(id.kind, 'ollama');
  assert.equal(id.scope, 'loopback');
  assert.equal(id.serverVersion, '0.32.5');
  assert.equal(id.servedModel, 'muse-glimmer:latest');
  assert.equal(id.announcedDigest, DIGEST);
  assert.equal(id.contextReported, 16384);
  assert.equal(id.contextTrained, 262144);
  assert.ok(seen.includes(`POST /api/show {"model":"muse-glimmer:latest"}`), 'the model name only: no prompt, file or history');
});

test("RAME's own llama-server: launched by RAME, file name only from /props, build_info as version", async () => {
  const llama = server({
    '/props': { model_path: '/home/someone/private/models/Muse-Glimmer-30B-Q4_K_M.gguf', build_info: 'b6123-abc1234', default_generation_settings: { n_ctx: 32768 } },
    '/v1/models': { data: [{ id: '/home/someone/private/models/Muse-Glimmer-30B-Q4_K_M.gguf', owned_by: 'llamacpp', meta: { n_params: 30_500_000_000, size: 17_000_000_000, n_ctx_train: 262144 } }] },
  });
  const result = await probeLocalIdentity({ endpoint: 'http://127.0.0.1:8775', requestedModel: 'local-glimmer', declaredKind: '', launchedByRame: true }, llama);
  assert.ok(result.ok);
  const id = result.identity;
  assert.equal(id.kind, 'rame-llama-server');
  assert.equal(id.basis, 'launched');
  assert.equal(id.servedModel, 'Muse-Glimmer-30B-Q4_K_M.gguf');
  assert.equal(id.serverVersion, 'b6123-abc1234');
  assert.equal(id.parameters, '30.5B');
  assert.equal(id.format, 'gguf');
  assert.doesNotMatch(JSON.stringify(id), /home|someone|private/, 'no directory of the user');
});

test('a generic OpenAI-compatible endpoint, a silent server, and false or incomplete metadata', async () => {
  const generic = await probeLocalIdentity({ endpoint: LAN, requestedModel: 'm', declaredKind: '', launchedByRame: false }, server({ '/v1/models': { data: [{ id: 'm' }] } }));
  assert.ok(generic.ok);
  assert.equal(generic.identity.kind, 'openai-compatible');
  assert.equal(generic.identity.listed, true);
  const silent = await probeLocalIdentity({ endpoint: LAN, requestedModel: 'm', declaredKind: 'lmstudio', launchedByRame: false }, server({}));
  assert.ok(silent.ok);
  assert.equal(silent.identity.basis, 'declared', 'shown as chosen, not verified');
  assert.equal(silent.identity.kind, 'lmstudio');
  assert.match(silent.identity.notes.join(' '), /did not answer any documented identity request/);
  const odd = await probeLocalIdentity({ endpoint: LOOP, requestedModel: 'x', declaredKind: '', launchedByRame: false }, server({
    '/api/version': { version: '<script>alert(1)</script>' },
    '/api/tags': { models: [{ name: 'x', digest: 'not-a-digest', details: { family: 42, quantization_level: 'Q4\nINJECT' }, size: -5 }] },
    '/api/ps': { models: 'nope' },
  }));
  assert.ok(odd.ok);
  assert.equal(odd.identity.serverVersion, null);
  assert.equal(odd.identity.announcedDigest, null);
  assert.equal(odd.identity.family, null);
  assert.equal(odd.identity.quantization, null);
  assert.equal(odd.identity.sizeBytes, null);
  // A public address is never asked.
  const outside = await probeLocalIdentity({ endpoint: 'http://8.8.8.8:1234', requestedModel: 'm', declaredKind: '', launchedByRame: false }, server({}));
  assert.equal(outside.ok, false);
  // Declared one kind, answers as another.
  const mismatch = await probeLocalIdentity({ endpoint: LOOP, requestedModel: 'm', declaredKind: 'lmstudio', launchedByRame: false }, server({ '/api/version': { version: '0.1' }, '/api/tags': { models: [] } }));
  assert.ok(mismatch.ok);
  assert.match(mismatch.identity.notes.join(' '), /Chosen as lmstudio, but the server answers as ollama/);
});

test('helpers: endpoint labels, file names, the requested id and the stored server facts', () => {
  assert.deepEqual(endpointLabel('http://192.168.1.158:1235'), { scope: 'private-network', label: 'private network, port 1235' });
  assert.deepEqual(endpointLabel('http://127.0.0.1:8775'), { scope: 'loopback', label: 'loopback, port 8775' });
  assert.equal(fileNameOnly('C:\\Users\\someone\\models\\a.gguf'), 'a.gguf');
  const settings = { externalLocalEndpoint: LAN, externalLocal: { model: 'muse-glimmer' }, local: { modelId: 'local-glimmer' } };
  assert.equal(requestedLocalModel(settings, LAN), 'muse-glimmer', 'what RAME really requests from the chosen server');
  assert.equal(requestedLocalModel(settings, 'http://127.0.0.1:8775'), 'local-glimmer', "RAME's own server runs: the configured id");
  assert.deepEqual(evidenceServer(null, 'lmstudio', false, 'private-network', 'muse-glimmer'), { kind: 'lmstudio', basis: 'declared', scope: 'private-network', responded: 'muse-glimmer' });
  assert.equal(isEvidenceServer({ kind: 'rame-llama-server', basis: 'launched', scope: 'private-network', responded: null }), false, "RAME's own server is always loopback");
  assert.equal(isEvidenceServer({ kind: 'lmstudio', basis: 'launched', scope: 'loopback', responded: null }), false, 'only RAME launches');
  assert.equal(sanitizeIdentityView({ identity: null, artifact: { state: 'verified', file: 'a.gguf', size: 1, sha256: 'x', inUse: true }, levels: { artifactVerified: true } })?.levels.artifactVerified, false, 'a level never stands without what it rests on');
});

// ----- SHA-256 of the GGUF -----

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'rame-identity-'));

test('SHA-256 of a model file: block by block, equal to a one-shot hash; a later change makes it stale', async () => {
  const dir = tmp();
  const file = path.join(dir, 'Muse-Glimmer-test.gguf');
  const bytes = Buffer.alloc(1_000_003, 7);
  writeFileSync(file, bytes);
  const progress: number[] = [];
  const hash = await hashArtifact(file, { chunkBytes: 65_536, onProgress: (read) => progress.push(read), now: () => 5 });
  assert.equal(hash.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(hash.size, bytes.length);
  assert.equal(hash.file, 'Muse-Glimmer-test.gguf', 'file name only');
  assert.ok(progress.length > 10 && progress.at(-1) === bytes.length, 'read in blocks');
  const { statSync } = await import('node:fs');
  assert.deepEqual(artifactStillMatches(hash, file, statSync(file)), { ok: true });
  writeFileSync(file, Buffer.alloc(1_000_004, 7));
  assert.deepEqual(artifactStillMatches(hash, file, statSync(file)), { ok: false, reason: 'the model file changed after it was hashed' });
  assert.deepEqual(artifactStillMatches(hash, path.join(dir, 'other.gguf'), statSync(file)), { ok: false, reason: 'another model file is configured now' });
});

test('SHA-256: cancel, unreadable file, and a file that changes while it is read — nothing is recorded, no path in the error', async () => {
  const controller = new AbortController();
  const dir = tmp();
  const file = path.join(dir, 'big.gguf');
  writeFileSync(file, Buffer.alloc(300_000, 1));
  await assert.rejects(
    hashArtifact(file, { chunkBytes: 1024, signal: controller.signal, onProgress: (read) => { if (read > 10_000) controller.abort(); } }),
    (error: Error) => error.name === 'AbortError',
  );
  await assert.rejects(hashArtifact(path.join(dir, 'missing.gguf')), (error: Error) => error instanceof ArtifactReadError && /\(ENOENT\)/.test(error.message) && !error.message.includes(dir));
  let stats = 0;
  const changing: ArtifactFs = {
    stat: async () => ({ size: 10, mtimeMs: stats++ === 0 ? 1 : 2, isFile: () => true }),
    open: async () => ({ read: async (buffer, _o, _l, position) => ({ bytesRead: position === 0 ? (buffer.fill(1, 0, 10), 10) : 0 }), close: async () => undefined }),
  };
  await assert.rejects(hashArtifact('/x/model.gguf', { fs: changing }), /changed while it was read/);
  const failing: ArtifactFs = {
    stat: async () => ({ size: 10, mtimeMs: 1, isFile: () => true }),
    open: async () => ({ read: async () => { throw Object.assign(new Error('/home/someone/x: EIO'), { code: 'EIO' }); }, close: async () => undefined }),
  };
  await assert.rejects(hashArtifact('/home/someone/x.gguf', { fs: failing }), (error: Error) => error.message === 'The model file could not be read (EIO).');
});

// ----- Host: the requested id, the server facts per inference, the GGUF hash -----

type Evidence = { decisive: InferenceEvidence[]; other: InferenceEvidence[]; now: ModelEvidenceView['now'] };
const evidenceOf = (state: PostedState) => state.modelEvidence as unknown as Evidence;

test('host: a chosen model on a server is recorded as what RAME requested; each inference keeps its server facts', async () => {
  const h = new HostHarness();
  await h.start({ externalLocal: { model: 'muse-glimmer', kind: 'lmstudio', tools: true, context: 32768, lan: false } });
  try {
    h.model.enqueue({ kind: 'json', body: Object.assign({}, assistantText('Hello.') as object, { model: 'muse-glimmer-30b' }) });
    await h.provider.sendMessage('Hi.', 'agent', 'local');
    const entry = [...evidenceOf(h.last()).decisive, ...evidenceOf(h.last()).other].at(-1) as InferenceEvidence;
    assert.ok(isValidInference(entry));
    assert.equal(entry.runtime.model, 'muse-glimmer', 'the id RAME requested, not local-glimmer');
    assert.equal(entry.runtime.server?.scope, 'loopback');
    assert.equal(entry.runtime.server?.kind, 'lmstudio');
    assert.equal(entry.runtime.server?.basis, 'declared', 'not checked: as chosen');
    assert.equal(entry.runtime.server?.responded, 'muse-glimmer-30b', 'the id the server wrote in its answer, kept apart');
    const sent = JSON.stringify(h.model.requests.at(-1));
    assert.match(sent, /"model":"muse-glimmer"/);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('host: SHA-256 of the configured GGUF from Settings; stale once the file changes; nothing blocks a run', async () => {
  const dir = tmp();
  const gguf = path.join(dir, 'Muse-Glimmer-host.gguf');
  writeFileSync(gguf, 'GGUF-fake-bytes');
  const h = new HostHarness();
  await h.start({ local: { executablePath: '/opt/llama/llama-server', modelPath: gguf, projectorPath: '', draftModelPath: '', modelId: 'local-glimmer', contextSize: 32768, port: 8775, idleTimeoutSec: 900 } });
  try {
    h.send({ type: 'localIdentity', action: 'hash' });
    const done = await h.waitFor((s) => evidenceOf(s).now.local.identity?.artifact.state === 'verified', 8000);
    const artifact = evidenceOf(done).now.local.identity?.artifact as { sha256: string; file: string; inUse: boolean };
    assert.equal(artifact.sha256, createHash('sha256').update('GGUF-fake-bytes').digest('hex'));
    assert.equal(artifact.file, 'Muse-Glimmer-host.gguf');
    assert.equal(artifact.inUse, false, 'RAME is not running this file now');
    assert.equal(evidenceOf(done).now.local.identity?.levels.artifactVerified, false, 'not "verified" for a run that does not use it');
    assert.doesNotMatch(JSON.stringify(evidenceOf(done).now), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no directory in the view');
    writeFileSync(gguf, 'GGUF-other-bytes!');
    await h.provider.refreshAll();
    assert.equal(evidenceOf(h.last()).now.local.identity?.artifact.state, 'stale');
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

// ----- The view: Model evidence lines -----

function formatter(): (view: unknown, language: 'en' | 'es') => { now: string[]; decisive: Array<{ lines: string[] }>; other: Array<{ lines: string[] }> } {
  type Helpers = { t(text: string): string; tf(text: string, ...values: unknown[]): string };
  const context = { window: {} as { RAME_EVIDENCE?: { format(view: unknown, language: string, t: unknown, tf: unknown): never; helpersFor(language: string): Helpers } } };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/evidenceUx.js', 'utf8'), context);
  const module = context.window.RAME_EVIDENCE!;
  return (view, language) => {
    const helpers = module.helpersFor(language);
    return module.format(view, language, helpers.t, helpers.tf);
  };
}

const record = (runtime: Record<string, unknown>, seq: number): InferenceEvidence => ({
  inferenceId: `inf-${seq}`, seq, at: 1, run: 1, provider: 'local',
  runtime: { kind: 'external-endpoint', model: 'muse-glimmer', contextConfigured: null, contextConfirmed: null, template: 'unknown', projector: false, draft: false, ...runtime } as InferenceEvidence['runtime'],
  identity: 'response-observed', authority: 'local', mode: 'agent', mission: null, request: 'agent-step', response: 'text', failure: null, usage: { input: 10, output: 5 }, finish: 'stop', toolCalls: [], final: true,
});

const NOW_LAN = {
  local: {
    configured: { kind: 'external', model: 'muse-glimmer', context: null, projector: false, draft: false },
    running: { kind: 'external-endpoint', contextConfirmed: null, template: 'unknown', scope: 'private-network' },
    observed: true,
    identity: {
      identity: { kind: 'lmstudio', basis: 'detected', scope: 'private-network', endpointLabel: 'private network, port 1235', serverVersion: null, requestedModel: 'muse-glimmer', listed: true, servedModel: 'muse-glimmer', family: 'qwen3moe', parameters: '30B-A3B', quantization: 'Q4_K_M', format: 'gguf', sizeBytes: null, contextReported: 32768, contextTrained: 262144, capabilities: ['tools'], announcedDigest: null, notes: [], checkedAt: 1 },
      artifact: { state: 'none' },
      levels: { configured: true, endpointVerified: true, artifactVerified: false, responseObserved: true },
    },
  },
  cloud: { model: 'muse-spark-1.3', keyStored: false, observed: false },
};

test('Model evidence: LM Studio on the LAN is named as such, requested and answered ids apart, no -m/GGUF note, levels and the caveat', () => {
  const format = formatter();
  const view = { now: NOW_LAN, decisive: [record({ server: { kind: 'lmstudio', basis: 'detected', scope: 'private-network', responded: 'muse-glimmer-30b' } }, 1)], other: [], otherHidden: 0, total: 1, mission: null, discarded: false };
  const out = format(view, 'en');
  const now = out.now.join('\n');
  assert.match(now, /Running: LM Studio · on another computer of the private network — type identified from the server's own API; the weights it runs are not verified/);
  assert.doesNotMatch(now, /loopback/);
  assert.doesNotMatch(now, /The file name is what RAME passed to llama-server with -m/, 'no llama-server of RAME here');
  assert.match(now, /Requested model id: muse-glimmer · listed by the server: yes/);
  assert.match(now, /Model the server reports as loaded: muse-glimmer/);
  assert.match(now, /Endpoint verified \(it answered and identified itself through its API in this session\): yes/);
  assert.match(now, /Model artifact verified \(SHA-256 of the GGUF of the llama-server RAME launched\): no/);
  assert.match(now, /does not prove which weights an external server ran/);
  const lines = out.decisive[0]?.lines.join('\n') ?? '';
  assert.match(lines, /Provider: LM Studio · on another computer of the private network · type identified from the server's own API\nRequested model id: muse-glimmer\nIdentity: server\/model identity not verified · response observed\nModel id in the server's answer: muse-glimmer-30b \(as the server wrote it\)/);
  const es = format(view, 'es').now.join('\n');
  assert.match(es, /En ejecución: LM Studio · en otro ordenador de la red privada — tipo identificado por la propia API del servidor; los pesos que ejecuta no se verifican/);
});

test('Model evidence: an endpoint never checked is still placed on the right network; an older record keeps what it recorded', () => {
  const format = formatter();
  const unchecked = { ...NOW_LAN, local: { ...NOW_LAN.local, identity: undefined } };
  const view = { now: unchecked, decisive: [record({}, 1)], other: [], otherHidden: 0, total: 1, mission: null, discarded: false };
  const out = format(view, 'en');
  assert.match(out.now.join('\n'), /Running: OpenAI-compatible endpoint on another computer of the private network — server\/model identity not verified/);
  assert.match(out.decisive[0]?.lines.join('\n') ?? '', /Provider: external OpenAI-compatible endpoint \(server type and network not recorded by the build that ran it\)/, 'an older record is not given facts it never had');
  // RAME's own llama-server: the -m / GGUF note is there.
  const owned = { now: { local: { configured: { kind: 'owned', model: 'Muse.gguf', context: 32768, projector: false, draft: false }, running: { kind: 'rame-launched', contextConfirmed: 32768, template: 'muse-glimmer' }, observed: true }, cloud: NOW_LAN.cloud }, decisive: [], other: [], otherHidden: 0, total: 0, mission: null, discarded: false };
  assert.match(format(owned, 'en').now.join('\n'), /The file name is what RAME passed to llama-server with -m/);
});
