/**
 * Integrity of a protected acceptance run beyond its start and end state
 * (SIMULATED, disposable projects, no Meta): a file the host cannot read is
 * never intact; a new file the check depends on, or whose role the run does
 * not establish, is never silently accepted.
 */

import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

import { MISSION_STATE_KEY, type MissionRecord } from '../src/missionStore.js';
import { assistantText, fakeWindow, HostHarness, toolCallReply, type PostedState } from './helpers/hostHarness.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });
const write = (id: string, file: string, content: string) => ({
  kind: 'json' as const,
  body: toolCallReply([{ id, name: 'apply_patch', args: { files: [{ path: file, expectedHash: sha(''), newContent: content }] } }]),
});
const stored = (h: HostHarness): MissionRecord => ((h.memento.get(MISSION_STATE_KEY) as { missions: MissionRecord[] }).missions[0]) as MissionRecord;
const notes = (h: HostHarness): string => stored(h).evidence.map((entry) => entry.text).join('\n');
interface MissionState { id: string; revision: number }
const missionOf = (state: PostedState): MissionState | null => ((state.memory as { mission: MissionState | null } | undefined)?.mission ?? null);
const PLAN = { goal: 'Implement add in lib/sum.js.', assumptions: [], steps: [{ id: 't1', title: 'Implement add', successCriterion: 'npm:check passes' }], risks: [] };
const FROZEN = { commandId: 'npm:check', files: ['acceptance/accept.test.js'] };
const reviews = () => fakeWindow.warningCalls.filter((call) => /^Count the acceptance check/.test(call.message));

async function withProject(files: Record<string, string>, body: (h: HostHarness, mission: MissionState) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission' });
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'integrity', private: true, scripts: { test: 'node own.test.js', check: 'node acceptance/accept.test.js' } }));
    await h.writeFile('own.test.js', 'process.exit(0);\n');
    for (const [file, content] of Object.entries(files)) {
      await h.writeFile(file, content);
    }
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: PLAN }]) });
    await h.provider.sendMessage('Implement add in lib/sum.js.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const mission = missionOf(await h.waitFor((state) => missionOf(state) !== null)) as MissionState;
    fakeWindow.warningCalls.length = 0;
    fakeWindow.warningAnswers.length = 0;
    await body(h, mission);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

const SIMPLE = "const add = require('../lib/sum.js');\nrequire('node:assert').equal(add(2, 3), 5);\n";

test('a file the code under test makes unreadable during the check: not verifiable, never intact', { skip: process.platform === 'win32' ? 'chmod does not block reads on Windows' : process.getuid?.() === 0 ? 'root reads every file' : false }, async () => {
  await withProject({ 'acceptance/accept.test.js': SIMPLE, 'notes.txt': 'kept' }, async (h, mission) => {
    const hide = "require('node:fs').chmodSync(require('node:path').join(__dirname, '..', 'notes.txt'), 0o000);\nmodule.exports = (a, b) => a + b;\n";
    h.model.enqueue(write('w', 'lib/sum.js', hide), say('Done.'), say('Done, no test needed.'));
    try {
      await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
      assert.equal(stored(h).status, 'blocked', notes(h));
      assert.match(stored(h).note, /^Blocked: NOT VERIFIABLE: RAME could not read notes\.txt to compare it with its record/);
    } finally {
      chmodSync(path.join(h.workspace, 'notes.txt'), 0o600);
    }
  });
});

const OVERRIDE =
  "const fs = require('node:fs');\nconst add = require('../lib/sum.js');\nlet expected = 5;\n" +
  "if (add.length === 2 && fs.existsSync(['data', 'override.txt'].join('/'))) expected = Number(fs.readFileSync(['data', 'override.txt'].join('/'), 'utf8'));\n" +
  "require('node:assert').equal(add(2, 3), expected);\n";

test('a new file the check depends on, never seen at authorization: not verifiable', async () => {
  await withProject({ 'acceptance/accept.test.js': OVERRIDE }, async (h, mission) => {
    h.model.enqueue(write('w', 'lib/sum.js', 'module.exports = (a, b) => 0;\n'), write('o', 'data/override.txt', '0'), say('Done.'), say('Done, no test needed.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
    assert.equal(stored(h).status, 'blocked', notes(h));
    assert.match(stored(h).note, /^Blocked: NOT VERIFIABLE: .*data\/override\.txt, which is outside the scope you authorized/);
  });
});

test('the same, with the dependency filtered out of the trace: the new file still needs the user, and declining is not verifiable', async () => {
  await withProject({ 'acceptance/accept.test.js': OVERRIDE }, async (h, mission) => {
    const forger =
      "const fs = require('node:fs');\n" +
      "process.on('exit', () => { const f = process.env.RAME_TRACE_FILE; if (f) { try { fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\\n').filter((l) => !l.includes('override')).join('\\n')); } catch {} } });\n" +
      'module.exports = (a, b) => 0;\n';
    fakeWindow.warningAnswers.push('Protect and authorize', undefined);
    h.model.enqueue(write('w', 'lib/sum.js', forger), write('o', 'data/override.txt', '0'), say('Done.'), say('Done, no test needed.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
    assert.equal(reviews().length, 1, 'never silently accepted');
    assert.match(reviews()[0]?.detail ?? '', /data\/override\.txt \(added\)/);
    assert.equal(stored(h).status, 'blocked', notes(h));
    assert.match(stored(h).note, /^Blocked: NOT VERIFIABLE: files changed outside the scope you authorized and you did not approve them: data\/override\.txt \(added\)/);
  });
});

test('every new code file needs scope review, including one the untrusted trace says the code under test loaded', async () => {
  await withProject({ 'acceptance/accept.test.js': SIMPLE }, async (h, mission) => {
    h.model.enqueue(
      write('w', 'lib/sum.js', "module.exports = require('./impl.js');\n"),
      write('i', 'lib/impl.js', 'module.exports = (a, b) => a + b;\n'),
      write('x', 'lib/orphan.js', 'module.exports = 1;\n'),
      say('Done.'),
      say('Done, no test needed.'),
    );
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
    assert.equal(reviews().length, 1, `${stored(h).status}\n${notes(h)}`);
    const detail = reviews()[0]?.detail ?? '';
    assert.match(detail, /lib\/orphan\.js \(added\)/);
    assert.match(detail, /lib\/impl\.js \(added\)/, 'the trace discovers the load but cannot authorize the file');
    assert.equal(stored(h).status, 'completed', notes(h));
    assert.match(notes(h), /scope review: the user approved lib\/impl\.js, lib\/orphan\.js as writable/);
  });
});

test('the protected check cannot add even a temporary file to an acceptance folder', async () => {
  await withProject({ 'acceptance/accept.test.js': SIMPLE }, async (h, mission) => {
    const sneak =
      "const fs = require('node:fs');\nconst p = require('node:path').join(__dirname, '..', 'acceptance', 'extra.test.js');\n" +
      "fs.writeFileSync(p, 'process.exit(0);');\nfs.rmSync(p);\nmodule.exports = (a, b) => a + b;\n";
    h.model.enqueue(write('w', 'lib/sum.js', sneak), say('Done.'), say('Done, no test needed.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
    assert.equal(stored(h).status, 'blocked', notes(h));
    assert.match(stored(h).note, /acceptance check kept failing \(npm:check exit=1 with every frozen file intact; verification: protected\)/);
    assert.equal(await h.readFile('acceptance/extra.test.js').catch(() => null), null);
  });
});

test('reinforced level: the case runner cannot change a non-writable project file', async () => {
  const CASES = JSON.stringify({ rameCases: 1, module: 'lib/sum.js', cases: [{ call: '', args: [2, 3], expect: 5 }] });
  await withProject({ 'acceptance/accept.test.js': "require('../lib/sum.js');\n", 'acceptance/sum.rame-cases.json': CASES, 'notes.txt': 'kept' }, async (h, mission) => {
    const lateWriter = "module.exports = (a, b) => { require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', 'notes.txt'), 'changed'); return a + b; };\n";
    h.model.enqueue(write('w', 'lib/sum.js', lateWriter), say('Done.'), say('Done, no test needed.'));
    await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, { commandId: 'npm:check', files: ['acceptance/accept.test.js', 'acceptance/sum.rame-cases.json'] });
    assert.equal(stored(h).status, 'blocked', notes(h));
    assert.match(stored(h).note, /host-compared cases.*failed:.*EACCES: permission denied, open .*notes\.txt/);
    assert.equal(await h.readFile('notes.txt'), 'kept');
  });
});

test('a project file RAME cannot read at authorization: nothing is authorized', { skip: process.platform === 'win32' ? 'chmod does not block reads on Windows' : process.getuid?.() === 0 ? 'root reads every file' : false }, async () => {
  await withProject({ 'acceptance/accept.test.js': SIMPLE, 'private.txt': 'x' }, async (h, mission) => {
    chmodSync(path.join(h.workspace, 'private.txt'), 0o000);
    try {
      await h.provider.startMission(mission.id, mission.revision, 'autonomous-workspace', null, true, FROZEN);
      assert.equal(stored(h).grant, null);
      assert.match(String(h.last().status), /^RAME cannot read private\.txt to record it, so the check cannot be protected\. Nothing was authorized\./);
    } finally {
      chmodSync(path.join(h.workspace, 'private.txt'), 0o600);
    }
  });
});
