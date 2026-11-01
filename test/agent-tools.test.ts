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

test('validation messages name the field and its rule, never echoing model values', () => {
  const hash = 'a'.repeat(64);
  const cases: Array<[() => unknown, string]> = [
    // The real Glimmer mistake on calculator.js: maxResults 100 over the limit of 50.
    [() => validateSearchTextArgs({ query: 'add', dir: '', isRegex: false, maxResults: 100 }), 'Invalid search_text arguments: maxResults must be an integer from 1 to 50.'],
    [() => validateSearchTextArgs({ query: 'add', dir: '', isRegex: 'yes', maxResults: 5 }), 'Invalid search_text arguments: isRegex must be true or false.'],
    [() => validateSearchTextArgs({ query: '', dir: '', isRegex: false, maxResults: 5 }), 'Invalid search_text arguments: query must be a non-empty string of at most 200 characters.'],
    [() => validateSearchTextArgs({ query: 'add', dir: '', isRegex: false, maxResults: 5, path: 'x' }), 'Invalid search_text arguments: use exactly the keys query, dir, isRegex, maxResults.'],
    [() => validateReadFileArgs({ path: 'a.js' }), 'Invalid read_file arguments: use exactly the keys path, maxBytes.'],
    [() => validateReadFileArgs({ path: 'a.js', maxBytes: 0 }), 'Invalid read_file arguments: maxBytes must be an integer from 1 to 262144.'],
    [() => validateListFilesArgs({ dir: '', limit: 500 }), 'Invalid list_files arguments: limit must be an integer from 1 to 200.'],
    [() => validateInspectWorkspaceArgs({ dir: '', maxDepth: 20, maxEntries: 10 }), 'Invalid inspect_workspace arguments: maxDepth must be an integer from 0 to 12.'],
    [() => validateFilesystemUsageArgs({ path: '' }), 'Invalid filesystem_usage arguments: use exactly {} with no keys.'],
    [() => validateDeleteFileArgs({ path: 'a.js', expectedHash: 'SECRET-VALUE' }), 'Invalid delete_file arguments: expectedHash must be the 64-character lowercase hex SHA-256 returned by read_file.'],
    [() => validateSetExecutableArgs({ path: 'a.sh', expectedHash: hash, executable: 1 }), 'Invalid set_executable arguments: executable must be true or false.'],
    [() => validateMoveFileArgs({ source: 'a', destination: '', expectedHash: hash }), 'Invalid move_file arguments: destination must be a non-empty string of at most 512 characters.'],
    [() => validateRunTestsArgs({ commandId: '' }), 'Invalid run_tests arguments: commandId must be a non-empty string of at most 128 characters.'],
    [() => validateApplyPatchArgs({ files: [] }), 'Invalid apply_patch arguments: files must be an array of 1 to 10 entries.'],
    [() => validateApplyPatchArgs({ files: [{ path: 'a.js', newContent: 'x' }] }), 'Invalid apply_patch arguments: files[0] must use exactly the keys path, expectedHash, newContent.'],
    [() => validateApplyPatchArgs({ files: [{ path: 'a.js', expectedHash: hash, newContent: 'x' }, { path: 'b.js', expectedHash: 'short', newContent: 'y' }] }), 'Invalid apply_patch arguments: files[1].expectedHash must be the 64-character lowercase hex SHA-256 returned by read_file.'],
    [() => validateApplyPatchArgs({ files: [{ path: 'a.js', expectedHash: hash, newContent: 'x'.repeat(70000) }, { path: 'b.js', expectedHash: hash, newContent: 'y'.repeat(70000) }] }), 'Invalid apply_patch arguments: the newContent of all files together must be at most 131072 characters; split the change into smaller patches.'],
    [() => validateOneToolCall(toolCall('t1', 'read_file', '{"path":"a.js","maxBy')), 'Invalid tool arguments: they are not complete, valid JSON.'],
  ];
  for (const [run, message] of cases) {
    assert.throws(run, (error: unknown) => {
      assert.equal((error as Error).message, message);
      assert.ok(message.length <= 200 && /^[\x20-\x7e]+$/.test(message), 'fits the repair channel unchanged');
      assert.doesNotMatch(message, /SECRET-VALUE|short/);
      return true;
    });
  }
  // Valid arguments still pass with the same bounds as before.
  assert.equal(validateSearchTextArgs({ query: 'add', dir: '', isRegex: false, maxResults: 50 }).maxResults, 50);
  assert.equal(validateApplyPatchArgs({ files: [{ path: 'a.js', expectedHash: hash, newContent: '' }] }).files.length, 1);
});
