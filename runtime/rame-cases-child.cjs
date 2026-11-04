'use strict';
// RAME Code host-compared cases: the child side. The host sends, on stdin,
// the module to load, the calls to make (never the expected values) and two
// random witness tokens. This shim answers on file descriptor 3, one JSON
// line per message:
//   {"witness":"<start token>"}            before the module is loaded
//   {"id":n,"ok":true,"value":...}         or {"id":n,"ok":false,"error":"..."}
//   {"witness":"<end token>"}              after the last call returned
// The host compares the values itself. Code under test runs in this process:
// it can end it (the end witness is then missing) or write to fd 3 (it can
// only claim outputs, which is what a correct implementation does anyway);
// it never sees the expected values.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const writeSync = fs.writeSync;
const send = (message) => {
  try {
    writeSync(3, JSON.stringify(message) + '\n');
  } catch {
    // the host sees a missing message
  }
};

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let request;
  try {
    request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exitCode = 2;
    return;
  }
  const { module: modulePath, calls, start, end } = request;
  // Kept in this closure only: loaded code cannot read them back.
  const witness = { start, end };
  request = null;
  send({ witness: witness.start });
  const absolute = path.resolve(process.cwd(), modulePath);
  const asEsm = () => import(pathToFileURL(absolute).href);
  const load = /\.mjs$/i.test(absolute)
    ? asEsm()
    : Promise.resolve().then(() => {
        try {
          return require(absolute);
        } catch (error) {
          if (error && error.code === 'ERR_REQUIRE_ESM') return asEsm();
          throw error;
        }
      });
  load
    .then(async (loaded) => {
      const pick = (name) => {
        if (name === '') return typeof loaded === 'function' ? loaded : loaded && loaded.default;
        if (loaded && typeof loaded[name] === 'function') return loaded[name];
        return loaded && loaded.default ? loaded.default[name] : undefined;
      };
      for (const call of calls) {
        try {
          const target = pick(call.name);
          if (typeof target !== 'function') {
            send({ id: call.id, ok: false, error: `${call.name || 'the module'} is not a function` });
            continue;
          }
          const value = await target(...call.args);
          let encoded;
          try {
            encoded = JSON.parse(JSON.stringify(value === undefined ? { $undefined: true } : value));
          } catch {
            send({ id: call.id, ok: false, error: 'the returned value cannot be represented as JSON' });
            continue;
          }
          send({ id: call.id, ok: true, value: encoded });
        } catch (error) {
          send({ id: call.id, ok: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
        }
      }
      send({ witness: witness.end });
    })
    .catch((error) => {
      send({ load: false, error: String(error && error.message ? error.message : error).slice(0, 300) });
    });
});
