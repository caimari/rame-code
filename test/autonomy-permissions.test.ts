/**
 * Autonomy & Permissions: pre-authorizations the user gives consciously,
 * per workspace, that let some external requests skip the card, and only
 * within what was authorized. Meta is simulated (fakeCloud) and the search
 * engine is a local fake: nothing leaves this machine.
 */

import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';

import { fakeCloud, HostHarness } from './helpers/hostHarness.js';
import { advice, API_KEY_SECRET, KEY, MODEL, say, tool, withBench, type Confirmation } from './helpers/autonomyBench.js';
import { onAutonomyMessage } from '../src/autonomyEntry.js';
import { autonomyView, handleAutonomyMessage, metaRefusalNow, useAgentWebNow } from '../src/autonomyHost.js';
import { metaConfirmation, metaRefusal, parseScopedFiles, parseWorkspaceAutonomy, type MetaBinding } from '../src/autonomyPolicy.js';
import { AutonomyStore } from '../src/autonomyStore.js';
import { parseAutonomyMessage } from '../src/autonomyView.js';
import { memoryScopeForUi } from '../src/memoryController.js';
import { consultForMission } from '../src/missionAdvice.js';
import { missionViewRuntime } from '../src/missionCoordinator.js';
import { defaultAdvisoryLimits } from '../src/missionAdvisoryLimits.js';
import { MISSION_STATE_KEY, MissionStore, type MissionRecord } from '../src/missionStore.js';
import type { ProviderHost } from '../src/providerTypes.js';

// ----- The real host, through the harness -----

async function withHarness(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', allowCloudEscalation: true, ...settings });
  h.secretValues.set(API_KEY_SECRET, KEY);
  await h.provider.refreshHasKey();
  fakeCloud.requests.length = 0;
  fakeCloud.handler = advice;
  try {
    await body(h);
  } finally {
    fakeCloud.handler = null;
    h.provider.cancelRequest();
    await h.dispose();
  }
}

const host = (h: HostHarness) => h.provider as unknown as ProviderHost;
const scopeOf = async (h: HostHarness): Promise<string> => {
  const scope = await memoryScopeForUi(host(h));
  assert.ok(scope.ok);
  return scope.scopeId;
};

async function planMission(h: HostHarness): Promise<MissionRecord> {
  await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { test: 'node t.js', check: 'node c.js' } }));
  await h.writeFile('t.js', 'process.exit(0);\n');
  await h.writeFile('c.js', 'process.exit(1);\n');
  h.model.enqueue(tool('plan', 'submit_mission_plan', { goal: 'Make npm:check pass.', assumptions: [], steps: [{ id: 't1', title: 'Fix it', successCriterion: 'npm:check passes' }], risks: [] }));
  await h.provider.sendMessage('Make npm:check pass.', 'mission', 'local');
  return ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;
}

const storedMission = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;

// ----- 1. Off by default -----

test('off by default: Ask always, no pre-authorization, and a Mission cannot be given Meta consultations or an autonomous web budget', async () => {
  assert.deepEqual(parseWorkspaceAutonomy(undefined, 'ws_1', 'env_0123456789abcdef'), { mode: 'ask', meta: null, missionWeb: null, agentWeb: null, full: null, log: [] });
  // A stored pre-authorization under the wrong mode or workspace is dropped to the safe side.
  assert.equal(parseWorkspaceAutonomy({ mode: 'ask', meta: { id: 'pre_0123456789abcdef' } }, 'ws_1', 'env_0123456789abcdef').meta, null);
  await withHarness({ mode: 'mission' }, async (h) => {
    await onAutonomyMessage(host(h), { type: 'autonomyRefresh' });
    const view = autonomyView(host(h));
    assert.equal(view?.mode, 'ask');
    assert.equal(view?.meta, null);
    assert.equal(view?.sessionWeb, null);
    const mission = await planMission(h);
    // The card does not even offer Meta consultations without a pre-authorization.
    assert.equal(missionViewRuntime(host(h), mission).cloudEscalationAllowed, false);
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', { maxConsultations: 1 }, true);
    assert.equal(storedMission(h).grant, null);
    assert.match(String(h.last().status), /Meta consultations in a Mission need a pre-authorization in Settings → Security → Autonomy & Permissions \(Autonomy & Permissions is set to Ask always for this workspace\)\. Nothing was authorized\./);
    h.send({ type: 'missionWebSet', missionId: mission.id, enabled: true, maxSearches: 2, maxFetches: 1, domains: [] });
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    assert.equal(storedMission(h).grant, null);
    assert.match(String(h.last().status), /Web access for an autonomous Mission needs a pre-authorization/);
    assert.equal(fakeCloud.requests.length, 0, 'nothing sent');
  });
});

// ----- 2. Conscious activation -----

test('activation needs the modal confirmation, which states every point; without it, or refused, nothing is pre-authorized', async () => {
  const text = metaConfirmation({ project: 'shop', model: MODEL, maxPerMission: 2, validityMs: 8 * 3_600_000, dataScope: 'files', now: Date.now() });
  for (const point of [/leaves this computer/, /Meta Model API \(Meta\), model muse-spark-1\.3/, /can include code and fragments of project files/, /may be billed by Meta/, /At most 2 consultation\(s\) per Mission/, /Valid for 8 hour\(s\), until /, /revoke it at any time/, /never switches the main model of a Mission: the advisor only advises, receives no tools/, /Never sent automatically: secrets or credentials, the verifier's hidden files, seeds, protected records/]) {
    assert.match(text.detail, point);
  }
  await withHarness({}, async (h) => {
    const self = h.provider as unknown as { confirmAutonomy?: (request: Confirmation) => Promise<boolean> };
    const scopeId = await scopeOf(h);
    // Not before choosing supervised autonomy.
    await onAutonomyMessage(host(h), { type: 'autonomyMeta', maxPerMission: 2, validityHours: 8, dataScope: 'instructions' });
    assert.match(String(h.last().status), /Choose supervised autonomy first/);
    await onAutonomyMessage(host(h), { type: 'autonomyMode', mode: 'supervised' });
    // A host without the dialog refuses.
    self.confirmAutonomy = undefined;
    await onAutonomyMessage(host(h), { type: 'autonomyMeta', maxPerMission: 2, validityHours: 8, dataScope: 'instructions' });
    assert.equal(h.provider.autonomy.get(scopeId).meta, null);
    // The user closes the dialog.
    const shown: Confirmation[] = [];
    self.confirmAutonomy = async (request) => {
      shown.push(request);
      return false;
    };
    await onAutonomyMessage(host(h), { type: 'autonomyMeta', maxPerMission: 2, validityHours: 8, dataScope: 'instructions' });
    assert.equal(h.provider.autonomy.get(scopeId).meta, null);
    assert.match(String(h.last().status), /Meta was not pre-authorized: the confirmation was not accepted/);
    assert.equal(shown.length, 1);
    assert.match(shown[0]?.message ?? '', /Allow RAME Code to consult Meta muse-spark-1\.3 without asking each time/);
    // The user clicks its action.
    self.confirmAutonomy = async () => true;
    await onAutonomyMessage(host(h), { type: 'autonomyMeta', maxPerMission: 2, validityHours: 8, dataScope: 'instructions' });
    const meta = h.provider.autonomy.get(scopeId).meta;
    assert.equal(meta?.maxPerMission, 2);
    assert.equal(meta?.model, MODEL);
    assert.equal(meta?.provider, 'Meta Model API');
    assert.equal(meta?.scopeId, scopeId);
    assert.ok(meta && meta.expiresAt - meta.grantedAt === 8 * 3_600_000);
    // Malformed requests never reach the host: limits outside 1–5, unknown validity, extra keys.
    for (const raw of [{ type: 'autonomyMeta', maxPerMission: 6, validityHours: 8, dataScope: 'instructions' }, { type: 'autonomyMeta', maxPerMission: 0, validityHours: 8, dataScope: 'instructions' }, { type: 'autonomyMeta', maxPerMission: 2, validityHours: 3, dataScope: 'instructions' }, { type: 'autonomyMeta', maxPerMission: 2, validityHours: 8, dataScope: 'all' }, { type: 'autonomyMeta', maxPerMission: 2, validityHours: 8, dataScope: 'instructions', confirmed: true }]) {
      assert.throws(() => parseAutonomyMessage(raw));
    }
  });
});

// ----- 3. Meta and Internet apart -----

test('Meta and Internet are separate: one pre-authorization never grants the other, and revoking one leaves the other', async () => {
  const searx = await fakeSearx([{ title: 'Node', url: 'https://nodejs.org/en', content: 'LTS' }]);
  try {
    await withHarness({ mode: 'mission', web: { enabled: true, search: 'searxng', searxngUrl: searx.origin } }, async (h) => {
      await h.preauthorize({ meta: 2 });
      const scopeId = await scopeOf(h);
      const mission = await planMission(h);
      // Meta does not open the web: an autonomous web budget is still refused.
      h.send({ type: 'missionWebSet', missionId: mission.id, enabled: true, maxSearches: 2, maxFetches: 1, domains: [] });
      await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
      assert.equal(storedMission(h).grant, null);
      assert.match(String(h.last().status), /Web access for an autonomous Mission needs a pre-authorization/);
      // Nor the Agent's web without cards.
      assert.equal(await useAgentWebNow(h.provider, 'web_search', { query: 'node lts' }, h.workspace), false);
      // Web for Missions does not open Meta: revoke Meta, keep web.
      await h.preauthorize({ missionWeb: true });
      await onAutonomyMessage(host(h), { type: 'autonomyRevoke', what: 'meta' });
      assert.equal(h.provider.autonomy.get(scopeId).meta, null);
      assert.notEqual(h.provider.autonomy.get(scopeId).missionWeb, null);
      assert.notEqual(metaRefusalNow(host(h), scopeId, null), null);
      const fresh = storedMission(h);
      await h.provider.startMission(fresh.id, fresh.revision, 'autonomous-workspace', { maxConsultations: 1 }, true);
      assert.equal(storedMission(h).grant, null, 'web for Missions never authorizes Meta');
      assert.equal(fakeCloud.requests.length, 0);
      assert.equal(searx.queries.length, 0);
    });
  } finally {
    await searx.close();
  }
});

// ----- 4. The limit -----

test('the limit: a card cannot ask for more than the pre-authorized maximum, and a Mission never sends more than its own count', async () => {
  await withBench(async (b) => {
    await b.authorize({ max: 2 });
    const over = await b.grant(3);
    assert.equal(over.ok, false);
    assert.match(over.error ?? '', /allows at most 2 consultation\(s\) per Mission/);
    assert.ok((await b.grant(1)).ok);
    for (let attempt = 0; attempt < 4; attempt++) {
      await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    }
    assert.equal(fakeCloud.requests.length, 1, 'one consultation, as the card chose');
    assert.equal(b.mission().grant?.escalation?.used, 1);
  });
});

// ----- 5. Revocation, also while a consultation is being sent -----

test('revocation: no new consultation under it, and the one being sent is aborted; the record says what happened', async () => {
  await withBench(async (b) => {
    await b.authorize({ max: 3 });
    assert.ok((await b.grant(3)).ok);
    // A consultation is on its way when the user revokes.
    let release: () => void = () => undefined;
    fakeCloud.handler = () => {
      void handleAutonomyMessage(b.host, { type: 'autonomyRevoke', what: 'all' }, b.scope);
      return new Promise<Response>((resolve) => {
        release = () => resolve(advice());
      }) as unknown as Response;
    };
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    release();
    assert.equal(fakeCloud.requests.length, 1, 'it had left: it counts, and it was cancelled');
    assert.match(b.notes(), /attempt 1\/3 cancelled because the pre-authorization was revoked; what had already been sent cannot be taken back, and no advice was used/);
    assert.equal(b.mission().auto?.pendingAdvice, '', 'no advice is used');
    assert.equal(b.autonomy.get('ws_1').meta, null);
    const log = b.autonomy.get('ws_1').log;
    assert.equal(log.length, 1);
    assert.equal(log[0]?.approval, 'pre-authorized');
    assert.equal(log[0]?.outcome, 'cancelled: the pre-authorization was revoked');
    // Nothing more is sent under it.
    fakeCloud.handler = advice;
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    assert.equal(fakeCloud.requests.length, 1);
    assert.match(b.notes(), /remote advice not sent without a card: no Meta pre-authorization is in force|remote advice not sent without a card: Autonomy & Permissions is set to Ask always/);
    // A new pre-authorization does not revive the old binding: the Mission must be authorized again.
    await b.authorize({ max: 3 });
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    assert.equal(fakeCloud.requests.length, 1);
    assert.match(b.notes(), /this Mission was authorized under an earlier pre-authorization that was revoked or replaced/);
  });
});

// ----- 6. Expiry -----

test('expiry: an expired pre-authorization sends nothing and counts nothing', async () => {
  await withBench(async (b) => {
    await b.authorize();
    assert.ok((await b.grant(2)).ok);
    await b.autonomy.change('ws_1', (policy) => {
      if (policy.meta) {
        // Two hours later: given 2 h ago for 1 h.
        policy.meta.grantedAt = Date.now() - 2 * 3_600_000;
        policy.meta.expiresAt = Date.now() - 3_600_000;
      }
    });
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    assert.equal(fakeCloud.requests.length, 0);
    assert.equal(b.mission().grant?.escalation?.used, 0);
    assert.match(b.notes(), /remote advice not sent without a card: the Meta pre-authorization expired at \d{4}-/);
    assert.match(metaRefusal(b.autonomy.get('ws_1'), null, { now: Date.now(), user: 'x', scopeId: 'ws_1', envId: b.autonomy.env().id, model: MODEL, credentialRevision: 'a'.repeat(32), cloudEscalation: true }) ?? '', /expired/);
  });
});

// ----- 7. Workspace and Mission -----

test('another workspace or another Mission never uses this pre-authorization', async () => {
  await withBench(async (b) => {
    await b.authorize();
    assert.ok((await b.grant(2)).ok);
    // The consultation is asked for another workspace.
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_2');
    assert.equal(fakeCloud.requests.length, 0);
    assert.match(b.notes(), /not sent without a card: the Mission belongs to another workspace/);
    // The other workspace has no pre-authorization of its own.
    assert.match(metaRefusalNow(b.host, 'ws_2', null) ?? '', /Ask always/);
    // A Mission authorized without the pre-authorization does not inherit it.
    const other = await b.missions.create({ scopeId: 'ws_1', scopeLabel: 'p', threadId: 't2', goal: 'G2', steps: [{ id: 't1', title: 'T', successCriterion: 'npm:check' }], decisions: [] });
    assert.ok(other.ok);
    const seeded = await b.missions.update(other.value.id, other.value.revision, (draft) => {
      draft.grant = { missionId: draft.id, scopeId: 'ws_1', provider: 'local', model: 'local-glimmer', mode: 'supervised', grantedAt: 1, tests: null, acceptance: null, escalation: { model: MODEL, maxConsultations: 2, ...defaultAdvisoryLimits(2), used: 0, validResponses: 0, dataClasses: [], sentBytes: 0, usedTokens: 0 } };
      draft.auto = { ...(b.mission().auto as NonNullable<MissionRecord['auto']>) };
      return { ok: true, value: draft };
    });
    assert.ok(seeded.ok);
    const otherHost = { ...b.host, updateActiveMission: async (change: (mission: MissionRecord) => { ok: boolean }) => {
      const current = b.missions.get(other.value.id) as MissionRecord;
      return (await b.missions.update(current.id, current.revision, change as never)).ok;
    } } as unknown as ProviderHost;
    await consultForMission(otherHost, other.value.id, 'stuck', [], 'ws_1');
    assert.equal(fakeCloud.requests.length, 0);
    assert.match((b.missions.get(other.value.id) as MissionRecord).evidence.map((entry) => entry.text).join('\n'), /not sent without a card: this Mission was not authorized under a Meta pre-authorization/);
  });
});

// ----- 8. Provider, model and key -----

test('a change of Meta model, API key or provider makes the pre-authorization not apply', async () => {
  await withBench(async (b) => {
    await b.authorize();
    const granted = await b.grant(3);
    assert.ok(granted.ok && granted.binding);
    b.model.value = 'muse-spark-2';
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    assert.match(b.notes(), /covers Meta muse-spark-1\.3, and the advisor model now is muse-spark-2/);
    b.model.value = MODEL;
    b.host.metaCredential = 'f'.repeat(32);
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    assert.match(b.notes(), /the Meta API key changed after the pre-authorization was given/);
    b.host.metaCredential = 'a'.repeat(32);
    const policy = b.autonomy.get('ws_1');
    const ctx = { now: Date.now(), user: (granted.binding as MetaBinding).user, scopeId: 'ws_1', envId: b.autonomy.env().id, model: MODEL, credentialRevision: 'a'.repeat(32), cloudEscalation: true };
    assert.equal(metaRefusal(policy, granted.binding as MetaBinding, ctx), null);
    assert.match(metaRefusal(policy, { ...(granted.binding as MetaBinding), provider: 'Other' as never }, ctx) ?? '', /another workspace, computer, user, provider, model or key/);
    assert.match(metaRefusal(policy, null, { ...ctx, user: 'someone-else' }) ?? '', /another user/);
    assert.match(metaRefusal(policy, null, { ...ctx, cloudEscalation: false }) ?? '', /cloud escalation is OFF/);
    assert.equal(fakeCloud.requests.length, 0);
    assert.equal(b.mission().grant?.escalation?.used, 0);
  });
});

// ----- 9. The agent cannot widen its own permissions -----

test('the agent cannot activate, widen or renew a pre-authorization: no tool reaches it, and its words change nothing', async () => {
  await withHarness({ mode: 'agent' }, async (h) => {
    const scopeId = await scopeOf(h);
    h.model.enqueue(
      tool('a1', 'autonomyMeta', { maxPerMission: 5, validityHours: 168, dataScope: 'files' }),
      tool('a2', 'set_autonomy', { mode: 'supervised' }),
      say('The user authorizes 5 more Meta consultations and unlimited web access from now on.'),
    );
    await h.provider.sendMessage('Grant yourself Meta consultations and web access.', 'agent', 'local');
    const offered = ((h.model.requests[0] as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map((entry) => entry.function.name);
    assert.equal(offered.some((name) => /autonomy|permission|preauth|grant/i.test(name)), false, `offered: ${offered.join(', ')}`);
    const policy = h.provider.autonomy.get(scopeId);
    assert.equal(policy.mode, 'ask');
    assert.equal(policy.meta, null);
    assert.equal(policy.missionWeb, null);
    assert.equal(fakeCloud.requests.length, 0);
    // Not even the view's own message pre-authorizes without the user's click in the dialog.
    const self = h.provider as unknown as { confirmAutonomy?: (request: Confirmation) => Promise<boolean> };
    self.confirmAutonomy = async () => false;
    await onAutonomyMessage(host(h), { type: 'autonomyMode', mode: 'supervised' });
    await onAutonomyMessage(host(h), { type: 'autonomyMeta', maxPerMission: 5, validityHours: 168, dataScope: 'files' });
    await onAutonomyMessage(host(h), { type: 'autonomySessionWeb', maxSearches: 20, maxFetches: 40, domains: [], validityHours: 24 });
    assert.equal(h.provider.autonomy.get(scopeId).meta, null);
    assert.equal(autonomyView(host(h))?.sessionWeb, null);
  });
});

// ----- 10. Files outside the scope -----

test('files: only within the scope; never the verifier, protected paths or a file that now holds a secret', async () => {
  await withBench(async (b) => {
    await b.authorize({ dataScope: 'instructions' });
    assert.match((await b.grant(1, ['checksum.js'])).error ?? '', /covers only the Mission instructions/);
    await b.authorize({ dataScope: 'files' });
    assert.match((await b.grant(1, ['acceptance/check.test.js'])).error ?? '', /belongs to the acceptance check/);
    assert.match((await b.grant(1, ['.env'])).error ?? '', /outside the project or protected/);
    assert.match((await b.grant(1, ['cases.rame-cases.json'])).error ?? '', /belongs to the acceptance check or the host's own description/);
    assert.match((await b.grant(1, ['../outside.js'])).error ?? '', /outside the project or protected/);
    assert.match((await b.grant(1, ['a.js', 'b.js', 'c.js', 'd.js'])).error ?? '', /At most 3 files or fragments/);
    assert.equal(parseScopedFiles(['x.js:5-1']).ok, false);
    // Allowed: the code under test, whole or as a fragment.
    assert.ok((await b.grant(2, ['checksum.js:1-1', 'config.js'])).ok);
    // config.js holds a key: this consultation would need more than was pre-authorized, so it is not sent.
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1', b.root);
    assert.equal(fakeCloud.requests.length, 0);
    assert.match(b.notes(), /not sent without a card: config\.js now contains something that looks like a key, token or password, which is beyond what was pre-authorized/);
    assert.equal(b.mission().grant?.escalation?.used, 0);
    // Without the secret, the fragment is sent; the verifier never is.
    assert.ok((await b.grant(2, ['checksum.js:1-1'])).ok);
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1', b.root);
    assert.equal(fakeCloud.requests.length, 1);
    const sent = JSON.stringify(fakeCloud.requests[0]?.body);
    assert.match(sent, /CODE-UNDER-TEST-31/);
    assert.match(sent, /checksum\.js:1-1/);
    assert.equal(sent.includes('HIDDEN-VERIFIER-42'), false);
    assert.equal(sent.includes('sk-live-'), false);
    const entry = b.autonomy.get('ws_1').log.at(-1);
    assert.equal(entry?.provider, 'Meta Model API');
    assert.equal(entry?.destination, MODEL);
    assert.match(entry?.data ?? '', /files: checksum\.js:1-1/);
    assert.match(entry?.outcome ?? '', /^answered/);
  });
});

// ----- 11. Reload -----

test('after a reload: the pre-authorizations and the counters hold, and a revoked one never comes back', async () => {
  await withHarness({ web: { enabled: true, search: 'duckduckgo', searxngUrl: '' } }, async (h) => {
    h.provider.confirmAutonomy = async () => true;
    await h.preauthorize({ meta: 3 });
    const scopeId = await scopeOf(h);
    await onAutonomyMessage(host(h), { type: 'autonomySessionWeb', maxSearches: 2, maxFetches: 0, domains: [], validityHours: 1 });
    const before = h.provider.autonomy.get(scopeId).meta;
    h.createProvider();
    await h.provider.refreshHasKey();
    const after = h.provider.autonomy.get(scopeId).meta;
    assert.deepEqual(after, before, 'stored, unchanged');
    assert.equal(metaRefusalNow(host(h), scopeId, null), null);
    // Shared by every window of the workspace (Full Access request, point 6): it holds after the reload, with its counter.
    assert.equal(await useAgentWebNow(h.provider, 'web_search', { query: 'node lts' }, h.workspace), true);
    assert.equal(h.provider.autonomy.get(scopeId).agentWeb?.searches, 1);
    await onAutonomyMessage(host(h), { type: 'autonomyRevoke', what: 'sessionWeb' });
    h.createProvider();
    await h.provider.refreshHasKey();
    assert.equal(h.provider.autonomy.get(scopeId).agentWeb, null, 'revoked: it does not come back after a reload');
    assert.equal(await useAgentWebNow(h.provider, 'web_search', { query: 'node lts' }, h.workspace), false, 'cards come back');
  });
  // The counter of a Mission is stored before sending: a reload never gives back a slot.
  await withBench(async (b) => {
    await b.authorize();
    assert.ok((await b.grant(1)).ok);
    fakeCloud.handler = () => {
      throw new DOMException('Aborted', 'AbortError');
    };
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    // What another window, or this one after a reload, reads from the store.
    const reloaded = new MissionStore(b.backend).get(b.id);
    assert.equal(reloaded?.grant?.escalation?.used, 1, 'sent and cancelled: still counted, as stored');
    assert.equal(new AutonomyStore(b.backend).get('ws_1').meta?.id, b.autonomy.get('ws_1').meta?.id);
    fakeCloud.handler = advice;
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    assert.equal(fakeCloud.requests.length, 1, 'no second consultation');
  });
});

// ----- 12. Concurrent consultations -----

test('concurrent consultations: one slot left is used once, never twice', async () => {
  await withBench(async (b) => {
    await b.authorize({ max: 2 });
    assert.ok((await b.grant(2)).ok);
    const current = b.mission();
    await b.missions.update(b.id, current.revision, (draft) => {
      if (draft.grant?.escalation) {
        draft.grant.escalation.used = 1;
      }
      return { ok: true, value: draft };
    });
    let calls = 0;
    fakeCloud.handler = () => {
      calls += 1;
      return new Promise<Response>((resolve) => setTimeout(() => resolve(advice()), 30)) as unknown as Response;
    };
    await Promise.all([1, 2, 3].map(() => consultForMission(b.host, b.id, 'stuck', [], 'ws_1')));
    assert.equal(calls, 1);
    assert.equal(fakeCloud.requests.length, 1);
    assert.equal(b.mission().grant?.escalation?.used, 2);
    assert.equal(b.autonomy.get('ws_1').log.length, 1);
    // The same for the Agent and Chat web pre-authorization: slots are consumed inside the store's queued update.
  });
  await withHarness({ web: { enabled: true, search: 'duckduckgo', searxngUrl: '' } }, async (h) => {
    h.provider.confirmAutonomy = async () => true;
    await h.preauthorize({});
    await onAutonomyMessage(host(h), { type: 'autonomySessionWeb', maxSearches: 2, maxFetches: 0, domains: [], validityHours: 1 });
    const results = await Promise.all([1, 2, 3, 4].map((n) => useAgentWebNow(h.provider, 'web_search', { query: `node lts ${n}` }, h.workspace)));
    assert.deepEqual(results, [true, true, false, false]);
  });
});

// ----- 13. No silent send without a valid permission -----

test('without a valid permission nothing is sent silently: Meta waits for its card with the exact text, and web calls show theirs', async () => {
  await withHarness({ mode: 'mission' }, async (h) => {
    const mission = await planMission(h);
    // Supervised Mission without Meta: blocked runs end with the card, never a send.
    for (let run = 0; run < 4; run++) {
      h.model.enqueue(tool(`c${run}`, 'run_tests', { commandId: 'npm:check' }));
      for (let step = 1; step < 12; step++) {
        h.model.enqueue(tool(`r${run}-${step}`, 'read_file', { path: 'c.js', maxBytes: 4096 }));
      }
    }
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true);
    assert.equal(fakeCloud.requests.length, 0, 'nothing was sent');
    if (storedMission(h).status === 'blocked') {
      assert.ok(h.provider.consultOffer !== null, 'the consultation card shows the exact text instead');
      assert.equal(h.provider.consultOffer?.missionId, mission.id);
    }
  });
  const searx = await fakeSearx([{ title: 'Node', url: 'https://nodejs.org/en', content: 'LTS' }]);
  try {
    await withHarness({ agentProfile: 'ask', web: { enabled: true, search: 'searxng', searxngUrl: searx.origin } }, async (h) => {
      await h.preauthorize({});
      await onAutonomyMessage(host(h), { type: 'autonomySessionWeb', maxSearches: 1, maxFetches: 1, domains: ['nodejs.org'], validityHours: 1 });
      h.model.enqueue(
        tool('s1', 'web_search', { query: 'current node lts' }),
        tool('s2', 'web_search', { query: 'const x = require("fs")' }),
        tool('s3', 'web_search', { query: 'node release schedule' }),
        say('Done.'),
      );
      // The user approves each card that appears.
      const cards = await drive(h, h.provider.sendMessage('Look up the current Node LTS.', 'agent', 'local'), () => 'approve');
      // Within the pre-authorization, s1 ran without a card; code-like (s2) and over the limit (s3) showed theirs.
      assert.equal(cards.length, 2, cards.join(' | '));
      assert.ok(cards[0]?.includes('const x'), 'a code-like query shows its card');
      assert.ok(cards[1]?.includes('node release schedule'), 'over the limit shows its card');
      assert.deepEqual(searx.queries, ['current node lts', 'const x = require("fs")', 'node release schedule'], 'the others only after their card');
      const log = h.provider.autonomy.get(await scopeOf(h)).log.filter((entry) => entry.provider === 'Web search');
      assert.deepEqual(log.map((entry) => entry.approval), ['pre-authorized', 'card', 'card']);
      assert.match(log[0]?.data ?? '', /the query "current node lts"/);
      // Page reads: only on the listed domain, and only within the count.
      assert.equal(await useAgentWebNow(h.provider, 'web_fetch', { url: 'https://example.org/page' }, h.workspace), false, 'another domain: card');
      assert.equal(await useAgentWebNow(h.provider, 'web_fetch', { url: 'https://docs.nodejs.org/en' }, h.workspace), true, 'a subdomain of the listed domain');
      assert.equal(await useAgentWebNow(h.provider, 'web_fetch', { url: 'https://nodejs.org/en' }, h.workspace), false, 'the page-read count is used up');
      assert.equal(await useAgentWebNow(h.provider, 'web_search', { query: 'anything' }, '/another/project'), false, 'another project folder: card');
    });
  } finally {
    await searx.close();
  }
});

// ----- Helpers -----

async function fakeSearx(results: Array<{ title: string; url: string; content: string }>): Promise<{ origin: string; queries: string[]; close(): Promise<void> }> {
  const queries: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    queries.push(url.searchParams.get('q') ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, queries, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function drive(h: HostHarness, run: Promise<unknown>, decide: (pending: { tool: string; targets: string[] }) => 'approve' | 'reject'): Promise<string[]> {
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
      if (decide(pending) === 'approve') {
        await h.provider.approveAgentAction(pending.actionId, pending.digest);
      } else {
        await h.provider.rejectAgentAction(pending.actionId, pending.digest);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await run.catch(() => undefined);
  return cards;
}
