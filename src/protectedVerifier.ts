/** Filesystem view for a protected verifier process. */

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

import type { ProtectedInvocationAccess } from './shellIsolation.js';

export type ProtectedAccessResult = { ok: true; access: ProtectedInvocationAccess } | { ok: false; error: string };

const inside = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}${path.sep}`);

/** Project files that evaluated code never receives as ambient verifier input. */
export function protectedVerifierSecret(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/');
  return /^(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.config)(?:\/|$)/i.test(normalized)
    || /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|secrets?\.json)$/i.test(normalized);
}

/**
 * Build an allowlist from host-recorded project paths. Symlinks that leave
 * the project are refused: a textual path must never smuggle an ambient read
 * into the protected verifier.
 */
export function protectedProjectAccess(
  root: string,
  readable: readonly string[],
  writable: readonly string[],
  scratch: string | null,
  trustedTrees: readonly string[] = [],
): ProtectedAccessResult {
  const heldRoot = realpathSync(root);
  const readFiles: string[] = [];
  const trees: string[] = [...trustedTrees];
  const dirs = new Set<string>([heldRoot]);
  const writeTrees: string[] = scratch === null ? [] : [scratch];
  const resolveProject = (rel: string): { ok: true; path: string } | { ok: false; error: string } => {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      return { ok: false, error: `${rel} is not a project-relative verifier path` };
    }
    const absolute = path.join(heldRoot, ...rel.split('/'));
    if (!existsSync(absolute)) {
      return { ok: true, path: absolute };
    }
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      return { ok: false, error: `${rel} cannot be resolved for protected verification` };
    }
    if (!inside(heldRoot, real)) {
      return { ok: false, error: `${rel} points outside the project` };
    }
    return { ok: true, path: real };
  };
  const addParents = (absolute: string): void => {
    let current = path.dirname(absolute);
    while (inside(heldRoot, current)) {
      dirs.add(current);
      if (current === heldRoot) break;
      current = path.dirname(current);
    }
  };
  for (const rel of readable) {
    if (protectedVerifierSecret(rel)) continue;
    const resolved = resolveProject(rel);
    if (!resolved.ok) return resolved;
    if (existsSync(resolved.path)) {
      const info = lstatSync(resolved.path);
      (info.isDirectory() ? trees : readFiles).push(resolved.path);
      addParents(resolved.path);
    }
  }
  for (const rel of writable) {
    if (protectedVerifierSecret(rel)) {
      return { ok: false, error: `${rel} is a recognized secret path and cannot be exposed to protected verification` };
    }
    const resolved = resolveProject(rel);
    if (!resolved.ok) return resolved;
    const existing = existsSync(resolved.path) ? resolved.path : path.dirname(resolved.path);
    if (!inside(heldRoot, existing)) {
      return { ok: false, error: `${rel} has no writable parent inside the project` };
    }
    writeTrees.push(existing);
    addParents(resolved.path);
    if (existsSync(resolved.path)) {
      const info = lstatSync(resolved.path);
      (info.isDirectory() ? trees : readFiles).push(resolved.path);
    }
  }
  const modules = path.join(heldRoot, 'node_modules');
  const readTrees = [...trees, ...(scratch === null ? [] : [scratch]), ...(existsSync(modules) ? [modules] : [])];
  return {
    ok: true,
    access: {
      readFiles: [...new Set(readFiles)],
      readTrees: [...new Set(readTrees)],
      // Listing a directory reveals names, not file contents.  Parent
      // directories are needed for module resolution and for checks that
      // deliberately enumerate a sealed fixture folder; individual hidden
      // files still receive no READ_FILE right.
      readDirs: [...dirs],
      writeTrees: [...new Set(writeTrees)],
    },
  };
}
