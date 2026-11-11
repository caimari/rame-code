/**
 * The long-job heartbeat under load (2026-11-08). Two intermittent failures
 * (`long-jobs` "the window that started a job dies (SIGKILL)" and the Podman
 * "reserving 4 GB under a 2 GB limit") had one cause: the supervisor rewrote
 * `heartbeat` in place, so a host reading it between the truncation and the
 * write saw an empty file, took it as no sign of life, and marked a healthy
 * job `uncertain` about a second after it started. An uncertain job is not
 * observed again: a single torn read lost the job for good.
 *
 * Real processes: a real supervisor, the host's own probe and store.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { jobApprovalDigest, type JobSpec } from '../src/jobRecord.js';
import { pidAnswers, probeJob } from '../src/jobRunner.js';
import { type JobBackend, JobStore } from '../src/jobStore.js';

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

function lab(): { root: string; workspace: string; jobsRoot: string; store: JobStore; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-heartbeat-test-'));
  const workspace = path.join(root, 'ws');
  spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(workspace)},{recursive:true})`]);
  writeFileSync(path.join(workspace, 'job.js'), 'setTimeout(() => process.exit(0), Number(process.argv[2]));\n');
  const jobsRoot = path.join(root, 'jobs');
  return { root, workspace, jobsRoot, store: new JobStore(new FileBackend(path.join(root, 'state.json')), jobsRoot), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const spec = (workspace: string, ms: number): JobSpec => ({
  executable: process.execPath,
  argv: ['job.js', String(ms)],
  cwd: workspace,
  timeoutMs: 60_000,
  maxLogBytes: 64 * 1024,
  // The shortest heartbeat the supervisor accepts: the most rewrites, the widest exposure.
  heartbeatMs: 50,
  env: {},
  keepElectronRunAsNode: false,
});

test('the supervisor replaces its heartbeat atomically: a host reading it as fast as it can never finds it empty, and a healthy job is never uncertain', async () => {
  const l = lab();
  try {
    const job = { scopeId: 'scope-1', label: 'npm:bench', missionId: 'mission-1', spec: spec(l.workspace, 2500) };
    const started = await l.store.start(job, jobApprovalDigest(job));
    assert.ok(started.ok, started.ok ? '' : started.error);
    const { id, dir } = started.value;
    const heartbeat = path.join(dir, 'heartbeat');
    let reads = 0;
    const torn: string[] = [];
    const statuses = new Set<string>();
    // Before its first heartbeat the supervisor is still starting (the host knows that case);
    // from the first one on, every read must find one.
    let beating = false;
    for (;;) {
      // As the host reads it: whatever the file holds at that instant.
      try {
        const text = await readFile(heartbeat, 'utf8');
        const value = Number(text.trim());
        const valid = Number.isFinite(value) && value > 0;
        beating ||= valid;
        if (beating) {
          reads += 1;
          if (!valid) {
            torn.push(JSON.stringify(text));
          }
        }
      } catch (error) {
        if (beating) {
          torn.push((error as NodeJS.ErrnoException).code ?? 'error');
        }
      }
      const now = await l.store.refresh(id);
      assert.ok(now.ok);
      statuses.add(now.value.status);
      if (now.value.status !== 'starting' && now.value.status !== 'running') {
        break;
      }
    }
    assert.ok(reads > 200, `the heartbeat was read often (${reads} times)`);
    assert.deepEqual(torn.slice(0, 5), [], `${torn.length} of ${reads} reads found no valid heartbeat`);
    assert.equal(l.store.get(id)?.status, 'finished', String(l.store.get(id)?.note));
    assert.equal(statuses.has('uncertain'), false);
  } finally {
    l.cleanup();
  }
});

test("the host's probe: a heartbeat caught mid-write (empty, as an older supervisor can leave it for an instant) is read again before the job is judged; one that stays empty is still no sign of life", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-heartbeat-probe-'));
  try {
    const heartbeat = path.join(root, 'heartbeat');
    writeFileSync(path.join(root, 'supervisor.json'), JSON.stringify({ pid: process.pid, childPid: process.pid, startedAt: Date.now() }));
    // Caught mid-write: empty now, written a moment later.
    writeFileSync(heartbeat, '');
    const written = Date.now();
    setTimeout(() => writeFileSync(heartbeat, String(written)), 5);
    const caught = await probeJob(root);
    assert.equal(caught.heartbeatAt, written, 'read again, not taken as no sign of life');
    // Empty for good (the disk is full, the supervisor is gone mid-write): no sign of life.
    writeFileSync(heartbeat, '');
    assert.equal((await probeJob(root)).heartbeatAt, null);
    // No heartbeat at all: answered at once.
    rmSync(heartbeat);
    const before = Date.now();
    assert.equal((await probeJob(root)).heartbeatAt, null);
    assert.ok(Date.now() - before < 50, 'a missing file is not waited for');
    assert.equal(pidAnswers(process.pid), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
