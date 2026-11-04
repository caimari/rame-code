/**
 * S10b: when the host runs the frozen acceptance check itself. Every
 * condition is required; each one is varied alone here.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { hostVerifiesAcceptance } from '../src/missionCoordinator.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const mission = (overrides: { acceptance?: boolean; pending?: number } = {}): MissionRecord =>
  ({
    grant: overrides.acceptance === false ? { acceptance: null } : { acceptance: { commandId: 'npm:check', packageJsonHash: 'a'.repeat(64), files: [] } },
    tasks: [{ status: 'current' }, ...Array.from({ length: overrides.pending ?? 0 }, () => ({ status: 'pending' }))],
  }) as unknown as MissionRecord;
const done = { outcome: 'done' as const, uncertain: 0 };
const needs = { needs: true, verifierUpdate: { blockers: [], recoveries: [], notes: [] } };

test('the host runs the frozen check itself only when every condition holds', () => {
  assert.equal(hostVerifiesAcceptance(mission(), done, needs), true);
  assert.equal(hostVerifiesAcceptance(null, done, needs), false, 'no Mission');
  assert.equal(hostVerifiesAcceptance(mission({ acceptance: false }), done, needs), false, 'no frozen acceptance check');
  assert.equal(hostVerifiesAcceptance(mission({ pending: 1 }), done, needs), false, 'not the last task');
  assert.equal(hostVerifiesAcceptance(mission(), { ...done, outcome: 'stopped' as never }, needs), false, 'the run did not report done');
  assert.equal(hostVerifiesAcceptance(mission(), { ...done, uncertain: 1 }, needs), false, 'an action has an unknown result');
  assert.equal(hostVerifiesAcceptance(mission(), done, null), false, 'no assessment');
  assert.equal(hostVerifiesAcceptance(mission(), done, { ...needs, needs: false }), false, 'already verified: the normal path runs it');
  assert.equal(
    hostVerifiesAcceptance(mission(), done, { needs: true, verifierUpdate: { blockers: [{} as never], recoveries: [], notes: [] } }),
    false,
    'a blocking verifier is open',
  );
});

// ----- Cancelling while the host runs the check -----

test('cancelling while the host runs the frozen check stops the Mission cleanly: no error, no completion', async () => {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'slow', private: true, scripts: { test: 'node t.js', check: 'node acceptance/accept.test.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    // A check that takes long enough to be cancelled while it runs.
    // Slow only once the agent's output exists, so the observation at authorization is quick.
    await h.writeFile('acceptance/accept.test.js', "if (require('node:fs').existsSync('a.txt')) setTimeout(() => process.exit(0), 20000); else process.exit(1);\n");
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: { goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'T', successCriterion: 'npm:check passes' }], risks: [] } }]) });
    await h.provider.sendMessage('Make npm:check pass.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const shown = (await h.waitFor((state: PostedState) => (state.memory as { mission: unknown } | undefined)?.mission != null)).memory as { mission: { id: string; revision: number } };
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'w', name: 'apply_patch', args: { files: [{ path: 'a.txt', expectedHash: createHash('sha256').update('').digest('hex'), newContent: 'x' }] } }]) },
      { kind: 'json', body: assistantText('Done.') },
      { kind: 'json', body: assistantText('Done, no test needed.') },
    );
    const run = h.provider.startMission(shown.mission.id, shown.mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/accept.test.js'] });
    await h.waitFor((state: PostedState) => /^Running the acceptance check npm:check/.test(state.status), 20_000);
    await h.provider.stopMission(shown.mission.id, 'cancel');
    await assert.doesNotReject(run);
    const stored = (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;
    assert.equal(stored.status, 'cancelled', stored.note);
    assert.doesNotMatch(stored.evidence.map((entry) => entry.text).join('\n'), /acceptance \(run by the host\)/, 'a stopped run is not recorded as a result');
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

// ----- A disposed window never writes again -----

test('dispose() during a slow acceptance check: the old loop starts no new run and never performs the queued write', async () => {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'slow', private: true, scripts: { test: 'node t.js', check: 'node acceptance/accept.test.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    // Fails after 1.5 s: before the fix, a failed check made the old loop start another run.
    await h.writeFile('acceptance/accept.test.js', "if (require('node:fs').existsSync('a.txt')) setTimeout(() => process.exit(1), 1500); else process.exit(1);\n");
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: { goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'T', successCriterion: 'npm:check passes' }], risks: [] } }]) });
    await h.provider.sendMessage('Make npm:check pass.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const shown = (await h.waitFor((state: PostedState) => (state.memory as { mission: unknown } | undefined)?.mission != null)).memory as { mission: { id: string; revision: number } };
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'w1', name: 'apply_patch', args: { files: [{ path: 'a.txt', expectedHash: sha(''), newContent: 'v1' }] } }]) },
      { kind: 'json', body: assistantText('Done.') },
      // The engine asks once for a test before ending a run with a change; the agent declines.
      { kind: 'json', body: assistantText('Done, no test needed.') },
      // Queued for a next run that must never start in the disposed window.
      { kind: 'json', body: toolCallReply([{ id: 'w2', name: 'apply_patch', args: { files: [{ path: 'a.txt', expectedHash: sha('v1'), newContent: 'v2-from-the-old-window' }] } }]) },
      { kind: 'json', body: assistantText('Done again.') },
    );
    const old = h.provider;
    const run = old.startMission(shown.mission.id, shown.mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/accept.test.js'] });
    await h.waitFor((state: PostedState) => /^Running the acceptance check npm:check/.test(state.status), 20_000);
    assert.equal(await h.readFile('a.txt'), 'v1', 'the first run wrote v1 and ended');
    const requestsAtDispose = h.model.requests.length;
    const stateAtDispose = JSON.stringify(h.memento.get(MISSION_STATE_KEY));
    old.dispose();
    await assert.doesNotReject(run);
    // Let anything still scheduled by the old window run its course.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(await h.readFile('a.txt'), 'v1', 'the queued write never happened');
    assert.equal(h.model.requests.length, requestsAtDispose, 'no model call (no new internal run) after dispose');
    assert.equal(JSON.stringify(h.memento.get(MISSION_STATE_KEY)), stateAtDispose, 'the disposed window wrote no Mission state');
    // Any direct write from the old window is refused.
    await assert.rejects(old.agentFsFor(h.workspace).writeText('a.txt', 'late'), /closed or reloaded; nothing was written/);
    assert.equal(await h.readFile('a.txt'), 'v1');
    // The next window recovers the Mission from its checkpoint: it is still resumable, not failed.
    h.createProvider();
    const recovered = (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;
    assert.ok(['active', 'interrupted'].includes(recovered.status), recovered.status);
    assert.doesNotMatch(recovered.evidence.map((entry) => entry.text).join('\n'), /acceptance \(run by the host\)/, 'the aborted check was not recorded as a result');
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('Stop during the host\'s acceptance run (no pause or cancel of the Mission) leaves it interrupted, not failed', async () => {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'slow', private: true, scripts: { test: 'node t.js', check: 'node acceptance/accept.test.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await h.writeFile('acceptance/accept.test.js', "if (require('node:fs').existsSync('a.txt')) setTimeout(() => process.exit(1), 20000); else process.exit(1);\n");
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: { goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'T', successCriterion: 'npm:check passes' }], risks: [] } }]) });
    await h.provider.sendMessage('Make npm:check pass.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const shown = (await h.waitFor((state: PostedState) => (state.memory as { mission: unknown } | undefined)?.mission != null)).memory as { mission: { id: string; revision: number } };
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'w', name: 'apply_patch', args: { files: [{ path: 'a.txt', expectedHash: createHash('sha256').update('').digest('hex'), newContent: 'x' }] } }]) },
      { kind: 'json', body: assistantText('Done.') },
      { kind: 'json', body: assistantText('Done, no test needed.') },
    );
    const run = h.provider.startMission(shown.mission.id, shown.mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/accept.test.js'] });
    await h.waitFor((state: PostedState) => /^Running the acceptance check npm:check/.test(state.status), 20_000);
    h.provider.cancelRequest();
    await assert.doesNotReject(run);
    const stored = (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;
    assert.equal(stored.status, 'interrupted', stored.note);
    assert.match(stored.note, /The acceptance check npm:check was interrupted before it finished; nothing was concluded from it\./);
    assert.doesNotMatch(stored.evidence.map((entry) => entry.text).join('\n'), /acceptance \(run by the host\)/, 'not recorded as a failed check');
    assert.equal(stored.auto?.acceptanceFeedback ?? '', '', 'no "acceptance failed" feedback for the next run');
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});
