import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connectionLabel,
  escapeHtml,
  formatPlanAsText,
  initialPanelState,
  toWebviewStateMessage,
  withHasKey,
  withMissionCancelled,
  withMissionFailed,
  withMissionStarted,
  withMissionSucceeded,
  withStatus,
} from '../src/panelState.js';
import type { MissionPlan } from '../src/types.js';

const PLAN: MissionPlan = {
  goal: 'Add a greeting command',
  assumptions: ['The command runs locally.'],
  steps: [
    {
      id: 'step-1',
      title: 'Define the command',
      successCriterion: 'The command is registered and tested.',
    },
  ],
  risks: ['Scope creep.'],
};

test('initial state reflects whether a key is stored', () => {
  const withoutKey = initialPanelState(false);
  assert.equal(withoutKey.connection, 'missing-key');
  assert.equal(withoutKey.running, false);
  assert.equal(withoutKey.plan, null);

  const withKey = initialPanelState(true);
  assert.equal(withKey.connection, 'ready');
  assert.equal(withKey.hasKey, true);
});

test('key updates preserve a running mission', () => {
  const running = { ...initialPanelState(true), running: true };
  assert.equal(withHasKey(running, true).connection, 'working');
  assert.equal(withHasKey(initialPanelState(true), false).connection, 'missing-key');
  assert.equal(withHasKey(initialPanelState(false), true).connection, 'ready');
});

test('mission start refuses concurrent, keyless, or invalid runs', () => {
  const started = withMissionStarted(initialPanelState(true), 'Add a verified greeting.');
  assert.ok(started);
  assert.equal(started.running, true);
  assert.equal(started.connection, 'working');
  assert.equal(started.plan, null);

  assert.equal(withMissionStarted(started, 'Another valid goal text.'), null);
  assert.equal(withMissionStarted(initialPanelState(false), 'Add a verified greeting.'), null);
  assert.equal(withMissionStarted(initialPanelState(true), 'short'), null);
});

test('mission success, failure, and cancellation transitions', () => {
  const started = withMissionStarted(initialPanelState(true), 'Add a verified greeting.');
  assert.ok(started);

  const done = withMissionSucceeded(started, PLAN);
  assert.equal(done.running, false);
  assert.equal(done.connection, 'done');
  assert.deepEqual(done.plan, PLAN);

  const failed = withMissionFailed(started, 'HTTP 400.');
  assert.equal(failed.connection, 'error');
  assert.equal(failed.plan, null);
  assert.equal(failed.error, 'HTTP 400.');

  const cancelled = withMissionCancelled(started);
  assert.equal(cancelled.running, false);
  assert.equal(cancelled.connection, 'cancelled');

  const noted = withStatus(initialPanelState(false), 'Hello.');
  assert.equal(noted.status, 'Hello.');
  assert.equal(noted.connection, 'missing-key');
});

test('state message carries no key material', () => {
  const message = toWebviewStateMessage(initialPanelState(true));
  assert.equal(message.hasKey, true);
  assert.ok(!('apiKey' in message));
});

test('plan text is readable and key-free by construction', () => {
  const text = formatPlanAsText(PLAN, 'muse-spark-1.3');
  assert.match(text, /muse-spark-1\.3/);
  assert.match(text, /Define the command/);
  assert.match(text, /No workspace content was read or sent/);
  assert.doesNotMatch(text, /Bearer|apiKey/i);
});

test('labels and escaping behave', () => {
  assert.equal(connectionLabel('missing-key'), 'Not connected — API key required');
  assert.equal(connectionLabel('ready'), 'Key stored — live connection not yet verified');
  assert.equal(connectionLabel('working'), 'Working…');
  assert.equal(escapeHtml('<a href="x">&\'test\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;test&#39;&lt;/a&gt;');
});
