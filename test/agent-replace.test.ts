/**
 * R8: exact-fragment edits (replace_in_file) through the existing approval,
 * policy, and atomic write path; and a bounded repair when llama-server
 * cannot parse a tool call (that exact HTTP 500 only).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

import { computeActionDigest } from '../src/agentApproval.js';
import { describeAgentCall, policyGateForCall } from '../src/agentHost.js';
import { isLocalMalformedToolCall, LOCAL_MALFORMED_TOOL_CALL_MESSAGE } from '../src/agentModel.js';
import { isAutoAllowed } from '../src/agentProfiles.js';
import { validateReplaceInFileArgs, validateToolArgs, type ValidatedToolCall } from '../src/agentTools.js';
import { assistantText, HostHarness, toolCallReply } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
type Message = { role: string; content: string; tool_call_id?: string };
const SOURCE = "export const LABEL = 'Your words';\nexport function trim(text) {\n  return text.trim();\n}\n";

function call(args: Record<string, unknown>): ValidatedToolCall {
  return { id: 'c1', tool: 'replace_in_file', args };
}

test('replace_in_file arguments: exact keys, a real hash, a non-empty fragment, a different replacement', () => {
  const ok = validateReplaceInFileArgs({ path: 'a.js', expectedHash: sha('x'), oldText: 'x', newText: '' });
  assert.deepEqual(ok, { path: 'a.js', expectedHash: sha('x'), oldText: 'x', newText: '' }, 'an empty replacement deletes the fragment');
  for (const [raw, reason] of [
    [{ path: 'a.js', expectedHash: sha('x'), oldText: 'x' }, /use exactly the keys path, expectedHash, oldText, newText/],
    [{ path: 'a.js', expectedHash: sha('x'), oldText: 'x', newText: 'y', content: 'z' }, /use exactly the keys/],
    [{ path: 'a.js', expectedHash: 'abc', oldText: 'x', newText: 'y' }, /expectedHash/],
    [{ path: 'a.js', expectedHash: sha('x'), oldText: '', newText: 'y' }, /oldText/],
    [{ path: 'a.js', expectedHash: sha('x'), oldText: 'same', newText: 'same' }, /newText must differ from oldText/],
    [{ path: 'a.js', expectedHash: sha('x'), oldText: 'x'.repeat(20001), newText: 'y' }, /oldText/],
  ] as const) {
    assert.throws(() => validateReplaceInFileArgs(raw), reason);
  }
  assert.ok(validateToolArgs('replace_in_file', { path: 'a.js', expectedHash: sha('x'), oldText: 'x', newText: 'y' }));
});

test('the card shows the exact change and its digest binds path, hash, and both fragments', () => {
  const base = { path: 'src/a.ts', expectedHash: sha(SOURCE), oldText: "'Your words'", newText: "'Tus palabras'" };
  const described = describeAgentCall(call(base));
  assert.deepEqual(described.targets, ['src/a.ts']);
  assert.deepEqual(described.preconditions, { 'src/a.ts': sha(SOURCE) });
  assert.equal(
    described.body,
    `Replace exactly one occurrence in src/a.ts (file sha256 ${sha(SOURCE)}).\n--- text to replace (12 characters) ---\n'Your words'\n--- replacement (14 characters) ---\n'Tus palabras'`,
  );
  const digest = (args: Record<string, unknown>) => {
    const d = describeAgentCall(call(args));
    return computeActionDigest({ tool: 'replace_in_file', targets: d.targets, body: d.body, provider: 'local', workspaceId: '/w', threadId: 't', preconditions: d.preconditions });
  };
  const reference = digest(base);
  for (const changed of [{ path: 'src/b.ts' }, { expectedHash: sha('other') }, { oldText: "'Your word'" }, { newText: "'Tus palabra'" }]) {
    assert.notEqual(digest({ ...base, ...changed }), reference, JSON.stringify(changed));
  }
  // Same protections as every write; same approval rules as apply_patch.
  for (const blocked of ['.env', '.git/config', '../outside.js', '/etc/passwd']) {
    assert.equal(policyGateForCall(call({ ...base, path: blocked })).ok, false, blocked);
  }
  assert.equal(isAutoAllowed('ask', 'replace_in_file'), false);
  assert.equal(isAutoAllowed('safe-auto', 'replace_in_file'), false);
  assert.equal(isAutoAllowed('workspace-full', 'replace_in_file'), isAutoAllowed('workspace-full', 'apply_patch'));
});

test('only the exact llama-server parse failure counts as a malformed tool call', () => {
  const exact = { error: { code: 500, message: LOCAL_MALFORMED_TOOL_CALL_MESSAGE, type: 'server_error' } };
  assert.equal(isLocalMalformedToolCall(500, exact), true);
  assert.equal(isLocalMalformedToolCall(502, exact), false);
  assert.equal(isLocalMalformedToolCall(500, { error: { ...exact.error, message: 'Internal error' } }), false);
  assert.equal(isLocalMalformedToolCall(500, { error: { ...exact.error, type: 'invalid_request_error' } }), false);
  assert.equal(isLocalMalformedToolCall(500, { error: { ...exact.error, message: `${LOCAL_MALFORMED_TOOL_CALL_MESSAGE} (extra)` } }), false);
  assert.equal(isLocalMalformedToolCall(500, null), false);
  assert.equal(isLocalMalformedToolCall(500, { message: LOCAL_MALFORMED_TOOL_CALL_MESSAGE }), false);
});

async function withHarness(profile: string, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: profile });
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function runApproving(h: HostHarness, text: string, onCard?: (tool: string) => Promise<boolean>): Promise<Array<{ tool: string; body: string }>> {
  const cards: Array<{ tool: string; body: string }> = [];
  let done = false;
  const run = h.provider.sendMessage(text, 'agent', 'local').then(() => (done = true));
  let seen = '';
  const deadline = Date.now() + 20000;
  while (!done) {
    if (Date.now() > deadline) {
      h.provider.cancelRequest();
      throw new Error('run did not finish');
    }
    const pending = h.last()?.agentPending;
    if (pending && pending.actionId !== seen) {
      seen = pending.actionId;
      cards.push({ tool: pending.tool, body: pending.bodyPreview });
      if (!onCard || (await onCard(pending.tool))) {
        await h.provider.approveAgentAction(pending.actionId, pending.digest);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await run;
  return cards;
}

const toolResult = (h: HostHarness, id: string): string => {
  for (const request of [...h.model.requests].reverse()) {
    const found = (request.messages as Message[] | undefined)?.find((m) => m.tool_call_id === id);
    if (found) {
      return found.content;
    }
  }
  return '';
};
const replace = (id: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name: 'replace_in_file', args }]) });
const record = (h: HostHarness): string => (h.last().turns.at(-1) as { hostRecord?: string[] }).hostRecord?.join('\n') ?? '';

test('a unique fragment is replaced after approval of the exact change; the rest of the file is untouched', async () => {
  await withHarness('safe-auto', async (h) => {
    await h.writeFile('label.js', SOURCE);
    h.model.enqueue(
      replace('r', { path: 'label.js', expectedHash: sha(SOURCE), oldText: "'Your words'", newText: "'Tus palabras'" }),
      { kind: 'json', body: assistantText('Changed the label. Files changed: label.js.') },
    );
    const cards = await runApproving(h, 'Translate the label.');
    assert.deepEqual(cards.map((card) => card.tool), ['replace_in_file']);
    assert.match(cards[0]?.body ?? '', /--- text to replace \(12 characters\) ---\n'Your words'\n--- replacement \(14 characters\) ---\n'Tus palabras'/);
    assert.equal(await h.readFile('label.js'), SOURCE.replace("'Your words'", "'Tus palabras'"));
    assert.match(toolResult(h, 'r'), /^Replaced 1 fragment in label\.js \(12 -> 14 characters\)\./);
    assert.match(record(h), /• replace_in_file label\.js → Replaced 1 fragment in label\.js/);
  });
});

test('a missing, repeated, or stale fragment never reaches a card and changes nothing', async () => {
  await withHarness('safe-auto', async (h) => {
    const twice = 'a = 1;\na = 1;\n';
    await h.writeFile('label.js', SOURCE);
    await h.writeFile('twice.js', twice);
    h.model.enqueue(
      replace('missing', { path: 'label.js', expectedHash: sha(SOURCE), oldText: 'not in the file', newText: 'x' }),
      replace('repeated', { path: 'twice.js', expectedHash: sha(twice), oldText: 'a = 1;', newText: 'a = 2;' }),
      replace('stale', { path: 'label.js', expectedHash: sha('an older version'), oldText: "'Your words'", newText: 'x' }),
      replace('nofile', { path: 'nope.js', expectedHash: sha(SOURCE), oldText: 'x', newText: 'y' }),
      { kind: 'json', body: assistantText('Nothing changed. Files changed: none.') },
    );
    const cards = await runApproving(h, 'Try some edits.');
    assert.deepEqual(cards, [], 'no card was shown');
    assert.match(toolResult(h, 'missing'), /^Not proposed: The text to replace is not in the file; read it again and copy the fragment exactly\./);
    assert.match(toolResult(h, 'repeated'), /^Not proposed: The text to replace appears more than once; include more surrounding lines so it is unique\./);
    assert.match(toolResult(h, 'stale'), /^Not proposed: The file changed; re-read and re-propose the action\./);
    assert.match(toolResult(h, 'nofile'), /^Not proposed: That file does not exist\./);
    assert.equal(await h.readFile('label.js'), SOURCE);
    assert.equal(await h.readFile('twice.js'), twice);
  });
});

test('a file changed after the card was shown is not written; a protected path or a symlink escape is blocked', async () => {
  await withHarness('safe-auto', async (h) => {
    await h.writeFile('label.js', SOURCE);
    h.model.enqueue(
      replace('r', { path: 'label.js', expectedHash: sha(SOURCE), oldText: "'Your words'", newText: "'Tus palabras'" }),
      { kind: 'json', body: assistantText('Stopped. Files changed: none.') },
    );
    const edited = `${SOURCE}// edited by someone else\n`;
    await runApproving(h, 'Translate the label.', async () => {
      await h.writeFile('label.js', edited);
      return true;
    });
    assert.equal(await h.readFile('label.js'), edited, 'the concurrent edit survives; the old approval wrote nothing');
  });
  await withHarness('workspace-full', async (h) => {
    await h.writeFile('.env', 'TOKEN=abc\n');
    h.model.enqueue(replace('env', { path: '.env', expectedHash: sha('TOKEN=abc\n'), oldText: 'abc', newText: 'xyz' }));
    await runApproving(h, 'Edit the env file.');
    assert.equal(await h.readFile('.env'), 'TOKEN=abc\n');
  });
  await withHarness('workspace-full', async (h) => {
    const outside = path.join(h.root, 'outside.txt');
    await fsp.writeFile(outside, 'secret value\n');
    await fsp.symlink(outside, path.join(h.workspace, 'link.txt'));
    h.model.enqueue(replace('link', { path: 'link.txt', expectedHash: sha('secret value\n'), oldText: 'secret', newText: 'public' }));
    await runApproving(h, 'Edit the link.');
    assert.equal(await fsp.readFile(outside, 'utf8'), 'secret value\n', 'the file outside the workspace is untouched');
    assert.match(record(h) + h.last().status, /Agent tool failed|blocked|not allowed|outside|symlink/i);
  });
});

const malformed = { kind: 'json' as const, status: 500, body: { error: { code: 500, message: LOCAL_MALFORMED_TOOL_CALL_MESSAGE, type: 'server_error' } } };

test('an unparsed tool call is repaired within the budget: nothing ran, and the model is told to use a smaller step', async () => {
  await withHarness('safe-auto', async (h) => {
    await h.writeFile('label.js', SOURCE);
    h.model.enqueue(
      malformed,
      replace('r', { path: 'label.js', expectedHash: sha(SOURCE), oldText: "'Your words'", newText: "'Tus palabras'" }),
      { kind: 'json', body: assistantText('Done. Files changed: label.js.') },
    );
    const cards = await runApproving(h, 'Translate the label.');
    assert.deepEqual(cards.map((card) => card.tool), ['replace_in_file']);
    const repair = (h.model.requests[1]?.messages as Message[]).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(repair, /The local server could not parse your previous reply as a tool call, so it was not executed and nothing changed\./);
    assert.match(repair, /use replace_in_file with a short exact fragment/);
    assert.ok(h.posted.some((state) => /could not parse the local model's tool call; nothing ran\. Asking for a smaller step \(1\/2\)/.test(state.status)));
    assert.equal(await h.readFile('label.js'), SOURCE.replace("'Your words'", "'Tus palabras'"));
    assert.equal(h.model.requests.length, 3, 'one repair step, no hidden retries');
  });
});

test('three unparsed replies in a row stop the run; any other HTTP 500 is still a plain failure', async () => {
  await withHarness('safe-auto', async (h) => {
    h.model.enqueue(malformed, malformed, malformed);
    await h.provider.sendMessage('Do something.', 'agent', 'local');
    assert.equal(
      h.last().status,
      "The local server repeatedly could not parse the model's tool calls. None of them ran and no success was claimed. Asking Meta for advice needs cloud escalation ON in Settings; nothing was sent.",
      'a repeated malformed call is a capability stop, so the cascade is mentioned (escalation is off here)',
    );
    assert.equal(h.model.requests.length, 3);
  });
  await withHarness('safe-auto', async (h) => {
    h.model.enqueue({ kind: 'json', status: 500, body: { error: { code: 500, message: 'Internal failure', type: 'server_error' } } });
    await h.provider.sendMessage('Do something.', 'agent', 'local');
    assert.match(h.last().status, /^Local work failed \(The local runtime returned HTTP 500: "Internal failure"\)/, "the server's own words are shown");
    assert.equal(h.model.requests.length, 1, 'no repair for an unrelated 500');
  });
});
