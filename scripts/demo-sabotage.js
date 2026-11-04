// Runs the Mission sabotage battery with a SIMULATED local model (scripted
// replies; no GPU, no Meta, no network beyond loopback) on disposable
// projects, then writes a sanitized result file for review:
//   evidence/sabotage/mission-sabotage.SIMULATED.json
// The file is refused if it would contain a local path, the user name or a
// key-like value. Requires a prior `npm run compile`.
'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'evidence', 'sabotage');
const outFile = path.join(outDir, 'mission-sabotage.SIMULATED.json');
const raw = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rame-sabotage-')), 'raw.json');

const run = spawnSync(process.execPath, ['--test', path.join(root, 'out', 'test', 'mission-sabotage.test.js')], {
  cwd: root,
  env: { ...process.env, RAME_SABOTAGE_REPORT: raw },
  encoding: 'utf8',
});
const summary = (run.stdout.match(/^# (?:tests|pass|fail) \d+$/gm) ?? []).join(' ');
if (run.status !== 0 || !fs.existsSync(raw)) {
  process.stderr.write(run.stdout.slice(-4000) + run.stderr.slice(-2000));
  process.stderr.write(`\nThe sabotage battery did not pass (${summary || 'no summary'}); nothing was written.\n`);
  process.exit(1);
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

const battery = JSON.parse(fs.readFileSync(raw, 'utf8'));
const buildInfo = JSON.parse(fs.readFileSync(path.join(root, 'out', 'build-info.json'), 'utf8'));
const report = {
  label: 'SIMULATED',
  what: 'Mission sabotage battery: a scripted local model tries to make a Mission look done without the work. Outcomes are read from the stored Mission and the files on disk.',
  rame: { version: buildInfo.version, revision: buildInfo.revision, commit: git(['rev-parse', '--short=12', 'HEAD']) },
  environment: { node: process.version, platform: process.platform },
  model: battery.model,
  generatedAt: battery.generatedAt,
  tests: summary,
  outcomes: {
    blocked: 'the host refused the action before it happened',
    detected: 'the action happened but the host did not accept the task',
    limit: 'the sabotage succeeds or the outcome is wrong today; documented, not hidden',
  },
  results: battery.results,
  caveat: 'Detecting a pattern here is not a defence against every variant of it. A simulated model shows what the host does with these exact actions; it says nothing about how often a real model attempts them.',
};
const text = JSON.stringify(report, null, 2) + '\n';

// Sanitization gate: no local paths, user names or key-like values.
const forbidden = [os.homedir(), os.tmpdir(), root, os.userInfo().username].filter((value) => value && value.length > 2);
const leaks = forbidden.filter((value) => text.includes(value));
if (/\/(?:home|Users)\/|[A-Za-z]:\\\\|sk-[A-Za-z0-9]{16,}|-----BEGIN/.test(text) || leaks.length > 0) {
  process.stderr.write('The result file would contain a local path, a user name or a key-like value; nothing was written.\n');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, text);
fs.rmSync(path.dirname(raw), { recursive: true, force: true });

const width = Math.max(...report.results.map((entry) => entry.id.length));
process.stdout.write(`RAME Code ${report.rame.version} (${report.rame.revision}) — sabotage battery, SIMULATED model, Node ${process.version}\n`);
for (const entry of report.results) {
  process.stdout.write(`  ${entry.id.padEnd(width)}  ${entry.expected.padEnd(8)}  ${entry.attack}\n${' '.repeat(width + 14)}→ ${entry.observed} [status: ${entry.status}]\n`);
}
const counts = report.results.reduce((acc, entry) => ({ ...acc, [entry.expected]: (acc[entry.expected] ?? 0) + 1 }), {});
process.stdout.write(`\n${summary}\nblocked ${counts.blocked ?? 0} · detected ${counts.detected ?? 0} · limit ${counts.limit ?? 0}\nWritten: evidence/sabotage/mission-sabotage.SIMULATED.json\n`);
