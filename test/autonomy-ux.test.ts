/**
 * The view of Autonomy & Permissions (media/autonomyUx.js), run in a small
 * fake DOM: what it shows from the host's state, and that every button only
 * sends a request the host parses (and confirms itself).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { parseAutonomyMessage } from '../src/autonomyView.js';
import { buildViewHtml } from '../src/viewHtml.js';

type Node = {
  id: string; tagName: string; hidden: boolean; disabled: boolean; checked: boolean; textContent: string; value: string; open?: boolean;
  options: Array<{ value: string; disabled: boolean }>; listeners: Record<string, Array<(event: unknown) => void>>; children: Node[];
};

function fakeDom() {
  const nodes: Record<string, Node> = {};
  const make = (id: string, tag = 'DIV'): Node => {
    const node: Node = { id, tagName: tag, hidden: false, disabled: false, checked: false, textContent: '', value: '', options: [], listeners: {}, children: [] };
    return Object.assign(node, {
      firstChild: null,
      classList: { contains: () => false, add() {}, remove() {} },
      attrs: {} as Record<string, string>,
      setAttribute(name: string, value: string) { (node as unknown as { attrs: Record<string, string> }).attrs[name] = String(value); },
      appendChild(child: Node) {
        node.children.push(child);
        // Like a real <select>: an appended <option> is one of its options.
        if (child.tagName === 'OPTION') node.options.push(child as unknown as { value: string; disabled: boolean });
      },
      removeChild() {},
      addEventListener(type: string, listener: (event: unknown) => void) { (node.listeners[type] ??= []).push(listener); },
    });
  };
  const docListeners: Array<(event: unknown) => void> = [];
  const document = {
    getElementById: (id: string) => (nodes[id] ??= make(id)),
    createElement: (tag: string) => make('', tag.toUpperCase()),
    addEventListener: (_type: string, listener: (event: unknown) => void) => docListeners.push(listener),
  };
  const click = (id: string) => {
    const target = document.getElementById(id);
    docListeners.forEach((listener) => listener({ target }));
    (target.listeners.click ?? []).forEach((listener) => listener({ target }));
  };
  const change = (id: string) => (document.getElementById(id).listeners.change ?? []).forEach((listener) => listener({ target: nodes[id] }));
  return { nodes, document, click, change };
}

function load() {
  const dom = fakeDom();
  const window: Record<string, unknown> = {};
  const context = { window, document: dom.document, setTimeout, clearTimeout, Date };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/localServersUx.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/autonomyUx.js', 'utf8'), context);
  const posted: Array<Record<string, unknown>> = [];
  const t = (text: string) => text;
  const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), text);
  const remote = window.RAME_REMOTE as { init(h: unknown): void; render(data: unknown): void };
  remote.init({ vscode: { postMessage: (message: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>) }, t, tf, tHost: t, markPending: () => true, hold() {} });
  return { ...dom, render: remote.render, posted };
}

const MISSION = 'mis_' + 'a'.repeat(24);
const VIEW = {
  project: 'shop', env: 'this computer (pc, user ana)', note: '', mode: 'supervised', model: 'muse-spark-1.3', metaUnavailable: '', inflight: 0,
  meta: { model: 'muse-spark-1.3', maxPerMission: 2, dataScope: 'files', grantedAt: 1, expiresAt: Date.now() + 3_600_000, tokenBudget: null, usedTokens: 0, problem: '' },
  missionWeb: null, sessionWeb: null, full: null as null | { tools: Record<string, boolean>; grantedAt: number; expiresAt: number; jobs: number; problem: string },
  missions: [{ missionId: MISSION, text: 'External access pre-authorized for this Mission: Meta muse-spark-1.3: 0 of 2 consultation(s) used.' }],
  log: [{ at: 1, provider: 'Meta Model API', destination: 'muse-spark-1.3', reason: 'Mission advice for npm:check', data: 'the Mission goal', approval: 'pre-authorized', outcome: 'answered', bytes: 900 }],
};
const state = (autonomy: unknown, missionId: string | null = MISSION) => ({ remote: { runtime: { local: 'connected', cloud: 'connected', selected: 'local' }, servers: null, autonomy }, missionLive: missionId ? { missionId } : null });

test('the markup: Autonomy & Permissions in Security, its part of the Mission card, and its script after the servers block, before main.js', () => {
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js', localServersUxUri: 'localServersUx.js', autonomyUxUri: 'autonomyUx.js' });
  const security = html.slice(html.indexOf('id="cardSecurity"'), html.indexOf('id="cardAdvanced"'));
  assert.match(security, /id="autonomySection"[^]*Autonomy &amp; Permissions[^]*id="autonomyAsk" value="ask"> Ask always \(default\)[^]*id="autonomySupervised" value="supervised"> Supervised autonomy[^]*id="autonomyMetaRow"[^]*id="autonomyWebRow"[^]*id="autonomyRevokeAll"[^]*id="autonomyLog"/);
  assert.equal(/autonomyAsk"[^>]*checked/.test(security) || /autonomySupervised"[^>]*checked/.test(security), false, 'no mode is pre-selected in the markup: the host decides');
  assert.match(html, /id="missionAutonomyRow"[^]*id="missionMetaFilesRow" hidden[^]*id="missionAutonomyOpen"[^]*id="missionStart"/);
  assert.ok(html.indexOf('src="localServersUx.js"') < html.indexOf('src="autonomyUx.js"') && html.indexOf('src="autonomyUx.js"') < html.indexOf('src="main.js"'));
  assert.equal(/innerHTML/.test(readFileSync('media/autonomyUx.js', 'utf8')), false, 'text only, never markup from the host');
});

test('Ask always: the grants are hidden and nothing is shown as pre-authorized', () => {
  const view = load();
  view.render(state({ ...VIEW, mode: 'ask', meta: null, missions: [], log: [] }));
  assert.equal(view.nodes.autonomyAsk?.checked, true);
  assert.equal(view.nodes.autonomySupervised?.checked, false);
  assert.equal(view.nodes.autonomyGrants?.hidden, true);
  assert.match(view.nodes.missionAutonomyNote?.textContent ?? '', /Meta without a card: not pre-authorized for this workspace/);
  assert.equal(view.nodes.missionAccessIndicator?.hidden, true);
});

test('supervised: what is pre-authorized, the history, the Mission indicator, and the card limited to the maximum', () => {
  const view = load();
  const select = view.document.getElementById('missionConsults');
  select.options = [0, 1, 2, 3, 4, 5].map((value) => ({ value: String(value), disabled: false }));
  select.value = '5';
  view.render(state(VIEW));
  assert.equal(view.nodes.autonomyGrants?.hidden, false);
  assert.match(view.nodes.autonomyMetaNow?.textContent ?? '', /^Pre-authorized: Meta muse-spark-1\.3, up to 2 per Mission, instructions and chosen files, until /);
  assert.equal(view.nodes.autonomyMetaRevoke?.disabled, false);
  // 0–2 allowed; 3–5, and the larger choices the view adds (10, 100, 1000, no count limit), are not.
  assert.deepEqual(select.options.map((option) => option.disabled), [false, false, false, true, true, true, true, true, true, true]);
  assert.equal(select.value, '0', 'over the maximum falls back to none');
  assert.equal(view.nodes.missionMetaFilesRow?.hidden, false, 'files can be chosen: the pre-authorization includes them');
  assert.equal(view.nodes.missionAccessIndicator?.hidden, false);
  assert.match(view.nodes.missionAccessIndicator?.textContent ?? '', /External access pre-authorized for this Mission/);
  const log = view.nodes.autonomyLog?.children ?? [];
  assert.equal(log.length, 1);
  assert.match(log[0]?.textContent ?? '', /Meta Model API → muse-spark-1\.3 · pre-authorized · Mission advice for npm:check · the Mission goal \(900 B\) · answered/);
  // A pre-authorization that no longer applies says why.
  view.render(state({ ...VIEW, meta: { ...VIEW.meta, problem: 'the Meta API key changed after the pre-authorization was given' } }));
  assert.match(view.nodes.autonomyMetaNow?.textContent ?? '', /Not in force: the Meta API key changed/);
  assert.equal(view.nodes.missionMetaFilesRow?.hidden, true);
});

test('every button only asks, with a message the host parses; the Mission\'s files travel before the authorization', () => {
  const view = load();
  view.render(state(VIEW));
  view.posted.length = 0;
  view.document.getElementById('autonomySupervised').checked = true;
  view.change('autonomySupervised');
  view.document.getElementById('autonomyMetaMax').value = '3';
  view.document.getElementById('autonomyMetaHours').value = '24';
  view.document.getElementById('autonomyMetaScope').value = 'files';
  view.click('autonomyMetaGrant');
  view.document.getElementById('autonomyWebSearches').value = '4';
  view.document.getElementById('autonomyWebFetches').value = '2';
  view.document.getElementById('autonomyWebDomains').value = 'nodejs.org, docs.python.org';
  view.document.getElementById('autonomyWebHours').value = '1';
  view.click('autonomyWebGrant');
  view.document.getElementById('autonomyMissionWebHours').value = '8';
  view.click('autonomyMissionWebGrant');
  view.click('autonomyMetaRevoke');
  view.click('autonomyRevokeAll');
  view.document.getElementById('missionMetaFiles').value = 'src/checksum.js, src/util.js:1-80';
  view.click('missionStart');
  // (The servers block sends its own missionWebSet on the same click.)
  const mine = view.posted.filter((message) => message.type !== 'missionWebSet');
  assert.deepEqual(mine.map((message) => message.type), ['autonomyMode', 'autonomyMeta', 'autonomySessionWeb', 'autonomyMissionWeb', 'autonomyRevoke', 'autonomyRevoke', 'missionMetaScopeSet']);
  for (const message of mine) {
    assert.ok(parseAutonomyMessage(message), `${String(message.type)} parses`);
  }
  assert.deepEqual(mine[1], { type: 'autonomyMeta', maxPerMission: 3, validityHours: 24, dataScope: 'files', tokenBudget: 0 });
  assert.deepEqual(mine[2], { type: 'autonomySessionWeb', maxSearches: 4, maxFetches: 2, domains: ['nodejs.org', 'docs.python.org'], validityHours: 1 });
  assert.deepEqual(mine[6], { type: 'missionMetaScopeSet', missionId: MISSION, files: ['src/checksum.js', 'src/util.js:1-80'] });
});

test('Full Access in the view: the radio only shows its parts, turning it on sends exactly what was chosen, and the card offers 10, 100, 1000 and no count limit', () => {
  const view = load();
  const select = view.document.getElementById('missionConsults');
  select.options = [0, 1, 2, 3, 4, 5].map((value) => ({ value: String(value), disabled: false }));
  select.value = '0';
  view.render(state({ ...VIEW, meta: { ...VIEW.meta, maxPerMission: null, tokenBudget: 100000, usedTokens: 50 } }));
  assert.match(view.nodes.autonomyEnv?.textContent ?? '', /^Operations run on this computer \(pc, user ana\)\. Permissions given here apply only there/);
  assert.equal(view.nodes.autonomyFullRow?.hidden, true, 'hidden until Full Access is chosen');
  assert.match(view.nodes.autonomyMetaNow?.textContent ?? '', /^Pre-authorized: Meta muse-spark-1\.3, no count limit per Mission, instructions and chosen files, until .* Tokens: 50 of 100000 used\.$/);
  // The Mission card: the larger choices are added once, and all are allowed under no count limit.
  assert.deepEqual(select.options.map((option) => option.value), ['0', '1', '2', '3', '4', '5', '10', '100', '1000', '-1']);
  assert.equal(select.options.some((option) => option.disabled), false);
  view.render(state(VIEW));
  assert.equal(select.options.length, 10, 'not added twice');
  assert.deepEqual(select.options.map((option) => option.disabled), [false, false, false, true, true, true, true, true, true, true], 'up to the pre-authorized 2; no count limit is not offered');
  select.value = '-1';
  view.render(state({ ...VIEW, meta: { ...VIEW.meta, maxPerMission: null } }));
  view.document.getElementById('missionConsultSummary');
  view.change('missionConsults');
  assert.match(view.nodes.missionConsultSummary?.textContent ?? '', /^Selected: no count limit on Meta consultations/);
  // Choosing the radio only shows the panel: no message, nothing turned on.
  view.posted.length = 0;
  view.document.getElementById('autonomyFullMode').checked = true;
  view.change('autonomyFullMode');
  assert.equal(view.posted.length, 0);
  assert.equal(view.nodes.autonomyFullRow?.hidden, false);
  // Nothing chosen: nothing sent.
  for (const id of ['autonomyFullFiles', 'autonomyFullTests', 'autonomyFullCommands', 'autonomyFullInstalls', 'autonomyFullJobs', 'autonomyFullWeb', 'autonomyFullMeta']) {
    view.document.getElementById(id).checked = false;
  }
  view.click('autonomyFullGrant');
  assert.equal(view.posted.length, 0);
  assert.equal(view.nodes.autonomyFullNow?.textContent, 'Choose at least one part for Full Access.');
  view.document.getElementById('autonomyFullFiles').checked = true;
  view.document.getElementById('autonomyFullCommands').checked = true;
  view.document.getElementById('autonomyFullHours').value = '720';
  view.click('autonomyFullGrant');
  view.document.getElementById('autonomyMetaMax').value = '-1';
  view.document.getElementById('autonomyMetaBudget').value = '1000000';
  view.click('autonomyMetaGrant');
  assert.deepEqual(view.posted[0], { type: 'autonomyFull', tools: { files: true, tests: false, commands: true, installs: false, jobs: false, web: false, meta: false }, validityHours: 720 });
  assert.deepEqual(view.posted[1], { type: 'autonomyMeta', maxPerMission: -1, validityHours: 8, dataScope: 'instructions', tokenBudget: 1000000 });
  assert.deepEqual(parseAutonomyMessage(view.posted[1] as Record<string, unknown>), { type: 'autonomyMeta', maxPerMission: null, validityHours: 8, dataScope: 'instructions', tokenBudget: 1000000 });
  assert.ok(parseAutonomyMessage(view.posted[0] as Record<string, unknown>));
  // On: what it covers, its jobs, and the way back.
  view.render(state({ ...VIEW, mode: 'full', full: { tools: { files: true, tests: false, commands: true, installs: false, jobs: true, web: false, meta: false }, grantedAt: 1, expiresAt: Date.now() + 3_600_000, jobs: 2, problem: '' } }));
  assert.equal(view.nodes.autonomyFullMode?.checked, true);
  assert.equal(view.nodes.autonomyGrants?.hidden, false, 'Meta and web pre-authorizations stay available under Full Access');
  assert.match(view.nodes.autonomyFullNow?.textContent ?? '', /^On until .*: workspace files, terminal commands, long jobs run without their cards\. 2 long job\(s\) started under it are stopped if you revoke it\.$/);
  assert.match(view.nodes.missionAutonomyNote?.textContent ?? '', /Full Access is on: the Mission's file operations and tests run without cards; this authorization card and project memory still ask\./);
  view.posted.length = 0;
  view.click('autonomyFullRevoke');
  assert.deepEqual(view.posted, [{ type: 'autonomyRevoke', what: 'full' }]);
  assert.ok(parseAutonomyMessage(view.posted[0] as Record<string, unknown>));
});

test('the chat permission menu: Full Access is the level above Workspace full, asks for its confirmation, a lower level turns it off, and its expiry is shown', async () => {
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js', localServersUxUri: 'localServersUx.js', autonomyUxUri: 'autonomyUx.js' });
  assert.match(html, /id="autonomyFullWeb"[^]*id="autonomyFullMeta"> Meta: when the main model cannot finish, consult Meta without cards[^]*id="autonomyFullMetaMax"[^]*id="autonomyFullMetaBudget"[^]*id="autonomyFullMetaScope"/);
  assert.match(html, /id="acceptanceReviewConsultations"[^]*<option value="5">5<\/option><option value="10">10<\/option><option value="100">100<\/option><option value="1000">1000<\/option><option value="-1">No count limit<\/option>/);
  assert.match(html, /id="permAsk"[^]*id="permSafe"[^]*id="permFull"/, 'the three profiles come first; Full Access is added after them');
  const view = load();
  // The panel's defaults, as in the markup: workspace files and tests, until the user turns it off.
  view.nodes.autonomyFullFiles = Object.assign(view.document.getElementById('autonomyFullFiles'), { checked: true });
  view.nodes.autonomyFullTests = Object.assign(view.document.getElementById('autonomyFullTests'), { checked: true });
  view.document.getElementById('autonomyFullHours').value = '0';
  view.render(state({ ...VIEW, full: null }));
  const btn = view.document.getElementById('permissionBtn') as Node & { title?: string };
  const menu = view.document.getElementById('permissionMenu');
  const attrs = (node: Node | undefined) => (node as unknown as { attrs: Record<string, string> } | undefined)?.attrs ?? {};
  const chip = () => btn.children.filter((child) => child.id === 'autonomyFullChip');
  const item = (id: string) => menu.children.filter((child) => child.id === id);
  const press = (id: string) => (item(id)[0]?.listeners.click ?? []).forEach((listener) => listener({}));
  const level = () => item('permFullAccess')[0];
  assert.equal(chip()[0]?.hidden, true, 'no chip while Full Access is off');
  assert.equal(attrs(level()).role, 'menuitemradio', 'a level of the selector, not a link');
  assert.equal(attrs(level())['aria-checked'], 'false');
  assert.equal(level()?.textContent, 'Full Access — no cards for the parts you choose; asks for confirmation.');
  assert.equal(item('permFullAccessParts')[0]?.textContent, 'Full Access parts and duration…');
  assert.equal(item('permFullAccessOff').length, 0, 'a lower level turns it off: no separate item');
  // Choosing the level sends exactly the panel's grant; the host confirms it. Nothing is in force yet.
  view.posted.length = 0;
  press('permFullAccess');
  assert.deepEqual(view.posted, [{ type: 'autonomyFull', tools: { files: true, tests: true, commands: false, installs: false, jobs: false, web: false, meta: false }, validityHours: 0 }]);
  assert.ok(parseAutonomyMessage(view.posted[0] as Record<string, unknown>));
  assert.equal(menu.hidden, true, 'the menu closes');
  assert.equal(chip()[0]?.hidden, true, 'not shown as in force before the confirmation');
  // Cancelled confirmation: the host keeps the state; a lower level then sends no revocation.
  view.render(state({ ...VIEW, full: null }));
  view.posted.length = 0;
  view.click('permSafe');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(view.posted, [], 'nothing to turn off');
  // Without a project folder the level leads to its panel instead of sending a grant.
  view.render(state({ ...VIEW, project: null, full: null }));
  view.posted.length = 0;
  press('permFullAccess');
  assert.deepEqual(view.posted, [{ type: 'autonomyRefresh' }], 'only Settings is opened, where the folder is asked for');
  // In force: the level is checked, the button names Full Access alone, the profiles are un-marked.
  const tools = { files: true, tests: true, commands: false, installs: false, jobs: false, web: false, meta: false };
  const inForce = { tools, grantedAt: 1, expiresAt: Date.now() + 3_600_000, jobs: 0, problem: '' };
  // With no expiry the menu says so instead of a date.
  view.render(state({ ...VIEW, mode: 'full', full: { ...inForce, expiresAt: 8_640_000_000_000_000 } }));
  assert.equal(item('permFullAccess')[0]?.textContent, 'Full Access — on until you turn it off; choose a lower level to turn it off.');
  (view.document.getElementById('permFull') as unknown as { setAttribute(name: string, value: string): void }).setAttribute('aria-checked', 'true');
  view.render(state({ ...VIEW, mode: 'full', full: inForce }));
  view.render(state({ ...VIEW, mode: 'full', full: inForce }));
  await Promise.resolve();
  assert.equal(chip().length, 1, 'created once');
  assert.equal(item('permFullAccess').length, 1);
  assert.equal(chip()[0]?.hidden, false);
  assert.equal(chip()[0]?.textContent, 'Full Access');
  assert.equal(view.nodes.permissionChip?.hidden, true, 'the profile underneath is not named while Full Access is the level');
  assert.equal(attrs(level())['aria-checked'], 'true');
  assert.equal(attrs(view.nodes.permFull)['aria-checked'], 'false', 'Workspace full is not marked as the level in force');
  assert.match(String(btn.title), /^Agent permission · Full Access is on until .*: workspace files, tests run without their cards\. Choose a lower level to turn it off\.$/);
  assert.match(String(level()?.textContent), /^Full Access — on until .*; choose a lower level to turn it off\.$/);
  view.posted.length = 0;
  press('permFullAccess');
  assert.deepEqual(view.posted, [], 'choosing the level in force changes nothing');
  // A lower level (here Workspace full itself) turns it off, after main.js has sent the profile.
  view.click('permFull');
  assert.deepEqual(view.posted, [], 'sent after the profile');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(view.posted, [{ type: 'autonomyRevoke', what: 'full' }]);
  assert.ok(parseAutonomyMessage(view.posted[0] as Record<string, unknown>));
  // The Settings profile list does the same.
  view.render(state({ ...VIEW, mode: 'full', full: inForce }));
  view.posted.length = 0;
  view.change('profileSelect');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(view.posted, [{ type: 'autonomyRevoke', what: 'full' }]);
  // Expired: a notice next to the profile shown again, until the menu is opened.
  const expired = { tools, grantedAt: 1, expiresAt: 2, jobs: 0, problem: 'the Full Access expired at 1970-01-01T00:00:00.002Z' };
  view.render(state({ ...VIEW, mode: 'full', full: expired }));
  assert.equal(chip()[0]?.hidden, false);
  assert.equal(chip()[0]?.textContent, 'Full Access expired');
  assert.equal(view.nodes.permissionChip?.hidden, false, 'the profile is named again');
  assert.equal(String(btn.title), 'Agent permission · Full Access expired: the permission is back to Ask.', 'the profile it had before');
  view.render({ ...state({ ...VIEW, mode: 'full', full: expired }), agentProfile: 'safe-auto' });
  assert.equal(String(btn.title), 'Agent permission · Full Access expired: the permission is back to Safe auto.');
  view.click('permissionBtn');
  assert.equal(chip()[0]?.hidden, true, 'acknowledged');
  view.render(state({ ...VIEW, mode: 'full', full: expired }));
  assert.equal(chip()[0]?.hidden, true, 'stays acknowledged');
  // Not in force for another reason (another computer): no notice.
  view.render(state({ ...VIEW, mode: 'full', full: { ...expired, expiresAt: 3, problem: 'the Full Access was given on another computer or server (pc)' } }));
  assert.equal(chip()[0]?.hidden, true);
  assert.equal(String(btn.title), 'Agent permission');
});
