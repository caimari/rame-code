/**
 * Agent and the project folder (human validation: "Select workspace folder
 * for this Agent run" appeared even for a web-only question):
 *   - one folder open: used, no picker;
 *   - a thread already bound to an open folder keeps it, no picker;
 *   - a new thread with no folder or several: Agent WITHOUT a project, with
 *     only web_search / web_fetch (when on) and request_project_folder; no
 *     file, test, terminal, memory or history tool;
 *   - request_project_folder opens the picker: the user chooses (or not),
 *     and the project tools apply from the next message;
 *   - a thread whose folder was closed is never moved to another folder by
 *     itself; Mission, and Agent with Meta, still need an explicit folder.
 * Simulated model and folders only; no network.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { assistantText, fakeWindow, fakeWorkspace, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

type Request = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: string | null; tool_call_id?: string }> };
const toolsOf = (request: unknown): string[] => ((request as Request).tools ?? []).map((tool) => tool.function.name).sort();
const WEB = { enabled: true, search: 'duckduckgo', searxngUrl: '' };
const threadOf = (h: HostHarness) => h.provider.store.get(h.last().activeThreadId as string);
const records = (state: PostedState) => JSON.stringify(state.turns);

async function withFolders(folders: number, settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness({ folders });
  await h.start({ agentProfile: 'safe-auto', ...settings });
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

test('one folder open: Agent uses it without asking', async () => {
  await withFolders(1, { web: WEB }, async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText('Hello.') });
    await h.provider.sendMessage('What is in this project?', 'agent', 'local');
    assert.equal(fakeWindow.quickPickCalls, 0);
    assert.ok(toolsOf(h.model.requests[0]).includes('read_file'), 'project tools');
    assert.ok(!toolsOf(h.model.requests[0]).includes('request_project_folder'));
    assert.equal(threadOf(h)?.workspaceRoot, h.workspace);
  });
});

test('several folders, new thread: no picker; Agent without a project offers only the web and request_project_folder', async () => {
  await withFolders(2, { web: WEB }, async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText('Node.js LTS is listed on nodejs.org.') });
    await h.provider.sendMessage('What is the current Node.js LTS?', 'agent', 'local');
    assert.equal(fakeWindow.quickPickCalls, 0, 'no folder picker for a question that needs no project');
    assert.deepEqual(toolsOf(h.model.requests[0]), ['request_project_folder', 'web_fetch', 'web_search']);
    assert.equal(threadOf(h)?.workspaceRoot, undefined, 'the thread is bound to no folder');
    assert.equal(h.last().agentWorkspace, null, 'the view shows "No project folder — web only"');
    assert.match(records(h.last()), /no project folder: web only \(no file, test, terminal or memory tool\)/);
    assert.equal(h.last().running, false);
  });
});

test('no folder open: Agent still answers without a project; with web access off it only offers request_project_folder', async () => {
  await withFolders(0, {}, async (h) => {
    h.model.enqueue({ kind: 'json', body: assistantText('Here is a general answer.') });
    await h.provider.sendMessage('Explain what an LTS release is.', 'agent', 'local');
    assert.equal(fakeWindow.quickPickCalls, 0);
    assert.deepEqual(toolsOf(h.model.requests[0]), ['request_project_folder']);
    assert.match(String(h.last().turns.at(-1)?.text ?? ''), /general answer/);
  });
});

test('without a project, a project tool is refused before any card and nothing is read; memory tools are not there either', async () => {
  await withFolders(2, { web: WEB }, async (h) => {
    await h.writeFile('secret.txt', 'NOT-TO-BE-READ');
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'r', name: 'read_file', args: { path: 'secret.txt', maxBytes: 4096 } }]) },
      { kind: 'json', body: toolCallReply([{ id: 'p', name: 'propose_decision', args: { key: 'a.b', valueType: 'boolean', value: 'true', expectedVersion: 0, userWords: 'set a.b to true', reason: 'x' } }]) },
      { kind: 'json', body: assistantText('I need a project folder for that.') },
    );
    await h.provider.sendMessage('Read secret.txt and set a.b to true.', 'agent', 'local');
    assert.equal(h.last().agentPending, null);
    const result = (id: string) => String(h.model.requests.flatMap((request) => (request as Request).messages).find((m) => m.tool_call_id === id)?.content ?? '');
    assert.match(result('r'), /read_file is not available: this Agent has no project folder/);
    assert.match(result('p'), /propose_decision is not available: this Agent has no project folder/);
    assert.doesNotMatch(JSON.stringify(h.model.requests), /NOT-TO-BE-READ/);
    h.send({ type: 'navigate', screen: 'settings' });
    const state = await h.waitFor((s) => s.screen === 'settings', 4000);
    assert.deepEqual((state.memory as { decisions?: unknown[] }).decisions ?? [], []);
  });
});

test('request_project_folder: the user chooses in the picker; project tools apply from the next message, without asking again', async () => {
  await withFolders(2, { web: WEB }, async (h) => {
    const second = (fakeWorkspace.workspaceFolders ?? [])[1]?.uri.fsPath as string;
    fakeWindow.quickPickAnswer = (items: Array<{ description?: string }>) => items.find((item) => item.description === second);
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'f', name: 'request_project_folder', args: { reason: 'I need to read the project files.' } }]) },
      { kind: 'json', body: assistantText('Folder chosen: please send the request again.') },
    );
    await h.provider.sendMessage('Fix the failing test in my project.', 'agent', 'local');
    assert.equal(fakeWindow.quickPickCalls, 1, 'the user was asked');
    const told = h.model.requests.flatMap((request) => (request as Request).messages).find((m) => m.tool_call_id === 'f');
    assert.match(String(told?.content), /The user chose the project folder ".+"\. Its tools apply from the user's next message/);
    assert.equal(threadOf(h)?.workspaceRoot, second, 'the chosen folder is bound to this thread');
    assert.match(records(h.last()), /request_project_folder → the user chose .+; project tools apply from the next message/);

    fakeWindow.quickPickAnswer = undefined;
    h.model.requests.length = 0;
    h.model.enqueue({ kind: 'json', body: assistantText('Looking at the project now.') });
    await h.provider.sendMessage('Go ahead.', 'agent', 'local');
    assert.equal(fakeWindow.quickPickCalls, 1, 'no second picker: the thread keeps its folder');
    assert.ok(toolsOf(h.model.requests[0]).includes('read_file'));
    assert.ok(!toolsOf(h.model.requests[0]).includes('request_project_folder'));
    assert.equal(h.last().agentWorkspace !== null, true);
  });
});

test('request_project_folder cancelled: the thread stays without a project, and nothing is bound', async () => {
  await withFolders(2, { web: WEB }, async (h) => {
    fakeWindow.quickPickAnswer = undefined;
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'f', name: 'request_project_folder', args: { reason: 'Need the repo.' } }]) },
      { kind: 'json', body: assistantText('Without a folder I can only answer generally.') },
    );
    await h.provider.sendMessage('Fix my tests.', 'agent', 'local');
    assert.equal(fakeWindow.quickPickCalls, 1);
    assert.equal(threadOf(h)?.workspaceRoot, undefined);
    const told = h.model.requests.flatMap((request) => (request as Request).messages).find((m) => m.tool_call_id === 'f');
    assert.match(String(told?.content), /did not choose a project folder/);
    h.model.enqueue({ kind: 'json', body: assistantText('Still general.') });
    await h.provider.sendMessage('OK, just explain.', 'agent', 'local');
    assert.equal(fakeWindow.quickPickCalls, 1, 'not asked again by itself');
    assert.equal(threadOf(h)?.workspaceRoot, undefined);
  });
});

test('several folders, existing bound thread: it keeps its folder without asking', async () => {
  await withFolders(2, { web: WEB }, async (h) => {
    fakeWindow.quickPickAnswer = (items: Array<{ description?: string }>) => items.find((item) => item.description === h.workspace);
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'f', name: 'request_project_folder', args: { reason: 'Need it.' } }]) }, { kind: 'json', body: assistantText('Chosen.') });
    await h.provider.sendMessage('Work on my project.', 'agent', 'local');
    const asked = fakeWindow.quickPickCalls;
    h.model.enqueue({ kind: 'json', body: assistantText('Working.') });
    await h.provider.sendMessage('Continue.', 'agent', 'local');
    assert.equal(fakeWindow.quickPickCalls, asked);
    assert.equal(threadOf(h)?.workspaceRoot, h.workspace);
  });
});

test('a thread whose folder was closed is never moved to another folder by itself: the user is asked; cancel runs nothing', async () => {
  await withFolders(2, {}, async (h) => {
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'f', name: 'request_project_folder', args: { reason: 'Need it.' } }]) }, { kind: 'json', body: assistantText('Chosen.') });
    fakeWindow.quickPickAnswer = (items: Array<{ description?: string }>) => items.find((item) => item.description === h.workspace);
    await h.provider.sendMessage('Work on my project.', 'agent', 'local');
    // The bound folder is closed; one other folder remains open.
    fakeWorkspace.workspaceFolders = (fakeWorkspace.workspaceFolders ?? []).slice(1);
    fakeWindow.quickPickAnswer = undefined;
    const asked = fakeWindow.quickPickCalls;
    const sent = h.model.requests.length;
    await h.provider.sendMessage('Continue.', 'agent', 'local');
    assert.equal(fakeWindow.quickPickCalls, asked + 1, 'asked, even with a single other folder open');
    assert.equal(h.model.requests.length, sent, 'nothing ran after cancel');
    assert.equal(threadOf(h)?.workspaceRoot, h.workspace, 'still bound to its own folder');
  });
});

test('Mission and Agent with Meta still need an explicit folder: several folders ask, none refuses', async () => {
  await withFolders(2, {}, async (h) => {
    await h.provider.sendMessage('Plan a cleanup.', 'mission', 'local');
    assert.equal(fakeWindow.quickPickCalls, 1, 'Mission asks');
    assert.equal(h.model.requests.length, 0);
    await h.provider.newThread();
    h.secretValues.set('rameCode.metaModelApiKey', 'fake-meta-key-FOLDER-1');
    await h.provider.refreshAll();
    await h.provider.sendMessage('Hello with Meta.', 'agent', 'cloud');
    assert.equal(fakeWindow.quickPickCalls, 2, 'Agent with Meta asks');
  });
  await withFolders(0, {}, async (h) => {
    await h.provider.sendMessage('Plan a cleanup.', 'mission', 'local');
    assert.match(h.last().status, /No workspace folder is open/);
    assert.equal(h.model.requests.length, 0);
  });
});

test('approvals made without a project are bound to no folder, and a web card is voided when the thread changes', async () => {
  await withFolders(2, { web: WEB }, async (h) => {
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 's', name: 'web_search', args: { query: 'node lts' } }]) }, { kind: 'json', body: assistantText('Done.') });
    const run = h.provider.sendMessage('Search node lts.', 'agent', 'local');
    const state = await h.waitFor((s) => s.agentPending !== null, 8000);
    assert.equal(state.agentPending?.tool, 'web_search');
    assert.equal(h.provider.agentPending?.workspaceId, '', 'bound to no folder');
    await h.provider.newThread();
    await run;
    assert.match(JSON.stringify(h.provider.store.list()), /did not run: approval invalidated/);
  });
});

test('the view: Agent without a project says so in the workspace badge (EN/ES); with a folder it shows the folder', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  type Node = { hidden: boolean; textContent: string; attributes: Record<string, string> };
  const nodes: Record<string, Node> = {};
  const node = (): Node => Object.assign({ hidden: true, textContent: '', attributes: {} as Record<string, string> }, {
    firstChild: null, dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    setAttribute(this: Node, name: string, value: string) { this.attributes[name] = value; },
    getAttribute(this: Node, name: string) { return this.attributes[name] ?? null; },
    addEventListener() {}, appendChild() {}, removeChild() {},
  });
  const context = { window: {} as Record<string, unknown>, document: { getElementById: (id: string) => (nodes[id] ??= node()), createElement: () => node(), querySelectorAll: () => [] } };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  const remote = context.window.RAME_REMOTE as { init(h: unknown): void; render(data: unknown): void };
  const i18n = context.window.RAME_I18N as { translate(language: string, text: string): string };
  let language = 'en';
  const t = (text: string) => (language === 'en' ? text : i18n.translate('es', text));
  const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), t(text));
  remote.init({ vscode: { postMessage() {} }, t, tf, tHost: t, markPending: () => true, hold() {} });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const show = async (mode: string, agentWorkspace: string | null) => {
    nodes.workspaceBadge = node();
    remote.render({ mode, agentWorkspace, connection: 'ready', agentPending: null, activeThreadId: 't', escalation: { pending: false, reason: '' }, remote: { consult: null, delegation: null, delegationFailure: null, localIssue: null, runtime: { local: 'running', cloud: 'configured', selected: 'local' } } });
    await tick();
    return [nodes.workspaceBadge.hidden, nodes.workspaceBadge.textContent];
  };
  assert.deepEqual(await show('agent', null), [false, 'No project folder — web only']);
  assert.deepEqual(await show('agent', 'my-project'), [true, ''], 'with a folder, main.js shows it (untouched here)');
  assert.deepEqual(await show('chat', null), [true, ''], 'Chat is not concerned');
  language = 'es';
  assert.deepEqual(await show('agent', null), [false, 'Sin carpeta de proyecto — solo web']);
});

test('Model evidence links each host action of an Agent without a project, as the host record does', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  await withFolders(2, { web: WEB, agentProfile: 'ask' }, async (h) => {
    const second = (fakeWorkspace.workspaceFolders ?? [])[1]?.uri.fsPath as string;
    fakeWindow.quickPickAnswer = (items: Array<{ description?: string }>) => items.find((item) => item.description === second);
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'r', name: 'read_file', args: { path: 'a.txt', maxBytes: 100 } }]) },
      { kind: 'json', body: toolCallReply([{ id: 's', name: 'web_search', args: { query: 'node lts' } }]) },
      { kind: 'json', body: toolCallReply([{ id: 'f', name: 'request_project_folder', args: { reason: 'Need the project.' } }]) },
      { kind: 'json', body: assistantText('Done.') },
    );
    const run = h.provider.sendMessage('Look this up, then work on my project.', 'agent', 'local');
    const state = await h.waitFor((s) => s.agentPending !== null, 8000);
    const card = state.agentPending as NonNullable<PostedState['agentPending']>;
    await h.provider.approveAgentAction(card.actionId, card.digest);
    await run;
    type Call = { tool: string; action: { result: string; approval: string | null; digest: string | null } | null };
    const evidence = h.last().modelEvidence as { decisive: Array<{ toolCalls: Call[] }>; other: Array<{ toolCalls: Call[] }> };
    const calls = [...evidence.decisive, ...evidence.other].flatMap((entry) => entry.toolCalls);
    const byTool = (tool: string) => calls.find((call) => call.tool === tool)?.action;
    assert.deepEqual(byTool('read_file'), { digest: null, approval: null, result: 'blocked-by-policy', write: false, commandId: null, exitCode: null });
    assert.equal(byTool('web_search')?.approval, 'human');
    assert.equal(byTool('web_search')?.digest, card.digest, 'the same digest as the approved card');
    assert.deepEqual(byTool('request_project_folder'), { digest: null, approval: 'human', result: 'applied', write: false, commandId: null, exitCode: null });
    assert.match(records(h.last()), /request_project_folder → the user chose/);
    // The view says the same as the host record, and never "No host action recorded" for these calls.
    const context = { window: {} as Record<string, unknown> };
    vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
    vm.runInNewContext(readFileSync('media/evidenceUx.js', 'utf8'), context);
    const module = context.window.RAME_EVIDENCE as { format(view: unknown, language: string, t: unknown, tf: unknown): { decisive: Array<{ calls: string[][] }>; other: Array<{ calls: string[][] }> }; helpersFor(language: string): { t: unknown; tf: unknown } };
    const helpers = module.helpersFor('en');
    const out = module.format(h.last().modelEvidence, 'en', helpers.t, helpers.tf);
    const lines = [...out.decisive, ...out.other].flatMap((entry) => entry.calls.flat()).join('\n');
    assert.match(lines, /Host action: you chose the project folder in VS Code's picker; nothing in it was read or changed/);
    assert.doesNotMatch(lines, /No host action recorded/);
  });
});
