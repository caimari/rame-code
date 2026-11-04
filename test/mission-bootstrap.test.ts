/** Empty-project Missions use two explicit grants: scaffold, then verify. */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { assistantText, HostHarness, toolCallReply } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const EMPTY = sha('');
const PLAN = {
  goal: 'Create a tiny calculator project and prove it works.',
  assumptions: [],
  steps: [{ id: 'build', title: 'Create and verify the calculator', successCriterion: 'npm:test passes' }],
  risks: [],
};

const stored = (h: HostHarness): MissionRecord =>
  ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord);

test('the authorization card explains both bootstrap stages in English and Spanish', () => {
  const html = readFileSync(path.join(process.cwd(), 'src/viewHtml.ts'), 'utf8');
  const ux = readFileSync(path.join(process.cwd(), 'media/remoteUx.js'), 'utf8');
  assert.match(html, /id="missionBootstrapNote"[^>]+aria-live="polite" hidden/);
  assert.match(ux, /setup\.bootstrap/);
  assert.match(ux, /verified\.disabled = bootstrap/);
  assert.match(ux, /Bootstrap Mission: this folder has no usable test setup yet/);
  assert.match(ux, /Misión de arranque: esta carpeta todavía no tiene pruebas utilizables/);
  assert.match(ux, /Scaffold ready: review the new package test command and test files below/);
  assert.match(ux, /Estructura preparada: revisa abajo el nuevo comando de pruebas y sus archivos/);
});
test('an empty-project Mission scaffolds, stops, then needs a separate verification authorization', async () => {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: PLAN }]) });
    await h.provider.sendMessage('Create a calculator project from this empty folder.', 'mission', 'local');
    let mission = stored(h);

    const packageJson = JSON.stringify({ name: 'bootstrap-demo', private: true, scripts: { test: 'node app.test.js' } });
    h.model.enqueue(
      {
        kind: 'json',
        body: toolCallReply([
          {
            id: 'files',
            name: 'apply_patch',
            args: {
              files: [
                { path: 'package.json', expectedHash: EMPTY, newContent: packageJson },
                { path: 'app.js', expectedHash: EMPTY, newContent: 'module.exports = (a, b) => a + b;\n' },
                {
                  path: 'app.test.js',
                  expectedHash: EMPTY,
                  newContent: "const assert = require('node:assert');\nassert.equal(require('./app.js')(2, 3), 5);\nconsole.log('ok');\n",
                },
              ],
            },
          },
        ]),
      },
      { kind: 'json', body: toolCallReply([{ id: 'too-early', name: 'run_tests', args: { commandId: 'npm:test' } }]) },
      { kind: 'json', body: assistantText('The scaffold and its test are ready for review.') },
    );

    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    mission = stored(h);
    assert.equal(mission.status, 'active');
    assert.equal(mission.grant, null, 'the bootstrap grant is revoked before verification');
    assert.equal(mission.awaitingVerification, true);
    assert.equal(mission.tasks[0]?.status, 'current', 'scaffolding never completes the task');
    assert.equal(mission.evidence.some((entry) => /run_tests .*exit=/.test(entry.text)), false, 'no test ran under the bootstrap grant');
    assert.ok(mission.evidence.some((entry) => /run_tests .*blocked by policy/.test(entry.text)), 'an early test is refused by host policy');
    assert.match(mission.note, /Review the new test command and files/);
    assert.equal(await h.readFile('package.json'), packageJson);

    const beforeReloadRuns = mission.taskRunsUsed;
    h.provider.dispose();
    h.createProvider();
    await h.provider.missionRecovery;
    mission = stored(h);
    assert.equal(mission.awaitingVerification, true, 'the second authorization survives a reload');
    assert.equal(mission.status, 'active', 'the deliberate pause is not misreported as an interrupted run');
    assert.equal(mission.taskRunsUsed, beforeReloadRuns, 'reload does not repeat any action');

    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'test', name: 'run_tests', args: { commandId: 'npm:test' } }]) },
      { kind: 'json', body: assistantText('Calculator created and npm:test passed.') },
    );
    await h.provider.startMission(
      mission.id,
      mission.revision,
      'autonomous-workspace',
      null,
      true,
      { commandId: 'npm:test', files: ['app.test.js'] },
    );
    mission = stored(h);
    assert.equal(mission.status, 'completed', mission.note);
    assert.equal(mission.awaitingVerification, undefined);
    assert.equal(mission.grant?.bootstrap, undefined);
    assert.equal(mission.grant?.acceptance?.files[0]?.path, 'app.test.js');
    assert.ok(mission.evidence.some((entry) => /run_tests npm:test.*exit=0/.test(entry.text)));
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});
