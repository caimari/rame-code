import { type AgentFs, type AgentFsEntry } from '../agentHost.js';
import { checkAgentRelPath } from '../agentPolicy.js';
import type { ProjectAdapter } from './types.js';

export const ACCEPTANCE_ENVIRONMENT_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'tsconfig.json', '.npmrc'] as const;

const ACCEPTANCE_SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', 'coverage', '.vscode-test', '.rame', '.private']);
const ACCEPTANCE_TEST_DIR = /^(test|tests|__tests__|spec|acceptance|e2e)$/i;
const ACCEPTANCE_TEST_FILE = /\.(test|spec|acceptance)\.[cm]?[jt]sx?$/i;
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

export const npmProjectAdapter: ProjectAdapter = {
  id: 'npm',
  acceptanceEnvironmentFiles: ACCEPTANCE_ENVIRONMENT_FILES,
  listAcceptanceCandidates,
};
