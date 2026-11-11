'use strict';
// RAME Code long jobs: the supervisor. The host starts it detached as
//   <node> rame-job-supervisor.cjs <job directory> <sha256 of spec.json>
// so it outlives the window that started it (a VS Code reload ends the
// extension host, not this process). It runs exactly one approved command and
// leaves, in the job directory (outside the workspace):
//   heartbeat            the time of its last sign of life, refreshed often
//   supervisor.json      {pid, childPid, startedAt} once the command started
//   log.txt, log.1.txt   combined output, rotated so it stays bounded
//   exit.json            {exitCode, signal, timedOut, cancelled, ...}, written
//                        atomically and last
// It stops the command only at its approved deadline or when the host writes
// `cancel` (a user decision). It never starts anything a second time.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const [dir, expected] = process.argv.slice(2);
const KILL_GRACE_MS = 2000;
const file = (name) => path.join(dir, name);

process.on('SIGHUP', () => {});

let finished = false;
function finish(record) {
  if (finished) {
    return;
  }
  finished = true;
  try {
    const tmp = file(`exit.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ exitCode: null, signal: null, timedOut: false, cancelled: false, ...record, endedAt: Date.now() }));
    fs.renameSync(tmp, file('exit.json'));
  } catch {
    // The host then sees no result and reports the job as uncertain.
  }
  process.exit(0);
}

let raw;
try {
  raw = fs.readFileSync(file('spec.json'));
} catch {
  process.exit(3);
}
if (typeof expected !== 'string' || crypto.createHash('sha256').update(raw).digest('hex') !== expected) {
  finish({ refused: 'the job specification changed after it was approved; nothing ran' });
}
let spec;
try {
  spec = JSON.parse(raw.toString('utf8'));
} catch {
  finish({ refused: 'the job specification is not valid JSON; nothing ran' });
}
const isStrings = (list) => Array.isArray(list) && list.every((part) => typeof part === 'string');
if (
  typeof spec !== 'object' || spec === null ||
  typeof spec.executable !== 'string' || !isStrings(spec.argv) || typeof spec.cwd !== 'string' ||
  !Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1 ||
  !Number.isInteger(spec.maxLogBytes) || spec.maxLogBytes < 1024 ||
  !Number.isInteger(spec.heartbeatMs) || spec.heartbeatMs < 50 ||
  typeof spec.env !== 'object' || spec.env === null || !Object.values(spec.env).every((value) => typeof value === 'string')
) {
  finish({ refused: 'the job specification is incomplete; nothing ran' });
}

// Replaced atomically (a temporary file, then a rename): written in place, a
// host reading it between the truncation and the write saw an empty file and
// took a healthy job for one that had stopped reporting.
const beatTmp = file(`heartbeat.${process.pid}.tmp`);
const beatNow = () => {
  const now = String(Date.now());
  try {
    fs.writeFileSync(beatTmp, now);
    fs.renameSync(beatTmp, file('heartbeat'));
  } catch {
    // Where a rename over a file being read can fail (Windows), in place is
    // still better than no heartbeat; the host reads an empty one again.
    try {
      fs.writeFileSync(file('heartbeat'), now);
    } catch {
      // A missing heartbeat only makes the host more careful.
    }
  }
};
beatNow();

// Output: one file up to maxLogBytes, then it becomes log.1.txt and a new one
// starts, so at most two files and the latest output is always kept.
let logFd = fs.openSync(file('log.txt'), 'a');
let logBytes = 0;
const writeLog = (chunk) => {
  try {
    const part = chunk.length > spec.maxLogBytes ? chunk.subarray(chunk.length - spec.maxLogBytes) : chunk;
    if (logBytes + part.length > spec.maxLogBytes) {
      fs.closeSync(logFd);
      fs.renameSync(file('log.txt'), file('log.1.txt'));
      logFd = fs.openSync(file('log.txt'), 'w');
      logBytes = 0;
    }
    fs.writeSync(logFd, part);
    logBytes += part.length;
  } catch {
    // Losing output never stops the job.
  }
};

const cleanup = spec.cleanup && typeof spec.cleanup.executable === 'string' && isStrings(spec.cleanup.argv) ? spec.cleanup : null;
let cleaned = false;
// e.g. remove the job's container: stopping its client does not always stop it.
function runCleanup() {
  if (cleanup === null || cleaned) {
    return;
  }
  cleaned = true;
  try {
    require('node:child_process').spawnSync(cleanup.executable, cleanup.argv, { shell: false, stdio: 'ignore', timeout: 20000, windowsHide: true });
  } catch {
    // The record still says what to clean up.
  }
}

const env = { ...process.env, ...spec.env };
delete env.NODE_TEST_CONTEXT;
if (spec.keepElectronRunAsNode !== true) {
  delete env.ELECTRON_RUN_AS_NODE;
}

let child;
try {
  child = spawn(spec.executable, spec.argv, {
    cwd: spec.cwd,
    env,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  finish({ refused: `the command could not start: ${String(error && error.message ? error.message : error).slice(0, 300)}` });
}

function killTree(signal) {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const root = /^[A-Za-z]:[\\/]/.test(process.env.SystemRoot || '') ? process.env.SystemRoot : 'C:\\Windows';
    try {
      spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      return;
    } catch {
      // fall back to the direct child
    }
  } else {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // the group is gone
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already exited
  }
}

let stopping = null;
let exited = null;
function stop(reason) {
  if (stopping !== null || finished) {
    return;
  }
  stopping = reason;
  writeLog(Buffer.from(`\n[RAME Code: ${reason === 'cancelled' ? 'stopped at the user\'s request' : `stopped at its approved limit of ${Math.round(spec.timeoutMs / 1000)} s`}]\n`));
  runCleanup();
  killTree('SIGTERM');
  setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
  setTimeout(() => done(), KILL_GRACE_MS + 1000);
}

function done() {
  if (finished) {
    return;
  }
  // Leftover members of the group never outlive the job.
  killTree('SIGKILL');
  runCleanup();
  try {
    fs.closeSync(logFd);
  } catch {
    // already closed
  }
  finish({
    exitCode: exited ? exited.code : null,
    signal: exited ? exited.signal : null,
    timedOut: stopping === 'timedOut',
    cancelled: stopping === 'cancelled',
  });
}

const deadline = Date.now() + spec.timeoutMs;
child.on('error', (error) => {
  if (exited === null) {
    finish({ refused: `the command could not start: ${String(error && error.message ? error.message : error).slice(0, 300)}` });
  }
});
child.on('spawn', () => {
  try {
    const tmp = file(`supervisor.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, childPid: child.pid, startedAt: Date.now() }));
    fs.renameSync(tmp, file('supervisor.json'));
  } catch {
    // The host still sees the heartbeat.
  }
});
child.stdout.on('data', writeLog);
child.stderr.on('data', writeLog);
child.on('exit', (code, signal) => {
  exited = { code, signal };
  // A grandchild may keep the pipes open: settle shortly anyway.
  setTimeout(done, 500);
});
child.on('close', () => done());

setInterval(() => {
  beatNow();
  if (fs.existsSync(file('cancel'))) {
    stop('cancelled');
  } else if (Date.now() >= deadline) {
    stop('timedOut');
  }
}, spec.heartbeatMs);
