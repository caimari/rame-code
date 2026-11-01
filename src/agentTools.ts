/**
 * Small typed Agent tool allowlist (no generic shell).
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * Every assistant tool call is validated against exact schemas: unknown tool
 * names, extra fields, malformed JSON, duplicate ids, and excessive parallel
 * calls are all rejected before anything runs.
 */

import {
  MAX_PATCH_BYTES,
  MAX_PATCH_FILES,
  MAX_SEARCH_RESULTS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_OUTPUT_BYTES,
} from './agentPolicy.js';
import type { AgentToolName } from './agentProfiles.js';
import type { ProviderUsage } from './usage.js';

export const AGENT_TOOL_LIST: readonly AgentToolName[] = [
  'list_files',
  'inspect_workspace',
  'filesystem_usage',
  'search_text',
  'read_file',
  'create_directory',
  'move_file',
  'delete_file',
  'set_executable',
  'apply_patch',
  'run_tests',
];

export interface ListFilesArgs {
  dir: string;
  limit: number;
}

export interface InspectWorkspaceArgs {
  dir: string;
  maxDepth: number;
  maxEntries: number;
}

export type FilesystemUsageArgs = Record<string, never>;

export interface SearchTextArgs {
  query: string;
  dir: string;
  isRegex: boolean;
  maxResults: number;
}

export interface ReadFileArgs {
  path: string;
  maxBytes: number;
}

export interface CreateDirectoryArgs {
  path: string;
}

export interface MoveFileArgs {
  source: string;
  destination: string;
  expectedHash: string;
}

export interface DeleteFileArgs {
  path: string;
  expectedHash: string;
}

export interface SetExecutableArgs {
  path: string;
  expectedHash: string;
  executable: boolean;
}

export interface PatchFileInput {
  path: string;
  expectedHash: string;
  newContent: string;
}

export interface ApplyPatchArgs {
  files: PatchFileInput[];
}

export interface RunTestsArgs {
  commandId: string;
}

export type AgentToolArgs =
  | { tool: 'list_files'; args: ListFilesArgs }
  | { tool: 'inspect_workspace'; args: InspectWorkspaceArgs }
  | { tool: 'filesystem_usage'; args: FilesystemUsageArgs }
  | { tool: 'search_text'; args: SearchTextArgs }
  | { tool: 'read_file'; args: ReadFileArgs }
  | { tool: 'create_directory'; args: CreateDirectoryArgs }
  | { tool: 'move_file'; args: MoveFileArgs }
  | { tool: 'delete_file'; args: DeleteFileArgs }
  | { tool: 'set_executable'; args: SetExecutableArgs }
  | { tool: 'apply_patch'; args: ApplyPatchArgs }
  | { tool: 'run_tests'; args: RunTestsArgs };

export interface ValidatedToolCall {
  id: string;
  tool: AgentToolName;
  args: Record<string, unknown>;
}

function hasExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(record);
  if (keys.length !== allowed.length) {
    return false;
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A model produced a tool envelope or argument object that does not match the
 * strict host contract. This is distinct from transport/runtime failures so a
 * bounded Agent loop can ask the same model to repair its proposal without
 * executing or persisting any invalid action.
 */
export class AgentToolProtocolError extends Error {
  /** Usage reported by the rejected reply, when the provider sent any. */
  usage?: ProviderUsage;

  constructor(message: string) {
    super(message);
    this.name = 'AgentToolProtocolError';
  }
}

function fail(message: string): never {
  throw new AgentToolProtocolError(message);
}

/** Validate `list_files` args with exact keys. */
export function validateListFilesArgs(raw: unknown): ListFilesArgs {
  if (!isRecord(raw) || !hasExactKeys(raw, ['dir', 'limit'])) {
    fail('Invalid list_files arguments.');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.dir !== 'string' || record.dir.length > 512) {
    fail('Invalid list_files arguments.');
  }
  if (
    typeof record.limit !== 'number' ||
    !Number.isInteger(record.limit) ||
    record.limit < 1 ||
    record.limit > 200
  ) {
    fail('Invalid list_files arguments.');
  }
  return { dir: record.dir as string, limit: record.limit as number };
}

/** Validate bounded recursive workspace inspection. */
export function validateInspectWorkspaceArgs(raw: unknown): InspectWorkspaceArgs {
  if (!isRecord(raw) || !hasExactKeys(raw, ['dir', 'maxDepth', 'maxEntries'])) {
    fail('Invalid inspect_workspace arguments.');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.dir !== 'string' || record.dir.length > 512) {
    fail('Invalid inspect_workspace arguments.');
  }
  if (typeof record.maxDepth !== 'number' || !Number.isInteger(record.maxDepth) || record.maxDepth < 0 || record.maxDepth > 12) {
    fail('Invalid inspect_workspace arguments.');
  }
  if (typeof record.maxEntries !== 'number' || !Number.isInteger(record.maxEntries) || record.maxEntries < 1 || record.maxEntries > 2000) {
    fail('Invalid inspect_workspace arguments.');
  }
  return {
    dir: record.dir as string,
    maxDepth: record.maxDepth as number,
    maxEntries: record.maxEntries as number,
  };
}

export function validateFilesystemUsageArgs(raw: unknown): FilesystemUsageArgs {
  if (!isRecord(raw) || Object.keys(raw).length !== 0) {
    fail('Invalid filesystem_usage arguments.');
  }
  return {};
}

/**
 * Conservative ReDoS screen for model-supplied regexes. Matching runs
 * synchronously on the extension host, so one exponential pattern would
 * freeze every extension (including Cancel). Rejects backreferences and any
 * repeated group whose body itself repeats or alternates, e.g. `(a+)+`,
 * `(a|aa)*`, `(.*x){20}`. Plain quantified atoms and optional groups stay
 * allowed.
 */
export function isBacktrackingRiskPattern(pattern: string): boolean {
  if (/\\[1-9]|\\k</.test(pattern)) {
    return true;
  }
  // Each open group tracks whether its body repeats or alternates.
  const stack: boolean[] = [];
  let inClass = false;
  // More than two unbounded repeats (`.*a.*b.*c`) backtrack polynomially.
  let unbounded = 0;
  for (let index = 0; index < pattern.length; index++) {
    const ch = pattern[index] as string;
    if (ch === '\\') {
      index += 1;
      continue;
    }
    if (inClass) {
      if (ch === ']') {
        inClass = false;
      }
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    const markRisky = (): void => {
      if (stack.length > 0) {
        stack[stack.length - 1] = true;
      }
    };
    if (ch === '(') {
      stack.push(false);
    } else if (ch === '|') {
      markRisky();
    } else if (ch === '*' || ch === '+' || ch === '{') {
      if (ch !== '{' || /^\{\s*\d+\s*,\s*\}/.test(pattern.slice(index))) {
        unbounded += 1;
        if (unbounded > 2) {
          return true;
        }
      }
      markRisky();
    } else if (ch === ')') {
      const bodyRepeats = stack.pop() ?? false;
      const next = pattern[index + 1];
      const repeated = next === '*' || next === '+' || (next === '{' && !/^\{\s*[01]?\s*\}/.test(pattern.slice(index + 1)));
      if (repeated && bodyRepeats) {
        return true;
      }
      if (bodyRepeats) {
        // A repeating inner group makes its enclosing group repeat too.
        markRisky();
      }
    }
  }
  return false;
}

/** Validate `search_text` args with exact keys. */
export function validateSearchTextArgs(raw: unknown): SearchTextArgs {
  if (!isRecord(raw) || !hasExactKeys(raw, ['query', 'dir', 'isRegex', 'maxResults'])) {
    fail('Invalid search_text arguments.');
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.query !== 'string' ||
    record.query.length === 0 ||
    record.query.length > 200
  ) {
    fail('Invalid search_text arguments.');
  }
  if (typeof record.dir !== 'string' || record.dir.length > 512) {
    fail('Invalid search_text arguments.');
  }
  if (typeof record.isRegex !== 'boolean') {
    fail('Invalid search_text arguments.');
  }
  if (
    typeof record.maxResults !== 'number' ||
    !Number.isInteger(record.maxResults) ||
    record.maxResults < 1 ||
    record.maxResults > MAX_SEARCH_RESULTS
  ) {
    fail('Invalid search_text arguments.');
  }
  // Reject patterns that are almost certainly ReDoS-prone nested quantifiers.
  if (record.isRegex === true) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(record.query as string);
    } catch {
      fail('Invalid search_text arguments.');
    }
    if (isBacktrackingRiskPattern(record.query as string)) {
      fail('Invalid search_text arguments: that regex could backtrack catastrophically; use a simpler pattern or a literal search.');
    }
  }
  return {
    query: record.query as string,
    dir: record.dir as string,
    isRegex: record.isRegex as boolean,
    maxResults: record.maxResults as number,
  };
}

/** Validate `read_file` args with exact keys. */
export function validateReadFileArgs(raw: unknown): ReadFileArgs {
  if (!isRecord(raw) || !hasExactKeys(raw, ['path', 'maxBytes'])) {
    fail('Invalid read_file arguments.');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.path !== 'string' || record.path.length === 0 || record.path.length > 512) {
    fail('Invalid read_file arguments.');
  }
  if (
    typeof record.maxBytes !== 'number' ||
    !Number.isInteger(record.maxBytes) ||
    record.maxBytes < 1 ||
    record.maxBytes > 262144
  ) {
    fail('Invalid read_file arguments.');
  }
  return { path: record.path as string, maxBytes: record.maxBytes as number };
}

function validateSha256(value: unknown, message: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail(message);
  }
  return value as string;
}

export function validateCreateDirectoryArgs(raw: unknown): CreateDirectoryArgs {
  if (!isRecord(raw) || !hasExactKeys(raw, ['path']) || typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.length > 512) {
    fail('Invalid create_directory arguments.');
  }
  return { path: raw.path };
}

export function validateMoveFileArgs(raw: unknown): MoveFileArgs {
  if (!isRecord(raw) || !hasExactKeys(raw, ['source', 'destination', 'expectedHash'])) {
    fail('Invalid move_file arguments.');
  }
  if (typeof raw.source !== 'string' || raw.source.length === 0 || raw.source.length > 512 || typeof raw.destination !== 'string' || raw.destination.length === 0 || raw.destination.length > 512) {
    fail('Invalid move_file arguments.');
  }
  return {
    source: raw.source,
    destination: raw.destination,
    expectedHash: validateSha256(raw.expectedHash, 'Invalid move_file arguments.'),
  };
}

export function validateDeleteFileArgs(raw: unknown): DeleteFileArgs {
  if (!isRecord(raw) || !hasExactKeys(raw, ['path', 'expectedHash']) || typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.length > 512) {
    fail('Invalid delete_file arguments.');
  }
  return {
    path: raw.path,
    expectedHash: validateSha256(raw.expectedHash, 'Invalid delete_file arguments.'),
  };
}

export function validateSetExecutableArgs(raw: unknown): SetExecutableArgs {
  if (!isRecord(raw) || !hasExactKeys(raw, ['path', 'expectedHash', 'executable']) || typeof raw.path !== 'string' || raw.path.length === 0 || raw.path.length > 512 || typeof raw.executable !== 'boolean') {
    fail('Invalid set_executable arguments.');
  }
  return {
    path: raw.path,
    expectedHash: validateSha256(raw.expectedHash, 'Invalid set_executable arguments.'),
    executable: raw.executable,
  };
}

/** Validate `apply_patch` args with exact keys and size/file-count bounds. */
export function validateApplyPatchArgs(raw: unknown): ApplyPatchArgs {
  if (!isRecord(raw) || !hasExactKeys(raw, ['files'])) {
    fail('Invalid apply_patch arguments.');
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.files) || record.files.length === 0 || record.files.length > MAX_PATCH_FILES) {
    fail('Invalid apply_patch arguments.');
  }
  let totalBytes = 0;
  const files: PatchFileInput[] = (record.files as unknown[]).map((entry) => {
    if (!isRecord(entry) || !hasExactKeys(entry, ['path', 'expectedHash', 'newContent'])) {
      fail('Invalid apply_patch arguments.');
    }
    if (
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.length > 512
    ) {
      fail('Invalid apply_patch arguments.');
    }
    if (typeof entry.expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(entry.expectedHash)) {
      fail('Invalid apply_patch arguments.');
    }
    if (typeof entry.newContent !== 'string' || entry.newContent.length > MAX_PATCH_BYTES) {
      fail('Invalid apply_patch arguments.');
    }
    totalBytes += (entry.newContent as string).length;
    if (totalBytes > MAX_PATCH_BYTES) {
      fail('Invalid apply_patch arguments.');
    }
    return {
      path: entry.path as string,
      expectedHash: entry.expectedHash as string,
      newContent: entry.newContent as string,
    };
  });
  return { files };
}

/** Validate `run_tests` args with exact keys. */
export function validateRunTestsArgs(raw: unknown): RunTestsArgs {
  if (!isRecord(raw) || !hasExactKeys(raw, ['commandId'])) {
    fail('Invalid run_tests arguments.');
  }
  if (typeof raw.commandId !== 'string' || raw.commandId.length === 0 || raw.commandId.length > 128) {
    fail('Invalid run_tests arguments.');
  }
  return { commandId: raw.commandId as string };
}

/** Dispatch to the per-tool exact validator. */
export function validateToolArgs(tool: string, raw: unknown): Record<string, unknown> {
  switch (tool) {
    case 'list_files':
      return validateListFilesArgs(raw) as unknown as Record<string, unknown>;
    case 'inspect_workspace':
      return validateInspectWorkspaceArgs(raw) as unknown as Record<string, unknown>;
    case 'filesystem_usage':
      return validateFilesystemUsageArgs(raw) as unknown as Record<string, unknown>;
    case 'search_text':
      return validateSearchTextArgs(raw) as unknown as Record<string, unknown>;
    case 'read_file':
      return validateReadFileArgs(raw) as unknown as Record<string, unknown>;
    case 'create_directory':
      return validateCreateDirectoryArgs(raw) as unknown as Record<string, unknown>;
    case 'move_file':
      return validateMoveFileArgs(raw) as unknown as Record<string, unknown>;
    case 'delete_file':
      return validateDeleteFileArgs(raw) as unknown as Record<string, unknown>;
    case 'set_executable':
      return validateSetExecutableArgs(raw) as unknown as Record<string, unknown>;
    case 'apply_patch':
      return validateApplyPatchArgs(raw) as unknown as Record<string, unknown>;
    case 'run_tests':
      return validateRunTestsArgs(raw) as unknown as Record<string, unknown>;
    default:
      fail('Unknown tool.');
  }
}

function parseArgumentsField(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length > 131072) {
      fail('Invalid tool arguments.');
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      fail('Invalid tool arguments.');
    }
  }
  if (isRecord(value)) {
    return value;
  }
  fail('Invalid tool arguments.');
}

/**
 * Validate one assistant `tool_calls` entry of the OpenAI-compatible shape:
 * `{ id, type: 'function', function: { name, arguments } }`. The `arguments`
 * may be a JSON string or an object; extra fields at any level are rejected.
 */
export function validateOneToolCall(raw: unknown): ValidatedToolCall {
  if (!isRecord(raw) || !hasExactKeys(raw, ['id', 'type', 'function'])) {
    fail('Invalid tool call.');
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 128) {
    fail('Invalid tool call.');
  }
  if (raw.type !== 'function') {
    fail('Invalid tool call.');
  }
  const fn = raw.function;
  if (!isRecord(fn) || !hasExactKeys(fn, ['name', 'arguments'])) {
    fail('Invalid tool call.');
  }
  if (typeof fn.name !== 'string' || !(AGENT_TOOL_LIST as readonly string[]).includes(fn.name)) {
    fail('Unknown tool.');
  }
  // Some OpenAI-compatible local runtimes serialize a zero-argument function
  // as an empty string or null. This is unambiguous only for this exact
  // zero-argument tool; every other tool keeps the strict JSON contract.
  const argsDecoded =
    fn.name === 'filesystem_usage' && (fn.arguments === '' || fn.arguments === null)
      ? {}
      : parseArgumentsField(fn.arguments);
  const args = validateToolArgs(fn.name as string, argsDecoded);
  return { id: raw.id as string, tool: fn.name as AgentToolName, args };
}

/**
 * Validate the full parallel-call list from one assistant turn. Rejects
 * empty lists, excessive parallel calls, and duplicate ids.
 */
export function validateToolCallList(raw: unknown): ValidatedToolCall[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TOOL_CALLS_PER_TURN) {
    fail('Invalid tool calls.');
  }
  const calls = (raw as unknown[]).map((entry) => validateOneToolCall(entry));
  const seen = new Set<string>();
  for (const call of calls) {
    if (seen.has(call.id)) {
      fail('Invalid tool calls.');
    }
    seen.add(call.id);
  }
  return calls;
}

/**
 * Extract and validate `tool_calls` from an untrusted provider payload.
 * Returns `null` when the assistant sent a normal text reply (no tool calls).
 */
export function parseAssistantToolCalls(payload: unknown): ValidatedToolCall[] | null {
  if (!isRecord(payload)) {
    fail('Invalid agent response.');
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    fail('Invalid agent response.');
  }
  const first = choices[0] as unknown;
  if (!isRecord(first)) {
    fail('Invalid agent response.');
  }
  const message = (first as Record<string, unknown>).message;
  if (!isRecord(message)) {
    return null;
  }
  const toolCalls = (message as Record<string, unknown>).tool_calls;
  if (toolCalls === undefined || toolCalls === null) {
    return null;
  }
  return validateToolCallList(toolCalls);
}

/** Extract assistant text from an untrusted provider payload (may be empty). */
export function parseAssistantText(payload: unknown): string {
  if (!isRecord(payload)) {
    return '';
  }
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return '';
  }
  const first = choices[0] as unknown;
  if (!isRecord(first)) {
    return '';
  }
  const message = (first as Record<string, unknown>).message;
  if (!isRecord(message)) {
    return '';
  }
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : '';
}

export interface AgentToolDefinition {
  type: 'function';
  function: {
    name: AgentToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Tool definitions sent to both Meta and OpenAI-compatible endpoints. */
export function buildAgentToolDefinitions(): AgentToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List relative workspace paths under a directory (bounded).',
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string' },
            limit: { type: 'integer' },
          },
          required: ['dir', 'limit'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'inspect_workspace',
        description: 'Recursively count files/directories and total file bytes under a workspace directory, with strict depth and entry bounds.',
        parameters: {
          type: 'object',
          properties: {
            dir: { type: 'string' },
            maxDepth: { type: 'integer', minimum: 0, maximum: 12 },
            maxEntries: { type: 'integer', minimum: 1, maximum: 2000 },
          },
          required: ['dir', 'maxDepth', 'maxEntries'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'filesystem_usage',
        description: 'Report total, used, free, and available bytes for the filesystem containing the explicitly selected workspace. Read-only; does not inspect other files.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_text',
        description: 'Literal or regex search inside the workspace (bounded).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            dir: { type: 'string' },
            isRegex: { type: 'boolean' },
            maxResults: { type: 'integer' },
          },
          required: ['query', 'dir', 'isRegex', 'maxResults'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_directory',
        description: 'Create one workspace directory (including missing parents). The target must not already exist.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'move_file',
        description: 'Move or rename one file inside the workspace without overwrite, bound to the SHA-256 returned by read_file.',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            destination: { type: 'string' },
            expectedHash: { type: 'string' },
          },
          required: ['source', 'destination', 'expectedHash'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Delete one workspace file, bound to the SHA-256 returned by read_file. Directories cannot be deleted.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            expectedHash: { type: 'string' },
          },
          required: ['path', 'expectedHash'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_executable',
        description: 'Set or clear only the owner-executable bit on one workspace file, bound to the SHA-256 returned by read_file. Other permission bits are preserved.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            expectedHash: { type: 'string' },
            executable: { type: 'boolean' },
          },
          required: ['path', 'expectedHash', 'executable'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read one UTF-8 workspace file (bounded).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            maxBytes: { type: 'integer' },
          },
          required: ['path', 'maxBytes'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'apply_patch',
        description: 'Apply full replacement content with SHA-256 preconditions returned by read_file. For a new file use the SHA-256 of empty UTF-8 content: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.',
        parameters: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                  expectedHash: { type: 'string' },
                  newContent: { type: 'string' },
                },
                required: ['path', 'expectedHash', 'newContent'],
                additionalProperties: false,
              },
            },
          },
          required: ['files'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_tests',
        description: 'Run one named allowlisted test command (no shell).',
        parameters: {
          type: 'object',
          properties: {
            commandId: { type: 'string' },
          },
          required: ['commandId'],
          additionalProperties: false,
        },
      },
    },
  ];
}

/**
 * Bound untrusted tool/model text to the output budget. All file content,
 * tool output, model text, and test output travel through this before they
 * re-enter a model request or the transcript.
 */
export function truncateToolOutput(text: string, maxBytes: number = MAX_TOOL_OUTPUT_BYTES): string {
  if (text.length <= maxBytes) {
    return text;
  }
  return text.slice(0, maxBytes) + '\n…[truncated]';
}
