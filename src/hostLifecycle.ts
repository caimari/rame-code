/**
 * The lifetime of one extension-host instance, as far as it may change the
 * workspace. When VS Code reloads or closes the view, the old host is
 * disposed while some of its promises may still be pending (a slow
 * acceptance check, a model reply). Nothing scheduled by that old host may
 * write afterwards: the next window recovers the Mission from its
 * checkpoint, like after a killed process.
 *
 * Barriers, each enough on its own for what it guards: the agent's file
 * system refuses changes (`guardDisposedWrites`, used by `agentFsFor`); no
 * request starts (`executeSend`, `ChatRunner.close`); no test or acceptance
 * process starts (`runAllowlistedTest`); the Mission loop checks `live()`
 * after every await; `updateActiveMission` writes no Mission state.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 */

import type { AgentFs } from './agentHost.js';

export class HostDisposedError extends Error {
  constructor() {
    super('This RAME Code window was closed or reloaded; nothing was written.');
    this.name = 'HostDisposedError';
  }
}

/**
 * The same file system, refusing every change once `disposed()` is true.
 * Reads still work (they change nothing). The check runs immediately before
 * each change, after any await of the caller.
 */
export function guardDisposedWrites(fs: AgentFs, disposed: () => boolean): AgentFs {
  const guard = <A extends unknown[], R>(method: ((...args: A) => Promise<R>) | undefined): ((...args: A) => Promise<R>) | undefined =>
    method === undefined
      ? undefined
      : async (...args: A): Promise<R> => {
          if (disposed()) {
            throw new HostDisposedError();
          }
          return method.apply(fs, args);
        };
  const optional = <K extends keyof AgentFs>(key: K, value: AgentFs[K] | undefined): Partial<AgentFs> => (value === undefined ? {} : { [key]: value });
  return {
    listEntries: fs.listEntries.bind(fs),
    readText: fs.readText.bind(fs),
    stat: fs.stat.bind(fs),
    writeText: guard(fs.writeText.bind(fs)) as AgentFs['writeText'],
    ...optional('createDirectory', guard(fs.createDirectory?.bind(fs))),
    ...optional('moveFile', guard(fs.moveFile?.bind(fs))),
    ...optional('deleteFile', guard(fs.deleteFile?.bind(fs))),
    ...optional('setOwnerExecutable', guard(fs.setOwnerExecutable?.bind(fs))),
    ...optional('removeFile', guard(fs.removeFile?.bind(fs))),
    ...optional('filesystemUsage', fs.filesystemUsage?.bind(fs)),
    ...optional('realpath', fs.realpath?.bind(fs)),
    ...optional('realpathRoot', fs.realpathRoot?.bind(fs)),
  };
}
