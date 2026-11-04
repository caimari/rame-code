/**
 * Host side of the recovered-context log (continuityLog.ts): records what a
 * continuity packet or a `search_history` call recovered, by reference and
 * hash, for the thread it belongs to.
 */

import { appendRecoveryEvent, pruneContinuityLog, sha256, type NewRecoveryEvent, type RecoveryMatch, type RecoveryMode } from './continuityLog.js';
import type { ContinuityPacket } from './contextContinuity.js';
import { resolveHistorySearchWithSources, type HistorySearchRequest } from './historySearch.js';
import type { ProviderHost } from './providerTypes.js';
import { originModelLabel } from './threadStore.js';

function append(host: ProviderHost, threadId: string, event: NewRecoveryEvent): void {
  if (appendRecoveryEvent(host.continuityLog.state, threadId, event)) {
    pruneContinuityLog(host.continuityLog.state, new Set(host.store.list().map((thread) => thread.id)));
    host.continuityLog.persist();
  }
}

/** The running Mission and its internal-run count, when a Mission is running. */
function missionRef(host: ProviderHost): NewRecoveryEvent['mission'] {
  const missionId = host.missionAuto?.missionId ?? host.activeMission?.id ?? null;
  return missionId === null ? null : { missionId, run: host.missions.get(missionId)?.taskRunsUsed ?? null };
}

/** Record an automatic recovery; nothing is recorded when nothing was recovered or withheld. */
export function logPacket(
  host: ProviderHost,
  threadId: string,
  mode: RecoveryMode,
  origin: { provider: 'local' | 'cloud'; model: string },
  query: string,
  packet: ContinuityPacket,
  withheldLocal = 0,
): void {
  const sources = packet.retrieval.sources.map((source) => ({
    turn: source.index,
    role: source.role,
    at: source.at,
    match: source.match as RecoveryMatch,
    sha256: sha256(source.text),
  }));
  if (sources.length === 0 && withheldLocal === 0) {
    return;
  }
  append(host, threadId, {
    at: Date.now(),
    trigger: 'automatic',
    mode,
    provider: origin.provider,
    model: originModelLabel(origin.model),
    mission: mode === 'mission-run' || mode === 'mission-plan' ? missionRef(host) : null,
    querySha256: sha256(query),
    sources,
    withheldLocal,
  });
}

/** `search_history` for an Agent or Mission run, with the excerpts it returned recorded by reference. */
export function recordedHistorySearch(host: ProviderHost, threadId: string, provider: 'local' | 'cloud', request: HistorySearchRequest): string {
  const result = resolveHistorySearchWithSources(provider, host.store.get(threadId), request);
  const mission = missionRef(host);
  append(host, threadId, {
    at: Date.now(),
    trigger: 'search_history',
    mode: mission === null ? 'agent' : 'mission-run',
    provider,
    model: originModelLabel(provider === 'cloud' ? host.selectedCloudModel() : host.settings.local.modelId),
    mission,
    querySha256: sha256(JSON.stringify(request.queries)),
    sources: result.excerpts.map((entry) => ({
      turn: entry.document.id,
      role: entry.document.role as 'user' | 'assistant' | 'plan',
      at: entry.document.timestamp,
      match: `lexical-${entry.match}` as RecoveryMatch,
      sha256: sha256(entry.document.text),
    })),
    withheldLocal: 0,
  });
  return result.text;
}
