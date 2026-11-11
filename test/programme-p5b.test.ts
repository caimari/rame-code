/**
 * P5b of the long-Mission plan: the host compares the code under test with a
 * frozen copy of the original on fresh inputs at every check (edge, random
 * and reserved), and a phase counts only when speed and that comparison pass
 * in the same host pass. SIMULATED model replies; the jobs, checks,
 * reference copies and comparisons run for real.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

import type { MissionRecord } from '../src/missionStore.js';
import { createProgramme, type NewProgramme, type ProgrammeHost, refreshProgramme, runMeasurePhase, startMissionPhase } from '../src/programmeHost.js';
import type { ProgrammeRecord } from '../src/programmeRecord.js';
import { replayRecordInputs } from '../src/referenceCheck.js';
import { assistantText, fakeCloud, HostHarness, type PostedState, toolCallReply } from './helpers/hostHarness.js';

// As in cascade.test.ts: the key's secret name (mainProvider.ts needs the vscode double, loaded by the harness).
const API_KEY_SECRET = 'rameCode.metaModelApiKey';
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const M = 1000003;
const K = 7919;
const SLOW = `// The report checksum. Slow: it loops every time.\nfunction checksum(n) {\n  let s = 0;\n  for (let i = 0; i < n; i++) s = (s + i * ${K}) % ${M};\n  return s;\n}\nmodule.exports = { checksum };\n`;
// What Glimmer wrote in the real P5 run, in this example's numbers: fast, right for small inputs, wrong above about 1.5 million.
const FLOAT = `// Closed form.\nfunction checksum(n) {\n  return (${K} * n * (n - 1) / 2) % ${M};\n}\nmodule.exports = { checksum };\n`;
const EXACT = `// Closed form, exact: reduce before multiplying.\nfunction checksum(n) {\n  const a = n % 2 === 0 ? (n / 2) % ${M} : n % ${M};\n  const b = n % 2 === 0 ? (n - 1) % ${M} : ((n - 1) / 2) % ${M};\n  return (${K} * ((a * b) % ${M})) % ${M};\n}\nmodule.exports = { checksum };\n`;
const slow = (n: number): number => {
  let s = 0;
  for (let i = 0; i < n; i++) s = (s + i * K) % M;
  return s;
};
// The benchmark uses inputs where the float form is still right: the metric alone would accept it.
const BENCH =
  "const { randomInt } = require('node:crypto');\n" +
  "const { checksum } = require('../lib/report.js');\n" +
  'const times = [];\n' +
  // Three untimed calls first (the first calls of a fresh process are not optimized yet), then 300 timed ones.
  'for (let i = 0; i < 3; i++) checksum(1000000 + i);\n' +
  'for (let i = 0; i < 300; i++) { const n = 1000000 + randomInt(400000); const t = process.hrtime.bigint(); checksum(n); times.push(Number(process.hrtime.bigint() - t) / 1e6); }\n' +
  'times.sort((a, b) => a - b);\n';
const REFERENCE = JSON.stringify({ rameReference: 1, module: 'lib/report.js', call: 'checksum', args: [{ int: { min: 0, max: 4000000 } }], edges: [[3]], random: 16, reserved: 12 });
const REF_PATH = 'acceptance/report.rame-reference.json';
const PROGRAMME: NewProgramme = {
  goal: 'Make the report checksum at least ten times faster, with the same results for every input.',
  // A wide allowed spread: these tests are about correctness, and the small bench is noisy when test files run in parallel.
  check: { commandId: 'npm:check', files: ['acceptance/bench.js', REF_PATH], metrics: ['wall_ms'], repeats: 3, maxSpreadPct: 100 },
  phases: [
    { title: 'Measure the baseline', kind: 'measure' },
    { title: 'Faster, same results as the original', kind: 'mission', relative: [{ metric: 'wall_ms', op: '<=', factor: 0.75 }] },
  ],
};

type Request = { messages?: Array<{ content: string | null; tool_call_id?: string }> };
const call = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const patch = (id: string, file: string, before: string, after: string) => call(id, 'apply_patch', { files: [{ path: file, expectedHash: sha(before), newContent: after }] });
const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });
const result = (h: HostHarness, id: string) => String((h.model.requests as Request[]).flatMap((r) => r.messages ?? []).find((m) => m.tool_call_id === id)?.content ?? '');
/** Everything the model was sent in this Mission. */
const seenByModel = (h: HostHarness) => JSON.stringify(h.model.requests);
const host = (h: HostHarness): ProgrammeHost => h.provider as unknown as ProgrammeHost;
// A long host note continues in the next ones: read it back whole.
const notes = (mission: MissionRecord): string => mission.evidence.map((entry) => entry.text).join('\n').replace(/\nacceptance \(continued\): /g, ' ');
const referencesRoot = (h: HostHarness) => path.join(h.provider.jobs.root, '..', 'references');
// The agent's read-only copies of the original (I-16), apart from the host's references.
const originalsRoot = (h: HostHarness) => path.join(h.provider.jobs.root, '..', 'originals');

async function withProject(body: (h: HostHarness) => Promise<void>, code = SLOW, settings: Record<string, unknown> = {}): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', mode: 'mission', ...settings });
  try {
    await h.writeFile('package.json', JSON.stringify({ name: 'report', private: true, scripts: { test: 'node t.js', check: 'node acceptance/bench.js' } }));
    await h.writeFile('t.js', 'process.exit(0);\n');
    await h.writeFile('lib/report.js', code);
    await h.writeFile('acceptance/bench.js', BENCH);
    await h.writeFile(REF_PATH, REFERENCE);
    await body(h);
  } finally {
    for (const job of h.provider.jobs.list()) {
      rmSync(job.dir, { recursive: true, force: true });
    }
    for (const programme of h.provider.programmes.list()) {
      rmSync(path.join(h.provider.jobs.root, '..', 'programmes', programme.id), { recursive: true, force: true });
    }
    rmSync(referencesRoot(h), { recursive: true, force: true });
    rmSync(originalsRoot(h), { recursive: true, force: true });
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function baselineAndMission(h: HostHarness): Promise<{ programme: ProgrammeRecord; mission: { id: string; revision: number } }> {
  const created = await createProgramme(host(h), PROGRAMME);
  assert.ok(created.ok, created.ok ? '' : created.error);
  let measured = await runMeasurePhase(host(h), created.value.id);
  // A noisy machine (test files run in parallel) can make the baseline inconclusive: measure again, as a user would.
  for (let retry = 0; retry < 2 && measured.ok && measured.value.phases[0]?.status === 'inconclusive'; retry += 1) {
    measured = await runMeasurePhase(host(h), created.value.id, { again: true });
  }
  assert.ok(measured.ok && measured.value.phases[0]?.status === 'verified', measured.ok ? measured.value.phases[0]?.note : measured.error);
  const plan = { goal: 'Make checksum at least ten times faster, same results.', assumptions: [], steps: [{ id: 't1', title: 'Speed up lib/report.js', successCriterion: 'the host measures it 10x faster and it gives the original results' }], risks: [] };
  h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: plan }]) });
  await h.provider.sendMessage('Make the report checksum at least ten times faster, same results.', 'mission', 'local');
  h.send({ type: 'navigate', screen: 'settings' });
  const shown = (await h.waitFor((state: PostedState) => (state.memory as { mission: unknown } | undefined)?.mission != null)).memory as { mission: { id: string; revision: number } };
  h.model.requests.length = 0;
  return { programme: measured.value, mission: shown.mission };
}

/** The host records of the reference checks of this Mission (outside the project). */
function hostRecords(h: HostHarness): Array<{ outcome: string; seeds: { shown: string; reserved: string }; inputsDigest: unknown; differences: Array<{ pool: string; input: number[]; original: { value: number } }> }> {
  const out = [];
  for (const dir of readdirSync(referencesRoot(h))) {
    const passes = path.join(referencesRoot(h), dir, 'passes');
    for (const file of (() => { try { return readdirSync(passes).sort(); } catch { return []; } })()) {
      out.push(JSON.parse(readFileSync(path.join(passes, file), 'utf8')));
    }
  }
  return out;
}

test('P5b: fast but imprecise is rejected by the comparison with the frozen original even though the metric is met; the agent sees failing inputs, never the original results; the exact fix passes', async () => {
  await withProject(async (h) => {
    const { programme, mission } = await baselineAndMission(h);
    assert.match(programme.phases[0]?.note ?? '', /; reference acceptance\/report\.rame-reference\.json: the original answers every input the same way twice\.$/);
    h.model.enqueue(
      // Run 1: look for the hidden description, then the fast float form.
      call('peek', 'read_file', { path: REF_PATH, maxBytes: 4096 }),
      patch('float', 'lib/report.js', SLOW, FLOAT),
      say('Done: closed form, instant now.'),
      say('Done, no test needed.'),
      // Run 2: after the host's feedback (failing inputs), the exact form.
      patch('exact', 'lib/report.js', FLOAT, EXACT),
      say('Done: exact closed form.'),
      say('Done, no test needed.'),
    );
    const after = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
    assert.ok(after.ok, after.ok ? '' : after.error);
    assert.match(result(h, 'peek'), /^The tool did not run: That file tells the host how to compare your code with the frozen original \(its inputs\); it is hidden from the agent during this Mission\./, 'the reference description is hidden from the agent');
    assert.doesNotMatch(result(h, 'peek'), /"reserved"|"rameReference"/);
    assert.match(JSON.stringify(h.model.requests[0]), /compares your code with a frozen copy of the original on fresh edge and random inputs/);
    const record = h.provider.missions.get(mission.id) as MissionRecord;
    const text = notes(record);
    assert.match(text, /differential reference acceptance\/report\.rame-reference\.json: the host froze the original lib\/report\.js outside the project/);
    // The float form met the speed criterion, but the comparison rejected it in the same host pass.
    assert.match(text, /acceptance \(run by the host\): measured run 1\/3: npm:check exit=0 with every frozen file intact, but the differential comparison with the frozen original \(acceptance\/report\.rame-reference\.json\) failed: \d+ of \d+ shown inputs and \d+ of 12 reserved inputs gave a different result; for example checksum\(\d+\) returned a different result than the original/);
    // What the agent saw: a few failing inputs, never the original's results, never a reserved input.
    const seen = seenByModel(h);
    const failed = hostRecords(h).find((entry) => entry.outcome === 'failed');
    assert.ok(failed, 'the failing pass is in the host record');
    const failureNote = text.split('\n').find((line) => line.includes('the differential comparison with the frozen original') && line.includes('failed:')) ?? '';
    const shownExamples = [...(failureNote.split('for example ')[1] ?? '').matchAll(/checksum\((\d+)\)/g)].map((match) => Number(match[1]));
    assert.ok(shownExamples.length >= 1);
    assert.match(seen, /for example checksum\(\d+\)/, 'the failing inputs reached the agent');
    for (const n of shownExamples) {
      assert.ok(!seen.includes(`${slow(n)}`) || slow(n) < 1000, `the original's result for ${n} never reached the agent`);
    }
    for (const entry of failed.differences.filter((item) => item.pool === 'reserved')) {
      assert.ok(!seen.includes(`checksum(${entry.input[0]})`), 'a reserved input never reached the agent');
    }
    // Reproducible: the seeds in the host record give exactly the inputs of that pass.
    assert.deepEqual(replayRecordInputs(REFERENCE, failed.seeds)?.digest, failed.inputsDigest);
    assert.equal(failed.differences[0]?.original.value, slow(failed.differences[0]!.input[0]!));
    // The exact form: speed and the comparison pass in the same host pass.
    assert.equal(record.status, 'completed', record.note);
    const phase = after.value.phases[1];
    assert.equal(phase?.status, 'verified', phase?.note);
    assert.match(phase?.note ?? '', /^Verified by the host: metrics measured by the host: (?:second measurement \(the first was inconclusive\): )?wall_ms median .* met \[observed by the host\]; npm:check exit=0 with every frozen file intact; reinforced level: differential with the frozen original \(acceptance\/report\.rame-reference\.json\): \d+ inputs \(\d+ edge and random, 12 reserved\) gave the same results as the original; host record /);
    assert.equal(after.value.status, 'completed');
    assert.equal(await h.readFile(REF_PATH), REFERENCE);
  });
});

test('P5b sabotage: the agent cannot change the reference description; a changed host copy of the original is never used', async () => {
  await withProject(async (h) => {
    const { programme, mission } = await baselineAndMission(h);
    h.model.enqueue(
      patch('spec', REF_PATH, REFERENCE, REFERENCE.replace('4000000', '1000')),
      patch('exact', 'lib/report.js', SLOW, EXACT),
      say('Done.'),
      say('Done, no test needed.'),
    );
    // Something outside RAME rewrites the host's copy of the original as soon as it exists.
    const timer = setInterval(() => {
      try {
        for (const dir of readdirSync(referencesRoot(h))) {
          const file = path.join(referencesRoot(h), dir, 'files', 'lib', 'report.js');
          if (readFileSync(file, 'utf8') !== EXACT) {
            writeFileSync(file, EXACT);
          }
        }
      } catch {
        // not created yet
      }
    }, 20);
    try {
      const after = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
      assert.ok(after.ok);
      assert.match(result(h, 'spec'), /frozen acceptance check for this Mission and cannot be changed/);
      assert.equal(await h.readFile(REF_PATH), REFERENCE);
      const record = h.provider.missions.get(mission.id) as MissionRecord;
      assert.notEqual(record.status, 'completed');
      assert.match(notes(record), /the host's frozen copy of the original for acceptance\/report\.rame-reference\.json can no longer be trusted: lib\/report\.js changed in it/);
      assert.notEqual(after.value.phases[1]?.status, 'verified');
    } finally {
      clearInterval(timer);
    }
  });
});

test('P5b: a non-deterministic original cannot be the reference of a baseline', async () => {
  await withProject(async (h) => {
    const created = await createProgramme(host(h), PROGRAMME);
    assert.ok(created.ok);
    const measured = await runMeasurePhase(host(h), created.value.id);
    assert.ok(measured.ok);
    assert.equal(measured.value.phases[0]?.status, 'failed');
    assert.match(measured.value.phases[0]?.note ?? '', /Not verifiable: the original in lib\/report\.js gave two different results for checksum\(\d+\); a function that does not always give the same result cannot be a reference\. The baseline was not frozen\./);
    assert.equal(measured.value.baseline, null);
  }, SLOW.replace('return s;', 'return s + (Math.random() < 0.5 ? 1 : 0);'));
});

test('P5b: interrupted during the host check, then a reload and a resume: the frozen original survives and the phase is verified only after the resumed comparison passes', async () => {
  await withProject(async (h) => {
    const { programme, mission } = await baselineAndMission(h);
    h.model.enqueue(patch('exact', 'lib/report.js', SLOW, EXACT), say('Done: exact closed form.'), say('Done, no test needed.'));
    const running = startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
    await h.waitFor((state: PostedState) => /^Running the acceptance check npm:check/.test(state.status), 30_000);
    h.provider.cancelRequest();
    const stopped = await running;
    assert.ok(stopped.ok);
    assert.equal((h.provider.missions.get(mission.id) as MissionRecord).status, 'interrupted');
    assert.equal(stopped.value.phases[1]?.status, 'running');
    // The window reloads: the grant still names the host's frozen copy, intact.
    h.createProvider();
    const reloaded = h.provider.missions.get(mission.id) as MissionRecord;
    const references = reloaded.grant?.acceptance?.references ?? [];
    assert.equal(references.length, 1);
    assert.equal(readFileSync(path.join(references[0]!.dir, 'files', 'lib', 'report.js'), 'utf8'), SLOW, 'the original, not the agent’s version');
    h.model.enqueue(say('The fix is in place; done.'), say('Done, no test needed.'));
    await h.provider.resumeMission(reloaded.id, reloaded.revision);
    const resumed = h.provider.missions.get(mission.id) as MissionRecord;
    assert.equal(resumed.status, 'completed', resumed.note);
    const refreshed = await refreshProgramme(host(h), programme.id);
    assert.ok(refreshed.ok && refreshed.value.phases[1]?.status === 'verified', refreshed.ok ? refreshed.value.phases[1]?.note : refreshed.error);
    assert.match(refreshed.value.phases[1]?.note ?? '', /differential with the frozen original \(acceptance\/report\.rame-reference\.json\)/);
  });
});

test('P5b: functional cases show the inputs of the cases that fail, never their expected values', async () => {
  await withProject(async (h) => {
    const cases = JSON.stringify({ rameCases: 1, module: 'lib/report.js', cases: [[0, 0], [3, slow(3)], [2999999, slow(2999999)], [3999999, slow(3999999)]].map(([n, expect]) => ({ call: 'checksum', args: [n], expect })) });
    await h.writeFile('acceptance/report.rame-cases.json', cases);
    const created = await createProgramme(host(h), { ...PROGRAMME, check: { ...PROGRAMME.check, files: ['acceptance/bench.js', 'acceptance/report.rame-cases.json'] } });
    assert.ok(created.ok, created.ok ? '' : created.error);
    const measured = await runMeasurePhase(host(h), created.value.id);
    assert.ok(measured.ok && measured.value.phases[0]?.status === 'verified');
    const plan = { goal: 'Faster checksum.', assumptions: [], steps: [{ id: 't1', title: 'Speed up lib/report.js', successCriterion: 'measured faster, cases pass' }], risks: [] };
    h.model.enqueue({ kind: 'json', body: toolCallReply([{ id: 'plan', name: 'submit_mission_plan', args: plan }]) });
    await h.provider.sendMessage('Faster checksum.', 'mission', 'local');
    h.send({ type: 'navigate', screen: 'settings' });
    const shown = (await h.waitFor((state: PostedState) => (state.memory as { mission: unknown } | undefined)?.mission != null)).memory as { mission: { id: string; revision: number } };
    h.model.requests.length = 0;
    h.model.enqueue(patch('float', 'lib/report.js', SLOW, FLOAT), say('Done.'), say('Done, no test needed.'), patch('exact', 'lib/report.js', FLOAT, EXACT), say('Done.'), say('Done, no test needed.'));
    const after = await startMissionPhase(host(h), measured.value.id, 1, shown.mission.id, shown.mission.revision);
    assert.ok(after.ok);
    const text = notes(h.provider.missions.get(shown.mission.id) as MissionRecord);
    assert.match(text, /host-compared cases in acceptance\/report\.rame-cases\.json failed: case \d \(checksum\((2999999|3999999)\)\) returned a different value than expected/);
    const seen = seenByModel(h);
    assert.ok(!seen.includes(String(slow(2999999))) && !seen.includes(String(slow(3999999))), 'the expected values never reached the agent');
    assert.equal(after.value.phases[1]?.status, 'verified', after.value.phases[1]?.note);
  });
});

type ToolsRequest = { tools?: Array<{ function: { name: string } }> };

test('I-16: in the Mission the agent reads the original through read_original, without a card and even after overwriting its own file; the host copy, the reference and the records stay out of reach', async () => {
  await withProject(async (h) => {
    const { programme, mission } = await baselineAndMission(h);
    h.model.enqueue(
      call('list', 'read_original', {}),
      patch('float', 'lib/report.js', SLOW, FLOAT),
      say('Done: closed form.'),
      say('Done, no test needed.'),
      // Run 2, after the comparison failed: the original as it was, not the float form now in the file.
      call('orig', 'read_original', { path: 'lib/report.js' }),
      call('trick', 'read_original', { path: `../references/${REF_PATH}` }),
      patch('exact', 'lib/report.js', FLOAT, EXACT),
      say('Done: exact closed form, same results as the original.'),
      say('Done, no test needed.'),
    );
    const after = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
    assert.ok(after.ok, after.ok ? '' : after.error);
    assert.ok((h.model.requests as ToolsRequest[]).every((request) => request.tools?.some((tool) => tool.function.name === 'read_original')), 'offered in every run of this Mission');
    assert.match(result(h, 'list'), /^READ-ONLY COPY OF THE ORIGINAL, as it was when the Mission was authorized[^\n]*\n- lib\/report\.js\nRead one with read_original/);
    assert.ok(result(h, 'orig').includes(SLOW), 'the original, as frozen');
    assert.equal(result(h, 'orig').includes('(n - 1) / 2'), false, 'not the float form the agent had written');
    assert.match(result(h, 'trick'), /Only the original files can be read with read_original: lib\/report\.js\./);
    const record = h.provider.missions.get(mission.id) as MissionRecord;
    assert.equal(record.status, 'completed', record.note);
    assert.equal(after.value.phases[1]?.status, 'verified', after.value.phases[1]?.note);
    const seen = seenByModel(h);
    for (const secret of [referencesRoot(h), originalsRoot(h), ...hostRecords(h).flatMap((entry) => [entry.seeds.shown, entry.seeds.reserved]), '"rameReference"']) {
      assert.equal(seen.includes(secret), false, `never sent to the model: ${secret}`);
    }
    assert.match(notes(record), /the agent can read a separate read-only copy with read_original/);
  });
});

test('escalation: a blocked local Mission only offers Meta; the exact text is shown first, nothing is sent without approval, no protected data is in it, and the advice waits for the next run with Glimmer', async () => {
  await withProject(async (h) => {
    h.secretValues.set(API_KEY_SECRET, 'fake-meta-key-p5b');
    fakeCloud.requests.length = 0;
    fakeCloud.handler = null;
    try {
      const { programme, mission } = await baselineAndMission(h);
      // Glimmer keeps the float form; every later run changes nothing (the harness answers "done").
      h.model.enqueue(patch('float', 'lib/report.js', SLOW, FLOAT), say('Done: closed form.'), say('Done, no test needed.'));
      const after = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
      assert.ok(after.ok, after.ok ? '' : after.error);
      const blocked = h.provider.missions.get(mission.id) as MissionRecord;
      assert.equal(blocked.status, 'blocked', blocked.note);
      assert.notEqual(after.value.phases[1]?.status, 'verified');
      const offer = h.provider.consultOffer;
      assert.ok(offer, 'Meta is offered');
      assert.equal(offer.missionId, mission.id);
      assert.equal(fakeCloud.requests.length, 0, 'nothing was sent: it is only an offer');
      assert.match(h.last().status, /You can ask Meta muse-spark-[\d.]+ for advice with the exact text shown, or dismiss\./);
      // The text shown is what would be sent: the goal, why it blocked, the host's notes; nothing protected.
      assert.match(offer.payload, /Task:\nMake checksum at least ten times faster, same results\.\nCurrent task: Speed up lib\/report\.js/);
      assert.match(offer.payload, /is blocked: /);
      const records = hostRecords(h);
      const reservedInputs = records.flatMap((entry) => entry.differences.filter((item) => item.pool === 'reserved').map((item) => `checksum(${item.input[0]})`));
      for (const secret of [REFERENCE, '"rameReference"', '"reserved"', referencesRoot(h), originalsRoot(h), ...records.flatMap((entry) => [entry.seeds.shown, entry.seeds.reserved]), ...reservedInputs]) {
        assert.equal(offer.payload.includes(secret), false, `not in the text for Meta: ${secret.slice(0, 40)}`);
      }
      assert.ok(offer.fileCandidates.includes('lib/report.js'), 'the user may choose to add the code');
      assert.equal(offer.fileCandidates.includes(REF_PATH), false, 'never the hidden reference description');
      await h.provider.includeConsultFiles(offer.digest, [REF_PATH]);
      assert.match(h.last().status, /^Only files this run read can be included/);
      assert.equal(fakeCloud.requests.length, 0);
      // The user approves this exact text: one request to Meta, then nothing runs by itself.
      const localCalls = h.model.requests.length;
      fakeCloud.handler = () =>
        Response.json({
          choices: [{ message: { role: 'assistant', content: JSON.stringify({ diagnosis: 'n*(n-1) passes 2^53 above about 1.5 million.', steps: ['Halve the even factor first, then reduce both factors modulo M before multiplying.'], checks: ['The host comparison passes.'] }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 300, completion_tokens: 60, total_tokens: 360 },
        });
      const digest = h.provider.consultOffer!.digest;
      await h.provider.approveConsult(digest);
      assert.equal(fakeCloud.requests.length, 1);
      const sent = fakeCloud.requests[0]?.body as { messages: Array<{ content: string }>; tools?: unknown };
      assert.equal(sent.messages.at(-1)?.content, offer.payload, 'exactly the approved text');
      assert.equal('tools' in sent, false, 'Meta gets no tools');
      assert.equal(h.model.requests.length, localCalls, 'no run started by itself');
      const kept = h.provider.missions.get(mission.id) as MissionRecord;
      assert.equal(kept.status, 'blocked', 'still blocked until the user retries');
      assert.match(kept.auto?.pendingAdvice ?? '', /Halve the even factor first/);
      assert.equal(kept.grant?.model, blocked.grant?.model, 'the Mission model did not change');
      assert.match(h.last().status, /Nothing ran: the advice waits for the Mission's next run\. Retry the Mission to let local-glimmer try with it, or leave it blocked\./);
      // The same approval cannot be used twice.
      await h.provider.approveConsult(digest);
      assert.equal(fakeCloud.requests.length, 1);
    } finally {
      fakeCloud.handler = null;
    }
  }, SLOW, { allowCloudEscalation: true });
});

test('escalation OFF: a blocked Mission says how to ask Meta, and offers nothing that could be sent', async () => {
  await withProject(async (h) => {
    fakeCloud.requests.length = 0;
    const { programme, mission } = await baselineAndMission(h);
    h.model.enqueue(patch('float', 'lib/report.js', SLOW, FLOAT), say('Done: closed form.'), say('Done, no test needed.'));
    const after = await startMissionPhase(host(h), programme.id, 1, mission.id, mission.revision);
    assert.ok(after.ok);
    assert.equal((h.provider.missions.get(mission.id) as MissionRecord).status, 'blocked');
    assert.equal(h.provider.consultOffer, null);
    assert.match(h.last().status, /Asking Meta for advice needs cloud escalation ON in Settings; nothing was sent\./);
    assert.equal(fakeCloud.requests.length, 0);
  });
});
