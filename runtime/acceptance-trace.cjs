'use strict';
// RAME Code acceptance trace, preloaded with --require only when the host
// runs a frozen acceptance check. It records, inside the project, every
// module Node resolves and every path read through `fs`, with the project
// file that caused it. It changes no behaviour of the check.
//
// It runs in the same process as the code under test, so that code can
// tamper with it: RAME treats the trace as a discovery aid for its own
// classification, never as proof. What the host trusts is what it checks
// itself (hashes of the whole project, before and after each run).
//
// Each process also records its entry point (process.argv[1]) and the entry
// point of the traced process that started it, passed down in
// RAME_TRACE_PARENT (it survives an intermediate shell, unlike a pid).
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { fileURLToPath } = require('node:url');
const { isMainThread } = require('node:worker_threads');

const out = process.env.RAME_TRACE_FILE;
const root = process.env.RAME_TRACE_ROOT;

// The ESM hooks thread loads this preload too: only the main thread traces.
if (out && root && isMainThread && !process.__rameAcceptanceTrace) {
  Object.defineProperty(process, '__rameAcceptanceTrace', { value: true });
  const append = fs.appendFileSync;
  const pid = process.pid;
  const write = (entry) => {
    try {
      append(out, JSON.stringify({ ...entry, pid }) + '\n');
    } catch {
      // A trace that cannot be written is incomplete; the host notices.
    }
  };
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // keep the given root
  }
  const relative = (absolute) => {
    for (const base of realRoot === root ? [root] : [root, realRoot]) {
      const rel = path.relative(base, absolute);
      // The project folder itself is '.': listing it is recorded too.
      if (rel === '') return '.';
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    }
    return null;
  };
  const asPath = (value) => {
    try {
      if (typeof value === 'string') return path.resolve(value);
      if (value instanceof URL) return fileURLToPath(value);
      if (Buffer.isBuffer(value)) return path.resolve(value.toString());
    } catch {
      // not a path
    }
    return null;
  };
  // The first project file (outside node_modules) on the stack: who asked.
  // A deep enough stack: Node 24's loader adds frames, and with the default
  // limit of 10 the requiring project file can fall off the end.
  const caller = () => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 200;
    let stack;
    try {
      stack = new Error().stack;
    } finally {
      Error.stackTraceLimit = limit;
    }
    const lines = String(stack).split('\n').slice(2);
    for (const raw of lines) {
      const match = /((?:file:\/\/)?(?:[A-Za-z]:)?[\\/][^():]*?):\d+:\d+\)?\s*$/.exec(raw.trim());
      if (!match) continue;
      let file = match[1];
      if (file.startsWith('file://')) {
        try {
          file = fileURLToPath(file);
        } catch {
          continue;
        }
      }
      if (file === __filename) continue;
      const rel = relative(file);
      if (rel !== null && !rel.split('/').includes('node_modules')) return rel;
    }
    return null;
  };
  const seen = new Set();
  const note = (kind, target, by) => {
    const absolute = asPath(target);
    if (absolute === null) return;
    const rel = relative(absolute);
    if (rel === null) return;
    const key = `${kind}\0${rel}\0${by ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    write({ kind, path: rel, by: by ?? null });
  };
  // This process's entry point inside the project, if any, and its traced parent's.
  let main = null;
  if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) {
    const rel = relative(path.resolve(process.argv[1]));
    main = rel === '.' ? null : rel;
  }
  const inherited = typeof process.env.RAME_TRACE_PARENT === 'string' ? process.env.RAME_TRACE_PARENT : null;
  const parent = inherited === null || inherited === '' ? null : inherited;
  // A process without a project entry (npm, a shell, the test runner) passes its parent on.
  process.env.RAME_TRACE_PARENT = main ?? parent ?? '';
  write({ kind: 'start', esm: typeof Module.register === 'function', node: process.version, main, parent });
  if (main !== null) {
    write({ kind: 'entry', path: main, by: parent });
  }
  process.on('exit', (code) => write({ kind: 'end', code }));

  const READS = ['readFileSync', 'openSync', 'existsSync', 'statSync', 'lstatSync', 'accessSync', 'readdirSync', 'opendirSync', 'createReadStream', 'readFile', 'open', 'stat', 'lstat', 'access', 'readdir', 'opendir', 'realpathSync', 'realpath'];
  for (const name of READS) {
    const original = fs[name];
    if (typeof original !== 'function') continue;
    const wrapped = function (target, ...rest) {
      note('read', target, caller());
      return original.call(this, target, ...rest);
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    fs[name] = wrapped;
  }
  for (const name of ['readFile', 'open', 'stat', 'lstat', 'access', 'readdir', 'opendir', 'realpath']) {
    const original = fs.promises[name];
    if (typeof original !== 'function') continue;
    fs.promises[name] = function (target, ...rest) {
      note('read', target, caller());
      return original.call(this, target, ...rest);
    };
  }
  // Observation at authorization only: a relative module of the project that
  // does not exist yet (the code the Mission must write) is replaced by an
  // inert stub, so the check keeps running and shows what else it uses.
  const stubMissing = process.env.RAME_TRACE_STUB_MISSING === '1';
  if (stubMissing) {
    const stub = new Proxy(function () {}, {
      get: (_target, key) => (key === Symbol.toPrimitive ? () => NaN : key === 'then' ? undefined : stub),
      apply: () => stub,
      construct: () => stub,
    });
    const load = Module._load;
    Module._load = function (request, parent, ...rest) {
      try {
        return load.call(this, request, parent, ...rest);
      } catch (error) {
        const relativeRequest = typeof request === 'string' && (request.startsWith('./') || request.startsWith('../'));
        if (error && error.code === 'MODULE_NOT_FOUND' && relativeRequest && parent && typeof parent.filename === 'string') {
          const target = relative(path.resolve(path.dirname(parent.filename), request));
          if (target !== null) {
            write({ kind: 'missing-module', path: target, by: relative(parent.filename) });
            return stub;
          }
        }
        throw error;
      }
    };
  }
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    const resolved = resolveFilename.call(this, request, parent, ...rest);
    if (typeof resolved === 'string' && path.isAbsolute(resolved)) {
      const by = parent && typeof parent.filename === 'string' ? relative(parent.filename) : null;
      note('module', resolved, by);
    }
    return resolved;
  };
  try {
    Module.syncBuiltinESMExports();
  } catch {
    // older Node: ESM named imports of fs keep the originals; the ESM hooks still see module loads
  }
}
