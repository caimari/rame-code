/** Host orchestration for the optional bootstrap acceptance review. */

import * as os from 'node:os';

import { hashContent } from './agentPatch.js';
import { checkAgentRelPath } from './agentPolicy.js';
import { redactSecrets, scrubLocalPaths } from './cloudEgress.js';
import { scopeIdForRoot } from './decisionStore.js';
import { createCascadeAdvice } from './meta-provider.js';
import { classifyMetaFailure, describeMetaFailure } from './metaFailures.js';
import { processingClass } from './metaRecipient.js';
import {
  ACCEPTANCE_REVIEW_DEFAULT_OUTPUT_TOKENS,
  ACCEPTANCE_REVIEW_DEFAULT_TOTAL_TOKENS,
  ACCEPTANCE_REVIEW_FILE_CHARS,
  ACCEPTANCE_REVIEW_MAX_FILES,
  acceptanceReviewDigest,
  acceptanceReviewSchema,
  acceptanceReviewTokenBound,
  ACCEPTANCE_REVIEW_SYSTEM_PROMPT,
  buildAcceptanceReviewPayload,
  validateAcceptanceReview,
  type MissionAcceptanceReview,
} from './missionAcceptanceReview.js';
import { recordAdvisory } from './modelEvidenceRecorder.js';
import type { MissionRecord } from './missionStore.js';
import { missionChangedFiles } from './missionPhase.js';
import { listAcceptanceCandidates } from './projectAdapters/npmProjectAdapter.js';
import type { ProviderHost } from './providerTypes.js';

const MIN_REQUEST_BYTES = 1000;
const MAX_REQUEST_BYTES = 24000;
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 8192;
const MIN_TOTAL_TOKENS = 1000;
const MAX_TOTAL_TOKENS = 200000;

async function missionScope(host: ProviderHost, mission: MissionRecord): Promise<{ root: string; fs: ReturnType<ProviderHost['agentFsFor']> } | null> {
  for (const folder of host.listOpenWorkspaceFolders()) {
    const fs = host.agentFsFor(folder.path);
    try {
      const canonical = await host.heldCanonicalRoot(folder.path, fs);
      if (scopeIdForRoot(canonical) === mission.scopeId) {
        return { root: folder.path, fs };
      }
    } catch {
      // An unreadable open folder cannot be the verified Mission scope.
    }
  }
  return null;
}

function addNote(mission: MissionRecord, text: string): void {
  const task = mission.tasks.find((entry) => entry.status === 'current');
  if (task) {
    mission.evidence.push({ taskId: task.id, kind: 'note', text: text.slice(0, 300), at: Date.now() });
  }
}

async function finish(host: ProviderHost, missionId: string, change: (mission: MissionRecord) => void): Promise<boolean> {
  const current = host.missions.get(missionId);
  if (current === null) return false;
  const updated = await host.missions.update(missionId, current.revision, (draft) => {
    change(draft);
    return { ok: true, value: draft };
  });
  host.status = updated.ok ? 'Mission acceptance review updated.' : updated.error;
  await host.refreshMemoryView();
  await host.postState();
  return updated.ok;
}

export interface PrepareAcceptanceReviewInput {
  missionId: string;
  revision: number;
  commandId: string;
  files: string[];
  maxConsultations?: number;
  maxRequestBytes?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
}

export type AcceptanceReviewHostMessage =
  | { type: 'acceptanceReviewPrepare'; missionId: string; revision: number; commandId: string; files: string[]; maxConsultations: number; maxRequestBytes: number | null; maxOutputTokens: number | null; maxTotalTokens: number | null }
  | { type: 'acceptanceReviewSend'; missionId: string; revision: number; digest: string }
  | { type: 'acceptanceReviewCancel'; missionId: string; revision: number; digest: string }
  | { type: 'acceptanceReviewDecide'; missionId: string; revision: number; digest: string; decision: 'considered' | 'dismissed' };

/** Single bounded dispatch point used by the main webview host. */
export async function handleAcceptanceReviewMessage(host: ProviderHost, message: AcceptanceReviewHostMessage): Promise<void> {
  if (message.type === 'acceptanceReviewPrepare') return prepareAcceptanceReview(host, {
    missionId: message.missionId, revision: message.revision, commandId: message.commandId, files: message.files, maxConsultations: message.maxConsultations,
    ...(message.maxRequestBytes === null ? {} : { maxRequestBytes: message.maxRequestBytes }),
    ...(message.maxOutputTokens === null ? {} : { maxOutputTokens: message.maxOutputTokens }),
    ...(message.maxTotalTokens === null ? {} : { maxTotalTokens: message.maxTotalTokens }),
  });
  if (message.type === 'acceptanceReviewSend') return sendAcceptanceReview(host, message.missionId, message.revision, message.digest);
  if (message.type === 'acceptanceReviewCancel') return cancelAcceptanceReview(host, message.missionId, message.revision, message.digest);
  return decideAcceptanceReview(host, message.missionId, message.revision, message.digest, message.decision);
}

/** Build and persist the exact preview. Nothing is sent. */
export async function prepareAcceptanceReview(host: ProviderHost, input: PrepareAcceptanceReviewInput): Promise<void> {
  const mission = host.missions.get(input.missionId);
  if (mission === null || mission.revision !== input.revision || mission.awaitingVerification !== true || mission.grant !== null) {
    host.status = 'This bootstrap Mission is not waiting for acceptance review. Nothing was sent.';
    await host.postState();
    return;
  }
  if (!host.settings.allowCloudEscalation || !host.hasKey) {
    host.status = 'Meta review needs cloud escalation enabled and a saved API key. Nothing was sent.';
    await host.postState();
    return;
  }
  const model = host.selectedCloudModel();
  if (processingClass(model) !== 'standard') {
    host.status = 'Independent acceptance review requires a Standard Meta model. Contributor and undocumented models are not used by default. Nothing was sent.';
    await host.postState();
    return;
  }
  const maxConsultations = input.maxConsultations ?? 1;
  const maxRequestBytes = input.maxRequestBytes ?? 12000;
  const maxOutputTokens = input.maxOutputTokens ?? ACCEPTANCE_REVIEW_DEFAULT_OUTPUT_TOKENS;
  const maxTotalTokens = input.maxTotalTokens ?? ACCEPTANCE_REVIEW_DEFAULT_TOTAL_TOKENS * maxConsultations;
  if (
    !Number.isInteger(maxConsultations) || maxConsultations < 1 || maxConsultations > 5 ||
    !Number.isInteger(maxRequestBytes) || maxRequestBytes < MIN_REQUEST_BYTES || maxRequestBytes > MAX_REQUEST_BYTES ||
    !Number.isInteger(maxOutputTokens) || maxOutputTokens < MIN_OUTPUT_TOKENS || maxOutputTokens > MAX_OUTPUT_TOKENS ||
    !Number.isInteger(maxTotalTokens) || maxTotalTokens < MIN_TOTAL_TOKENS || maxTotalTokens > MAX_TOTAL_TOKENS ||
    maxOutputTokens > maxTotalTokens
  ) {
    host.status = 'Invalid acceptance-review budget. Nothing was sent.';
    await host.postState();
    return;
  }
  const scope = await missionScope(host, mission);
  if (scope === null) {
    host.status = 'The Mission project is not open in this window. Nothing was sent.';
    await host.postState();
    return;
  }
  const testContext = await host.testCommandContext(scope.root);
  if (!testContext.allowlist.some((entry) => entry.id === input.commandId)) {
    host.status = 'Choose an allowlisted acceptance command before preparing the review. Nothing was sent.';
    await host.postState();
    return;
  }
  const chosen = [...new Set(input.files)].slice(0, ACCEPTANCE_REVIEW_MAX_FILES);
  if (chosen.length === 0) {
    host.status = 'Choose at least one proposed test file before preparing the review. Nothing was sent.';
    await host.postState();
    return;
  }
  const candidates = new Set(await listAcceptanceCandidates(scope.fs));
  if (chosen.some((path) => !candidates.has(path))) {
    host.status = 'A selected review file is not an offered acceptance candidate. Nothing was sent.';
    await host.postState();
    return;
  }
  const prepared: Array<{ path: string; hash: string; content: string; truncated: boolean }> = [];
  for (const raw of chosen) {
    const gate = checkAgentRelPath(raw);
    if (!gate.ok) {
      host.status = 'A selected review file is not a safe project-relative path. Nothing was sent.';
      await host.postState();
      return;
    }
    const path = (gate as { ok: true; rel: string }).rel;
    try {
      const original = await scope.fs.readText(path);
      const fragment = original.slice(0, ACCEPTANCE_REVIEW_FILE_CHARS);
      const redacted = redactSecrets(fragment).text;
      const content = scrubLocalPaths(redacted, [[scope.root, '<project folder>'], [os.homedir(), '~']]);
      prepared.push({ path, hash: hashContent(original), content, truncated: original.length > fragment.length });
    } catch {
      host.status = 'A selected review file could not be read. Nothing was sent.';
      await host.postState();
      return;
    }
  }
  const written = new Set(missionChangedFiles(mission));
  const modelFiles = prepared.filter((file) => written.has(file.path)).length;
  const provenance = modelFiles === prepared.length ? 'glimmer' as const : modelFiles === 0 ? 'user' as const : 'mixed' as const;
  // The same disclosure protections as the file fragments: the goal and the
  // criteria are user text too, and may carry local paths or secret-like values.
  const protect = (text: string) => scrubLocalPaths(redactSecrets(text).text, [[scope.root, '<project folder>'], [os.homedir(), '~']]);
  const payload = buildAcceptanceReviewPayload({
    goal: protect(mission.goal),
    criteria: mission.tasks.map((task) => ({ title: protect(task.title), successCriterion: protect(task.successCriterion) })),
    commandId: input.commandId,
    provenance,
    files: prepared,
  });
  const base = {
    version: 1 as const,
    missionId: mission.id,
    scopeId: mission.scopeId,
    model,
    processingClass: 'standard' as const,
    credentialRevision: host.metaCredential,
    commandId: input.commandId,
    files: prepared.map((file) => ({ path: file.path, hash: file.hash, chars: file.content.length, truncated: file.truncated })),
    provenance,
    payload,
    requestBytes: Buffer.byteLength(payload, 'utf8'),
    maxRequestBytes,
    maxConsultations,
    maxOutputTokens,
    maxTotalTokens,
  };
  const previous = mission.acceptanceReview;
  const attempts = previous?.attempts ?? 0;
  const usedTokens = previous?.usedTokens ?? 0;
  if (attempts >= maxConsultations || usedTokens >= maxTotalTokens) {
    host.status = 'The authorized acceptance-review consultation or token budget is already exhausted. Nothing was sent.';
    await host.postState();
    return;
  }
  const review: MissionAcceptanceReview = {
    ...base,
    digest: acceptanceReviewDigest(base),
    attempts,
    sentBytes: previous?.sentBytes ?? 0,
    usedTokens,
    status: 'offered',
    decision: 'pending',
    result: null,
    failure: '',
    updatedAt: Date.now(),
  };
  const updated = await host.missions.update(mission.id, mission.revision, (draft) => {
    draft.acceptanceReview = review;
    addNote(draft, `acceptance review prepared for Meta ${model}: ${review.files.length} selected test file(s), ${review.requestBytes} content bytes; nothing sent`);
    return { ok: true, value: draft };
  });
  host.status = updated.ok ? 'Review prepared. Inspect the exact content before sending it to Meta.' : updated.error;
  await host.refreshMemoryView();
  await host.postState();
}

/** Send one previously previewed review. The request has no tools. */
export async function sendAcceptanceReview(host: ProviderHost, missionId: string, revision: number, digest: string): Promise<void> {
  const mission = host.missions.get(missionId);
  const review = mission?.acceptanceReview ?? null;
  if (
    mission === null || mission.revision !== revision || mission.awaitingVerification !== true || review === null || review.status !== 'offered' || review.attempts >= review.maxConsultations ||
    review.digest !== digest || review.model !== host.selectedCloudModel() || review.credentialRevision !== host.metaCredential || processingClass(review.model) !== 'standard'
  ) {
    host.status = 'The acceptance-review approval is stale or does not match this Mission, project, model, credential, content, and budget. Nothing was sent.';
    await host.postState();
    return;
  }
  const apiKey = await host.getApiKey();
  if (!apiKey || !host.settings.allowCloudEscalation) {
    host.status = 'Meta review is no longer configured. Nothing was sent.';
    await host.postState();
    return;
  }
  const marked = await host.missions.update(mission.id, mission.revision, (draft) => {
    if (!draft.acceptanceReview || draft.acceptanceReview.digest !== digest) return { ok: false, error: 'The review changed before sending.' };
    draft.acceptanceReview.status = 'sending';
    draft.acceptanceReview.attempts += 1;
    draft.acceptanceReview.updatedAt = Date.now();
    addNote(draft, `acceptance review send authorized for Meta ${review.model} (digest ${digest.slice(0, 12)}…); no tools granted`);
    return { ok: true, value: draft };
  });
  if (!marked.ok) {
    host.status = marked.error;
    await host.postState();
    return;
  }
  let sent = false;
  let refused = '';
  let reservedBound = 0;
  try {
    const response = await host.chatRunner.start(async ({ signal }) =>
      createCascadeAdvice({
        apiKey,
        model: review.model,
        payload: review.payload,
        schema: acceptanceReviewSchema,
        systemPrompt: ACCEPTANCE_REVIEW_SYSTEM_PROMPT,
        generation: { maxCompletionTokens: review.maxOutputTokens, reasoning: null, reasoningParam: null },
        signal,
        fetchImpl: async (input, init) => {
          const bytes = typeof init?.body === 'string' ? Buffer.byteLength(init.body, 'utf8') : Number.POSITIVE_INFINITY;
          const bound = acceptanceReviewTokenBound(bytes, review.maxOutputTokens);
          reservedBound = bound;
          if (bytes > review.maxRequestBytes) refused = `the exact HTTP request is ${bytes} bytes and the authorized limit is ${review.maxRequestBytes}`;
          else if (review.usedTokens + bound > review.maxTotalTokens) refused = `the requests could use up to ${review.usedTokens + bound} tokens and the authorized total is ${review.maxTotalTokens}`;
          if (refused) throw new DOMException('Refused by the acceptance-review budget.', 'AbortError');
          const latest = host.missions.get(missionId);
          if (!latest?.acceptanceReview || latest.acceptanceReview.digest !== digest || latest.acceptanceReview.status !== 'sending') {
            throw new DOMException('Review state changed before sending.', 'AbortError');
          }
          const accounted = await host.missions.update(missionId, latest.revision, (draft) => {
            if (!draft.acceptanceReview) return { ok: false, error: 'Review state missing.' };
            draft.acceptanceReview.sentBytes += bytes;
            draft.acceptanceReview.usedTokens += bound;
            draft.acceptanceReview.updatedAt = Date.now();
            return { ok: true, value: draft };
          });
          if (!accounted.ok) throw new DOMException('Review usage could not be recorded.', 'AbortError');
          sent = true;
          return fetch(input, init);
        },
      }),
    );
    const result = validateAcceptanceReview(JSON.parse(response.content) as unknown);
    host.recordUsage('cloud', response.usage);
    host.cloudConfirmed = true;
    recordAdvisory(host, mission.threadId, review.model, { usage: response.usage });
    await finish(host, missionId, (draft) => {
      if (!draft.acceptanceReview || draft.acceptanceReview.digest !== digest) return;
      draft.acceptanceReview.status = 'completed';
      draft.acceptanceReview.result = result;
      draft.acceptanceReview.usedTokens = Math.max(0, draft.acceptanceReview.usedTokens - reservedBound) + response.usage.inputTokens + response.usage.outputTokens;
      draft.acceptanceReview.failure = '';
      draft.acceptanceReview.updatedAt = Date.now();
      addNote(draft, `Meta ${review.model} returned an independent acceptance review; it remains untrusted advice and changed no files, permissions, or criteria`);
    });
  } catch (error) {
    const malformed = error instanceof SyntaxError || (error instanceof Error && /acceptance review|unexpected fields|requirements|recommendation/.test(error.message));
    const failure = classifyMetaFailure(error, [apiKey]);
    recordAdvisory(host, mission.threadId, review.model, { error, sent });
    await finish(host, missionId, (draft) => {
      if (!draft.acceptanceReview || draft.acceptanceReview.digest !== digest) return;
      if (!sent) draft.acceptanceReview.attempts = Math.max(0, draft.acceptanceReview.attempts - 1);
      draft.acceptanceReview.status = refused ? 'budget-refused' : malformed ? 'malformed' : 'failed';
      draft.acceptanceReview.failure = refused || (malformed ? 'Meta returned a malformed acceptance review; no observations were used.' : describeMetaFailure(failure));
      draft.acceptanceReview.updatedAt = Date.now();
      addNote(draft, `acceptance review ${draft.acceptanceReview.status}: ${draft.acceptanceReview.failure}; the user may continue locally`);
    });
  }
}

export async function cancelAcceptanceReview(host: ProviderHost, missionId: string, revision: number, digest: string): Promise<void> {
  const mission = host.missions.get(missionId);
  if (mission === null || mission.revision !== revision || mission.acceptanceReview?.digest !== digest || mission.acceptanceReview.status !== 'offered') {
    host.status = 'That acceptance-review offer is no longer current.';
    await host.postState();
    return;
  }
  await finish(host, missionId, (draft) => {
    if (!draft.acceptanceReview) return;
    draft.acceptanceReview.status = 'cancelled';
    draft.acceptanceReview.failure = 'Cancelled by the user before sending; Meta received nothing.';
    draft.acceptanceReview.updatedAt = Date.now();
    addNote(draft, 'acceptance review cancelled before sending; Meta received nothing');
  });
}

export async function decideAcceptanceReview(
  host: ProviderHost,
  missionId: string,
  revision: number,
  digest: string,
  decision: 'considered' | 'dismissed',
): Promise<void> {
  const mission = host.missions.get(missionId);
  if (mission === null || mission.revision !== revision || mission.acceptanceReview?.digest !== digest || mission.acceptanceReview.status !== 'completed') {
    host.status = 'That acceptance review is no longer current.';
    await host.postState();
    return;
  }
  await finish(host, missionId, (draft) => {
    if (!draft.acceptanceReview) return;
    draft.acceptanceReview.decision = decision;
    draft.acceptanceReview.updatedAt = Date.now();
    addNote(draft, decision === 'considered' ? 'user considered the Spark review before selecting final acceptance criteria' : 'user rejected the Spark suggestions; no criteria were changed');
  });
}
