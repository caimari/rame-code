import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentToolDefinitions,
  parseAssistantText,
  parseAssistantToolCalls,
  truncateToolOutput,
  validateApplyPatchArgs,
  validateCreateDirectoryArgs,
  validateDeleteFileArgs,
  validateFilesystemUsageArgs,
  validateInspectWorkspaceArgs,
  validateListFilesArgs,
  validateMoveFileArgs,
  validateReadFileArgs,
  validateRunTestsArgs,
  validateSearchTextArgs,
  validateSetExecutableArgs,
  validateToolCallList,
  validateOneToolCall,
} from '../src/agentTools.js';

function toolCall(id: string, name: string, args: unknown): unknown {
  return {
    id,
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

test('per-tool schemas accept exact keys and reject extras', () => {
  assert.deepEqual(validateListFilesArgs({ dir: 'src', limit: 50 }), { dir: 'src', limit: 50 });
  assert.throws(() => validateListFilesArgs({ dir: 'src', limit: 50, extra: 1 }), /Invalid/);
  assert.deepEqual(
    validateSearchTextArgs({ query: 'hello', dir: '', isRegex: false, maxResults: 10 }),
    { query: 'hello', dir: '', isRegex: false, maxResults: 10 },
  );
  assert.throws(() => validateSearchTextArgs({ query: '', dir: '', isRegex: false, maxResults: 10 }), /Invalid/);
  assert.throws(() => validateSearchTextArgs({ query: 'a', dir: '', isRegex: 'yes', maxResults: 10 }), /Invalid/);
  assert.deepEqual(validateReadFileArgs({ path: 'a.ts', maxBytes: 100 }), { path: 'a.ts', maxBytes: 100 });
  assert.throws(() => validateReadFileArgs({ path: 'a.ts' }), /Invalid/);
  assert.deepEqual(validateInspectWorkspaceArgs({ dir: '', maxDepth: 4, maxEntries: 500 }), { dir: '', maxDepth: 4, maxEntries: 500 });
  assert.throws(() => validateInspectWorkspaceArgs({ dir: '', maxDepth: 99, maxEntries: 500 }), /Invalid/);
  assert.deepEqual(validateFilesystemUsageArgs({}), {});
  assert.throws(() => validateFilesystemUsageArgs({ path: '/' }), /Invalid/);
  assert.deepEqual(validateCreateDirectoryArgs({ path: 'src/new' }), { path: 'src/new' });
  assert.throws(() => validateCreateDirectoryArgs({ path: '' }), /Invalid/);
  assert.deepEqual(validateMoveFileArgs({ source: 'a', destination: 'b', expectedHash: 'a'.repeat(64) }), { source: 'a', destination: 'b', expectedHash: 'a'.repeat(64) });
  assert.throws(() => validateMoveFileArgs({ source: 'a', destination: 'b', expectedHash: 'bad' }), /Invalid/);
  assert.deepEqual(validateDeleteFileArgs({ path: 'a', expectedHash: 'b'.repeat(64) }), { path: 'a', expectedHash: 'b'.repeat(64) });
  assert.deepEqual(validateSetExecutableArgs({ path: 'run.sh', expectedHash: 'c'.repeat(64), executable: true }), { path: 'run.sh', expectedHash: 'c'.repeat(64), executable: true });
  assert.throws(() => validateSetExecutableArgs({ path: 'run.sh', expectedHash: 'c'.repeat(64), executable: 'yes' }), /Invalid/);
  assert.deepEqual(validateRunTestsArgs({ commandId: 'npm:test' }), { commandId: 'npm:test' });
  assert.throws(() => validateRunTestsArgs({ commandId: '', }), /Invalid/);
  const patch = {
    files: [{ path: 'a.ts', expectedHash: 'a'.repeat(64), newContent: 'x' }],
  };
  assert.deepEqual(validateApplyPatchArgs(patch).files.length, 1);
  assert.throws(() => validateApplyPatchArgs({ files: [] }), /Invalid/);
  assert.throws(
    () => validateApplyPatchArgs({ files: [{ path: 'a', expectedHash: 'short', newContent: 'x' }] }),
    /Invalid/,
  );
});

test('assistant tool calls reject unknown names, malformed JSON, duplicates, excess parallelism', () => {
  assert.throws(
    () => validateOneToolCall(toolCall('1', 'rm_rf', { path: 'x' })),
    /Unknown tool/,
  );
  assert.throws(
    () => validateOneToolCall({ id: '1', type: 'function', function: { name: 'read_file', arguments: '{bad json' } }),
    /Invalid tool arguments/,
  );
  assert.throws(
    () => validateOneToolCall({ id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' }, extra: 1 }),
    /Invalid tool call/,
  );
  assert.throws(
    () =>
      validateToolCallList([
        toolCall('dup', 'list_files', { dir: '', limit: 10 }),
        toolCall('dup', 'list_files', { dir: '', limit: 10 }),
      ]),
    /Invalid tool calls/,
  );
  const five = [1, 2, 3, 4, 5].map((index) =>
    toolCall(`id-${index}`, 'list_files', { dir: '', limit: 10 }),
  );
  assert.throws(() => validateToolCallList(five), /Invalid tool calls/);
  const one = validateToolCallList([toolCall('ok-1', 'read_file', { path: 'a', maxBytes: 10 })]);
  assert.equal(one[0]?.tool, 'read_file');
  for (const emptyArgs of ['', null]) {
    const zeroArg = validateOneToolCall({
      id: `disk-${String(emptyArgs)}`,
      type: 'function',
      function: { name: 'filesystem_usage', arguments: emptyArgs },
    });
    assert.deepEqual(zeroArg.args, {});
  }
});

test('provider payload parsing extracts text or validated calls', () => {
  const textPayload = { choices: [{ message: { content: 'hello' } }] };
  assert.equal(parseAssistantToolCalls(textPayload), null);
  assert.equal(parseAssistantText(textPayload), 'hello');
  const callsPayload = {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [toolCall('c1', 'read_file', { path: 'a', maxBytes: 10 })],
        },
      },
    ],
  };
  const calls = parseAssistantToolCalls(callsPayload);
  assert.equal(calls?.length, 1);
  assert.equal(calls?.[0]?.tool, 'read_file');
});

test('tool definitions cover the bounded allowlisted tools and bound output', () => {
  const defs = buildAgentToolDefinitions();
  assert.deepEqual(defs.map((def) => def.function.name).sort(), [
    'apply_patch',
    'create_directory',
    'delete_file',
    'filesystem_usage',
    'inspect_workspace',
    'list_files',
    'move_file',
    'read_file',
    'run_tests',
    'search_text',
    'set_executable',
  ]);
  for (const def of defs) {
    assert.equal(def.type, 'function');
    assert.equal((def.function.parameters as Record<string, unknown>).additionalProperties, false);
  }
  assert.equal(truncateToolOutput('abc', 10), 'abc');
  assert.match(truncateToolOutput('x'.repeat(100), 10), /truncated/);
});
