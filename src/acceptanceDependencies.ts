/**
 * What a frozen acceptance check loads, so that a Mission cannot pass by
 * changing the check's own helpers instead of the code (sabotage case S6b).
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Starting from the files the user froze, every module they load through a
 * literal `require`/`import` is resolved like Node resolves a relative path:
 *
 * - test support (a file under an acceptance file's own folder, a path with a
 *   test/fixture segment, a `*.test.*`/`*.spec.*` file, or JSON data) is
 *   frozen with the check, and what it loads is followed in turn;
 * - anything else is the code under test: it stays writable, is reported to
 *   the user, and is not followed (it is what the agent is asked to change);
 * - a load RAME cannot determine (a computed path, a `#` import alias, an
 *   absolute path or one outside the project, missing test support) refuses
 *   the authorization and names it, because it cannot be protected. Missing
 *   code under test is allowed: the agent may be asked to create it.
 *
 * Test support must be loaded by its exact file name, or the agent could add
 * a file Node resolves first. Data the check reads through a literal path
 * (`readFileSync('…')`, `path.join(__dirname, '…')`) is frozen the same way
 * when it is test support.
 *
 * Limits, said plainly: a helper placed outside those locations is treated as
 * code under test; data read through a computed path is not followed; code
 * under test runs in the check's own process and can still interfere with it. Installed packages (`node_modules`)
 * are not hashed; RAME's tools never write them.
 */

import { builtinModules } from 'node:module';
import * as path from 'node:path';

import { checkAgentRelPath } from './agentPolicy.js';

export interface DependencyReader {
  stat(rel: string): Promise<{ kind: 'file' | 'dir' | 'symlink' | 'missing' | 'other'; size?: number }>;
  readText(rel: string): Promise<string>;
}

export type AcceptanceDependencyPlan =
  | {
      ok: true;
      /** Test support the check loads, not listed by the user: frozen with it. */
      freeze: string[];
      /** Code under test the check loads: stays writable, shown to the user. */
      subjects: string[];
      /** Installed packages the check loads (not hashed). */
      packages: string[];
    }
  | { ok: false; error: string };

export const MAX_ACCEPTANCE_DEPENDENCIES = 64;
export const MAX_ACCEPTANCE_FILE_BYTES = 512 * 1024;

const SCRIPT = /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i;
const RESOLVE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.json', '.ts', '.cts', '.mts'];
const SUPPORT_SEGMENTS = new Set([
  'test', 'tests', '__tests__', 'spec', 'specs', 'fixture', 'fixtures', '__fixtures__', '__mocks__', 'mocks',
  'acceptance', 'testdata', 'test-data', 'test_data', 'helpers', 'support', 'e2e',
]);
const BUILTINS = new Set(builtinModules);

/** A literal module specifier and where it was found. */
interface Load {
  specifier: string;
  dynamic: false;
}
interface DynamicLoad {
  excerpt: string;
  dynamic: true;
}

const LITERAL = String.raw`(['"\x60])([^'"\x60\n$]*)\1`;
const LITERAL_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\brequire\s*\(\s*${LITERAL}\s*\)`, 'g'),
  new RegExp(String.raw`\brequire\.resolve\s*\(\s*${LITERAL}`, 'g'),
  new RegExp(String.raw`\bimport\s*\(\s*${LITERAL}\s*[,)]`, 'g'),
  new RegExp(String.raw`\b(?:import|export)\b[^'"\x60;]*?\bfrom\s*${LITERAL}`, 'g'),
  new RegExp(String.raw`\bimport\s*${LITERAL}`, 'g'),
];
/** A load whose target is computed: `require(x)`, `import(x)`, a template with `${`, or another loader. */
const DYNAMIC_PATTERNS: RegExp[] = [
  /\brequire\s*\(\s*(?!(['"`])[^'"`\n$]*\1\s*\))[^)\n]{0,60}\)?/g,
  /\bimport\s*\(\s*(?!(['"`])[^'"`\n$]*\1\s*[,)])[^)\n]{0,60}\)?/g,
  /\b(?:createRequire|module\.require|process\.dlopen|require\.main\.require)\b[^\n]{0,60}/g,
];

/**
 * Files a source reads as data through a literal path: relative to the
 * project root (where npm runs the check) or to the file itself
 * (`path.join(__dirname, …)`, `new URL(…, import.meta.url)`).
 */
const DATA_FROM_ROOT = new RegExp(String.raw`\b(?:readFileSync|readFile|createReadStream|readdirSync|readdir|statSync|existsSync|openSync)\s*\(\s*${LITERAL}`, 'g');
const DATA_FROM_FILE: RegExp[] = [
  new RegExp(String.raw`\bpath\.(?:join|resolve)\s*\(\s*__dirname\s*,\s*${LITERAL}\s*\)`, 'g'),
  new RegExp(String.raw`\bnew\s+URL\s*\(\s*${LITERAL}\s*,\s*import\.meta\.url\s*\)`, 'g'),
];

export function dataReads(source: string): Array<{ path: string; from: 'root' | 'file' }> {
  const found: Array<{ path: string; from: 'root' | 'file' }> = [];
  for (const match of source.matchAll(DATA_FROM_ROOT)) {
    found.push({ path: match[2] as string, from: 'root' });
  }
  for (const pattern of DATA_FROM_FILE) {
    for (const match of source.matchAll(pattern)) {
      found.push({ path: match[2] as string, from: 'file' });
    }
  }
  return found;
}

/**
 * The source with its comments blanked out (strings and template literals
 * kept). A best-effort scanner: it is only used to stop a computed load
 * mentioned in a comment from refusing protection. Literal loads are still
 * collected from the original text as well, so a scanning mistake can never
 * freeze fewer files.
 */
export function withoutComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== ch && !(ch !== '`' && source[j] === '\n')) {
        j += source[j] === '\\' ? 2 : 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Every module a source file loads; computed loads are reported, never guessed. */
export function moduleLoads(source: string): Array<Load | DynamicLoad> {
  const found: Array<Load | DynamicLoad> = [];
  const seen = new Set<string>();
  const code = withoutComments(source);
  for (const text of [source, code]) {
    for (const pattern of LITERAL_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[2] as string;
        if (!seen.has(specifier)) {
          seen.add(specifier);
          found.push({ specifier, dynamic: false });
        }
      }
    }
  }
  // A computed load counts only in code, not in a comment that mentions one.
  for (const pattern of DYNAMIC_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      found.push({ excerpt: match[0].trim().slice(0, 60), dynamic: true });
    }
  }
  return found;
}

/** True for a file that supports the check rather than being the code it checks. */
export function isTestSupport(rel: string, acceptanceDirs: readonly string[]): boolean {
  if (rel.toLowerCase().endsWith('.json')) {
    return true;
  }
  if (acceptanceDirs.some((dir) => dir !== '' && (rel === dir || rel.startsWith(`${dir}/`)))) {
    return true;
  }
  const segments = rel.toLowerCase().split('/');
  const base = segments.at(-1) ?? '';
  return (
    segments.slice(0, -1).some((segment) => SUPPORT_SEGMENTS.has(segment)) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /fixture|\.mock\./.test(base)
  );
}

function relativeSpecifier(from: string, to: string): string {
  const rel = path.posix.relative(path.posix.dirname(from), to);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0] as string);
}

async function resolveRelative(reader: DependencyReader, from: string, specifier: string): Promise<string | null> {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`), ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`)];
  for (const candidate of candidates) {
    const gate = checkAgentRelPath(candidate);
    if (!gate.ok) {
      continue;
    }
    const rel = (gate as { ok: true; rel: string }).rel;
    try {
      const st = await reader.stat(rel);
      if (st.kind === 'file') {
        return rel;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Plan the dependencies of a frozen acceptance check. `frozen` are the files
 * the user listed (already validated); `projectName` is package.json's name,
 * used to recognise a self-reference that would resolve inside the project.
 */
export async function planAcceptanceDependencies(
  reader: DependencyReader,
  frozen: readonly string[],
  projectName = '',
): Promise<AcceptanceDependencyPlan> {
  const listed = new Set(frozen);
  const acceptanceDirs = [...new Set(frozen.filter((file) => SCRIPT.test(file)).map((file) => path.posix.dirname(file)).map((dir) => (dir === '.' ? '' : dir)))];
  const freeze = new Set<string>();
  const subjects = new Set<string>();
  const packages = new Set<string>();
  const queue = [...frozen];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file) || !SCRIPT.test(file)) {
      continue;
    }
    visited.add(file);
    if (visited.size + subjects.size > MAX_ACCEPTANCE_DEPENDENCIES) {
      return { ok: false, error: `The acceptance check loads more than ${MAX_ACCEPTANCE_DEPENDENCIES} files; RAME cannot protect all of them. List fewer or smaller checks.` };
    }
    let source: string;
    try {
      const st = await reader.stat(file);
      if (st.kind !== 'file' || (st.size ?? 0) > MAX_ACCEPTANCE_FILE_BYTES) {
        return { ok: false, error: `The acceptance file ${file} cannot be read in full, so what it loads cannot be protected.` };
      }
      source = await reader.readText(file);
    } catch {
      return { ok: false, error: `The acceptance file ${file} cannot be read, so what it loads cannot be protected.` };
    }
    for (const load of moduleLoads(source)) {
      if (load.dynamic) {
        return { ok: false, error: `${file} loads a module whose path RAME cannot determine (${load.excerpt}). Use a literal relative path, or the check cannot be protected.` };
      }
      const specifier = load.specifier;
      if (isBuiltin(specifier)) {
        continue;
      }
      if (specifier.startsWith('#')) {
        return { ok: false, error: `${file} loads ${specifier} through a package.json import alias; RAME cannot tell which file that is. Use a relative path.` };
      }
      if (specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith('file:')) {
        return { ok: false, error: `${file} loads an absolute path (${specifier.slice(0, 80)}); it cannot be protected. Use a path inside the project.` };
      }
      if (!specifier.startsWith('./') && !specifier.startsWith('../') && specifier !== '.' && specifier !== '..') {
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] as string);
        if (projectName.length > 0 && name === projectName) {
          return { ok: false, error: `${file} loads the project by its own package name (${specifier}); RAME cannot tell which file that is. Use a relative path.` };
        }
        packages.add(name);
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const inside = checkAgentRelPath(target);
      if (!inside.ok) {
        return { ok: false, error: `${file} loads ${specifier}, which is outside the project or protected; it cannot be protected.` };
      }
      const resolved = await resolveRelative(reader, file, specifier);
      if (resolved === null) {
        // Missing now. Code under test may not exist yet (the agent is asked to
        // write it); missing test support could be written by the agent at will.
        if (isTestSupport(target, acceptanceDirs)) {
          return { ok: false, error: `${file} loads ${specifier}, which does not exist yet; a test file the agent could create cannot be protected. Create it before authorizing.` };
        }
        subjects.add(`${(inside as { ok: true; rel: string }).rel} (not created yet)`);
        continue;
      }
      if (listed.has(resolved) || freeze.has(resolved) || subjects.has(resolved)) {
        continue;
      }
      if (isTestSupport(resolved, acceptanceDirs)) {
        if (resolved !== target) {
          // Node would load an extensionless file or a sibling before this one:
          // the agent could add it and shadow the frozen file.
          return { ok: false, error: `${file} loads ${specifier} without its exact file name; the agent could add a file Node loads first. Write '${relativeSpecifier(file, resolved)}'.` };
        }
        freeze.add(resolved);
        queue.push(resolved);
      } else {
        subjects.add(resolved);
      }
    }
    for (const read of dataReads(source)) {
      if (path.posix.isAbsolute(read.path) || /^[A-Za-z]:[\\/]/.test(read.path)) {
        continue;
      }
      const target = path.posix.normalize(read.from === 'root' ? read.path : path.posix.join(path.posix.dirname(file), read.path));
      const gate = checkAgentRelPath(target);
      if (!gate.ok) {
        continue;
      }
      const rel = (gate as { ok: true; rel: string }).rel;
      if (listed.has(rel) || freeze.has(rel) || !isTestSupport(rel, acceptanceDirs)) {
        continue;
      }
      let kind = 'missing';
      try {
        kind = (await reader.stat(rel)).kind;
      } catch {
        // missing
      }
      if (kind === 'dir') {
        // A folder the check lists: its files are classified from what the check is observed to read.
        continue;
      }
      if (kind !== 'file') {
        return { ok: false, error: `${file} reads ${read.path}, test data that does not exist as a file yet; the agent could create it. Create it before authorizing.` };
      }
      freeze.add(rel);
    }
  }
  return { ok: true, freeze: [...freeze].sort(), subjects: [...subjects].sort(), packages: [...packages].sort() };
}

const RESOLUTION_EXTENSION = /^\.(?:[cm]?js|json|node|[cm]?ts)$/;

/**
 * True when writing `rel` would change a frozen file or how Node finds it:
 * the file itself (any letter case, for case-insensitive file systems),
 * installed packages at any depth, a package.json at or above a frozen
 * file's folder, a sibling with the same name and another extension or
 * none (resolved first for an extensionless load), or the folder name of a
 * frozen `index.*` entry point.
 */
export function frozenWriteHit(frozen: readonly string[], rel: string): boolean {
  const target = rel.toLowerCase();
  const segments = target.split('/');
  if (segments.includes('node_modules')) {
    return true;
  }
  for (const entry of frozen) {
    const file = entry.toLowerCase();
    if (file.endsWith('/')) {
      // A sealed folder: nothing may be added, changed or removed in it, nor the folder (or one above it) moved.
      const folder = file.slice(0, -1);
      if (target === folder || target.startsWith(file) || folder.startsWith(`${target}/`)) {
        return true;
      }
      continue;
    }
    if (target === file || file.startsWith(`${target}/`)) {
      return true;
    }
    const folder = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);
    if (segments.at(-1) === 'package.json') {
      const where = path.posix.dirname(target) === '.' ? '' : path.posix.dirname(target);
      if (where === '' || folder === where || folder.startsWith(`${where}/`)) {
        return true;
      }
    }
    const stem = file.replace(/\.(?:[cm]?js|json|node|[cm]?ts)$/, '');
    if (stem !== file && (target === stem || (target.startsWith(`${stem}.`) && RESOLUTION_EXTENSION.test(target.slice(stem.length))))) {
      return true;
    }
    if (/^index\.(?:[cm]?js|json|node|[cm]?ts)$/.test(path.posix.basename(file)) && folder !== '') {
      if (target === folder || (target.startsWith(`${folder}.`) && RESOLUTION_EXTENSION.test(target.slice(folder.length)))) {
        return true;
      }
    }
  }
  return false;
}
