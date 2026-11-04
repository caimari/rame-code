/**
 * Settings → Models chooses which Glimmer the local runtime uses (RAME's own
 * llama-server, or a server the user runs: Ollama, LM Studio, llama-server),
 * apart from the Meta Model API; Settings → Runtime then shows only the
 * settings of that source, and the header says "Use: <model>". Every settings
 * button answers a click: a spinner until the host replies, then a check mark
 * or "!" (human validation: buttons "did nothing" visibly).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { buildViewHtml } from '../src/viewHtml.js';

type Node = {
  id: string; tagName: string; parent: Node | null; hidden: boolean; disabled: boolean; checked: boolean; textContent: string; value: string;
  classes: Set<string>; attributes: Record<string, string>; listeners: Record<string, Array<(event: unknown) => void>>;
};

function fakeDom(tree: Record<string, { tag?: string; parent?: string }>) {
  const nodes: Record<string, Node> = {};
  const make = (id: string, tag = 'DIV'): Node => {
    const node: Node = { id, tagName: tag, parent: null, hidden: false, disabled: false, checked: false, textContent: '', value: '', classes: new Set(), attributes: {}, listeners: {} };
    Object.assign(node, { options: [], selectedIndex: -1, firstChild: null, style: {}, appendChild() {}, removeChild() {}, querySelector: () => null, querySelectorAll: () => [] });
    return Object.assign(node, {
      classList: { add: (...names: string[]) => names.forEach((n) => node.classes.add(n)), remove: (...names: string[]) => names.forEach((n) => node.classes.delete(n)), contains: (n: string) => node.classes.has(n) },
      setAttribute(name: string, value: string) { node.attributes[name] = value; },
      getAttribute(name: string) { return node.attributes[name] ?? null; },
      hasAttribute(name: string) { return name in node.attributes; },
      removeAttribute(name: string) { delete node.attributes[name]; },
      addEventListener(type: string, listener: (event: unknown) => void) { (node.listeners[type] ??= []).push(listener); },
      closest(selector: string) {
        const ids = selector.split(',').map((part) => part.trim());
        let at: Node | null = node;
        while (at) {
          if (ids.includes(`#${at.id}`) || (ids.includes('button') && at.tagName === 'BUTTON')) return at;
          at = at.parent;
        }
        return null;
      },
    });
  };
  for (const [id, spec] of Object.entries(tree)) nodes[id] = make(id, spec.tag);
  for (const [id, spec] of Object.entries(tree)) nodes[id].parent = spec.parent ? nodes[spec.parent] : null;
  const docListeners: Array<(event: unknown) => void> = [];
  const document = {
    getElementById: (id: string) => (nodes[id] ??= make(id)),
    createElement: (tag: string) => make('', tag.toUpperCase()),
    addEventListener: (_type: string, listener: (event: unknown) => void) => docListeners.push(listener),
    querySelectorAll: () => [],
    activeElement: null,
  };
  const click = (id: string) => {
    const target = nodes[id];
    (target.listeners.click ?? []).forEach((listener) => listener({ target }));
    docListeners.forEach((listener) => listener({ target }));
  };
  const change = (id: string) => (nodes[id].listeners.change ?? []).forEach((listener) => listener({ target: nodes[id] }));
  return { nodes, document, click, change };
}

const TREE = {
  settingsScreen: {},
  cardModels: { parent: 'settingsScreen' },
  localSourceManaged: { tag: 'INPUT', parent: 'cardModels' },
  localSourceServer: { tag: 'INPUT', parent: 'cardModels' },
  localSourceConfigure: { tag: 'BUTTON', parent: 'cardModels' },
  saveKey: { tag: 'BUTTON', parent: 'cardModels' },
  cardRuntime: { parent: 'settingsScreen' },
  localSection: { parent: 'cardRuntime' },
  saveLocal: { tag: 'BUTTON', parent: 'localSection' },
  localServersSection: { parent: 'cardRuntime' },
  serverScan: { tag: 'BUTTON', parent: 'localServersSection' },
  serverPresetLmStudio: { tag: 'BUTTON', parent: 'localServersSection' },
  serverEndpoint: { tag: 'INPUT', parent: 'localServersSection' },
  chatScreen: {},
  sendElsewhere: { tag: 'BUTTON', parent: 'chatScreen' },
};

function load(language: 'en' | 'es' = 'en') {
  const dom = fakeDom(TREE);
  const window: Record<string, unknown> = {};
  const context = { window, document: dom.document, setTimeout, clearTimeout, Date };
  vm.runInNewContext(readFileSync('media/i18n.js', 'utf8'), context);
  // The real order of the view: remoteUx.js, then localServersUx.js wrapping it.
  vm.runInNewContext(readFileSync('media/remoteUx.js', 'utf8'), context);
  vm.runInNewContext(readFileSync('media/localServersUx.js', 'utf8'), context);
  const posted: unknown[] = [];
  const i18n = window.RAME_I18N as { translate(language: string, text: string): string };
  const t = (text: string) => (language === 'en' ? text : i18n.translate('es', text));
  const tf = (text: string, ...values: unknown[]) => values.reduce<string>((out, value, index) => out.replace(`{${index}}`, String(value)), t(text));
  const remote = window.RAME_REMOTE as { init(h: unknown): void; render(data: unknown): void };
  remote.init({ vscode: { postMessage: (message: unknown) => posted.push(message) }, t, tf, tHost: t, markPending: () => true, hold() {} });
  const sent = () => JSON.parse(JSON.stringify(posted)) as Array<{ type: string }>;
  return { ...dom, render: remote.render, sent, window };
}

const SERVER_STATE = {
  status: 'Using muse-glimmer on LM Studio.',
  cloudModel: 'muse-spark-1.3',
  externalLocalEndpoint: 'http://192.168.1.158:1235',
  localSettings: { modelPath: '/models/Muse-Glimmer-Q4_K_M.gguf', modelId: 'local-glimmer' },
  remote: {
    runtime: { local: 'connected', cloud: 'connected', selected: 'local' },
    servers: { endpoint: 'http://192.168.1.158:1235', model: 'muse-glimmer', kind: 'lmstudio', lan: true, scan: null, scanError: '', web: {}, shell: {} },
  },
};
const MANAGED_STATE = {
  ...SERVER_STATE,
  status: 'Settings saved.',
  externalLocalEndpoint: '',
  remote: { ...SERVER_STATE.remote, runtime: { local: 'running', cloud: 'connected', selected: 'local' }, servers: { ...SERVER_STATE.remote.servers, endpoint: '', model: '', kind: '' } },
};

test('the markup: the local source is chosen in Models, apart from Meta; Runtime says what it configures', () => {
  const html = buildViewHtml({ cspSource: 'c', scriptUri: 'main.js', styleUri: 'main.css', nonce: 'n', i18nUri: 'i18n.js', remoteUxUri: 'remoteUx.js', localServersUxUri: 'localServersUx.js' });
  const models = html.slice(html.indexOf('id="cardModels"'), html.indexOf('id="cardRuntime"'));
  assert.match(models, /id="localSourceChoice"[^]*Local model \(Glimmer\)[^]*id="localSourceManaged" value="managed"> Muse Glimmer on this computer — RAME starts and stops llama-server[^]*id="localSourceServer" value="server"> Glimmer on a server you run — Ollama, LM Studio or llama-server[^]*id="localSourceNow"[^]*id="localSourceConfigure"/);
  assert.ok(models.indexOf('id="localSourceChoice"') < models.indexOf('id="cloudSection"'), 'chosen before, and apart from, the Meta settings');
  const runtime = html.slice(html.indexOf('id="cardRuntime"'), html.indexOf('id="cardMission"'));
  assert.ok(runtime.indexOf('id="localSourceBanner"') < runtime.indexOf('id="localSection"'));
  assert.match(runtime, /id="localSourceChange" type="button">Change in Models</);
  const css = readFileSync('media/main.css', 'utf8');
  assert.match(css, /button\.is-working::after \{[^}]*animation: rame-spin/);
  assert.match(css, /button\.is-done::after \{\s*content: " ✓";/);
  assert.match(css, /button\.is-failed::after \{\s*content: " !";/);
});

test('an external server in use: its radio is chosen, Runtime shows only the server settings, and the header says what is used', () => {
  const ui = load();
  ui.render(SERVER_STATE);
  assert.equal(ui.nodes.localSourceServer.checked, true);
  assert.equal(ui.nodes.localSourceManaged.checked, false);
  assert.equal(ui.nodes.localSection.hidden, true, "RAME's llama-server settings are hidden");
  assert.equal(ui.nodes.localServersSection.hidden, false);
  assert.equal(ui.nodes.localSourceNow.textContent, 'Use: muse-glimmer — LM Studio at http://192.168.1.158:1235');
  assert.equal(ui.nodes.localSourceBannerText.textContent, 'Configuring: Glimmer on a server you run (Ollama, LM Studio or llama-server).');
  assert.equal(ui.nodes.runtimeBadgeLocal.textContent, 'Use: muse-glimmer (LM Studio at http://192.168.1.158:1235) · connected');
});

test("RAME's llama-server in use: its radio is chosen, Runtime shows only its settings; Meta selected: the header names the Meta model", () => {
  const ui = load();
  ui.render(MANAGED_STATE);
  assert.equal(ui.nodes.localSourceManaged.checked, true);
  assert.equal(ui.nodes.localSection.hidden, false);
  assert.equal(ui.nodes.localServersSection.hidden, true);
  assert.equal(ui.nodes.localSourceNow.textContent, 'Use: Muse-Glimmer-Q4_K_M.gguf — llama-server on this computer');
  assert.equal(ui.nodes.runtimeBadgeLocal.textContent, 'Use: Muse-Glimmer-Q4_K_M.gguf (llama-server on this computer) · running');
  ui.render({ ...MANAGED_STATE, remote: { ...MANAGED_STATE.remote, runtime: { local: 'running', cloud: 'connected', selected: 'cloud' } } });
  assert.equal(ui.nodes.runtimeBadgeCloud.textContent, 'Use: muse-spark-1.3 (Meta API) · connected');
});

test('switching the source: to this computer clears the external server at once; to a server waits for "Use this model"', () => {
  const ui = load();
  ui.render(SERVER_STATE);
  ui.nodes.localSourceManaged.checked = true;
  ui.change('localSourceManaged');
  assert.deepEqual(ui.sent(), [{ type: 'clearExternalEndpoint' }]);
  assert.equal(ui.nodes.localSection.hidden, false, 'Runtime now shows the llama-server settings');
  ui.render(MANAGED_STATE);
  ui.nodes.localSourceServer.checked = true;
  ui.change('localSourceServer');
  assert.equal(ui.sent().length, 1, 'nothing is switched before a model is chosen on the server');
  assert.equal(ui.nodes.localServersSection.hidden, false);
  assert.equal(ui.nodes.localSection.hidden, true);
  assert.equal(ui.nodes.localSourceNow.textContent, 'Not in use yet: in Runtime, find the models of your server and press Use this model.');
});

test('every settings button answers: a spinner until the host replies, then a check mark, or "!" when the host reports a problem', async () => {
  const ui = load();
  ui.render(MANAGED_STATE);
  ui.click('saveLocal');
  assert.ok(ui.nodes.saveLocal.classes.has('is-working'), 'spinner at once');
  assert.equal(ui.nodes.saveLocal.attributes['aria-busy'], 'true');
  ui.render({ ...MANAGED_STATE, status: 'Local settings saved.' });
  assert.ok(ui.nodes.saveLocal.classes.has('is-working'), 'the spinner stays long enough to be seen');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(!ui.nodes.saveLocal.classes.has('is-working'));
  assert.ok(ui.nodes.saveLocal.classes.has('is-done'), 'check mark');
  ui.click('serverScan');
  ui.render({ ...MANAGED_STATE, status: 'Could not reach the model server at http://192.168.1.158:1235.' });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.ok(ui.nodes.serverScan.classes.has('is-failed'), '"!" when the host reports a problem');
  // A button that only fills a field answers at once; a button outside Settings is left alone.
  ui.click('serverPresetLmStudio');
  assert.ok(ui.nodes.serverPresetLmStudio.classes.has('is-done'));
  ui.click('sendElsewhere');
  assert.ok(!ui.nodes.sendElsewhere.classes.has('is-working'));
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.ok(!ui.nodes.saveLocal.classes.has('is-done'), 'the check mark goes away');
});

test('Spanish', () => {
  const ui = load('es');
  ui.render(SERVER_STATE);
  assert.equal(ui.nodes.localSourceNow.textContent, 'Usa: muse-glimmer — LM Studio en http://192.168.1.158:1235');
  assert.equal(ui.nodes.localSourceBannerText.textContent, 'Configurando: Glimmer en un servidor que ejecutas tú (Ollama, LM Studio o llama-server).');
  assert.equal(ui.nodes.runtimeBadgeLocal.textContent, 'Usa: muse-glimmer (LM Studio en http://192.168.1.158:1235) · conectado');
  const i18n = ui.window.RAME_I18N as { translate(language: string, text: string): string };
  assert.equal(i18n.translate('es', 'Muse Glimmer on this computer — RAME starts and stops llama-server'), 'Muse Glimmer en este ordenador — RAME arranca y para llama-server');
  assert.equal(i18n.translate('es', 'Change in Models'), 'Cambiar en Modelos');
});
