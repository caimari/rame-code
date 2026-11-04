/**
 * What the agent's tools may touch while a Mission with a protected
 * acceptance check runs: the frozen files, sealed folders and everything
 * that changes how Node finds them are refused for writing, and the
 * expected values of host-compared cases cannot be read.
 */

import { frozenWriteHit } from './acceptanceDependencies.js';
import { hideFromAgent } from './acceptanceManifest.js';
import type { AgentFs } from './agentHost.js';
import { checkAgentRelPath } from './agentPolicy.js';
import { frozenPaths } from './missionStore.js';
import type { ProviderHost } from './providerTypes.js';

/**
 * A target frozen by the running Mission's acceptance check (checked by
 * hash), inside a sealed folder, or inside node_modules (only blocked for
 * RAME's own tools, not hashed: scripts, other processes, or the user can
 * still change it).
 */
export function frozenTarget(host: ProviderHost, targets: readonly string[]): string | null {
  const auto = host.missionAuto;
  if (auto === null) {
    return null;
  }
  const frozen = frozenPaths(host.missions.get(auto.missionId));
  if (frozen.length === 0) {
    return null;
  }
  for (const target of targets) {
    const gate = checkAgentRelPath(target);
    const rel = gate.ok ? (gate as { ok: true; rel: string }).rel : target;
    if (frozenWriteHit(frozen, rel)) {
      return rel;
    }
  }
  return null;
}

/** The agent's file system: the running Mission's hidden cases files cannot be read through it. */
export function agentToolFs(host: ProviderHost, fs: AgentFs): AgentFs {
  return hideFromAgent(fs, () => {
    const auto = host.missionAuto;
    return auto === null ? [] : (host.missions.get(auto.missionId)?.grant?.acceptance?.scope?.hidden ?? []);
  });
}
