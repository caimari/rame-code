/**
 * Two guarantees, with simulated servers only:
 * 1. An earlier Meta disclosure never covers local messages the user has
 *    not reviewed: new messages need a new answer, and an inclusion is bound
 *    to the exact content shown, not to a turn's position.
 * 2. Every recovery of earlier context (automatic, in Chat, Agent, a Mission
 *    plan or run, and `search_history`) is recorded apart from the host
 *    record and the Mission's evidence, by reference and sha256 only.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { cloudVisibleThread, loadDisclosure, planDisclosure, recordAnswer, threadDisclosure } from '../src/cloudDisclosure.js';
import { appendRecoveryEvent, CONTINUITY_LOG_KEY, loadContinuityLog, MAX_EVENTS_PER_THREAD, sha256, type ContinuityLogView, type RecoveryEvent } from '../src/continuityLog.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { appendAssistantTurn, appendUserTurn, createThread, THREAD_STORE_KEY, type ChatThread } from '../src/threadStore.js';
import { buildViewHtml } from '../src/viewHtml.js';
import { assistantText, fakeCloud, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const KEY = 'fake-meta-key-CONSENT-8c21';
const LOCAL = { provider: 'local' as const, model: 'local-glimmer' };
const FACT = 'Invoices for the Oceania customer must be issued in NZD.';
type Disclosure = { messages: Array<{ turn: number; text: string }>; digest: string };
const disclosureOf = (state: PostedState): Disclosure | null => (state.remote as { disclosure: Disclosure | null }).disclosure;
const logOf = (state: PostedState): ContinuityLogView => state.continuityLog as ContinuityLogView;
const cloudText = (): string => JSON.stringify(fakeCloud.requests.map((request) => request.body.messages));
const okReply = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });

async function withHarness(body: (h: HostHarness) => Promise<void>, settings: Record<string, unknown> = {}): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true, ...settings });
  h.secretValues.set('rameCode.metaModelApiKey', KEY);
  fakeCloud.requests.length = 0;
  fakeCloud.handler = okReply;
  try {
    await body(h);
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function localChat(h: HostHarness, texts: string[]): Promise<void> {
  for (const text of texts) {
    h.model.enqueue({ kind: 'json', body: assistantText(`Local reply to: ${text}`) });
    await h.provider.sendMessage(text, 'chat', 'local');
  }
}

async function answer(h: HostHarness, choice: 'include' | 'withhold'): Promise<void> {
  const before = fakeCloud.requests.length;
  h.send({ type: 'disclosureDecide', digest: (disclosureOf(h.last()) as Disclosure).digest, choice });
  await h.waitFor(() => fakeCloud.requests.length === before + 1);
  await h.waitFor((state) => !state.running);
}

// ----- 1. Consent never carries over to unreviewed content -----

test('an earlier inclusion never covers new local messages: they wait for a new answer and are never sent before it', async () => {
  await withHarness(async (h) => {
    await localChat(h, ['FIRST-LOCAL-NOTE approved for Meta.']);
    await h.provider.sendMessage('To Meta.', 'chat', 'cloud');
    await answer(h, 'include');
    assert.match(cloudText(), /FIRST-LOCAL-NOTE/);
    // New local messages after that inclusion.
    await localChat(h, ['SECOND-LOCAL-NOTE never reviewed.', 'THIRD-LOCAL-NOTE never reviewed.']);
    const sent = fakeCloud.requests.length;
    await h.provider.sendMessage('To Meta again.', 'chat', 'cloud');
    assert.equal(fakeCloud.requests.length, sent, 'the earlier answer does not let the new messages through');
    const card = disclosureOf(h.last()) as Disclosure;
    assert.deepEqual(card.messages.map((entry) => entry.text), [
      'SECOND-LOCAL-NOTE never reviewed.',
      'Local reply to: SECOND-LOCAL-NOTE never reviewed.',
      'THIRD-LOCAL-NOTE never reviewed.',
      'Local reply to: THIRD-LOCAL-NOTE never reviewed.',
    ], 'only the unreviewed messages are offered');
    assert.equal(cloudText().includes('SECOND-LOCAL-NOTE'), false);
    // Withheld now: never sent later, while the earlier inclusion still holds.
    await answer(h, 'withhold');
    await h.provider.sendMessage('And once more.', 'chat', 'cloud');
    assert.equal(disclosureOf(h.last()), null);
    const last = JSON.stringify(fakeCloud.requests.at(-1)?.body.messages);
    assert.match(last, /FIRST-LOCAL-NOTE/);
    assert.equal(cloudText().includes('SECOND-LOCAL-NOTE') || cloudText().includes('THIRD-LOCAL-NOTE'), false);
  });
});

test('an inclusion is bound to the exact content shown: a changed or shifted turn is not sent on the old approval', () => {
  let thread: ChatThread = createThread('APPROVED-ONE', { now: 1, id: 't-hash', mode: 'chat' });
  thread = appendAssistantTurn(thread, 'APPROVED-TWO', 2, undefined, LOCAL);
  thread = appendUserTurn(thread, 'Now Meta.', 3);
  const state = loadDisclosure(undefined);
  const plan = planDisclosure(thread, 'Now Meta.', threadDisclosure(state, 't-hash', { processing: 'standard', credential: 'none' }), { scopeId: '', list: [] }, { model: 'muse-spark-1.3', mode: 'chat', delegated: false, askToolResults: false });
  recordAnswer(state, 't-hash', plan, true, 4, { processing: 'standard', credential: 'none' });
  const visible = (candidate: ChatThread) => JSON.stringify(cloudVisibleThread(candidate, 'Now Meta.', threadDisclosure(state, 't-hash', { processing: 'standard', credential: 'none' })).turns);
  assert.match(visible(thread), /APPROVED-ONE[\s\S]*APPROVED-TWO/);
  // Same position, different content (for example an edited or replaced stored turn).
  const changed: ChatThread = { ...thread, turns: thread.turns.map((turn, index) => (index === 0 && turn.kind === 'user' ? { ...turn, text: 'NEVER-REVIEWED-SECRET' } : turn)) };
  assert.equal(visible(changed).includes('NEVER-REVIEWED-SECRET'), false);
  assert.match(visible(changed), /APPROVED-TWO/, 'the unchanged turn keeps its approval');
  // Shifted positions (a reload dropped an invalid turn before them): nothing unreviewed moves into an approved slot.
  const shifted: ChatThread = { ...thread, turns: [{ kind: 'user', text: 'NEVER-REVIEWED-INSERTED', timestamp: 0 }, ...thread.turns] };
  assert.equal(visible(shifted).includes('NEVER-REVIEWED-INSERTED'), false);
  assert.equal(visible(shifted).includes('APPROVED-ONE'), false, 'moved content is not sent on a position it was not approved at');
});

// ----- 2. The recovered-context log -----

function farFactThread(root: string): ChatThread {
  let thread: ChatThread = createThread('Keep the billing module healthy.', { now: 1, id: 't-log', mode: 'chat', workspaceRoot: root });
  thread = appendUserTurn(thread, FACT, 2);
  thread = appendAssistantTurn(thread, 'Noted.', 3, undefined, LOCAL);
  for (let index = 0; index < 150; index++) {
    thread = index % 2 ? appendAssistantTurn(thread, `layout reply ${index} ${'sidebar '.repeat(70)}`, 4 + index, undefined, LOCAL) : appendUserTurn(thread, `layout note ${index} ${'toolbar '.repeat(70)}`, 4 + index);
  }
  return thread;
}

async function openSeeded(h: HostHarness, thread: ChatThread): Promise<void> {
  h.memento.set(THREAD_STORE_KEY, [thread]);
  h.model.props = { default_generation_settings: { n_ctx: 32768 } };
  h.createProvider();
  await h.provider.refreshAll();
  h.send({ type: 'openThread', threadId: thread.id });
  await h.waitFor((state) => state.activeThreadId === thread.id);
}

const stored = (h: HostHarness): RecoveryEvent[] => ((h.memento.get(CONTINUITY_LOG_KEY) as { threads: Array<{ events: RecoveryEvent[] }> }).threads[0]?.events ?? []);

test('a Mission run records what it recovered and why, by turn and sha256, apart from the Mission evidence', async () => {
  await withHarness(async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node t.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await openSeeded(h, farFactThread(h.workspace));
    const plan = { goal: 'Issue Oceania invoices in the agreed currency.', assumptions: [], steps: [{ id: 't1', title: 'Set the Oceania invoice currency', successCriterion: 'npm:test passes' }], risks: [] };
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: plan }]) });
    await h.provider.sendMessage('Fix the currency of Oceania invoices as agreed.', 'mission', 'local');
    const mission = (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;
    h.model.enqueue({ kind: 'json', body: assistantText('Done.') });
    const run = h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    await h.waitFor(() => stored(h).some((event) => event.mode === 'mission-run'), 8000);
    await h.provider.stopMission(mission.id, 'cancel');
    await run;
    const events = stored(h);
    const planEvent = events.find((event) => event.mode === 'mission-plan');
    const runEvent = events.find((event) => event.mode === 'mission-run') as RecoveryEvent;
    assert.ok(planEvent, 'the plan\'s recovery is recorded too');
    assert.equal(runEvent.trigger, 'automatic');
    assert.deepEqual(runEvent.mission, { missionId: mission.id, run: 1 });
    assert.equal(runEvent.provider, 'local');
    const fact = runEvent.sources.find((source) => source.turn === 1);
    assert.ok(fact, 'the far fact, by its position in the thread');
    assert.equal(fact.role, 'user');
    assert.equal(fact.sha256, sha256(FACT), 'the hash of the exact stored text: anyone can recompute it from the thread');
    assert.match(fact.match, /^lexical-/);
    // Apart from the Mission's evidence, whose first lines are unchanged.
    const missionEvidence = (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]?.evidence ?? [];
    assert.ok(!missionEvidence.some((entry) => /context_continuity|sha256/.test(entry.text)));
    // References only: no excerpt, no query.
    const raw = JSON.stringify(h.memento.get(CONTINUITY_LOG_KEY));
    for (const leak of [FACT, 'Oceania', 'Fix the currency', h.workspace]) {
      assert.equal(raw.includes(leak), false, leak);
    }
    // In the view, and after a reload.
    assert.ok(logOf(h.last()).events.some((event) => event.mode === 'mission-run'));
    h.createProvider();
    h.send({ type: 'openThread', threadId: 't-log' });
    const reloaded = await h.waitFor((state) => state.activeThreadId === 't-log');
    assert.deepEqual(logOf(reloaded).events.map((event) => event.seq), events.map((event) => event.seq));
  }, { mode: 'mission' });
});

test('Chat, Agent, search_history, and a Meta request with withheld history are each recorded', async () => {
  await withHarness(async (h) => {
    await openSeeded(h, farFactThread(h.workspace));
    h.model.enqueue({ kind: 'json', body: assistantText('NZD.') });
    await h.provider.sendMessage('Which currency for Oceania invoices?', 'chat', 'local');
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 's1', name: 'search_history', args: { queries: ['Oceania invoices currency'], limit: 3 } }]) },
      { kind: 'json', body: assistantText('NZD.') },
    );
    await h.provider.sendMessage('Check what we agreed about Oceania invoices.', 'agent', 'local');
    await h.provider.sendMessage('Ask Meta about Oceania invoices.', 'chat', 'cloud');
    await answer(h, 'withhold');
    const events = stored(h);
    const kinds = events.map((event) => `${event.trigger}/${event.mode}/${event.provider}`);
    assert.ok(kinds.includes('automatic/chat/local'), kinds.join(' '));
    assert.ok(kinds.includes('automatic/agent/local'), kinds.join(' '));
    assert.ok(kinds.includes('search_history/agent/local'), kinds.join(' '));
    const search = events.find((event) => event.trigger === 'search_history') as RecoveryEvent;
    assert.ok(search.sources.some((source) => source.turn === 1 && source.sha256 === sha256(FACT)));
    assert.equal(search.querySha256, sha256(JSON.stringify(['Oceania invoices currency'])));
    const meta = events.find((event) => event.provider === 'cloud') as RecoveryEvent;
    assert.ok(meta.withheldLocal > 100, `withheld ${meta.withheldLocal}`);
    assert.deepEqual(meta.sources, [], 'nothing local was recovered for Meta');
  });
});

test('the log is versioned, validated, bounded, and fails closed when unreadable', () => {
  const event = { at: 1, trigger: 'automatic' as const, mode: 'chat' as const, provider: 'local' as const, model: 'local-glimmer', mission: null, querySha256: sha256('q'), sources: [{ turn: 1, role: 'user' as const, at: 1, match: 'lexical-exact' as const, sha256: sha256('x') }], withheldLocal: 0 };
  const state = loadContinuityLog(undefined).state;
  for (let index = 0; index < MAX_EVENTS_PER_THREAD + 5; index++) {
    assert.equal(appendRecoveryEvent(state, 't-1', event), true);
  }
  assert.equal(state.threads[0]?.events.length, MAX_EVENTS_PER_THREAD);
  assert.equal(state.threads[0]?.events.at(-1)?.seq, MAX_EVENTS_PER_THREAD + 5, 'sequence numbers are never reused');
  assert.equal(appendRecoveryEvent(state, 't-1', { ...event, sources: [{ ...event.sources[0]!, sha256: 'not-a-hash' }] }), false, 'an invalid event is not stored');
  assert.equal(appendRecoveryEvent(state, 't-1', { ...event, model: '/home/someone/model.gguf' }), false, 'no paths');
  const good = JSON.parse(JSON.stringify(state));
  const bad = structuredClone(good);
  bad.threads[0].events[0].excerpt = FACT;
  assert.equal(loadContinuityLog(bad).state.threads.length, 0, 'an extra field drops the thread whole');
  assert.equal(loadContinuityLog({ version: 2, threads: [] }).discarded, 1);
  assert.equal(loadContinuityLog(good).discarded, 0);
});

test('the view: a folded section inside Model evidence, references only, English and Spanish', () => {
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', evidenceUxUri: 'evidenceUx.js' });
  const evidence = html.slice(html.indexOf('<details id="modelEvidence">'), html.indexOf('</details>\n      </details>'));
  assert.match(evidence, /<details id="recoveryLog">\s*<summary id="recoveryLogSummary"><\/summary>/);
  const context = { window: {} as { RAME_EVIDENCE?: { formatLog(log: unknown, t: unknown, tf: unknown): { summary: string; note: string; events: Array<{ head: string; lines: string[] }> }; helpersFor(language: string): { t: unknown; tf: unknown } } } };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/evidenceUx.js', 'utf8'), context);
  const module = context.window.RAME_EVIDENCE;
  assert.ok(module);
  const log = { total: 1, discarded: false, events: [{ seq: 1, at: 0, trigger: 'search_history', mode: 'mission-run', provider: 'local', model: 'local-glimmer', mission: { missionId: 'mis_x', run: 2 }, querySha256: sha256('q'), sources: [{ turn: 1, role: 'user', at: 0, match: 'lexical-exact', sha256: sha256(FACT) }], withheldLocal: 0 }] };
  for (const language of ['en', 'es']) {
    const helpers = module.helpersFor(language);
    const view = module.formatLog(log, helpers.t, helpers.tf);
    const lines = [view.summary, view.note, ...view.events.flatMap((event) => [event.head, ...event.lines])].join('\n');
    assert.match(lines, new RegExp(`sha256 ${sha256(FACT).slice(0, 16)}…`));
    assert.equal(lines.includes(FACT), false);
    assert.match(lines, language === 'en' ? /Recovered context — recorded by RAME Code \(1\)[\s\S]*search_history requested by the model · Mission run · local-glimmer[\s\S]*internal run 2[\s\S]*Turn 2 · user/ : /Contexto recuperado — registrado por RAME Code \(1\)[\s\S]*search_history pedido por el modelo · Ejecución de Mission[\s\S]*ejecución interna 2[\s\S]*Turno 2 · usuario/);
  }
});
