/**
 * Mission Advisory consultations: within the grant's budget, only for a
 * reproducible blocker (an open blocking verifier), and only as advice.
 * A request over any grant limit is refused before it is sent, and the
 * limits are never raised (missionAdvisoryLimits.ts). The bytes and an
 * upper bound of the tokens are recorded before the request leaves; what
 * Meta reports replaces the bound afterwards.
 * The attempt is counted when it is sent; valid answers are counted apart;
 * a failure is classified and recorded, never retried here, and never
 * recovers the blocker. Only the host's own passing run of the original
 * verifier does that (missionVerifiers.ts).
 */

import { buildConsultPayload, cascadeAdviceSchema, formatAdvisory, validateCascadeAdvice } from './cascade.js';
import { createCascadeAdvice } from './meta-provider.js';
import { classifyMetaFailure, describeMetaFailure } from './metaFailures.js';
import { refuseOverLimit, tokenBound } from './missionAdvisoryLimits.js';
import { recordAdvisory } from './modelEvidenceRecorder.js';
import { currentTask, type MissionRecord } from './missionStore.js';
import type { BlockingVerifier } from './missionVerifiers.js';
import type { ProviderHost } from './providerTypes.js';

function note(mission: MissionRecord, text: string): void {
  const task = currentTask(mission);
  if (task) {
    mission.evidence.push({ taskId: task.id, kind: 'note', text: text.slice(0, 300), at: Date.now() });
  }
}

/** The blocker a consultation is for: the first one that can still recover. */
export function consultableBlocker(mission: MissionRecord): BlockingVerifier | null {
  return mission.auto?.blockers.find((blocker) => blocker.state === 'open') ?? null;
}

export async function consultForMission(
  host: ProviderHost,
  missionId: string,
  reason: string,
  hostRecord: string[],
  scopeId: string,
): Promise<void> {
  const mission = host.missions.get(missionId);
  const grant = mission?.grant ?? null;
  if (mission === null || grant === null || grant.escalation === null || grant.escalation.used >= grant.escalation.maxConsultations || !host.settings.allowCloudEscalation) {
    return;
  }
  const blocker = consultableBlocker(mission);
  if (blocker === null) {
    // No reproducible blocker to name: nothing is sent and nothing is counted.
    await host.updateActiveMission((draft) => {
      note(draft, 'remote advice not requested: no failing allowed test (blocking verifier) justifies a consultation');
      return { ok: true, value: draft };
    });
    return;
  }
  const apiKey = await host.getApiKey();
  if (!apiKey || (host.missionAuto !== null && host.missionAuto.stop !== null)) {
    return;
  }
  const escalation = grant.escalation;
  const task = currentTask(mission);
  const payload = buildConsultPayload({
    task: `${mission.goal}\nCurrent task: ${task?.title ?? ''}`,
    reason: `${reason}; blocking verifier ${blocker.commandId} has failed since internal run ${blocker.sinceRun}`,
    hostRecord,
    decisions: host.memory.listCurrentDecisions(scopeId).map((entry) => ({ key: entry.key, value: entry.value, version: entry.version })),
    verifier: { commandId: blocker.commandId, exitCode: blocker.originalExit },
  });
  const attempt = escalation.used + 1;
  const count = (delta: 1 | -1) =>
    host.updateActiveMission((draft) => {
      const target = draft.auto?.blockers.find((entry) => entry.id === blocker.id);
      if (draft.grant?.escalation) {
        draft.grant.escalation.used = Math.max(0, draft.grant.escalation.used + delta);
      }
      if (target) {
        target.advisoryAttempts = Math.max(0, target.advisoryAttempts + delta);
      }
      return { ok: true, value: draft };
    });
  // Counted before the call: an attempt that was sent and failed still used its slot.
  if (!(await count(1))) {
    return;
  }
  let sent = false;
  let refused: string | null = null;
  let reserved = 0;
  let advice = '';
  let line: string;
  // Bytes and the token bound are recorded before sending, so a reload mid-request cannot undercount.
  const account = (bytes: number, tokens: number) =>
    host.updateActiveMission((draft) => {
      if (draft.grant?.escalation) {
        draft.grant.escalation.sentBytes += bytes;
        draft.grant.escalation.usedTokens = Math.max(0, draft.grant.escalation.usedTokens + tokens);
      }
      return { ok: true, value: draft };
    });
  try {
    const result = await host.chatRunner.start(async ({ signal }) =>
      createCascadeAdvice({
        apiKey,
        model: escalation.model,
        payload,
        schema: cascadeAdviceSchema,
        generation: { maxCompletionTokens: escalation.maxOutputTokens, reasoning: null, reasoningParam: null },
        signal,
        fetchImpl: async (input, init) => {
          const bytes = typeof init?.body === 'string' ? Buffer.byteLength(init.body, 'utf8') : Number.POSITIVE_INFINITY;
          refused = refuseOverLimit(escalation, { maxConsultations: escalation.maxConsultations, used: escalation.used, sentBytes: escalation.sentBytes, usedTokens: escalation.usedTokens }, bytes);
          if (refused !== null) {
            throw new DOMException('Refused by a Mission Advisory limit.', 'AbortError');
          }
          reserved = tokenBound(bytes, escalation);
          if (!(await account(bytes, reserved))) {
            refused = 'its usage could not be recorded';
            throw new DOMException('Refused: usage not recorded.', 'AbortError');
          }
          sent = true;
          return fetch(input, init);
        },
      }),
    );
    host.recordUsage('cloud', result.usage);
    const actual = result.usage.inputTokens + result.usage.outputTokens;
    if (actual > 0) {
      await account(0, actual - reserved);
    }
    advice = formatAdvisory(escalation.model, validateCascadeAdvice(JSON.parse(result.content) as unknown));
    recordAdvisory(host, mission.threadId, escalation.model, { usage: result.usage });
    line = `remote advice for ${blocker.commandId} [${blocker.id}]: attempt ${attempt}/${escalation.maxConsultations}, a valid answer from Meta ${escalation.model} (in ${result.usage.inputTokens} / out ${result.usage.outputTokens} tokens), kept as untrusted data; the blocker stays open until the host's run of ${blocker.commandId} passes`;
  } catch (error) {
    const failure = classifyMetaFailure(error, [apiKey]);
    host.cloudConfirmed = host.cloudConfirmed && failure.category !== 'authentication';
    recordAdvisory(host, mission.threadId, escalation.model, { error, sent });
    if (refused !== null) {
      // Nothing was sent: not counted, and the limit stays as the user set it.
      await count(-1);
      line = `remote advice for ${blocker.commandId} [${blocker.id}]: not sent, because ${refused}; not counted, and the limit is not raised`;
    } else if (failure.category === 'cancelled' && !sent) {
      // Cancelled before anything was sent: not counted.
      await count(-1);
      line = `remote advice for ${blocker.commandId} [${blocker.id}]: cancelled before sending; not counted`;
    } else {
      line = `remote advice for ${blocker.commandId} [${blocker.id}]: attempt ${attempt}/${escalation.maxConsultations} failed: ${describeMetaFailure(failure)}; no advice used, not retried, and the blocker is unchanged`;
    }
  }
  await host.updateActiveMission((draft) => {
    note(draft, line);
    if (advice.length > 0) {
      const target = draft.auto?.blockers.find((entry) => entry.id === blocker.id);
      if (draft.grant?.escalation) {
        draft.grant.escalation.validResponses += 1;
      }
      if (target) {
        target.validResponses += 1;
      }
    }
    if (draft.auto !== null) {
      draft.auto.pendingAdvice = advice.slice(0, 4000);
    }
    return { ok: true, value: draft };
  });
}
