/**
 * Pure webview HTML builder. Kept free of the `vscode` API so the document
 * structure and Content-Security-Policy can be unit tested with `node:test`.
 * The extension host supplies the webview `cspSource`, the local resource
 * URIs, and a fresh per-load nonce.
 */

import { randomBytes } from 'node:crypto';

export interface PanelHtmlOptions {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  nonce: string;
}

/** Create a fresh CSP nonce for one webview load. */
export function createNonce(): string {
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
 * Build the panel document. The markup intentionally contains no API key and
 * no remote URLs: one local script, one local stylesheet, and a
 * nonce-protected inline style block.
 */
export function buildPanelHtml(options: PanelHtmlOptions): string {
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
section { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.hint { opacity: 0.85; }
#plan { white-space: normal; }
#plan ol, #plan ul { margin: 4px 0 8px; padding-left: 20px; }
</style>
<title>RAME Code Mission</title>
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
    <p class="hint">Sent to the extension host only when you click Save key. Stored only in VS Code SecretStorage; the panel only ever learns whether a key exists.</p>
  </section>
  <section aria-labelledby="mission-heading">
    <h2 id="mission-heading">Mission</h2>
    <label for="mission">Mission goal</label>
    <textarea id="mission" rows="5" placeholder="Describe the software goal. Only this text is sent to Meta Model API."></textarea>
    <div class="row">
      <button id="start" type="button">Start mission</button>
      <button id="cancel" type="button">Cancel</button>
    </div>
  </section>
  <section aria-labelledby="status-heading">
    <h2 id="status-heading">Status</h2>
    <p id="status" role="status">Starting…</p>
  </section>
  <section aria-labelledby="plan-heading">
    <h2 id="plan-heading">Mission plan</h2>
    <div id="plan" aria-live="polite"><p class="hint">No plan yet.</p></div>
  </section>
</main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
