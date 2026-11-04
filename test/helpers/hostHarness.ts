/**
 * Behavioral harness for the real extension-host provider.
 *
 * Installs a minimal in-process `vscode` double (backed by a disposable
 * temporary directory) before loading `mainProvider`, plus a scripted
 * loopback OpenAI-compatible model server. No real VS Code, network, or
 * user workspace is touched; every temporary directory is removed by
 * `dispose()`.
 */

import { mkdtempSync, promises as fsp, rmSync } from 'node:fs';
import * as http from 'node:http';
import Module from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

// The Node under test runs every child too: `npm run` resolves `node` from
// PATH, which may point at another version than the one running the tests.
const NODE_DIR = path.dirname(process.execPath);
if ((process.env.PATH ?? '').split(path.delimiter)[0] !== NODE_DIR) {
  process.env.PATH = `${NODE_DIR}${path.delimiter}${process.env.PATH ?? ''}`;
}

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

interface FakeUri {
  scheme: 'file';
  fsPath: string;
  path: string;
  toString(): string;
}

function fileUri(fsPath: string): FakeUri {
  return { scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` };
}

async function statType(fsPath: string): Promise<{ type: number; size: number }> {
  const link = await fsp.lstat(fsPath);
  if (link.isSymbolicLink()) {
    try {
      const target = await fsp.stat(fsPath);
      return { type: FileType.SymbolicLink | (target.isDirectory() ? FileType.Directory : FileType.File), size: target.size };
    } catch {
      return { type: FileType.SymbolicLink, size: 0 };
    }
  }
  return { type: link.isDirectory() ? FileType.Directory : link.isFile() ? FileType.File : FileType.Unknown, size: link.size };
}

export const fakeWindow = {
  quickPickAnswer: undefined as unknown,
  quickPickCalls: 0,
  async showQuickPick(items: Array<{ description?: string }>): Promise<unknown> {
    fakeWindow.quickPickCalls += 1;
    const answer = fakeWindow.quickPickAnswer;
    if (typeof answer === 'function') {
      return (answer as (all: unknown[]) => unknown)(items);
    }
    return answer;
  },
  async showInformationMessage(): Promise<undefined> {
    return undefined;
  },
  /** Modal answers: the first item of the queue, else the default (the first action offered). */
  warningAnswers: [] as Array<string | undefined>,
  warningCalls: [] as Array<{ message: string; detail: string }>,
  async showWarningMessage(message: string, options?: { detail?: string }, ...actions: string[]): Promise<string | undefined> {
    fakeWindow.warningCalls.push({ message, detail: options?.detail ?? '' });
    return fakeWindow.warningAnswers.length > 0 ? fakeWindow.warningAnswers.shift() : actions[0];
  },
};

export const fakeWorkspace = {
  workspaceFolders: undefined as undefined | Array<{ name: string; uri: FakeUri; index: number }>,
  fs: {
    async readDirectory(uri: FakeUri): Promise<Array<[string, number]>> {
      const names = await fsp.readdir(uri.fsPath);
      const out: Array<[string, number]> = [];
      for (const name of names) {
        out.push([name, (await statType(path.join(uri.fsPath, name))).type]);
      }
      return out;
    },
    async readFile(uri: FakeUri): Promise<Uint8Array> {
      return new Uint8Array(await fsp.readFile(uri.fsPath));
    },
    async stat(uri: FakeUri): Promise<{ type: number; size: number }> {
      return statType(uri.fsPath);
    },
    async writeFile(uri: FakeUri, bytes: Uint8Array): Promise<void> {
      await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fsp.writeFile(uri.fsPath, bytes);
    },
    async createDirectory(uri: FakeUri): Promise<void> {
      await fsp.mkdir(uri.fsPath, { recursive: true });
    },
    async rename(source: FakeUri, target: FakeUri): Promise<void> {
      await fsp.rename(source.fsPath, target.fsPath);
    },
    async delete(uri: FakeUri): Promise<void> {
      await fsp.unlink(uri.fsPath);
    },
  },
};

const fakeVscode = {
  FileType,
  Uri: {
    file: fileUri,
    joinPath: (base: FakeUri, ...parts: string[]) => fileUri(path.join(base.fsPath, ...parts)),
  },
  workspace: fakeWorkspace,
  window: fakeWindow,
  commands: { async executeCommand(): Promise<undefined> { return undefined; } },
  Disposable: {
    from: (...items: Array<{ dispose(): unknown }>) => ({
      dispose: () => {
        for (const item of items) {
          item.dispose();
        }
      },
    }),
  },
};

let installed = false;

/** Register the `vscode` double; must run before `mainProvider` loads. */
export function installFakeVscode(): void {
  if (installed) {
    return;
  }
  installed = true;
  const moduleApi = Module as unknown as {
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
    _cache: Record<string, unknown>;
  };
  const original = moduleApi._resolveFilename;
  moduleApi._resolveFilename = function (request: string, ...rest: unknown[]): string {
    if (request === 'vscode') {
      return 'vscode';
    }
    return original.call(this, request, ...rest);
  };
  moduleApi._cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: fakeVscode };
}

installFakeVscode();

/** Non-loopback URLs a test tried to reach; they are refused, never sent. */
export const blockedFetches: string[] = [];
/**
 * Optional in-process stand-in for Meta Model API. Requests it answers are
 * recorded (headers included) and never leave the process.
 */
export const fakeCloud: {
  handler: null | ((body: Record<string, unknown>) => Response);
  requests: Array<{ url: string; authorization: string; body: Record<string, unknown> }>;
} = { handler: null, requests: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) {
    if (fakeCloud.handler !== null && url.startsWith('https://api.meta.ai/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      fakeCloud.requests.push({ url, authorization: headers.get('Authorization') ?? '', body });
      const handler = fakeCloud.handler;
      // Like the real fetch: an abort rejects a request that is still pending.
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        Promise.resolve(handler(body)).then(resolve, reject);
      });
    }
    blockedFetches.push(url);
    return Promise.reject(new Error('Non-loopback request refused by the test harness.'));
  }
  return realFetch(input, init);
}) as typeof fetch;

// Loaded only after the double is registered.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mainProviderModule = require('../../src/mainProvider.js') as typeof import('../../src/mainProvider.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const missionModule = require('../../src/missionRunner.js') as typeof import('../../src/missionRunner.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chatModule = require('../../src/chatRunner.js') as typeof import('../../src/chatRunner.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storeModule = require('../../src/threadStore.js') as typeof import('../../src/threadStore.js');

export type ModelReply =
  | { kind: 'json'; body: unknown; status?: number }
  | { kind: 'hang' }
  | { kind: 'partial' };

/** Scripted loopback model: each request consumes the next reply. */
export class FakeModelServer {
  readonly requests: Array<Record<string, unknown>> = [];
  private readonly replies: ModelReply[] = [];
  private server: http.Server | null = null;
  private readonly open = new Set<http.ServerResponse>();
  endpoint = '';
  /**
   * Body for `GET /props` (llama-server metadata). Null answers 404, like
   * an OpenAI-compatible server that is not llama-server. Props reads never
   * consume a scripted chat reply.
   */
  props: unknown = null;
  propsRequests = 0;
  /**
   * Optional metadata routes (Ollama's /api/..., LM Studio's /api/v0/models):
   * an answer here is sent as JSON and never consumes a scripted chat reply.
   */
  metadata: ((method: string, url: string, body: string) => unknown) | null = null;

  enqueue(...replies: ModelReply[]): void {
    this.replies.push(...replies);
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/props') {
        this.propsRequests += 1;
        req.resume();
        res.writeHead(this.props === null ? 404 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.props ?? { error: { code: 404, message: 'Not Found' } }));
        return;
      }
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        const meta = this.metadata?.(req.method ?? 'GET', req.url ?? '/', raw);
        if (meta !== undefined) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(meta));
          return;
        }
        try {
          this.requests.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          this.requests.push({});
        }
        const reply = this.replies.shift() ?? { kind: 'json', body: assistantText('done') };
        if (reply.kind === 'hang') {
          this.open.add(res);
          return;
        }
        if (reply.kind === 'partial') {
          this.open.add(res);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('{"choices":[');
          return;
        }
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as { port: number };
    this.endpoint = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.open) {
      res.destroy();
    }
    this.open.clear();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

export function assistantText(text: string, usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }): unknown {
  return { choices: [{ message: { role: 'assistant', content: text } }], usage };
}

export function toolCallReply(
  calls: Array<{ id: string; name: string; args: unknown }>,
  usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
): unknown {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args) },
          })),
        },
      },
    ],
    usage,
  };
}

export interface PostedState {
  running: boolean;
  status: string;
  connection: string;
  activeThreadId: string | null;
  turns: Array<{ kind: string; text?: string; message?: string; hostRecord?: string[] }>;
  agentPending: null | { actionId: string; digest: string; tool: string; threadId: string; bodyPreview: string; targets: string[] };
  agentLog: Array<{ tool: string; decision: string; result: string }>;
  escalation: { pending: boolean; reason: string };
  [key: string]: unknown;
}

export class HostHarness {
  readonly root: string;
  readonly workspace: string;
  readonly model = new FakeModelServer();
  readonly posted: PostedState[] = [];
  readonly memento = new Map<string, unknown>();
  readonly secretValues = new Map<string, string>();
  provider!: InstanceType<typeof mainProviderModule.RameCodeViewProvider>;
  private handler: ((raw: unknown) => void) | null = null;

  /** When set, memory and Missions use shared files here (like two real windows). */
  sharedStateDir: string | undefined;

  constructor(options: { folders?: number; sharedStateDir?: string } = {}) {
    this.sharedStateDir = options.sharedStateDir;
    this.root = mkdtempSync(path.join(os.tmpdir(), 'rame-host-harness-'));
    this.workspace = path.join(this.root, 'ws');
    const count = options.folders ?? 1;
    const folders = [];
    for (let index = 0; index < count; index++) {
      const dir = index === 0 ? this.workspace : path.join(this.root, `ws${index}`);
      folders.push({ name: path.basename(dir), uri: fileUri(dir), index });
    }
    fakeWorkspace.workspaceFolders = count === 0 ? undefined : folders;
    fakeWindow.quickPickAnswer = undefined;
    fakeWindow.quickPickCalls = 0;
  }

  async start(settings: Record<string, unknown> = {}): Promise<void> {
    for (const folder of fakeWorkspace.workspaceFolders ?? []) {
      await fsp.mkdir(folder.uri.fsPath, { recursive: true });
    }
    await this.model.start();
    this.memento.set('rameCode.settings.v1', {
      ...settingsDefaults(),
      provider: 'local',
      model: 'local-glimmer',
      mode: 'agent',
      externalLocalEndpoint: this.model.endpoint,
      ...settings,
    });
    this.createProvider();
  }

  /** Construct a provider over the same persisted state (simulates reload). */
  createProvider(options: { isolatedState?: boolean } = {}): void {
    // isolatedState: another window whose globalState cache has none of this
    // window's writes (it starts from a copy of the settings only).
    const backing = options.isolatedState
      ? new Map<string, unknown>([['rameCode.settings.v1', this.memento.get('rameCode.settings.v1')]])
      : this.memento;
    const state = {
      get: (key: string) => backing.get(key),
      update: (key: string, value: unknown) => {
        // Like VS Code's Memento: `undefined` removes the key.
        if (value === undefined) {
          backing.delete(key);
        } else {
          backing.set(key, JSON.parse(JSON.stringify(value)) as unknown);
        }
        return Promise.resolve();
      },
    };
    const secrets = {
      get: async (key: string) => this.secretValues.get(key),
      store: async (key: string, value: string) => {
        this.secretValues.set(key, value);
      },
      delete: async (key: string) => {
        this.secretValues.delete(key);
      },
    };
    const output = { clear() {}, appendLine() {}, show() {} };
    const store = new storeModule.ThreadStore(state);
    store.load();
    this.provider = new mainProviderModule.RameCodeViewProvider(
      fileUri(this.root) as never,
      secrets as never,
      new missionModule.MissionRunner(),
      new chatModule.ChatRunner(),
      store,
      state,
      output as never,
      this.sharedStateDir,
    );
    this.provider.resolveWebviewView(this.fakeView() as never, {} as never, {} as never);
  }

  /**
   * Rebuild the webview over the same provider, as VS Code does when the
   * view is hidden and shown again: the page starts over with no memory.
   */
  rebuildView(): void {
    this.provider.resolveWebviewView(this.fakeView() as never, {} as never, {} as never);
  }

  private fakeView(): unknown {
    return {
      webview: {
        options: {},
        html: '',
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: FakeUri) => uri,
        postMessage: async (message: unknown) => {
          this.posted.push(JSON.parse(JSON.stringify(message)) as PostedState);
          return true;
        },
        onDidReceiveMessage: (handler: (raw: unknown) => void) => {
          this.handler = handler;
          return { dispose() {} };
        },
      },
      onDidDispose: () => ({ dispose() {} }),
    };
  }

  send(raw: unknown): void {
    this.handler?.(raw);
  }

  last(): PostedState {
    return this.posted[this.posted.length - 1] as PostedState;
  }

  /** Poll posted state until `predicate` holds or the deadline passes. */
  async waitFor(predicate: (state: PostedState) => boolean, timeoutMs = 4000): Promise<PostedState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = this.posted.length > 0 ? this.last() : null;
      if (state && predicate(state)) {
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for state; last status: ${this.posted.length > 0 ? this.last().status : '(none)'}`);
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const target = path.join(this.workspace, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }

  async readFile(rel: string): Promise<string> {
    return fsp.readFile(path.join(this.workspace, rel), 'utf8');
  }

  /**
   * Write a stand-in `llama-server` executable that answers `/health` and
   * proxies chat requests to the scripted model, so the owned-runtime
   * lifecycle (start, idle shutdown, stop) runs for real.
   */
  async writeFakeLlamaServer(): Promise<string> {
    const script = path.join(this.root, 'fake-llama-server.js');
    await fsp.writeFile(
      script,
      `#!${process.execPath}
const http = require('node:http');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1]);
const upstream = ${JSON.stringify(this.model.endpoint)};
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('{"status":"ok"}'); return; }
  if (req.method === 'GET') {
    fetch(upstream + req.url).then(async (r) => {
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(await r.text());
    }).catch(() => { res.writeHead(502); res.end('{}'); });
    return;
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    try {
      const r = await fetch(upstream + req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(await r.text());
    } catch { res.writeHead(502); res.end('{}'); }
  });
}).listen(port, '127.0.0.1');
`,
    );
    await fsp.chmod(script, 0o755);
    return script;
  }

  async dispose(): Promise<void> {
    try {
      this.provider?.dispose();
    } catch {
      // Already disposed.
    }
    await this.model.stop();
    fakeWorkspace.workspaceFolders = undefined;
    rmSync(this.root, { recursive: true, force: true });
  }
}

function settingsDefaults(): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const settingsModule = require('../../src/settingsStore.js') as typeof import('../../src/settingsStore.js');
  return settingsModule.defaultSettings() as unknown as Record<string, unknown>;
}
