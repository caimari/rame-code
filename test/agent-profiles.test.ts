import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_TOOL_NAMES,
  AGENT_BOUNDARIES_TEXT,
  DEFAULT_AGENT_PROFILE,
  describeAgentProfile,
  isAgentProfileId,
  isAutoAllowed,
  parseAgentProfile,
  WORKSPACE_FULL_WARNING,
} from '../src/agentProfiles.js';

test('permission profiles default to the safest on unknown/corrupt state', () => {
  assert.equal(DEFAULT_AGENT_PROFILE, 'ask');
  assert.equal(parseAgentProfile(undefined), 'ask');
  assert.equal(parseAgentProfile(null), 'ask');
  assert.equal(parseAgentProfile(''), 'ask');
  assert.equal(parseAgentProfile('workspace-full-evil'), 'ask');
  assert.equal(parseAgentProfile({}), 'ask');
  assert.equal(parseAgentProfile({ profile: 'nope' }), 'ask');
  assert.equal(parseAgentProfile({ profile: 'safe-auto' }), 'safe-auto');
  assert.equal(parseAgentProfile({ id: 'workspace-full' }), 'workspace-full');
  assert.equal(parseAgentProfile('ask'), 'ask');
  assert.equal(parseAgentProfile('safe-auto'), 'safe-auto');
  assert.equal(parseAgentProfile('workspace-full'), 'workspace-full');
  assert.equal(isAgentProfileId('ask'), true);
  assert.equal(isAgentProfileId('bogus'), false);
});

test('auto-allow matrix keeps writes and tests gated except in workspace-full', () => {
  for (const tool of AGENT_TOOL_NAMES) {
    assert.equal(isAutoAllowed('ask', tool), false);
  }
  assert.equal(isAutoAllowed('safe-auto', 'list_files'), true);
  assert.equal(isAutoAllowed('safe-auto', 'inspect_workspace'), true);
  assert.equal(isAutoAllowed('safe-auto', 'search_text'), true);
  assert.equal(isAutoAllowed('safe-auto', 'read_file'), true);
  assert.equal(isAutoAllowed('safe-auto', 'create_directory'), false);
  assert.equal(isAutoAllowed('safe-auto', 'move_file'), false);
  assert.equal(isAutoAllowed('safe-auto', 'delete_file'), false);
  assert.equal(isAutoAllowed('safe-auto', 'apply_patch'), false);
  assert.equal(isAutoAllowed('safe-auto', 'run_tests'), false);
  for (const tool of AGENT_TOOL_NAMES) {
    assert.equal(isAutoAllowed('workspace-full', tool), true);
  }
});

test('profile descriptions state boundaries honestly', () => {
  assert.match(describeAgentProfile('ask'), /Ask/);
  assert.match(AGENT_BOUNDARIES_TEXT, /active workspace/);
  assert.match(AGENT_BOUNDARIES_TEXT, /Symlink/);
  assert.match(AGENT_BOUNDARIES_TEXT, /shell:false/);
  assert.match(AGENT_BOUNDARIES_TEXT, /may access files, network, or shells/);
  assert.match(AGENT_BOUNDARIES_TEXT, /without/);
  assert.match(AGENT_BOUNDARIES_TEXT, /prompting/);
  assert.match(AGENT_BOUNDARIES_TEXT, /high risk/);
  assert.match(AGENT_BOUNDARIES_TEXT, /arbitrary commands run only through the optional terminal tool \(OFF by default\), each shown first/);
  assert.match(AGENT_BOUNDARIES_TEXT, /never switches providers silently/);
  assert.match(WORKSPACE_FULL_WARNING, /Select Ask/);
  assert.doesNotMatch(AGENT_BOUNDARIES_TEXT, /unrestricted/i);
  assert.doesNotMatch(AGENT_BOUNDARIES_TEXT, /arbitrary internet/i);
});
