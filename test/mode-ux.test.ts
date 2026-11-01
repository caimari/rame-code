import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CHAT_MODES, DEFAULT_CHAT_MODE } from '../src/modes.js';
import { DEFAULT_AGENT_PROFILE } from '../src/agentProfiles.js';
import { defaultSettings, validateSettings } from '../src/settingsStore.js';
import { buildViewHtml } from '../src/viewHtml.js';

function document(): string {
  return buildViewHtml({
    cspSource: 'vscode-webview://test',
    scriptUri: 'vscode-webview://test/main.js',
    styleUri: 'vscode-webview://test/main.css',
    nonce: 'test-nonce-123',
  });
}

test('default mode is Agent with order Agent, Mission, Chat', () => {
  assert.equal(DEFAULT_CHAT_MODE, 'agent');
  assert.deepEqual(
    CHAT_MODES.map((mode) => mode.id),
    ['agent', 'mission', 'chat'],
  );
  assert.deepEqual(
    CHAT_MODES.map((mode) => mode.label),
    ['Agent', 'Mission', 'Chat'],
  );
  assert.equal(defaultSettings().mode, 'agent');
  assert.equal(validateSettings(undefined).mode, 'agent');
  assert.equal(validateSettings({ mode: 'bogus' }).mode, 'agent');
  // Persisted valid choices stay readable; history is never rewritten here.
  assert.equal(validateSettings({ mode: 'chat' }).mode, 'chat');
  assert.equal(validateSettings({ mode: 'mission' }).mode, 'mission');
  assert.equal(validateSettings({ mode: 'agent' }).mode, 'agent');
  assert.equal(DEFAULT_AGENT_PROFILE, 'ask');
});

test('composer defaults to Agent and permission defaults to Ask', () => {
  const html = document();
  const modeSelect = html.match(/<select id="modeSelect"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';
  const agentAt = modeSelect.indexOf('value="agent"');
  const missionAt = modeSelect.indexOf('value="mission"');
  const chatAt = modeSelect.indexOf('value="chat"');
  assert.ok(agentAt >= 0 && missionAt > agentAt && chatAt > missionAt);
  assert.match(html, /<option value="agent" selected>Agent<\/option>/);
  assert.match(html, /<option value="ask" selected>Ask \(safest\)<\/option>/);
  // Legacy select stays as a hidden internal sync control; the visible
  // permission UI is the single permissionBtn/menu.
  assert.match(html, /id="profileSelect"[^>]*hidden/);
  assert.match(html, /id="agentSection"[^>]*hidden/);
  assert.match(html, /id="permissionBtn"[^>]*aria-haspopup="menu"/);
  assert.match(html, /id="permissionWarning"[^>]*hidden/);
});

test('modern layout keeps header, secondary recent, primary conversation, bottom composer', () => {
  const html = document();
  for (const id of [
    'chatScreen',
    'recentSection',
    'threadList',
    'transcriptSection',
    'transcript',
    'activitySection',
    'activityList',
    'composer-wrap',
    'composerCard',
    'composerToolbar',
    'composer',
    'composerMeta',
    'permissionChip',
    'permissionBtn',
    'permissionWarning',
    'runtimeStatus',
    'modeSelect',
    'workspaceBadge',
    'runDetails',
    'send',
    'cancel',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  const recentAt = html.indexOf('id="recentSection"');
  const transcriptAt = html.indexOf('id="transcriptSection"');
  const composerAt = html.indexOf('id="composer-wrap"');
  assert.ok(recentAt >= 0 && transcriptAt > recentAt && composerAt > transcriptAt);
  assert.match(html, /id="transcript-heading"[^>]*>Conversation/);
  assert.ok(html.includes('No thread yet. Start a new Agent thread below.'));
  // Single runtime button lives inside the composer card/toolbar so home and
  // conversation share it; it is not duplicated in transcript metadata.
  const cardAt = html.indexOf('id="composerCard"');
  const toolbarAt = html.indexOf('id="composerToolbar"');
  const runtimeAt = html.indexOf('id="runtimeStatus"');
  assert.ok(cardAt >= 0 && toolbarAt > cardAt && runtimeAt > toolbarAt);
  assert.equal((html.match(/id="runtimeStatus"/g) ?? []).length, 1);
  // Unified home composer carries runtime, permission, mode, and send.
  for (const id of ['runtimeStatus', 'permissionBtn', 'modeSelect', 'send']) {
    assert.ok(html.indexOf(`id="${id}"`) > toolbarAt, `#${id} must be in the composer toolbar`);
  }
});

test('activity and approval stay structured; security prose collapses', () => {
  const html = document();
  assert.ok(html.includes('id="scopeDetails"'));
  assert.ok(html.includes('id="scopeNotice"'));
  assert.match(html, /<details[^>]*id="scopeDetails"[^>]*>[\s\S]*Scope \/ boundaries[\s\S]*<\/details>/);
  assert.ok(html.includes('id="agentBox"'));
  assert.match(html, /id="agentBox"[^>]*role="dialog"/);
  assert.match(html, /Pending approval/);
  assert.ok(html.includes('id="pendingTool"'));
  assert.ok(html.includes('id="pendingTargets"'));
  assert.ok(html.includes('id="pendingMeta"'));
  assert.ok(html.includes('id="pendingApprove"'));
  assert.ok(html.includes('id="pendingReject"'));
  // Compact chips/status, not paragraphs, for runtime/permission/workspace.
  assert.match(html, /id="connection"[^>]*class="chip"/);
  assert.match(html, /id="runtimeStatus"[^>]*class="chip"/);
  assert.match(html, /id="workspaceBadge"[^>]*class="chip"/);
  assert.match(html, /id="permissionChip"[^>]*class="chip"/);
  assert.doesNotMatch(html, /\.innerHTML/);
  // Structured activity stays visible; legacy audit/status/usage collapse
  // into conversation-scoped Run details and never clutter home.
  assert.ok(html.includes('id="activityList"'));
  assert.ok(html.includes('id="runDetails"'));
  const runTag = html.match(/<details[^>]*id="runDetails"[^>]*>/)?.[0] ?? '';
  assert.ok(!/\bopen\b/.test(runTag), 'Run details must start collapsed');
  const convAt = html.indexOf('id="conversationSection"');
  const runAt = html.indexOf('id="runDetails"');
  assert.ok(runAt > convAt);
  assert.ok(html.indexOf('id="actionLogBox"') > runAt);
  const homeSlice = html.slice(html.indexOf('id="homeSection"'), convAt);
  assert.ok(!homeSlice.includes('id="actionLogBox"'));
  assert.ok(!homeSlice.includes('id="runDetails"'));
});

test('webview script gives async pending feedback and never claims early success', () => {
  const script = readFileSync('media/main.js', 'utf8');
  for (const label of [
    'Saving…',
    'Starting…',
    'Stopping…',
    'Loading models…',
    'Running…',
  ]) {
    assert.ok(script.includes(label), `missing pending label ${label}`);
  }
  assert.match(script, /is-pending/);
  assert.match(script, /markPending/);
  assert.match(script, /restorePendingButtons/);
  assert.match(script, /disabled/);
  // Single exact-key posts only.
  assert.match(script, /type:\s*['"]sendMessage['"]/);
  // Start is intentionally built through readLocalForm('startLocal') so the
  // posted message carries the exact type key plus the visible local settings.
  assert.match(script, /readLocalForm\(\s*['"]startLocal['"]\s*\)/);
  assert.match(script, /type:\s*type\s*\|\|\s*['"]updateLocalSettings['"]/);
  assert.match(script, /markPending\(\s*startLocalBtn\s*,\s*['"]Starting…['"]\s*\)/);
  assert.match(script, /type:\s*['"]refreshModels['"]/);
  assert.match(script, /type:\s*['"]saveKey['"]/);
  assert.match(script, /type:\s*['"]stopLocal['"]/);
  // Workspace target stays visible; approval still binds id plus digest.
  assert.match(script, /workspaceBadge/);
  assert.match(script, /activityList/);
  assert.match(script, /approveAgentAction/);
  assert.match(script, /actionId/);
  assert.match(script, /digest/);
  assert.doesNotMatch(script, /\.innerHTML/);
  // Coherent composer: legacy agentSection never unhides; the compact
  // composer warning mirrors the hidden internal workspace-full warning.
  assert.match(script, /agentSectionEl\.hidden = true/);
  assert.match(script, /permissionWarningEl/);
  assert.match(script, /permissionWarningEl\.hidden/);
  assert.match(script, /agentWarningEl\.hidden/);
});
