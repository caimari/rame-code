import { chmod, realpath, stat, statfs } from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { AgentFs } from '../agentHost.js';

/**
 * Adapt one local VS Code workspace folder to the host's testable AgentFs
 * boundary. Model code never sees absolute paths or VS Code APIs.
 */
export function createVscodeWorkspaceFs(root: string): AgentFs {
  const rootUri = vscode.Uri.file(root);
  const join = (rel: string): vscode.Uri =>
    rel === '' ? rootUri : vscode.Uri.joinPath(rootUri, ...rel.split('/'));
  const fsPathFor = (rel: string): string =>
    rel === '' ? root : path.join(root, ...rel.split('/'));

  return {
    async listEntries(rel: string) {
      const entries = await vscode.workspace.fs.readDirectory(join(rel));
      return entries.map(([name, type]) => ({
        name,
        isFile: (type & vscode.FileType.File) !== 0,
        isDir: (type & vscode.FileType.Directory) !== 0,
        isSymlink: (type & vscode.FileType.SymbolicLink) !== 0,
      }));
    },
    async readText(rel: string) {
      const bytes = await vscode.workspace.fs.readFile(join(rel));
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    },
    async stat(rel: string) {
      try {
        const info = await vscode.workspace.fs.stat(join(rel));
        if ((info.type & vscode.FileType.SymbolicLink) !== 0) {
          return { kind: 'symlink' as const };
        }
        if ((info.type & vscode.FileType.Directory) !== 0) {
          return { kind: 'dir' as const, size: info.size };
        }
        if ((info.type & vscode.FileType.File) !== 0) {
          const native = await stat(fsPathFor(rel));
          return { kind: 'file' as const, size: info.size, ownerExecutable: (native.mode & 0o100) !== 0 };
        }
        return { kind: 'other' as const };
      } catch {
        return { kind: 'missing' as const };
      }
    },
    async writeText(rel: string, content: string) {
      await vscode.workspace.fs.writeFile(join(rel), new TextEncoder().encode(content));
    },
    async createDirectory(rel: string) {
      await vscode.workspace.fs.createDirectory(join(rel));
    },
    async moveFile(source: string, destination: string) {
      await vscode.workspace.fs.rename(join(source), join(destination), { overwrite: false });
    },
    async deleteFile(rel: string) {
      await vscode.workspace.fs.delete(join(rel), { recursive: false, useTrash: false });
    },
    ...(process.platform === 'win32'
      ? {}
      : {
        async setOwnerExecutable(rel: string, executable: boolean) {
          const absolute = fsPathFor(rel);
          const info = await stat(absolute);
          await chmod(absolute, executable ? (info.mode | 0o100) : (info.mode & ~0o100));
        },
      }),
    async filesystemUsage() {
      const info = await statfs(root, { bigint: true });
      const total = info.bsize * info.blocks;
      const free = info.bsize * info.bfree;
      const available = info.bsize * info.bavail;
      return {
        totalBytes: total.toString(),
        usedBytes: (total - free).toString(),
        freeBytes: free.toString(),
        availableBytes: available.toString(),
      };
    },
    async removeFile(rel: string) {
      await vscode.workspace.fs.delete(join(rel), { recursive: false });
    },
    async realpath(rel: string) {
      return realpath(fsPathFor(rel));
    },
    async realpathRoot() {
      return realpath(root);
    },
  };
}
