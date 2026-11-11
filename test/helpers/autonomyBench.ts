/**
 * A partial host that drives the Mission Advisory and Autonomy & Permissions
 * directly, shared by the autonomy suites. Meta is the harness's fakeCloud:
 * nothing leaves this machine.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { assistantText, fakeCloud, toolCallReply } from './hostHarness.js';
import { handleAutonomyMessage, missionMetaBinding } from '../../src/autonomyHost.js';
import type { MetaBinding } from '../../src/autonomyPolicy.js';
import { AutonomyStore, type AutonomyRuntime } from '../../src/autonomyStore.js';
import { defaultAdvisoryLimits } from '../../src/missionAdvisoryLimits.js';
import { MissionStore, type MissionRecord } from '../../src/missionStore.js';
import { updateVerifiers } from '../../src/missionVerifiers.js';
import type { ProviderHost } from '../../src/providerTypes.js';

export const KEY = 'fake-meta-key-AUTONOMY-7d1e';
export const API_KEY_SECRET = 'rameCode.metaModelApiKey';
export const MODEL = 'muse-spark-1.3';
export const ADVICE = { diagnosis: 'a.txt must say final.', steps: ['Write final into a.txt.'], checks: ['npm:check passes.'] };
export const advice = () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(ADVICE) }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 } });
export const tool = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
export const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });
export type Confirmation = { message: string; detail: string; action: string };

// ----- A partial host that drives the Mission Advisory directly -----

export interface ConsultBench {
  host: ProviderHost & { confirmAutonomy?: (request: Confirmation) => Promise<boolean>; metaCredential: string };
  missions: MissionStore;
  autonomy: AutonomyStore;
  backend: { get(key: string): unknown; update(key: string, value: unknown): Promise<void> };
  root: string;
  id: string;
  model: { value: string };
  confirmations: Confirmation[];
  scope: () => Promise<{ ok: true; scopeId: string; root: string; label: string }>;
  authorize(options?: { max?: number | null; dataScope?: 'instructions' | 'files'; tokenBudget?: number | null }): Promise<void>;
  grant(maxConsultations: number | null, files?: string[], excluded?: string[]): Promise<{ ok: boolean; error?: string; binding?: MetaBinding }>;
  mission(): MissionRecord;
  notes(): string;
  dispose(): void;
}

export async function bench(options: { backend?: ConsultBench['backend']; runtime?: AutonomyRuntime } = {}): Promise<ConsultBench> {
  const memory = new Map<string, unknown>();
  const backend = options.backend ?? { get: (key: string) => memory.get(key), update: async (key: string, value: unknown) => void memory.set(key, JSON.parse(JSON.stringify(value))) };
  const missions = new MissionStore(backend);
  const autonomy = new AutonomyStore(backend, options.runtime);
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-autonomy-'));
  await fsp.writeFile(path.join(root, 'checksum.js'), 'module.exports = (s) => s.length; // CODE-UNDER-TEST-31\n');
  await fsp.writeFile(path.join(root, 'config.js'), "const token = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789';\n");
  await fsp.mkdir(path.join(root, 'acceptance'), { recursive: true });
  await fsp.writeFile(path.join(root, 'acceptance', 'check.test.js'), 'HIDDEN-VERIFIER-42\n');
  await fsp.writeFile(path.join(root, '.env'), 'API_KEY=1\n');
  const created = await missions.create({ scopeId: 'ws_1', scopeLabel: 'p', threadId: 't1', goal: 'Make npm:check pass.', steps: [{ id: 't1', title: 'Fix it', successCriterion: 'npm:check' }], decisions: [] });
  assert.ok(created.ok);
  const id = created.value.id;
  const model = { value: MODEL };
  const confirmations: Confirmation[] = [];
  const fs = {
    readText: (rel: string) => fsp.readFile(path.join(root, rel), 'utf8'),
    stat: async (rel: string) => {
      try {
        return (await fsp.stat(path.join(root, rel))).isFile() ? { kind: 'file' as const } : { kind: 'dir' as const };
      } catch {
        return { kind: 'missing' as const };
      }
    },
  };
  const host = {
    missions,
    autonomy,
    disposed: false,
    status: '',
    hasKey: true,
    metaCredential: 'a'.repeat(32),
    settings: { allowCloudEscalation: true, web: { enabled: true } },
    missionAuto: null,
    selectedCloudModel: () => model.value,
    getApiKey: async () => KEY,
    memory: { listCurrentDecisions: () => [] },
    chatRunner: { start: (work: (context: { signal: AbortSignal }) => Promise<unknown>) => work({ signal: new AbortController().signal }) },
    recordUsage: () => {},
    postState: async () => undefined,
    agentFsFor: () => fs,
    // Model evidence of the consultation (recorded on success).
    modelEvidence: { state: { version: 1, threads: [] }, observed: {}, persist: () => undefined },
    store: { list: () => [] },
    activeMission: null,
    localStatus: () => ({ owned: false }),
    confirmAutonomy: async (request: Confirmation) => {
      confirmations.push(request);
      return true;
    },
    updateActiveMission: async (change: (mission: MissionRecord) => { ok: boolean }) => {
      const current = missions.get(id) as MissionRecord;
      return (await missions.update(id, current.revision, change as never)).ok;
    },
  } as unknown as ConsultBench['host'];
  const scope = async () => ({ ok: true as const, scopeId: 'ws_1', root, label: 'p' });
  return {
    host, missions, autonomy, backend, root, id, model, confirmations, scope,
    async authorize(options = {}) {
      await handleAutonomyMessage(host, { type: 'autonomyMode', mode: 'supervised' }, scope);
      await handleAutonomyMessage(host, { type: 'autonomyMeta', maxPerMission: options.max === undefined ? 5 : options.max, validityHours: 8, dataScope: options.dataScope ?? 'instructions', tokenBudget: options.tokenBudget ?? null }, scope);
    },
    async grant(maxConsultations, files = [], excluded = ['acceptance/check.test.js']) {
      const bound = await missionMetaBinding(host, 'ws_1', maxConsultations, files, fs as never, new Set(excluded));
      if (!bound.ok) {
        return { ok: false, error: bound.error };
      }
      const current = missions.get(id) as MissionRecord;
      const seeded = await missions.update(id, current.revision, (draft) => {
        draft.grant = {
          missionId: id, scopeId: 'ws_1', provider: 'local', model: 'local-glimmer', mode: 'supervised', grantedAt: 1, tests: null,
          acceptance: { commandId: 'npm:check', packageJsonHash: 'b'.repeat(64), files: [{ path: 'acceptance/check.test.js', hash: 'c'.repeat(64) }] },
          escalation: { model: MODEL, maxConsultations, ...defaultAdvisoryLimits(maxConsultations), used: 0, validResponses: 0, dataClasses: [], sentBytes: 0, usedTokens: 0, preauth: bound.binding },
        };
        draft.auto = { runs: 1, startedAt: 1, noProgressStreak: 0, lastSignature: '', lastProgress: '', needsVerification: true, pendingAdvice: '', acceptanceFeedback: '', lastRunNotes: '', userGuidance: '', blockers: updateVerifiers([], [], [{ commandId: 'npm:check', exitCode: 1, afterLastWrite: true }], 'c', 1, 'agent', id).blockers, recoveries: [] };
        return { ok: true, value: draft };
      });
      assert.ok(seeded.ok, seeded.ok ? '' : seeded.error);
      return { ok: true, binding: bound.binding };
    },
    mission: () => missions.get(id) as MissionRecord,
    notes: () => (missions.get(id) as MissionRecord).evidence.map((entry) => entry.text).join('\n'),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export async function withBench(body: (b: ConsultBench) => Promise<void>): Promise<void> {
  const b = await bench();
  fakeCloud.requests.length = 0;
  fakeCloud.handler = advice;
  try {
    await body(b);
  } finally {
    fakeCloud.handler = null;
    b.dispose();
  }
}

