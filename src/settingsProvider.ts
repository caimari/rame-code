/**
 * Extension-host side of the RAME Code Settings webview view.
 *
 * Key-handling contract (unchanged from the panel base):
 * - The key travels from the webview to the host only inside an explicit
 *   `saveKey` message (the Save key button).
 * - It is stored only in `vscode.SecretStorage`, never echoed back to the
 *   webview, and never written to HTML, logs, config, or error text.
 * - The webview receives only the boolean `hasKey` flag.
 */

import * as vscode from 'vscode';

import {
  buildSettingsStateMessage,
  parseSettingsInboundMessage,
} from './settingsMessages.js';
import { buildSettingsHtml, createSettingsNonce } from './settingsHtml.js';
import type { ConnectionState } from './panelState.js';
import { validateApiKeyInput } from './webviewMessages.js';

export const SETTINGS_VIEW_ID = 'rameCode.settings';
export const API_KEY_SECRET = 'rameCode.metaModelApiKey';

export class SettingsProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private hasKey = false;
  private status = 'Starting…';
  private connection: ConnectionState = 'missing-key';
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
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

    const nonce = createSettingsNonce();
    view.webview.html = buildSettingsHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settings.js'))
        .toString(),
      styleUri: view.webview
        .asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'settings.css'))
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
    this.hasKey = stored !== undefined;
    this.connection = this.hasKey ? 'ready' : 'missing-key';
    this.status = this.hasKey
      ? 'API key stored. Ready.'
      : 'No API key stored. Save a Meta Model API key to begin.';
    await this.postState();
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let message;
    try {
      message = parseSettingsInboundMessage(raw);
    } catch {
      // Validation errors carry no received values by construction.
      this.status = 'Ignoring an invalid settings request.';
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
      case 'ready':
        await this.refreshHasKey();
        return;
    }
  }

  private async saveKey(rawKey: string): Promise<void> {
    const checked = validateApiKeyInput(rawKey);
    if (!checked.ok || checked.apiKey === undefined) {
      this.status = checked.error ?? 'The API key is invalid.';
      await this.postState();
      return;
    }
    await this.secrets.store(API_KEY_SECRET, checked.apiKey);
    await this.refreshHasKey();
  }

  private async clearKey(): Promise<void> {
    await this.secrets.delete(API_KEY_SECRET);
    await this.refreshHasKey();
  }

  private async postState(): Promise<void> {
    if (this.disposed || !this.view) {
      return;
    }
    // `buildSettingsStateMessage` exposes only the boolean hasKey flag.
    await this.view.webview.postMessage(
      buildSettingsStateMessage({
        hasKey: this.hasKey,
        connection: this.connection,
        status: this.status,
      }),
    );
  }
}
