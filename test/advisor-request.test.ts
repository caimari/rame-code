/**
 * What an advisor consultation carries and how the advisor is asked (P5h,
 * after the real Wonder consultation of 08-11-2026, which noted that the
 * failing check's output was not in the record):
 *
 *  - the end of the failing check's output, made safe or not sent; on the
 *    card as exact text, and without a card only under a data scope that
 *    includes fragments;
 *  - the advisor's own generation settings and output cap.
 *
 * Everything is simulated: Meta is the harness's fakeCloud.
 */

import assert from 'node:assert/strict';
import * as os from 'node:os';
import test from 'node:test';

import { fakeCloud, HostHarness } from './helpers/hostHarness.js';
import { API_KEY_SECRET, KEY } from './helpers/autonomyBench.js';
import { ADVISOR_MAX_OUTPUT_TOKENS, advisorGeneration, safeCheckExcerpt } from '../src/advisorRequest.js';
import { onAutonomyMessage } from '../src/autonomyEntry.js';
import { defaultGenerationSettings } from '../src/generationSettings.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';

test('the end of a failing check\'s output: bounded, folders hidden, and nothing at all when a secret, the key or a private folder would remain', () => {
  const project = '/tmp/ws-123/shop';
  const folders: Array<[string, string]> = [[project, '<project folder>'], [os.homedir(), '~']];
  const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
  const tail = safeCheckExcerpt(`${long}\nError: expected 5 at ${project}/test.js:3:8`, folders);
  assert.equal(tail.ok, true);
  const text = (tail as { text: string }).text;
  assert.ok(text.split('\n').length <= 30 && text.length <= 1500);
  assert.ok(!text.includes('line 10\n'), 'only the end');
  assert.match(text, /Error: expected 5 at <project folder>\/test\.js:3:8$/);
  assert.match(String((safeCheckExcerpt(`at ${os.homedir()}/notes.txt`, folders) as { text: string }).text), /^at ~\/notes\.txt$/);
  assert.deepEqual(safeCheckExcerpt('Error: token sk-live_ABCDEFGHIJKLMNOPQRST0123 rejected', folders), { ok: false, reason: 'it looked like it contained a secret' });
  assert.deepEqual(safeCheckExcerpt('failed with key KEY-123456789', folders, 'KEY-123456789'), { ok: false, reason: 'it contained the API key' });
  assert.deepEqual(safeCheckExcerpt('cannot open /home/someone-else/.ssh/id_rsa', folders), { ok: false, reason: 'it named a private folder that could not be hidden' });
  assert.deepEqual(safeCheckExcerpt('   \n  ', folders), { ok: false, reason: 'the check printed nothing' });
});

test("the advisor is asked with its own settings: its documented profile, the reasoning stored for it (not the main model's), and its output cap", () => {
  const settings = defaultGenerationSettings();
  settings.reasoningByModel['cloud:muse-spark-1.3'] = 'max';
  settings.maxOutputTokens.cloud = null;
  const wonder = advisorGeneration(settings, 'muse-wonder-1.0');
  assert.equal(wonder.model, 'muse-wonder-1.0');
  assert.equal(wonder.reasoning, null, "Spark's stored level is not Wonder's");
  assert.equal(wonder.manualMax, ADVISOR_MAX_OUTPUT_TOKENS);
  settings.reasoningByModel['cloud:muse-wonder-1.0'] = 'low';
  settings.maxOutputTokens.cloud = 1000;
  const chosen = advisorGeneration(settings, 'muse-wonder-1.0');
  assert.equal(chosen.reasoning, 'low');
  assert.equal(chosen.manualMax, 1000, 'a lower manual maximum still applies');
  settings.maxOutputTokens.cloud = 50_000;
  assert.equal(advisorGeneration(settings, 'muse-wonder-1.0').manualMax, ADVISOR_MAX_OUTPUT_TOKENS, 'never above the advisor cap');
});

async function blockedMission(dataScope: 'instructions' | 'files' | null, checkScript: string, onCard?: (h: HostHarness) => Promise<void>): Promise<{ wonder: Record<string, unknown> | undefined; workspace: string }> {
  const h = new HostHarness();
  await h.start({ provider: 'cloud', model: 'muse-spark-1.3', cloudModel: 'muse-spark-1.3', mode: 'mission', agentProfile: 'ask', allowCloudEscalation: true, advisorModel: 'muse-wonder-1.0' });
  h.secretValues.set(API_KEY_SECRET, KEY);
  await h.provider.refreshHasKey();
  h.provider.confirmAutonomy = async () => true;
  fakeCloud.requests.length = 0;
  fakeCloud.handler = (body) => {
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    const reply = (content: string | null, calls?: unknown[]) => Response.json({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? 'tool_calls' : 'stop' }], usage });
    if (body.model === 'muse-wonder-1.0') {
      return reply(JSON.stringify({ diagnosis: 'The flag is missing.', steps: ['Ask the operator.'], checks: ['npm:check passes.'] }));
    }
    if (body.response_format) {
      return reply(JSON.stringify({ goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'Make npm:check pass', successCriterion: 'npm:check passes' }], risks: [] }));
    }
    const messages = body.messages as Array<{ role: string }>;
    return messages.at(-1)?.role === 'tool' ? reply('Done for this run.') : reply(null, [{ id: `c${messages.length}`, type: 'function', function: { name: 'run_tests', arguments: JSON.stringify({ commandId: 'npm:check' }) } }]);
  };
  try {
    await h.writeFile('check.js', checkScript);
    await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { check: 'node check.js' } }));
    if (dataScope !== null) {
      await onAutonomyMessage(h.provider as never, { type: 'autonomyFull', tools: { files: true, tests: true, commands: false, installs: false, jobs: false, web: false, meta: true }, validityHours: 1, metaMain: true, meta: { maxPerMission: 1, dataScope, tokenBudget: 40000 } });
    }
    await h.provider.sendMessage('Make npm:check pass.', 'mission', 'cloud');
    const mission = (h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0] as MissionRecord;
    h.send({ type: 'missionRunsSet', missionId: mission.id, runsPerTask: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    if (onCard) {
      await onCard(h);
    }
    return { wonder: fakeCloud.requests.find((request) => request.body.model === 'muse-wonder-1.0')?.body, workspace: h.workspace };
  } finally {
    fakeCloud.handler = null;
    fakeCloud.requests.length = 0;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

const CHECK = "console.error('release not approved: RAME_TRIAL_UNLOCK is not set in ' + __dirname);\nprocess.exit(1);\n";

test('a blocked Mission consults Wonder with the end of the failing check\'s output only under a data scope that includes fragments, with the project folder hidden, the advisor\'s own output cap, and no tools', async () => {
  const withFiles = await blockedMission('files', CHECK);
  assert.ok(withFiles.wonder, 'Wonder was consulted');
  const sent = JSON.stringify(withFiles.wonder);
  assert.match(sent, /End of the failing check's output \(last lines; secrets removed, local folders hidden\)/);
  assert.match(sent, /release not approved: RAME_TRIAL_UNLOCK is not set in <project folder>/);
  assert.equal(sent.includes(withFiles.workspace), false, 'the project folder is hidden');
  assert.ok(Number(withFiles.wonder.max_completion_tokens) <= ADVISOR_MAX_OUTPUT_TOKENS);
  assert.equal(withFiles.wonder.tools, undefined, 'the advisor gets no tools');
  // "Only instructions and the host's notes": the consultation goes, without the output.
  const instructions = await blockedMission('instructions', CHECK);
  assert.ok(instructions.wonder);
  assert.doesNotMatch(JSON.stringify(instructions.wonder), /RAME_TRIAL_UNLOCK|End of the failing check's output/);
  assert.match(JSON.stringify(instructions.wonder), /its output is not included/);
  // Output with something that looks like a secret: never sent, whatever the scope.
  const secret = await blockedMission('files', "console.error('auth failed for token sk-live_ABCDEFGHIJKLMNOPQRST0123');\nprocess.exit(1);\n");
  assert.ok(secret.wonder);
  assert.doesNotMatch(JSON.stringify(secret.wonder), /sk-live_|auth failed/);
});

test("on the consultation card the output is the user's choice: not in the exact text by default; included (and shown again) only when the user ticks it", async () => {
  await blockedMission(null, CHECK, async (h) => {
    const offer = h.provider.consultOffer;
    assert.ok(offer, String(h.last().status));
    assert.match(offer.payload, /its output is not included/);
    assert.doesNotMatch(offer.payload, /RAME_TRIAL_UNLOCK/, 'not by default');
    const view = () => (h.last().remote as { consult: { outputAvailable: boolean; outputIncluded: boolean } }).consult;
    await h.provider.postState();
    assert.deepEqual([view().outputAvailable, view().outputIncluded], [true, false]);
    h.send({ type: 'consultIncludeFiles', digest: offer.digest, files: [], output: true });
    await h.waitFor(() => h.provider.consultOffer?.outputIncluded === true);
    const shown = h.provider.consultOffer!;
    assert.notEqual(shown.digest, offer.digest, 'a new text needs a new approval');
    assert.match(shown.payload, /End of the failing check's output[^]*RAME_TRIAL_UNLOCK is not set in <project folder>/);
    assert.equal(shown.payload.includes(h.workspace), false);
    assert.match(String(h.last().status), /it includes the end of the failing check's output/);
    assert.deepEqual([view().outputAvailable, view().outputIncluded], [true, true]);
    // Adding files without saying anything about the output keeps the choice.
    const before = shown.createdAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.send({ type: 'consultIncludeFiles', digest: shown.digest, files: [] });
    // The same text keeps its digest: the host renewed the offer when its time changed.
    await h.waitFor(() => h.provider.consultOffer !== null && h.provider.consultOffer.createdAt !== before);
    assert.equal(h.provider.consultOffer?.outputIncluded, true);
    h.send({ type: 'consultIncludeFiles', digest: h.provider.consultOffer!.digest, files: [], output: false });
    await h.waitFor(() => h.provider.consultOffer?.outputIncluded === false);
    assert.doesNotMatch(h.provider.consultOffer!.payload, /RAME_TRIAL_UNLOCK/);
    assert.equal(fakeCloud.requests.filter((request) => request.body.model === 'muse-wonder-1.0').length, 0, 'nothing was sent to the advisor without approval');
  });
});
