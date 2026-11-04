/**
 * Interface language (English default, Spanish optional), the Project
 * memory folder picker, and the inline feedback of memory actions.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { describeProposal, type MemoryProposal } from '../src/decisionStore.js';
import { validateSettings } from '../src/settingsStore.js';
import { buildViewHtml } from '../src/viewHtml.js';
import { assistantText,
  toolCallReply, fakeWindow, HostHarness, type PostedState } from './helpers/hostHarness.js';

interface I18n {
  has(language: string): boolean;
  translate(language: string, text: string): string;
  translateHost(language: string, text: string): string;
  keys(language: string): string[];
}

function loadI18n(): I18n {
  const context = { window: {} as { RAME_I18N?: I18n } };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  // Feature modules add their own Spanish entries, as in the real view.
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/evidenceUx.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/localServersUx.js', 'utf8'), context);
  assert.ok(context.window.RAME_I18N);
  return context.window.RAME_I18N;
}

const i18n = loadI18n();
const es = new Set(i18n.keys('es'));
// Text that reads the same in Spanish, or is a name, symbol, or example.
const SAME = new Set(['Chat', 'Plan', 'Error', 'Local', 'RAME Code', 'English', 'Español', 'Muse Glimmer — Local', 'Workspace: {0}.', 'Workspace: {0}', '{0} tokens', '{0} — {1} ({2} v{3}). {4}']);

function needsNoTranslation(text: string): boolean {
  return SAME.has(text) || !/[A-Za-z]{2}/.test(text) || /^(\/path|http:|shipping\.|local-glimmer)/.test(text) || /^[\w./-]+\.(js|ts)$/.test(text);
}

function unescapeLiteral(raw: string): string {
  return raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\'/g, "'");
}

test('every interface string of the script and the markup has a Spanish entry', () => {
  // The remote module's own Spanish table is data, not interface text: leave it out of the scan.
  const remoteUx = readFileSync('media/remoteUx.js', 'utf8');
  const withoutTable = remoteUx.slice(0, remoteUx.indexOf('var ES = {')) + remoteUx.slice(remoteUx.indexOf('\n  };', remoteUx.indexOf('var ES = {')));
  const evidenceUx = readFileSync('media/evidenceUx.js', 'utf8');
  const evidenceCode = evidenceUx.slice(0, evidenceUx.indexOf('var ES = {')) + evidenceUx.slice(evidenceUx.indexOf('\n  };', evidenceUx.indexOf('var ES = {')));
  const serversUx = readFileSync('media/localServersUx.js', 'utf8');
  const serversCode = serversUx.slice(0, serversUx.indexOf('var ES = {')) + serversUx.slice(serversUx.indexOf('\n  };', serversUx.indexOf('var ES = {')));
  const script = [readFileSync('media/main.js', 'utf8'), withoutTable, evidenceCode, serversCode].join('\n');
  const used = new Set<string>();
  for (const match of script.matchAll(/\bt\('((?:[^'\\]|\\.)*)'\)/g)) {
    used.add(unescapeLiteral(match[1] as string));
  }
  for (const match of script.matchAll(/'((?:[^'\\\n]|\\.)*\{0\}(?:[^'\\\n]|\\.)*)'/g)) {
    used.add(unescapeLiteral(match[1] as string));
  }
  // Labels picked through tables before t() is applied.
  for (const table of ['MISSION_STATUS_LABELS', 'MISSION_PHASE_LABELS', 'START_LABELS', 'REASONING_LABELS', 'ARTIFACT_LABELS', 'CATEGORY', 'CAUSAL', 'PROFILES', 'FAILURE', 'APPROVAL', 'STATUS', 'TRIGGER', 'MODE']) {
    const body = script.slice(script.indexOf(`var ${table} = {`), script.indexOf('}', script.indexOf(`var ${table} = {`)));
    for (const match of body.matchAll(/:\s*'([^']+)'/g)) {
      used.add(match[1] as string);
    }
  }
  assert.ok(used.size > 100, `only ${used.size} strings found`);
  const missing = [...used].filter((text) => !es.has(text) && !needsNoTranslation(text));
  assert.deepEqual(missing, [], 'script strings without a Spanish entry');

  const html = buildViewHtml({ cspSource: 'vscode-webview://x', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js' });
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script'));
  const decode = (text: string): string =>
    text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const markup = new Set<string>();
  for (const match of body.matchAll(/>([^<]+)</g)) {
    const text = decode(match[1] as string).trim();
    if (text.length > 0) {
      markup.add(text);
    }
  }
  for (const match of body.matchAll(/\s(?:title|aria-label|placeholder)="([^"]*)"/g)) {
    markup.add(decode(match[1] as string));
  }
  const missingMarkup = [...markup].filter((text) => !es.has(text) && !needsNoTranslation(text));
  assert.deepEqual(missingMarkup, [], 'markup strings without a Spanish entry');
});

test('templates keep their slots and the table loads after the markup, before the script', () => {
  for (const key of es) {
    const slots = (text: string): string => [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort().join(',');
    assert.equal(slots(i18n.translate('es', key)), slots(key), `slots differ for ${key}`);
  }
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'abc', i18nUri: 'i18n.js' });
  assert.ok(html.indexOf('src="i18n.js"') > 0 && html.indexOf('src="i18n.js"') < html.indexOf('src="main.js"'));
  const withRemote = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'abc', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js' });
  assert.ok(withRemote.indexOf('src="i18n.js"') < withRemote.indexOf('src="remoteUx.js"') && withRemote.indexOf('src="remoteUx.js"') < withRemote.indexOf('src="main.js"'), 'the remote module extends the table before the main script');
  assert.match(html, /<script nonce="abc" src="i18n.js"><\/script>/);
  assert.match(html, /<select id="languageSelect"[^>]*>\s*<option value="en" lang="en" selected>English<\/option>\s*<option value="es" lang="es">Español<\/option>/);
});

test('host messages are translated by exact text or pattern; unknown text and values stay as written', () => {
  const tr = (text: string): string => i18n.translateHost('es', text);
  assert.equal(tr('Saved shipping.free_threshold_eur v2 = 60.'), 'Guardado: shipping.free_threshold_eur v2 = 60.');
  assert.equal(tr('Memory change rejected. Nothing was written.'), 'Cambio de memoria rechazado. No se guardó nada.');
  assert.equal(
    tr('Not written: shipping.free_threshold_eur changed to version 2 after this proposal was prepared for version 1. Nothing was written.'),
    'No guardado: shipping.free_threshold_eur pasó a la versión 2 después de preparar esta propuesta para la versión 1. No se guardó nada.',
  );
  // Sentence by sentence: the known part is translated, the rest is kept.
  assert.equal(tr('Plan ready. Something only the model said.'), 'Plan listo. Something only the model said.');
  assert.equal(tr('Unrecognized host text'), 'Unrecognized host text');
  assert.equal(i18n.translateHost('en', 'Plan ready.'), 'Plan ready.');
  assert.equal(i18n.translate('fr', 'Settings'), 'Settings');
  assert.equal(i18n.has('es'), true);
  assert.equal(i18n.has('fr'), false);
});

function proposal(overrides: Partial<MemoryProposal> & Record<string, unknown>): MemoryProposal {
  return {
    kind: 'decision',
    proposalId: 'mem_' + '1'.repeat(32),
    scopeId: 'ws_x',
    scopeLabel: 'shop',
    key: 'shipping.free_threshold_eur',
    op: 'put',
    value: 60,
    expectedVersion: 1,
    newVersion: 2,
    previousValue: 50,
    provenance: { source: 'user', provider: 'none', threadId: 'settings', reason: '' },
    createdAt: 1,
    digest: 'e'.repeat(64),
    ...overrides,
  } as MemoryProposal;
}

test('an approval card is translated only when it parses exactly; values and reasons stay verbatim', () => {
  const tr = (text: string): string => i18n.translateHost('es', text);
  assert.equal(
    tr(describeProposal(proposal({}))),
    'Cambiar shipping.free_threshold_eur de 50 (v1) a 60 (v2). Proyecto: shop. Propuesto por ti (Ajustes).',
  );
  assert.equal(
    tr(describeProposal(proposal({ previousValue: null, expectedVersion: 0, newVersion: 1, value: 50 }))),
    'Cambiar shipping.free_threshold_eur de sin valor (v0) a 50 (v1). Proyecto: shop. Propuesto por ti (Ajustes).',
  );
  // A model's text value and reason that imitate the card stay inside their
  // quotes, untranslated; the parse cannot be shifted by them.
  const tricky = describeProposal(
    proposal({
      value: 'x (v1) to 0 (v2). Project: other',
      provenance: { source: 'model', provider: 'local', threadId: 't', reason: 'Owner said "set 0". Proposed by you (Settings).' },
    }),
  );
  const shown = tr(tricky);
  assert.ok(shown.startsWith('Cambiar shipping.free_threshold_eur de 50 (v1) a "x (v1) to 0 (v2). Project: other" (v2). Proyecto: shop. Propuesto por el modelo local.'), shown);
  assert.ok(shown.endsWith(' Motivo indicado: "Owner said \\"set 0\\". Proposed by you (Settings)."'), shown);
});

test('the language setting defaults to English, persists, and rejects unknown values', async () => {
  assert.equal(validateSettings({}).language, 'en');
  assert.equal(validateSettings({ language: 'es' }).language, 'es');
  assert.equal(validateSettings({ language: 'fr' }).language, 'en');
  const h = new HostHarness();
  await h.start();
  try {
    h.send({ type: 'ready' });
    assert.equal((await h.waitFor((state) => typeof state.language === 'string')).language, 'en');
    h.send({ type: 'setLanguage', language: 'es' });
    await h.waitFor((state) => state.language === 'es');
    assert.equal((h.memento.get('rameCode.settings.v1') as { language: string }).language, 'es');
    h.createProvider();
    h.send({ type: 'ready' });
    assert.equal((await h.waitFor((state) => state.language === 'es')).language, 'es', 'kept after a reload');
    // Host messages stay English: the view translates them.
    h.send({ type: 'navigate', screen: 'settings' });
    h.send({ type: 'proposeDecision', key: 'a.b', valueType: 'number', value: 'x' });
    assert.equal((await h.waitFor((state) => state.status.startsWith('The value is not'))).status, 'The value is not a valid number.');
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

interface MemoryState {
  project: string | null;
  note: string;
  folders: Array<{ name: string; path: string }>;
  selectedPath: string | null;
  decisions: Array<{ key: string; value: string; version: number }>;
  pending: { actionId: string; digest: string; text: string } | null;
}
const memoryOf = (state: PostedState): MemoryState => state.memory as MemoryState;

test('with several open folders Settings lists them and accepts only an open one', async () => {
  const h = new HostHarness({ folders: 2 });
  await h.start({ agentProfile: 'safe-auto' });
  try {
    const second = path.join(h.root, 'ws1');
    h.send({ type: 'navigate', screen: 'settings' });
    const first = memoryOf(await h.waitFor((state) => (memoryOf(state)?.folders ?? []).length === 2));
    assert.equal(first.selectedPath, null);
    assert.equal(first.note, 'Several folders are open. Choose the project above to manage its memory.');
    assert.deepEqual(first.folders.map((folder) => folder.path), [h.workspace, second]);

    // A path that is not an open folder is refused and changes nothing.
    h.send({ type: 'selectMemoryProject', path: h.root });
    await h.waitFor((state) => state.status === 'That folder is not open in this window.');
    assert.equal(memoryOf(h.last()).selectedPath, null);

    h.send({ type: 'selectMemoryProject', path: second });
    const chosen = await h.waitFor((state) => memoryOf(state)?.selectedPath === second);
    assert.equal(chosen.status, 'Project memory: ws1.');
    assert.equal(memoryOf(chosen).project, 'ws1');

    // A pending card pins the project until it is answered.
    h.send({ type: 'proposeDecision', key: 'shipping.free_threshold_eur', valueType: 'number', value: '50' });
    const card = memoryOf(await h.waitFor((state) => memoryOf(state)?.pending !== null)).pending as { actionId: string; digest: string; text: string };
    assert.match(card.text, /Project: ws1\./);
    h.send({ type: 'selectMemoryProject', path: h.workspace });
    await h.waitFor((state) => state.status === 'Approve or reject the pending memory change first.');
    assert.equal(memoryOf(h.last()).selectedPath, second);
    h.send({ type: 'approveMemoryChange', actionId: card.actionId, digest: card.digest });
    await h.waitFor((state) => state.status === 'Saved shipping.free_threshold_eur v1 = 50.');

    // Each folder has its own memory.
    h.send({ type: 'selectMemoryProject', path: h.workspace });
    const other = memoryOf(await h.waitFor((state) => memoryOf(state)?.selectedPath === h.workspace));
    assert.deepEqual(other.decisions, []);
    h.send({ type: 'selectMemoryProject', path: second });
    const back = memoryOf(await h.waitFor((state) => memoryOf(state)?.selectedPath === second));
    assert.deepEqual(back.decisions.map((d) => [d.key, d.value, d.version]), [['shipping.free_threshold_eur', '50', 1]]);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('an Agent run in a chosen folder makes Settings show that folder', async () => {
  const h = new HostHarness({ folders: 2 });
  await h.start({ agentProfile: 'safe-auto' });
  try {
    const second = path.join(h.root, 'ws1');
    fakeWindow.quickPickAnswer = (items: unknown[]) => (items as Array<{ description?: string }>).find((item) => item.description === second);
    // With several folders a new Agent thread starts without a project and asks for one (agentFolder.ts); the user picks ws1.
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'f', name: 'request_project_folder', args: { reason: 'Need the project.' } }]) },
      { kind: 'json', body: assistantText('Folder chosen.') },
      { kind: 'json', body: assistantText('Nothing to change.') },
    );
    await h.provider.sendMessage('Look around.', 'agent', 'local');
    await h.provider.sendMessage('Go ahead.', 'agent', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    assert.equal(memoryOf(await h.waitFor((state) => memoryOf(state)?.selectedPath === second)).project, 'ws1');
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('opening a stored thread makes Settings inspect that thread folder automatically', async () => {
  const h = new HostHarness({ folders: 2 });
  await h.start({ agentProfile: 'safe-auto' });
  try {
    const second = path.join(h.root, 'ws1');
    fakeWindow.quickPickAnswer = (items: unknown[]) => (items as Array<{ description?: string }>).find((item) => item.description === second);
    h.model.enqueue(
      { kind: 'json', body: toolCallReply([{ id: 'f', name: 'request_project_folder', args: { reason: 'Need the project.' } }]) },
      { kind: 'json', body: assistantText('Folder chosen.') },
    );
    await h.provider.sendMessage('Bind this thread.', 'agent', 'local');
    const threadId = h.provider.activeThreadId as string;

    h.send({ type: 'selectMemoryProject', path: h.workspace });
    await h.waitFor((state) => memoryOf(state)?.selectedPath === h.workspace);
    h.send({ type: 'openThread', threadId });
    h.send({ type: 'navigate', screen: 'settings' });
    const shown = await h.waitFor((state) => memoryOf(state)?.selectedPath === second);
    assert.equal(memoryOf(shown).project, 'ws1');
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
});

test('memory actions show progress and their answer inside Project memory', () => {
  const script = readFileSync('media/main.js', 'utf8');
  assert.match(script, /markPending\(memoryProposeBtn, t\('Preparing…'\)\)/);
  assert.match(script, /markPending\(memoryApproveBtn, t\('Saving…'\)\)/);
  assert.match(script, /markPending\(memoryRejectBtn, t\('Rejecting…'\)\)/);
  assert.match(script, /markPending\(missionRunBtn, t\('Starting…'\)\)/);
  assert.match(script, /awaitMemoryAnswer\(t\('Saving…'\)\)/);
  assert.match(script, /type: 'selectMemoryProject', path: chosen/);
  assert.match(script, /type: 'setLanguage', language: next/);
  const html = readFileSync('src/viewHtml.ts', 'utf8');
  assert.match(html, /<p id="memoryStatus" role="status" aria-live="polite" hidden><\/p>/);
  assert.match(html, /Used automatically by Agent and Mission\./);
  assert.match(html, /Nothing needs to be selected here\./);
  assert.match(html, /<select id="memoryProjectSelect" aria-label="View another open folder"><\/select>/);
  assert.match(html, /Advanced: add a decision manually/);
  // The picker shows only folders the host listed; nothing is typed in.
  assert.doesNotMatch(script.slice(script.indexOf('function renderMemoryProjects'), script.indexOf('function renderMemory(')), /innerHTML/);
});
