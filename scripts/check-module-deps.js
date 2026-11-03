'use strict';

// Fails the build on any cyclic import between source modules under src/,
// type-only imports included: a cycle couples two modules even when one
// side only needs types. Usage: node scripts/check-module-deps.js [root]

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
const IMPORT = /^\s*(?:import|export)\s[^'";]*?from\s+'(\.{1,2}\/[^']+)'/gm;

function sourceFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(rel));
    } else if (entry.name.endsWith('.ts')) {
      found.push(rel.replaceAll(path.sep, '/'));
    }
  }
  return found;
}

const files = sourceFiles('src');
const known = new Set(files);
const graph = new Map();
for (const rel of files) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const deps = [];
  for (const match of source.matchAll(IMPORT)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1].replace(/\.js$/, '.ts')));
    if (known.has(target)) {
      deps.push(target);
    }
  }
  graph.set(rel, deps);
}

const cycles = new Map();
const state = new Map();
const stack = [];
function visit(node) {
  state.set(node, 'open');
  stack.push(node);
  for (const dep of graph.get(node)) {
    if (state.get(dep) === 'open') {
      const cycle = stack.slice(stack.indexOf(dep));
      cycles.set([...cycle].sort().join(','), [...cycle, dep].join(' -> '));
    } else if (!state.has(dep)) {
      visit(dep);
    }
  }
  stack.pop();
  state.set(node, 'done');
}
for (const node of [...graph.keys()].sort()) {
  if (!state.has(node)) {
    visit(node);
  }
}

if (cycles.size > 0) {
  console.error('Module dependency policy failed: cyclic imports are not allowed.');
  for (const cycle of cycles.values()) {
    console.error(`- ${cycle}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Module dependency policy passed (${files.length} source files, no cyclic imports).`);
}
