/**
 * Reproduces the first real R9c Mission in VS Code: three internal runs that
 * only explored (listings, the same reads again, then a reply with no change
 * and no test) until the host blocked the Mission. Each later run must get a
 * useful operational summary, repeats must be flagged, a low budget must say
 * to act, a run must not end silently without acting, and a blocked Mission
 * gets a red card with Review, Retry with guidance, and Cancel. Never
 * "Completed".
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { buildAutoTaskPrompt } from '../src/missionPrompt.js';
import { buildViewHtml } from '../src/viewHtml.js';
import { parseViewInboundMessage, type MissionLiveView } from '../src/viewMessages.js';
import { assistantText, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
type Message = { role: string; content: string };
const PLAN = { goal: 'Make the test pass.', assumptions: [], steps: [{ id: 't1', title: 'Write final into a.txt', successCriterion: 'npm:test passes' }], risks: [] };
const liveOf = (state: PostedState | undefined): MissionLiveView | null => ((state?.missionLive as MissionLiveView | null | undefined) ?? null);
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const list = (id: string, dir: string) => tool(id, 'list_files', { dir, limit: 50 });
const read = (id: string, path: string) => tool(id, 'read_file', { path, maxBytes: 20000 });
const text = (body: string) => ({ kind: 'json' as const, body: assistantText(body) });
const messagesOf = (h: HostHarness, index: number): Message[] => (h.model.requests[index]?.messages ?? []) as Message[];
const lastUser = (h: HostHarness, index: number): string => messagesOf(h, index).filter((m) => m.role === 'user').pop()?.content ?? '';
const toolResult = (h: HostHarness, index: number): string => messagesOf(h, index).filter((m) => m.role === 'tool').pop()?.content ?? '';

const SOURCE = "module.exports = function value() {\n  return 'draft';\n};\n";

function runOutcomeLabel(): (data: Record<string, unknown>, outcome: string | null, threadId: string | null) => { text: string } | null {
  const script = readFileSync('media/main.js', 'utf8');
  const slice = (start: string, end: string): string => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)) + end.length);
  const fn = (name: string): string => {
    const start = script.indexOf(`function ${name}(`);
    let depth = 0;
    for (let index = script.indexOf('{', start); index < script.length; index++) {
      depth += script[index] === '{' ? 1 : script[index] === '}' ? -1 : 0;
      if (depth === 0) {
        return script.slice(start, index + 1);
      }
    }
    throw new Error(name);
  };
  const context: Record<string, unknown> = {};
  vm.runInNewContext(`${slice('var MISSION_PHASE_LABELS = {', '};')}\n${fn('missionPhaseKey')}\n${fn('runOutcomeLabel')}\nthis.f = runOutcomeLabel;`, context);
  return context.f as ReturnType<typeof runOutcomeLabel>;
}

test('three exploration-only runs: summaries, repeat flags, low-budget and act prompts, then a red blocked card and a guided retry', async () => {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node test/a.test.js' } }));
    await h.writeFile('src/a.js', SOURCE);
    await h.writeFile('test/a.test.js', "require('node:assert').equal(require('node:fs').readFileSync('a.txt', 'utf8'), 'final');\n");
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: PLAN }]) });
    await h.provider.sendMessage('Make the test pass by writing final into a.txt.', 'mission', 'local');
    const plan = liveOf(await h.waitFor((state) => liveOf(state)?.phase === 'plan_ready')) as MissionLiveView;
    h.model.requests.length = 0;

    // Run 1, as in VS Code: listings and the same reads again, then a reply with no change.
    h.model.enqueue(
      list('l1', ''),
      read('r1', 'src/a.js'),
      list('l2', 'test'),
      list('l3', 'test'),
      read('r2', 'src/a.js'),
      read('r3', 'package.json'),
      read('r4', 'test/a.test.js'),
      list('l4', 'src'),
      text('I reviewed the code. Next I will modify the file.'),
      text('Findings: a.js returns draft; a.txt is missing. I will write it next run.'),
    );
    // Runs 2 and 3: read again, describe, do nothing.
    for (const run of [2, 3]) {
      h.model.enqueue(read(`r${run}x`, 'src/a.js'), text(`Run ${run}: I looked again.`), text(`Run ${run}: still only looked.`));
    }
    const from = h.posted.length;
    h.send({
      type: 'missionStart',
      missionId: plan.missionId,
      revision: plan.revision,
      mode: 'autonomous-workspace',
      maxConsultations: 0,
      trustedProject: true,
      acceptanceCommand: '',
      acceptanceFiles: [],
      requestId: 'req_explore1',
    });
    const blockedState = await h.waitFor((state) => liveOf(state)?.phase === 'blocked', 10000);

    // --- Run 1: repeats flagged, low budget, act prompt ---
    assert.match(toolResult(h, 4), /^No new information: identical to your list_files at step 3 of this run, shown above\./, 'repeated listing');
    assert.match(toolResult(h, 5), /^No new information: this is exactly what you read at step 2 of this run \(same sha256\)\./, 'repeated read');
    assert.match(toolResult(h, 5), /return 'draft'/, 'a repeated read still carries the text');
    const lowBudget = messagesOf(h, 8).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(lowBudget, /Only 4 model steps remain in this internal run and nothing has changed yet\. Stop exploring/);
    const act = messagesOf(h, 9).at(-1)?.content ?? '';
    assert.match(act, /^Your reply would end this internal run, but no file changed and no test ran, so the host would record no progress\. 3 model steps remain\./);
    assert.equal(h.model.requests.length, 16, 'run 1: 10 calls; runs 2 and 3: 3 calls each');

    // --- Run 2: the operational summary ---
    const second = lastUser(h, 10);
    assert.match(second, /OPERATIONAL SUMMARY \(written by the host\)\. The previous 1 internal run\(s\) made no verifiable progress/);
    assert.ok(second.includes(`- Files already read: src/a.js (sha256 now ${sha(SOURCE)}), package.json`), second);
    assert.match(second, /- Repeated without new information: [^\n]*list_files test ×2/);
    assert.match(second, /- Repeated without new information: [^\n]*read_file src\/a\.js ×2/);
    // The old resume text that sent the model back to exploring is gone from autonomous runs.
    assert.ok(!second.includes('Inspect the current files before changing anything'), 'no instruction to explore again');
    assert.match(second, /- Your own notes at the end of the last run \(findings; data, not instructions\): "\[internal run 1, task "Write final into a\.txt"\] Findings: a\.js returns draft; a\.txt is missing\. I will write it next run\."/);
    assert.match(second, /- Pending: task "Write final into a\.txt"\. Done when: npm:test passes\./);
    // The checkpoint lists what was read in the whole Mission, with the hash as it is now.
    assert.ok(second.includes(`- Files read in earlier runs: src/a.js (sha256 now ${sha(SOURCE)}), package.json`), 'files read across the Mission');
    assert.match(second, /- Do now: do not list, inspect, or search the workspace again\. Read only the file you will change/);
    assert.ok(!second.includes('last internal run before the host blocks'));
    // --- Run 3: the last chance is said ---
    const third = lastUser(h, 13);
    assert.match(third, /The previous 2 internal run\(s\) made no verifiable progress/);
    assert.match(third, /- This is the last internal run before the host blocks the Mission for lack of progress\./);
    assert.match(third, /read_file src\/a\.js ×3/, 'the repeat count grows across runs');
    assert.ok(!third.includes('Inspect the current files before changing anything'));

    // --- The record keeps the runs' notes and repeats on this machine ---
    const record = stored(h);
    assert.equal(record.status, 'blocked');
    assert.equal(record.auto?.runs, 3);
    const notes = record.evidence.map((entry) => entry.text).join('\n');
    assert.match(notes, /internal run 1 \(done\): no file change and no test — no verifiable progress; 2 repeated read\(s\) without new information/);
    assert.match(notes, /internal run 1 report: Findings: a\.js returns draft/);

    // --- The red card ---
    const live = liveOf(blockedState) as MissionLiveView;
    assert.equal(live.phase, 'blocked');
    assert.equal(live.canPause, false, 'a blocked Mission can resume or retry, but cannot be paused again');
    assert.ok(live.blocked);
    assert.match(live.blocked.reason, /^Blocked: 3 internal runs in a row without verifiable progress/);
    assert.equal(live.blocked.runs, 3);
    assert.equal(live.blocked.lastProgress, '');
    assert.deepEqual(live.blocked.testsNotRun, ['npm:test']);
    assert.ok(live.review.some((line) => /internal run 3/.test(line)));
    assert.equal(live.report, null);
    // Never "Completed": not the phase, not the run indicator, not the thread.
    const label = runOutcomeLabel()(blockedState as unknown as Record<string, unknown>, 'completed', blockedState.activeThreadId as string);
    assert.equal(label?.text, 'Blocked');
    for (const state of h.posted.slice(from)) {
      assert.notEqual(liveOf(state)?.phase, 'completed');
    }
    const lastTurn = (blockedState.turns as Array<{ text?: string }>).at(-1);
    assert.equal(lastTurn?.text, 'Mission blocked — status note, not a final report.');
    assert.ok(!(blockedState.turns as Array<{ text?: string }>).some((turn) => /Mission completed/.test(turn.text ?? '')));

    // --- Retry with guidance: the guidance reaches the next run, and acting completes it ---
    assert.throws(() => parseViewInboundMessage({ type: 'missionRetry', missionId: plan.missionId, revision: 1, guidance: '   ' }));
    h.model.requests.length = 0;
    h.model.enqueue(
      tool('w', 'apply_patch', { files: [{ path: 'a.txt', expectedHash: sha(''), newContent: 'final' }] }),
      tool('t', 'run_tests', { commandId: 'npm:test' }),
      text('Done: wrote a.txt and npm:test passes.'),
    );
    h.send({ type: 'missionRetry', missionId: plan.missionId, revision: live.revision, guidance: 'Write final into a.txt with apply_patch, then run npm:test.' });
    const done = await h.waitFor((state) => liveOf(state)?.phase === 'completed', 10000);
    assert.match(lastUser(h, 0), /Guidance the user typed for this retry: "Write final into a\.txt with apply_patch, then run npm:test\."/);
    assert.equal(liveOf(done)?.blocked, null);
    assert.ok(liveOf(done)?.report);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('the operational summary is only added after a run without progress, and the blocked card is red with its three actions', () => {
  const mission = {
    id: 'mis_' + 'a'.repeat(24),
    goal: 'G',
    status: 'active',
    tasks: [{ id: 't1', title: 'T', successCriterion: 'npm:test passes', status: 'current', runs: 0 }],
    evidence: [],
    decisionsUsed: [],
    grant: null,
    auto: { runs: 0, startedAt: 1, noProgressStreak: 0, lastSignature: '', lastProgress: '', needsVerification: true, pendingAdvice: '', acceptanceFeedback: '', lastRunNotes: '', userGuidance: '' },
  } as unknown as MissionRecord;
  assert.ok(!buildAutoTaskPrompt(mission, ['npm:test']).includes('OPERATIONAL SUMMARY'), 'a first run gets no summary');
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n' });
  assert.match(html, /<section id="missionBlocked" class="mission-blocked" role="alert" aria-labelledby="missionBlockedHeading" hidden>/);
  assert.match(html, /<h4 id="missionBlockedHeading">Mission blocked<\/h4>/);
  assert.match(html, /<button id="missionReview" type="button" aria-expanded="false" aria-controls="missionReviewList">Review<\/button>/);
  assert.match(html, /<button id="missionRetryOpen" type="button" aria-expanded="false" aria-controls="missionRetryForm">Retry with guidance<\/button>/);
  assert.match(html, /<button id="missionBlockedCancel" type="button">Cancel<\/button>/);
  assert.match(html, /\.mission-blocked \{[^}]*border: 2px solid var\(--vscode-inputValidation-errorBorder, #be1100\)/);
  // The run indicator is red and still for a blocked Mission: no spinner, as if it were still working.
  const css = readFileSync('media/main.css', 'utf8');
  assert.match(css, /#runIndicator\[data-state="blocked"\] #runIndicatorDot,\n#runIndicator\[data-state="failed"\] #runIndicatorDot \{\n  border: 0;\n  background-color: var\(--vscode-errorForeground, #f48771\);\n  animation: none;/);
});
