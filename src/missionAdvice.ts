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

import { finishExternal, metaInForce, metaRefusalNow, recordExternal, reserveMetaTokens, scopedFilesSection, settleMetaTokens, trackPreauthorized } from './autonomyHost.js';
import { META_PROVIDER, missionCountRefusal } from './autonomyPolicy.js';
import { withoutWebLines } from './missionWeb.js';
import { buildConsultPayload, cascadeAdviceSchema, formatAdvisory, validateCascadeAdvice } from './cascade.js';
import { createCascadeAdvice } from './meta-provider.js';
import { classifyMetaFailure, describeMetaFailure } from './metaFailures.js';
import { refuseOverLimit, tokenBound } from './missionAdvisoryLimits.js';
import { recordAdvisory } from './modelEvidenceRecorder.js';
import { currentTask, type MissionRecord } from './missionStore.js';
import type { BlockingVerifier } from './missionVerifiers.js';
import type { ProviderHost } from './providerTypes.js';
import { HOST_SPEC_FILE } from './referenceCheck.js';
import { offerConsult } from './remoteController.js';

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

/** "of 3", or "" with no count limit; and "/3" for the record. */
const describeCount = (max: number | null): string => (max === null ? ', no count limit' : ` of ${max}`);
const slash = (max: number | null): string => (max === null ? ' (no count limit)' : `/${max}`);

/** A Mission whose stored count is above what the pre-authorization allows now (a stored grant changed by hand) is not sent. */
function overPreauth(host: ProviderHost, scopeId: string, maxConsultations: number | null): string | null {
  const meta = metaInForce(host, scopeId);
  const over = meta === null ? null : missionCountRefusal(meta, maxConsultations);
  return over === null ? null : `the Mission's count is above the pre-authorization (${over.replace(/\.$/, '')})`;
}

export async function consultForMission(
  host: ProviderHost,
  missionId: string,
  reason: string,
  hostRecord: string[],
  scopeId: string,
  root?: string,
): Promise<void> {
  const mission = host.missions.get(missionId);
  const grant = mission?.grant ?? null;
  if (mission === null || grant === null || grant.escalation === null || (grant.escalation.maxConsultations !== null && grant.escalation.used >= grant.escalation.maxConsultations) || !host.settings.allowCloudEscalation) {
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
  // Without a card only under the pre-authorization this Mission was given (Autonomy & Permissions), checked now.
  const binding = grant.escalation.preauth ?? null;
  const notInForce = binding === null
    ? 'this Mission was not authorized under a Meta pre-authorization'
    : mission.scopeId !== scopeId ? 'the Mission belongs to another workspace' : (metaRefusalNow(host, mission.scopeId, binding) ?? overPreauth(host, mission.scopeId, grant.escalation.maxConsultations));
  if (notInForce !== null || binding === null) {
    await host.updateActiveMission((draft) => {
      note(draft, `remote advice not sent without a card: ${notInForce ?? 'no pre-authorization'}; nothing was sent or counted (when the Mission stops, the consultation card shows the exact text for your approval)`);
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
  let payload = buildConsultPayload({
    task: `${mission.goal}\nCurrent task: ${task?.title ?? ''}`,
    reason: `${reason}; blocking verifier ${blocker.commandId} has failed since internal run ${blocker.sinceRun}`,
    // Web searches and pages stay local: never sent to Meta with a consultation.
    hostRecord: withoutWebLines(hostRecord),
    decisions: host.memory.listCurrentDecisions(scopeId).map((entry) => ({ key: entry.key, value: entry.value, version: entry.version })),
    verifier: { commandId: blocker.commandId, exitCode: blocker.originalExit },
  });
  let fileNames: string[] = [];
  if (binding.files.length > 0) {
    const acceptance = grant.acceptance ?? null;
    const excluded = new Set([...(acceptance?.files ?? []).map((file) => file.path), ...(acceptance?.scope?.hidden ?? []), ...(acceptance?.references ?? []).map((reference) => reference.spec)]);
    const section = root === undefined ? { ok: false as const, error: 'the project folder is not known' } : await scopedFilesSection(host.agentFsFor(root), mission.scopeLabel, binding.files, excluded);
    if (!section.ok) {
      // Beyond what was pre-authorized: never sent automatically; the card asks with the exact text.
      await host.updateActiveMission((draft) => {
        note(draft, `remote advice not sent without a card: ${section.error}, which is beyond what was pre-authorized; nothing was sent or counted (when the Mission stops, the consultation card shows the exact text for your approval)`);
        return { ok: true, value: draft };
      });
      return;
    }
    payload += section.text;
    fileNames = section.names;
  }
  // One slot, reserved atomically and stored before sending: two consultations can never share it.
  let attempt = 0;
  const reserve = () =>
    host.updateActiveMission((draft) => {
      const target = draft.auto?.blockers.find((entry) => entry.id === blocker.id);
      const stored = draft.grant?.escalation;
      if (!stored || (stored.maxConsultations !== null && stored.used >= stored.maxConsultations)) {
        return { ok: true, value: draft };
      }
      stored.used += 1;
      attempt = stored.used;
      if (target) {
        target.advisoryAttempts += 1;
      }
      return { ok: true, value: draft };
    });
  const release = () =>
    host.updateActiveMission((draft) => {
      const target = draft.auto?.blockers.find((entry) => entry.id === blocker.id);
      if (draft.grant?.escalation) {
        draft.grant.escalation.used = Math.max(0, draft.grant.escalation.used - 1);
      }
      if (target) {
        target.advisoryAttempts = Math.max(0, target.advisoryAttempts - 1);
      }
      return { ok: true, value: draft };
    });
  // Counted before the call: an attempt that was sent and failed still used its slot.
  if (!(await reserve()) || attempt === 0) {
    return;
  }
  let sent = false;
  let refused: string | null = null;
  let reserved = 0;
  let advice = '';
  let line: string;
  let entryId = '';
  // Bytes and the token bound are checked and recorded in one update before sending, so neither a reload nor a second consultation can undercount.
  const account = (bytes: number, tokens: number, check: boolean) =>
    host.updateActiveMission((draft) => {
      const stored = draft.grant?.escalation;
      if (!stored) {
        refused = 'its usage could not be recorded';
        return { ok: true, value: draft };
      }
      if (check) {
        refused = refuseOverLimit(stored, { maxConsultations: stored.maxConsultations, used: stored.used - 1, sentBytes: stored.sentBytes, usedTokens: stored.usedTokens }, bytes);
        if (refused !== null) {
          return { ok: true, value: draft };
        }
      }
      stored.sentBytes += bytes;
      stored.usedTokens = Math.max(0, stored.usedTokens + tokens);
      return { ok: true, value: draft };
    });
  // Revoking the pre-authorization aborts this request while the transport still can, from any window.
  const revocable = trackPreauthorized(binding.preauthId, mission.scopeId, host);
  // The pre-authorization's own token budget across Missions, reserved with the same bound (atomic, in the shared store).
  let budgetReserved = 0;
  const of = describeCount(escalation.maxConsultations);
  // Visible while it happens: the user sees that Meta is being consulted, which one, and how many remain.
  host.status = `Consulting Meta ${escalation.model} for advice (consultation ${attempt}${of}); only the bounded text shown in Remote advice is sent, and ${grant.model} keeps control.`;
  await host.postState();
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
          // Checked right before sending, on the stored policy: a revocation, expiry or change elsewhere stops it here.
          const now = metaRefusalNow(host, mission.scopeId, binding);
          if (now !== null || revocable.signal.aborted) {
            refused = `the pre-authorization no longer applies (${now ?? 'it was revoked'})`;
            throw new DOMException('Refused: the pre-authorization no longer applies.', 'AbortError');
          }
          const bytes = typeof init?.body === 'string' ? Buffer.byteLength(init.body, 'utf8') : Number.POSITIVE_INFINITY;
          reserved = Number.isFinite(bytes) ? tokenBound(bytes, escalation) : 0;
          if (!Number.isFinite(bytes) || !(await account(bytes, reserved, true)) || refused !== null) {
            refused ??= 'its size could not be measured';
            reserved = 0;
            throw new DOMException('Refused by a Mission Advisory limit.', 'AbortError');
          }
          const overBudget = await reserveMetaTokens(host, mission.scopeId, binding.preauthId, reserved).catch(() => 'the pre-authorization budget could not be recorded');
          if (overBudget !== null) {
            await account(-bytes, -reserved, false);
            refused = overBudget;
            reserved = 0;
            throw new DOMException('Refused by the pre-authorization budget.', 'AbortError');
          }
          budgetReserved = reserved;
          entryId = await recordExternal(host, mission.scopeId, {
            provider: META_PROVIDER, destination: escalation.model, reason: `Mission advice for ${blocker.commandId}: ${reason}`.slice(0, 300),
            data: `the Mission goal and current task, the host's notes on the run, the failing check and project decisions${fileNames.length > 0 ? `; files: ${fileNames.join(', ')}` : ''}`,
            approval: 'pre-authorized', preauthId: binding.preauthId, missionId, bytes,
          });
          sent = true;
          const signals = [init?.signal, revocable.signal].filter((entry): entry is AbortSignal => entry instanceof AbortSignal);
          return fetch(input, { ...init, signal: signals.length > 1 && typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : revocable.signal });
        },
      }),
    );
    host.recordUsage('cloud', result.usage);
    const actual = result.usage.inputTokens + result.usage.outputTokens;
    if (actual > 0) {
      await account(0, actual - reserved, false);
    }
    if (budgetReserved > 0) {
      await settleMetaTokens(host, mission.scopeId, binding.preauthId, budgetReserved, actual > 0 ? actual : budgetReserved);
    }
    advice = formatAdvisory(escalation.model, validateCascadeAdvice(JSON.parse(result.content) as unknown));
    host.cloudConfirmed = true;
    recordAdvisory(host, mission.threadId, escalation.model, { usage: result.usage });
    line = `remote advice for ${blocker.commandId} [${blocker.id}]: attempt ${attempt}${slash(escalation.maxConsultations)}, a valid answer from Meta ${escalation.model} (in ${result.usage.inputTokens} / out ${result.usage.outputTokens} tokens), kept as untrusted data; the blocker stays open until the host's run of ${blocker.commandId} passes`;
    await finishExternal(host, mission.scopeId, entryId, `answered (in ${result.usage.inputTokens} / out ${result.usage.outputTokens} tokens)`);
  } catch (error) {
    const failure = classifyMetaFailure(error, [apiKey]);
    host.cloudConfirmed = host.cloudConfirmed && failure.category !== 'authentication';
    recordAdvisory(host, mission.threadId, escalation.model, { error, sent });
    if (refused !== null) {
      // Nothing was sent: not counted, and the limit stays as the user set it.
      await release();
      line = `remote advice for ${blocker.commandId} [${blocker.id}]: not sent, because ${refused}; not counted, and the limit is not raised`;
    } else if (failure.category === 'cancelled' && !sent) {
      // Cancelled before anything was sent: not counted.
      await release();
      line = `remote advice for ${blocker.commandId} [${blocker.id}]: cancelled before sending; not counted`;
    } else if (revocable.signal.aborted) {
      line = `remote advice for ${blocker.commandId} [${blocker.id}]: attempt ${attempt}${slash(escalation.maxConsultations)} cancelled because the pre-authorization was revoked; what had already been sent cannot be taken back, and no advice was used`;
    } else {
      line = `remote advice for ${blocker.commandId} [${blocker.id}]: attempt ${attempt}${slash(escalation.maxConsultations)} failed: ${describeMetaFailure(failure)}; no advice used, not retried, and the blocker is unchanged`;
    }
    await finishExternal(host, mission.scopeId, entryId, revocable.signal.aborted ? 'cancelled: the pre-authorization was revoked' : `failed: ${describeMetaFailure(failure)}`.slice(0, 300));
  } finally {
    revocable.done();
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
  host.status = advice.length > 0
    ? `Meta ${escalation.model} answered (consultation ${attempt}${of}); ${grant.model} continues with the tools and the host's tests still decide.`
    : `Meta consultation ${attempt}${of}: no advice used (see the Mission record). ${grant.model} continues with the tools.`;
  await host.postState();
}

/**
 * A local Mission is blocked: offer (never send) a Meta consultation. The
 * exact text, built only from the Mission's goal and the host's notes on the
 * current task, is shown on the consultation card; nothing leaves this
 * computer until the user approves that text, and the user picks which
 * project files, if any, are added to it. The host's hidden descriptions
 * (expected values, the reference and its inputs) are never among them, and
 * the notes never carry seeds or reserved inputs. The main model stays the model
 * of the Mission: an answer is only kept for its next run if the user
 * retries it.
 */
export function offerMissionConsult(host: ProviderHost, missionId: string, root: string, scopeId: string, reason: string, failing: { commandId: string; text: string } | null = null): void {
  const mission = host.missions.get(missionId);
  const acceptance = mission?.grant?.acceptance ?? null;
  if (mission === null || mission.status !== 'blocked' || mission.auto === null || host.consultOffer !== null) {
    return;
  }
  const task = currentTask(mission);
  const hidden = new Set(acceptance?.scope?.hidden ?? []);
  const hostRecord = withoutWebLines(
    mission.evidence
      .filter((entry) => (task === null || entry.taskId === task.id) && (entry.kind === 'note' || entry.kind === 'host-record'))
      .slice(-30)
      .map((entry) => entry.text),
  );
  const files = [...new Set([...(acceptance?.scope?.writable ?? []), ...(acceptance?.files ?? []).map((file) => file.path)])]
    .filter((file) => !HOST_SPEC_FILE.test(file) && !hidden.has(file))
    .slice(0, 12);
  offerConsult(host, {
    threadId: mission.threadId,
    root,
    task: `${mission.goal}\nCurrent task: ${task?.title ?? ''}`,
    reason: `the Mission with ${mission.grant?.model ?? 'the local model'} is blocked: ${reason}`.slice(0, 600),
    hostRecord,
    scopeId,
    verifier: failing !== null ? { commandId: failing.commandId, exitCode: Number(/^exit=(\d+)/.exec(failing.text)?.[1] ?? NaN) || null } : acceptance ? { commandId: acceptance.commandId, exitCode: null } : null,
    ...(failing !== null ? { checkOutput: failing.text } : {}),
    missionId,
    files,
  });
}
