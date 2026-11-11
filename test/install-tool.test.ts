/**
 * Installs with permission (roadmap 6.2): RAME says what it needs and asks;
 * with permission it installs and checks the result itself; administrator
 * rights go through the user's own password (a terminal) or UAC; automatic
 * installs only when the user chose them, and never with administrator
 * rights. SIMULATED model replies; the installs run for real (a local image
 * copied from Docker into Podman) or against stand-in sudo/dpkg-query
 * programs on PATH (no real system package is installed).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { isAutoAllowed } from '../src/agentProfiles.js';
import { validateToolArgs } from '../src/agentTools.js';
import { installRunsWithoutCard, planInstall, readInstalled, validateInstallRequest } from '../src/installPlan.js';
import { installToolDefinitions, setInstallTerminal, trustedInvocation } from '../src/installTool.js';
import { assistantText, HostHarness, toolCallReply } from './helpers/hostHarness.js';

type Request = { tools?: Array<{ function: { name: string } }>; messages?: Array<{ content: string | null; tool_call_id?: string }> };
const call = (id: string, name: string, args: Record<string, unknown>) => ({ kind: 'json' as const, body: toolCallReply([{ id, name, args }]) });
const say = (text: string) => ({ kind: 'json' as const, body: assistantText(text) });
const result = (h: HostHarness, id: string) => String((h.model.requests as Request[]).flatMap((r) => r.messages ?? []).find((m) => m.tool_call_id === id)?.content ?? '');

async function withHost(settings: Record<string, unknown>, body: (h: HostHarness) => Promise<void>): Promise<void> {
  const h = new HostHarness();
  await h.start({ agentProfile: 'safe-auto', ...settings });
  try {
    await body(h);
  } finally {
    h.provider.cancelRequest();
    await h.dispose();
  }
}

async function run(h: HostHarness, text: string, options: { approve?: boolean; beforeApproval?: () => void } = {}): Promise<string[]> {
  const cards: string[] = [];
  let done = false;
  const sent = h.provider.sendMessage(text, 'agent', 'local').then(() => (done = true));
  let seen = '';
  const deadline = Date.now() + 60000;
  while (!done && Date.now() < deadline) {
    const pending = h.last()?.agentPending as { actionId: string; digest: string; tool: string; targets: string[] } | null | undefined;
    if (pending && pending.actionId !== seen) {
      seen = pending.actionId;
      cards.push(`${pending.tool} | ${pending.targets.join(' | ')}`);
      options.beforeApproval?.();
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

// ----- What runs, for each package manager (pure) -----

test('the request is validated per package manager; nothing becomes a shell line', () => {
  assert.deepEqual(validateInstallRequest({ manager: 'apt', name: 'podman' }), { ok: true, request: { manager: 'apt', name: 'podman' } });
  for (const bad of [{ manager: 'brew', name: 'x' }, { manager: 'apt', name: 'podman; rm -rf /' }, { manager: 'apt', name: '-o=APT::x' }, { manager: 'npm', name: 'Left Pad' }, { manager: 'pip', name: 'x', version: '1.0 && curl' }, { manager: 'image', name: 'ubuntu:24.04' }, { manager: 'apt', name: 'x', runtime: 'podman' }]) {
    assert.equal(validateInstallRequest(bad).ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(validateToolArgs('install_package', { manager: 'apt', name: 'uidmap', reason: 'Podman rootless needs it' }), { manager: 'apt', name: 'uidmap', reason: 'Podman rootless needs it' });
  assert.throws(() => validateToolArgs('install_package', { manager: 'apt', name: 'uidmap' }), /Invalid install_package arguments/, 'it must say why');
  assert.deepEqual(validateToolArgs('check_installed', { manager: 'image', name: 'ubuntu:24.04', runtime: 'podman', waitSec: 10 }), { manager: 'image', name: 'ubuntu:24.04', runtime: 'podman', waitSec: 10 });
});

test('the plan per system: apt with sudo on Ubuntu, winget on Windows, user-level npm and pip, images copied locally when possible', () => {
  const apt = planInstall({ manager: 'apt', name: 'podman' }, { platform: 'linux' });
  assert.ok(apt.ok);
  assert.deepEqual(apt.plan.steps, [{ executable: 'sudo', argv: ['apt-get', 'install', '-y', '--no-install-recommends', 'podman'], elevated: true }]);
  assert.equal(apt.plan.elevated, true);
  assert.match(apt.plan.lines.join('\n'), /you type the sudo password yourself in a terminal; RAME Code never sees it/);
  assert.match((planInstall({ manager: 'apt', name: 'podman' }, { platform: 'win32' }) as { error: string }).error, /use winget on Windows/);
  const winget = planInstall({ manager: 'winget', name: 'RedHat.Podman', version: '5.2.0' }, { platform: 'win32' });
  assert.ok(winget.ok);
  assert.deepEqual(winget.plan.steps[0]?.argv, ['install', '--id', 'RedHat.Podman', '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--version', '5.2.0'], 'the winget repository only, not the Microsoft Store');
  assert.match(winget.plan.lines.join('\n'), /Windows asks you itself \(UAC\)/);
  assert.match(winget.plan.lines.join('\n'), /it accepts the package's license and the source's agreements for you .*approve only if you accept them/, 'the card says what is accepted on the user\'s behalf');
  const pip = planInstall({ manager: 'pip', name: 'requests' }, { platform: 'linux' });
  assert.ok(pip.ok);
  assert.deepEqual(pip.plan.steps[0]?.argv, ['-m', 'pip', 'install', '--user', '--only-binary', ':all:', 'requests'], 'wheels only: no package code runs while installing');
  const npm = planInstall({ manager: 'npm', name: 'autocannon', version: '7.15.0' }, { platform: 'linux' });
  assert.ok(npm.ok && npm.plan.elevated === false);
  assert.deepEqual(npm.plan.steps[0]?.argv, ['install', '--global', '--ignore-scripts', 'autocannon@7.15.0'], 'install scripts never run');
  const local = planInstall({ manager: 'image', name: 'ubuntu:24.04', runtime: 'podman' }, { platform: 'linux', dockerHasImage: true });
  assert.ok(local.ok && local.plan.downloads === false);
  assert.match(local.plan.lines[0] ?? '', /^install: docker save ubuntu:24\.04 \| podman load$/);
  const pull = planInstall({ manager: 'image', name: 'ubuntu:24.04', runtime: 'podman' }, { platform: 'linux', dockerHasImage: false });
  assert.ok(pull.ok && pull.plan.downloads === true);
  assert.match(pull.plan.lines.join('\n'), /downloaded by podman from its registry/);
});

test('the check is read the same way RAME reports it: installed only when the package manager says so', () => {
  assert.deepEqual(readInstalled({ manager: 'apt', name: 'podman' }, 0, 'install ok installed 4.9.3+ds1-1ubuntu0.2'), { installed: true, version: '4.9.3+ds1-1ubuntu0.2' });
  assert.deepEqual(readInstalled({ manager: 'apt', name: 'podman' }, 0, 'deinstall ok config-files 4.9.3'), { installed: false, version: null });
  assert.deepEqual(readInstalled({ manager: 'apt', name: 'podman' }, 1, ''), { installed: false, version: null });
  assert.deepEqual(readInstalled({ manager: 'npm', name: 'autocannon' }, 0, '{"dependencies":{"autocannon":{"version":"7.15.0"}}}'), { installed: true, version: '7.15.0' });
  assert.deepEqual(readInstalled({ manager: 'pip', name: 'requests' }, 0, 'Name: requests\nVersion: 2.32.3\n'), { installed: true, version: '2.32.3' });
  assert.deepEqual(readInstalled({ manager: 'image', name: 'x', runtime: 'podman' }, 0, '[{"Id":"abc"}]'), { installed: true, version: null });
});

test('no profile installs on its own; automatic installs only when the user chose them, in Workspace full, and only for a local copy (no download, no administrator rights)', () => {
  for (const profile of ['ask', 'safe-auto', 'workspace-full'] as const) {
    assert.equal(isAutoAllowed(profile, 'install_package'), false, profile);
  }
  assert.equal(isAutoAllowed('safe-auto', 'check_installed'), true, 'checking is a read');
  const image = (planInstall({ manager: 'image', name: 'ubuntu:24.04', runtime: 'podman' }, { platform: 'linux', dockerHasImage: true }) as unknown as { plan: never }).plan;
  const apt = (planInstall({ manager: 'apt', name: 'podman' }, { platform: 'linux' }) as unknown as { plan: never }).plan;
  assert.equal(installRunsWithoutCard(image, { enabled: true, auto: true }, 'workspace-full'), true);
  assert.equal(installRunsWithoutCard(image, { enabled: true, auto: false }, 'workspace-full'), false);
  assert.equal(installRunsWithoutCard(image, { enabled: true, auto: true }, 'safe-auto'), false);
  assert.equal(installRunsWithoutCard(apt, { enabled: true, auto: true }, 'workspace-full'), false, 'administrator rights always wait');
  for (const download of [
    planInstall({ manager: 'npm', name: 'autocannon' }, { platform: 'linux' }),
    planInstall({ manager: 'pip', name: 'requests' }, { platform: 'linux' }),
    planInstall({ manager: 'image', name: 'ubuntu:24.04', runtime: 'podman' }, { platform: 'linux', dockerHasImage: false }),
  ]) {
    assert.ok(download.ok);
    assert.equal(installRunsWithoutCard(download.plan, { enabled: true, auto: true }, 'workspace-full'), false, `${download.plan.request.manager}: a download always waits for a card`);
  }
  assert.match((image as unknown as { lines: string[] }).lines.join('\n'), /installing it does not authorize running it/);
});

test('the programs that run are found only in absolute PATH entries outside the project', () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'rame-trusted-bin-'));
  const project = mkdtempSync(path.join(os.tmpdir(), 'rame-trusted-project-'));
  try {
    for (const dir of [bin, project]) {
      writeFileSync(path.join(dir, 'sudo'), '#!/bin/sh\nexit 0\n');
      chmodSync(path.join(dir, 'sudo'), 0o755);
    }
    const pathEnv = [project, '.', 'relative/bin', path.join(project, 'sub'), bin].join(':');
    assert.equal(trustedInvocation('sudo', ['-n', 'true'], project, 'linux', pathEnv).executable, path.join(bin, 'sudo'), 'the one planted in the project is skipped');
    assert.throws(() => trustedInvocation('sudo', [], project, 'linux', [project, '.'].join(':')), /not found in a safe PATH entry/);
    // A folder outside the project whose program is a symbolic link into the project.
    const linked = mkdtempSync(path.join(os.tmpdir(), 'rame-trusted-link-'));
    symlinkSync(path.join(project, 'sudo'), path.join(linked, 'sudo'));
    assert.equal(trustedInvocation('sudo', [], project, 'linux', [linked, bin].join(':')).executable, path.join(bin, 'sudo'), 'a link into the project is skipped');
    // A folder anyone may write to.
    const open = mkdtempSync(path.join(os.tmpdir(), 'rame-trusted-open-'));
    writeFileSync(path.join(open, 'sudo'), '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(open, 'sudo'), 0o755);
    chmodSync(open, 0o777);
    assert.equal(trustedInvocation('sudo', [], project, 'linux', [open, bin].join(':')).executable, path.join(bin, 'sudo'), 'a world-writable folder is skipped');
    rmSync(linked, { recursive: true, force: true });
    rmSync(open, { recursive: true, force: true });
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// ----- With the host -----

test('offered by default in Agent (each install on a card), never in a Mission run; a rejected card installs nothing', async () => {
  await withHost({}, async (h) => {
    assert.deepEqual(installToolDefinitions(h.provider).map((tool) => tool.function.name), ['install_package', 'check_installed']);
    h.provider.missionAuto = { missionId: 'mis_000000000000000000000000', stop: null, holdAutonomy: false };
    assert.deepEqual(installToolDefinitions(h.provider), []);
    h.provider.missionAuto = null;
    h.model.enqueue(call('i', 'install_package', { manager: 'npm', name: 'rame-code-never-real', reason: 'the task needs the CLI' }), say('Okay.'));
    const cards = await run(h, 'Prepare the CLI.', { approve: false });
    assert.equal(((h.model.requests[0] as Request).tools ?? []).some((tool) => tool.function.name === 'install_package'), true);
    assert.equal(cards.length, 1);
    assert.match(cards[0] ?? '', /^install_package \| why: the task needs the CLI \| install: npm install --global --ignore-scripts rame-code-never-real[^]*\| isolation: isolated: writes only in the project, temporary and package-cache folders; network allowed$/);
  });
  await withHost({ installs: { enabled: false, auto: false } }, async (h) => {
    assert.deepEqual(installToolDefinitions(h.provider), [], 'the user can turn installs off');
  });
});

const hasRuntimes = spawnSync('docker', ['image', 'inspect', 'ubuntu:24.04'], { stdio: 'ignore' }).status === 0 && spawnSync('podman', ['--version'], { stdio: 'ignore' }).status === 0;

test('approved: an image in Docker is copied into Podman (nothing downloaded) and RAME verifies it; then it says there is nothing to do', { skip: hasRuntimes ? false : 'Docker with ubuntu:24.04 and Podman are needed here' }, async () => {
  const tag = `rame-code-test/install:${process.pid}`;
  spawnSync('docker', ['tag', 'ubuntu:24.04', tag]);
  try {
    await withHost({ shell: { enabled: false, isolation: 'total' } }, async (h) => {
      h.model.enqueue(call('i', 'install_package', { manager: 'image', name: tag, runtime: 'podman', reason: 'the job container needs it' }), call('again', 'install_package', { manager: 'image', name: tag, runtime: 'podman', reason: 'again' }), say('Done.'));
      const cards = await run(h, 'Prepare the image for Podman.');
      assert.equal(cards.length, 2);
      assert.match(cards[0] ?? '', new RegExp(`install: docker save ${tag.replace(/[/.]/g, '\\$&')} \\| podman load \\| container image .* copied from Docker into Podman on this computer: nothing is downloaded`));
      assert.equal(result(h, 'i'), `Installed and verified by RAME Code: image ${tag}. Isolation: no isolation: the command runs with your permissions.`);
      assert.equal(result(h, 'again'), `Nothing to do: image ${tag} is already installed.`);
      assert.equal(spawnSync('podman', ['image', 'inspect', tag], { stdio: 'ignore' }).status, 0);
    });
  } finally {
    spawnSync('podman', ['rmi', '-f', tag], { stdio: 'ignore' });
    spawnSync('docker', ['rmi', tag], { stdio: 'ignore' });
  }
});

test('automatic installs (chosen by the user, Workspace full): no card for the local image copy; a download (npm) and an apt install still wait for a card', { skip: hasRuntimes ? false : 'Docker with ubuntu:24.04 and Podman are needed here' }, async () => {
  const tag = `rame-code-test/auto:${process.pid}`;
  spawnSync('docker', ['tag', 'ubuntu:24.04', tag]);
  try {
    await withHost({ agentProfile: 'workspace-full', installs: { enabled: true, auto: true }, shell: { enabled: false, isolation: 'total' } }, async (h) => {
      // A rejected card ends the run, so each case gets its own request.
      h.model.enqueue(call('i', 'install_package', { manager: 'image', name: tag, runtime: 'podman', reason: 'the job container needs it' }), call('n', 'install_package', { manager: 'npm', name: 'rame-code-never-real', reason: 'test' }));
      const first = await run(h, 'Prepare the image and the npm tool.', { approve: false });
      assert.deepEqual(first.map((card) => card.split(' | ')[2]), ['install: npm install --global --ignore-scripts rame-code-never-real'], 'the local copy ran without a card; the download asked');
      h.model.enqueue(call('a', 'install_package', { manager: 'apt', name: 'rame-code-never-real', reason: 'test' }));
      const second = await run(h, 'Install the system package.', { approve: false });
      assert.deepEqual(second.map((card) => card.split(' | ')[2]), ['install: sudo apt-get install -y --no-install-recommends rame-code-never-real'], 'an administrator install asks');
      assert.equal(result(h, 'i'), `Installed and verified by RAME Code: image ${tag}. Isolation: no isolation: the command runs with your permissions.`);
      const docker = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' }).stdout.trim().replace(/^sha256:/, '');
      const podman = spawnSync('podman', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' }).stdout.trim().replace(/^sha256:/, '');
      assert.equal(podman, docker, 'Podman holds exactly the Docker image');
    });
  } finally {
    spawnSync('podman', ['rmi', '-f', tag], { stdio: 'ignore' });
    spawnSync('docker', ['rmi', tag], { stdio: 'ignore' });
  }
});

test('administrator rights: sudo never waits for a password; the command opens in a terminal for the user, and check_installed waits for it', { skip: process.platform === 'linux' ? false : 'apt is for Linux' }, async () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'rame-install-bin-'));
  const marker = path.join(bin, 'typed-the-password');
  // Stand-ins: sudo -n refuses without a password; dpkg-query says installed once the user "ran" it.
  writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nif [ "$1" = "-n" ]; then echo "sudo: a password is required" >&2; exit 1; fi\nexit 0\n');
  writeFileSync(path.join(bin, 'dpkg-query'), `#!/bin/sh\nif [ -f ${JSON.stringify(marker)} ]; then printf 'install ok installed 3.03'; exit 0; fi\nexit 1\n`);
  chmodSync(path.join(bin, 'sudo'), 0o755);
  chmodSync(path.join(bin, 'dpkg-query'), 0o755);
  const original = process.env.PATH;
  let workspace = '';
  const opened: string[] = [];
  setInstallTerminal((title, line) => {
    opened.push(`${title}: ${line}`);
    setTimeout(() => writeFileSync(marker, 'yes'), 2500);
  });
  try {
    await withHost({}, async (h) => {
      workspace = h.workspace;
      // A sudo the agent could have written into the project, reachable through the project folder and "." on PATH.
      await h.writeFile('sudo', `#!/bin/sh\necho pwned > ${JSON.stringify(path.join(workspace, 'pwned'))}\nexit 0\n`);
      chmodSync(path.join(workspace, 'sudo'), 0o755);
      process.env.PATH = [workspace, '.', bin, original].join(path.delimiter);
      h.model.enqueue(call('i', 'install_package', { manager: 'apt', name: 'cowsay', reason: 'the demo script uses it' }), call('c', 'check_installed', { manager: 'apt', name: 'cowsay', waitSec: 20 }), say('Installed.'));
      const cards = await run(h, 'Install cowsay.');
      assert.equal(cards.length, 1, 'check_installed is a read: no card');
      assert.match(cards[0] ?? '', /needs administrator rights: you type the sudo password yourself in a terminal; RAME Code never sees it/);
      assert.deepEqual(opened, [`RAME Code: install (not isolated): ${path.join(bin, 'sudo')} apt-get install -y --no-install-recommends cowsay`], 'the terminal line names the trusted sudo, never one the shell would look up from the project');
      assert.match(result(h, 'i'), /^Waiting for the user: apt cowsay needs administrator rights\. Its approved command was opened in the VS Code terminal and is not Landlock-isolated/);
      assert.equal(result(h, 'c'), 'Installed: apt cowsay (version 3.03).');
      await assert.rejects(h.readFile('pwned'), 'the sudo planted in the project never ran');
    });
  } finally {
    setInstallTerminal(null);
    process.env.PATH = original;
    rmSync(bin, { recursive: true, force: true });
  }
});

test('the install changed between the card and the approval: nothing is installed (and nothing is downloaded)', { skip: hasRuntimes ? false : 'Docker with ubuntu:24.04 and Podman are needed here' }, async () => {
  const tag = `rame-code-test/changed:${process.pid}`;
  spawnSync('docker', ['tag', 'ubuntu:24.04', tag]);
  try {
    await withHost({ shell: { enabled: false, isolation: 'total' } }, async (h) => {
      h.model.enqueue(call('i', 'install_package', { manager: 'image', name: tag, runtime: 'podman', reason: 'needed' }), say('Okay.'));
      // The card says "copied from Docker"; before the approval the Docker image is gone, so the plan would now download it.
      await run(h, 'Prepare the image.', { beforeApproval: () => void spawnSync('docker', ['rmi', tag], { stdio: 'ignore' }) });
      assert.match(h.last()?.status ?? '', /The install changed after it was approved\. Nothing was installed/);
      assert.notEqual(spawnSync('podman', ['image', 'inspect', tag], { stdio: 'ignore' }).status, 0, 'nothing reached Podman');
    });
  } finally {
    spawnSync('podman', ['rmi', '-f', tag], { stdio: 'ignore' });
    spawnSync('docker', ['rmi', tag], { stdio: 'ignore' });
  }
});

test('"RAME Code: Installs": off and on; the automatic mode only after a warning that administrator rights still ask', async () => {
  const { runInstallsMenu } = await import('../src/jobCommands.js');
  await withHost({}, async (h) => {
    const seen: string[] = [];
    const ui = (pick: RegExp, warning?: string) => ({
      showQuickPick: async (items: Array<{ label: string }>) => items.find((item) => pick.test(item.label)) as never,
      showInputBox: async () => undefined,
      showWarningMessage: async (message: string, options: { detail?: string }) => (seen.push(`${message} ${options.detail ?? ''}`), warning),
      showInformationMessage: async () => undefined,
    });
    await runInstallsMenu(h.provider, ui(/Automatic installs .*OFF/, undefined));
    assert.equal(h.provider.settings.installs.auto, false, 'cancelled at the warning');
    assert.match(seen[0] ?? '', /Anything that needs administrator rights still waits for your approval and your own password or UAC prompt/);
    await runInstallsMenu(h.provider, ui(/Automatic installs .*OFF/, 'Turn on'));
    assert.deepEqual(h.provider.settings.installs, { enabled: true, auto: true });
    await runInstallsMenu(h.provider, ui(/Installs for Agent: ON/));
    assert.deepEqual(h.provider.settings.installs, { enabled: false, auto: false }, 'turning installs off also turns the automatic mode off');
  });
});
