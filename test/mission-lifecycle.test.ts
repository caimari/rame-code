/**
 * AUD-04: a host that is closed, reloaded or superseded starts nothing and
 * writes nothing at any of the Mission loop's pauses. Each barrier is tested
 * on its own (the loop's `live()` checks, D3; `updateActiveMission`, D4; the
 * agent's file system; `runAllowlistedTest`; `ChatRunner`), so that removing
 * one is caught even where another would also hold.
 *
 * SIMULATED: scripted model replies, disposable projects, no Meta.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { ChatRunner } from '../src/chatRunner.js';
import { updateActiveMission } from '../src/missionCoordinator.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { assistantText, fakeWindow, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const EMPTY = sha('');
const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });
const write = (id: string, file: string, content: string, before: string | null) => ({
  kind: 'json' as const,
  body: toolCallReply([{ id, name: 'apply_patch', args: { files: [{ path: file, expectedHash: before === null ? EMPTY : sha(before), newContent: content }] } }]),
});
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;
const notes = (h: HostHarness): string => stored(h).evidence.map((entry) => entry.text).join('\n');
interface MissionState { id: string; revision: number }
const missionOf = (state: PostedState): MissionState | null => ((state.memory as { mission: MissionState | null } | undefined)?.mission ?? null);
const PLAN = { goal: 'Implement add in lib/sum.js.', assumptions: [], steps: [{ id: 't1', title: 'Implement add', successCriterion: 'npm:check passes' }], risks: [] };
const FROZEN = { commandId: 'npm:check', files: ['acceptance/accept.test.js'] };
const SLOW_PASS = "const add = require('../lib/sum.js');\nrequire('node:assert').equal(add(2, 3), 5);\nsetTimeout(() => {}, 1500);\n";
const CORRECT = 'module.exports = (a, b) => a + b;\n';

async function withProject(accept: string, body: (h: HostHarness, mission: MissionState) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'lifecycle', private: true, scripts: { test: 'node own.test.js', check: 'node acceptance/accept.test.js' } }));
    await h.writeFile('own.test.js', 'process.exit(0);\n');
    await h.writeFile('acceptance/accept.test.js', accept);
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: PLAN }]) });
    await h.provider.sendMessage('Implement add in lib/sum.js.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const mission = missionOf(await h.waitFor((state) => missionOf(state) !== null)) as MissionState;
    h.model.requests.length = 0;
    fakeWindow.warningCalls.length = 0;
    fakeWindow.warningAnswers.length = 0;
    await body(h, mission);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

test('D3: another Mission loop takes over this host while the acceptance check runs: the old loop records nothing more', async () => {
  await withProject(SLOW_PASS, async (h, mission) => {
    h.model.enqueue(write('w', 'lib/sum.js', CORRECT, null), say('Done.'), say('Done, no test needed.'));
    const host = h.provider;
    const run = host.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
    await h.waitFor((state) => /^Running the acceptance check npm:check/.test(state.status), 20_000);
    // Not disposed: only the loop's own lifetime check (D3) can stop it here; updateActiveMission (D4) would write.
    host.missionAuto = { missionId: mission.id, stop: null, holdAutonomy: false };
    await run;
    try {
      assert.equal(host.disposed, false);
      assert.doesNotMatch(notes(h), /acceptance \(run by the host\)/, 'the superseded loop did not record the acceptance result');
      assert.notEqual(stored(h).status, 'completed');
    } finally {
      host.missionAuto = null;
    }
  });
});

test('D4: a disposed host writes no Mission state, even when called directly', async () => {
  await withProject(SLOW_PASS, async (h, mission) => {
    const host = h.provider;
    const before = JSON.stringify(h.memento.get(MISSION_STATE_KEY));
    host.activeMission = { id: mission.id, revision: stored(h).revision };
    host.dispose();
    let called = false;
    const wrote = await updateActiveMission(host, (draft) => {
      called = true;
      draft.note = 'written by a closed window';
      return { ok: true, value: draft };
    });
    assert.equal(wrote, false);
    assert.equal(called, false, 'the change is never even computed');
    assert.equal(JSON.stringify(h.memento.get(MISSION_STATE_KEY)), before);
    h.createProvider();
  });
});

test('a disposed host starts no test or acceptance process and no model request', async () => {
  await withProject(SLOW_PASS, async (h) => {
    const host = h.provider;
    const context = await host.testCommandContext(h.workspace);
    const command = context.allowlist.find((entry) => entry.id === 'npm:test');
    assert.ok(command);
    host.dispose();
    const output = await host.runAllowlistedTest(command, new AbortController().signal, h.workspace);
    assert.match(output, /^not started: this RAME Code window was closed or reloaded$/);
    assert.doesNotMatch(output, /^exit=/, 'no exit code, so never a pass');
    await assert.rejects(host.chatRunner.start(async () => 'sent'), /closed or reloaded; nothing was sent/);
    h.createProvider();
  });
});

test('ChatRunner.close() cancels the running call and refuses new ones', async () => {
  const runner = new ChatRunner();
  let aborted = false;
  const running = runner.start(({ signal }) => new Promise<string>((resolve) => signal.addEventListener('abort', () => {
    aborted = true;
    resolve('aborted');
  })));
  runner.close();
  assert.equal(await running, 'aborted');
  assert.equal(aborted, true);
  await assert.rejects(runner.start(async () => 'x'), /closed or reloaded/);
});

test('dispose() at the pause right after the agent run: nothing recorded, no acceptance run, no new request', async () => {
  await withProject(SLOW_PASS, async (h, mission) => {
    h.model.enqueue(write('w', 'lib/sum.js', CORRECT, null), say('Done.'), say('Done, no test needed.'), say('More.'));
    const host = h.provider;
    const original = host.testCommandContext.bind(host);
    let tests = 0;
    host.testCommandContext = async (root?: string) => {
      const value = await original(root);
      if (host.lastAgentOutcome !== null && host.activeMission !== null) {
        tests += 1;
        host.dispose();
      }
      return value;
    };
    const run = host.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
    await run;
    const requests = h.model.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(tests, 1, 'the loop reached the pause once');
    assert.doesNotMatch(notes(h), /internal run 1|acceptance \(run by the host\)/, 'the run was not recorded by the closed window');
    assert.equal(h.model.requests.length, requests);
    assert.notEqual(stored(h).status, 'completed');
    h.createProvider();
  });
});

test('dispose() while the scope review is open: the run is not counted and the scope is not widened', async () => {
  await withProject("const add = require('../lib/sum.js');\nrequire('node:assert').equal(add(2, 3), 5);\n", async (h, mission) => {
    await h.writeFile('lib/util.js', 'module.exports = 1;\n');
    h.model.enqueue(write('w', 'lib/sum.js', CORRECT, null), write('u', 'lib/util.js', 'module.exports = 2;\n', 'module.exports = 1;\n'), say('Done.'), say('Done, no test needed.'));
    const host = h.provider;
    const original = fakeWindow.showWarningMessage;
    fakeWindow.showWarningMessage = async (message: string, options?: { detail?: string }, ...actions: string[]) => {
      if (/^Count the acceptance check/.test(message)) {
        host.dispose();
      }
      return original.call(fakeWindow, message, options, ...actions);
    };
    try {
      await host.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
    } finally {
      fakeWindow.showWarningMessage = original;
    }
    assert.ok(fakeWindow.warningCalls.some((call) => /^Count the acceptance check/.test(call.message)), 'the review was shown');
    assert.notEqual(stored(h).status, 'completed');
    assert.deepEqual(stored(h).grant?.acceptance?.scope?.writable, []);
    assert.doesNotMatch(notes(h), /scope review: the user approved/);
    h.createProvider();
  });
});

test('dispose() while RAME observes the check at authorization: nothing is authorized', async () => {
  await withProject("setTimeout(() => {}, 1500);\n", async (h, mission) => {
    const host = h.provider;
    const run = host.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
    await h.waitFor((state) => /^Observing what the acceptance check/.test(state.status), 20_000);
    host.dispose();
    await run;
    assert.equal(stored(h).grant, null);
    h.createProvider();
  });
});

test('scope review approved: the run counts, and the approval is recorded as a new authorization', async () => {
  await withProject("const add = require('../lib/sum.js');\nrequire('node:assert').equal(add(2, 3), 5);\n", async (h, mission) => {
    await h.writeFile('lib/util.js', 'module.exports = 1;\n');
    h.model.enqueue(write('w', 'lib/sum.js', CORRECT, null), write('u', 'lib/util.js', 'module.exports = 2;\n', 'module.exports = 1;\n'), say('Done.'), say('Done, no test needed.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
    const review = fakeWindow.warningCalls.find((call) => /^Count the acceptance check npm:check with these changes\?$/.test(call.message));
    assert.ok(review);
    assert.match(review.detail, /lib\/util\.js \(changed\)/);
    assert.equal(stored(h).status, 'completed', notes(h));
    assert.deepEqual(stored(h).grant?.acceptance?.scope?.writable, ['lib/util.js']);
    assert.equal(stored(h).grant?.acceptance?.scope?.approvals, 1);
    assert.match(notes(h), /scope review: the user approved lib\/util\.js as writable after the check ran/);
  });
});
