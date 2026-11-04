/**
 * An empty-project Mission never loops on a blocked test (human validation of
 * src.2f737eddcab9: Muse Glimmer created calculator.js, test_calculator.js and
 * package.json, then spent 26 inferences retrying run_tests, always "blocked
 * by policy: That test command is not allowlisted").
 *
 *   - In the first (bootstrap) stage no test runs: that is the policy, kept.
 *     The model is told why and not to retry; the host record says the same.
 *   - The common test file names (test_*.js, *_test.js) and the files the
 *     "test" script names end the first stage: the Mission stops and asks
 *     for the verification authorization.
 *   - If the scaffold still cannot be reviewed, the Mission stops and says
 *     what is missing, instead of spending more internal runs.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { BOOTSTRAP_TESTS_WAIT, MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { assistantText, HostHarness, toolCallReply } from './helpers/hostHarness.js';

const EMPTY = createHash('sha256').update('', 'utf8').digest('hex');
const PLAN = {
  goal: 'Create a minimal JavaScript calculator with tests and verify it.',
  assumptions: [],
  steps: [{ id: 'build', title: 'Create calculator source and test files', successCriterion: 'npm:test passes' }],
  risks: [],
};
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord);
type Message = { role: string; content: string | null; tool_call_id?: string };
const toolResult = (h: HostHarness, id: string): string =>
  String(h.model.requests.flatMap((request) => request.messages as Message[]).find((message) => message.tool_call_id === id)?.content ?? '');

async function startEmptyMission(h: HostHarness): Promise<MissionRecord> {
  h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: PLAN }]) });
  await h.provider.sendMessage('Create a minimal JavaScript calculator with tests. Do not use Meta.', 'mission', 'local');
  return stored(h);
}

const scaffold = (testFile: string, script: string) => ({
  kind: 'json' as const,
  body: toolCallReply([{
    id: 'files',
    name: 'apply_patch',
    args: {
      files: [
        { path: 'calculator.js', expectedHash: EMPTY, newContent: 'module.exports = { add: (a, b) => a + b };\n' },
        { path: testFile, expectedHash: EMPTY, newContent: "const assert = require('node:assert');\nconst { add } = require('./calculator.js');\nassert.equal(add(2, 3), 5);\nassert.equal(add(-2, -3), -5);\n" },
        { path: 'package.json', expectedHash: EMPTY, newContent: JSON.stringify({ name: 'calculator', version: '1.0.0', scripts: { test: script } }) },
      ],
    },
  }]),
});

test('the reported case: test_calculator.js ends the first stage; the early test is refused once with a clear reason, never retried in a loop', async () => {
  const h = new HostHarness({ folders: 1 });
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    const mission = await startEmptyMission(h);
    h.model.enqueue(
      scaffold('test_calculator.js', 'node test_calculator.js'),
      { kind: 'json', body: toolCallReply([{ id: 'early', name: 'run_tests', args: { commandId: 'npm:test' } }]) },
      { kind: 'json', body: assistantText('Scaffold ready for review.') },
    );
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const after = stored(h);
    assert.equal(after.awaitingVerification, true, 'the Mission stopped for the verification authorization');
    assert.equal(after.grant, null, 'the first-stage grant is revoked');
    assert.match(after.note, /Review the new test command and files/);
    assert.ok(after.evidence.some((entry) => /bootstrap scaffold ready: review npm:test and test_calculator\.js/.test(entry.text)), 'test_calculator.js is offered for review');
    assert.match(toolResult(h, 'early'), /^Not run: tests wait for the verification stage.*Do not call run_tests again in this Mission stage/);
    assert.equal(after.evidence.some((entry) => /run_tests .*exit=/.test(entry.text)), false, 'no test ran before the authorization');
    assert.ok(h.model.requests.length <= 6, `bounded (the reported run spent 26): ${h.model.requests.length} inference(s)`);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('a test file the "test" script names is offered for review too', async () => {
  const h = new HostHarness({ folders: 1 });
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    const mission = await startEmptyMission(h);
    h.model.enqueue(scaffold('checks.js', 'node checks.js'), { kind: 'json', body: assistantText('Ready.') });
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const after = stored(h);
    assert.equal(after.awaitingVerification, true);
    assert.ok(after.evidence.some((entry) => /bootstrap scaffold ready: review npm:test and checks\.js/.test(entry.text)));
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('a scaffold that cannot be reviewed: the Mission stops and says what is missing, instead of retrying', async () => {
  const h = new HostHarness({ folders: 1 });
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    const mission = await startEmptyMission(h);
    // No package.json: no test command can be reviewed. The model asks for a test anyway, many times.
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'src', name: 'apply_patch', args: { files: [{ path: 'calculator.js', expectedHash: EMPTY, newContent: 'module.exports = {};\n' }] } }]) },
      ...Array.from({ length: 12 }, (_, index) => ({ kind: 'json' as const, body: toolCallReply([{ id: `t${index}`, name: 'run_tests', args: { commandId: 'npm:test' } }]) })),
    );
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const after = stored(h);
    assert.equal(after.status, 'blocked');
    assert.match(after.note, /The scaffold is not ready for review: it still needs a "test" script in package\.json and a test file RAME can show you for review/);
    assert.match(after.note, /Tests only run after you review and authorize them, so the Mission stopped instead of retrying/);
    assert.ok(after.taskRunsUsed <= 1, `stopped after the first internal run (${after.taskRunsUsed})`);
    assert.ok(after.evidence.some((entry) => entry.text.includes(BOOTSTRAP_TESTS_WAIT.slice(0, 40))), 'the reason is on record');
    assert.equal(h.last().running, false);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('the view: a pending authorization names its stage, is announced at the message box, and is brought into view once (EN/ES)', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  type Node = { hidden: boolean; textContent: string; scrolled: number; classes: Set<string>; listeners: Array<() => void> };
  const nodes: Record<string, Node> = {};
  const node = (): Node => {
    const made: Node = { hidden: false, textContent: '', scrolled: 0, classes: new Set(), listeners: [] };
    return Object.assign(made, {
      attributes: {}, dataset: {}, firstChild: null,
      classList: { add: (n: string) => made.classes.add(n), remove: (n: string) => made.classes.delete(n), contains: (n: string) => made.classes.has(n) },
      setAttribute() {}, getAttribute: () => null, hasAttribute: () => false, removeAttribute() {},
      addEventListener(_t: string, listener: () => void) { made.listeners.push(listener); },
      scrollIntoView() { made.scrolled += 1; }, focus() {}, appendChild() {}, removeChild() {}, closest: () => null,
      options: [], querySelector: () => null, querySelectorAll: () => [],
    });
  };
  const context = { window: {} as Record<string, unknown>, document: { getElementById: (id: string) => (nodes[id] ??= node()), createElement: () => node(), addEventListener() {}, querySelectorAll: () => [] }, setTimeout, clearTimeout };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/localServersUx.js', 'utf8'), context);
  const remote = context.window.RAME_REMOTE as { init(h: unknown): void; render(data: unknown): void };
  const i18n = context.window.RAME_I18N as { translate(language: string, text: string): string };
  let language = 'en';
  const t = (text: string) => (language === 'en' ? text : i18n.translate('es', text));
  const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), t(text));
  remote.init({ vscode: { postMessage() {} }, t, tf, tHost: t, markPending: () => true, hold() {} });
  const render = async (setup: Record<string, unknown> | null, setupVisible: boolean) => {
    nodes.missionSetup = nodes.missionSetup ?? node();
    nodes.missionSetup.hidden = !setupVisible;
    remote.render({ activeThreadId: 't', missionLive: { threadId: 't', missionId: 'mis_1', setup }, connection: 'ready', escalation: { pending: false, reason: '' }, remote: { consult: null, delegation: null, delegationFailure: null, localIssue: null, runtime: { local: 'connected', cloud: 'configured', selected: 'local' } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await render({ bootstrap: true, awaitingVerification: false }, true);
  assert.equal(nodes.missionStart.textContent, 'Authorize stage 1 of 2: create the files');
  assert.equal(nodes.authorizationPending.hidden, false);
  assert.equal(nodes.authorizationPendingText.textContent, 'Authorization needed — stage 1 of 2: create the project files (no test runs yet).');
  assert.equal(nodes.missionStart.scrolled, 1, 'brought into view');
  await render({ bootstrap: true, awaitingVerification: false }, true);
  assert.equal(nodes.missionStart.scrolled, 1, 'not pulled again for the same authorization');
  // Authorized: the card closes, nothing waits, nothing to press again.
  await render({ bootstrap: true, awaitingVerification: false }, false);
  assert.equal(nodes.authorizationPending.hidden, true);
  // The second stage is a different authorization, said so, and brought into view.
  await render({ bootstrap: false, awaitingVerification: true, createdFiles: ['calculator.js'], testCommands: ['npm:test'], candidates: ['calculator.test.js'] }, true);
  assert.equal(nodes.missionStart.textContent, 'Authorize stage 2 of 2: run the tests and continue');
  assert.equal(nodes.authorizationPendingText.textContent, 'Authorization needed — stage 2 of 2: run the new tests. Stage 1 is done.');
  assert.equal(nodes.missionStart.scrolled, 2);
  assert.ok(nodes.missionSetup.classes.has('needs-authorization'), 'highlighted');
  nodes.authorizationPendingReview.listeners.forEach((listener) => listener());
  assert.equal(nodes.missionStart.scrolled, 3, 'Review brings it back into view');
  language = 'es';
  await render({ bootstrap: false, awaitingVerification: true, createdFiles: ['calculator.js'], testCommands: ['npm:test'], candidates: ['calculator.test.js'] }, true);
  assert.equal(nodes.missionStart.textContent, 'Autorizar fase 2 de 2: ejecutar las pruebas y continuar');
  assert.equal(nodes.authorizationPendingText.textContent, 'Autorización necesaria — fase 2 de 2: ejecutar las pruebas nuevas. La fase 1 ya está hecha.');
});

test('the view: the current task reads "Task 2 of 2: …" (EN/ES)', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const dd = { textContent: 'Run tests after authorization and report results (1 of 2 done)' };
  let language = 'en';
  const dt = { get textContent() { return language === 'en' ? 'Current task' : 'Tarea actual'; }, nextElementSibling: dd };
  const plain = () => ({ hidden: false, textContent: '', classList: { add() {}, remove() {}, contains: () => false }, setAttribute() {}, getAttribute: () => null, addEventListener() {}, appendChild() {}, removeChild() {}, querySelectorAll: () => [], options: [] });
  const nodes: Record<string, unknown> = { missionFacts: { querySelectorAll: (selector: string) => (selector === 'dt' ? [dt] : []), appendChild() {}, removeChild() {}, firstChild: null } };
  const context = { window: {} as Record<string, unknown>, document: { getElementById: (id: string) => (nodes[id] ??= plain()), createElement: () => plain(), addEventListener() {}, querySelectorAll: () => [] }, setTimeout, clearTimeout };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/localServersUx.js', 'utf8'), context);
  const remote = context.window.RAME_REMOTE as { init(h: unknown): void; render(data: unknown): void };
  const i18n = context.window.RAME_I18N as { translate(language: string, text: string): string };
  const t = (text: string) => (language === 'en' ? text : i18n.translate('es', text));
  const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), t(text));
  remote.init({ vscode: { postMessage() {} }, t, tf, tHost: t, markPending: () => true, hold() {} });
  const data = { activeThreadId: 't', missionLive: { threadId: 't', missionId: 'mis_1', currentTask: 'Run tests after authorization and report results', tasksDone: 1, tasksTotal: 2, setup: null }, connection: 'ready', escalation: { pending: false, reason: '' }, remote: { consult: null, delegation: null, delegationFailure: null, localIssue: null, runtime: { local: 'connected', cloud: 'configured', selected: 'local' } } };
  remote.render(data);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dd.textContent, 'Task 2 of 2: Run tests after authorization and report results');
  language = 'es';
  remote.render(data);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(dd.textContent, 'Tarea 2 de 2: Run tests after authorization and report results');
});
