/**
 * Model evidence: which model and runtime answered each inference, and the
 * host facts that inference links to (its tool calls, the host action taken
 * for each, and the checks the host ran afterwards).
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * Only host facts are kept: identifiers, enums, counts, a model file's
 * basename, and digests. Messages, prompts, reasoning, tool arguments, file
 * contents, replies, absolute paths, and credentials are never stored: the
 * reply stays in the conversation and the exact action in Activity; this
 * record only links them. A link is recorded only when the host can make it
 * by ids or by its own state; order alone is shown as "afterwards", never as
 * a cause.
 *
 * Storage contract: one versioned key, bounded per thread and in threads,
 * validated on load. Anything unreadable is dropped whole (never partly
 * rebuilt), and nothing in it is ever replayed.
 */

export const MODEL_EVIDENCE_KEY = 'rameCode.modelEvidence.v1';
export const MODEL_EVIDENCE_VERSION = 1;
export const MAX_EVIDENCE_THREADS = 30;
export const MAX_INFERENCES_PER_THREAD = 40;
export const MAX_TOOL_CALLS_PER_INFERENCE = 8;
export const MAX_EVIDENCE_MODEL_LENGTH = 96;
/** Shown per thread: decisive inferences, then the rest one level further down. */
export const MAX_DECISIVE_SHOWN = 12;
export const MAX_OTHER_SHOWN = 12;

export type EvidenceProvider = 'local' | 'cloud';
/** configured: settings only. running: the process or endpoint was up. response-observed: it answered this inference. */
export type EvidenceIdentity = 'configured' | 'running' | 'response-observed';
/** rame-launched: RAME spawned llama-server with these arguments. external-endpoint: identity not verified. */
export type EvidenceRuntimeKind = 'rame-launched' | 'external-endpoint' | 'not-running' | 'meta-api';
export type EvidenceTemplate = 'muse-glimmer' | 'other' | 'unknown';
/** local: Glimmer. selected: the user chose Meta as the runtime. advisory / delegated: the Meta authority the user approved. */
export type EvidenceAuthority = 'local' | 'selected' | 'advisory' | 'delegated';
export type EvidenceMode = 'agent' | 'mission' | 'chat';
export type EvidenceRequest = 'agent-step' | 'chat' | 'plan' | 'advisory';
/** invalid: the server answered but the host refused the output (cut off, malformed). failed: no usable answer. */
export type EvidenceResponse = 'text' | 'tool-calls' | 'invalid' | 'failed';
export type EvidenceFinish = 'stop' | 'tool_calls' | 'length' | 'other';
export type EvidenceApproval = 'human' | 'profile' | 'mission-grant';
export type EvidenceActionResult =
  | 'applied'
  | 'blocked-by-policy'
  | 'not-proposed'
  | 'did-not-run'
  | 'rejected-by-user'
  | 'approval-invalidated';

export const EVIDENCE_FAILURES = [
  'authentication', 'credit', 'rate-limit', 'network', 'timeout', 'invalid-response', 'remote-error', 'unknown',
  'unreachable', 'local-error', 'cut-off', 'malformed-tool-call', 'invalid-arguments',
] as const;
export type EvidenceFailure = (typeof EVIDENCE_FAILURES)[number];

export interface EvidenceRuntime {
  kind: EvidenceRuntimeKind;
  /** GGUF basename passed with -m, the model id RAME requested from an external endpoint, or the Meta model. */
  model: string;
  contextConfigured: number | null;
  /** Per-slot context from the server's /props, when it answered. */
  contextConfirmed: number | null;
  template: EvidenceTemplate;
  /** Passed at launch (--mmproj / --model-draft); not a claim that they loaded. */
  projector: boolean;
  draft: boolean;
}

export interface EvidenceAction {
  /** The Activity digest of the action (sha256 hex), when the host computed one. */
  digest: string | null;
  approval: EvidenceApproval | null;
  result: EvidenceActionResult;
  write: boolean;
  /** run_tests only: the command and its exit code. */
  commandId: string | null;
  exitCode: number | null;
}

/** The first check the host ran after this change, in the same run. */
export interface EvidenceVerification {
  inferenceId: string;
  n: number;
  commandId: string;
  exitCode: number | null;
}

export interface EvidenceToolCall {
  /** Position in the inference's reply, from 1: the host's own key. */
  n: number;
  /** The protocol id, only when it is a plain identifier. */
  callId: string | null;
  tool: string;
  action: EvidenceAction | null;
  verification: EvidenceVerification | null;
}

export interface InferenceEvidence {
  inferenceId: string;
  seq: number;
  at: number;
  run: number;
  provider: EvidenceProvider;
  runtime: EvidenceRuntime;
  identity: EvidenceIdentity;
  authority: EvidenceAuthority;
  mode: EvidenceMode;
  mission: { missionId: string; run: number | null; step: number | null } | null;
  request: EvidenceRequest;
  response: EvidenceResponse;
  failure: EvidenceFailure | null;
  usage: { input: number; output: number } | null;
  finish: EvidenceFinish | null;
  toolCalls: EvidenceToolCall[];
  final: boolean;
}

export interface ThreadEvidence {
  threadId: string;
  updatedAt: number;
  nextSeq: number;
  runs: number;
  inferences: InferenceEvidence[];
}

export interface ModelEvidenceState {
  version: 1;
  threads: ThreadEvidence[];
}

/** What RAME passed to the llama-server it launched (basename and flags only). */
export interface LocalLaunchFacts {
  endpoint: string;
  model: string;
  contextSize: number;
  projector: boolean;
  draft: boolean;
}

export function launchFacts(settings: { modelPath: string; contextSize: number; projectorPath: string; draftModelPath: string; port: number }): LocalLaunchFacts {
  return {
    endpoint: `http://127.0.0.1:${settings.port}`,
    model: evidenceModelName(settings.modelPath) || 'unknown',
    contextSize: settings.contextSize,
    projector: settings.projectorPath.length > 0,
    draft: settings.draftModelPath.length > 0,
  };
}

/** The stored record, plus which providers answered a real inference in this session. */
export class ModelEvidenceStore {
  state: ModelEvidenceState;
  readonly discarded: boolean;
  readonly observed = { local: false, cloud: false };

  constructor(private readonly backend: { get(key: string): unknown; update(key: string, value: unknown): unknown }) {
    const loaded = loadModelEvidence(backend.get(MODEL_EVIDENCE_KEY));
    this.state = loaded.state;
    this.discarded = loaded.discarded > 0;
  }

  persist(): void {
    void this.backend.update(MODEL_EVIDENCE_KEY, this.state);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set(['list_files', 'inspect_workspace', 'filesystem_usage', 'search_history', 'search_text', 'read_file', 'read_decisions']);
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const TOOL = /^[a-z_]{1,40}$/;
const COMMAND = /^[A-Za-z0-9:._@/-]{1,80}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function count(value: unknown, max = 100_000_000): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function countOrNull(value: unknown, max?: number): value is number | null {
  return value === null || count(value, max);
}

/** A model name fit for display: no path, no controls, bounded. */
export function evidenceModelName(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? '';
  return base.replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, MAX_EVIDENCE_MODEL_LENGTH);
}

function validModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === evidenceModelName(value);
}

function validRuntime(value: unknown): value is EvidenceRuntime {
  return (
    isRecord(value) &&
    exactKeys(value, ['kind', 'model', 'contextConfigured', 'contextConfirmed', 'template', 'projector', 'draft']) &&
    oneOf(value.kind, ['rame-launched', 'external-endpoint', 'not-running', 'meta-api'] as const) &&
    validModel(value.model) &&
    countOrNull(value.contextConfigured, 16_777_216) &&
    countOrNull(value.contextConfirmed, 16_777_216) &&
    oneOf(value.template, ['muse-glimmer', 'other', 'unknown'] as const) &&
    typeof value.projector === 'boolean' &&
    typeof value.draft === 'boolean'
  );
}

function validAction(value: unknown): value is EvidenceAction | null {
  if (value === null) {
    return true;
  }
  return (
    isRecord(value) &&
    exactKeys(value, ['digest', 'approval', 'result', 'write', 'commandId', 'exitCode']) &&
    (value.digest === null || (typeof value.digest === 'string' && DIGEST.test(value.digest))) &&
    (value.approval === null || oneOf(value.approval, ['human', 'profile', 'mission-grant'] as const)) &&
    oneOf(value.result, ['applied', 'blocked-by-policy', 'not-proposed', 'did-not-run', 'rejected-by-user', 'approval-invalidated'] as const) &&
    typeof value.write === 'boolean' &&
    (value.commandId === null || (typeof value.commandId === 'string' && COMMAND.test(value.commandId))) &&
    countOrNull(value.exitCode, 255)
  );
}

function validVerification(value: unknown): value is EvidenceVerification | null {
  if (value === null) {
    return true;
  }
  return (
    isRecord(value) &&
    exactKeys(value, ['inferenceId', 'n', 'commandId', 'exitCode']) &&
    typeof value.inferenceId === 'string' &&
    ID.test(value.inferenceId) &&
    count(value.n, MAX_TOOL_CALLS_PER_INFERENCE) &&
    typeof value.commandId === 'string' &&
    COMMAND.test(value.commandId) &&
    countOrNull(value.exitCode, 255)
  );
}

function validToolCall(value: unknown): value is EvidenceToolCall {
  return (
    isRecord(value) &&
    exactKeys(value, ['n', 'callId', 'tool', 'action', 'verification']) &&
    count(value.n, MAX_TOOL_CALLS_PER_INFERENCE) &&
    value.n >= 1 &&
    (value.callId === null || (typeof value.callId === 'string' && ID.test(value.callId))) &&
    typeof value.tool === 'string' &&
    TOOL.test(value.tool) &&
    validAction(value.action) &&
    validVerification(value.verification)
  );
}

/** Validate one stored or posted inference record; anything else is refused. */
export function isValidInference(value: unknown): value is InferenceEvidence {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'inferenceId', 'seq', 'at', 'run', 'provider', 'runtime', 'identity', 'authority', 'mode', 'mission',
      'request', 'response', 'failure', 'usage', 'finish', 'toolCalls', 'final',
    ])
  ) {
    return false;
  }
  const mission = value.mission;
  const usage = value.usage;
  const failed = value.response === 'failed';
  return (
    typeof value.inferenceId === 'string' &&
    ID.test(value.inferenceId) &&
    count(value.seq) &&
    value.seq >= 1 &&
    count(value.at, 8_640_000_000_000_000) &&
    count(value.run) &&
    oneOf(value.provider, ['local', 'cloud'] as const) &&
    validRuntime(value.runtime) &&
    (value.provider === 'cloud') === (value.runtime.kind === 'meta-api') &&
    oneOf(value.identity, ['configured', 'running', 'response-observed'] as const) &&
    // A failure is never a response observed; an answer always is.
    (failed ? value.identity !== 'response-observed' : value.identity === 'response-observed') &&
    oneOf(value.authority, ['local', 'selected', 'advisory', 'delegated'] as const) &&
    (value.provider === 'local') === (value.authority === 'local') &&
    oneOf(value.mode, ['agent', 'mission', 'chat'] as const) &&
    (mission === null ||
      (isRecord(mission) &&
        exactKeys(mission, ['missionId', 'run', 'step']) &&
        typeof mission.missionId === 'string' &&
        ID.test(mission.missionId) &&
        countOrNull(mission.run, 10_000) &&
        countOrNull(mission.step, 10_000))) &&
    oneOf(value.request, ['agent-step', 'chat', 'plan', 'advisory'] as const) &&
    oneOf(value.response, ['text', 'tool-calls', 'invalid', 'failed'] as const) &&
    (value.failure === null) === (value.response !== 'failed' && value.response !== 'invalid') &&
    (value.failure === null || oneOf(value.failure, EVIDENCE_FAILURES)) &&
    (usage === null || (isRecord(usage) && exactKeys(usage, ['input', 'output']) && count(usage.input) && count(usage.output))) &&
    (value.finish === null || oneOf(value.finish, ['stop', 'tool_calls', 'length', 'other'] as const)) &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.length <= MAX_TOOL_CALLS_PER_INFERENCE &&
    value.toolCalls.every(validToolCall) &&
    (value.response === 'tool-calls') === (value.toolCalls.length > 0) &&
    typeof value.final === 'boolean'
  );
}

function validThread(value: unknown): value is ThreadEvidence {
  return (
    isRecord(value) &&
    exactKeys(value, ['threadId', 'updatedAt', 'nextSeq', 'runs', 'inferences']) &&
    typeof value.threadId === 'string' &&
    ID.test(value.threadId) &&
    count(value.updatedAt, 8_640_000_000_000_000) &&
    count(value.nextSeq) &&
    count(value.runs) &&
    Array.isArray(value.inferences) &&
    value.inferences.length <= MAX_INFERENCES_PER_THREAD &&
    value.inferences.every(isValidInference) &&
    value.inferences.every((entry) => (entry as InferenceEvidence).seq < (value.nextSeq as number))
  );
}

/**
 * Validate untrusted stored evidence. A wrong version or shape yields an
 * empty record; a thread with any unreadable part is dropped whole.
 */
export function loadModelEvidence(raw: unknown): { state: ModelEvidenceState; discarded: number } {
  if (raw === undefined) {
    return { state: { version: 1, threads: [] }, discarded: 0 };
  }
  if (!isRecord(raw) || !exactKeys(raw, ['version', 'threads']) || raw.version !== MODEL_EVIDENCE_VERSION || !Array.isArray(raw.threads)) {
    return { state: { version: 1, threads: [] }, discarded: 1 };
  }
  const threads: ThreadEvidence[] = [];
  let discarded = 0;
  const seen = new Set<string>();
  for (const candidate of raw.threads) {
    if (!validThread(candidate) || seen.has(candidate.threadId)) {
      discarded += 1;
      continue;
    }
    seen.add(candidate.threadId);
    threads.push(structuredClone(candidate));
  }
  threads.sort((a, b) => b.updatedAt - a.updatedAt);
  discarded += Math.max(0, threads.length - MAX_EVIDENCE_THREADS);
  return { state: { version: 1, threads: threads.slice(0, MAX_EVIDENCE_THREADS) }, discarded };
}

// ---------------------------------------------------------------------------
// Updates (pure: each returns nothing and changes the given state in place)
// ---------------------------------------------------------------------------

/** Proposed tools, the final reply, Meta, and anything a check ran after are decisive; reads alone are not. */
export function isDecisive(entry: InferenceEvidence): boolean {
  return (
    entry.final ||
    entry.authority === 'advisory' ||
    entry.authority === 'delegated' ||
    entry.request === 'plan' ||
    entry.toolCalls.some((call) => !READ_TOOLS.has(call.tool) || call.verification !== null)
  );
}

function threadOf(state: ModelEvidenceState, threadId: string, now: number): ThreadEvidence {
  let thread = state.threads.find((entry) => entry.threadId === threadId);
  if (thread === undefined) {
    thread = { threadId, updatedAt: now, nextSeq: 1, runs: 0, inferences: [] };
    state.threads.unshift(thread);
    state.threads.splice(MAX_EVIDENCE_THREADS);
  }
  thread.updatedAt = now;
  return thread;
}

/** Start a new run in a thread (an Agent run, a chat reply, a consultation); returns its number. */
export function beginEvidenceRun(state: ModelEvidenceState, threadId: string, now: number): number {
  const thread = threadOf(state, threadId, now);
  thread.runs += 1;
  return thread.runs;
}

export type NewInference = Omit<InferenceEvidence, 'inferenceId' | 'seq' | 'at' | 'toolCalls' | 'final'> & {
  toolCalls: Array<{ callId: string; tool: string }>;
  final?: boolean;
};

/**
 * Record one inference. The oldest exploratory entries make room first, so a
 * long Mission keeps its decisive chain. Returns the id, or null if the
 * input does not validate (nothing is stored then).
 */
export function appendInference(state: ModelEvidenceState, threadId: string, input: NewInference, now: number): string | null {
  if (!ID.test(threadId)) {
    return null;
  }
  const thread = threadOf(state, threadId, now);
  const seq = Math.max(1, thread.nextSeq);
  const entry: InferenceEvidence = {
    inferenceId: `inf-${seq}`,
    seq,
    at: now,
    run: input.run,
    provider: input.provider,
    runtime: { ...input.runtime, model: evidenceModelName(input.runtime.model) || 'unknown' },
    identity: input.identity,
    authority: input.authority,
    mode: input.mode,
    mission: input.mission,
    request: input.request,
    response: input.response,
    failure: input.failure,
    usage: input.usage,
    finish: input.finish,
    toolCalls: input.toolCalls.slice(0, MAX_TOOL_CALLS_PER_INFERENCE).map((call, index) => ({
      n: index + 1,
      callId: ID.test(call.callId) ? call.callId : null,
      tool: TOOL.test(call.tool) ? call.tool : 'unknown_tool',
      action: null,
      verification: null,
    })),
    final: input.final === true,
  };
  if (!isValidInference(entry)) {
    return null;
  }
  thread.nextSeq = seq + 1;
  thread.inferences.push(entry);
  while (thread.inferences.length > MAX_INFERENCES_PER_THREAD) {
    const exploratory = thread.inferences.findIndex((candidate) => !isDecisive(candidate));
    thread.inferences.splice(exploratory === -1 ? 0 : exploratory, 1);
  }
  return entry.inferenceId;
}

function findCall(state: ModelEvidenceState, threadId: string, inferenceId: string, n: number): { entry: InferenceEvidence; call: EvidenceToolCall } | null {
  const entry = state.threads.find((thread) => thread.threadId === threadId)?.inferences.find((candidate) => candidate.inferenceId === inferenceId);
  const call = entry?.toolCalls.find((candidate) => candidate.n === n);
  return entry && call ? { entry, call } : null;
}

/**
 * Link the host's action to the tool call that proposed it. When the action
 * was a check (run_tests) that ran, the earlier changes of the same run that
 * no check followed yet are linked to it, as "checked afterwards".
 */
export function linkEvidenceAction(
  state: ModelEvidenceState,
  threadId: string,
  inferenceId: string,
  n: number,
  action: EvidenceAction,
): boolean {
  const found = findCall(state, threadId, inferenceId, n);
  if (found === null || found.call.action !== null || !validAction(action)) {
    return false;
  }
  found.call.action = { ...action };
  if (action.result === 'applied' && action.commandId !== null) {
    const thread = state.threads.find((entry) => entry.threadId === threadId) as ThreadEvidence;
    for (const earlier of thread.inferences) {
      if (earlier.run !== found.entry.run || earlier.seq > found.entry.seq) {
        continue;
      }
      for (const call of earlier.toolCalls) {
        if (call.action?.write === true && call.action.result === 'applied' && call.verification === null && (earlier.seq < found.entry.seq || call.n < n)) {
          call.verification = { inferenceId, n, commandId: action.commandId, exitCode: action.exitCode };
        }
      }
    }
  }
  return true;
}

/** Mark the inference whose reply the host stored as the run's final answer. */
export function markEvidenceFinal(state: ModelEvidenceState, threadId: string, inferenceId: string): void {
  const entry = state.threads.find((thread) => thread.threadId === threadId)?.inferences.find((candidate) => candidate.inferenceId === inferenceId);
  if (entry !== undefined && entry.response === 'text') {
    entry.final = true;
  }
}

/** Forget the evidence of threads that no longer exist. */
export function pruneEvidence(state: ModelEvidenceState, liveThreadIds: ReadonlySet<string>): boolean {
  const before = state.threads.length;
  state.threads = state.threads.filter((thread) => liveThreadIds.has(thread.threadId));
  return state.threads.length !== before;
}

// ---------------------------------------------------------------------------
// View and Mission summary
// ---------------------------------------------------------------------------

export type AcceptanceEvidence = 'none' | 'not_run' | 'passed' | 'failed' | 'tampered';

export interface EvidenceNowView {
  local: {
    /** Settings only: GGUF basename (owned server) or requested model id (external endpoint). */
    configured: { kind: 'owned' | 'external'; model: string; context: number | null; projector: boolean; draft: boolean } | null;
    running: { kind: 'rame-launched' | 'external-endpoint'; contextConfirmed: number | null; template: EvidenceTemplate } | null;
    observed: boolean;
  };
  cloud: { model: string; keyStored: boolean; observed: boolean };
}

export interface EvidenceMissionView {
  status: string;
  completedByHost: boolean;
  acceptance: AcceptanceEvidence;
  acceptanceCommand: string | null;
  lastCommand: { commandId: string; exitCode: number | null } | null;
}

export interface ModelEvidenceView {
  now: EvidenceNowView;
  decisive: InferenceEvidence[];
  other: InferenceEvidence[];
  /** Exploratory inferences recorded but not shown. */
  otherHidden: number;
  total: number;
  mission: EvidenceMissionView | null;
  discarded: boolean;
}

/** The thread's evidence for the view: decisive first, the rest bounded one level down. */
export function buildEvidenceView(
  state: ModelEvidenceState,
  threadId: string | null,
  now: EvidenceNowView,
  mission: EvidenceMissionView | null,
  discarded: boolean,
): ModelEvidenceView {
  const inferences = state.threads.find((thread) => thread.threadId === threadId)?.inferences ?? [];
  const decisive = inferences.filter(isDecisive);
  const other = inferences.filter((entry) => !isDecisive(entry));
  return {
    now,
    decisive: decisive.slice(-MAX_DECISIVE_SHOWN).map((entry) => structuredClone(entry)),
    other: other.slice(-MAX_OTHER_SHOWN).map((entry) => structuredClone(entry)),
    otherHidden: Math.max(0, other.length - MAX_OTHER_SHOWN),
    total: inferences.length,
    mission,
    discarded,
  };
}

const NOW_VIEW_EMPTY: EvidenceNowView = {
  local: { configured: null, running: null, observed: false },
  cloud: { model: 'unknown', keyStored: false, observed: false },
};

export const EMPTY_EVIDENCE_VIEW: ModelEvidenceView = {
  now: NOW_VIEW_EMPTY,
  decisive: [],
  other: [],
  otherHidden: 0,
  total: 0,
  mission: null,
  discarded: false,
};

function sanitizeNow(value: unknown): EvidenceNowView {
  if (!isRecord(value) || !isRecord(value.local) || !isRecord(value.cloud)) {
    return structuredClone(NOW_VIEW_EMPTY);
  }
  const configured = value.local.configured;
  const running = value.local.running;
  return {
    local: {
      configured:
        isRecord(configured) && oneOf(configured.kind, ['owned', 'external'] as const) && typeof configured.model === 'string'
          ? {
              kind: configured.kind,
              model: evidenceModelName(configured.model) || 'unknown',
              context: count(configured.context, 16_777_216) ? configured.context : null,
              projector: configured.projector === true,
              draft: configured.draft === true,
            }
          : null,
      running:
        isRecord(running) && oneOf(running.kind, ['rame-launched', 'external-endpoint'] as const)
          ? {
              kind: running.kind,
              contextConfirmed: count(running.contextConfirmed, 16_777_216) ? running.contextConfirmed : null,
              template: oneOf(running.template, ['muse-glimmer', 'other', 'unknown'] as const) ? running.template : 'unknown',
            }
          : null,
      observed: value.local.observed === true,
    },
    cloud: {
      model: typeof value.cloud.model === 'string' ? evidenceModelName(value.cloud.model) || 'unknown' : 'unknown',
      keyStored: value.cloud.keyStored === true,
      observed: value.cloud.observed === true,
    },
  };
}

function sanitizeMission(value: unknown): EvidenceMissionView | null {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return null;
  }
  const last = value.lastCommand;
  return {
    status: value.status.replace(/[^a-z_]/g, '').slice(0, 24),
    completedByHost: value.completedByHost === true,
    acceptance: oneOf(value.acceptance, ['none', 'not_run', 'passed', 'failed', 'tampered'] as const) ? value.acceptance : 'none',
    acceptanceCommand: typeof value.acceptanceCommand === 'string' && COMMAND.test(value.acceptanceCommand) ? value.acceptanceCommand : null,
    lastCommand:
      isRecord(last) && typeof last.commandId === 'string' && COMMAND.test(last.commandId) && countOrNull(last.exitCode, 255)
        ? { commandId: last.commandId, exitCode: last.exitCode }
        : null,
  };
}

/** Re-validate the view at the webview boundary: invalid entries are dropped, never repaired. */
export function sanitizeEvidenceView(value: unknown): ModelEvidenceView {
  if (!isRecord(value)) {
    return structuredClone(EMPTY_EVIDENCE_VIEW);
  }
  const list = (raw: unknown, max: number): InferenceEvidence[] =>
    Array.isArray(raw) ? raw.filter(isValidInference).slice(-max).map((entry) => structuredClone(entry)) : [];
  return {
    now: sanitizeNow(value.now),
    decisive: list(value.decisive, MAX_DECISIVE_SHOWN),
    other: list(value.other, MAX_OTHER_SHOWN),
    otherHidden: count(value.otherHidden, MAX_INFERENCES_PER_THREAD) ? value.otherHidden : 0,
    total: count(value.total, MAX_INFERENCES_PER_THREAD) ? value.total : 0,
    mission: sanitizeMission(value.mission),
    discarded: value.discarded === true,
  };
}

/** Two host-record lines for the Mission's final report: models, counts, links, checks. */
export function missionEvidenceLines(state: ModelEvidenceState, threadId: string, missionId: string): string[] {
  const entries = (state.threads.find((thread) => thread.threadId === threadId)?.inferences ?? []).filter(
    (entry) => entry.mission?.missionId === missionId,
  );
  if (entries.length === 0) {
    return ['mission: model evidence — no inference of this Mission is recorded'];
  }
  const models = [...new Set(entries.map((entry) => `${entry.provider === 'cloud' ? 'Meta' : entry.runtime.kind === 'external-endpoint' ? 'endpoint' : 'local'} ${entry.runtime.model}`))];
  const local = entries.filter((entry) => entry.provider === 'local');
  const meta = entries.filter((entry) => entry.provider === 'cloud');
  const calls = entries.flatMap((entry) => entry.toolCalls);
  const checks = [...new Set(calls.filter((call) => call.action?.commandId != null && call.action.result === 'applied').map((call) => `${call.action?.commandId} exit=${call.action?.exitCode ?? 'unknown'}`))];
  return [
    `mission: model evidence — ${models.slice(0, 3).join('; ')}; ${local.length} local inference(s), ${local.filter((entry) => entry.identity === 'response-observed').length} with a response observed; ${meta.length} Meta consultation(s) (${meta.filter((entry) => entry.identity === 'response-observed').length} answered)`,
    `mission: ${calls.filter((call) => call.action !== null).length}/${calls.length} proposed tool call(s) linked to a host action; checks the host ran: ${checks.length > 0 ? checks.slice(-4).join(', ') : 'none'}`,
  ];
}
