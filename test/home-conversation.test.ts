import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AGENT_PROFILES, DEFAULT_AGENT_PROFILE, isAgentProfileId, parseAgentProfile } from '../src/agentProfiles.js';
import { CHAT_MODES, DEFAULT_CHAT_MODE } from '../src/modes.js';
import { buildViewHtml } from '../src/viewHtml.js';
import {
  isLocalUnreachableMessage,
  localUnreachableMessage,
  parseViewInboundMessage,
} from '../src/viewMessages.js';

function document(): string {
  return buildViewHtml({
    cspSource: 'vscode-webview://test',
    scriptUri: 'vscode-webview://test/main.js',
    styleUri: 'vscode-webview://test/main.css',
    nonce: 'test-nonce-123',
  });
}

test('home vs conversation structure with dedicated back navigation', () => {
  const html = document();
  for (const id of [
    'homeSection',
    'recentSection',
    'threadList',
    'conversationSection',
    'conversationBar',
    'backToList',
    'threadTitle',
    'transcriptSection',
    'transcript',
    'activitySection',
    'activityList',
    'resultSection',
    'resultBody',
    'composer-wrap',
    'composerCard',
    'composerToolbar',
    'composer',
    'send',
    'cancel',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.match(html, /id="conversationSection"[^>]*hidden/);
  assert.match(html, /id="backToList"[^>]*aria-label="Back to thread list"/);
  assert.match(html, /<h2 id="threadTitle">/);
  const script = readFileSync('media/main.js', 'utf8');
  assert.match(script, /renderHomeVsConversation/);
  assert.match(script, /homeSectionEl\.hidden/);
  assert.match(script, /conversationSectionEl\.hidden/);
  assert.match(script, /threadTitleFor/);
  assert.match(script, /type:\s*['"]backToList['"]/);
  assert.match(script, /markPending\(btn, title\)/, 'opening a thread immediately shows a pending state');
  assert.match(script, /markPending\(backToListBtn, ['"]\\u2190['"]\)/, 'Back immediately shows a pending state');
  assert.match(html, /#backToList\.is-pending \{[^}]*animation: rame-back-pulse/);
  assert.match(html, /#runIndicator \{ margin: 5px 0 3px; \}/);
});

test('completed replies render as a distinct final Result after Activity', () => {
  const html = document();
  const activityAt = html.indexOf('id="activitySection"');
  const resultAt = html.indexOf('id="resultSection"');
  assert.ok(activityAt >= 0 && resultAt > activityAt, 'Result must follow Activity');
  assert.match(html, /id="resultSection"[^>]*hidden/);
  const script = readFileSync('media/main.js', 'utf8');
  assert.match(script, /function cleanAgentResult/);
  assert.match(script, /finalResultIndex/);
  assert.match(script, /renderTurns\(data\.turns, data\.running\)/);
  assert.match(script, /resultSectionEl\.hidden = false/);
  const host = readFileSync('src/mainProvider.ts', 'utf8');
  assert.match(host, /this\.agentLogView = \[\]/);
});

test('every supplied thread renders with optional honest metadata', () => {
  const script = readFileSync('media/main.js', 'utf8');
  assert.match(script, /function renderThreads/);
  assert.match(script, /threads\.forEach/);
  assert.ok(!script.includes('slice(0, 3)'), 'thread list must not slice to three');
  assert.ok(!script.includes('slice(0,3)'), 'thread list must not slice to three');
  assert.match(script, /formatThreadMeta/);
  assert.match(script, /Updated /);
  assert.match(script, /toLocaleString/);
  const stylesheet = readFileSync('media/main.css', 'utf8');
  const html = document();
  assert.match(html, /#homeSection\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(stylesheet, /#threadList\s*\{[^}]*overflow:\s*visible/);
  assert.doesNotMatch(html, /class="thread-meta"/);
  assert.match(script, /var meta = formatThreadMeta\(thread\)/);
  assert.match(script, /var metaEl = document\.createElement\('span'\)/);
  assert.match(script, /metaEl\.className = 'thread-meta'/);
  assert.match(script, /metaEl\.textContent = meta/);
  assert.match(script, /li\.appendChild\(metaEl\)/);
});

test('back-to-list uses an exact-key typed message and clears selection only', () => {
  assert.deepEqual(parseViewInboundMessage({ type: 'backToList' }), { type: 'backToList' });
  for (const raw of [
    { type: 'backToList', extra: 1 },
    { type: 'backToList', threadId: 't-1' },
    { type: 'backtolist' },
    { type: '' },
  ]) {
    assert.throws(() => parseViewInboundMessage(raw), /Invalid|Unknown/);
  }
  const host = readFileSync('src/mainProvider.ts', 'utf8');
  assert.match(host, /case 'backToList'/);
  assert.match(host, /async backToList/);
  assert.match(host, /activeThreadId = null/);
  assert.ok(!/backToList[\s\S]{0,300}?store\.(delete|clear)/.test(host), 'backToList must not delete thread data');
});

test('Agent default with Agent, Mission, Chat order is preserved', () => {
  assert.equal(DEFAULT_CHAT_MODE, 'agent');
  assert.deepEqual(
    CHAT_MODES.map((mode) => mode.id),
    ['agent', 'mission', 'chat'],
  );
  const html = document();
  const modeSelect = html.match(/<select id="modeSelect"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';
  const agentAt = modeSelect.indexOf('value="agent"');
  const missionAt = modeSelect.indexOf('value="mission"');
  const chatAt = modeSelect.indexOf('value="chat"');
  assert.ok(agentAt >= 0 && missionAt > agentAt && chatAt > missionAt);
  assert.match(html, /<option value="agent" selected title="[^"]+">Agent<\/option>/);
  const script = readFileSync('media/main.js', 'utf8');
  assert.match(script, /modeSelectEl\.value = 'agent'/);
});

test('permission popover maps exactly to ask, safe-auto, workspace-full', () => {
  assert.equal(DEFAULT_AGENT_PROFILE, 'ask');
  assert.deepEqual(
    AGENT_PROFILES.map((entry) => entry.id),
    ['ask', 'safe-auto', 'workspace-full'],
  );
  for (const id of ['ask', 'safe-auto', 'workspace-full']) {
    assert.ok(isAgentProfileId(id), `unknown profile ${id}`);
  }
  assert.equal(parseAgentProfile('bogus'), 'ask');
  const html = document();
  assert.match(html, /id="permissionBtn"[^>]*aria-haspopup="menu"/);
  assert.match(html, /id="permissionMenu"[^>]*role="menu"[^>]*hidden/);
  assert.match(html, /data-profile="ask"[^>]*aria-checked/);
  assert.match(html, /data-profile="safe-auto"/);
  assert.match(html, /data-profile="workspace-full"/);
  assert.ok(html.includes('>Ask — every tool action needs approval.</button>'));
  assert.ok(html.includes('Safe auto — reads run automatically; writes and tests need approval.'));
  assert.ok(html.includes('Workspace full — high risk:'));
  // Legacy shield select stays only as a hidden internal sync control for
  // host authority/profile validation; it is never a second visible control.
  assert.ok(html.includes('id="profileSelect"'), 'legacy shield select stays for host authority');
  assert.match(html, /id="profileSelect"[^>]*hidden/);
  assert.match(html, /id="agentSection"[^>]*hidden/);
  assert.match(html, /id="agentSection"[^>]*aria-hidden="true"/);
  assert.match(html, /id="permissionWarning"[^>]*hidden/);
  assert.equal((html.match(/id="permissionBtn"/g) ?? []).length, 1);
  const script = readFileSync('media/main.js', 'utf8');
  assert.match(script, /selectProfile/);
  assert.match(script, /type:\s*['"]setAgentProfile['"]/);
  assert.match(script, /data-profile/);
  assert.match(script, /agentSectionEl\.hidden = true/);
  assert.match(script, /permissionWarningEl\.hidden/);
});

test('coherent composer shows one permission and one runtime control; details stay collapsed', () => {
  const html = document();
  // Exactly one visible permission control (permissionBtn) and one visible
  // runtime/model control (runtimeStatus); legacy select is hidden/internal.
  assert.equal((html.match(/id="permissionBtn"/g) ?? []).length, 1);
  assert.equal((html.match(/id="runtimeStatus"/g) ?? []).length, 1);
  assert.equal((html.match(/id="profileSelect"/g) ?? []).length, 1);
  assert.match(html, /id="profileSelect"[^>]*hidden/);
  // Runtime button is structurally inside the shared composer so both home
  // (new-thread) and conversation screens show it.
  const toolbarAt = html.indexOf('id="composerToolbar"');
  const runtimeAt = html.indexOf('id="runtimeStatus"');
  const wrapAt = html.indexOf('id="composer-wrap"');
  const homeAt = html.indexOf('id="homeSection"');
  const convAt = html.indexOf('id="conversationSection"');
  assert.ok(toolbarAt >= 0 && runtimeAt > toolbarAt && wrapAt < toolbarAt);
  assert.ok(homeAt >= 0 && convAt > homeAt && wrapAt > convAt);
  // Conversation shows messages + Activity + composer; technical details are
  // collapsed inside conversation and absent from home.
  for (const id of ['transcript', 'activityList', 'composerCard', 'runDetails', 'agentBox']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  const runAt = html.indexOf('id="runDetails"');
  const runTag = html.match(/<details[^>]*id="runDetails"[^>]*>/)?.[0] ?? '';
  assert.ok(!/\bopen\b/.test(runTag), 'Run details must start collapsed');
  assert.ok(runAt > convAt && runAt < wrapAt);
  assert.ok(html.indexOf('id="actionLogBox"') > runAt);
  assert.ok(html.indexOf('id="agentBox"') > convAt && html.indexOf('id="agentBox"') < wrapAt);
  const homeSlice = html.slice(homeAt, convAt);
  assert.ok(!homeSlice.includes('id="actionLogBox"'));
  assert.ok(!homeSlice.includes('id="runDetails"'));
  // No duplicate visible action log or profile form outside the collapsed disclosure.
  const looseLogs = (html.match(/id="actionLogBox"/g) ?? []).length;
  assert.equal(looseLogs, 1);
});

test('unreachable local endpoint shows an actionable message with Settings action', () => {
  assert.equal(
    localUnreachableMessage('http://127.0.0.1:8775'),
    'Local model is not reachable at http://127.0.0.1:8775. Start it in Settings.',
  );
  assert.equal(
    localUnreachableMessage('https://example.com:1'),
    'Local model is not reachable at http://127.0.0.1:8775. Start it in Settings.',
  );
  assert.ok(isLocalUnreachableMessage(localUnreachableMessage('http://127.0.0.1:8775')));
  assert.ok(!isLocalUnreachableMessage('Request failed.'));
  assert.ok(!localUnreachableMessage('http://127.0.0.1:8775').includes('fetch'));
  assert.ok(!localUnreachableMessage('http://127.0.0.1:8775').includes('Error:'));
  const script = readFileSync('media/main.js', 'utf8');
  assert.match(script, /Local model is not reachable at /);
  assert.match(script, /Open Settings/);
  assert.match(script, /type:\s*['"]navigate['"]/);
  const host = readFileSync('src/generationController.ts', 'utf8');
  assert.match(host, /localUnreachableMessage/);
  assert.match(host, /looksUnreachable/);
  assert.ok(!host.includes("appendErrorTurn(current, 'Request failed.')"), 'generic failure must carry actionable detail');
});

test('async actions show pending state and only confirm after host state', () => {
  const script = readFileSync('media/main.js', 'utf8');
  for (const label of [
    'Saving…',
    'Starting…',
    'Stopping…',
    'Loading models…',
    'Running…',
    'Approving…',
    'Rejecting…',
  ]) {
    assert.ok(script.includes(label), `missing pending label ${label}`);
  }
  assert.match(script, /markPending/);
  assert.match(script, /restorePendingButtons/);
  assert.match(script, /is-pending/);
  assert.match(script, /disabled/);
  assert.match(script, /cancelBtn\.hidden = !running/);
  assert.match(script, /sendBtn\.hidden = running/);
  const html = document();
  assert.match(html, /id="cancel"[^>]*title="Stop current run"[^>]*aria-label="Stop current run"[^>]*hidden>&#x25A0;<\/button>/);
  assert.doesNotMatch(html, /id="cancel"[^>]*>Cancel<\/button>/);
  assert.match(html, /#send, #cancel\s*\{[^}]*grid-column:\s*5/);
});

test('consecutive Agent approvals re-enable both one-use action controls', () => {
  const script = readFileSync('media/main.js', 'utf8');
  const restore = script.match(
    /function restorePendingButtons\(\) \{([\s\S]*?)\n  \}/,
  )?.[1] ?? '';
  assert.match(restore, /btn\.disabled = false/);
  assert.match(restore, /btn\.dataset\.origLabel = ''/);
  assert.match(script, /markPending\(pendingApproveBtn, t\('Approving…'\)\)/);
  assert.match(script, /markPending\(pendingRejectBtn, t\('Rejecting…'\)\)/);
});

test('Stop control cannot remain visually stuck after the host reports stopped', () => {
  const script = readFileSync('media/main.js', 'utf8');
  assert.match(script, /stopLocalBtn\.textContent = t\('Stop'\)/);
  assert.match(script, /stopLocalBtn\.disabled = !localOwned/);
  assert.match(script, /localLifecycle !== 'running'/);
  const html = document();
  assert.match(html, /#stopLocal\s*\{[^}]*vscode-errorForeground/);
  assert.match(html, /#stopLocal:not\(:disabled\):hover/);
});

test('unified composer is rounded, narrow-safe, keyboard accessible, strict CSP', () => {
  const html = document();
  assert.match(html, /#composerCard\s*\{[^}]*border-radius:\s*12px/);
  assert.match(html, /#composerToolbar\s*\{[^}]*display:\s*grid/);
  assert.match(html, /grid-template-columns:/);
  assert.match(html, /#send,\s*#cancel\s*\{[^}]*border-radius:\s*50%/);
  assert.match(html, /@media\s*\(max-width:\s*500px\)/);
  assert.match(html, /overflow-x:\s*hidden/);
  assert.match(html, /id="attachBtn"[^>]*disabled/);
  assert.match(html, /Add context \(coming later\)/);
  assert.ok(!html.includes('microphone') && !html.includes('id="mic"'), 'unsupported microphone must be omitted');
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /role="menu"/);
  assert.match(html, /role="menuitemradio"/);
  // Unified composer carries runtime + permission + mode + send in one toolbar.
  const toolbarAt = html.indexOf('id="composerToolbar"');
  for (const id of ['runtimeStatus', 'permissionBtn', 'modeSelect', 'send']) {
    assert.ok(html.indexOf(`id="${id}"`) > toolbarAt, `#${id} must sit in the composer toolbar`);
  }
  assert.match(html, /id="runtimeStatus"[^>]*class="chip"/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /innerHTML/);
  assert.doesNotMatch(html, /\beval\s*\(/);
  const script = readFileSync('media/main.js', 'utf8');
  assert.doesNotMatch(script, /\.innerHTML/);
  assert.doesNotMatch(script, /\[\s*['"]innerHTML['"]\s*\]/);
  assert.doesNotMatch(script, /\beval\s*\(/);
  assert.match(script, /textContent/);
  assert.match(script, /Escape/);
});

test('composer grows, Enter sends, Shift+Enter stays multiline, and scrolling respects the reader', () => {
  const script = readFileSync('media/main.js', 'utf8');
  const ux = readFileSync('media/composerUx.js', 'utf8');
  const stylesheet = readFileSync('media/main.css', 'utf8');
  assert.match(script, /RAME_COMPOSER_UX\.init\(composerEl, sendBtn, conversationSectionEl/);
  assert.match(ux, /event\.key === 'Enter' && !event\.shiftKey && !event\.isComposing/);
  assert.match(ux, /send\.click\(\)/);
  assert.match(ux, /Math\.min\(composer\.scrollHeight, maxHeight\)/);
  assert.match(ux, /following = nearEnd\(\)/);
  assert.match(ux, /if \(!following\)/);
  assert.match(ux, /MutationObserver\(followSoon\)/);
  assert.match(stylesheet, /#composer\s*\{[^}]*min-height:\s*64px[^}]*max-height:\s*180px/);
});

test('narrow header keeps title, version, status, and actions vertically visible', () => {
  const html = document();
  const stylesheet = readFileSync('media/main.css', 'utf8');
  assert.match(html, /\.view-header\s*\{[^}]*min-height:\s*36px[^}]*overflow:\s*visible/);
  assert.match(html, /\.view-header \.view-title\s*\{[^}]*margin:\s*0[^}]*line-height:\s*1\.4/);
  assert.match(stylesheet, /\.view-header\s*\{[^}]*min-height:\s*36px[^}]*overflow:\s*visible/);
  assert.match(stylesheet, /\.view-actions\s*\{[^}]*align-items:\s*center/);
});

test('settings fully hides chat and threads expose confirmed deletion', () => {
  const html = document();
  const script = readFileSync('media/main.js', 'utf8');
  const stylesheet = readFileSync('media/main.css', 'utf8');
  assert.match(html, /#chatScreen\[hidden\], #settingsScreen\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(script, /className = 'thread-delete'/);
  assert.doesNotMatch(script, /window\.confirm/);
  assert.match(script, /className = 'thread-confirm'/);
  assert.match(script, /className = 'thread-confirm-delete'/);
  assert.match(script, /className = 'thread-confirm-cancel'/);
  assert.match(script, /Delete this thread\?/);
  assert.match(script, /type:\s*'deleteThread'/);
  assert.match(script, /keyEvent\.key === 'Escape'/);
  assert.doesNotMatch(html, /Pick a thread to continue/);
  assert.match(stylesheet, /#threadList\s*\{[^}]*max-height:\s*none/);
  assert.match(stylesheet, /#threadList\s*\{[^}]*overflow:\s*visible/);
  assert.doesNotMatch(stylesheet, /button:focus\s*[,\{]/);
  assert.match(stylesheet, /button:focus-visible/);
  assert.match(html, /id="runIndicator"[^>]*role="status"[^>]*hidden/);
  assert.match(script, /Waiting for your approval/);
  assert.match(script, /data\.connection === 'verified'/);
  assert.match(script, /'Completed'/);
  assert.match(script, /Action cancelled/);
  assert.doesNotMatch(script, /Something needs attention/);
  assert.match(html, /\.thread-delete:hover[^\{]*\{[^}]*background:\s*transparent/);
});

test('stopped local runtime is blocked before creating an error thread', () => {
  const html = document();
  const script = readFileSync('media/main.js', 'utf8');
  const host = readFileSync('src/mainProvider.ts', 'utf8');
  assert.match(html, /id="runtimeNotice"[^>]*role="alert"[^>]*hidden/);
  assert.match(html, /id="runtimeNoticeSettings"/);
  assert.match(script, /currentRuntimeId\(\) === 'local' && !localReady/);
  assert.match(script, /external OpenAI-compatible loopback server/);
  const preflight = host.indexOf('// Provider preflight happens before settings or thread persistence.');
  const create = host.indexOf('thread = this.store.create(text', preflight);
  assert.ok(preflight >= 0 && create > preflight, 'local preflight must precede thread creation');
  assert.match(host, /Muse Glimmer is still starting\. Wait for Running before sending\./);
});
