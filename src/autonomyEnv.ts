/**
 * The environment RAME Code's host runs in, where every authorized
 * operation actually happens: this computer, a Remote SSH server, WSL, a
 * container. Every pre-authorization and Full Access grant is bound to it,
 * so a permission given on one computer never applies on another, and a
 * change of computer, server identity, user or workspace invalidates it.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * The identity is a hash of the kind of environment (`vscode.env.remoteName`,
 * none for local), the host name, the operating-system user, the machine id
 * (`/etc/machine-id`, or a random id kept in RAME Code's state folder on that
 * machine) and, for a remote environment, the server's SSH host key when it
 * can be read. Nothing of it is sent anywhere.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ExecEnv {
  /** `env_` and 16 hex characters. */
  id: string;
  /** `local`, `ssh-remote`, `wsl`, `dev-container`, … */
  kind: string;
  host: string;
  user: string;
  /** How the user is told where operations run. */
  label: string;
}

export interface EnvProbe {
  remoteName?: string | undefined;
  hostname(): string;
  user(): string;
  readFile(file: string): string | null;
  /** A random id for this installation, created once on that machine. */
  installId(): string;
}

const HOST_KEYS = ['/etc/ssh/ssh_host_ed25519_key.pub', '/etc/ssh/ssh_host_ecdsa_key.pub', '/etc/ssh/ssh_host_rsa_key.pub'];
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export function describeEnv(kind: string, host: string, user: string): string {
  switch (kind) {
    case 'local':
      return `this computer (${host}, user ${user})`;
    case 'ssh-remote':
      return `the Remote SSH server ${host} (user ${user})`;
    case 'wsl':
      return `WSL on ${host} (user ${user})`;
    default:
      return `the ${kind} environment ${host} (user ${user})`;
  }
}

export function computeExecEnv(probe: EnvProbe): ExecEnv {
  const kind = (probe.remoteName ?? '').trim().slice(0, 40) || 'local';
  const host = probe.hostname().trim().slice(0, 120) || 'unknown-host';
  const user = probe.user().trim().slice(0, 128) || 'unknown';
  const machine = (probe.readFile('/etc/machine-id') ?? probe.readFile('/var/lib/dbus/machine-id') ?? '').trim() || probe.installId();
  let hostKey = '';
  if (kind !== 'local') {
    for (const file of HOST_KEYS) {
      const key = probe.readFile(file)?.trim().split(/\s+/)[1];
      if (key) {
        hostKey = sha(key);
        break;
      }
    }
  }
  return { id: `env_${sha(JSON.stringify(['rame-env:v1', kind, host, user, machine, hostKey])).slice(0, 16)}`, kind, host, user, label: describeEnv(kind, host, user) };
}

function readSmall(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, 8192);
  } catch {
    return null;
  }
}

function installIdIn(stateDir: string | undefined): string {
  const file = path.join(stateDir ?? path.join(os.tmpdir(), `rame-code-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`), 'install-id');
  const known = readSmall(file)?.trim();
  if (known && /^[0-9a-f]{32}$/.test(known)) {
    return known;
  }
  const fresh = randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fresh, { flag: 'wx', mode: 0o600 });
    return fresh;
  } catch {
    // Another window created it first, or the folder is read-only.
    return readSmall(file)?.trim() || fresh;
  }
}

function osUserName(): string {
  try {
    return os.userInfo().username || 'unknown';
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

/** The real environment of this process, recomputed at most every 2 s. */
export function liveExecEnv(remoteName: string | undefined, stateDir: string | undefined): () => ExecEnv {
  let cached: { at: number; env: ExecEnv } | null = null;
  let installId: string | null = null;
  return () => {
    if (cached !== null && Date.now() - cached.at < 2000) {
      return cached.env;
    }
    const env = computeExecEnv({ remoteName, hostname: () => os.hostname(), user: osUserName, readFile: readSmall, installId: () => (installId ??= installIdIn(stateDir)) });
    cached = { at: Date.now(), env };
    return env;
  };
}
