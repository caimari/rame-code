import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildViewHtml, createViewNonce } from '../src/viewHtml.js';

function document(): string {
  return buildViewHtml({
    cspSource: 'vscode-webview://test',
    scriptUri: 'vscode-webview://test/main.js',
    styleUri: 'vscode-webview://test/main.css',
    nonce: 'test-nonce-123',
  });
}

test('unified document is one view with internal navigation hooks', () => {
  const html = document();
  assert.match(html, /<title>RAME Code<\/title>/);
  assert.ok(html.includes('id="chatScreen"'));
  assert.ok(html.includes('id="settingsScreen"'));
  assert.ok(html.includes('id="backToChat"'));
  assert.ok(html.includes('id="openSettings"'));
  // Exactly one provider-level runtime selector lives in Settings; Chat
  // shows read-only text. The cloud model is a subordinate cloud-only
  // choice, never a second provider selector.
  const runtimeSelectCount = (html.match(/id="runtimeSelect"/g) ?? []).length;
  assert.equal(runtimeSelectCount, 1);
  assert.ok(html.includes('Meta Model API — Cloud'));
  assert.ok(html.includes('Muse Glimmer — Local'));
  assert.ok(html.includes('value="cloud"'));
  assert.ok(html.includes('value="local"'));
  assert.ok(!html.includes('value="cloud:muse-spark-1.3"'));
  assert.ok(!html.includes('value="local:local-glimmer"'));
  // Main Chat controls: one Mode selector, read-only runtime status, no
  // independent Provider/Model selectors (mismatched pairs unrepresentable).
  for (const id of [
    'newThread',
    'refresh',
    'openSettings',
    'backToChat',
    'threadList',
    'transcript',
    'composer',
    'modeSelect',
    'runtimeStatus',
    'runtimeSelect',
    'send',
    'cancel',
    'status',
    'usage',
    'escalationBox',
    'escalateApprove',
    'escalateDismiss',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(!html.includes('id="providerSelect"'), 'providerSelect must be gone');
  assert.ok(!html.includes('id="modelSelect"'), 'modelSelect must be gone');
  // Settings sections: Cloud, Local runtime, Escalation, Privacy,
  // Diagnostics. Conditional sections carry ids so the webview can hide the
  // entire Local section in Cloud mode and the entire Cloud/key section in
  // Local mode. The catalog is a subordinate cloud-only choice.
  for (const id of [
    'apiKey',
    'saveKey',
    'clearKey',
    'testMetaConnection',
    'cloudSection',
    'localSection',
    'escalationSection',
    'cloudModelSelect',
    'refreshModels',
    'catalogStatus',
    'exePath',
    'modelPath',
    'projectorPath',
    'draftPath',
    'localModelId',
    'contextSize',
    'localPort',
    'idleTimeout',
    'externalEndpoint',
    'useSuggestions',
    'saveLocal',
    'startLocal',
    'stopLocal',
    'selectExternal',
    'clearExternal',
    'allowEscalation',
    'diagnostics',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes('Available compatible Meta models'));
  assert.ok(html.includes('Idle timeout (minutes, 0 disables)'));
  assert.match(html, /id="idleTimeout"[^>]*max="1440"[^>]*step="1"[^>]*value="15"/);
  assert.ok(html.includes('Closing a terminal does not stop it.'));
});

test('unified document keeps strict CSP and local assets only', () => {
  const html = document();
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-test-nonce-123'/);
  assert.match(html, /style-src vscode-webview:\/\/test 'nonce-test-nonce-123'/);
  // No remote fetching: connect is closed and images/fonts cannot load remote.
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /img-src vscode-webview:\/\/test data:/);
  assert.match(html, /font-src 'none'/);
  // Executable / resource-bearing attributes must never carry a remote URL.
  // The inert loopback placeholder below is intentionally allowed.
  assert.doesNotMatch(html, /\ssrc\s*=\s*["']https?:\/\//i);
  assert.doesNotMatch(html, /\shref\s*=\s*["']https?:\/\//i);
  assert.doesNotMatch(html, /\saction\s*=\s*["']https?:\/\//i);
  assert.doesNotMatch(html, /\sformaction\s*=\s*["']https?:\/\//i);
  assert.doesNotMatch(html, /\ssrcset\s*=\s*["']https?:\/\//i);
  assert.doesNotMatch(html, /\sposter\s*=\s*["']https?:\/\//i);
  assert.doesNotMatch(html, /\sdata\s*=\s*["']https?:\/\//i);
  // The CSP itself must not allow remote sources.
  const csp = html.match(/Content-Security-Policy" content="([^"]*)"/)?.[1] ?? '';
  assert.ok(!csp.includes('http://') && !csp.includes('https://'));
  // Inert loopback placeholder text is allowed (not a fetchable resource).
  assert.ok(html.includes('placeholder="http://127.0.0.1:8775"'));
  const withoutPlaceholders = html.replace(/\splaceholder\s*=\s*"[^"]*"/g, '');
  assert.ok(!withoutPlaceholders.includes('http://'));
  assert.ok(!withoutPlaceholders.includes('https://'));
  assert.doesNotMatch(html, /innerHTML/);
  assert.doesNotMatch(html, /currentColor/);
  assert.ok(!html.includes('apiKey') || html.includes('id="apiKey"'));
  assert.equal(createViewNonce().length > 0, true);
});

test('optional composer UX module loads locally before the main view script', () => {
  const html = buildViewHtml({
    cspSource: 'vscode-webview://test',
    scriptUri: 'main.js',
    styleUri: 'main.css',
    composerUxUri: 'composerUx.js',
    nonce: 'n',
  });
  assert.ok(html.indexOf('src="composerUx.js"') > 0);
  assert.ok(html.indexOf('src="composerUx.js"') < html.indexOf('src="main.js"'));
});

test('chat header is compact with icon buttons and stays visible at 220px', () => {
  const html = document();
  // Title plus three compact icon buttons with accessible names.
  // The public version sits inside the title, filled by the host (never hard-coded).
  assert.match(html, /<h2 class="view-title">RAME Code <span id="versionBadge" class="version-chip" title="Public version"><\/span><\/h2>/);
  assert.match(html, /id="newThread"[^>]*aria-label="New thread"/);
  assert.match(html, /id="refresh"[^>]*aria-label="Refresh history"/);
  assert.match(html, /id="openSettings"[^>]*aria-label="Open Settings"/);
  // Recognizable gear for Settings (Unicode, no remote assets).
  assert.match(html, /id="openSettings"[^>]*title="Open Settings"/);
  assert.match(html, /<button[^>]*id="openSettings"[^>]*>&#x2699;<\/button>/);
  // Long text labels must not crowd a narrow sidebar header buttons.
  assert.ok(!html.includes('>New thread</button>'));
  assert.ok(!html.includes('>Refresh</button>'));
  assert.ok(!html.includes('>Settings</button>'));
  // Header stays visible; the row itself cannot clip controls, while the
  // title alone ellipsizes horizontally in a narrow sidebar.
  assert.match(html, /\.view-header\s*\{[^}]*position:\s*sticky/);
  assert.match(html, /\.view-header\s*\{[^}]*overflow:\s*visible/);
  assert.match(html, /\.view-header \.view-title\s*\{[^}]*overflow:\s*hidden/);
  assert.match(html, /button\.icon-btn/);
  assert.match(html, /@media\s*\(max-width:\s*260px\)/);
});

test('settings is a separate screen with a prominent back button', () => {
  const html = document();
  assert.ok(html.includes('id="chatScreen"'));
  assert.ok(html.includes('id="settingsScreen"'));
  assert.match(html, /id="settingsScreen"[^>]*hidden/);
  assert.match(html, /id="backToChat"[^>]*aria-label="Back to Chat"/);
  assert.match(html, /id="backToChat"[^>]*Back/);
  assert.match(html, /id="openSettings"[^>]*aria-label="Open Settings"/);
  // Sections toggle via [hidden]; no stacked Chat+Settings presentation.
  assert.match(html, /\.screen\[hidden\]\s*\{\s*display:\s*none/);
});

test('a long approval remains reachable without trapping the whole card or creating horizontal scroll', () => {
  const html = document();
  const css = readFileSync('media/main.css', 'utf8');
  for (const source of [html, css]) {
    assert.match(source, /#agentBox\s*\{[^}]*position:\s*relative/);
    assert.doesNotMatch(source, /#agentBox\s*\{[^}]*position:\s*sticky/);
    assert.match(source, /#agentBox\s*\{[^}]*max-width:\s*100%/);
    assert.match(source, /#agentBox\s*\{[^}]*overflow:\s*hidden/);
    assert.match(source, /#pendingBody\s*\{[^}]*max-height:\s*min\(42vh,\s*320px\)/);
    assert.match(source, /#pendingBody\s*\{[^}]*overflow-y:\s*auto/);
    assert.match(source, /#pendingBody\s*\{[^}]*overflow-x:\s*hidden/);
    assert.match(source, /#pendingBody\s*\{[^}]*overflow-wrap:\s*anywhere/);
  }
});

test('composer keeps mode, collapses agent boundaries, warns on workspace-full', () => {
  const html = document();
  assert.ok(html.includes('id="modeSelect"'));
  assert.ok(html.includes('id="agentSection"'));
  assert.ok(html.includes('id="profileSelect"'));
  assert.ok(html.includes('id="profileDesc"'));
  // Legacy duplicate block stays hidden/internal: the visible permission UI
  // is permissionBtn/permissionMenu only. Host authority and validation stay
  // via the hidden internal select.
  assert.match(html, /id="agentSection"[^>]*hidden/);
  assert.match(html, /id="agentSection"[^>]*aria-hidden="true"/);
  assert.match(html, /id="profileSelect"[^>]*hidden/);
  assert.match(html, /id="profileDesc"[^>]*hidden/);
  assert.match(html, /id="agentBoundariesDetails"[^>]*hidden/);
  // Boundaries text is retained hidden for host/script behavior; the
  // user-visible risk lives in the permission menu plus a compact composer
  // warning, without a second technical form.
  assert.match(html, /<details[^>]*>[\s\S]*Security \/ boundaries[\s\S]*<\/details>/);
  assert.ok(html.includes('id="agentBoundaries"'));
  assert.match(html, /id="agentWarning"[^>]*role="alert"/);
  assert.match(html, /id="agentWarning"[^>]*hidden/);
  assert.match(html, /Workspace-full is high risk/);
  assert.match(html, /id="permissionWarning"[^>]*role="alert"/);
  assert.match(html, /id="permissionWarning"[^>]*hidden/);
  assert.ok(html.includes('Workspace full — high risk: reads, patches, and allowlisted tests run without prompts.'));
  // Exactly one of each control id: no duplicate visible permission or
  // runtime/model controls.
  for (const id of ['permissionBtn', 'runtimeStatus', 'profileSelect', 'status', 'usage', 'actionLog']) {
    const count = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
    assert.equal(count, 1, `duplicate #${id}`);
  }
});

test('runtime lives once inside the composer and opens Settings', () => {
  const html = document();
  // Single runtimeStatus button structurally inside the composer card/toolbar
  // so it is visible on both home and conversation screens.
  const cardAt = html.indexOf('id="composerCard"');
  const toolbarAt = html.indexOf('id="composerToolbar"');
  const runtimeAt = html.indexOf('id="runtimeStatus"');
  const composerWrapAt = html.indexOf('id="composer-wrap"');
  assert.ok(cardAt >= 0 && toolbarAt > cardAt && runtimeAt > toolbarAt);
  assert.ok(runtimeAt < html.indexOf('id="permissionMenu"', toolbarAt));
  assert.ok(composerWrapAt >= 0 && runtimeAt > composerWrapAt);
  // Not in the conversation-only transcript metadata: it must not sit
  // between composerMeta and the transcript.
  const metaAt = html.indexOf('id="composerMeta"');
  const transcriptAt = html.indexOf('id="transcript"');
  assert.ok(metaAt >= 0 && transcriptAt > metaAt);
  assert.ok(!(runtimeAt > metaAt && runtimeAt < transcriptAt), 'runtimeStatus must not live in composerMeta');
  assert.match(html, /id="runtimeStatus"[^>]*class="chip"/);
  assert.match(html, /id="runtimeStatus"[^>]*title="Open Settings to change runtime"/);
  const runtimeCount = (html.match(/id="runtimeStatus"/g) ?? []).length;
  assert.equal(runtimeCount, 1);
});

test('technical audit/status/usage collapse into conversation-scoped Run details', () => {
  const html = document();
  assert.ok(html.includes('id="runDetails"'));
  assert.match(html, /<details[^>]*id="runDetails"[^>]*>/);
  // Collapsed by default: no open attribute on runDetails.
  const runTag = html.match(/<details[^>]*id="runDetails"[^>]*>/)?.[0] ?? '';
  assert.ok(!/\bopen\b/.test(runTag), 'Run details must start collapsed');
  assert.match(html, /<summary>Run details<\/summary>/);
  // Legacy ids retained inside the disclosure for host/script behavior.
  for (const id of ['runtimeState', 'status', 'usage', 'actionLogBox', 'actionLog']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id} inside Run details`);
  }
  const runAt = html.indexOf('id="runDetails"');
  for (const id of ['status', 'usage', 'actionLogBox']) {
    assert.ok(html.indexOf(`id="${id}"`) > runAt, `#${id} must live inside Run details`);
  }
  // Scoped to conversation: inside conversationSection, outside home and footer composer card.
  const convAt = html.indexOf('id="conversationSection"');
  const homeAt = html.indexOf('id="homeSection"');
  const cardAt = html.indexOf('id="composerCard"');
  assert.ok(convAt >= 0 && runAt > convAt);
  assert.ok(runAt < html.indexOf('id="composer-wrap"') || html.indexOf('id="composer-wrap"') < convAt);
  void homeAt;
  void cardAt;
  // Home screen stays calm: no loose action log or status blocks outside conversation.
  const homeSlice = html.slice(html.indexOf('id="homeSection"'), html.indexOf('id="conversationSection"'));
  assert.ok(!homeSlice.includes('id="actionLogBox"'));
  assert.ok(!homeSlice.includes('id="runDetails"'));
  assert.ok(!homeSlice.includes('id="status"'));
});

test('settings local buttons are ordered with obvious runtime state', () => {
  const html = document();
  const useAt = html.indexOf('id="useSuggestions"');
  const saveAt = html.indexOf('id="saveLocal"');
  const startAt = html.indexOf('id="startLocal"');
  const stopAt = html.indexOf('id="stopLocal"');
  assert.ok(useAt >= 0 && saveAt > useAt && startAt > saveAt && stopAt > startAt);
  assert.match(html, /id="useSuggestions"[^>]*>Use detected settings</);
  assert.match(html, /id="saveLocal"[^>]*>Save</);
  assert.match(html, /id="startLocal"[^>]*>Start Muse Glimmer</);
  assert.match(html, /id="localStatus"[^>]*role="status"/);
});
