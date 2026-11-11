/**
 * P3 of the long-Mission plan: a long job inside a container. The three
 * sabotage cases of the plan must fail INSIDE the container without touching
 * the computer: writing into the project outside the output folder, reaching
 * the internet, and reserving more memory than allowed. Stopping a container
 * job (also an uncertain one) removes the container by its unique name.
 *
 * The real cases run once per runtime (rootless Podman, Docker) where that
 * runtime and its local image ubuntu:24.04 exist (nothing is ever pulled);
 * elsewhere they are skipped, saying why.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { suggestedContainerSettings } from '../src/jobCommands.js';
import { buildContainerJob, type ContainerRuntime, describeIsolation, type JobContainerSettings, validateContainerSettings } from '../src/jobContainer.js';
import { jobApprovalDigest, type JobRecord, type JobSpec } from '../src/jobRecord.js';
import { JobStore, type NewJob } from '../src/jobStore.js';

const IMAGE = 'ubuntu:24.04';
const ready = (runtime: ContainerRuntime): boolean => {
  try {
    return spawnSync(runtime, ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 20_000 }).status === 0;
  } catch {
    return false;
  }
};
const RUNTIMES: Array<{ runtime: ContainerRuntime; skip: string | false }> = (['podman', 'docker'] as const).map((runtime) => ({ runtime, skip: ready(runtime) ? false : `${runtime} or its local image ${IMAGE} is not available here` }));

const settings = (over: Partial<JobContainerSettings> = {}): JobContainerSettings => ({ ...suggestedContainerSettings(), runtime: 'docker', image: IMAGE, memoryMb: 2048, cpus: 2, outputDir: 'job-output', ...over });

test('container settings are validated; the card says exactly where a job runs', () => {
  assert.ok(validateContainerSettings(settings()).ok);
  for (const [bad, why] of [
    [{ image: '--privileged' }, /local image name/],
    [{ memoryMb: 10 }, /memory must be/],
    [{ cpus: 0 }, /CPUs must be/],
    [{ outputDir: '.git' }, /output folder/],
    [{ outputDir: '../outside' }, /output folder/],
    [{ outputDir: '/abs' }, /output folder/],
    [{ outputDir: 'node_modules/x' }, /output folder/],
    [{ toolMounts: [{ hostPath: '/usr', containerPath: '/work/usr' }] }, /outside \/work/],
    [{ toolMounts: [{ hostPath: 'relative', containerPath: '/opt/x' }] }, /absolute paths/],
    [{ pathEnv: 'bin:/usr/bin' }, /PATH/],
    [{ runtime: 'lxc' }, /podman or docker/],
  ] as const) {
    const checked = validateContainerSettings({ ...settings(), ...bad });
    assert.equal(checked.ok, false, JSON.stringify(bad));
    assert.match(checked.ok ? '' : checked.error, why);
  }
  assert.match(describeIsolation(null), /^isolation: none — it runs on this computer with your permissions/);
  assert.match(describeIsolation(settings({ toolMounts: [] })), /^isolation: container ubuntu:24\.04 \(local image only, never pulled\): no network, 2048 MB of memory, 2 CPU\(s\), the project read-only except job-output\/$/);
  assert.match(describeIsolation(settings({ runtime: 'podman', toolMounts: [] })), /^isolation: (rootless )?podman container ubuntu:24\.04 \(local image only, never pulled\)/);
  assert.equal(validateContainerSettings({ ...settings(), runtime: undefined }).ok && (validateContainerSettings({ ...settings(), runtime: undefined }) as { settings: JobContainerSettings }).settings.runtime, 'docker', 'older settings without a runtime keep Docker');
});

test('the docker command: no network, memory with swap bounded, no pull, no capabilities, project read-only, unique name removed on stop', () => {
  const spec = buildContainerJob({ executable: 'npm', argv: ['run', '--ignore-scripts', 'bench'], projectRoot: '/home/u/p', timeoutMs: 60_000, containerName: 'rame-job-0123456789abcdef', user: '1000:1000' }, settings({ toolMounts: [] }));
  const argv = spec.argv.join(' ');
  for (const part of ['run --rm --init --pull never', '--name rame-job-0123456789abcdef', '--network none', '--memory 2048m --memory-swap 2048m', '--cpus 2 --pids-limit 512', '--cap-drop ALL --security-opt no-new-privileges', '--read-only --tmpfs /tmp:rw,size=256m', '--user 1000:1000', '-v /home/u/p:/work:ro', '-v /home/u/p/job-output:/work/job-output:rw', '-w /work -- ubuntu:24.04 npm run --ignore-scripts bench']) {
    assert.ok(argv.includes(part), part);
  }
  assert.deepEqual(spec.cleanup, { executable: 'docker', argv: ['rm', '-f', 'rame-job-0123456789abcdef'] });
  const rootless = buildContainerJob({ executable: 'npm', argv: ['run', '--ignore-scripts', 'bench'], projectRoot: '/home/u/p', timeoutMs: 60_000, containerName: 'rame-job-0123456789abcdef', user: '1000:1000' }, settings({ runtime: 'podman', toolMounts: [] }));
  assert.equal(rootless.executable, 'podman');
  assert.ok(rootless.argv.includes('--userns=keep-id'), 'rootless Podman maps the user\'s own uid');
  assert.equal(rootless.argv.includes('--user'), false);
  assert.ok(rootless.argv.join(' ').includes('--network none'));
  assert.deepEqual(rootless.cleanup, { executable: 'podman', argv: ['rm', '-f', 'rame-job-0123456789abcdef'] });
});

// ----- Real containers -----

interface Lab {
  project: string;
  store: JobStore;
  cleanup: () => void;
}

function lab(): Lab {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rame-container-test-'));
  const project = path.join(root, 'project');
  mkdirSync(path.join(project, 'job-output'), { recursive: true });
  let state: unknown;
  const store = new JobStore({ get: () => state, update: async (_key, value) => void (state = structuredClone(value)) }, path.join(root, 'jobs'));
  return { project, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

let names = 0;
function containerJob(l: Lab, runtime: ContainerRuntime, script: string, over: Partial<JobContainerSettings> = {}, spec: Partial<JobSpec> = {}): NewJob {
  writeFileSync(path.join(l.project, 'job.js'), script);
  const name = `rame-job-test${process.pid}x${++names}`;
  const user = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid?.()}` : null;
  return { scopeId: 'scope', label: 'npm:bench', missionId: null, spec: { ...buildContainerJob({ executable: 'node', argv: ['job.js'], projectRoot: l.project, timeoutMs: 60_000, containerName: name, user }, settings({ runtime, ...over })), heartbeatMs: 200, ...spec } };
}

async function runToEnd(l: Lab, job: NewJob): Promise<JobRecord> {
  const started = await l.store.start(job, jobApprovalDigest(job));
  assert.ok(started.ok, started.ok ? '' : started.error);
  const done = await l.store.waitFor(started.value.id, { pollMs: 100 });
  assert.ok(done.ok, done.ok ? '' : done.error);
  return done.value;
}

const containerName = (job: NewJob | JobRecord): string => job.spec.cleanup?.argv[2] as string;
const containerExists = (job: NewJob | JobRecord): boolean => execFileSync(job.spec.executable, ['ps', '-a', '--filter', `name=^${containerName(job)}$`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim() === containerName(job);

for (const { runtime, skip } of RUNTIMES) {
  test(`${runtime}: P3 sabotage: writing the project outside the output folder and reaching the internet both fail inside the container`, { skip }, async () => {
  const l = lab();
  try {
    const job = containerJob(
      l,
      runtime,
      [
        "const fs = require('node:fs');",
        'const out = {};',
        "try { fs.writeFileSync('/work/hack.txt', 'x'); out.project = 'WROTE'; } catch (e) { out.project = e.code; }",
        "try { fs.writeFileSync('/work/package.json', '{}'); out.overwrite = 'WROTE'; } catch (e) { out.overwrite = e.code; }",
        "try { fs.writeFileSync('/etc/rame', 'x'); out.system = 'WROTE'; } catch (e) { out.system = e.code; }",
        "fetch('https://example.com').then(() => { out.network = 'REACHED'; }, (e) => { out.network = String(e.cause?.code ?? e.message); })",
        "  .finally(() => { fs.writeFileSync('/work/job-output/result.json', JSON.stringify(out)); console.log(JSON.stringify(out)); });",
      ].join('\n'),
    );
    writeFileSync(path.join(l.project, 'package.json'), '{"name":"kept"}');
    const done = await runToEnd(l, job);
    assert.equal(done.status, 'finished', done.note);
    assert.equal(done.exit?.exitCode, 0);
    const out = JSON.parse(readFileSync(path.join(l.project, 'job-output', 'result.json'), 'utf8')) as Record<string, string>;
    assert.equal(out.project, 'EROFS', 'the project is read-only');
    assert.equal(out.overwrite, 'EROFS');
    assert.match(out.system ?? '', /^(EROFS|EACCES)$/, 'the container root is read-only');
    assert.notEqual(out.network, 'REACHED', 'no network');
    assert.equal(existsSync(path.join(l.project, 'hack.txt')), false, 'nothing reached the computer');
    assert.equal(readFileSync(path.join(l.project, 'package.json'), 'utf8'), '{"name":"kept"}');
    assert.equal(containerExists(job), false, 'the container is gone');
  } finally {
    l.cleanup();
  }
});

  test(`${runtime}: P3 sabotage: reserving 4 GB under a 2 GB limit kills the job inside its container, not the computer`, { skip }, async () => {
  const l = lab();
  try {
    const job = containerJob(l, runtime, "const chunks = []; for (let i = 0; i < 16; i++) { chunks.push(Buffer.alloc(256 * 1024 * 1024, 1)); require('node:fs').writeFileSync('/work/job-output/mb.txt', String((i + 1) * 256)); } console.log('ALLOCATED 4096 MB');\n");
    const done = await runToEnd(l, job);
    assert.equal(done.status, 'finished', done.note);
    assert.equal(done.exit?.exitCode, 137, 'killed by the out-of-memory killer of its container');
    const reached = Number(readFileSync(path.join(l.project, 'job-output', 'mb.txt'), 'utf8'));
    assert.ok(reached < 2048, `it never got past its limit (${reached} MB)`);
    assert.doesNotMatch(await l.store.tail(done.id), /ALLOCATED/);
    // The bound is what the job itself recorded: it never got past its limit. The machine's free
    // memory is not a reliable measure (other processes of the computer change it meanwhile).
    assert.equal(containerExists(job), false);
  } finally {
    l.cleanup();
  }
});

  test(`${runtime}: an image that is not on the machine is never pulled: the job fails at once`, { skip }, async () => {
  const l = lab();
  try {
    const done = await runToEnd(l, containerJob(l, runtime, 'console.log(1);\n', { image: 'rame-code-test/never-pulled:none' }));
    assert.equal(done.status, 'finished');
    assert.notEqual(done.exit?.exitCode, 0);
    assert.match(await l.store.tail(done.id), /No such image|not found|image not known|pull access denied|Unable to find image/i);
    assert.equal(spawnSync(runtime, ['image', 'inspect', 'rame-code-test/never-pulled:none'], { stdio: 'ignore' }).status === 0, false, 'nothing was downloaded');
  } finally {
    l.cleanup();
  }
});

  test(`${runtime}: stopping a container job removes its container; an uncertain container job can be stopped safely by its name`, { skip }, async () => {
  const l = lab();
  try {
    const quiet = 'setInterval(() => {}, 1000);\n';
    const first = containerJob(l, runtime, quiet);
    const started = await l.store.start(first, jobApprovalDigest(first));
    assert.ok(started.ok);
    for (let i = 0; i < 100 && !containerExists(first); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(containerExists(first), true);
    for (let i = 0; i < 50 && l.store.get(started.value.id)?.status !== 'running'; i++) {
      await l.store.refresh(started.value.id);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const asked = await l.store.cancel(started.value.id);
    assert.ok(asked.ok, asked.ok ? '' : asked.error);
    const stopped = await l.store.waitFor(started.value.id, { pollMs: 100 });
    assert.ok(stopped.ok && stopped.value.status === 'cancelled', stopped.ok ? stopped.value.note : stopped.error);
    assert.equal(containerExists(first), false, 'stopped and removed');

    // The supervisor dies; the container keeps running; the user stops it by name.
    const second = containerJob(l, runtime, quiet);
    const again = await l.store.start(second, jobApprovalDigest(second));
    assert.ok(again.ok);
    let running = again.value;
    for (let i = 0; i < 100 && (running.status !== 'running' || !containerExists(second)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const r = await l.store.refresh(again.value.id);
      running = r.ok ? r.value : running;
    }
    process.kill(running.supervisorPid as number, 'SIGKILL');
    let lost = running;
    for (let i = 0; i < 60 && lost.status !== 'uncertain'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await l.store.recover();
      lost = l.store.get(again.value.id) as JobRecord;
    }
    assert.equal(lost.status, 'uncertain', lost.note);
    assert.match(lost.note, new RegExp(`Its cleanup \\(${runtime} rm -f ${containerName(second)}\\) has not run: Stop runs it\\.`));
    assert.equal(containerExists(second), true, 'RAME did not remove it on its own');
    const byName = await l.store.cancel(again.value.id);
    assert.ok(byName.ok && byName.value.status === 'cancelled', byName.ok ? byName.value.note : byName.error);
    assert.match(byName.value.note, /Stopped by the user after RAME Code lost track .* its result is unknown/);
    assert.equal(containerExists(second), false);
  } finally {
    l.cleanup();
  }
});
}
