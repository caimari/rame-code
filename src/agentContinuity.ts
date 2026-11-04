/**
 * The continuity packet for one Agent or Mission run (contextContinuity.ts),
 * assembled here so the Agent engine stays within its size bound.
 *
 * An autonomous Mission run receives the same bounded, extractive recovery as
 * Agent, but only from the user's own conversation: the host-written internal
 * runs are left out (the Mission's own checkpoint already covers them), the
 * search uses the Mission's goal, its current task, and the user's latest own
 * request, and nothing changes its grant or authority.
 */

import { withheldForRun } from './cloudDisclosureHost.js';
import { logPacket } from './continuityLogHost.js';
import { buildContinuityPacket, continuityBudgetChars, type ContinuityPacket } from './contextContinuity.js';
import { currentTask } from './missionStore.js';
import type { ProviderHost } from './providerTypes.js';
import type { ChatThread } from './threadStore.js';

/** Turns of host-written segments: from a host-written user turn to the next user-written one. */
export function hostSegmentTurns(thread: ChatThread | undefined): Set<number> {
  const turns = new Set<number>();
  let inside = false;
  thread?.turns.forEach((turn, index) => {
    if (turn.kind === 'user') {
      inside = turn.host === true;
    }
    if (inside) {
      turns.add(index);
    }
  });
  return turns;
}

export function agentContinuity(
  host: ProviderHost,
  input: {
    threadId: string;
    thread: ChatThread | undefined;
    text: string;
    provider: 'local' | 'cloud';
    model: string;
    contextWindow: number | null;
    recentIndexes: ReadonlySet<number>;
    scopeId: string;
    label: string;
  },
): ContinuityPacket {
  const origin = { provider: input.provider, model: input.model };
  const budget = continuityBudgetChars(input.contextWindow);
  const auto = host.missionAuto;
  if (auto === null) {
    const withheldLocal = withheldForRun(host, input.threadId, input.provider, input.text);
    const packet = buildContinuityPacket(input.thread, input.text, origin, budget, {
      recentIndexes: input.recentIndexes,
      authorizedDecisions: host.memory.listCurrentDecisions(input.scopeId).map((decision) => ({
        key: decision.key,
        version: decision.version,
        value: decision.value,
        createdAt: decision.createdAt,
      })),
      scopeLabel: input.label,
      withheldLocalTurns: withheldLocal,
    });
    logPacket(host, input.threadId, host.activeMission === null ? 'agent' : 'mission-run', origin, input.text, packet, withheldLocal);
    return packet;
  }
  const mission = host.missions.get(auto.missionId);
  const task = mission === null ? null : currentTask(mission);
  // The Mission's own words plus the user's latest own request (a plan may paraphrase it).
  const userTurn = [...(input.thread?.turns ?? [])].reverse().find((turn) => turn.kind === 'user' && turn.host !== true);
  const query = mission === null
    ? input.text
    : [mission.goal, task?.title ?? '', task?.successCriterion ?? '', userTurn?.kind === 'user' ? userTurn.text : ''].join('\n');
  const packet = buildContinuityPacket(input.thread, query, origin, budget, {
    recentIndexes: input.recentIndexes,
    excludeIndexes: hostSegmentTurns(input.thread),
    checkpoint: false,
    scopeLabel: input.label,
  });
  // The Mission keeps its first host-record lines as evidence: recovery is not one of its
  // actions. What was recovered, and why, goes to the separate recovered-context log.
  logPacket(host, input.threadId, 'mission-run', origin, query, packet);
  return { ...packet, hostRecordLine: null };
}
