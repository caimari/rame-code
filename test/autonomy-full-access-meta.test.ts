/**
 * The user's decisions of 08-11-2026 on Full Access:
 *
 * 1. the Workspace full profile never grants anything outside the computer:
 *    the web follows Autonomy & Permissions, also in Ask always;
 * 2. Full Access with its Meta part asks nothing: Agent's advice, a blocked
 *    Mission's consultation (then the Mission is retried, at most three
 *    times) and the acceptance review go without their card, within the
 *    Meta pre-authorization given in the same confirmation (provider,
 *    model, key, environment, data scope, counts and tokens) and revoked
 *    with it; Full Access with web asks nothing either (keys removed, the
 *    user's folders hidden);
 * 3. no fixed limit of five in those flows either;
 * 4. never more data than authorized: secrets removed, local paths hidden,
 *    no file for Agent's advice, files only with a pre-authorization that
 *    includes them.
 *
 * Everything is simulated: Meta is the harness's fakeCloud, the search
 * engine is a local fake, tests are `node` one-liners.
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';

import { fakeCloud, HostHarness, toolCallReply } from './helpers/hostHarness.js';
import { advice, API_KEY_SECRET, KEY, say, tool } from './helpers/autonomyBench.js';
import { isAutoAllowed } from '../src/agentProfiles.js';
import { onAutonomyMessage } from '../src/autonomyEntry.js';
import { fullMetaNow, fullMetaRefusalNow } from '../src/autonomyHost.js';
import { type FullTools } from '../src/autonomyPolicy.js';
import { parseAutonomyMessage } from '../src/autonomyView.js';
import { memoryScopeForUi } from '../src/memoryController.js';
import { scrubLocalPaths } from '../src/cloudEgress.js';
import { ACCEPTANCE_REVIEW_MAX_TOTAL_TOKENS } from '../src/missionAcceptanceReview.js';
import { prepareAcceptanceReview } from '../src/missionAcceptanceReviewHost.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import type { ProviderHost } from '../src/providerTypes.js';
import { dismissConsult } from '../src/remoteController.js';
import { parseRemoteMessage } from '../src/remoteViews.js';

const NONE: FullTools = { files: false, tests: false, commands: false, installs: false, jobs: false, web: false, meta: false };
const FILES_TESTS: FullTools = { ...NONE, files: true, tests: true };
const SECRET = 'sk-live_ABCDEFGHIJKLMNOPQRST0123';
const host = (h: HostHarness) => h.provider as unknown as ProviderHost;
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;
const lastLog = async (h: HostHarness) => h.provider.autonomy.get(await scopeOf(h)).log.at(-1);

async function scopeOf(h: HostHarness): Promise<string> {
  const scope = await memoryScopeForUi(host(h));
  assert.ok(scope.ok);
  return scope.scopeId;
}

async function withHarness(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'ask', allowCloudEscalation: true, ...settings });
  h.secretValues.set(API_KEY_SECRET, KEY);
  await h.provider.refreshHasKey();
  h.provider.confirmAutonomy = async () => true;
  fakeCloud.requests.length = 0;
  fakeCloud.handler = advice;
  try {
    await body(h);
  } finally {
    fakeCloud.handler = null;
    fakeCloud.requests.length = 0;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

/** Supervised, then the Meta pre-authorization the user chose. */
async function preauthorizeMeta(h: HostHarness, options: { max: number | null; dataScope?: 'instructions' | 'files'; tokenBudget?: number | null }): Promise<void> {
  await onAutonomyMessage(host(h), { type: 'autonomyMode', mode: 'supervised' });
  await onAutonomyMessage(host(h), { type: 'autonomyMeta', maxPerMission: options.max, validityHours: 8, dataScope: options.dataScope ?? 'instructions', tokenBudget: options.tokenBudget ?? null });
  assert.notEqual(h.provider.autonomy.get(await scopeOf(h)).meta, null, String(h.last().status));
}

type MetaChoice = { maxPerMission: number | null; dataScope: 'instructions' | 'files'; tokenBudget: number | null };
const ALL_META: MetaChoice = { maxPerMission: null, dataScope: 'files', tokenBudget: 1_000_000 };

/** Full Access as the user turns it on: with its Meta part, the Meta limits come in the same request and confirmation. */
async function turnOnFull(h: HostHarness, tools: FullTools, meta: MetaChoice = ALL_META): Promise<void> {
  await onAutonomyMessage(host(h), tools.meta ? { type: 'autonomyFull', tools, validityHours: 8, meta } : { type: 'autonomyFull', tools, validityHours: 8 });
}

/** Approve or reject each Agent card that appears; returns the cards, in order. */
async function drive(h: HostHarness, run: Promise<unknown>, decide: 'approve' | 'reject'): Promise<string[]> {
  const cards: string[] = [];
  let done = false;
  void run.then(() => (done = true), () => (done = true));
  let seen = '';
  const deadline = Date.now() + 30000;
  while (!done && Date.now() < deadline) {
    const pending = h.last()?.agentPending as { actionId: string; digest: string; tool: string; targets: string[] } | null | undefined;
    if (pending && pending.actionId !== seen) {
      seen = pending.actionId;
      cards.push(`${pending.tool} ${pending.targets[0] ?? ''}`);
      await (decide === 'approve' ? h.provider.approveAgentAction(pending.actionId, pending.digest) : h.provider.rejectAgentAction(pending.actionId, pending.digest));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await run.catch(() => undefined);
  return cards;
}

async function fakeSearx(): Promise<{ origin: string; queries: string[]; close(): Promise<void> }> {
  const queries: string[] = [];
  const server = http.createServer((req, res) => {
    queries.push(new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: [{ title: 'Node', url: 'https://nodejs.org/en', content: 'LTS' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, queries, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// ----- 1. The profile never grants anything outside the computer -----

test('Workspace full never grants the web: in Ask always and in supervised autonomy each search shows its card; only Full Access with web (or a web pre-authorization) skips it', async () => {
  for (const profile of ['ask', 'safe-auto', 'workspace-full'] as const) {
    for (const name of ['web_search', 'web_fetch'] as const) {
      assert.equal(isAutoAllowed(profile, name), false, `${profile} ${name}`);
    }
  }
  assert.equal(isAutoAllowed('workspace-full', 'apply_patch'), true, 'the profile still covers workspace tools');
  const searx = await fakeSearx();
  try {
    await withHarness({ agentProfile: 'workspace-full', web: { enabled: true, search: 'searxng', searxngUrl: searx.origin } }, async (h) => {
      const search = async (query: string) => {
        h.model.enqueue(tool(`s${searx.queries.length}`, 'web_search', { query }), say('Done.'));
        return drive(h, h.provider.sendMessage(`Look up ${query}.`, 'agent', 'local'), 'approve');
      };
      // Ask always (the default) with Workspace full: the card.
      assert.equal(h.provider.autonomy.get(await scopeOf(h)).mode, 'ask');
      assert.equal((await search('current node lts')).length, 1);
      assert.equal((await lastLog(h))?.approval, 'card', 'recorded as approved on its card, never by the profile');
      // Supervised without a web pre-authorization: still the card.
      await onAutonomyMessage(host(h), { type: 'autonomyMode', mode: 'supervised' });
      assert.equal((await search('node release schedule')).length, 1);
      // Full Access without its web part: still the card.
      await turnOnFull(h, FILES_TESTS);
      assert.equal((await search('node security releases')).length, 1);
      // Full Access with web: no card, recorded as Full Access.
      await turnOnFull(h, { ...FILES_TESTS, web: true });
      assert.equal((await search('node lts end of life')).length, 0);
      assert.equal((await lastLog(h))?.approval, 'full-access');
      assert.equal(searx.queries.length, 4, 'each approved search ran once');
      assert.equal(h.provider.settings.agentProfile, 'workspace-full', 'the profile was never changed by any of it');
      // Full Access with web asks nothing, also for a technical query: code and paths go, the key is removed, the user's folders hidden.
      const technical = `TypeError: fs.readFileSync is not a function at ${h.workspace}/src/a.js:3 token ${SECRET} in /etc/nginx/nginx.conf`;
      assert.equal((await search(technical)).length, 0, 'no card');
      const sent = searx.queries.at(-1) ?? '';
      assert.equal(sent.includes(SECRET), false, 'the key never leaves');
      assert.equal(sent.includes(h.workspace), false, 'the project folder is hidden');
      assert.match(sent, /^TypeError: fs\.readFileSync is not a function at <project folder>\/src\/a\.js:3 token in \/etc\/nginx\/nginx\.conf$/);
      assert.match((await lastLog(h))?.data ?? '', /keys removed and local folders hidden/);
      // A page whose address carries a key: no card either, and it is not requested.
      const before = h.model.requests.length;
      h.model.enqueue(tool('f1', 'web_fetch', { url: `https://example.com/?api_key=${SECRET}` }), say('Done.'));
      assert.equal((await drive(h, h.provider.sendMessage('Read it.', 'agent', 'local'), 'approve')).length, 0);
      const fetched = (h.model.requests.slice(before) as Array<{ messages?: Array<{ tool_call_id?: string; content: string | null }> }>).flatMap((r) => r.messages ?? []).find((m) => m.tool_call_id === 'f1')?.content ?? '';
      assert.match(String(fetched), /Not fetched: the URL was not requested because it contains something that looks like a key/);
    });
  } finally {
    await searx.close();
  }
});

// ----- 2-4. Agent's advice to Meta outside a Mission -----

test('a local path at the end of a sentence is hidden too (found by the advice test below; it reached Meta before)', () => {
  const root = '/home/ana/shop';
  assert.equal(scrubLocalPaths(`The project is ${root}. Then ${root}/src/a.js and ${root}`, [[root, '<project folder>']]), 'The project is <project folder>. Then <project folder>/src/a.js and <project folder>');
  assert.equal(scrubLocalPaths(`${root}.bak and ${root}2/x`, [[root, '<project folder>']]), `${root}.bak and ${root}2/x`, 'another path is left as it is');
  assert.equal(scrubLocalPaths('C:\\Users\\ana\\shop.', [['C:\\Users\\ana\\shop', '<project folder>']]), '<project folder>.');
});

test("Agent's advice: Full Access with Meta asks nothing (one confirmation gives Meta too), sends no secret and no local path, counts per conversation, and goes with Full Access when revoked", async () => {
  await withHarness({}, async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node t.js' } }));
    await h.writeFile('t.js', 'process.exit(1);\n');
    const ask = `Fix the failing test. My token is ${SECRET} and the project is ${h.workspace}.`;
    const failingRun = async (...replies: ReturnType<typeof say>[]) => {
      h.model.enqueue(tool(`t${h.model.requests.length}`, 'run_tests', { commandId: 'npm:test' }), say('The test still fails.'), ...replies);
      return drive(h, h.provider.sendMessage(ask, 'agent', 'local'), 'reject');
    };
    // Its Meta part needs its limits in the request, and cloud escalation with a key: otherwise nothing is turned on.
    assert.throws(() => parseAutonomyMessage({ type: 'autonomyFull', tools: { ...FILES_TESTS, meta: true }, validityHours: 8 }), 'the Meta part without its limits');
    assert.throws(() => parseAutonomyMessage({ type: 'autonomyFull', tools: FILES_TESTS, validityHours: 8, meta: ALL_META }), 'limits without the Meta part');
    h.provider.settings = { ...h.provider.settings, allowCloudEscalation: false };
    await turnOnFull(h, { ...FILES_TESTS, meta: true });
    assert.equal(h.provider.autonomy.get(await scopeOf(h)).full, null);
    assert.match(String(h.last().status), /its Meta part needs cloud escalation ON, a saved Meta API key and an advisor model for the main model/);
    h.provider.settings = { ...h.provider.settings, allowCloudEscalation: true };
    // Full Access without its Meta part: the card with the exact text, nothing sent.
    await turnOnFull(h, FILES_TESTS);
    assert.deepEqual(await failingRun(), [], 'the allowlisted test ran under Full Access');
    assert.equal(fakeCloud.requests.length, 0);
    assert.notEqual(h.provider.consultOffer, null, 'the consultation card is shown');
    await dismissConsult(host(h));
    // With its Meta part, one confirmation: Full Access and the Meta pre-authorization together, bound to each other.
    let shown = '';
    h.provider.confirmAutonomy = async (request) => {
      shown = request.detail;
      return true;
    };
    await turnOnFull(h, { ...FILES_TESTS, meta: true }, { maxPerMission: 1, dataScope: 'instructions', tokenBudget: 100_000 });
    const given = h.provider.autonomy.get(await scopeOf(h));
    assert.equal(given.mode, 'full');
    assert.equal(given.meta?.fullId, given.full?.id, 'given with Full Access');
    assert.equal(given.meta?.maxPerMission, 1);
    assert.match(shown, /Meta: when the main model cannot finish, RAME consults Meta Model API without a card[^]*All within: Meta muse-spark-1\.3, at most 1 consultation\(s\)[^]*given and revoked with Full Access/);
    // Sent once, without the card, then verified locally by Glimmer.
    await failingRun(say('I checked the advice locally.'));
    assert.equal(fakeCloud.requests.length, 1, String(h.last().status));
    const body = JSON.stringify(fakeCloud.requests[0]?.body);
    assert.equal(body.includes(SECRET), false, 'secrets are removed before it leaves');
    assert.equal(body.includes(h.workspace), false, 'the local path is hidden');
    assert.equal(h.provider.consultOffer, null);
    const policy = h.provider.autonomy.get(await scopeOf(h));
    const entry = policy.log.at(-1);
    assert.equal(entry?.approval, 'full-access');
    assert.equal(entry?.preauthId, policy.meta?.id, 'recorded under the Meta pre-authorization');
    assert.match(entry?.data ?? '', /secrets removed, no file and no web page/);
    const threadId = String(h.provider.activeThreadId);
    assert.equal(policy.meta?.adviceUses[threadId], 1, 'counted against this conversation');
    assert.equal(policy.meta?.usedTokens, 50, 'the reserved bound was settled to what Meta reported');
    // The same conversation has used its one consultation: the card again, nothing sent.
    await failingRun();
    assert.equal(fakeCloud.requests.length, 1);
    assert.notEqual(h.provider.consultOffer, null);
    assert.match(String(fullMetaRefusalNow(host(h), await scopeOf(h), { dataScope: 'instructions', key: threadId })), /at most 1 consultation\(s\) per Mission or Agent conversation/);
    await dismissConsult(host(h));
    // Revoking Full Access revokes the Meta pre-authorization given with it; one given on its own stays.
    await onAutonomyMessage(host(h), { type: 'autonomyRevoke', what: 'full' });
    assert.equal(h.provider.autonomy.get(await scopeOf(h)).meta, null, 'gone with Full Access');
    await preauthorizeMeta(h, { max: 1 });
    await turnOnFull(h, FILES_TESTS);
    await onAutonomyMessage(host(h), { type: 'autonomyRevoke', what: 'full' });
    assert.notEqual(h.provider.autonomy.get(await scopeOf(h)).meta, null, 'a Meta pre-authorization of its own is not Full Access\'s to revoke');
  });
});

test('Full Access with Meta checks provider, model, key, data scope, count and budget, and reserves atomically: concurrent consultations never share the last slot or the last tokens', async () => {
  await withHarness({}, async (h) => {
    const scopeId = await scopeOf(h);
    await turnOnFull(h, { ...FILES_TESTS, meta: true }, { maxPerMission: 2, dataScope: 'instructions', tokenBudget: 100_000 });
    // Count per conversation (no count limit would need a pre-authorization without one).
    const four = await Promise.all([1, 2, 3, 4].map(() => fullMetaNow(host(h), scopeId, { dataScope: 'instructions', key: 'thr_a' }, 10)));
    assert.deepEqual(four.map((entry) => entry.ok), [true, true, false, false]);
    // Budget: two of 60 000 tokens do not fit in 100 000, whichever conversation asks.
    const budget = await Promise.all(['thr_b', 'thr_c'].map((key) => fullMetaNow(host(h), scopeId, { dataScope: 'instructions', key }, 60_000)));
    assert.deepEqual(budget.map((entry) => entry.ok), [true, false]);
    assert.match((budget[1] as { why: string }).why, /could use up to 60000 tokens/);
    assert.equal(h.provider.autonomy.get(scopeId).meta?.usedTokens, 60_020);
    // Data scope: files only with a pre-authorization that includes them.
    assert.match(String(fullMetaRefusalNow(host(h), scopeId, { dataScope: 'files', count: 1 })), /covers only instructions and the host's notes, not project files/);
    // The review's own count must fit the pre-authorization: no count limit never does here.
    assert.match(String(fullMetaRefusalNow(host(h), scopeId, { dataScope: 'instructions', count: null })), /allows at most 2 consultation\(s\) per Mission/);
    assert.equal(fullMetaRefusalNow(host(h), scopeId, { dataScope: 'instructions', count: 2 }), null);
    // Another model, another key or cloud escalation OFF: nothing.
    // (P5h) Consultations go to the advisor model: changing it is what changes the recipient.
    const advisor = h.provider.settings.advisorModel;
    h.provider.settings = { ...h.provider.settings, advisorModel: 'muse-wonder-1.0' };
    assert.match(String(fullMetaRefusalNow(host(h), scopeId, { dataScope: 'instructions', key: 'thr_d' })), /covers Meta muse-spark-1\.3, and the advisor model now is muse-wonder-1\.0/);
    h.provider.settings = { ...h.provider.settings, advisorModel: advisor };
    const credential = h.provider.metaCredential;
    h.provider.metaCredential = 'f'.repeat(32);
    assert.match(String(fullMetaRefusalNow(host(h), scopeId, { dataScope: 'instructions', key: 'thr_d' })), /the Meta API key changed/);
    h.provider.metaCredential = credential;
    h.provider.settings = { ...h.provider.settings, allowCloudEscalation: false };
    assert.match(String(fullMetaRefusalNow(host(h), scopeId, { dataScope: 'instructions', key: 'thr_d' })), /cloud escalation is OFF/);
    h.provider.settings = { ...h.provider.settings, allowCloudEscalation: true };
    // Full Access again without its Meta part: the Meta pre-authorization it carried goes with the old grant.
    await turnOnFull(h, FILES_TESTS);
    assert.equal(h.provider.autonomy.get(scopeId).meta, null);
    assert.match(String(fullMetaRefusalNow(host(h), scopeId, { dataScope: 'instructions', key: 'thr_d' })), /Full Access does not include Meta consultations when the main model cannot finish/);
    await onAutonomyMessage(host(h), { type: 'autonomyRevoke', what: 'full' });
    assert.equal((await fullMetaNow(host(h), scopeId, { dataScope: 'instructions', key: 'thr_d' }, 1)).ok, false);
  });
});

// ----- 2-4. The acceptance review -----

const PLAN = {
  goal: 'Create a calculator whose add function sums two numbers.',
  assumptions: [],
  steps: [{ id: 'build', title: 'Implement calculator', successCriterion: 'npm:check proves addition and edge cases' }],
  risks: [],
};
const REVIEW = {
  requirements: [{ requirement: 'Addition is correct', tests: ['positive and negative operands'], coverage: 'The selected test covers both.' }],
  risks: ['NaN is not covered'],
  additionalCases: ['zero operands'],
  recommendation: 'Keep the selected check and add a zero case.',
};
const reviewReply = () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(REVIEW) }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 } });

async function awaitingReview(h: HostHarness): Promise<MissionRecord> {
  await h.writeFile('package.json', JSON.stringify({ name: 'review', private: true, scripts: { check: 'node acceptance/check.js' } }));
  await h.writeFile('acceptance/check.js', `// local path ${h.workspace}\nconst API_TOKEN = "PRIVATE-REVIEW-TOKEN-991";\nrequire('node:assert').equal(2 + 3, 5);\n`);
  h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: PLAN }]) });
  await h.provider.sendMessage(PLAN.goal, 'mission', 'local');
  const initial = stored(h);
  const update = await h.provider.missions.update(initial.id, initial.revision, (draft) => {
    draft.awaitingVerification = true;
    return { ok: true, value: draft };
  });
  assert.equal(update.ok, true);
  return stored(h);
}

const prepare = (h: HostHarness, maxConsultations: number) => {
  const mission = stored(h);
  return prepareAcceptanceReview(h.provider, { missionId: mission.id, revision: mission.revision, commandId: 'npm:check', files: ['acceptance/check.js'], maxConsultations });
};

test('the acceptance review: no fixed limit of five (10, 100, 1000 or no count limit, the token total still capped); sent without its card only with Full Access Meta and a pre-authorization that includes files', async () => {
  await withHarness({ agentProfile: 'safe-auto', mode: 'mission', cloudModel: 'muse-spark-1.3' }, async (h) => {
    fakeCloud.handler = reviewReply;
    const mission = await awaitingReview(h);
    // 3. The view and the host accept more than five, and no count limit; never 0, 6 or anything else.
    const message = { type: 'acceptanceReviewPrepare', missionId: mission.id, revision: mission.revision, commandId: 'npm:check', files: ['acceptance/check.js'], maxRequestBytes: null, maxOutputTokens: null, maxTotalTokens: null };
    for (const count of [1, 5, 10, 100, 1000, -1]) {
      assert.equal((parseRemoteMessage({ ...message, maxConsultations: count }) as { maxConsultations: number }).maxConsultations, count);
    }
    for (const count of [0, 6, 7, 1001, -2]) {
      assert.throws(() => parseRemoteMessage({ ...message, maxConsultations: count }), String(count));
    }
    await prepare(h, -1);
    assert.equal(stored(h).acceptanceReview?.maxConsultations, null, 'no count limit');
    assert.equal(stored(h).acceptanceReview?.maxTotalTokens, ACCEPTANCE_REVIEW_MAX_TOTAL_TOKENS, 'the token total keeps its ceiling');
    assert.equal(stored(h).acceptanceReview?.status, 'offered', 'without Full Access it waits on its card');
    await prepare(h, 10);
    assert.equal(stored(h).acceptanceReview?.maxConsultations, 10);
    assert.equal(fakeCloud.requests.length, 0, 'nothing sent without a card');
    // 2/4. Full Access Meta chosen with instructions only: the card stays, and says why.
    await turnOnFull(h, { ...NONE, meta: true }, { maxPerMission: 10, dataScope: 'instructions', tokenBudget: null });
    await prepare(h, 3);
    assert.equal(stored(h).acceptanceReview?.status, 'offered');
    assert.match(String(h.last().status), /Not sent without its card: the Meta pre-authorization covers only instructions and the host's notes, not project files/);
    assert.equal(fakeCloud.requests.length, 0);
    // With files, and a count that fits: sent at once, recorded as Full Access, without the secret or the path.
    await turnOnFull(h, { ...NONE, meta: true }, { maxPerMission: 10, dataScope: 'files', tokenBudget: null });
    await prepare(h, 3);
    assert.equal(fakeCloud.requests.length, 1, String(h.last().status));
    assert.equal(stored(h).acceptanceReview?.status, 'completed');
    const body = JSON.stringify(fakeCloud.requests[0]?.body);
    assert.equal(body.includes('PRIVATE-REVIEW-TOKEN-991'), false);
    assert.equal(body.includes(h.workspace), false);
    const policy = h.provider.autonomy.get(await scopeOf(h));
    assert.equal(policy.log.at(-1)?.approval, 'full-access');
    assert.equal(policy.log.at(-1)?.preauthId, policy.meta?.id);
    assert.equal(policy.meta?.usedTokens, 110, 'within the pre-authorization: settled to what Meta reported');
    // A count beyond the pre-authorization (no count limit over 10) keeps the card.
    await prepare(h, -1);
    assert.equal(stored(h).acceptanceReview?.status, 'offered');
    assert.match(String(h.last().status), /allows at most 10 consultation\(s\) per Mission/);
    assert.equal(fakeCloud.requests.length, 1);
  });
});

// ----- A blocked Mission under Full Access with Meta -----

test('a blocked Mission under Full Access with Meta: its consultation goes without a card and the Mission is retried with the advice, within the count; then the card waits for the user', async () => {
  await withHarness({ mode: 'mission' }, async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { test: 'node t.js', check: 'node c.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await h.writeFile('c.js', 'process.exit(1);\n');
    h.model.enqueue(tool('plan', 'submit_mission_plan', { goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'Fix it', successCriterion: 'npm:check passes' }], risks: [] }));
    await h.provider.sendMessage('Make npm:check pass.', 'mission', 'local');
    const mission = stored(h);
    await turnOnFull(h, { ...FILES_TESTS, meta: true }, { maxPerMission: 2, dataScope: 'instructions', tokenBudget: null });
    // Every internal run only says "done" and the check keeps failing: the Mission blocks for lack of progress.
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const policy = h.provider.autonomy.get(await scopeOf(h));
    // The second consultation means the Mission was retried with the first advice and blocked again.
    assert.equal(fakeCloud.requests.length, 2, `two consultations, the pre-authorized count (${String(h.last().status)})`);
    assert.equal(policy.meta?.adviceUses[mission.id], 2, 'counted against this Mission');
    assert.deepEqual(policy.log.filter((entry) => entry.provider === 'Meta Model API').map((entry) => entry.approval), ['full-access', 'full-access']);
    for (const request of fakeCloud.requests) {
      assert.equal(JSON.stringify(request.body).includes(h.workspace), false, 'no local path');
    }
    const after = stored(h);
    assert.equal(after.status, 'blocked');
    assert.notEqual(h.provider.consultOffer, null, 'beyond the count, the card waits for the user with the exact text');
    assert.equal(h.provider.consultOffer?.missionId, mission.id);
  });
});

test('a blocked Mission under Full Access with Meta and no count limit: at most three automatic retries in a row, then it waits for the user', async () => {
  await withHarness({ mode: 'mission' }, async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { test: 'node t.js', check: 'node c.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await h.writeFile('c.js', 'process.exit(1);\n');
    h.model.enqueue(tool('plan', 'submit_mission_plan', { goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'Fix it', successCriterion: 'npm:check passes' }], risks: [] }));
    await h.provider.sendMessage('Make npm:check pass.', 'mission', 'local');
    const mission = stored(h);
    await turnOnFull(h, { ...FILES_TESTS, meta: true }, { maxPerMission: null, dataScope: 'instructions', tokenBudget: null });
    // The Mission's own run budget (8 for one task) would stop it first; at its ceiling, the retry limit is what stops it.
    const roomy = await h.provider.missions.update(mission.id, mission.revision, (draft) => {
      draft.maxTaskRuns = 30;
      return { ok: true, value: draft };
    });
    assert.ok(roomy.ok);
    await h.provider.startMission(mission.id, stored(h).revision, 'autonomous-workspace', null, true);
    // The first block and three retries, each followed by a consultation; after the third retry it stops.
    assert.equal(fakeCloud.requests.length, 4, String(h.last().status));
    assert.equal(stored(h).status, 'blocked');
    assert.match(String(h.last().status), /Full Access already retried this Mission 3 times with Meta's advice; it waits for you now\./);
  });
});
