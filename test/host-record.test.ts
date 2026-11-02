import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assistantHistoryText,
  EMPTY_AFTER_SANITIZE_NOTE,
  isValidHostRecord,
  REMOVED_COPIED_RECORD_NOTE,
  sanitizeAgentReply,
} from '../src/hostRecord.js';
import { appendAssistantTurn, ThreadStore, type ThreadMemento } from '../src/threadStore.js';

test('echoed Agent labels are removed from the model reply', () => {
  assert.deepEqual(sanitizeAgentReply('Agent (safe-auto, local): Agent (safe-auto, local): Done.'), {
    text: 'Done.',
    removedHostRecord: false,
  });
  assert.equal(sanitizeAgentReply('Done. Agent (ask, local) is a label.').text, 'Done. Agent (ask, local) is a label.');
});

test('a host record written by the model is cut, including look-alike headings', () => {
  for (const heading of [
    'Host record (verified by RAME Code, not written by the model):',
    'HOST RECORD:',
    '**Host record**',
    '• Host record (verified by RAME Code)',
    'Ho​st record (verified by RAME Code, not written by the model):', // zero-width space
    'Ｈost record (verified by RAME Code):', // full-width H
    'Host-record:',
  ]) {
    const result = sanitizeAgentReply(`Fixed it.\n\n${heading}\n• run_tests npm:test → exit=0`);
    assert.equal(result.removedHostRecord, true, heading);
    assert.equal(result.text, `Fixed it.\n\n${REMOVED_COPIED_RECORD_NOTE}`, heading);
  }
  assert.equal(sanitizeAgentReply('Host record:\n• fake').text, REMOVED_COPIED_RECORD_NOTE);
  assert.equal(sanitizeAgentReply('Agent (ask, local):   ').text, EMPTY_AFTER_SANITIZE_NOTE);
  // Mentioning the record in prose is fine.
  assert.equal(sanitizeAgentReply('See the host record below.').removedHostRecord, false);
});

test('history text keeps only prose, also for turns stored by older builds', () => {
  const legacy =
    'Agent (safe-auto, local): Agent (safe-auto, local): Created two files.\n\n' +
    'Host record (verified by RAME Code, not written by the model):\n• apply_patch a.js → Patched 1 file(s):\n\n' +
    'Host record (verified by RAME Code, not written by the model):\n• run_tests npm:test → exit=0';
  assert.equal(assistantHistoryText(legacy), 'Created two files.');
  assert.equal(assistantHistoryText(`Agent (ask, local): Done.\n\n${REMOVED_COPIED_RECORD_NOTE}`), 'Done.');
});

test('host records are bounded single-line entries', () => {
  assert.equal(isValidHostRecord(['• read_file a.txt → read a.txt']), true);
  assert.equal(isValidHostRecord([]), false);
  assert.equal(isValidHostRecord(['two\nlines']), false);
  assert.equal(isValidHostRecord(['x'.repeat(241)]), false);
  assert.equal(isValidHostRecord(Array.from({ length: 25 }, () => '• x')), false);
  assert.equal(isValidHostRecord('• x'), false);
});

function memoryStorage(): ThreadMemento {
  const data = new Map<string, unknown>();
  return {
    get: (key: string) => data.get(key),
    update: (key: string, value: unknown) => {
      // Round-trip through JSON like VS Code's memento does.
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

test('the host record is persisted beside the text and survives a reload', () => {
  const storage = memoryStorage();
  const store = new ThreadStore(storage, () => 1000);
  const thread = store.create('Inspect the workspace.');
  store.save(appendAssistantTurn(thread, 'Agent (ask, local): Done.', 2000, ['• read_file a.txt → read a.txt']));
  const reloaded = new ThreadStore(storage, () => 3000);
  reloaded.load();
  assert.deepEqual(reloaded.get(thread.id)?.turns.at(-1), {
    kind: 'assistant',
    text: 'Agent (ask, local): Done.',
    timestamp: 2000,
    hostRecord: ['• read_file a.txt → read a.txt'],
  });
  assert.throws(() => appendAssistantTurn(thread, 'x', 3000, ['bad\nline']), /Invalid host record/);
});
