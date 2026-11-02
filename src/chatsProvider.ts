/**
 * Extension-host side of the RAME Code Chats webview view.
 *
 * Key-handling contract (unchanged from the panel base):
 * - The key is read from `vscode.SecretStorage` at mission time and never
 *   leaves the extension host except inside the provider HTTPS request.
 * - The webview receives only the boolean `hasKey` flag.
 *
 * Thread contract:
 * - Threads persist in `ExtensionContext.globalState` through
 *   {@link ThreadStore} under a versioned key and never contain key material.
 * - A send with no active thread creates one. Every send transmits only the
 *   newly submitted composer text; earlier thread content is never sent.
 */

import * as vscode from 'vscode';

import { META_MODEL } from './meta-provider.js';
import { MissionRunner } from './missionRunner.js';
import {
  buildChatsStateMessage,
  parseChatInboundMessage,
  selectMissionGoalForSend,
} from './chatMessages.js';
import { buildChatsHtml, createChatsNonce } from './chatsHtml.js';
import { isSupportedMode, isSupportedModel } from './modes.js';
import {
  formatPlanAsText,
  initialPanelState,
  withHasKey,
  withMissionCancelled,
  withMissionFailed,
  withMissionStarted,
  withMissionSucceeded,
  withStatus,
  type PanelState,
} from './panelState.js';
import { API_KEY_SECRET } from './settingsProvider.js';
import {
  appendErrorTurn,
  appendPlanTurn,
  appendUserTurn,
  ThreadStore,
} from './threadStore.js';
import {
  redactKeyFromText,
  validateGoalInput,
} from './webviewMessages.js';

export const CHATS_VIEW_ID = 'rameCode.chats';

export class ChatsProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private panel: PanelState = initialPanelState(false);
  private activeThreadId: string | null = null;
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly runner: MissionRunner,
    private readonly store: ThreadStore,
    private readonly output: vscode.OutputChannel,
  ) {}

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = view;

    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    const nonce = createChatsNonce();
    view.webview.html = buildChatsHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chats.js'))
        .toString(),
      styleUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'chats.css'))
        .toString(),
      nonce,
    });

    const messageHandler = view.webview.onDidReceiveMessage((raw: unknown) => {
      void this.handleMessage(raw);
    });
    const disposeHandler = view.onDidDispose(() => {
      this.view = undefined;
      vscode.Disposable.from(...this.disposables).dispose();
      this.disposables.length = 0;
    });
    this.disposables.push(messageHandler, disposeHandler);

    void this.refreshAll();
  }

  dispose(): void {
    this.disposed = true;
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
    this.view = undefined;
  }

  /** Reload persisted threads and the key flag, then publish key-free state. */
  async refreshAll(): Promise<void> {
    this.store.load();
    const stored = await this.secrets.get(API_KEY_SECRET);
    this.panel = withHasKey(this.panel, stored !== undefined);
    this.ensureActiveThreadStillExists();
    await this.postState();
  }

  /** Re-read SecretStorage and publish the key-free `hasKey` flag. */
  async refreshHasKey(): Promise<void> {
    const stored = await this.secrets.get(API_KEY_SECRET);
    this.panel = withHasKey(this.panel, stored !== undefined);
    await this.postState();
  }

  /** Start an empty thread: selection clears; storage happens on send. */
  async newThread(): Promise<void> {
    this.activeThreadId = null;
    if (!this.panel.running) {
      this.panel = withStatus(
        this.panel,
        'New thread started. Type a message below.',
      );
    }
    await this.postState();
  }

  /** Select an existing thread for display. */
  async openThread(threadId: string): Promise<void> {
    const thread = this.store.get(threadId);
    if (!thread) {
      this.panel = withStatus(this.panel, 'That thread is no longer stored.');
      await this.postState();
      return;
    }
    this.activeThreadId = thread.id;
    this.panel = withStatus(this.panel, `Opened “${thread.title}”.`);
    await this.postState();
  }

  /**
   * Submit one composer message. Only the newly submitted text is sent to
   * the provider; earlier thread content is never included.
   */
  async sendMessage(
    rawText: string,
    rawMode: string,
    rawModel: string,
  ): Promise<void> {
    if (this.runner.isRunning || this.panel.running) {
      this.panel = withStatus(
        this.panel,
        'A mission is already running. Cancel it before sending another.',
      );
      await this.postState();
      return;
    }
    if (!isSupportedMode(rawMode)) {
      this.panel = withStatus(
        this.panel,
        'Unknown mode. Mission is the only supported mode in this base.',
      );
      await this.postState();
      return;
    }
    if (!isSupportedModel(rawModel)) {
      this.panel = withStatus(
        this.panel,
        'Unknown model. Muse Spark 1.3 is the only supported model in this base.',
      );
      await this.postState();
      return;
    }

    const goal = selectMissionGoalForSend(rawText);
    const checkedGoal = validateGoalInput(goal);
    if (!checkedGoal.ok || checkedGoal.goal === undefined) {
      this.panel = withStatus(
        this.panel,
        checkedGoal.error ?? 'The message is invalid.',
      );
      await this.postState();
      return;
    }

    const apiKey = await this.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      this.panel = withHasKey(this.panel, false);
      await this.postState();
      return;
    }

    // Persist the user turn before the network call.
    let threadId = this.activeThreadId;
    let thread =
      threadId !== null ? this.store.get(threadId) : undefined;
    if (!thread) {
      thread = this.store.create(checkedGoal.goal);
      threadId = thread.id;
      this.activeThreadId = threadId;
    } else {
      thread = appendUserTurn(thread, checkedGoal.goal);
      this.store.save(thread);
    }

    if (threadId === null) {
      this.panel = withStatus(this.panel, 'The mission could not be started.');
      await this.postState();
      return;
    }

    const started = withMissionStarted(this.panel, checkedGoal.goal);
    if (started === null) {
      this.panel = withStatus(this.panel, 'The mission could not be started.');
      await this.postState();
      return;
    }
    this.panel = started;
    await this.postState();

    try {
      // Independent call: only the newly submitted text goes to the API.
      const plan = await this.runner.start({
        apiKey,
        goal: checkedGoal.goal,
      });
      this.panel = withMissionSucceeded(this.panel, plan);
      const current = this.store.get(threadId);
      if (current) {
        this.store.save(appendPlanTurn(current, plan));
      }
      this.output.clear();
      this.output.appendLine(formatPlanAsText(plan, META_MODEL));
      this.output.show(true);
    } catch (error) {
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        this.panel = withMissionCancelled(this.panel);
        const current = this.store.get(threadId);
        if (current) {
          this.store.save(appendErrorTurn(current, 'Mission cancelled.'));
        }
      } else {
        const detail =
          error instanceof Error ? error.message : 'Unknown error.';
        // Defensive: provider errors never include the key, but redact anyway.
        // The thread keeps a generic local note; detail stays in the status.
        this.panel = withMissionFailed(
          this.panel,
          redactKeyFromText(detail, apiKey),
        );
        const current = this.store.get(threadId);
        if (current) {
          this.store.save(appendErrorTurn(current, 'Planning failed.'));
        }
      }
    }
    await this.postState();
  }

  /** Cancel the running mission. Returns false when nothing was running. */
  cancelMission(): boolean {
    if (!this.runner.isRunning && !this.panel.running) {
      this.panel = withStatus(this.panel, 'No mission is running.');
      void this.postState();
      return false;
    }
    this.runner.cancel();
    this.panel = withMissionCancelled(this.panel);
    void this.postState();
    return true;
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let message;
    try {
      message = parseChatInboundMessage(raw);
    } catch {
      this.panel = withStatus(
        this.panel,
        'Ignoring an invalid chats request.',
      );
      await this.postState();
      return;
    }

    switch (message.type) {
      case 'ready':
      case 'refreshThreads':
        await this.refreshAll();
        return;
      case 'newThread':
        await this.newThread();
        return;
      case 'openThread':
        await this.openThread(message.threadId);
        return;
      case 'sendMessage':
        await this.sendMessage(message.text, message.mode, message.model);
        return;
      case 'cancelMission':
        this.cancelMission();
        return;
      case 'openSettings':
        await this.revealSettings();
        return;
    }
  }

  private async revealSettings(): Promise<void> {
    try {
      await vscode.commands.executeCommand('rameCode.settings.focus');
    } catch {
      // The view may be unavailable (e.g. in tests); state is unchanged.
    }
  }

  private ensureActiveThreadStillExists(): void {
    if (
      this.activeThreadId !== null &&
      !this.store.get(this.activeThreadId)
    ) {
      this.activeThreadId = null;
    }
  }

  private async postState(): Promise<void> {
    if (this.disposed || !this.view) {
      return;
    }
    const threads = this.store.list();
    const active =
      this.activeThreadId !== null
        ? this.store.get(this.activeThreadId)
        : undefined;
    await this.view.webview.postMessage(
      buildChatsStateMessage({
        hasKey: this.panel.hasKey,
        running: this.panel.running,
        status: this.panel.status,
        connection: this.panel.connection,
        threads,
        activeThreadId: active ? active.id : null,
        turns: active ? active.turns : [],
      }),
    );
  }
}
