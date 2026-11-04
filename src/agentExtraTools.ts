/**
 * The Agent's optional tools beyond the workspace: read-only web access
 * (webTools.ts) and terminal commands (shellTool.ts). Both are OFF by
 * default, offered only to a local model and never in a Mission's runs.
 */

import type { AgentToolDefinition } from './agentTools.js';
import type { ProviderHost } from './providerTypes.js';
import type { ProviderId } from './settingsStore.js';
import { executeShellTool, shellToolDefinitions } from './shellTool.js';
import { executeWebTool, webToolDefinitions } from './webTools.js';

export function extraToolDefinitions(host: ProviderHost, provider: ProviderId): AgentToolDefinition[] {
  return [...webToolDefinitions(host, provider), ...shellToolDefinitions(host, provider)];
}

export function executeExtraTool(host: ProviderHost, tool: 'web_search' | 'web_fetch' | 'run_command', args: Record<string, unknown>, provider: ProviderId, root: string, signal: AbortSignal): Promise<string> {
  return tool === 'run_command' ? executeShellTool(host, args, provider, root, signal) : executeWebTool(host, tool, args, provider, signal);
}
