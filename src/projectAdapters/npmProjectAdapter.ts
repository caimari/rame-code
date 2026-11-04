import { type AgentFs, type AgentFsEntry } from '../agentHost.js';
import { deriveAllowedCommands } from '../agentCommands.js';
import { checkAgentRelPath } from '../agentPolicy.js';
import type { ProjectAdapter, ProjectTestContext } from './types.js';

export const ACCEPTANCE_ENVIRONMENT_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'tsconfig.json', '.npmrc'] as const;

const ACCEPTANCE_SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'coverage', '.vscode-test', '.rame', '.private']);
const ACCEPTANCE_TEST_DIR = /^(test|tests|__tests__|spec|acceptance|e2e)$/i;
// calculator.test.js, calculator.spec.ts, and the other common forms test_calculator.js / calculator_test.js.
const ACCEPTANCE_TEST_FILE = /(?:\.(?:test|spec|acceptance)|^test[_-].+|.+[_-]test)\.[cm]?[jt]sx?$/i;
const ACCEPTANCE_SCRIPT_FILE = /\.([cm]?[jt]sx?|json)$/i;

/** Find bounded test/acceptance files without following links or protected paths. */
export async function listAcceptanceCandidates(fs: AgentFs): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number; inTests: boolean }> = [{ dir: '', depth: 0, inTests: false }];
  let visited = 0;
  while (queue.length > 0 && found.length < 80 && visited < 2000) {
    const current = queue.shift() as { dir: string; depth: number; inTests: boolean };
    let entries: AgentFsEntry[];
    try {
      entries = await fs.listEntries(current.dir);
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      visited += 1;
      const rel = current.dir === '' ? entry.name : `${current.dir}/${entry.name}`;
      if (entry.isSymlink || !checkAgentRelPath(rel).ok) {
        continue;
      }
      if (entry.isDir && current.depth < 4 && !ACCEPTANCE_SKIP_DIRS.has(entry.name)) {
        queue.push({ dir: rel, depth: current.depth + 1, inTests: current.inTests || ACCEPTANCE_TEST_DIR.test(entry.name) });
      } else if (entry.isFile && (ACCEPTANCE_TEST_FILE.test(entry.name) || (current.inTests && ACCEPTANCE_SCRIPT_FILE.test(entry.name)))) {
        found.push(rel);
      }
    }
  }
  return found.sort().slice(0, 80);
}

/** Files the "test" script names (node test_calc.js, node --test checks/run.mjs), when they exist in the project. */
export async function testScriptFiles(fs: AgentFs, packageJsonRaw: string): Promise<string[]> {
  const script = parsePackageScripts(packageJsonRaw)?.test ?? '';
  const named = script.split(/\s+/).filter((token) => /^[\w.][\w./-]*\.[cm]?[jt]sx?$/.test(token) && !token.includes('..'));
  const found: string[] = [];
  for (const rel of named.slice(0, 8)) {
    try {
      if (checkAgentRelPath(rel).ok && (await fs.stat(rel)).kind === 'file') {
        found.push(rel);
      }
    } catch {
      // Unreadable: not offered for review.
    }
  }
  return found;
}

export function parsePackageScripts(raw: string): Record<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const rawScripts = (parsed as Record<string, unknown>).scripts;
    if (typeof rawScripts !== 'object' || rawScripts === null) {
      return undefined;
    }
    const scripts: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawScripts as Record<string, unknown>)) {
      if (typeof value === 'string') {
        scripts[key] = value;
      }
    }
    return scripts;
  } catch {
    return undefined;
  }
}

/** Derive npm verification capabilities from the selected project. */
export async function npmTestContext(fs: AgentFs): Promise<ProjectTestContext> {
  try {
    const packageJsonRaw = await fs.readText('package.json');
    const scripts = parsePackageScripts(packageJsonRaw) ?? {};
    return { allowlist: deriveAllowedCommands(scripts, []), packageJsonRaw, scripts };
  } catch {
    return { allowlist: [], packageJsonRaw: '', scripts: {} };
  }
}

export const npmProjectAdapter: ProjectAdapter = {
  id: 'npm',
  acceptanceEnvironmentFiles: ACCEPTANCE_ENVIRONMENT_FILES,
  listAcceptanceCandidates,
  testContext: npmTestContext,
};
