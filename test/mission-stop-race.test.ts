/**
 * Stopping a Mission between two internal runs (2026-11-08). Under load,
 * `mission-causal-verification` hung: its Cancel landed after the host had
 * checked for a stop and before the next internal run had a request to
 * abort (while the host saved the run's start, or while the Agent prepared
 * it). The stop was recorded but nothing looked at it again: the run
 * started anyway, so a Mission the user cancelled kept working, and here
 * waited forever on an approval nobody would give.
 *
 * Deterministic: the stop is pressed exactly when the host has saved the
 * start of the second run, before that run sends anything.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { assistantText, HostHarness, toolCallReply } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;

for (const kind of ['cancel', 'pause'] as const) {
  test(`${kind} pressed between two internal runs, after the host checked for a stop and before the next run sent anything, is honoured: that run sends nothing and the Mission is ${kind === 'cancel' ? 'cancelled' : 'paused'}`, async () => {
    const h = new HostHarness();
    await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
    try {
      await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { check: 'node c.js' } }));
      await h.writeFile('c.js', 'process.exit(1);\n');
      h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: { goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'Make npm:check pass', successCriterion: 'npm:check passes' }], risks: [] } }]) });
      await h.provider.sendMessage('Make npm:check pass.', 'mission', 'local');
      const mission = stored(h);
      h.model.requests.length = 0;
      h.model.enqueue(
        // Run 1: a change, the failing check, a report.
        tool('w1', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: sha(''), newContent: 'draft' }] }),
        tool('c1', 'run_tests', { commandId: 'npm:check' }),
        { kind: 'json', body: assistantText('Done.') },
        // Run 2 must never get here; if it did, it would wait forever.
        { kind: 'hang' },
      );
      // The user presses the button exactly when the host has saved the start of run 2.
      const store = h.provider.missions;
      const update = store.update.bind(store);
      let pressed = false;
      store.update = async (...args: Parameters<typeof update>) => {
        const result = await update(...args);
        if (!pressed && result.ok && result.value.status === 'active' && /\(run 2;/.test(result.value.note)) {
          pressed = true;
          await h.provider.stopMission(mission.id, kind);
        }
        return result;
      };
      const ran = h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true).then(() => 'ended');
      const outcome = await Promise.race([ran, new Promise((resolve) => setTimeout(() => resolve('still running after 15 s'), 15_000))]);
      assert.equal(pressed, true, 'the button was pressed in that window');
      assert.equal(outcome, 'ended', `the Mission stopped (${stored(h).status}: ${stored(h).note})`);
      assert.equal(stored(h).status, kind === 'cancel' ? 'cancelled' : 'paused', stored(h).note);
      assert.equal(h.model.requests.length, 3, 'run 2 sent nothing to the model');
      assert.equal(h.last().agentPending, null, 'no approval is left waiting');
    } finally {
      h.provider.cancelRequest();
      await h.dispose();
    }
  });
}
