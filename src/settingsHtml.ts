/**
 * Pure Settings webview HTML builder, free of the `vscode` API so the
 * document structure and Content-Security-Policy can be unit tested with
 * `node:test`.
 */

import { randomBytes } from 'node:crypto';

export interface SettingsHtmlOptions {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  nonce: string;
}

/** Create a fresh CSP nonce for one webview load. */
export function createSettingsNonce(): string {
  return randomBytes(16).toString('base64');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the Settings document. The markup contains no API key and no remote
 * URLs: one local script, one local stylesheet, and a nonce-protected
 * inline style block.
 */
export function buildSettingsHtml(options: SettingsHtmlOptions): string {
  const cspSource = escapeAttr(options.cspSource);
  const scriptUri = escapeAttr(options.scriptUri);
  const styleUri = escapeAttr(options.styleUri);
  const nonce = escapeAttr(options.nonce);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; font-src 'none'; connect-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}">
<style nonce="${nonce}">
main { display: flex; flex-direction: column; gap: 12px; padding: 12px 12px 24px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.hint { opacity: 0.85; }
</style>
<title>RAME Code Settings</title>
</head>
<body>
<main>
  <section aria-labelledby="connection-heading">
    <h2 id="connection-heading">Connection</h2>
    <p id="connection" role="status">Checking…</p>
  </section>
  <section aria-labelledby="key-heading">
    <h2 id="key-heading">Meta Model API key</h2>
    <label for="apiKey">API key</label>
    <input id="apiKey" name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Enter a separate Meta Model API key">
    <div class="row">
      <button id="saveKey" type="button">Save key</button>
      <button id="clearKey" type="button">Clear key</button>
    </div>
    <p class="hint">Muse Code subscription credentials are not reused. Enter a separate Meta Model API key.</p>
    <p class="hint">Sent to the extension host only when you click Save key. Stored only in VS Code SecretStorage; this view only ever learns whether a key exists.</p>
  </section>
  <section aria-labelledby="status-heading">
    <h2 id="status-heading">Status</h2>
    <p id="status" role="status">Starting…</p>
  </section>
</main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
