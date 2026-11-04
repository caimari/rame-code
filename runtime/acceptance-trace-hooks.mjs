// RAME Code acceptance trace: records every ES module resolved inside the
// project, with the module that imported it. Runs on Node's hooks thread.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { realpathSync } from 'node:fs';

const out = process.env.RAME_TRACE_FILE;
const root = process.env.RAME_TRACE_ROOT;
let realRoot = root;
try {
  realRoot = root ? realpathSync(root) : root;
} catch {
  // keep the given root
}

function relative(url) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  const absolute = fileURLToPath(url);
  for (const base of realRoot === root ? [root] : [root, realRoot]) {
    const rel = path.relative(base, absolute);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  try {
    const rel = out && root ? relative(result.url) : null;
    if (rel !== null) {
      appendFileSync(out, JSON.stringify({ kind: 'module', path: rel, by: relative(context.parentURL), pid: process.pid }) + '\n');
    }
  } catch {
    // an unwritable trace is incomplete; the host notices
  }
  return result;
}
