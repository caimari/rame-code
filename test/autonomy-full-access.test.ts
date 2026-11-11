/**
 * Full Access and the wider Autonomy & Permissions: three modes apart from
 * the tool profile, Full Access over cards within what it covers (and only
 * that), Meta without a fixed limit of five, permissions bound to the
 * computer or Remote SSH server they were given on, revocation from any
 * window, restarts, and a store the model cannot write itself into.
 *
 * Everything is simulated: Meta is the harness's fakeCloud, the search
 * engine is a local fake, commands are harmless `node -e` lines, and no
 * install runs (only the decision to let one through is checked).
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import test from 'node:test';

import { fakeCloud, HostHarness } from './helpers/hostHarness.js';
import { advice, API_KEY_SECRET, bench, KEY, MODEL, say, tool, withBench } from './helpers/autonomyBench.js';
import { extraToolAuto } from '../src/agentExtraTools.js';
import { onAutonomyMessage } from '../src/autonomyEntry.js';
import { computeExecEnv, type EnvProbe } from '../src/autonomyEnv.js';
import { autonomyView, checkRevocations, fullAccessNow, handleAutonomyMessage, missionWebRefusalNow, rememberFullJob, useAgentWebNow } from '../src/autonomyHost.js';
import { AUTONOMY_STATE_KEY, commandNeedsCard, fullConfirmation, metaRefusal, UNTIL_TURNED_OFF, type FullTools, type WorkspaceAutonomy } from '../src/autonomyPolicy.js';
import { AutonomyStore, type AutonomyRuntime } from '../src/autonomyStore.js';
import { parseAutonomyMessage, type AutonomyMessage } from '../src/autonomyView.js';
import { memoryScopeForUi } from '../src/memoryController.js';
import { consultForMission } from '../src/missionAdvice.js';
import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import type { ProviderHost } from '../src/providerTypes.js';
import { buildViewHtml } from '../src/viewHtml.js';
import { parseViewInboundMessage } from '../src/viewMessages.js';

const NONE: FullTools = { files: false, tests: false, commands: false, installs: false, jobs: false, web: false, meta: false };
const FILES_TESTS: FullTools = { ...NONE, files: true, tests: true };
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const host = (h: HostHarness) => h.provider as unknown as ProviderHost;
type Request = { messages?: Array<{ tool_call_id?: string; content: string | null }>; tools?: Array<{ function: { name: string } }> };
const result = (h: HostHarness, id: string) => String((h.model.requests as Request[]).flatMap((r) => r.messages ?? []).find((m) => m.tool_call_id === id)?.content ?? '');
const storedMission = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;

async function scopeOf(h: HostHarness): Promise<string> {
  const scope = await memoryScopeForUi(host(h));
  assert.ok(scope.ok);
  return scope.scopeId;
}

async function withHarness(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>, options: { sharedStateDir?: string } = {}): Promise<void> {
  const h = new HostHarness(options);
  await h.start({ agentProfile: 'ask', allowCloudEscalation: true, ...settings });
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

/** The user turns Full Access on in Settings and accepts its confirmation; returns what the dialog said. */
async function turnOnFull(h: HostHarness, tools: FullTools, accept = true): Promise<{ message: string; detail: string }> {
  let shown = { message: '', detail: '' };
  h.provider.confirmAutonomy = async (request) => {
    shown = request;
    return accept;
  };
  await onAutonomyMessage(host(h), { type: 'autonomyFull', tools, validityHours: 8 });
  return shown;
}

/** Approve or reject each card that appears; returns the cards, in order. */
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

async function fakeSearx(results: Array<{ title: string; url: string; content: string }>): Promise<{ origin: string; queries: string[]; close(): Promise<void> }> {
  const queries: string[] = [];
  const server = http.createServer((req, res) => {
    queries.push(new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, queries, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const until = async (check: () => boolean, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
};

// ----- Environments: this computer and two Remote SSH servers -----

const SEAL = randomBytes(32);
function probe(kind: string | undefined, hostname: string, user: string, machine: string, hostKey: string | null): EnvProbe {
  return {
    remoteName: kind,
    hostname: () => hostname,
    user: () => user,
    readFile: (file) => (file === '/etc/machine-id' ? machine : file.endsWith('ssh_host_ed25519_key.pub') && hostKey !== null ? `ssh-ed25519 ${hostKey} root@${hostname}` : null),
    installId: () => 'f'.repeat(32),
  };
}
const runtimeOf = (env: EnvProbe, key: Buffer = SEAL): AutonomyRuntime => ({ env: () => computeExecEnv(env), key: () => key });
const memoryBackend = () => {
  const memory = new Map<string, unknown>();
  return { memory, get: (key: string) => memory.get(key), update: async (key: string, value: unknown) => void memory.set(key, JSON.parse(JSON.stringify(value))) };
};

/** A minimal host of one window: Settings messages and the checks, on its own store. */
function windowHost(store: AutonomyStore, extra: Record<string, unknown> = {}): ProviderHost & { confirmAutonomy: () => Promise<boolean> } {
  return {
    autonomy: store, status: '', disposed: false, running: false, missionAuto: null, hasKey: false, metaCredential: '',
    settings: { allowCloudEscalation: false, web: { enabled: true }, shell: { enabled: true }, installs: { enabled: true, auto: false }, jobs: { enabled: true } },
    selectedCloudModel: () => '', postState: async () => undefined, missions: { list: () => [] }, confirmAutonomy: async () => true, cancelRequest: () => false,
    ...extra,
  } as unknown as ProviderHost & { confirmAutonomy: () => Promise<boolean> };
}
const ws1 = async () => ({ ok: true as const, scopeId: 'ws_1', root: '/srv/project', label: 'project' });
const send = (target: ProviderHost, message: AutonomyMessage) => handleAutonomyMessage(target, message, ws1);

// ----- 1. Three modes, apart from the tool profile -----

test('three modes, separate from the tool profile: Workspace full never turns Full Access on, and Full Access needs its own confirmation', async () => {
  await withHarness({}, async (h) => {
    const scopeId = await scopeOf(h);
    assert.equal(h.provider.autonomy.get(scopeId).mode, 'ask', 'Ask always by default');
    // Choosing the Workspace full profile changes the profile only.
    await h.provider.setAgentProfile('workspace-full');
    assert.equal(h.provider.settings.agentProfile, 'workspace-full');
    assert.equal(h.provider.autonomy.get(scopeId).mode, 'ask');
    assert.equal(h.provider.autonomy.get(scopeId).full, null);
    assert.deepEqual(await fullAccessNow(host(h), 'run_command', { command: 'npm test' }, h.workspace), { ok: false, why: 'Full Access is not on for this workspace' });
    // The view cannot set the mode to full: only the Full Access request, with its confirmation, does.
    assert.throws(() => parseAutonomyMessage({ type: 'autonomyMode', mode: 'full' }));
    assert.throws(() => parseAutonomyMessage({ type: 'autonomyFull', tools: NONE, validityHours: 8 }), 'at least one part');
    assert.throws(() => parseAutonomyMessage({ type: 'autonomyFull', tools: { ...FILES_TESTS, everything: true }, validityHours: 8 }));
    assert.throws(() => parseAutonomyMessage({ type: 'autonomyFull', tools: FILES_TESTS, validityHours: 8, confirmed: true }));
    // Refused in the dialog: nothing changes.
    await turnOnFull(h, FILES_TESTS, false);
    assert.equal(h.provider.autonomy.get(scopeId).mode, 'ask');
    assert.match(String(h.last().status), /Full Access was not turned on: the confirmation was not accepted/);
    // Accepted: Full Access, and the profile is still the user's own choice.
    const shown = await turnOnFull(h, FILES_TESTS);
    const policy = h.provider.autonomy.get(scopeId);
    assert.equal(policy.mode, 'full');
    assert.deepEqual(policy.full?.tools, FILES_TESTS);
    assert.equal(h.provider.settings.agentProfile, 'workspace-full', 'Full Access does not touch the profile');
    assert.match(shown.message, /^Turn on Full Access for ws on this computer \(/);
    // Back to supervised: Full Access is revoked; Ask always revokes everything.
    await onAutonomyMessage(host(h), { type: 'autonomyMode', mode: 'supervised' });
    assert.equal(h.provider.autonomy.get(scopeId).mode, 'supervised');
    assert.equal(h.provider.autonomy.get(scopeId).full, null);
    await turnOnFull(h, FILES_TESTS);
    await onAutonomyMessage(host(h), { type: 'autonomyMode', mode: 'ask' });
    assert.deepEqual({ ...h.provider.autonomy.get(scopeId), log: [] }, { mode: 'ask', meta: null, missionWeb: null, agentWeb: null, full: null, log: [] });
  });
});

test('Full Access as the top level of the selector never widens the profile underneath: refused, nothing changes; accepted, only its parts; a lower level revokes it', async () => {
  await withHarness({}, async (h) => {
    const scopeId = await scopeOf(h);
    assert.equal(h.provider.settings.agentProfile, 'ask');
    // Chosen in the selector, refused in its confirmation: no grant and the same level.
    await turnOnFull(h, FILES_TESTS, false);
    assert.equal(h.provider.autonomy.get(scopeId).full, null);
    assert.equal(h.provider.settings.agentProfile, 'ask', 'back to the previous level');
    // Accepted: Full Access in force for its parts only; the profile underneath is not raised,
    // so a Full Access with the web part alone never lets Agent edit files without a card.
    await turnOnFull(h, { ...NONE, web: true });
    assert.equal(h.provider.autonomy.get(scopeId).mode, 'full');
    assert.equal(h.provider.settings.agentProfile, 'ask', 'never raised to Workspace full by Full Access');
    // A lower level chosen while it is in force: the view sends the revocation, which the host states.
    await h.provider.setAgentProfile('safe-auto');
    await onAutonomyMessage(host(h), { type: 'autonomyRevoke', what: 'full' });
    assert.equal(h.provider.autonomy.get(scopeId).full, null);
    assert.equal(h.provider.settings.agentProfile, 'safe-auto');
    assert.match(String(h.last().status), /^Full Access was revoked in every window of this workspace/);
  });
});

test('Full Access until the user turns it off: the default, no expiry, said in the confirmation and the status; other pre-authorizations keep their hours', async () => {
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n' });
  assert.match(html, /<select id="autonomyFullHours"><option value="0" selected>Until you turn it off<\/option><option value="1">1 hour<\/option><option value="8">8 hours<\/option>/, 'the default, then the timed choices, none of them selected');
  assert.match(html, /<select id="autonomyMetaHours"><option value="1">1 hour<\/option><option value="8" selected>8 hours/, 'the Meta pre-authorization keeps its hours');
  assert.deepEqual(parseAutonomyMessage({ type: 'autonomyFull', tools: FILES_TESTS, validityHours: 0 }), { type: 'autonomyFull', tools: FILES_TESTS, validityHours: 0 });
  assert.throws(() => parseAutonomyMessage({ type: 'autonomyMeta', maxPerMission: 1, validityHours: 0, dataScope: 'instructions' }), 'only Full Access may last until it is turned off');
  assert.throws(() => parseAutonomyMessage({ type: 'autonomyFull', tools: FILES_TESTS, validityHours: -1 }));
  await withHarness({}, async (h) => {
    const scopeId = await scopeOf(h);
    let shown = { message: '', detail: '' };
    h.provider.confirmAutonomy = async (request) => {
      shown = request;
      return true;
    };
    await onAutonomyMessage(host(h), { type: 'autonomyFull', tools: FILES_TESTS, validityHours: 0 });
    assert.match(shown.detail, /• Valid until you turn it off: choose a lower level in the chat's permission selector, or turn it off in Autonomy & Permissions\. It does not expire by itself\./);
    const full = h.provider.autonomy.get(scopeId).full;
    assert.equal(full?.expiresAt, UNTIL_TURNED_OFF);
    assert.match(String(h.last().status), /^Full Access is on for ws on this computer \(.*\) until you turn it off: /);
    assert.equal(autonomyView(host(h))?.full?.problem, '', 'in force');
    // Stored and read back (sealed, bound to this environment): still in force, still no expiry.
    assert.equal(h.provider.autonomy.get(scopeId).full?.expiresAt, UNTIL_TURNED_OFF);
    // Turned off by the user: gone.
    await onAutonomyMessage(host(h), { type: 'autonomyRevoke', what: 'full' });
    assert.equal(h.provider.autonomy.get(scopeId).full, null);
  });
});

test('the Full Access confirmation states every point: tools, files and commands, installs and downloads, Internet, Meta and its data, costs, where it runs, how to revoke', () => {
  // Every part but Meta: Meta needs its own pre-authorization first (its own test below).
  const all: FullTools = { files: true, tests: true, commands: true, installs: true, jobs: true, web: true, meta: false };
  const text = fullConfirmation({
    project: 'shop', env: 'the Remote SSH server build-1 (user ana)', tools: all, validityMs: 8 * 3_600_000, now: Date.now(),
    enabled: { commands: false, installs: true, jobs: true, web: true }, meta: 'Meta muse-spark-1.3, no count limit consultation(s) per Mission, instructions only, until x',
  });
  assert.equal(text.message, 'Turn on Full Access for shop on the Remote SSH server build-1 (user ana)?');
  for (const point of [
    /Where: every operation runs on the Remote SSH server build-1 \(user ana\), in the folder of shop\. Another computer, Remote SSH server, user or workspace does not inherit it\./,
    /Files: Agent and Mission runs read, create, change, move and delete files of this workspace without a card\. Protected files \(\.git, \.env, keys, credentials\)/,
    /Tests: the allowlisted test scripts of package\.json run without a card/,
    // Since the isolation levels (08-11): the confirmation states the level instead of "there is no sandbox".
    /Terminal commands: run without a card, in the project folder, with your user permissions[^]*the tool itself is OFF in Settings now; Full Access does not turn it on[^]*Their isolation level is Project \(Linux\): writes only in the project, temporary and package-cache folders, network allowed; where it cannot be applied a command does not run\. A command that elevates privileges \(sudo, su, doas, pkexec, runas\)/,
    /Meta as the main model: not included\. An Agent run with Meta as the main model keeps the card that asks what may be sent to Meta\./,
    /Installs: packages that need no administrator rights \(npm without scripts, pip for your user, container images\) are downloaded from their registry and installed without a card[^]*administrator rights \(apt, an elevated installer\) still show their card/,
    /Long jobs: start without a card; they are stopped when you revoke Full Access/,
    /Internet: web searches and page reads \(read-only\) run without a card[^]*A query may carry code, an error message or a file path; keys, tokens and passwords are removed from it, and your home and project folders hidden, before it leaves\. A page whose address carries a key or a local path is not requested, and local or private addresses are refused\. Publishing or changing anything online is not part of it\./,
    /Meta: not included outside Missions \(Agent's advice and the acceptance review keep their cards\)\. Missions keep their own pre-authorization: Meta muse-spark-1\.3, no count limit/,
    /Costs: Full Access itself costs nothing\. Meta consultations use your API key and may be billed; RAME has no Meta price list, so the limit is the pre-authorization's tokens\. Commands and installs may download content or use paid services/,
    /Never bypassed: your operating system's permissions, your providers' permissions, project memory \(always a card\), the Mission authorization card, the verifier's hidden files and the acceptance check/,
    /Valid for 8 hour\(s\), until /,
    /revoke it at any time in Settings → Security → Autonomy & Permissions, from any window[^]*Revoking stops the running Agent or Mission that used it, and the long jobs it started/,
  ]) {
    assert.match(text.detail, point);
  }
  // With its Meta part: what is sent, within which pre-authorization, and what never is.
  const withMeta = fullConfirmation({ project: 'shop', env: 'this computer (pc, user ana)', tools: { ...FILES_TESTS, meta: true }, validityMs: 3_600_000, now: Date.now(), enabled: { commands: true, installs: true, jobs: true, web: true }, meta: 'Meta muse-spark-1.3, at most 5 consultation(s) per Mission, instructions only, until x' });
  assert.match(withMeta.detail, /Meta: when the main model cannot finish, RAME consults Meta Model API without a card: Agent's advice after the main model stops, a blocked Mission's consultation \(the Mission is then retried with the advice, at most 3 times\) and a Mission's acceptance review[^]*All within: Meta muse-spark-1\.3, at most 5[^]*given and revoked with Full Access[^]*never a file[^]*only if the data scope includes files\. Secrets are removed and local paths hidden first\. A failed consultation is not retried by itself\. Delegating a run to Spark \(Meta running the tools\) is not part of it\./);
  const none = fullConfirmation({ project: 'shop', env: 'this computer (pc, user ana)', tools: FILES_TESTS, validityMs: 3_600_000, now: Date.now(), enabled: { commands: true, installs: true, jobs: true, web: true }, meta: null });
  assert.match(none.detail, /Terminal commands: not included; each one shows its card\./);
  assert.match(none.detail, /Internet: not included\./);
  assert.match(none.detail, /Meta: not included\. Nothing is sent to Meta under Full Access/);
  assert.doesNotMatch(none.detail, /may be billed/);
});

// ----- 2. Full Access over cards, within what it covers -----

test('Full Access: what it covers runs without cards (even with the Ask profile), and what it does not cover still asks or is refused', async () => {
  await withHarness({ shell: { enabled: true } }, async (h) => {
    await h.writeFile('package.json', JSON.stringify({ name: 'p', private: true, scripts: { test: 'node t.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await turnOnFull(h, { ...FILES_TESTS, commands: true });
    h.model.enqueue(
      tool('w', 'apply_patch', { files: [{ path: 'NOTES.md', expectedHash: sha(''), newContent: 'done\n' }] }),
      tool('t', 'run_tests', { commandId: 'npm:test' }),
      tool('c', 'run_command', { command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'ok\')"' }),
      tool('e', 'apply_patch', { files: [{ path: '.env', expectedHash: sha(''), newContent: 'KEY=1\n' }] }),
      tool('s', 'run_command', { command: 'sudo true' }),
    );
    const cards = await drive(h, h.provider.sendMessage('Write the notes, test, and record a run.', 'agent', 'local'), () => 'reject');
    assert.equal(cards.length, 1, cards.join(' | '));
    assert.ok(cards[0]?.startsWith('run_command'), 'privilege elevation still shows its card (and was rejected)');
    assert.equal(await h.readFile('NOTES.md'), 'done\n');
    assert.equal(await h.readFile('ran.txt'), 'ok');
    await assert.rejects(h.readFile('.env'), 'a protected file stays refused under Full Access');
    const decisions = h.provider.audit.list().filter((entry) => ['apply_patch', 'run_tests', 'run_command'].includes(entry.tool) && entry.decision !== 'policy');
    assert.deepEqual(decisions.map((entry) => `${entry.tool}:${entry.decision}`).slice(0, 3), ['apply_patch:full-access', 'run_tests:full-access', 'run_command:full-access'], 'recorded as Full Access, not as the profile');
    // Project memory always asks.
    h.model.enqueue(tool('m', 'propose_decision', { key: 'shipping.free_threshold_eur', valueType: 'number', value: '60', expectedVersion: 0, userWords: 'free shipping starts at 60 EUR', reason: 'the user said so' }));
    const memoryCards = await drive(h, h.provider.sendMessage('For this project free shipping starts at 60 EUR.', 'agent', 'local'), () => 'reject');
    assert.equal(memoryCards.length, 1);
    assert.ok(memoryCards[0]?.startsWith('propose_decision'));
    assert.equal(h.provider.memory.listCurrentDecisions(await scopeOf(h)).length, 0);
  });
});

test('a part Full Access does not include keeps its card', async () => {
  await withHarness({ shell: { enabled: true } }, async (h) => {
    await turnOnFull(h, FILES_TESTS);
    h.model.enqueue(tool('c', 'run_command', { command: 'node -e "require(\'fs\').writeFileSync(\'x.txt\', \'1\')"' }));
    const cards = await drive(h, h.provider.sendMessage('Run it.', 'agent', 'local'), () => 'reject');
    assert.equal(cards.length, 1);
    await assert.rejects(h.readFile('x.txt'));
    assert.match((await fullAccessNow(host(h), 'run_command', { command: 'ls' }, h.workspace) as { why: string }).why, /Full Access does not include terminal commands/);
    // Never covered by any part: project memory and the folder dialog.
    for (const name of ['propose_decision', 'bind_artifact', 'request_project_folder']) {
      assert.match((await fullAccessNow(host(h), name, {}, h.workspace) as { why: string }).why, /always needs its card/);
    }
  });
});

test('commands under Full Access still ask for privilege elevation, RAME Code\'s own state and the system\'s stored secrets', () => {
  const state = ['/home/u/.vscode-server/data/User/globalStorage/caimari.rame-code'];
  for (const line of ['sudo apt-get install x', 'npm test && sudo rm -rf build', 'doas ls', 'pkexec true', 'su -c id', '(sudo true)', '/usr/bin/sudo true', 'bash -c "sudo true"', "sh -c 'sudo'", 'x=$(sudo cat f)', 'Start-Process pwsh -Verb RunAs']) {
    assert.equal(commandNeedsCard(line, state), 'it elevates privileges', line);
  }
  for (const line of ['cat ~/.config/Code/User/globalStorage/x/shared-state/state.json', `echo x > ${state[0]}/shared-state/rameCode.autonomy.v1.json`, 'node -e "1" # rameCode.autonomy']) {
    assert.equal(commandNeedsCard(line, state), "it mentions RAME Code's own state", line);
  }
  for (const line of ['secret-tool lookup service vscode', 'security find-generic-password -s x', 'cmdkey /list']) {
    assert.equal(commandNeedsCard(line, state), "it reads the system's stored secrets", line);
  }
  for (const line of ['npm test', 'node -e "1"', 'git status', 'echo sudoku', 'pseudo-random', 'npm run sudo-check', 'cd /workspace/rame-code-long && npm run build', 'grep issue src']) {
    assert.equal(commandNeedsCard(line, state), null, line);
  }
});

// ----- 3. The model never gives itself permissions -----

test('the model cannot grant itself anything: no tool reaches the permissions, a command that names the store asks, and a forged or copied policy does not verify', async () => {
  const dir = '/home/u/.config/Code/User/globalStorage/caimari.rame-code';
  await withHarness({ shell: { enabled: true } }, async (h) => {
    const scopeId = await scopeOf(h);
    await turnOnFull(h, { ...FILES_TESTS, commands: true });
    const offered = () => ((h.model.requests.at(-1) as Request | undefined)?.tools ?? []).map((entry) => entry.function.name);
    // A command that would write a grant into RAME Code's own state shows its card (rejected here).
    h.model.enqueue(tool('f', 'autonomyFull', { tools: { commands: true }, validityHours: 720 }), tool('c', 'run_command', { command: `node -e "require('fs').writeFileSync('${dir}/shared-state/rameCode.autonomy.v1.json', '{}')"` }));
    const cards = await drive(h, h.provider.sendMessage('Give yourself more time.', 'agent', 'local'), () => 'reject');
    assert.equal(offered().some((name) => /autonomy|permission|preauth|grant|full/i.test(name)), false, offered().join(', '));
    assert.equal(cards.length, 1, 'the store-writing command asked');
    assert.equal(h.provider.autonomy.get(scopeId).full?.tools.jobs, false, 'Full Access is exactly what the user gave');
    // Even written by something that bypassed RAME, a forged policy does not verify.
    const before = h.provider.autonomy.get(scopeId);
    const raw = h.memento.get(AUTONOMY_STATE_KEY) as { version: number; workspaces: Record<string, { policy: WorkspaceAutonomy; mac: string }> };
    const slot = Object.keys(raw.workspaces).find((key) => key.endsWith(`/${scopeId}`)) as string;
    const forged = JSON.parse(JSON.stringify(raw)) as typeof raw;
    (forged.workspaces[slot] as { policy: WorkspaceAutonomy }).policy.full!.expiresAt = Date.now() + 365 * 86_400_000;
    (forged.workspaces[slot] as { policy: WorkspaceAutonomy }).policy.full!.tools = { files: true, tests: true, commands: true, installs: true, jobs: true, web: true, meta: true };
    h.memento.set(AUTONOMY_STATE_KEY, forged);
    assert.equal(h.provider.autonomy.get(scopeId).mode, 'ask', 'a changed policy reads as Ask always');
    assert.equal(h.provider.autonomy.get(scopeId).full, null);
    assert.equal((await fullAccessNow(host(h), 'apply_patch', {}, h.workspace)).ok, false);
    // A sealed record moved to another workspace's slot does not verify there.
    h.memento.set(AUTONOMY_STATE_KEY, { version: 2, workspaces: { [slot.replace(scopeId, 'ws_other')]: raw.workspaces[slot] } });
    assert.equal(h.provider.autonomy.get('ws_other').full, null);
    assert.equal(h.provider.autonomy.get(scopeId).full, null);
    h.memento.set(AUTONOMY_STATE_KEY, raw);
    assert.deepEqual(h.provider.autonomy.get(scopeId).full, before.full, 'the genuine record still verifies');
  });
});

// ----- 4. Meta without a fixed limit of five -----

test('Meta limits: 1, 5, 10, 100, 1000 or no count limit, chosen in the view; anything else is refused before the host', () => {
  for (const max of [1, 2, 3, 4, 5, 10, 100, 1000, -1]) {
    const parsed = parseAutonomyMessage({ type: 'autonomyMeta', maxPerMission: max, validityHours: 8, dataScope: 'instructions', tokenBudget: 0 });
    assert.equal(parsed?.type === 'autonomyMeta' ? parsed.maxPerMission : 'x', max === -1 ? null : max);
  }
  for (const max of [0, 6, 7, 11, 999, 1001, -2, 2.5]) {
    assert.throws(() => parseAutonomyMessage({ type: 'autonomyMeta', maxPerMission: max, validityHours: 8, dataScope: 'instructions' }), String(max));
  }
  assert.equal((parseAutonomyMessage({ type: 'autonomyMeta', maxPerMission: 5, validityHours: 720, dataScope: 'files', tokenBudget: 100000 }) as { tokenBudget: number }).tokenBudget, 100000);
  assert.throws(() => parseAutonomyMessage({ type: 'autonomyMeta', maxPerMission: 5, validityHours: 8, dataScope: 'files', tokenBudget: 12345 }));
  const start = { type: 'missionStart', missionId: 'mis_' + 'a'.repeat(24), revision: 1, mode: 'supervised', trustedProject: false, acceptanceCommand: '', acceptanceFiles: [] };
  for (const count of [0, 1, 5, 10, 100, 1000, -1]) {
    assert.equal((parseViewInboundMessage({ ...start, maxConsultations: count }) as { maxConsultations: number }).maxConsultations, count);
  }
  for (const count of [6, 9, 11, 1001, -2]) {
    assert.throws(() => parseViewInboundMessage({ ...start, maxConsultations: count }), String(count));
  }
});

test('no count limit: more than five consultations are sent, each still within its byte and token limits, which still stop it', async () => {
  await withBench(async (b) => {
    await b.authorize({ max: 5 });
    assert.match((await b.grant(null)).error ?? '', /allows at most 5 consultation\(s\) per Mission/, 'a finite pre-authorization never allows no count limit');
    assert.match((await b.grant(10)).error ?? '', /allows at most 5/);
    await b.authorize({ max: null });
    assert.ok((await b.grant(null)).ok);
    // The same blocker stays open: each call is a new consultation about it.
    for (let n = 0; n < 8; n++) {
      await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    }
    assert.equal(fakeCloud.requests.length, 8, 'eight, beyond the old limit of five');
    assert.equal(b.mission().grant?.escalation?.used, 8);
    assert.equal(b.mission().grant?.escalation?.maxConsultations, null);
    assert.match(b.notes(), /attempt 8 \(no count limit\), a valid answer/);
    // The technical limits remain: shrink the total bytes so that only one more request fits.
    const sent = b.mission().grant?.escalation?.sentBytes ?? 0;
    const each = Math.ceil(sent / 8);
    const current = b.mission();
    await b.missions.update(b.id, current.revision, (draft) => {
      if (draft.grant?.escalation) {
        draft.grant.escalation.maxTotalBytes = sent + each + Math.floor(each / 2);
      }
      return { ok: true, value: draft };
    });
    for (let n = 0; n < 3; n++) {
      await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    }
    assert.equal(fakeCloud.requests.length, 9, 'one more fitted, then the byte total stopped it');
    assert.match(b.notes(), /not sent, because the request \(\d+ bytes\) would bring the total sent to \d+ of \d+ bytes; not counted, and the limit is not raised/);
    assert.match(autonomyView(b.host)?.missions[0]?.text ?? '', /9 consultation\(s\) used, no count limit/);
  });
});

test('concurrent consultations with no count limit: every one is counted once, none lost; with a token budget, one slot of budget is used once', async () => {
  await withBench(async (b) => {
    await b.authorize({ max: null });
    assert.ok((await b.grant(null)).ok);
    fakeCloud.handler = () => new Promise<Response>((resolve) => setTimeout(() => resolve(advice()), 20)) as unknown as Response;
    await Promise.all([1, 2, 3, 4, 5].map(() => consultForMission(b.host, b.id, 'stuck', [], 'ws_1')));
    assert.equal(fakeCloud.requests.length, 5);
    assert.equal(b.mission().grant?.escalation?.used, 5, 'no lost update');
    assert.equal(b.autonomy.get('ws_1').log.filter((entry) => entry.provider === 'Meta Model API').length, 5);
  });
  await withBench(async (b) => {
    await b.authorize({ max: null, tokenBudget: 100_000 });
    assert.ok((await b.grant(null)).ok);
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    assert.equal(b.autonomy.get('ws_1').meta?.usedTokens, 50, 'what Meta reported replaces the reserved bound');
    const bytes = b.mission().grant?.escalation?.sentBytes ?? 0;
    const bound = bytes + 2048;
    // Leave room for exactly one more request's bound.
    await b.autonomy.change('ws_1', (policy) => {
      if (policy.meta) {
        policy.meta.usedTokens = 100_000 - bound - 10;
      }
    });
    fakeCloud.handler = () => new Promise<Response>((resolve) => setTimeout(() => resolve(advice()), 20)) as unknown as Response;
    await Promise.all([1, 2, 3].map(() => consultForMission(b.host, b.id, 'stuck', [], 'ws_1')));
    assert.equal(fakeCloud.requests.length, 2, 'one more, never two');
    assert.equal(b.autonomy.get('ws_1').meta?.usedTokens, 100_000 - bound - 10 + 50);
    assert.match(b.notes(), /only \d+ of the pre-authorization's 100000-token budget remain/);
    assert.equal(b.mission().grant?.escalation?.used, 2, 'refused ones were not counted');
    // Used up: nothing more is sent without a card.
    await b.autonomy.change('ws_1', (policy) => {
      if (policy.meta) {
        policy.meta.usedTokens = 100_000;
      }
    });
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    assert.equal(fakeCloud.requests.length, 2);
    assert.match(b.notes(), /budget of 100000 remote tokens is used up/);
  });
});

test('a Mission whose stored count was raised above the pre-authorization sends nothing', async () => {
  await withBench(async (b) => {
    await b.authorize({ max: 5 });
    assert.ok((await b.grant(5)).ok);
    const current = b.mission();
    await b.missions.update(b.id, current.revision, (draft) => {
      if (draft.grant?.escalation) {
        draft.grant.escalation.maxConsultations = null;
      }
      return { ok: true, value: draft };
    });
    await consultForMission(b.host, b.id, 'stuck', [], 'ws_1');
    assert.equal(fakeCloud.requests.length, 0);
    assert.match(b.notes(), /not sent without a card: the Mission's count is above the pre-authorization \(The Meta pre-authorization allows at most 5 consultation\(s\) per Mission\)/);
  });
});

// ----- 5. Bound to the computer or Remote SSH server -----

test('permissions belong to the environment they were given on: local is not inherited by Remote SSH, each server has its own, and a change of server identity or user invalidates them', async () => {
  const backend = memoryBackend();
  const local = new AutonomyStore(backend, runtimeOf(probe(undefined, 'devbox', 'ana', 'm-local', null)));
  const serverA = new AutonomyStore(backend, runtimeOf(probe('ssh-remote', 'build-1', 'ana', 'm-a', 'AAAAkeyA')));
  const serverB = new AutonomyStore(backend, runtimeOf(probe('ssh-remote', 'build-2', 'ana', 'm-b', 'AAAAkeyB')));
  assert.match(local.env().label, /^this computer \(devbox, user ana\)$/);
  assert.match(serverA.env().label, /^the Remote SSH server build-1 \(user ana\)$/);
  // Same host name, different kind: still another environment.
  assert.notEqual(computeExecEnv(probe('ssh-remote', 'devbox', 'ana', 'm-local', null)).id, local.env().id);
  // Given locally, with the dialog naming this computer.
  const shown: string[] = [];
  await send(windowHost(local, { confirmAutonomy: async (request: { message: string }) => (shown.push(request.message), true) }), { type: 'autonomyFull', tools: FILES_TESTS, validityHours: 8 });
  assert.match(shown[0] ?? '', /on this computer \(devbox, user ana\)\?$/);
  assert.equal(local.get('ws_1').mode, 'full');
  // The same workspace path on a Remote SSH server, even with a shared store: nothing inherited.
  assert.equal(serverA.get('ws_1').mode, 'ask');
  assert.equal(serverA.get('ws_1').full, null);
  // Each server gets its own, and revoking one leaves the others.
  await send(windowHost(serverA), { type: 'autonomyFull', tools: { ...NONE, web: true }, validityHours: 1 });
  assert.equal(serverA.get('ws_1').full?.envLabel, 'the Remote SSH server build-1 (user ana)');
  assert.equal(serverB.get('ws_1').full, null);
  await send(windowHost(serverA), { type: 'autonomyRevoke', what: 'all' });
  assert.equal(serverA.get('ws_1').full, null);
  assert.deepEqual(local.get('ws_1').full?.tools, FILES_TESTS);
  await send(windowHost(serverB), { type: 'autonomyFull', tools: FILES_TESTS, validityHours: 1 });
  // A reinstalled server (new SSH host key), another user, or a renamed host is another environment.
  for (const changed of [probe('ssh-remote', 'build-2', 'ana', 'm-b', 'AAAAnewKey'), probe('ssh-remote', 'build-2', 'bob', 'm-b', 'AAAAkeyB'), probe('ssh-remote', 'build-3', 'ana', 'm-b', 'AAAAkeyB')]) {
    const later = new AutonomyStore(backend, runtimeOf(changed));
    assert.equal(later.get('ws_1').full, null, changed.hostname() + changed.user());
  }
  assert.notEqual(new AutonomyStore(backend, runtimeOf(probe('ssh-remote', 'build-2', 'ana', 'm-b', 'AAAAkeyB'))).get('ws_1').full, null, 'the same server still has it');
  // A record re-sealed into another environment's slot is still not in force there: each grant carries its environment.
  const moved = serverA.seal('ws_1', local.get('ws_1'));
  backend.memory.set(AUTONOMY_STATE_KEY, { version: 2, workspaces: { ...(backend.get(AUTONOMY_STATE_KEY) as { workspaces: object }).workspaces, [moved.slot]: moved.record } });
  assert.equal(serverA.get('ws_1').full, null);
  // A Meta binding from another environment is refused.
  const policy: WorkspaceAutonomy = {
    mode: 'supervised', missionWeb: null, agentWeb: null, full: null, log: [],
    meta: { id: 'pre_0123456789abcdef', user: 'ana', envId: local.env().id, envLabel: local.env().label, scopeId: 'ws_1', project: 'p', provider: 'Meta Model API', model: MODEL, credentialRevision: 'a'.repeat(32), maxPerMission: 5, dataScope: 'instructions', tokenBudget: null, usedTokens: 0, adviceUses: {}, grantedAt: Date.now(), expiresAt: Date.now() + 3_600_000 },
  };
  const ctx = { now: Date.now(), user: 'ana', scopeId: 'ws_1', envId: local.env().id, model: MODEL, credentialRevision: 'a'.repeat(32), cloudEscalation: true };
  const binding = { preauthId: 'pre_0123456789abcdef', user: 'ana', scopeId: 'ws_1', envId: serverA.env().id, provider: 'Meta Model API' as const, model: MODEL, credentialRevision: 'a'.repeat(32), expiresAt: Date.now() + 3_600_000, files: [] };
  assert.match(metaRefusal(policy, binding, ctx) ?? '', /another workspace, computer, user, provider, model or key/);
  assert.match(metaRefusal(policy, null, { ...ctx, envId: serverA.env().id }) ?? '', /was given on another computer or server \(this computer \(devbox, user ana\)\)/);
});

// ----- 6. Revocation from any window, and restarts -----

test('revocation from another window: a consultation being sent is cancelled within a second, a run under Full Access is stopped, its long jobs too', async () => {
  const backend = memoryBackend();
  const a = await bench({ backend });
  const b = await bench({ backend });
  fakeCloud.requests.length = 0;
  try {
    await a.authorize({ max: null });
    assert.equal(b.autonomy.get('ws_1').meta?.id, a.autonomy.get('ws_1').meta?.id, 'one shared policy');
    assert.ok((await a.grant(null)).ok);
    // Window B revokes while window A's consultation is on its way; B's own module never touches A's request.
    fakeCloud.handler = () => {
      void b.autonomy.change('ws_1', (policy) => {
        policy.meta = null;
      });
      return new Promise<Response>(() => undefined) as unknown as Response;
    };
    const started = Date.now();
    await consultForMission(a.host, a.id, 'stuck', [], 'ws_1');
    assert.ok(Date.now() - started < 3000, `cancelled after ${Date.now() - started} ms`);
    assert.match(a.notes(), /cancelled because the pre-authorization was revoked; what had already been sent cannot be taken back, and no advice was used/);
    // Full Access in A: the run that used it stops when B revokes it.
    let cancelled = 0;
    const runA = windowHost(a.autonomy, { running: true, cancelRequest: () => (cancelled += 1, true) });
    await send(runA, { type: 'autonomyFull', tools: { ...FILES_TESTS, jobs: true }, validityHours: 8 });
    const granted = await fullAccessNow(runA, 'apply_patch', {}, '/srv/project');
    assert.ok(granted.ok);
    await rememberFullJob(runA, 'ws_1', granted.ok ? granted.id : '', 'job_1');
    const stoppedJobs: string[] = [];
    const runB = windowHost(b.autonomy, { jobs: { get: () => ({ status: 'running' }), cancel: async (id: string) => (stoppedJobs.push(id), { ok: true }) } });
    await send(runB, { type: 'autonomyRevoke', what: 'all' });
    assert.deepEqual(stoppedJobs, ['job_1'], 'the long job it started is stopped by the window that revoked');
    assert.match(String(runB.status), /was revoked in every window of this workspace[^]*1 long job\(s\) it started were stopped/);
    assert.ok(await until(() => cancelled === 1), 'window A stopped its run within a second');
    assert.match(String(runA.status), /Full Access was revoked or expired: the run that used it was stopped/);
    assert.equal((await fullAccessNow(runA, 'apply_patch', {}, '/srv/project')).ok, false, 'no new operation under it');
    assert.equal(await checkRevocations(), 0);
  } finally {
    fakeCloud.handler = null;
    a.dispose();
    b.dispose();
  }
});

test('the Agent and Chat web pre-authorization is shared by the windows of a workspace: one counter, and a revocation in one window holds in the other', async () => {
  const backend = memoryBackend();
  const store = new AutonomyStore(backend);
  const other = new AutonomyStore(backend);
  const one = windowHost(store);
  const two = windowHost(other);
  await send(one, { type: 'autonomyMode', mode: 'supervised' });
  await send(one, { type: 'autonomySessionWeb', maxSearches: 3, maxFetches: 0, domains: [], validityHours: 1 });
  await send(two, { type: 'autonomyRefresh' });
  const uses = [];
  for (const [window, n] of [[one, 1], [two, 2], [one, 3], [two, 4]] as const) {
    uses.push(await useAgentWebNow(window, 'web_search', { query: `node lts ${n}` }, '/srv/project'));
  }
  assert.deepEqual(uses, [true, true, true, false], 'three in total, across both windows');
  assert.equal(other.get('ws_1').agentWeb?.searches, 3);
  await send(one, { type: 'autonomySessionWeb', maxSearches: 3, maxFetches: 0, domains: [], validityHours: 1 });
  assert.equal(await useAgentWebNow(two, 'web_search', { query: 'node lts' }, '/srv/project'), true);
  await send(two, { type: 'autonomyRevoke', what: 'sessionWeb' });
  assert.equal(await useAgentWebNow(one, 'web_search', { query: 'node lts' }, '/srv/project'), false, 'revoked in the other window');
  // Full Access with web asks nothing and counts nothing (the user's decision of 08-11): code-like queries too;
  // what must never leave is removed from a query, and an address that carries a key is not requested, when the call runs.
  await send(one, { type: 'autonomyFull', tools: { ...NONE, web: true }, validityHours: 1 });
  assert.equal(await useAgentWebNow(two, 'web_search', { query: 'node release schedule' }, '/srv/project'), true);
  assert.equal(await useAgentWebNow(two, 'web_search', { query: 'const k = process.env.KEY' }, '/srv/project'), true);
  assert.equal(await useAgentWebNow(two, 'web_fetch', { url: 'https://example.org/?token=sk-live-abcdefghijklmnopqrstuvwxyz0123' }, '/srv/project'), true);
});

test('after a restart: Full Access holds until it expires; a revoked one never comes back; a lost key leaves nothing in force', async () => {
  await withHarness({}, async (h) => {
    const scopeId = await scopeOf(h);
    await turnOnFull(h, FILES_TESTS);
    const id = h.provider.autonomy.get(scopeId).full?.id;
    h.createProvider();
    await h.provider.refreshHasKey();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.provider.autonomy.get(scopeId).full?.id, id, 'the same grant after the reload');
    assert.equal((await fullAccessNow(host(h), 'apply_patch', {}, h.workspace)).ok, true);
    // Expired: not in force, also after a restart.
    await h.provider.autonomy.change(scopeId, (policy) => {
      if (policy.full) {
        policy.full.grantedAt = Date.now() - 2 * 3_600_000;
        policy.full.expiresAt = Date.now() - 3_600_000;
      }
    });
    assert.match((await fullAccessNow(host(h), 'apply_patch', {}, h.workspace) as { why: string }).why, /Full Access expired at/);
    await turnOnFull(h, FILES_TESTS);
    await onAutonomyMessage(host(h), { type: 'autonomyRevoke', what: 'full' });
    h.createProvider();
    await h.provider.refreshHasKey();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.provider.autonomy.get(scopeId).full, null, 'revoked: never back');
    // The seal key is gone from the keychain: a new key is made, and nothing old is in force.
    await turnOnFull(h, FILES_TESTS);
    h.secretValues.delete('rameCode.autonomy.sealKey');
    h.createProvider();
    await h.provider.refreshHasKey();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.provider.autonomy.get(scopeId).full, null);
    assert.equal(h.provider.autonomy.get(scopeId).mode, 'ask');
  });
});

// ----- 7. Internet and Missions under Full Access -----

test('Full Access with web: every search runs without a card in Agent, code-like ones too; an autonomous Mission gets its web budget under it, until it is revoked', async () => {
  const searx = await fakeSearx([{ title: 'Node', url: 'https://nodejs.org/en', content: 'LTS' }]);
  try {
    await withHarness({ mode: 'agent', web: { enabled: true, search: 'searxng', searxngUrl: searx.origin } }, async (h) => {
      const scopeId = await scopeOf(h);
      await turnOnFull(h, { ...NONE, web: true });
      // Since 08-11 (the user's decision) a code-like query asks nothing under Full Access with web either.
      h.model.enqueue(tool('s1', 'web_search', { query: 'current node lts' }), tool('s2', 'web_search', { query: 'const x = require("fs")' }), say('Done.'));
      const cards = await drive(h, h.provider.sendMessage('Look up the current Node LTS.', 'agent', 'local'), () => 'reject');
      assert.equal(cards.length, 0, cards.join(' | '));
      assert.deepEqual(searx.queries, ['current node lts', 'const x = require("fs")']);
      assert.match(result(h, 's1'), /^Search \(SearXNG\): current node lts/);
      const log = h.provider.autonomy.get(scopeId).log.filter((entry) => entry.provider === 'Web search');
      assert.deepEqual(log.map((entry) => entry.approval), ['full-access', 'full-access']);
      // A Mission: its web budget is bound to Full Access when no separate Missions pre-authorization exists.
      await h.writeFile('package.json', JSON.stringify({ name: 'm', private: true, scripts: { test: 'node t.js' } }));
      await h.writeFile('t.js', 'process.exit(0);\n');
      h.model.enqueue(tool('plan', 'submit_mission_plan', { goal: 'Check node.', assumptions: [], steps: [{ id: 't1', title: 'Check', successCriterion: 'npm:test passes' }], risks: [] }));
      await h.provider.sendMessage('Check node.', 'mission', 'local');
      assert.ok(h.memento.get(MISSION_STATE_KEY), String(h.last().status));
      const mission = storedMission(h);
      h.send({ type: 'missionWebSet', missionId: mission.id, enabled: true, maxSearches: 1, maxFetches: 0, domains: [] });
      h.model.enqueue(say('Done.'));
      await drive(h, h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true), () => 'reject');
      const grant = storedMission(h).grant;
      assert.equal(grant?.web?.preauthId, h.provider.autonomy.get(scopeId).full?.id);
      assert.equal(missionWebRefusalNow(host(h), scopeId, grant?.web?.preauthId ?? null), null);
      await onAutonomyMessage(host(h), { type: 'autonomyRevoke', what: 'full' });
      assert.match(missionWebRefusalNow(host(h), scopeId, grant?.web?.preauthId ?? null) ?? '', /revoked or replaced/);
    });
  } finally {
    await searx.close();
  }
});

test('installs under Full Access: without administrator rights they skip the card; with them they never do (decided only: nothing is installed)', async () => {
  await withHarness({ agentProfile: 'ask', installs: { enabled: true, auto: false } }, async (h) => {
    const call = (manager: string, name: string) => ({ id: 'i', tool: 'install_package' as const, args: { manager, name, reason: 'needed' } });
    assert.equal(await extraToolAuto(host(h), 'ask', call('npm', 'left-pad') as never, h.workspace), false, 'without Full Access: card');
    await turnOnFull(h, { ...NONE, installs: true });
    assert.equal(await extraToolAuto(host(h), 'ask', call('npm', 'left-pad') as never, h.workspace), true, 'npm for the user: no card');
    assert.equal(await extraToolAuto(host(h), 'ask', call('apt', 'jq') as never, h.workspace), process.platform === 'win32', 'apt needs administrator rights: card');
    assert.equal(await extraToolAuto(host(h), 'ask', { id: 'r', tool: 'run_command', args: { command: 'ls' } } as never, h.workspace), false, 'commands were not included');
  });
});
