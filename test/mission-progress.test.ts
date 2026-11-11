/**
 * What counts as progress in an autonomous Mission, and the user's run
 * budget (P5h, the user's decisions of 08-11-2026, after the second real
 * run with Spark: alternating which tests ran was counted as progress, so the
 * Mission never blocked and never consulted the advisor).
 *
 * Everything is simulated: Meta is the harness's fakeCloud.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeCloud, HostHarness } from './helpers/hostHarness.js';
import { API_KEY_SECRET, KEY } from './helpers/autonomyBench.js';
import { onAutonomyMessage } from '../src/autonomyEntry.js';
import { measureProgress, runBudget } from '../src/missionProgress.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';

const pass = (commandId: string) => ({ commandId, exitCode: 0, afterLastWrite: true });
const fail = (commandId: string) => ({ commandId, exitCode: 1, afterLastWrite: true });

test('progress is a demonstrable improvement in a new file state: other tests, the same results, or files edited back to an earlier state are not progress', () => {
  // A test that was failing passes after a change: progress.
  let step = measureProgress(null, { writes: [{ path: 'a.js', hash: 'h1' }], lastTest: null, verifiers: [fail('npm:check')] });
  assert.equal(step.improved, false, 'a first failing result is not an improvement');
  step = measureProgress(step.memory, { writes: [{ path: 'a.js', hash: 'h2' }], lastTest: null, verifiers: [pass('npm:check')] });
  assert.equal(step.improved && step.newState, true, 'failing → passing in a new state');
  let memory = step.memory;
  // Running other tests, or the same ones again, with the same results: not progress.
  for (const verifiers of [[pass('npm:check'), fail('npm:lint')], [fail('npm:lint')], [pass('npm:check'), fail('npm:lint')]]) {
    step = measureProgress(memory, { writes: [], lastTest: null, verifiers });
    assert.equal(step.improved, false, JSON.stringify(verifiers));
    memory = step.memory;
  }
  // Editing back and forth: a state already reached is never new.
  step = measureProgress(memory, { writes: [{ path: 'a.js', hash: 'h3' }], lastTest: null, verifiers: [fail('npm:check')] });
  assert.equal(step.newState, true);
  memory = step.memory;
  step = measureProgress(memory, { writes: [{ path: 'a.js', hash: 'h2' }], lastTest: null, verifiers: [pass('npm:check')] });
  assert.equal(step.improved, true, 'it passes again');
  assert.equal(step.newState, false, 'but in a file state already reached: not progress');
  // A run that writes nothing keeps the current state: new only once.
  const quiet = measureProgress(null, { writes: [], lastTest: null, verifiers: [] });
  assert.equal(quiet.newState, true);
  assert.equal(measureProgress(quiet.memory, { writes: [], lastTest: null, verifiers: [] }).newState, false);
});

test("the run budget the user chooses is used exactly and never raised; with no choice an autonomous Mission gets the safety ceiling", () => {
  assert.deepEqual(runBudget({ mode: 'autonomous-workspace', chosen: 3, tasks: 2, current: 4 }), { ok: true, maxTaskRuns: 6, runsPerTask: 3 });
  assert.deepEqual(runBudget({ mode: 'autonomous-workspace', stored: 3, tasks: 2, current: 16 }), { ok: true, maxTaskRuns: 6, runsPerTask: 3 }, 'authorized again: the choice stays');
  assert.deepEqual(runBudget({ mode: 'autonomous-workspace', tasks: 2, current: 4 }), { ok: true, maxTaskRuns: 16 }, 'no choice: 8 per task, as before');
  assert.deepEqual(runBudget({ mode: 'supervised', tasks: 2, current: 4 }), { ok: true, maxTaskRuns: 4 });
  for (const chosen of [0, 9, 2.5]) {
    assert.equal(runBudget({ mode: 'autonomous-workspace', chosen, tasks: 2, current: 4 }).ok, false, String(chosen));
  }
});

test('a Mission with Spark as its main model whose task cannot pass: alternating tests is not progress, so after 3 runs it blocks, Wonder is consulted once under Full Access, Spark continues within the chosen budget, and Glimmer is never asked', async () => {
  const h = new HostHarness();
  await h.start({ provider: 'cloud', model: 'muse-spark-1.3', cloudModel: 'muse-spark-1.3', mode: 'mission', agentProfile: 'ask', allowCloudEscalation: true, advisorModel: 'muse-wonder-1.0' });
  h.secretValues.set(API_KEY_SECRET, KEY);
  await h.provider.refreshHasKey();
  h.provider.confirmAutonomy = async () => true;
  const models: string[] = [];
  let sparkSteps = 0;
  fakeCloud.requests.length = 0;
  fakeCloud.handler = (body) => {
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    const reply = (content: string | null, calls?: unknown[]) => Response.json({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage });
    models.push(String(body.model));
    if (body.model === 'muse-wonder-1.0') {
      return reply(JSON.stringify({ diagnosis: 'npm:check needs a flag only the operator sets.', steps: ['Leave check.js as it is.'], checks: ['npm:check passes once the flag is set.'] }));
    }
    if (body.response_format) {
      return reply(JSON.stringify({ goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'Make npm:check pass', successCriterion: 'npm:check passes' }], risks: [] }));
    }
    const messages = body.messages as Array<{ role: string }>;
    if (messages.at(-1)?.role === 'tool') {
      return reply('Done for this run.');
    }
    sparkSteps += 1;
    // Like the real Spark of 08-11: sometimes both tests, sometimes only the failing one.
    const calls = sparkSteps % 2 === 0
      ? [{ id: `a${sparkSteps}`, type: 'function', function: { name: 'run_tests', arguments: JSON.stringify({ commandId: 'npm:test' }) } }, { id: `b${sparkSteps}`, type: 'function', function: { name: 'run_tests', arguments: JSON.stringify({ commandId: 'npm:check' }) } }]
      : [{ id: `c${sparkSteps}`, type: 'function', function: { name: 'run_tests', arguments: JSON.stringify({ commandId: 'npm:check' }) } }];
    return reply(null, calls);
  };
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { test: 'node -e "process.exit(0)"', check: 'node -e "process.exit(1)"' } }));
    await onAutonomyMessage(h.provider as never, { type: 'autonomyFull', tools: { files: true, tests: true, commands: false, installs: false, jobs: false, web: false, meta: true }, validityHours: 1, metaMain: true, meta: { maxPerMission: 1, dataScope: 'instructions', tokenBudget: 40000 } });
    await h.provider.sendMessage('Make npm:check pass.', 'mission', 'cloud');
    const stored = () => (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;
    const mission = stored();
    // The user's budget on the card: 4 runs per task. RAME keeps it.
    h.send({ type: 'missionRunsSet', missionId: mission.id, runsPerTask: 4 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const localBefore = h.model.requests.length;
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const after = stored();
    assert.equal(after.runsPerTask, 4);
    assert.equal(after.maxTaskRuns, 4, 'one task × 4: never raised to 8');
    assert.equal(after.tasks[0]?.runs, 4, String(h.last().status));
    const wonder = models.indexOf('muse-wonder-1.0');
    assert.equal(models.filter((model) => model === 'muse-wonder-1.0').length, 1, `one consultation (${models.join(', ')})`);
    // Plan, then 3 runs of 2 Spark requests each, then Wonder, then the 4th run with Spark.
    assert.equal(wonder, 1 + 3 * 2, 'consulted right after the third run without progress');
    assert.deepEqual(models.slice(wonder + 1), ['muse-spark-1.3', 'muse-spark-1.3'], 'Spark continued after the advice');
    assert.ok(after.evidence.some((entry) => /internal run 2 \(done\): .*no verifiable progress/.test(entry.text)), 'alternating tests was not progress');
    assert.equal(after.status, 'blocked');
    assert.equal(h.model.requests.length, localBefore, 'Glimmer was never asked');
    assert.equal((h.last().remote as { disclosure: unknown }).disclosure, null, 'no disclosure card');
  } finally {
    fakeCloud.handler = null;
    fakeCloud.requests.length = 0;
    h.provider.cancelRequest();
    await h.dispose();
  }
});
