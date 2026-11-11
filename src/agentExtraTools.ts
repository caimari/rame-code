/**
 * The Agent's optional tools beyond the workspace: read-only web access
 * (webTools.ts), terminal commands (shellTool.ts), long jobs (jobTools.ts)
 * and installs (installTool.ts). None is ever offered in a Mission's runs;
 * the one Mission-only tool, read_original (originalTool.ts), is offered
 * only there.
 *
 * Long jobs and installs have their own approval card, rebuilt and compared
 * right after the user approves it; the engine calls them through the
 * `bound*` hooks below.
 */

import { fullAccessNow, markFullApproved, rememberFullJob, useAgentWebNow } from './autonomyHost.js';
import type { AgentChatMessage } from './agentModel.js';
import type { AgentToolDefinition, ValidatedToolCall } from './agentTools.js';
import { confirmInstallApproval, executeInstallTool, installAuto, installToolDefinitions, prepareInstallCard } from './installTool.js';
import { confirmJobApproval, executeJobTool, jobRefusal, jobToolDefinitions, prepareJobCard } from './jobTools.js';
import type { ProviderHost } from './providerTypes.js';
import type { ProviderId } from './settingsStore.js';
import { executeReadOriginal, originalToolDefinitions } from './originalTool.js';
import { executeShellTool, shellToolDefinitions } from './shellTool.js';
import { executeWebTool, webToolDefinitions } from './webTools.js';

export function extraToolDefinitions(host: ProviderHost, provider: ProviderId): AgentToolDefinition[] {
  return [...webToolDefinitions(host, provider), ...shellToolDefinitions(host, provider), ...jobToolDefinitions(host), ...installToolDefinitions(host), ...originalToolDefinitions(host)];
}

export function executeExtraTool(host: ProviderHost, tool: 'web_search' | 'web_fetch' | 'run_command', args: Record<string, unknown>, provider: ProviderId, root: string, signal: AbortSignal): Promise<string> {
  return tool === 'run_command' ? executeShellTool(host, args, provider, root, signal) : executeWebTool(host, tool, args, provider, signal);
}

type Described = { targets: string[]; body: string; preconditions: Record<string, string> };

/** Tools with their own card: start_job and install_package. */
export const isBoundTool = (tool: string): boolean => tool === 'start_job' || tool === 'install_package';

export function boundCard(host: ProviderHost, call: ValidatedToolCall, root: string): Promise<{ ok: true; described: Described } | { ok: false; error: string }> {
  return call.tool === 'start_job' ? prepareJobCard(host, call, root) : prepareInstallCard(host, call, root);
}

export function confirmBound(host: ProviderHost, call: ValidatedToolCall, approvedBody: string, root: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return call.tool === 'start_job' ? confirmJobApproval(host, call, approvedBody, root) : call.tool === 'install_package' ? confirmInstallApproval(host, call, approvedBody, root) : Promise.resolve({ ok: true });
}

export const boundRefusal = (call: ValidatedToolCall, error: string): AgentChatMessage[] => jobRefusal(call, error);

/**
 * Whether a call may run without its card beyond the profile, checked right
 * before it runs: Full Access for the parts the user chose (Autonomy &
 * Permissions; a long job and an install still pass their own checks, and
 * an install never with administrator rights), a web call within the
 * Agent and Chat web pre-authorization (one slot consumed now), or an
 * automatic install the user chose for Workspace full.
 */
export async function extraToolAuto(host: ProviderHost, profile: string, call: ValidatedToolCall, root: string): Promise<boolean> {
  const args = call.args as Record<string, unknown>;
  if (call.tool === 'web_search' || call.tool === 'web_fetch') {
    return useAgentWebNow(host, call.tool, args, root);
  }
  const full = await fullAccessNow(host, call.tool, args, root);
  if (full.ok) {
    let ready = true;
    if (call.tool === 'install_package') {
      ready = await installAuto(host, profile, call, root, true);
    } else if (call.tool === 'start_job') {
      const card = await prepareJobCard(host, call, root);
      ready = card.ok && (await confirmJobApproval(host, call, card.described.body, root)).ok;
      if (ready) {
        fullJobs.set(call, full);
      }
    }
    if (ready) {
      markFullApproved(call);
      return true;
    }
  }
  return installAuto(host, profile, call, root);
}

/** Long jobs started under Full Access: remembered so that revoking it stops them. */
const fullJobs = new WeakMap<ValidatedToolCall, { id: string; scopeId: string }>();

export function executeBoundTool(host: ProviderHost, call: ValidatedToolCall, root: string, profile: string, signal: AbortSignal): Promise<string> {
  if (call.tool === 'read_original') {
    return executeReadOriginal(host, call.args as Record<string, unknown>);
  }
  if (call.tool === 'start_job' || call.tool === 'job_status') {
    return executeJobTool(host, call, root, signal).then(async (text) => {
      const full = fullJobs.get(call);
      const id = /^Started job (\S+)/.exec(text)?.[1];
      if (full && id) {
        await rememberFullJob(host, full.scopeId, full.id, id);
      }
      return text;
    });
  }
  return executeInstallTool(host, call, root, profile, signal);
}
