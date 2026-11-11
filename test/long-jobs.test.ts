/**
 * P2 of the long-Mission plan: long jobs that outlive a reload. Real
 * processes: a window that starts a job and dies, a supervisor killed in the
 * middle, and a new window that has to make sense of what is left. The host
 * must never run a job twice, and an uncertain job waits for the user.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  canonicalJobSpec,
  jobApprovalDigest,
  type JobProbe,
  type JobRecord,
  type JobSpec,
  jobSpecDigest,
  parseJobRecord,
  reconcileJob,
} from '../src/jobRecord.js';
import { JOB_SUPERVISOR, pidAnswers } from '../src/jobRunner.js';
import { describeJob, JOB_STATE_KEY, type JobBackend, JobStore, type NewJob } from '../src/jobStore.js';

/** Memento-like storage in one file, shared by every "window" (process). */
class FileBackend implements JobBackend {
  constructor(private readonly file: string) {}
  get(key: string): unknown {
    try {
      return (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  }
  async update(key: string, value: unknown): Promise<void> {
    let all: Record<string, unknown> = {};
    try {
      all = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
    } catch {
      // first write
    }
    all[key] = value;
    writeFileSync(`${this.file}.tmp`, JSON.stringify(all));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

class RacingBackend implements JobBackend {
  private state: unknown;
  private lock: Promise<unknown> = Promise.resolve();
  get(): unknown { return structuredClone(this.state); }
  async update(_key: string, value: unknown): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.state = structuredClone(value);
  }
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work, work);
    this.lock = next.then(() => undefined, () => undefined);
    return next;
  }
}

interface Lab {
  root: string;
  workspace: string;
  jobsRoot: string;
  stateFile: string;
  store: (options?: ConstructorParameters<typeof JobStore>[2]) => JobStore;
  cleanup: () => void;
}

const pidsToEnd = new Set<number>();

function lab(): Lab {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-jobs-test-'));
  const workspace = path.join(root, 'ws');
  const jobsRoot = path.join(root, 'jobs');
  const stateFile = path.join(root, 'state.json');
  spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(workspace)},{recursive:true})`]);
  // The job: records each start (a duplicate would show as a second line), ticks, exits.
  writeFileSync(
    path.join(workspace, 'job.js'),
    [
      "const fs = require('node:fs');",
      "fs.appendFileSync('starts.txt', `start ${process.pid}\\n`);",
      'const [ticks, every, code, bytes, quiet] = process.argv.slice(2).map(Number);',
      "if (bytes > 0) { for (let i = 0; i < bytes / 64; i++) console.log(`line ${String(i).padStart(6, '0')} ${'x'.repeat(50)}`); }",
      'let i = 0;',
      'const timer = setInterval(() => { i++; if (!quiet) console.log(`tick ${i}`); if (i >= ticks) { clearInterval(timer); process.exit(code); } }, every);',
    ].join('\n'),
  );
  return {
    root,
    workspace,
    jobsRoot,
    stateFile,
    store: (options) => new JobStore(new FileBackend(stateFile), jobsRoot, options),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const spec = (l: Lab, ticks: number, every: number, extra: Partial<JobSpec> = {}, code = 0, bytes = 0, quiet = false): JobSpec => ({
  executable: process.execPath,
  argv: ['job.js', String(ticks), String(every), String(code), String(bytes), quiet ? '1' : '0'],
  cwd: l.workspace,
  timeoutMs: 60_000,
  maxLogBytes: 64 * 1024,
  heartbeatMs: 100,
  env: {},
  keepElectronRunAsNode: false,
  ...extra,
});

const newJob = (l: Lab, jobSpec: JobSpec, label = 'npm:bench'): NewJob => ({ scopeId: 'scope-1', label, missionId: 'mission-1', spec: jobSpec });

async function startApproved(store: JobStore, job: NewJob): Promise<JobRecord> {
  const started = await store.start(job, jobApprovalDigest(job));
  assert.ok(started.ok, started.ok ? '' : started.error);
  return started.value;
}

const starts = (l: Lab): string[] => (existsSync(path.join(l.workspace, 'starts.txt')) ? readFileSync(path.join(l.workspace, 'starts.txt'), 'utf8').trim().split('\n') : []);

test('two windows reserve the same long job atomically and only one launches it', async () => {
  const l = lab();
  try {
    const backend = new RacingBackend();
    let launches = 0;
    const options = { launch: async () => { launches += 1; } };
    const first = new JobStore(backend, l.jobsRoot, options);
    const second = new JobStore(backend, l.jobsRoot, options);
    const job = newJob(l, spec(l, 1, 50));
    const results = await Promise.all([first.start(job, jobApprovalDigest(job)), second.start(job, jobApprovalDigest(job))]);
    assert.equal(results.filter((result) => result.ok).length, 1, 'one cross-window reservation wins');
    assert.equal(launches, 1, 'the approved command is launched once');
    assert.equal(first.list().length, 1, 'one live record remains');
  } finally {
    l.cleanup();
  }
});

async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value) || Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const endGroup = (pid: number | null): void => {
  if (pid === null) {
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // gone
    }
  }
};

test.after(() => {
  for (const pid of pidsToEnd) {
    endGroup(pid);
  }
});

// ----- The decision after a reload (pure) -----

test('reconcileJob: only a recorded result ends a job, a fresh heartbeat attaches, anything else is uncertain', () => {
  const l = { workspace: '/w' } as Lab;
  const base: JobRecord = {
    id: 'aaaaaaaa-1', scopeId: 's', label: 'npm:bench', missionId: null, spec: spec(l, 1, 1), specDigest: '', dir: '/j/aaaaaaaa-1',
    status: 'running', createdAt: 0, updatedAt: 0, revision: 1, supervisorPid: 10, childPid: 11, exit: null, cancelRequested: false, note: '',
  };
  const probe = (over: Partial<JobProbe>): JobProbe => ({ now: 100_000, exit: null, started: { pid: 10, childPid: 11, startedAt: 1000 }, heartbeatAt: 99_950, childAlive: true, ...over });
  const exit = { exitCode: 0, signal: null, timedOut: false, cancelled: false, endedAt: 60_000 };
  assert.equal(reconcileJob(base, probe({})).status, 'running');
  assert.match(reconcileJob(base, probe({ exit })).note, /finished \(exit 0\) after 60 s/);
  assert.equal(reconcileJob(base, probe({ exit: { ...exit, exitCode: 1 } })).status, 'finished', 'a failing exit is still a recorded result');
  assert.equal(reconcileJob(base, probe({ exit: { ...exit, exitCode: null, cancelled: true } })).status, 'cancelled');
  assert.equal(reconcileJob(base, probe({ exit: { ...exit, exitCode: null, timedOut: true } })).status, 'timed_out');
  assert.equal(reconcileJob(base, probe({ exit: { ...exit, refused: 'x' } })).status, 'refused');
  const silent = reconcileJob(base, probe({ heartbeatAt: 10_000 }));
  assert.equal(silent.status, 'uncertain');
  assert.match(silent.note, /stopped reporting without recording a result \(last sign of life 90 s ago\)\. Its command \(pid 11\) may still be running; RAME Code does not stop it on its own\. Nothing was restarted\./);
  assert.match(reconcileJob(base, probe({ heartbeatAt: 10_000, childAlive: false })).note, /pid 11\) is no longer running/);
  const starting = { ...base, status: 'starting' as const, createdAt: 99_000, supervisorPid: null, childPid: null };
  assert.equal(reconcileJob(starting, probe({ started: null, heartbeatAt: null })).status, 'starting', 'a job just launched gets its grace period');
  const lost = reconcileJob({ ...starting, createdAt: 0 }, probe({ started: null, heartbeatAt: null }));
  assert.equal(lost.status, 'uncertain');
  assert.match(lost.note, /lost track .* while it was starting; it may or may not have started/);
  for (const status of ['finished', 'cancelled', 'timed_out', 'refused', 'abandoned'] as const) {
    assert.equal(reconcileJob({ ...base, status }, probe({ exit })).status, status, `${status} is final`);
  }
});

test('an approval binds the exact job; a damaged or relocated record is refused', async () => {
  const l = lab();
  try {
    const store = l.store();
    const job = newJob(l, spec(l, 1, 10));
    const digest = jobApprovalDigest(job);
    for (const other of [
      { ...job, spec: { ...job.spec, argv: [...job.spec.argv, 'more'] } },
      { ...job, spec: { ...job.spec, timeoutMs: 120_000 } },
      { ...job, spec: { ...job.spec, env: { EXTRA: '1' } } },
      { ...job, label: 'npm:other' },
      { ...job, missionId: 'mission-2' },
      { ...job, scopeId: 'scope-2' },
    ]) {
      const refused = await store.start(other, digest);
      assert.equal(refused.ok, false);
      assert.match(refused.ok ? '' : refused.error, /does not match the job\. Nothing was started\./);
    }
    const invalid = await store.start({ ...job, spec: { ...job.spec, timeoutMs: 7 * 3_600_000 } }, digest);
    assert.match(invalid.ok ? '' : invalid.error, /time limit must be 1 s to 6 h/);
    assert.equal(existsSync(l.jobsRoot), false, 'nothing was created');
    assert.deepEqual(starts(l), []);
    const record = await startApproved(store, job);
    assert.equal(record.specDigest, jobSpecDigest(job.spec));
    assert.equal(readFileSync(path.join(record.dir, 'spec.json'), 'utf8'), canonicalJobSpec(job.spec), 'the supervisor reads exactly the approved bytes');
    assert.notEqual(parseJobRecord(record, l.jobsRoot), null);
    assert.equal(parseJobRecord({ ...record, dir: path.join(l.root, 'elsewhere', record.id) }, l.jobsRoot), null, 'folder outside the jobs root');
    assert.equal(parseJobRecord({ ...record, spec: { ...record.spec, argv: ['evil.js'] } }, l.jobsRoot), null, 'spec changed after approval');
    await store.waitFor(record.id, { pollMs: 50 });
  } finally {
    l.cleanup();
  }
});

// ----- Running, output, results -----

test('a job runs to its end: its exit code and the end of its output are recorded', async () => {
  const l = lab();
  try {
    const store = l.store();
    const ok = await startApproved(store, newJob(l, spec(l, 5, 20)));
    const failing = await startApproved(store, newJob(l, spec(l, 3, 20, {}, 3), 'npm:failing'));
    const first = await store.waitFor(ok.id, { pollMs: 50 });
    const second = await store.waitFor(failing.id, { pollMs: 50 });
    assert.ok(first.ok && second.ok);
    assert.equal(first.value.status, 'finished', first.value.note);
    assert.equal(first.value.exit?.exitCode, 0);
    assert.equal(second.value.status, 'finished');
    assert.equal(second.value.exit?.exitCode, 3);
    assert.match(second.value.note, /finished \(exit 3\)/);
    const tail = await store.tail(ok.id);
    assert.match(tail, /tick 5\n$/);
    const text = describeJob(first.value, 'y'.repeat(5000));
    assert.ok(text.length < 2400, 'the model sees a bounded summary');
    assert.match(text, /^job npm:bench \([0-9a-f-]+\): finished\./);
  } finally {
    l.cleanup();
  }
});

test('the log stays bounded (two rotated files) and keeps the latest output', async () => {
  const l = lab();
  try {
    const store = l.store();
    const job = await startApproved(store, newJob(l, spec(l, 1, 10, { maxLogBytes: 4096 }, 0, 60_000)));
    const done = await store.waitFor(job.id, { pollMs: 50 });
    assert.ok(done.ok && done.value.status === 'finished', done.ok ? done.value.note : done.error);
    assert.ok(statSync(path.join(job.dir, 'log.txt')).size <= 4096);
    assert.ok(statSync(path.join(job.dir, 'log.1.txt')).size <= 4096);
    assert.match(await store.tail(job.id, 8192), /tick 1\n$/);
    assert.match(await store.tail(job.id, 1000), /^line \d{6} x+\n/, 'a cut tail starts at a whole line');
  } finally {
    l.cleanup();
  }
});

// ----- Reloads -----

test('the window that started a job dies (SIGKILL): the next window attaches, never starts it again, and sees the result', async () => {
  const l = lab();
  try {
    const job = newJob(l, spec(l, 30, 100));
    const out = path.join(__dirname, '..', 'src');
    const windowA = [
      `const { JobStore } = require(${JSON.stringify(path.join(out, 'jobStore.js'))});`,
      `const { jobApprovalDigest } = require(${JSON.stringify(path.join(out, 'jobRecord.js'))});`,
      `const fs = require('node:fs');`,
      `const backend = { get: (k) => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(l.stateFile)}, 'utf8'))[k]; } catch { return undefined; } },`,
      `  update: async (k, v) => { let all = {}; try { all = JSON.parse(fs.readFileSync(${JSON.stringify(l.stateFile)}, 'utf8')); } catch {} all[k] = v; fs.writeFileSync(${JSON.stringify(l.stateFile)}, JSON.stringify(all)); } };`,
      `const job = ${JSON.stringify(job)};`,
      `new JobStore(backend, ${JSON.stringify(l.jobsRoot)}).start(job, jobApprovalDigest(job)).then((r) => {`,
      `  if (!r.ok) { console.error(r.error); process.exit(9); }`,
      // The extension host goes away abruptly, as on a reload or a crash.
      `  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 800);`,
      `});`,
    ].join('\n');
    const died = await new Promise<string | null>((resolve) => spawn(process.execPath, ['-e', windowA], { stdio: 'ignore' }).on('exit', (_code, signal) => resolve(signal)));
    assert.equal(died, 'SIGKILL', 'window A was killed');
    // Window B: a fresh store over the same storage.
    const store = l.store();
    const [record] = store.list();
    assert.ok(record, 'window A recorded the job before it ran');
    if (record.supervisorPid !== null) {
      pidsToEnd.add(record.supervisorPid);
    }
    const counts = await store.recover();
    assert.deepEqual(counts, { running: 1, settled: 0, uncertain: 0 }, 'attached, still running');
    const attached = store.get(record.id) as JobRecord;
    assert.equal(attached.status, 'running');
    assert.match(attached.note, /is running \(started at \d{4}-\d\d-\d\dT/, 'the stored note has no relative age that would go stale');
    assert.ok(attached.childPid !== null);
    pidsToEnd.add(attached.childPid as number);
    const again = await store.start(job, jobApprovalDigest(job));
    assert.match(again.ok ? '' : again.error, /is already running .* Nothing was started\./, 'the same job is never started twice');
    const done = await store.waitFor(record.id, { pollMs: 100 });
    assert.ok(done.ok && done.value.status === 'finished', done.ok ? done.value.note : done.error);
    assert.equal(done.value.exit?.exitCode, 0);
    assert.equal(starts(l).length, 1, 'the command ran exactly once');
    // A later window keeps it as it is.
    assert.deepEqual(await l.store().recover(), { running: 0, settled: 0, uncertain: 0 });
    assert.equal(l.store().get(record.id)?.status, 'finished');
  } finally {
    l.cleanup();
  }
});

test('the supervisor dies mid-job: the job is uncertain, cannot be stopped or repeated by RAME, and only the user settles it', async () => {
  const l = lab();
  try {
    const store = l.store();
    // A command that prints nothing: it does not notice its supervisor is gone.
    const job = newJob(l, spec(l, 600, 100, {}, 0, 0, true));
    const record = await startApproved(store, job);
    const running = await until(() => store.refresh(record.id), (r) => r.ok && r.value.status === 'running');
    assert.ok(running.ok && running.value.status === 'running');
    const { supervisorPid, childPid } = running.value;
    assert.ok(supervisorPid !== null && childPid !== null);
    pidsToEnd.add(childPid);
    process.kill(supervisorPid, 'SIGKILL');
    // Window B, after the heartbeat has gone stale.
    const later = l.store();
    const lost = await until(async () => (await later.recover(), later.get(record.id) as JobRecord), (r) => r.status !== 'running', 10_000);
    assert.equal(lost.status, 'uncertain', lost.note);
    assert.match(lost.note, /stopped reporting without recording a result .* Its command \(pid \d+\) may still be running; RAME Code does not stop it on its own\. Nothing was restarted\./);
    assert.equal(pidAnswers(childPid), true, 'RAME did not kill the orphaned command on its own');
    // RAME refuses to act on its own.
    const stop = await later.cancel(record.id);
    assert.match(stop.ok ? '' : stop.error, /no live supervisor .* cannot stop it safely .* pid \d+/);
    const repeat = await later.start(job, jobApprovalDigest(job));
    assert.match(repeat.ok ? '' : repeat.error, /has an unknown result .* decide about it first\. Nothing was started\./);
    assert.deepEqual(await later.recover(), { running: 0, settled: 0, uncertain: 0 }, 'a reload does not settle it either');
    assert.equal(later.get(record.id)?.status, 'uncertain');
    const checked = await later.decide(record.id, 'check-again');
    assert.ok(checked.ok && checked.value.status === 'uncertain');
    // The user ends the orphan themselves, then abandons the job.
    endGroup(childPid);
    const abandoned = await later.decide(record.id, 'abandon');
    assert.ok(abandoned.ok && abandoned.value.status === 'abandoned');
    assert.match(abandoned.value.note, /result .* is unknown, it was not restarted and it does not count as a result/);
    assert.equal(starts(l).length, 1, 'nothing ran twice');
    // Only now may the user start it again, with a new approval.
    const fresh = await startApproved(later, newJob(l, spec(l, 1, 10)));
    assert.notEqual(fresh.id, record.id);
    await later.waitFor(fresh.id, { pollMs: 50 });
    assert.equal(starts(l).length, 2);
  } finally {
    l.cleanup();
  }
});

test('a command that prints output ends with its supervisor (broken pipe), so no unsupervised copy keeps running', async () => {
  const l = lab();
  try {
    const store = l.store();
    const record = await startApproved(store, newJob(l, spec(l, 600, 100)));
    const running = await until(() => store.refresh(record.id), (r) => r.ok && r.value.status === 'running');
    assert.ok(running.ok);
    const { supervisorPid, childPid } = running.value;
    pidsToEnd.add(childPid as number);
    process.kill(supervisorPid as number, 'SIGKILL');
    assert.equal(await until(() => pidAnswers(childPid as number), (alive) => !alive, 5000), false, 'the command ended on its next write');
    const later = l.store();
    const lost = await until(async () => (await later.recover(), later.get(record.id) as JobRecord), (r) => r.status !== 'running', 10_000);
    assert.equal(lost.status, 'uncertain', 'still no recorded result: the user decides');
    assert.match(lost.note, /Its command \(pid \d+\) is no longer running\. Nothing was restarted\./);
    assert.equal(starts(l).length, 1);
  } finally {
    l.cleanup();
  }
});

test('a window that dies after recording a job but before launching it leaves it uncertain, never launched behind the user\'s back', async () => {
  const l = lab();
  try {
    let now = 1_000_000;
    const crashing = l.store({ now: () => now, launch: () => new Promise<void>(() => undefined) });
    const job = newJob(l, spec(l, 1, 10));
    void crashing.start(job, jobApprovalDigest(job));
    const [record] = await until(() => l.store().list(), (jobs) => jobs.length === 1);
    assert.equal(record?.status, 'starting');
    const later = l.store({ now: () => now });
    assert.deepEqual(await later.recover(), { running: 1, settled: 0, uncertain: 0 }, 'within the start grace period it is still starting');
    now += 60_000;
    assert.deepEqual(await later.recover(), { running: 0, settled: 0, uncertain: 1 });
    assert.match(later.get(record!.id)?.note ?? '', /while it was starting; it may or may not have started/);
    assert.equal(existsSync(record!.dir), false, 'no supervisor was ever launched');
    assert.deepEqual(starts(l), []);
  } finally {
    l.cleanup();
  }
});

// ----- The user stops a job; the approved limit -----

test('the user stops a job: the whole command ends, and it stays cancelled after a reload', async () => {
  const l = lab();
  try {
    const store = l.store();
    const record = await startApproved(store, newJob(l, spec(l, 600, 100)));
    const running = await until(() => store.refresh(record.id), (r) => r.ok && r.value.status === 'running');
    assert.ok(running.ok);
    const childPid = running.value.childPid as number;
    pidsToEnd.add(childPid);
    const asked = await store.cancel(record.id);
    assert.ok(asked.ok && asked.value.cancelRequested);
    const done = await store.waitFor(record.id, { pollMs: 100 });
    assert.ok(done.ok && done.value.status === 'cancelled', done.ok ? done.value.note : done.error);
    assert.equal(await until(() => pidAnswers(childPid), (alive) => !alive, 5000), false, 'the command is gone');
    assert.match(await store.tail(record.id), /stopped at the user's request/);
    assert.deepEqual(await l.store().recover(), { running: 0, settled: 0, uncertain: 0 });
    assert.equal(l.store().get(record.id)?.status, 'cancelled');
    const twice = await store.cancel(record.id);
    assert.match(twice.ok ? '' : twice.error, /is already cancelled/);
  } finally {
    l.cleanup();
  }
});

test('the supervisor enforces the approved time limit even with no window left', async () => {
  const l = lab();
  try {
    const record = await startApproved(l.store(), newJob(l, spec(l, 600, 100, { timeoutMs: 1500 })));
    // No window follows it; a later one only reads the result.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const later = l.store();
    assert.deepEqual(await later.recover(), { running: 0, settled: 1, uncertain: 0 });
    const job = later.get(record.id) as JobRecord;
    assert.equal(job.status, 'timed_out', job.note);
    assert.match(job.note, /stopped at its approved limit of 2 s; it did not finish/);
    if (job.childPid !== null) {
      assert.equal(pidAnswers(job.childPid), false);
    }
  } finally {
    l.cleanup();
  }
});

test('a spec changed on disk after approval is refused by the supervisor: nothing runs', async () => {
  const l = lab();
  try {
    const approved = spec(l, 1, 10);
    const store = l.store({
      launch: async (dir, jobSpec) => {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'spec.json'), canonicalJobSpec({ ...jobSpec, argv: ['-e', "require('fs').writeFileSync('pwned','1')"] }));
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [JOB_SUPERVISOR, dir, jobSpecDigest(jobSpec)], { detached: true, stdio: 'ignore' });
          child.once('error', reject);
          child.once('spawn', () => (child.unref(), resolve()));
        });
      },
    });
    const record = await startApproved(store, newJob(l, approved));
    const done = await until(() => store.refresh(record.id), (r) => r.ok && r.value.status !== 'starting');
    assert.ok(done.ok && done.value.status === 'refused', done.ok ? done.value.note : done.error);
    assert.match(done.value.note, /did not run: the job specification changed after it was approved; nothing ran/);
    assert.equal(existsSync(path.join(l.workspace, 'pwned')), false);
    assert.deepEqual(starts(l), []);
  } finally {
    l.cleanup();
  }
});

test('the stored list is bounded and the key is the one documented', async () => {
  const l = lab();
  try {
    const store = l.store();
    const record = await startApproved(store, newJob(l, spec(l, 1, 10)));
    await store.waitFor(record.id, { pollMs: 50 });
    const raw = JSON.parse(readFileSync(l.stateFile, 'utf8')) as Record<string, { version: number; jobs: unknown[] }>;
    assert.equal(raw[JOB_STATE_KEY]?.version, 1);
    assert.equal(raw[JOB_STATE_KEY]?.jobs.length, 1);
  } finally {
    l.cleanup();
  }
});
