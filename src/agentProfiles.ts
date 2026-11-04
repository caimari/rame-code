/**
 * Original permission profiles for Agent mode.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * - `ask`: every tool action pauses for a visible approve/reject decision.
 * - `safe-auto`: low-risk workspace reads run automatically after policy
 *   validation; writes and test commands still require approval.
 * - `workspace-full`: policy-valid reads, patch applications, allowlisted
 *   tests and enabled read-only web calls may run without per-action prompts.
 *   The optional terminal remains separately gated and always needs approval.
 *
 * Only the profile id is persisted; transient approvals are never stored.
 * Unknown or corrupt persisted state falls back to `ask`.
 */

export const ASK_PROFILE_ID = 'ask' as const;
export const SAFE_AUTO_PROFILE_ID = 'safe-auto' as const;
export const WORKSPACE_FULL_PROFILE_ID = 'workspace-full' as const;

export type AgentProfileId =
  | typeof ASK_PROFILE_ID
  | typeof SAFE_AUTO_PROFILE_ID
  | typeof WORKSPACE_FULL_PROFILE_ID;

export const DEFAULT_AGENT_PROFILE: AgentProfileId = ASK_PROFILE_ID;

export const AGENT_PROFILE_IDS: readonly AgentProfileId[] = [
  ASK_PROFILE_ID,
  SAFE_AUTO_PROFILE_ID,
  WORKSPACE_FULL_PROFILE_ID,
];

/** Tool names in the small typed Agent allowlist. */
export const AGENT_TOOL_NAMES = [
  'list_files',
  'inspect_workspace',
  'filesystem_usage',
  'search_history',
  'search_text',
  'read_file',
  'create_directory',
  'move_file',
  'delete_file',
  'set_executable',
  'apply_patch',
  'replace_in_file',
  'run_tests',
] as const;

export type AgentWorkspaceToolName = (typeof AGENT_TOOL_NAMES)[number];

/**
 * Project-memory tools. The model can read authorized memory and propose
 * changes; it can never write memory. Proposals always wait for the user,
 * in every profile, including workspace-full.
 */
export const MEMORY_TOOL_NAMES = ['read_decisions', 'propose_decision', 'bind_artifact'] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];
/** Memory tools that only a user approval can complete. */
export const USER_APPROVAL_ONLY_TOOLS: readonly MemoryToolName[] = ['propose_decision', 'bind_artifact'];

/** Optional tools beyond the workspace, each offered only when the user enabled it: read-only web (webTools.ts) and terminal commands (shellTool.ts). */
export const WEB_TOOL_NAMES = ['web_search', 'web_fetch', 'run_command'] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];
export function isWebToolName(value: unknown): value is WebToolName {
  return (WEB_TOOL_NAMES as readonly unknown[]).includes(value);
}
export type AgentToolName = AgentWorkspaceToolName | MemoryToolName | WebToolName;

export function isMemoryToolName(value: unknown): value is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly unknown[]).includes(value);
}

const READ_TOOLS: readonly AgentToolName[] = [
  'list_files',
  'inspect_workspace',
  'filesystem_usage',
  'search_history',
  'search_text',
  'read_file',
  'read_decisions',
];

export interface AgentProfileOption {
  id: AgentProfileId;
  label: string;
  short: string;
  detail: string;
}

export const AGENT_PROFILES: readonly AgentProfileOption[] = [
  {
    id: ASK_PROFILE_ID,
    label: 'Ask (safest)',
    short: 'Every tool action needs your approval.',
    detail:
      'Ask pauses before each workspace inspection, read, file operation, patch, or test command. ' +
      'Nothing runs until you approve that exact action, including the exact ' +
      'resolved test executable and script shown in the approval.',
  },
  {
    id: SAFE_AUTO_PROFILE_ID,
    label: 'Safe auto',
    short: 'Reads run automatically; writes and tests need approval.',
    detail:
      'Policy-checked reads (list, inspect, search, read) run without a prompt. ' +
      'Directory creation, file moves/deletes, patches, and test commands still pause for approval. ' +
      'Allowlisted test scripts run with your OS permissions when approved.',
  },
  {
    id: WORKSPACE_FULL_PROFILE_ID,
    label: 'Workspace full',
    short: 'Workspace file operations and allowlisted tests run without prompts. High risk.',
    detail:
      'Policy-checked reads, file operations, patch applications, and allowlisted test ' +
      'commands can run without per-action prompts after your explicit ' +
      'selection. Allowlisted test scripts run with your OS permissions and ' +
      'may access files, network, or shells; Workspace-full is high risk. ' +
      'Switch back to Ask instantly at any time.',
  },
];

/**
 * Explicit boundaries that hold in every profile, including
 * `workspace-full`. Shown in the UI next to the profile selector. There is
 * deliberately no OS sandbox for package scripts and no claim that tests
 * cannot reach the network or outside files.
 */
export const AGENT_BOUNDARIES_TEXT =
  'Agent works only inside the active workspace. ' +
  'Symlink and path escapes are blocked; .git, .env files, credential and key ' +
  'material, secret stores, auth files, and repository control files are protected. ' +
  'Tests run only from an exact derived allowlist with shell:false; arbitrary ' +
  'commands run only through the optional terminal tool (OFF by default), each shown first; allowlisted package scripts still execute with your ' +
  'OS permissions and may access files, network, or shells. Ask and Safe-auto ' +
  'require approval before they run, while Workspace-full may run them without ' +
  'prompting and is high risk. Cloud work needs your existing escalation ' +
  'consent and never switches providers silently. Tamper resistance is not claimed.';

/** Persistent warning shown while `workspace-full` is selected. */
export const WORKSPACE_FULL_WARNING =
  'Workspace-full is high risk: policy-checked patches and allowlisted tests run ' +
  'without per-action prompts. Allowlisted test scripts execute with your OS ' +
  'permissions and may access files, network, or shells; they are not sandboxed. ' +
  'File work stays inside the active workspace only. ' +
  'Select Ask to return to per-action approval instantly.';

/** Parse untrusted persisted profile state; unknown values fall back to `ask`. */
export function parseAgentProfile(value: unknown): AgentProfileId {
  if (
    value === ASK_PROFILE_ID ||
    value === SAFE_AUTO_PROFILE_ID ||
    value === WORKSPACE_FULL_PROFILE_ID
  ) {
    return value;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return parseAgentProfile(record.profile ?? record.id ?? record.agentProfile);
  }
  return DEFAULT_AGENT_PROFILE;
}

/** True only for the three known profile ids. */
export function isAgentProfileId(value: string): value is AgentProfileId {
  return (
    value === ASK_PROFILE_ID ||
    value === SAFE_AUTO_PROFILE_ID ||
    value === WORKSPACE_FULL_PROFILE_ID
  );
}

/** Human-readable description for the active profile. */
export function describeAgentProfile(id: AgentProfileId): string {
  const found = AGENT_PROFILES.find((option) => option.id === id);
  return found ? `${found.label} — ${found.short}` : 'Ask (safest)';
}

/**
 * Whether the profile permits running the tool without a per-action human
 * approval. Policy validation still applies first; `false` means approval is
 * required. Tool output can never change this result.
 */
export function isAutoAllowed(
  profile: AgentProfileId,
  tool: AgentToolName,
): boolean {
  if ((USER_APPROVAL_ONLY_TOOLS as readonly string[]).includes(tool) || tool === 'run_command') {
    // Memory changes and terminal commands are never automatic, whatever the profile.
    return false;
  }
  if (profile === ASK_PROFILE_ID) {
    return false;
  }
  if (profile === SAFE_AUTO_PROFILE_ID) {
    return (READ_TOOLS as readonly string[]).includes(tool);
  }
  // workspace-full: every allowlisted tool may run without a prompt once
  // policy, patch preconditions, and the test allowlist all pass.
  // Web tools too, once enabled: each call is still shown in the action log and host record (terminal commands never: above).
  return (AGENT_TOOL_NAMES as readonly string[]).includes(tool) || tool === 'read_decisions' || isWebToolName(tool);
}
