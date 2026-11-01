/**
 * Extension-host side of the RAME Code webview view.
 *
 * Key-handling contract:
 * - The key travels from the webview to the host only inside an explicit
 *   `saveKey` message (the Save key button).
 * - It is stored only in `vscode.SecretStorage`, never echoed back to the
 *   webview, and never written to HTML, logs, config, or error text.
 * - The webview receives only the boolean `hasKey` flag.
 */

import * as vscode from 'vscode';

import { META_MODEL } from './meta-provider.js';
import { MissionRunner } from './missionRunner.js';
import { buildPanelHtml, createNonce } from './panelHtml.js';
import {
  formatPlanAsText,
  initialPanelState,
  toWebviewStateMessage,
  withHasKey,
  withMissionCancelled,
  withMissionFailed,
  withMissionStarted,
  withMissionSucceeded,
  withStatus,
  type PanelState,
} from './panelState.js';
import {
  parseInboundMessage,
  redactKeyFromText,
  validateApiKeyInput,
  validateGoalInput,
} from './webviewMessages.js';

export const VIEW_ID = 'rameCode.main';
export const API_KEY_SECRET = 'rameCode.metaModelApiKey';

export class RameCodePanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private state: PanelState = initialPanelState(false);
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly runner: MissionRunner,
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

    const nonce = createNonce();
    view.webview.html = buildPanelHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js'))
        .toString(),
      styleUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css'))
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

    // Reveal the latest known state (including hasKey) to the fresh view.
    void this.refreshHasKey();
  }

  dispose(): void {
    this.disposed = true;
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
    this.view = undefined;
  }

  /** Re-read SecretStorage and publish the key-free `hasKey` flag. */
  async refreshHasKey(): Promise<void> {
    const stored = await this.secrets.get(API_KEY_SECRET);
    this.state = withHasKey(this.state, stored !== undefined);
    await this.postState();
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let message;
    try {
      message = parseInboundMessage(raw);
    } catch {
      // Validation errors carry no received values by construction.
      this.state = withStatus(this.state, 'Ignoring an invalid panel request.');
      await this.postState();
      return;
    }

    switch (message.type) {
      case 'saveKey':
        await this.saveKey(message.apiKey);
        return;
      case 'clearKey':
        await this.clearKey();
        return;
      case 'startMission':
        await this.startMission(message.goal);
        return;
      case 'cancelMission':
        this.cancelMission();
        await this.postState();
        return;
      case 'ready':
        await this.refreshHasKey();
        return;
    }
  }

  private async saveKey(rawKey: string): Promise<void> {
    const checked = validateApiKeyInput(rawKey);
    if (!checked.ok || checked.apiKey === undefined) {
      this.state = withStatus(
        this.state,
        checked.error ?? 'The API key is invalid.',
      );
      await this.postState();
      return;
    }
    await this.secrets.store(API_KEY_SECRET, checked.apiKey);
    this.state = withHasKey(this.state, true);
    await this.postState();
  }

  private async clearKey(): Promise<void> {
    await this.secrets.delete(API_KEY_SECRET);
    this.state = withHasKey(this.state, false);
    await this.postState();
  }

  private async startMission(rawGoal: string): Promise<void> {
    if (this.runner.isRunning || this.state.running) {
      this.state = withStatus(
        this.state,
        'A mission is already running. Cancel it before starting another.',
      );
      await this.postState();
      return;
    }

    const checkedGoal = validateGoalInput(rawGoal);
    if (!checkedGoal.ok || checkedGoal.goal === undefined) {
      this.state = withStatus(
        this.state,
        checkedGoal.error ?? 'The mission goal is invalid.',
      );
      await this.postState();
      return;
    }

    // The key is read from SecretStorage at mission time and never leaves
    // the extension host except inside the provider's HTTPS request.
    const apiKey = await this.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      this.state = withHasKey(this.state, false);
      await this.postState();
      return;
    }

    const started = withMissionStarted(this.state, checkedGoal.goal);
    if (started === null) {
      this.state = withStatus(
        this.state,
        'The mission could not be started.',
      );
      await this.postState();
      return;
    }
    this.state = started;
    await this.postState();

    try {
      // Bounded behavior: only the user-entered goal text goes to the API.
      const plan = await this.runner.start({
        apiKey,
        goal: checkedGoal.goal,
      });
      this.state = withMissionSucceeded(this.state, plan);
      this.output.clear();
      this.output.appendLine(formatPlanAsText(plan, META_MODEL));
      this.output.show(true);
    } catch (error) {
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        this.state = withMissionCancelled(this.state);
      } else {
        const detail =
          error instanceof Error ? error.message : 'Unknown error.';
        // Defensive: the provider never includes the key, but redact anyway.
        this.state = withMissionFailed(
          this.state,
          redactKeyFromText(detail, apiKey),
        );
      }
    }
    await this.postState();
  }

  private cancelMission(): void {
    if (!this.runner.isRunning && !this.state.running) {
      this.state = withStatus(this.state, 'No mission is running.');
      return;
    }
    this.runner.cancel();
    this.state = withMissionCancelled(this.state);
  }

  private async postState(): Promise<void> {
    if (this.disposed || !this.view) {
      return;
    }
    // `toWebviewStateMessage` exposes only the boolean hasKey flag.
    await this.view.webview.postMessage(toWebviewStateMessage(this.state));
  }
}
