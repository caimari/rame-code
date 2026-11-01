import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentAuditLog, redactAuditResult } from '../src/agentAudit.js';

test('audit redacts secrets and bounds entries without storing content', () => {
  assert.equal(redactAuditResult('Bearer abcdefgh12345678'), '[redacted]');
  assert.equal(redactAuditResult('api-key: qwertyuiop123'), '[redacted]');
  assert.equal(redactAuditResult('ok: patched 2 files').slice(0, 20), 'ok: patched 2 files'.slice(0, 20));
  const log = new AgentAuditLog(3);
  for (let index = 0; index < 5; index++) {
    log.append({
      provider: 'local',
      threadId: 't-1',
      profile: 'ask',
      tool: 'read_file',
      digest: 'a'.repeat(64),
      decision: 'human',
      result: `result-${index}`,
    });
  }
  assert.equal(log.length, 3);
  const listed = log.list();
  assert.equal(listed[0]?.result, 'result-2');
  assert.equal(listed[2]?.result, 'result-4');
  for (const entry of listed) {
    assert.match(entry.digest, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(entry).includes('file-bytes-secret'));
  }
});

test('audit loads only valid rows and drops corrupt ones', () => {
  const log = new AgentAuditLog();
  log.load([
    {
      seq: 1,
      at: '2026-11-01T00:00:00.000Z',
      provider: 'cloud',
      threadId: 't-1',
      profile: 'ask',
      tool: 'read_file',
      digest: 'b'.repeat(64),
      decision: 'human',
      result: 'ok',
    },
    { seq: 2, bogus: true },
    {
      seq: 3,
      at: 'x',
      provider: 'cloud',
      threadId: 't-1',
      profile: 'ask',
      tool: 'read_file',
      digest: 'short',
      decision: 'human',
      result: 'ok',
    },
  ]);
  assert.equal(log.length, 1);
  assert.equal(log.list()[0]?.seq, 1);
  log.load(null);
  assert.equal(log.length, 0);
});
