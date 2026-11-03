import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildViewHtml } from '../src/viewHtml.js';
import {
  AGENT_SCOPE_NOTICE,
  agentScopeNotice,
  buildViewStateMessage,
  parseViewInboundMessage,
  scopeNoticeForMode,
} from '../src/viewMessages.js';
import { EMPTY_USAGE } from '../src/usage.js';

function document(): string {
  return buildViewHtml({
    cspSource: 'vscode-webview://test',
    scriptUri: 'vscode-webview://test/main.js',
    styleUri: 'vscode-webview://test/main.css',
    nonce: 'test-nonce-123',
  });
}

function baseState() {
  return {
    screen: 'chat' as const,
    hasKey: false,
    running: false,
    status: 'Ready.',
    connection: 'ready' as const,
    provider: 'local' as const,
    mode: 'agent' as const,
    model: 'local-glimmer',
    threads: [],
    activeThreadId: null,
    turns: [],
    usageLast: { ...EMPTY_USAGE },
    usageCloud: { ...EMPTY_USAGE },
    usageLocal: { ...EMPTY_USAGE },
    local: { lifecycle: 'stopped' as const, owned: false, endpoint: null, diagnostics: '' },
    escalation: { pending: false, reason: '' },
    allowCloudEscalation: false,
    externalLocalEndpoint: '',
  };
}

test('agent protocol uses exact keys and never echoes secrets', () => {
  assert.deepEqual(parseViewInboundMessage({ type: 'setAgentProfile', profile: 'ask' }), {
    type: 'setAgentProfile',
    profile: 'ask',
  });
  assert.deepEqual(
    parseViewInboundMessage({ type: 'approveAgentAction', actionId: 'act_1', digest: 'a'.repeat(64) }).type,
    'approveAgentAction',
  );
  assert.deepEqual(
    parseViewInboundMessage({ type: 'rejectAgentAction', actionId: 'act_1', digest: 'a'.repeat(64) }).type,
    'rejectAgentAction',
  );
  for (const profile of ['ask', 'safe-auto', 'workspace-full']) {
    assert.deepEqual(parseViewInboundMessage({ type: 'setAgentProfile', profile }), {
      type: 'setAgentProfile',
      profile,
    });
  }
  const bad: unknown[] = [
    { type: 'setAgentProfile' },
    { type: 'setAgentProfile', profile: 'ask', extra: 1 },
    { type: 'setAgentProfile', profile: 'admin' },
    { type: 'setAgentProfile', profile: '' },
    { type: 'setAgentProfile', profile: 'ASK' },
    { type: 'approveAgentAction', actionId: 'a' },
    { type: 'approveAgentAction', actionId: 'a', digest: 'b', extra: 1 },
    { type: 'approveAgentAction', actionId: '', digest: 'a'.repeat(64) },
    { type: 'approveAgentAction', actionId: 'act_1', digest: 'A'.repeat(64) },
    { type: 'approveAgentAction', actionId: 'act_1', digest: 'g'.repeat(64) },
    { type: 'approveAgentAction', actionId: 'act_1', digest: 'a'.repeat(63) },
    { type: 'approveAgentAction', actionId: 'act_1', digest: 'a'.repeat(65) },
    { type: 'rejectAgentAction', actionId: 'a', digest: 'short' },
    { type: 'rejectAgentAction', actionId: '', digest: 'a'.repeat(64) },
    { type: 'rejectAgentAction', actionId: 'act_1', digest: 'A'.repeat(64) },
  ];
  for (const raw of bad) {
    assert.throws(() => parseViewInboundMessage(raw), /Invalid/);
  }
  assert.equal(scopeNoticeForMode('agent'), agentScopeNotice('muse-spark-1.3'));
  assert.match(scopeNoticeForMode('agent'), /muse-spark-1\.3/);
  assert.match(scopeNoticeForMode('agent', 'muse-wonder-1.0'), /muse-wonder-1\.0/);
  assert.match(AGENT_SCOPE_NOTICE, /never switched silently/);
  assert.match(AGENT_SCOPE_NOTICE, /bounded tool loop/);
  assert.match(AGENT_SCOPE_NOTICE, /active workspace/);
  assert.match(AGENT_SCOPE_NOTICE, /selected provider/);
  assert.match(AGENT_SCOPE_NOTICE, /No computer-wide control/);
  assert.match(AGENT_SCOPE_NOTICE, /arbitrary internet/);
  assert.match(AGENT_SCOPE_NOTICE, /terminal/);
});

test('agent state defaults safely and carries no key material', () => {
  const message = buildViewStateMessage(baseState());
  assert.equal(message.agentProfile, 'ask');
  assert.equal(message.agentWorkspace, null);
  assert.equal(message.agentPending, null);
  assert.deepEqual(message.agentLog, []);
  assert.ok(!('apiKey' in message));
  assert.doesNotMatch(JSON.stringify(message), /sk-|Bearer/i);
  const withPending = buildViewStateMessage({
    ...baseState(),
    agentProfile: 'workspace-full',
    agentWorkspace: '/ws',
    agentPending: {
      actionId: 'act_1',
      digest: 'c'.repeat(64),
      tool: 'apply_patch',
      targets: ['a.ts'],
      provider: 'local',
      workspaceId: '/ws',
      threadId: 't-1',
      bodyPreview: '{"files":[]}',
    },
    agentLog: [{ tool: 'read_file', digest: 'd'.repeat(16), decision: 'profile-auto', result: 'ok' }],
  });
  assert.equal(withPending.agentProfile, 'workspace-full');
  assert.equal(withPending.agentPending?.tool, 'apply_patch');
});

test('unified document exposes the shield, pending action, log, and boundaries', () => {
  const html = document();
  for (const id of [
    'profileSelect',
    'profileDesc',
    'agentShield',
    'agentShieldRow',
    'agentBoundaries',
    'agentWarning',
    'agentBox',
    'pendingTool',
    'pendingTargets',
    'pendingBody',
    'pendingMeta',
    'pendingApprove',
    'pendingReject',
    'actionLogBox',
    'actionLog',
    'modeSelect',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  const modeSelect = html.match(/<select id="modeSelect"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';
  assert.match(modeSelect, /<option[^>]*value="agent"[^>]*>Agent<\/option>/);
  assert.match(modeSelect, /<option[^>]*value="agent"[^>]*selected[^>]*>Agent<\/option>/);
  assert.ok(html.includes('<option value="workspace-full">Workspace full</option>'));
  assert.match(html, /active workspace/);
  assert.match(html, /disposable copy or test fixture/);
  // Reject executable innerHTML use (property or bracket access), not the
  // bare word in documentation comments.
  assert.doesNotMatch(html, /\.innerHTML/);
  assert.doesNotMatch(html, /\[\s*['"]innerHTML['"]\s*\]/);
});

test('webview script renders safely and binds approvals to id plus digest', () => {
  const script = readFileSync('media/main.js', 'utf8');
  // Reject executable innerHTML use (property or bracket access), not the
  // bare word in documentation comments.
  assert.doesNotMatch(script, /\.innerHTML/);
  assert.doesNotMatch(script, /\[\s*['"]innerHTML['"]\s*\]/);
  assert.match(script, /textContent/);
  assert.match(script, /setAgentProfile/);
  assert.match(script, /approveAgentAction/);
  assert.match(script, /rejectAgentAction/);
  assert.match(script, /actionId/);
  assert.match(script, /digest/);
  // Reject executable browser-storage use, not a documentation denial.
  assert.doesNotMatch(script, /window\s*\.\s*localStorage/);
  assert.doesNotMatch(script, /globalThis\s*\.\s*localStorage/);
  assert.doesNotMatch(script, /localStorage\s*\.\s*(getItem|setItem|removeItem|clear|key)\b/);
  assert.doesNotMatch(script, /\[\s*['"]localStorage['"]\s*\]/);
  // The save handler must read the input once to post {type:'saveKey', apiKey:value},
  // then immediately clear the input. That transient read is required, not persistence.
  assert.match(script, /type:\s*['"]saveKey['"]/);
  assert.match(script, /apiKeyEl\.value\s*=\s*['"]{2}/);
  {
    const clearAt = script.search(/apiKeyEl\.value\s*=\s*['"]{2}/);
    const postAt = script.search(/type:\s*['"]saveKey['"]/);
    assert.ok(clearAt !== -1 && postAt !== -1);
    assert.ok(clearAt <= postAt, 'key input must be cleared before/when posting saveKey');
  }
  // vscode.setState may persist only the composer draft, never key material.
  {
    const calls = [...script.matchAll(/setState\(\{([^}]*)\}\)/g)];
    assert.ok(calls.length > 0, 'expected at least one setState call');
    for (const m of calls) {
      assert.match(m[1], /composerDraft/);
      assert.doesNotMatch(m[1], /apiKey/i);
      assert.doesNotMatch(m[1], /\bkey\b/i);
      assert.doesNotMatch(m[1], /apiKeyEl/);
    }
  }
});

test('host gives malformed model tool calls a bounded schema repair path', () => {
  const host = readFileSync('src/agentEngine.ts', 'utf8');
  assert.match(host, /protocolRepairs > 2/);
  assert.match(host, /Correcting malformed tool call/);
  assert.match(host, /did not exactly match the declared JSON schema/);
  assert.match(host, /No invalid action ran/);
});

test('new-file approval binds absence and stale approvals trigger re-proposal', () => {
  const host = readFileSync('src/agentEngine.ts', 'utf8');
  assert.match(host, /bindPatchApprovalPreconditions/);
  assert.match(host, /MISSING_FILE_PRECONDITION/);
  assert.match(host, /choice\.kind === 'stale'/);
  assert.match(host, /Re-read every affected file and re-propose the change/);
  assert.doesNotMatch(host, /appendErrorTurn\(current, 'Agent action rejected\. Nothing ran\.'/);
});

test('empty Agent replies are retried and never reported as successful completion', () => {
  const host = readFileSync('src/agentEngine.ts', 'utf8');
  assert.match(host, /Retrying an empty Agent response/);
  assert.match(host, /model repeatedly returned an empty response/);
  assert.match(host, /No success was claimed/);
  assert.doesNotMatch(host, /Agent finished without a reply/);
  assert.match(host, /commandId npm:<safe-script-name>/);
  assert.match(host, /isRecoverableAgentToolError/);
  assert.match(host, /asking the Agent to inspect and retry/);
});
