/**
 * Mission UX: "Authorize and start" is confirmed by the host, never sent
 * twice, survives a rebuilt view, and the live card says only what the host
 * recorded (a created plan is never "Completed"; the final report appears
 * only after the user's acceptance check exited 0). Settings is split into
 * cards, and the version is shown.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { readBuildInfo } from '../src/buildInfo.js';
import { acceptanceState, missionFinalReport, missionPhase } from '../src/missionPhase.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { buildViewHtml } from '../src/viewHtml.js';
import { parseViewInboundMessage, type MissionLiveView } from '../src/viewMessages.js';
import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const EMPTY = sha('');
const ONE_TASK = { goal: 'Make check.test.js pass.', assumptions: [], steps: [{ id: 't1', title: 'Write final into a.txt', successCriterion: 'npm:test passes' }], risks: [] };
const liveOf = (state: PostedState | undefined): MissionLiveView | null => ((state?.missionLive as MissionLiveView | null | undefined) ?? null);
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] } | undefined)?.missions[0] ?? null) as MissionRecord;
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const writeA = (id: string, content: string, before: string | null) =>
  tool(id, 'apply_patch', { files: [{ path: 'a.txt', expectedHash: before === null ? EMPTY : sha(before), newContent: content }] });
const runTests = (id: string) => tool(id, 'run_tests', { commandId: 'npm:test' });

// ----- The view's own logic, taken from media/main.js as it ships -----

const script = readFileSync('media/main.js', 'utf8');

function extractFunction(name: string): string {
  const start = script.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  let depth = 0;
  for (let index = script.indexOf('{', start); index < script.length; index++) {
    if (script[index] === '{') {
      depth += 1;
    } else if (script[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return script.slice(start, index + 1);
      }
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

function extractTable(name: string): string {
  const start = script.indexOf(`var ${name} = {`);
  assert.ok(start >= 0, `missing table ${name}`);
  return script.slice(start, script.indexOf('};', start) + 2);
}

interface StartControl {
  visible: boolean;
  disabled: boolean;
  pending: boolean;
  label: string;
  error: string;
  started: boolean;
}
interface ViewLogic {
  missionStartControl(local: { requestId: string; at: number } | null, live: Partial<MissionLiveView> | null, now: number): StartControl;
  runOutcomeLabel(data: Record<string, unknown>, outcome: string | null, threadId: string | null): { text: string; state: string } | null;
  MISSION_PHASE_LABELS: Record<string, string>;
  START_CONFIRM_TIMEOUT_MS: number;
}

function viewLogic(): ViewLogic {
  const timeout = /var START_CONFIRM_TIMEOUT_MS = (\d+);/.exec(script);
  assert.ok(timeout);
  const context: Record<string, unknown> = {};
  vm.runInNewContext(
    [
      extractTable('MISSION_PHASE_LABELS'),
      extractTable('START_LABELS'),
      timeout[0],
      extractFunction('missionPhaseKey'),
      extractFunction('missionStartControl'),
      extractFunction('runOutcomeLabel'),
      'this.missionStartControl = missionStartControl; this.runOutcomeLabel = runOutcomeLabel;',
      'this.MISSION_PHASE_LABELS = MISSION_PHASE_LABELS; this.START_CONFIRM_TIMEOUT_MS = START_CONFIRM_TIMEOUT_MS;',
    ].join('\n'),
    context,
  );
  return context as unknown as ViewLogic;
}

const logic = viewLogic();
const planReady: Partial<MissionLiveView> = { missionId: 'mis_' + 'a'.repeat(24), revision: 1, phase: 'plan_ready', canStart: true, startRequest: null };

// ----- Harness -----

async function withHarness(body: (h: HostHarness) => Promise<void>, acceptance = false): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  await h.writeFile('package.json', JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node check.test.js', ...(acceptance ? { check: 'node acceptance/accept.test.js' } : {}) } }));
  if (acceptance) {
    // The agent-facing test only checks that a.txt exists; the user's frozen check requires the real content.
    await h.writeFile('check.test.js', "require('node:fs').statSync('a.txt');\n");
    await h.writeFile('acceptance/accept.test.js', "require('node:assert').equal(require('node:fs').readFileSync('a.txt', 'utf8'), 'final');\n");
  } else {
    await h.writeFile('check.test.js', "require('node:assert').equal(require('node:fs').readFileSync('a.txt', 'utf8'), 'final');\n");
  }
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

/** A plan through the strict plan tool; the thread stays open, as after planning in the view. */
async function createMission(h: HostHarness): Promise<MissionLiveView> {
  h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: ONE_TASK }]) });
  await h.provider.sendMessage('Make check.test.js pass by writing final into a.txt.', 'mission', 'local');
  const state = await h.waitFor((posted) => liveOf(posted)?.phase === 'plan_ready');
  h.model.requests.length = 0;
  return liveOf(state) as MissionLiveView;
}

const startMessage = (live: MissionLiveView, requestId: string, extra: Record<string, unknown> = {}) => ({
  type: 'missionStart',
  missionId: live.missionId,
  revision: live.revision,
  mode: 'autonomous-workspace',
  maxConsultations: 0,
  trustedProject: true,
  acceptanceCommand: '',
  acceptanceFiles: [],
  requestId,
  ...extra,
});

const startStates = (states: PostedState[], requestId: string, state: string): number =>
  states.findIndex((posted) => liveOf(posted)?.startRequest?.requestId === requestId && liveOf(posted)?.startRequest?.state === state);

// ----- 1. The click shows a pending state at once -----

test('the click shows the pending state at once: disabled, spinner, "Authorizing…", before the host answers', () => {
  const now = 1_000_000;
  const idle = logic.missionStartControl(null, planReady, now);
  assert.deepEqual({ ...idle }, { visible: true, disabled: false, pending: false, label: 'Authorize and start', error: '', started: false });
  // Right after the click, with the host still showing the plan as before.
  const clicked = logic.missionStartControl({ requestId: 'req_click01', at: now }, planReady, now);
  assert.equal(clicked.disabled, true);
  assert.equal(clicked.pending, true, 'the spinner class is on');
  assert.equal(clicked.label, 'Authorizing…');
  // The click handler marks it pending before it posts the message, and refuses a second click.
  const handlerAt = script.indexOf("missionStartBtn.addEventListener('click'");
  const handler = script.slice(handlerAt, script.indexOf('if (missionPauseBtn) {', handlerAt));
  const marked = handler.indexOf('missionStartLocal = { requestId: newRequestId(), at: Date.now() };');
  const drawn = handler.indexOf('applyStartControl(live);');
  const posted = handler.indexOf("type: 'missionStart'");
  assert.ok(marked > 0 && drawn > marked && posted > drawn, 'pending is drawn before the message is posted');
  assert.match(handler, /missionStartBtn\.disabled \|\| missionStartLocal !== null && missionStartControl\(missionStartLocal, live, Date\.now\(\)\)\.pending/);
  assert.match(handler, /requestId: missionStartLocal\.requestId/);
  // The pending state is drawn with the spinner class and aria-busy.
  const apply = extractFunction('applyStartControl');
  assert.match(apply, /classList\.toggle\('is-pending', control\.pending\)/);
  assert.match(apply, /setAttribute\('aria-busy'/);
  // No confirmation for too long: the button comes back with an inline error, never silently.
  const late = logic.missionStartControl({ requestId: 'req_click01', at: now }, planReady, now + logic.START_CONFIRM_TIMEOUT_MS + 1);
  assert.equal(late.disabled, false);
  assert.match(late.error, /did not confirm the start/);
  // The request id is part of the validated message.
  const parsed = parseViewInboundMessage({ ...startMessage(planReady as MissionLiveView, 'req_click01') });
  assert.equal((parsed as { requestId?: string }).requestId, 'req_click01');
  assert.throws(() => parseViewInboundMessage({ ...startMessage(planReady as MissionLiveView, 'not-an-id') }));
});

// ----- 2. The host confirms the start -----

test('the host confirms the start by request id: authorizing first, then started, before the first internal run', async () => {
  await withHarness(async (h) => {
    const live = await createMission(h);
    h.model.enqueue(writeA('w', 'final', null), runTests('t'), { kind: 'json', body: assistantText('Done.') });
    const from = h.posted.length;
    h.send(startMessage(live, 'req_click01'));
    await h.waitFor((state) => liveOf(state)?.phase === 'completed', 8000);
    const states = h.posted.slice(from);
    const authorizing = startStates(states, 'req_click01', 'authorizing');
    const started = startStates(states, 'req_click01', 'started');
    const firstStep = states.findIndex((state) => typeof liveOf(state)?.step === 'number');
    assert.equal(authorizing, 0, 'the first state after the click confirms it');
    assert.equal(liveOf(states[authorizing])?.phase, 'authorizing');
    assert.equal(liveOf(states[authorizing])?.canStart, false, 'no second start is offered while authorizing');
    assert.ok(started > authorizing, 'then started');
    assert.equal(states[started]?.status, 'Mission started.');
    assert.ok(firstStep > started, 'the confirmation comes before the first model step');
    // The view, with its own click, turns the confirmation into "Mission started".
    const control = logic.missionStartControl({ requestId: 'req_click01', at: Date.now() }, liveOf(states[started]) as MissionLiveView, Date.now());
    assert.equal(control.started, true);
    assert.equal(control.label, 'Mission started');
    // The card's script announces it, returns to Chat, and focuses the card.
    const render = extractFunction('renderMissionCard');
    assert.match(render, /missionStartNoteEl\.textContent = t\(START_LABELS\.started\)/);
    assert.match(render, /vscode\.postMessage\(\{ type: 'navigate', screen: 'chat' \}\)/);
    assert.match(render, /missionCardHeadingEl\.focus\(\)/);
  });
});

test('a start the host refuses comes back as an inline error, with nothing granted and the button usable again', async () => {
  await withHarness(async (h) => {
    const live = await createMission(h);
    const from = h.posted.length;
    h.send(startMessage(live, 'req_badfile', { acceptanceCommand: 'npm:test', acceptanceFiles: ['missing/accept.test.js'] }));
    const failed = await h.waitFor((state) => liveOf(state)?.startRequest?.state === 'failed');
    assert.ok(startStates(h.posted.slice(from), 'req_badfile', 'authorizing') >= 0);
    assert.match(liveOf(failed)?.startRequest?.error ?? '', /does not exist in this project\. Nothing was authorized\./);
    assert.equal(stored(h).grant, null);
    assert.equal(liveOf(failed)?.phase, 'plan_ready');
    const control = logic.missionStartControl({ requestId: 'req_badfile', at: Date.now() }, liveOf(failed) as MissionLiveView, Date.now());
    assert.equal(control.disabled, false);
    assert.match(control.error, /does not exist/);
  });
});

// ----- 3. A double click never starts twice -----

test('a double click (or the same message twice) starts the Mission once', async () => {
  await withHarness(async (h) => {
    const live = await createMission(h);
    h.model.enqueue(writeA('w', 'final', null), runTests('t'), { kind: 'json', body: assistantText('Done.') });
    const from = h.posted.length;
    h.send(startMessage(live, 'req_first01'));
    h.send(startMessage(live, 'req_second1'));
    h.send(startMessage(live, 'req_first01'));
    await h.waitFor((state) => liveOf(state)?.phase === 'completed', 8000);
    // Let any late message settle.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const record = stored(h);
    assert.equal(record.status, 'completed');
    assert.equal(record.auto?.runs, 1, 'one loop, one internal run');
    assert.equal(h.model.requests.length, 3, 'one run of model calls only');
    const states = h.posted.slice(from);
    assert.equal(startStates(states, 'req_second1', 'authorizing'), -1, 'the second click never became a request');
    // Without the guard the extra clicks would be refused later by the revision check, but the
    // user would see a false "changed in another window" error.
    assert.ok(!states.some((state) => /The Mission changed|already running/.test(String(state.status))), 'and never surfaced an error');
    const turns = (h.last().turns as Array<{ text?: string }>).filter((turn) => turn.text === 'Mission completed and verified by the host.');
    assert.equal(turns.length, 1, 'one final report');
  });
});

// ----- 4. A rebuilt view recovers Running -----

test('a view rebuilt during authorization shows Authorizing or Running from the host, never the start button', async () => {
  await withHarness(async (h) => {
    const live = await createMission(h);
    h.model.enqueue({ kind: 'hang' });
    h.send(startMessage(live, 'req_reload1'));
    const rebuiltAt = h.posted.length;
    h.rebuildView();
    const running = await h.waitFor((state) => liveOf(state)?.phase === 'running' && liveOf(state)?.step !== null, 6000).catch((error: Error) => {
      throw new Error(`${error.message}; last card: ${JSON.stringify(liveOf(h.last()))}; active ${String(h.last().activeThreadId)}`);
    });
    const after = h.posted.slice(rebuiltAt).map(liveOf).filter((entry): entry is MissionLiveView => entry !== null);
    assert.ok(after.length > 0);
    for (const entry of after) {
      assert.ok(['authorizing', 'running'].includes(entry.phase), entry.phase);
      assert.equal(entry.canStart, false);
      // The rebuilt page has no click of its own: it follows the host.
      const control = logic.missionStartControl(null, entry, Date.now());
      assert.ok(control.pending || !control.visible, `phase ${entry.phase} must not offer the button`);
    }
    assert.equal(liveOf(running)?.internalRun, 1);
    // A full window reload (new extension host) finds the grant and shows Interrupted, still no start button.
    h.provider.dispose();
    h.createProvider();
    h.send({ type: 'openThread', threadId: live.threadId });
    const reloaded = await h.waitFor((state) => liveOf(state)?.missionId === live.missionId && liveOf(state)?.phase === 'interrupted');
    assert.equal(liveOf(reloaded)?.canStart, false);
    assert.equal(liveOf(reloaded)?.canResume, true);
  });
});

// ----- 5. A created plan is never "Completed" -----

test('a created plan is "Plan ready — awaiting authorization", never "Completed"', async () => {
  await withHarness(async (h) => {
    const from = h.posted.length;
    const live = await createMission(h);
    const state = h.last();
    assert.equal(state.connection, 'verified');
    assert.equal(state.runKind, 'mission-plan');
    assert.equal(live.phase, 'plan_ready');
    assert.equal(live.canStart, true);
    const label = logic.runOutcomeLabel(state as unknown as Record<string, unknown>, 'completed', state.activeThreadId as string);
    assert.equal(label?.text, 'Plan ready — awaiting authorization');
    for (const posted of h.posted.slice(from)) {
      assert.notEqual(liveOf(posted)?.phase, 'completed');
      const shown = logic.runOutcomeLabel(posted as unknown as Record<string, unknown>, posted.connection === 'verified' ? 'completed' : null, posted.activeThreadId as string);
      assert.ok(shown === null || !/^Completed/.test(shown.text), `shown: ${shown?.text}`);
    }
    // While the plan is requested, the card says Planning.
    assert.ok(h.posted.slice(from).some((posted) => liveOf(posted)?.phase === 'planning'));
    assert.match(String(state.status), /review it and authorize it in the Mission card of this thread/);
  });
  // A mission request that produced no plan says so, not "Completed".
  await withHarness(async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText('Here is a plan in prose only.') });
    await h.provider.sendMessage('Make check.test.js pass.', 'mission', 'local');
    const state = h.last();
    assert.equal(state.runKind, 'mission-plan');
    assert.equal(liveOf(state), null);
    const label = logic.runOutcomeLabel(state as unknown as Record<string, unknown>, 'completed', state.activeThreadId as string);
    assert.equal(label?.text, 'No Mission plan was created; see the reply');
  });
  // Pure: an active Mission without a grant is a plan; with a grant and no driver it was cut short.
  const base = { status: 'active', grant: null } as unknown as MissionRecord;
  const quiet = { driving: false, authorizing: false, manualTask: false, runningElsewhere: false };
  assert.equal(missionPhase(base, quiet), 'plan_ready');
  assert.equal(missionPhase({ ...base, grant: {} } as unknown as MissionRecord, quiet), 'interrupted');
  assert.equal(missionPhase(base, { ...quiet, authorizing: true }), 'authorizing');
  assert.ok(!/Completed/.test(logic.MISSION_PHASE_LABELS.plan_ready as string));
});

// ----- 6. Progress moves -----

test('the live card follows the Mission: internal run, step, last test, acceptance state, and time move', async () => {
  await withHarness(async (h) => {
    const live = await createMission(h);
    h.model.enqueue(
      writeA('w1', 'draft', null),
      runTests('t1'),
      { kind: 'json', body: assistantText('Done, npm:test passes.') },
      writeA('w2', 'final', 'draft'),
      runTests('t2'),
      { kind: 'json', body: assistantText('Done.') },
    );
    const from = h.posted.length;
    h.send(startMessage(live, 'req_progres', { acceptanceCommand: 'npm:check', acceptanceFiles: ['acceptance/accept.test.js'] }));
    await h.waitFor((state) => liveOf(state)?.phase === 'completed', 10000);
    const lives = h.posted.slice(from).map(liveOf).filter((entry): entry is MissionLiveView => entry !== null);
    const running = lives.filter((entry) => entry.phase === 'running');
    const runs = new Set(running.map((entry) => entry.internalRun));
    assert.ok(runs.has(1) && runs.has(2), `internal runs seen: ${[...runs].join(',')}`);
    const firstRunSteps = running.filter((entry) => entry.internalRun === 1 && entry.step !== null).map((entry) => entry.step as number);
    assert.ok(new Set(firstRunSteps).size >= 2, `steps seen: ${firstRunSteps.join(',')}`);
    assert.ok(firstRunSteps.every((step, index) => index === 0 || step >= (firstRunSteps[index - 1] as number)), 'steps only move forward within a run');
    assert.ok(running.some((entry) => /run_tests npm:test → exit=0/.test(entry.lastTest)), 'the last test appears');
    assert.ok(new Set(lives.map((entry) => entry.lastProgress)).size >= 2, 'the last progress changes');
    assert.ok(lives.some((entry) => entry.acceptance?.state === 'failed'), 'the failed acceptance run is shown');
    const done = lives[lives.length - 1] as MissionLiveView;
    assert.equal(done.acceptance?.state, 'passed');
    assert.ok(done.startedAt !== null && done.endedAt !== null && done.endedAt >= done.startedAt, 'the clock stops at the end');
    assert.equal(new Set(running.map((entry) => entry.startedAt)).size, 1, 'the clock starts once, at authorization');
  }, true);
});

// ----- 7. The final report only after acceptance exit=0 -----

test('the final report appears only after the host\'s acceptance run exited 0', async () => {
  await withHarness(async (h) => {
    const live = await createMission(h);
    h.model.enqueue(
      writeA('w1', 'draft', null),
      runTests('t1'),
      { kind: 'json', body: assistantText('Done, npm:test passes.') },
      writeA('w2', 'final', 'draft'),
      runTests('t2'),
      { kind: 'json', body: assistantText('Done.') },
    );
    const from = h.posted.length;
    h.send(startMessage(live, 'req_report1', { acceptanceCommand: 'npm:check', acceptanceFiles: ['acceptance/accept.test.js'] }));
    await h.waitFor((state) => liveOf(state)?.phase === 'completed', 10000);
    const states = h.posted.slice(from);
    const firstReport = states.findIndex((state) => liveOf(state)?.report != null);
    assert.ok(firstReport > 0);
    for (const state of states.slice(0, firstReport)) {
      assert.notEqual(liveOf(state)?.acceptance?.state, 'passed', 'no report while the acceptance had not passed');
      const finals = (state.turns as Array<{ text?: string }>).filter((turn) => turn.text === 'Mission completed and verified by the host.');
      assert.equal(finals.length, 0);
    }
    assert.ok(states.slice(0, firstReport).some((state) => liveOf(state)?.acceptance?.state === 'failed'), 'the first acceptance run failed first');
    const report = liveOf(states[firstReport])?.report;
    assert.ok(report);
    assert.equal(liveOf(states[firstReport])?.acceptance?.state, 'passed');
    assert.deepEqual(report.files, ['a.txt']);
    assert.equal(report.tests.length, 2);
    assert.ok(report.tests.every((line) => /exit=0/.test(line)));
    assert.match(report.acceptance, /^npm:check — npm:check exit=0 with every frozen file intact \(frozen: acceptance\/accept\.test\.js, package\.json\)$/);
    assert.equal(report.internalRuns, 2);
    assert.match(report.models[0] as string, /local-glimmer \(Muse Glimmer — Local\)/);
    assert.equal(report.metaConsultations, 'none allowed');
    const record = (h.last().turns.at(-1) as { text: string; hostRecord: string[] });
    assert.equal(record.text, 'Mission completed and verified by the host.');
    const lines = record.hostRecord.join('\n');
    assert.match(lines, /mission: tests run run_tests npm:test → exit=0/);
    assert.match(lines, /mission: models local-glimmer \(Muse Glimmer — Local\); Meta consultations none allowed/);
    assert.match(lines, /mission: no sandbox: test scripts ran with your user permissions/);
    assert.match(lines, /mission: time [\d.]+ min since authorization/);
  }, true);
  // Pure: a completed record whose last acceptance run failed, or a tampered one, has no report.
  const completed = {
    status: 'completed',
    note: '',
    tasks: [{ title: 'T', status: 'completed', runs: 1 }],
    evidence: [{ taskId: 't', kind: 'note', text: 'acceptance (run by the host): npm:check exit=1 with every frozen file intact', at: 1 }],
    taskRunsUsed: 1,
    createdAt: 1,
    updatedAt: 2,
    grant: { model: 'm', grantedAt: 1, escalation: null, acceptance: { commandId: 'npm:check', packageJsonHash: 'x', files: [{ path: 'a.test.js', hash: 'h' }] } },
  } as unknown as MissionRecord;
  assert.equal(acceptanceState(completed).state, 'failed');
  assert.equal(missionFinalReport(completed), null);
  const tampered = { ...completed, status: 'blocked', note: 'Blocked: the acceptance check can no longer be trusted: a.test.js changed.' } as MissionRecord;
  assert.equal(acceptanceState(tampered).state, 'tampered');
  assert.equal(missionFinalReport(tampered), null);
  const passed = { ...completed, evidence: [{ ...completed.evidence[0], text: 'acceptance (run by the host): npm:check exit=0 with every frozen file intact' }] } as MissionRecord;
  assert.ok(missionFinalReport(passed));
  const standard = { ...completed, evidence: [], grant: { ...completed.grant, acceptance: null } } as unknown as MissionRecord;
  assert.ok(missionFinalReport(standard), 'a Standard Mission reports after its project tests');
});

// ----- Layout, accessibility, version -----

function html(): string {
  return buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js' });
}

test('Settings is split into exclusive cards with Models separate from Runtime', () => {
  const doc = html();
  const settings = doc.slice(doc.indexOf('id="settingsScreen"'));
  const cards = [...settings.matchAll(/<details class="settings-card" id="(card\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(cards, ['cardGeneral', 'cardModels', 'cardRuntime', 'cardMission', 'cardMemory', 'cardSecurity', 'cardAdvanced', 'cardAbout']);
  const nav = settings.slice(settings.indexOf('<nav id="settingsNav"'), settings.indexOf('</nav>'));
  assert.deepEqual([...nav.matchAll(/data-card="(card\w+)"/g)].map((match) => match[1]), cards);
  assert.match(nav, /aria-label="Settings sections"/);
  for (const id of cards) {
    const summary = new RegExp(`id="${id}"[^>]*>\\s*<summary><span class="card-title">[^<]+</span> <span class="card-summary" id="summary\\w+"></span></summary>`);
    assert.match(settings, summary, id);
  }
  assert.ok(settings.indexOf('id="backToChat"') < settings.indexOf('id="settingsNav"'), 'Back stays in the sticky header');
  assert.match(doc, /#settingsNav \{ position: sticky;/);
  assert.match(settings, /id="cardModels" hidden/);
  assert.match(settings, /id="cardRuntime" hidden/);
  assert.ok(settings.indexOf('id="cloudSection"') < settings.indexOf('id="cardRuntime"'), 'cloud models live in Models');
  assert.ok(settings.indexOf('id="localSection"') > settings.indexOf('id="cardRuntime"'), 'llama-server lives in Runtime');
  // The complete start grant lives in the thread card; Settings only follows an existing Mission.
  assert.ok(!settings.includes('id="missionStart"'));
  assert.ok(!settings.includes('id="missionConsults"'));
  assert.ok(settings.includes('id="missionOpenThread"'));
  // Every section that existed is still there.
  for (const id of ['languageSelect', 'runtimeSelect', 'generationSection', 'cloudSection', 'localSection', 'memorySection', 'missionSection', 'escalationSection', 'generationAdvanced', 'diagnostics', 'aboutFacts']) {
    assert.ok(settings.includes(`id="${id}"`), id);
  }
  const navigation = readFileSync('media/settingsTabs.js', 'utf8');
  assert.match(navigation, /cards\[index\]\.hidden = cards\[index\] !== card/);
  assert.doesNotMatch(navigation, /scrollIntoView/);
});

test('the Mission card is in the thread, keyboard reachable, and announces with aria-live', () => {
  const doc = html();
  const chat = doc.slice(doc.indexOf('id="conversationSection"'), doc.indexOf('id="settingsScreen"'));
  for (const id of ['missionCard', 'missionPhase', 'missionFacts', 'missionSetup', 'missionStart', 'missionPause', 'missionCancel', 'missionReport', 'missionAdvancedVerification']) {
    assert.ok(chat.includes(`id="${id}"`), id);
  }
  assert.match(chat, /<h3 id="missionCardHeading" tabindex="-1">Mission<\/h3>/);
  assert.match(chat, /<p id="missionPhase" class="mission-phase" role="status" aria-live="polite"><\/p>/);
  assert.match(chat, /<p id="missionStartNote" class="mission-note" role="status" aria-live="polite" hidden><\/p>/);
  assert.match(chat, /<p id="missionStartError" class="mission-error" role="alert" hidden><\/p>/);
  // Two levels, as radio buttons with a legend; the file choice is a checkbox list, not a comma field.
  assert.match(chat, /<legend>Verification level<\/legend>/);
  assert.match(chat, /id="missionLevelStandard" value="standard" checked> Standard Mission/);
  assert.match(chat, /id="missionLevelVerified" value="verified"> Verified Mission/);
  assert.match(chat, /<div id="missionAcceptanceList" class="file-picker" role="group" aria-label="Acceptance files"><\/div>/);
  assert.match(chat, /<fieldset id="missionConsultRow" hidden>/);
  assert.match(chat, /<select id="missionConsults" aria-label="Maximum Meta consultations">/);
  assert.match(chat, /<option value="0">0 — off<\/option>/);
  assert.match(chat, /<option value="1" selected>1<\/option>/);
  assert.match(chat, /id="missionConsultSummary" class="hint" role="status" aria-live="polite"/);
  assert.ok(chat.indexOf('id="missionConsultRow"') < chat.indexOf('id="missionStart"'), 'the advisory grant is reviewed before authorization');
  assert.match(doc, /#missionSetup \{ display: flex; flex-direction: column; gap: 12px;/);
  assert.match(doc, /#missionLevel \{ display: flex; flex-direction: column; gap: 6px; padding: 10px; \}/);
  assert.match(doc, /#missionVerifiedRow \{ display: flex; flex-direction: column; gap: 9px;/);
  assert.match(doc, /#missionConsultRow \{ display: flex; flex-direction: column; gap: 8px;/);
  assert.match(doc, /#missionSandboxWarning \{ padding: 8px 10px; border-left: 3px solid/);
  assert.ok(!/comma-separated/.test(doc));
  // The warnings stay.
  assert.ok(chat.includes('id="missionSandboxWarning"'));
  assert.ok(chat.includes('id="missionDependenciesNote"'));
  const remote = readFileSync('media/remoteUx.js', 'utf8');
  assert.match(remote, /function renderMissionGrant\(data\)/);
  assert.match(remote, /data\.allowCloudEscalation === true && data\.hasKey === true/);
  assert.match(remote, /Selected: up to \{0\} Meta consultation\(s\) · \{1\} · \{2\}/);
  assert.match(remote, /renderRuntime\(data\);[\s\S]*renderMissionGrant\(data\);/);
});

test('the start card offers the detected scripts and test files, and names what will be hashed', async () => {
  await withHarness(async (h) => {
    await h.writeFile('node_modules/dep/index.test.js', '');
    await h.writeFile('.env', 'SECRET=1');
    const live = await createMission(h);
    assert.deepEqual(live.setup?.testCommands, ['npm:test', 'npm:check'], 'in package.json order');
    assert.deepEqual(live.setup?.candidates, ['acceptance/accept.test.js', 'check.test.js'], 'never node_modules or protected files');
    assert.deepEqual(live.setup?.environmentFiles, []);
    assert.equal(live.setup?.packageJsonHash, sha(await h.readFile('package.json')));
  }, true);
  const summary = extractFunction('renderFrozenSummary');
  assert.match(summary, /Checked by hash when you authorize: \{0\}\. RAME Code\\'s tools will not modify node_modules \(not hashed\)\./);
});

test('the version and build come from build-info; only a verified release says "release"', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-build-info-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  assert.deepEqual(readBuildInfo(root), { version: '1.2.3', revision: 'unknown', channel: 'candidate' });
  mkdirSync(path.join(root, 'out'));
  writeFileSync(path.join(root, 'out', 'build-info.json'), JSON.stringify({ version: '1.2.3', revision: 'abc1234.src.0123456789ab', channel: 'release' }));
  assert.deepEqual(readBuildInfo(root), { version: '1.2.3', revision: 'abc1234.src.0123456789ab', channel: 'release' });
  writeFileSync(path.join(root, 'out', 'build-info.json'), JSON.stringify({ version: '1.2.2', revision: 'abc <script>', channel: 'release' }));
  assert.deepEqual(readBuildInfo(root), { version: '1.2.3', revision: 'unknown', channel: 'candidate' }, 'another version or a bad revision claims nothing');
  // The build of this tree: a dirty tree is never a release.
  const info = JSON.parse(readFileSync('out/build-info.json', 'utf8')) as { version: string; revision: string; channel: string };
  assert.equal(info.version, JSON.parse(readFileSync('package.json', 'utf8')).version);
  if (info.revision.includes('-dirty') || !/^[0-9a-f]{7}\./.test(info.revision)) {
    assert.equal(info.channel, 'candidate');
  }
  assert.match(html(), /<span id="versionBadge" class="version-chip" title="Public version"><\/span>/);
});
