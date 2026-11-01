/**
 * Pure Chats webview HTML builder, free of the `vscode` API so the document
 * structure and Content-Security-Policy can be unit tested with `node:test`.
 */

import { randomBytes } from 'node:crypto';

export interface ChatsHtmlOptions {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  nonce: string;
}

/** Create a fresh CSP nonce for one webview load. */
export function createChatsNonce(): string {
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
 * Build the Chats document. The markup contains no API key and no remote
 * URLs: one local script, one local stylesheet, and a nonce-protected
 * inline style block.
 */
export function buildChatsHtml(options: ChatsHtmlOptions): string {
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
main { display: flex; flex-direction: column; gap: 8px; padding: 8px 8px 4px; }
#composer-wrap { position: sticky; bottom: 0; padding-bottom: 8px; }
#transcript { display: flex; flex-direction: column; gap: 8px; }
.turn { border: 1px solid var(--vscode-panel-border, transparent); border-radius: 2px; padding: 6px 8px; }
</style>
<title>RAME Code Chats</title>
</head>
<body>
<main>
  <header class="chats-header">
    <h2 class="chats-title">Chats</h2>
    <div class="chats-actions" role="toolbar" aria-label="Chats actions">
      <button id="newThread" type="button" title="New thread" aria-label="New thread">New thread</button>
      <button id="refreshThreads" type="button" title="Refresh history" aria-label="Refresh history">Refresh</button>
      <button id="openSettings" type="button" title="Open Settings" aria-label="Open Settings">Settings</button>
    </div>
  </header>
  <section aria-labelledby="recent-heading">
    <h3 id="recent-heading">Recent</h3>
    <ul id="threadList"></ul>
  </section>
  <section aria-labelledby="transcript-heading">
    <h3 id="transcript-heading">Transcript</h3>
    <p id="connection" role="status">Checking…</p>
    <p id="scopeNotice" class="hint">Only the current message is sent to Meta Model API. Earlier thread content is not sent as context yet.</p>
    <div id="transcript" aria-live="polite"></div>
    <p id="emptyState" class="hint">No thread selected. Start a new thread below.</p>
  </section>
  <footer id="composer-wrap">
    <label for="composer">Message</label>
    <textarea id="composer" rows="3" placeholder="Describe the software goal. Only this message is sent."></textarea>
    <div class="row">
      <label for="modeSelect">Mode</label>
      <select id="modeSelect" aria-label="Mode">
        <option value="mission" selected>Mission</option>
      </select>
      <label for="modelSelect">Model</label>
      <select id="modelSelect" aria-label="Model">
        <option value="muse-spark-1.3" selected>Muse Spark 1.3</option>
      </select>
    </div>
    <div class="row">
      <button id="send" type="button" title="Send message" aria-label="Send message">Send</button>
      <button id="cancel" type="button" title="Cancel running mission" aria-label="Cancel running mission">Cancel</button>
    </div>
    <p id="status" role="status">Starting…</p>
  </footer>
</main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
