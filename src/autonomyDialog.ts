/**
 * The VS Code side of Autonomy & Permissions: the modal confirmation of a
 * pre-authorization, and where this host runs and the key that seals its
 * policies.
 *
 * Only the user's click on the dialog's action pre-authorizes anything;
 * closing it or pressing Escape refuses.
 *
 * The seal key is 32 random bytes kept in VS Code's SecretStorage (the
 * system keychain), never in the state file it protects. Until it is
 * loaded nothing is in force. If another window created a different key
 * at the same moment, the stored one wins on its next change.
 */

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { liveExecEnv } from './autonomyEnv.js';
import type { AutonomyRuntime } from './autonomyStore.js';

const SEAL_KEY = 'rameCode.autonomy.sealKey';

export async function confirmAutonomyDialog(request: { message: string; detail: string; action: string }): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(request.message, { modal: true, detail: request.detail }, request.action);
  return choice === request.action;
}

export function autonomyRuntime(secrets: vscode.SecretStorage, stateDir: string | undefined): AutonomyRuntime {
  let key: Buffer | null = null;
  const load = async (): Promise<void> => {
    let stored = await secrets.get(SEAL_KEY);
    if (!stored || !/^[0-9a-f]{64}$/.test(stored)) {
      await secrets.store(SEAL_KEY, randomBytes(32).toString('hex'));
      stored = await secrets.get(SEAL_KEY);
    }
    key = stored && /^[0-9a-f]{64}$/.test(stored) ? Buffer.from(stored, 'hex') : null;
  };
  const loading = load().catch(() => undefined);
  secrets.onDidChange?.((event) => {
    if (event.key === SEAL_KEY) {
      void load().catch(() => undefined);
    }
  });
  return {
    env: liveExecEnv(vscode.env?.remoteName, stateDir),
    key: () => key,
    ready: () => loading,
    statePaths: stateDir ? [path.dirname(stateDir)] : [],
  };
}
