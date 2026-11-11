/**
 * The Mission's Advisory budget and causal recovery state, as the live card
 * shows them: attempts sent, valid answers, the limits with what is used
 * and what remains, the blocker they were for, and
 * whether authority is normal, restricted (consulted, not yet recovered by
 * the original verifier), or unrecoverable. Pure; no host access.
 */

import type { MissionRecord } from './missionStore.js';
import type { MissionRemoteView } from './remoteViews.js';

/** The Advisory budget and the causal recovery state, for the live card. */
export function missionRemoteView(mission: MissionRecord): MissionRemoteView | null {
  const escalation = mission.grant?.escalation ?? null;
  const blockers = mission.auto?.blockers ?? [];
  if (escalation === null && blockers.length === 0) {
    return null;
  }
  const blocker = blockers.find((entry) => entry.advisoryAttempts > 0) ?? blockers[0] ?? null;
  const last = [...mission.evidence].reverse().find((entry) => entry.text.startsWith('remote advice'));
  return {
    model: escalation?.model ?? '',
    maxConsultations: escalation === null ? 0 : (escalation.maxConsultations ?? ('∞' as const)),
    attempts: escalation?.used ?? 0,
    validResponses: escalation?.validResponses ?? 0,
    limits:
      escalation === null
        ? null
        : {
            maxRequestBytes: escalation.maxRequestBytes,
            maxTotalBytes: escalation.maxTotalBytes,
            sentBytes: escalation.sentBytes,
            maxOutputTokens: escalation.maxOutputTokens,
            maxTotalTokens: escalation.maxTotalTokens,
            usedTokens: escalation.usedTokens,
          },
    dataClasses: escalation ? [...escalation.dataClasses] : [],
    lastResult: last?.text ?? '',
    blocker: blocker === null ? null : { id: blocker.id, commandId: blocker.commandId, sinceRun: blocker.sinceRun, state: blocker.state },
    causalState: blockers.some((entry) => entry.state === 'unrecoverable')
      ? 'unrecoverable'
      : blockers.some((entry) => entry.advisoryAttempts > 0)
        ? 'restricted'
        : 'normal',
  };
}
