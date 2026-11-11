/**
 * The user's decisions of 08-11-2026 (P5h):
 *
 * 1. Two models, chosen apart: the main model (Glimmer or another local
 *    model, or a Meta Model API model) does the work and uses RAME's tools
 *    in Agent and in every task of a Mission, never switched silently to
 *    Glimmer; the advisor only answers a consultation in text.
 * 2. The advisor must be a different model that Meta's documentation
 *    describes as more capable (Wonder over Spark; any Meta model over a
 *    local one); otherwise there is no escalation, never the main model
 *    itself and never an invented model.
 * 3. Full Access authorizes only the selected local tools and bounded Meta
 *    consultations. It never replaces the disclosure card of a Meta main
 *    model; a Mission authorized with Meta as its main model is covered by
 *    its own card. Permissions, budgets and data limits stay in force.
 *
 * Everything is simulated: Meta is the harness's fakeCloud, tests are
 * `node` one-liners. No paid request and no real Meta call.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeCloud, HostHarness, toolCallReply } from './helpers/hostHarness.js';
import { ADVICE, API_KEY_SECRET, KEY, tool } from './helpers/autonomyBench.js';
import { advisorOptions, advisorRefusal, DEFAULT_ADVISOR, DOCUMENTED_CAPABILITY } from '../src/advisorModels.js';
import { onAutonomyMessage } from '../src/autonomyEntry.js';
import { type FullTools } from '../src/autonomyPolicy.js';
import { FALLBACK_CLOUD_MODEL_IDS } from '../src/metaCatalog.js';
import { memoryScopeForUi } from '../src/memoryController.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import type { ProviderHost } from '../src/providerTypes.js';
import { approveConsult } from '../src/remoteController.js';
import { validateSettings } from '../src/settingsStore.js';
import { parseLocalSourceMessage } from '../src/localSourceView.js';
import { parseAutonomyMessage } from '../src/autonomyView.js';

const CATALOG = [...FALLBACK_CLOUD_MODEL_IDS, 'muse-spark-1.3-contributor', 'muse-spark-2.0'];
const NONE: FullTools = { files: false, tests: false, commands: false, installs: false, jobs: false, web: false, meta: false };
const host = (h: HostHarness) => h.provider as unknown as ProviderHost;
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;
const usage = { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 };
const sayReply = (text: string) => Response.json({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage });
const adviceReply = () => Response.json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(ADVICE) }, finish_reason: 'stop' }], usage });
type Body = { model?: string; tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; content?: unknown }> };
const toolNames = (body: Body) => (body.tools ?? []).map((entry) => entry.function.name);

async function scopeOf(h: HostHarness): Promise<string> {
  const scope = await memoryScopeForUi(host(h));
  assert.ok(scope.ok);
  return scope.scopeId;
}

/** Meta as the main model: Spark 1.3 does the work; the advisor chosen in Settings. */
async function withMetaMain(advisor: string, body: (h: HostHarness) => Promise<void>, settings: Record<string, unknown> = {}): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true, ...settings });
  h.secretValues.set(API_KEY_SECRET, KEY);
  await h.provider.refreshHasKey();
  h.provider.confirmAutonomy = async () => true;
  h.provider.settings = { ...h.provider.settings, provider: 'cloud', model: 'muse-spark-1.3', cloudModel: 'muse-spark-1.3', advisorModel: advisor };
  fakeCloud.requests.length = 0;
  try {
    await body(h);
  } finally {
    fakeCloud.handler = null;
    fakeCloud.requests.length = 0;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

/**
 * Spark answers as the main model (it runs the failing or passing test, then
 * reports); Wonder answers as the advisor. A request to any other model fails.
 */
function metaBackend(): void {
  fakeCloud.handler = (raw) => {
    const body = raw as Body;
    if (body.model === 'muse-wonder-1.0') {
      return adviceReply();
    }
    if (body.model !== 'muse-spark-1.3') {
      return Response.json({ error: { message: `unexpected model ${String(body.model)}` } }, { status: 400 });
    }
    const last = body.messages?.at(-1);
    return last?.role === 'tool' ? sayReply('Done.') : Response.json(toolCallReply([{ id: `r${fakeCloud.requests.length}`, name: 'run_tests', args: { commandId: 'npm:check' } }], usage));
  };
}

/** The first Agent run with Meta in a session asks about tool results: allow them (the user's card). */
async function answerDisclosure(h: HostHarness, choice: 'include' | 'withhold' = 'include'): Promise<void> {
  const card = (h.last().remote as { disclosure: { digest: string } | null }).disclosure;
  if (card) {
    h.send({ type: 'disclosureDecide', digest: card.digest, choice, toolResults: true });
    await h.waitFor((state) => !state.running && (state.remote as { disclosure: unknown }).disclosure === null, 20000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.waitFor((state) => !state.running, 20000);
  }
}

// ----- 2. Which model may advise which -----

test('the advisor must be another model that Meta documents as more capable: Wonder over Spark, any Meta model over a local one; never the main model itself, a Contributor variant, an unlisted or undocumented model', () => {
  const local = { provider: 'local' as const, model: 'local-glimmer' };
  const spark = { provider: 'cloud' as const, model: 'muse-spark-1.3' };
  const wonder = { provider: 'cloud' as const, model: 'muse-wonder-1.0' };
  const eligible = (main: typeof local | typeof spark) => advisorOptions(main, CATALOG).filter((entry) => entry.eligible).map((entry) => entry.id);
  // Glimmer (or any local model): every documented Standard Meta model.
  assert.deepEqual(eligible(local), ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1', 'muse-wonder-1.0']);
  // Spark: only Wonder, Meta's most capable model. Another Spark version is not documented as more capable.
  assert.deepEqual(eligible(spark), ['muse-wonder-1.0']);
  assert.match(String(advisorRefusal(spark, 'muse-spark-1.3', CATALOG)), /is the main model itself: consulting it is not an escalation/);
  assert.match(String(advisorRefusal(spark, 'muse-spark-1.2', CATALOG)), /not documented as more capable than the main model muse-spark-1\.3/);
  // Wonder: nothing above it on the API, so no escalation at all.
  assert.deepEqual(eligible(wonder), []);
  // Never a Contributor variant, never a model the catalog does not list, never one Meta does not document.
  assert.match(String(advisorRefusal(local, 'muse-spark-1.3-contributor', CATALOG)), /Contributor variant \(Meta may use the data\), never an advisor/);
  assert.match(String(advisorRefusal(local, 'muse-wonder-1.0', ['muse-spark-1.3'])), /not in the Meta API catalog RAME loaded/);
  assert.match(String(advisorRefusal(local, 'muse-spark-2.0', CATALOG)), /does not describe what muse-spark-2\.0 can do/);
  assert.match(String(advisorRefusal({ provider: 'cloud', model: 'muse-spark-2.0' }, 'muse-wonder-1.0', CATALOG)), /does not rank the main model muse-spark-2\.0/);
  assert.match(String(advisorRefusal(local, '', CATALOG)), /no advisor model is chosen/);
  assert.match(String(advisorRefusal(local, 'gpt-5', CATALOG)), /is not a Meta chat model/);
  // The ranks come from Meta's documentation only (read on 08-11-2026).
  assert.equal(DOCUMENTED_CAPABILITY['muse-wonder-1.0']?.rank, 3);
  assert.equal(DOCUMENTED_CAPABILITY['muse-spark-1.3']?.rank, 2);
});

test('settings: the advisor is its own setting (Spark by default, the old escalation model when migrating, "none" kept); terminal isolation defaults to Project', () => {
  const fresh = validateSettings(undefined);
  assert.equal(fresh.advisorModel, DEFAULT_ADVISOR);
  assert.equal(fresh.shell.isolation, 'project');
  // Before P5h, escalation went to the selected cloud model: kept.
  assert.equal(validateSettings({ provider: 'local', cloudModel: 'muse-spark-1.2' }).advisorModel, 'muse-spark-1.2');
  assert.equal(validateSettings({ provider: 'local', cloudModel: 'muse-spark-1.2', advisorModel: '' }).advisorModel, '', 'none stays none');
  assert.equal(validateSettings({ provider: 'cloud', cloudModel: 'muse-spark-1.3', advisorModel: 'muse-wonder-1.0' }).advisorModel, 'muse-wonder-1.0');
  assert.equal(validateSettings({ cloudModel: 'muse-spark-1.3', advisorModel: 'rm -rf /' }).advisorModel, 'muse-spark-1.3', 'an invalid value falls back');
  for (const level of ['total', 'project', 'closed'] as const) {
    assert.equal(validateSettings({ shell: { enabled: true, isolation: level } }).shell.isolation, level);
  }
  assert.equal(validateSettings({ shell: { enabled: true, isolation: 'none' } }).shell.isolation, 'project');
  assert.equal(validateSettings({ shell: { enabled: true } }).shell.isolation, 'project', 'older settings get the default');
});

// ----- 1. Meta as the main model works directly, in Agent -----

test('Agent with Meta Spark as the main model: Spark itself calls the tools (web and commands too); when it is stuck it consults Wonder, never itself, and Spark continues with the advice', async () => {
  await withMetaMain('muse-wonder-1.0', async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { check: 'node c.js' } }));
    await h.writeFile('c.js', 'process.exit(1);\n');
    h.provider.settings = { ...h.provider.settings, shell: { enabled: true, isolation: 'project' }, web: { enabled: true, search: 'duckduckgo', searxngUrl: '' } };
    metaBackend();
    const localBefore = h.model.requests.length;
    await h.provider.sendMessage('Make npm:check pass.', 'agent', 'cloud');
    await answerDisclosure(h);
    const main = fakeCloud.requests.filter((request) => (request.body as Body).model === 'muse-spark-1.3');
    assert.ok(main.length >= 2, `Spark ran the Agent steps (${String(h.last().status)})`);
    const offered = toolNames(main[0]?.body as Body);
    for (const name of ['read_file', 'apply_patch', 'run_tests', 'run_command', 'web_search', 'web_fetch']) {
      assert.ok(offered.includes(name), `${name} is offered to Meta as the main model`);
    }
    assert.equal(h.model.requests.length, localBefore, 'Glimmer was never asked');
    // The run ended with the check failing: the consultation goes to the advisor, Wonder.
    const offer = h.provider.consultOffer;
    assert.ok(offer, String(h.last().status));
    assert.equal(offer.model, 'muse-wonder-1.0');
    assert.equal(offer.localModel, 'muse-spark-1.3', 'Spark keeps the tools');
    assert.equal(offer.mainProvider, 'cloud');
    const before = fakeCloud.requests.length;
    await approveConsult(host(h), offer.digest);
    const after = fakeCloud.requests.slice(before);
    assert.equal(after[0]?.body.model, 'muse-wonder-1.0', 'the advisor answered first');
    assert.equal(toolNames(after[0]?.body as Body).length, 0, 'the advisor gets no tools');
    assert.ok(after.slice(1).length > 0 && after.slice(1).every((request) => request.body.model === 'muse-spark-1.3'), 'then Spark, the main model, continued with the advice');
    assert.equal(h.model.requests.length, localBefore, 'never switched to Glimmer');
  }, { agentProfile: 'workspace-full' });
});

test('Agent with Meta Spark as the main model and Spark as the "advisor": no consultation at all (it would be the same model), and the status says why', async () => {
  await withMetaMain('muse-spark-1.3', async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { check: 'node c.js' } }));
    await h.writeFile('c.js', 'process.exit(1);\n');
    metaBackend();
    await h.provider.sendMessage('Make npm:check pass.', 'agent', 'cloud');
    await answerDisclosure(h);
    assert.equal(h.provider.consultOffer, null);
    assert.match(String(h.last().status), /No advisor to consult: muse-spark-1\.3 is the main model itself: consulting it is not an escalation\. Nothing was sent\./);
    assert.ok(fakeCloud.requests.every((request) => request.body.model === 'muse-spark-1.3'), 'Meta was asked only as the main model');
  }, { agentProfile: 'workspace-full' });
});

// ----- 3. Full Access and the disclosure card of a Meta main model -----

test('Full Access for files and tests never bypasses the disclosure card of a Meta main model', async () => {
  await withMetaMain('muse-wonder-1.0', async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { check: 'node c.js' } }));
    await h.writeFile('c.js', 'process.exit(0);\n');
    // An earlier local message in the same conversation, never answered on a card.
    h.provider.settings = { ...h.provider.settings, provider: 'local' };
    h.model.enqueue({ kind: 'json', body: { choices: [{ message: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }], usage } });
    await h.provider.sendMessage('Remember LOCAL-ONLY-MARKER-77.', 'agent', 'local');
    h.provider.settings = { ...h.provider.settings, provider: 'cloud' };
    await onAutonomyMessage(host(h), { type: 'autonomyFull', tools: { ...NONE, files: true, tests: true }, validityHours: 8 });
    assert.equal(h.provider.autonomy.get(await scopeOf(h)).mode, 'full', String(h.last().status));
    metaBackend();
    await h.provider.sendMessage('Run npm:check.', 'agent', 'cloud');
    const disclosure = (h.last().remote as { disclosure: { digest: string } | null }).disclosure;
    assert.ok(disclosure, 'the Meta disclosure card is mandatory');
    assert.equal(fakeCloud.requests.length, 0, 'nothing reached Meta before the explicit disclosure answer');
    await answerDisclosure(h, 'withhold');
    assert.ok(fakeCloud.requests.length >= 2, String(h.last().status));
    const sent = JSON.stringify(fakeCloud.requests.map((request) => request.body));
    assert.equal(sent.includes('LOCAL-ONLY-MARKER-77'), false, 'an earlier local message is not sent without its card');
    assert.ok(fakeCloud.requests.some((request) => ((request.body as Body).messages ?? []).some((message) => message.role === 'tool')), 'the run\'s own tool results went to Meta');
    const entry = h.provider.autonomy.get(await scopeOf(h)).log.find((item) => item.reason === 'Agent run with Meta as the main model');
    assert.equal(entry, undefined, 'the run was not misrecorded as authorized by Full Access');
  });
});

test('Full Access with its own "Meta as the main model" part, and only it: Agent with Spark goes without the disclosure card and sends only the run\'s request and tool results; another model, another key or revoking brings the card back', async () => {
  await withMetaMain('muse-wonder-1.0', async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { check: 'node c.js' } }));
    await h.writeFile('c.js', 'process.exit(0);\n');
    h.provider.settings = { ...h.provider.settings, provider: 'local' };
    h.model.enqueue({ kind: 'json', body: { choices: [{ message: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }], usage } });
    await h.provider.sendMessage('Remember LOCAL-ONLY-MARKER-88.', 'agent', 'local');
    h.provider.settings = { ...h.provider.settings, provider: 'cloud' };
    // The view: it is its own choice, only as true, never implied by a tool part.
    assert.throws(() => parseAutonomyMessage({ type: 'autonomyFull', tools: NONE, validityHours: 8 }), 'nothing chosen');
    assert.throws(() => parseAutonomyMessage({ type: 'autonomyFull', tools: NONE, validityHours: 8, metaMain: false }));
    assert.deepEqual(parseAutonomyMessage({ type: 'autonomyFull', tools: NONE, validityHours: 8, metaMain: true }), { type: 'autonomyFull', tools: NONE, validityHours: 8, metaMain: true });
    let shown = '';
    h.provider.confirmAutonomy = async (request) => {
      shown = request.detail;
      return true;
    };
    // Without it, the confirmation says so.
    await onAutonomyMessage(host(h), { type: 'autonomyFull', tools: { ...NONE, files: true }, validityHours: 8 });
    assert.match(shown, /• Meta as the main model: not included\. An Agent run with Meta as the main model keeps the card/);
    // With it: one confirmation that says what goes to Meta, that it is billed, and for which model and key.
    await onAutonomyMessage(host(h), { type: 'autonomyFull', tools: { ...NONE, files: true, tests: true, commands: true }, validityHours: 8, metaMain: true });
    assert.match(shown, /• Meta as the main model: Agent runs with Meta muse-spark-1\.3 in this workspace send, without the card that asks what may go to Meta, your request and the results of the tools[^]*Earlier local messages and project memory are not sent without their own card\. Another Meta model or another API key needs a new authorization/);
    assert.match(shown, /Every step of muse-spark-1\.3 as the main model uses your API key and is billed by Meta/);
    assert.match(shown, /Their isolation level is Project/);
    assert.deepEqual(h.provider.autonomy.get(await scopeOf(h)).full?.mainModel, { model: 'muse-spark-1.3', credentialRevision: h.provider.metaCredential });
    metaBackend();
    await h.provider.sendMessage('Run npm:check.', 'agent', 'cloud');
    assert.equal((h.last().remote as { disclosure: unknown }).disclosure, null, 'no disclosure card under this part');
    assert.ok(fakeCloud.requests.length >= 2, String(h.last().status));
    const sent = JSON.stringify(fakeCloud.requests.map((request) => request.body));
    assert.equal(sent.includes('LOCAL-ONLY-MARKER-88'), false, 'an earlier local message is not sent without its card');
    assert.ok(fakeCloud.requests.some((request) => ((request.body as Body).messages ?? []).some((message) => message.role === 'tool')), 'the run\'s own tool results went to Meta');
    const entry = h.provider.autonomy.get(await scopeOf(h)).log.find((item) => item.reason === 'Agent run with Meta as the main model');
    assert.equal(entry?.approval, 'full-access');
    assert.match(entry?.data ?? '', /2 earlier local message\(s\) not sent; project decisions not sent/);
    // Another Meta model, another key, or Full Access revoked: the card, and nothing sent before it is answered.
    const cardAgain = async (why: string) => {
      const before = fakeCloud.requests.length;
      await h.provider.sendMessage(`Again: ${why}.`, 'agent', 'cloud');
      assert.ok((h.last().remote as { disclosure: unknown }).disclosure, `the card is back: ${why}`);
      assert.equal(fakeCloud.requests.length, before, `nothing sent: ${why}`);
      h.provider.cloudDisclosureOffer = null;
    };
    h.provider.settings = { ...h.provider.settings, cloudModel: 'muse-spark-1.2' };
    await cardAgain('another Meta model');
    h.provider.settings = { ...h.provider.settings, cloudModel: 'muse-spark-1.3' };
    const credential = h.provider.metaCredential;
    h.provider.metaCredential = 'f'.repeat(32);
    await cardAgain('another API key');
    h.provider.metaCredential = credential;
    await onAutonomyMessage(host(h), { type: 'autonomyRevoke', what: 'full' });
    await cardAgain('Full Access revoked');
  }, { agentProfile: 'workspace-full' });
});

// ----- 1. Meta as the main model of a Mission, in every task -----

const PLAN = { goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'Fix it', successCriterion: 'npm:check passes' }], risks: [] };

async function plannedMission(h: HostHarness, check: string): Promise<MissionRecord> {
  await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { check: 'node c.js' } }));
  await h.writeFile('c.js', check);
  // Planned with the local model; the main model chosen when it is authorized is Meta.
  h.provider.settings = { ...h.provider.settings, provider: 'local', mode: 'mission' };
  h.model.enqueue(tool('plan', 'submit_mission_plan', PLAN));
  await h.provider.sendMessage(PLAN.goal, 'mission', 'local');
  h.provider.settings = { ...h.provider.settings, provider: 'cloud' };
  return stored(h);
}

test('a Mission authorized with Meta Spark as its main model: every task runs with Spark (no switch to Glimmer, no disclosure card), and an advisor equal to the main model is refused', async () => {
  await withMetaMain('muse-spark-1.3', async (h) => {
    const mission = await plannedMission(h, 'process.exit(0);\n');
    metaBackend();
    // Consultations with the main model itself as the advisor: nothing is authorized.
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 1 }, true);
    assert.equal(stored(h).grant, null);
    assert.match(String(h.last().status), /This Mission cannot consult an advisor: muse-spark-1\.3 is the main model itself/);
    // Without consultations: authorized for Meta Spark, and Spark does the task.
    const localBefore = h.model.requests.length;
    await h.provider.startMission(mission.id, stored(h).revision, 'autonomous-workspace', null, true);
    const grant = stored(h).grant;
    assert.equal(grant?.provider, 'cloud');
    assert.equal(grant?.model, 'muse-spark-1.3');
    assert.ok(fakeCloud.requests.length >= 2, String(h.last().status));
    assert.ok(fakeCloud.requests.every((request) => request.body.model === 'muse-spark-1.3' && toolNames(request.body as Body).includes('run_tests')), 'Spark called the tools');
    assert.equal(h.model.requests.length, localBefore, 'Glimmer was never asked');
    assert.equal((h.last().remote as { disclosure: unknown }).disclosure, null, 'the Mission card was the consent: no disclosure card');
    assert.equal(stored(h).status, 'completed', String(h.last().status));
    // Changing the selected model does not move the Mission to it: RAME refuses instead.
    h.provider.settings = { ...h.provider.settings, cloudModel: 'muse-spark-1.2' };
    const status = await h.provider.missions.update(stored(h).id, stored(h).revision, (draft) => {
      draft.status = 'interrupted';
      return { ok: true, value: draft };
    });
    assert.ok(status.ok);
    await h.provider.resumeMission(stored(h).id, stored(h).revision);
    assert.match(String(h.last().status), /authorized for Meta muse-spark-1\.3, which is not the model selected for it now; RAME does not switch its main model/);
  });
});

test('a blocked Mission with Meta Spark as its main model under Full Access with Meta: it consults Wonder without a card, and Spark (not Glimmer) retries with the advice', async () => {
  await withMetaMain('muse-wonder-1.0', async (h) => {
    const mission = await plannedMission(h, 'process.exit(1);\n');
    metaBackend();
    await onAutonomyMessage(host(h), { type: 'autonomyFull', tools: { ...NONE, files: true, tests: true, meta: true }, validityHours: 8, meta: { maxPerMission: 1, dataScope: 'instructions', tokenBudget: null } });
    const policy = h.provider.autonomy.get(await scopeOf(h));
    assert.equal(policy.meta?.model, 'muse-wonder-1.0', 'the Meta part covers the advisor model');
    const localBefore = h.model.requests.length;
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    const models = fakeCloud.requests.map((request) => String(request.body.model));
    const firstAdvice = models.indexOf('muse-wonder-1.0');
    assert.ok(firstAdvice > 0, `Wonder was consulted after Spark's runs (${models.join(', ')}; ${String(h.last().status)})`);
    assert.equal(models.filter((model) => model === 'muse-wonder-1.0').length, 1, 'within the pre-authorized count');
    assert.ok(models.slice(firstAdvice + 1).includes('muse-spark-1.3'), 'Spark retried the Mission with the advice');
    assert.ok(models.every((model) => model === 'muse-spark-1.3' || model === 'muse-wonder-1.0'));
    assert.equal(h.model.requests.length, localBefore, 'Glimmer was never asked');
    const advice = h.provider.autonomy.get(await scopeOf(h)).log.filter((entry) => entry.destination === 'muse-wonder-1.0');
    assert.deepEqual(advice.map((entry) => entry.approval), ['full-access']);
    assert.equal(stored(h).status, 'blocked');
  });
});

// ----- The view: choosing the advisor and the isolation level -----

test('the view: the advisor is chosen with "" or a Meta id and checked by the host against the main model; the view lists every catalog model with why it can or cannot advise; the isolation level travels with the terminal switch', async () => {
  assert.deepEqual(parseLocalSourceMessage({ type: 'advisorModelSet', model: 'muse-wonder-1.0' }), { type: 'advisorModelSet', model: 'muse-wonder-1.0' });
  assert.deepEqual(parseLocalSourceMessage({ type: 'advisorModelSet', model: '' }), { type: 'advisorModelSet', model: '' });
  for (const bad of [{ type: 'advisorModelSet', model: 'gpt-5' }, { type: 'advisorModelSet' }, { type: 'advisorModelSet', model: 'muse-wonder-1.0', extra: 1 }]) {
    assert.throws(() => parseLocalSourceMessage(bad), JSON.stringify(bad));
  }
  assert.deepEqual(parseLocalSourceMessage({ type: 'shellAccessSet', enabled: true, isolation: 'closed' }), { type: 'shellAccessSet', enabled: true, isolation: 'closed' });
  assert.deepEqual(parseLocalSourceMessage({ type: 'shellAccessSet', enabled: true }), { type: 'shellAccessSet', enabled: true });
  assert.throws(() => parseLocalSourceMessage({ type: 'shellAccessSet', enabled: true, isolation: 'none' }));
  await withMetaMain('muse-spark-1.3', async (h) => {
    const advisorView = () => ((h.last().remote as { servers: { advisor: { selected: string; problem: string; options: Array<{ id: string; eligible: boolean; reason: string }> } } }).servers.advisor);
    await h.provider.postState();
    assert.match(advisorView().problem, /is the main model itself/);
    const wonder = advisorView().options.find((option) => option.id === 'muse-wonder-1.0');
    assert.deepEqual(wonder, { id: 'muse-wonder-1.0', eligible: true, reason: "Meta's most capable model (preview)" });
    assert.equal(advisorView().options.find((option) => option.id === 'muse-spark-1.2')?.eligible, false);
    h.send({ type: 'advisorModelSet', model: 'muse-wonder-1.0' });
    await h.waitFor(() => h.provider.settings.advisorModel === 'muse-wonder-1.0');
    await h.waitFor((state) => /^Advisor model: muse-wonder-1\.0\. Meta muse-spark-1\.3 keeps the tools/.test(String(state.status)));
    assert.equal(advisorView().problem, '');
    // A model that cannot advise the main model now is kept (it may advise another), and the status says so.
    h.send({ type: 'advisorModelSet', model: 'muse-spark-1.2' });
    await h.waitFor((state) => /^Advisor model saved as muse-spark-1\.2, but it cannot advise the main model now: muse-spark-1\.2 is not documented as more capable/.test(String(state.status)));
    h.send({ type: 'shellAccessSet', enabled: true, isolation: 'closed' });
    await h.waitFor(() => h.provider.settings.shell.isolation === 'closed');
    assert.match(String(h.last().status), /isolated and closed: writes only in the project, temporary and package-cache folders; no network/);
  });
});
