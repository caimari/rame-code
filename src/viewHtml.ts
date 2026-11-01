/**
 * Pure HTML builder for the single `RAME Code` webview view.
 *
 * Free of the `vscode` API so the document structure and
 * Content-Security-Policy can be unit tested with `node:test`. Internal
 * navigation (Chat <-> Settings, plus Home <-> Conversation inside Chat)
 * happens inside this one document; the extension registers exactly one view.
 */

import { randomBytes } from 'node:crypto';

export interface ViewHtmlOptions {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  nonce: string;
}

/** Create a fresh CSP nonce for one webview load. */
export function createViewNonce(): string {
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
 * Build the unified document. The markup contains no API key and no remote
 * fetchable URLs: one local script, one local stylesheet, and a
 * nonce-protected inline style block. The only `http://` text is an inert
 * loopback `placeholder` attribute (never a `src`/`href`/CSP source), so it
 * cannot load a remote resource. All dynamic content is rendered by the
 * script with DOM construction and `textContent`, never `innerHTML`.
 */
export function buildViewHtml(options: ViewHtmlOptions): string {
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
html, body { height: 100%; overflow: hidden; }
main { display: flex; flex-direction: column; gap: 10px; height: 100vh; box-sizing: border-box; padding: 8px 8px 4px; min-width: 0; max-width: 100%; overflow: hidden; }
.screen[hidden] { display: none; }
#chatScreen { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; overflow: hidden; }
#chatScreen[hidden], #settingsScreen[hidden] { display: none; }
#settingsScreen { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.view-header { position: sticky; top: 0; z-index: 2; background-color: var(--vscode-sideBar-background); padding: 4px 0; min-width: 0; overflow: hidden; }
.view-header .view-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.view-header .view-actions { flex: 0 0 auto; min-width: 0; }
button.icon-btn { padding: 2px 7px; min-width: 28px; flex: 0 0 auto; font-size: 13px; line-height: 1.4; }
button.icon-btn.gear { font-size: 15px; }
#homeSection { display: flex; flex: 1 1 auto; flex-direction: column; gap: 6px; min-width: 0; min-height: 0; overflow-y: auto; }
#homeSection[hidden] { display: none; }
#recentSection { opacity: 0.92; min-width: 0; }
#recentSection h3 { margin-top: 2px; }
#homeCalm { min-height: 24px; }
#conversationSection { display: flex; flex: 1 1 auto; flex-direction: column; gap: 6px; min-width: 0; min-height: 0; overflow-y: auto; }
#conversationSection[hidden] { display: none; }
#conversationBar { display: flex; align-items: center; gap: 6px; min-width: 0; position: sticky; top: 0; z-index: 1; background-color: var(--vscode-sideBar-background); padding: 2px 0; }
#threadTitle { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; margin: 0; }
#transcriptSection { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
#composer-wrap { flex: 0 0 auto; padding: 8px 0 0; background-color: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border, transparent); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
#composerCard { position: relative; display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 100%; border: 1px solid var(--vscode-panel-border, transparent); border-radius: 12px; padding: 8px; background-color: var(--vscode-editor-background); }
#composerToolbar { display: grid; grid-template-columns: 32px auto minmax(64px, 1fr) 96px 32px; gap: 6px; align-items: center; min-width: 0; max-width: 100%; }
#composerMeta { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
.chip { display: inline-block; font-size: 12px; line-height: 1.4; padding: 0 7px; border: 0; border-radius: 3px; background: transparent; color: inherit; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip[hidden] { display: none; }
button.chip { cursor: pointer; font-family: inherit; }
#transcript { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.turn { border: 1px solid var(--vscode-panel-border, transparent); border-radius: 6px; padding: 8px 10px; line-height: 1.45; overflow-wrap: break-word; min-width: 0; }
.turn-user { background-color: var(--vscode-list-hoverBackground, transparent); }
.turn-assistant { background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
.result-card { border: 1px solid var(--vscode-testing-iconPassed, #73c991); border-left-width: 3px; border-radius: 6px; padding: 8px 10px; background-color: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
.result-card h3 { margin: 0 0 6px; color: var(--vscode-testing-iconPassed, #73c991); }
.result-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.45; }
#resultSection[hidden] { display: none; }
.turn-error { border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
.turn-plan { background-color: var(--vscode-editor-background); }
section.settings-block { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; border-top: 1px solid var(--vscode-panel-border, transparent); }
section.settings-block[hidden] { display: none; }
#runtimeStatus { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
#workspaceBadge { font-weight: 600; }
#workspaceBadge[hidden] { display: none; }
#activityList { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.activity-card { border: 1px solid var(--vscode-panel-border, transparent); border-left-width: 3px; border-radius: 4px; padding: 6px 8px; min-width: 0; }
.activity-card .activity-head { font-weight: 600; }
.activity-card .activity-sub { opacity: 0.9; white-space: pre-wrap; word-break: break-word; }
#agentWarning { font-weight: 700; border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500); border-radius: 4px; padding: 4px 6px; }
#agentWarning[hidden] { display: none; }
#permissionWarning { font-weight: 600; border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500); border-radius: 4px; padding: 4px 6px; }
#permissionWarning[hidden] { display: none; }
#runDetails { border: 1px solid var(--vscode-panel-border, transparent); border-radius: 4px; padding: 4px 6px; }
#runDetails summary { cursor: pointer; font-weight: 600; }
#profileSelect[hidden] { display: none; }
#agentBox { border: 2px solid var(--vscode-inputValidation-warningBorder, #b89500); border-radius: 6px; padding: 8px; background-color: var(--vscode-editor-background); box-shadow: 0 4px 16px rgba(0,0,0,0.25); position: sticky; bottom: 8px; z-index: 5; min-width: 0; }
#agentBox[hidden] { display: none; }
#agentBox h3 { margin-top: 0; }
#agentSection[hidden] { display: none; }
details.agent-details { border: 1px solid var(--vscode-panel-border, transparent); border-radius: 4px; padding: 4px 6px; }
details.agent-details summary { cursor: pointer; font-weight: 600; }
details.scope-details { border: 1px solid var(--vscode-panel-border, transparent); border-radius: 4px; padding: 4px 6px; }
details.scope-details summary { cursor: pointer; font-weight: 600; }
button.is-pending { opacity: 0.75; cursor: progress; }
button.is-pending::after { content: ""; display: inline-block; width: 10px; height: 10px; margin-left: 6px; border: 2px solid var(--vscode-progressBar-background, #0e70c0); border-right-color: transparent; border-radius: 50%; vertical-align: -1px; animation: rame-spin 0.8s linear infinite; }
@keyframes rame-spin { to { transform: rotate(360deg); } }
#permissionBtn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; max-width: 100%; height: 32px; padding: 0 6px; background: transparent; color: var(--vscode-foreground); border-color: transparent; }
#permissionBtn:hover, #runtimeStatus:hover { background-color: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
#permissionBtn .chip { padding: 0; }
#permissionMenu { position: absolute; left: 8px; bottom: 44px; z-index: 10; display: flex; flex-direction: column; gap: 4px; min-width: 0; max-width: calc(100% - 16px); border: 1px solid var(--vscode-panel-border, transparent); border-radius: 8px; padding: 6px; background-color: var(--vscode-editor-background); box-shadow: 0 4px 16px rgba(0,0,0,0.25); }
#permissionMenu[hidden] { display: none; }
#permissionMenu button { text-align: left; }
#runtimeStatus { height: 32px; min-width: 0; padding: 0 6px; background: transparent; color: var(--vscode-foreground); border-color: transparent; text-align: left; }
#composerToolbar > label[for="modeSelect"] { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
#modeSelect { height: 32px; padding-top: 0; padding-bottom: 0; }
#attachBtn, #send, #cancel { width: 32px; height: 32px; min-width: 32px; padding: 0; }
#send, #cancel { grid-column: 5; grid-row: 1; border-radius: 50%; font-size: 16px; line-height: 1; }
#cancel { color: var(--vscode-button-foreground); background-color: var(--vscode-inputValidation-errorBorder, #be1100); border-color: transparent; }
#cancel:not(:disabled):hover { background-color: var(--vscode-errorForeground, #f48771); }
#localStatus[data-state="running"] { color: var(--vscode-testing-iconPassed, #73c991); }
#startLocal.runtime-running { color: var(--vscode-testing-iconPassed, #73c991); background: transparent; border-color: var(--vscode-testing-iconPassed, #73c991); opacity: 1; }
#stopLocal { color: var(--vscode-errorForeground, #f48771); background: transparent; border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
#stopLocal:not(:disabled):hover { color: var(--vscode-button-foreground, #ffffff); background-color: var(--vscode-inputValidation-errorBorder, #be1100); }
#stopLocal:disabled { color: var(--vscode-errorForeground, #f48771); background: transparent; }
#cancel[hidden] { display: none; }
#modeSelect { max-width: 110px; }
#attachBtn:disabled { opacity: 0.5; cursor: not-allowed; }
.thread-meta { opacity: 0.75; font-size: 11px; }
.thread-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
#threadList .thread-open { flex: 1 1 auto; min-width: 0; width: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#threadList .thread-delete { flex: 0 0 28px; width: 28px; min-width: 28px; height: 28px; padding: 0; color: var(--vscode-foreground); background: transparent; border-color: transparent; font-size: 15px; }
#threadList .thread-delete:hover, #threadList .thread-delete:focus-visible { color: var(--vscode-errorForeground, #f48771); background: transparent; }
@media (max-width: 500px) {
  #composerCard { padding: 6px; border-radius: 10px; }
  #composerToolbar { grid-template-columns: 32px auto minmax(48px, 1fr) 82px 32px; gap: 4px; }
  #modeSelect { max-width: 82px; }
  #runtimeStatus { max-width: 140px; }
}
@media (max-width: 260px) {
  .view-header { gap: 4px; }
  button.icon-btn { padding: 2px 5px; min-width: 26px; }
}
@media (prefers-reduced-motion: reduce) {
  button.is-pending::after { animation: none; border-right-color: var(--vscode-progressBar-background, #0e70c0); }
}
</style>
<title>RAME Code</title>
</head>
<body>
<main>
  <div id="chatScreen" class="screen" data-screen="chat">
    <header class="view-header">
      <h2 class="view-title">RAME Code</h2>
      <div class="view-actions" role="toolbar" aria-label="RAME Code actions">
        <button id="newThread" class="icon-btn" type="button" title="New thread" aria-label="New thread">+</button>
        <button id="refresh" class="icon-btn" type="button" title="Refresh history" aria-label="Refresh history">&#x21bb;</button>
        <button id="openSettings" class="icon-btn gear" type="button" title="Open Settings" aria-label="Open Settings">&#x2699;</button>
      </div>
    </header>
    <div id="runIndicator" role="status" aria-live="polite" hidden>
      <span id="runIndicatorDot" aria-hidden="true"></span>
      <span id="runIndicatorText">Working…</span>
    </div>
    <div id="homeSection" aria-label="Thread list">
      <section id="recentSection" aria-labelledby="recent-heading">
        <h3 id="recent-heading">Threads</h3>
        <ul id="threadList"></ul>
      </section>
      <div id="homeCalm" aria-hidden="true"></div>
    </div>
    <div id="conversationSection" hidden>
      <div id="conversationBar">
        <button id="backToList" class="icon-btn" type="button" title="Back to thread list" aria-label="Back to thread list">&#x2190;</button>
        <h2 id="threadTitle">Conversation</h2>
      </div>
      <section id="transcriptSection" aria-labelledby="transcript-heading">
        <h3 id="transcript-heading">Conversation</h3>
        <div id="composerMeta">
          <span id="connection" class="chip" role="status">Checking…</span>
          <span id="workspaceBadge" class="chip" role="status" hidden></span>
        </div>
        <details class="scope-details" id="scopeDetails">
          <summary>Scope / boundaries</summary>
          <p id="scopeNotice" class="hint"></p>
        </details>
        <div id="transcript" aria-live="polite"></div>
        <p id="emptyState" class="hint">No thread yet. Start a new Agent thread below.</p>
      </section>
      <section id="activitySection" aria-labelledby="activity-heading">
        <h3 id="activity-heading">Activity</h3>
        <div id="activityList" aria-live="polite"></div>
      </section>
      <section id="resultSection" class="result-card" aria-labelledby="result-heading" hidden>
        <h3 id="result-heading">Result</h3>
        <p id="resultBody" class="result-body"></p>
      </section>
      <section id="escalationBox" aria-labelledby="escalation-heading" hidden>
        <h3 id="escalation-heading">Cloud escalation</h3>
        <p id="escalationReason" class="hint"></p>
        <div class="row">
          <button id="escalateApprove" type="button">Send this request to Meta</button>
          <button id="escalateDismiss" type="button">Dismiss</button>
        </div>
      </section>
      <section id="agentBox" role="dialog" aria-modal="false" aria-labelledby="agent-pending-heading" hidden>
        <h3 id="agent-pending-heading">Pending approval — review exact action</h3>
        <p id="pendingTool" class="hint"></p>
        <p id="pendingTargets" class="hint"></p>
        <p id="pendingBody" class="hint"></p>
        <p id="pendingMeta" class="hint"></p>
        <div class="row">
          <button id="pendingApprove" type="button">Approve action</button>
          <button id="pendingReject" type="button">Reject</button>
        </div>
      </section>
      <details id="runDetails">
        <summary>Run details</summary>
        <p id="runtimeState" role="status"></p>
        <p id="status" role="status">Starting…</p>
        <p id="usage" class="hint" aria-live="polite"></p>
        <section id="actionLogBox" aria-labelledby="action-log-heading">
          <h3 id="action-log-heading">Action log</h3>
          <ul id="actionLog"></ul>
        </section>
      </details>
    </div>
    <footer id="composer-wrap">
      <div id="composerCard">
        <label for="composer">Message</label>
        <textarea id="composer" rows="3" placeholder="Describe the software goal."></textarea>
        <div id="runtimeNotice" class="composer-notice" role="alert" hidden>
          <span id="runtimeNoticeText"></span>
          <button id="runtimeNoticeSettings" type="button">Open Settings</button>
        </div>
        <p id="permissionWarning" class="hint" role="alert" hidden>Workspace-full is high risk: patches and allowlisted tests run without prompts.</p>
        <div id="composerToolbar" role="toolbar" aria-label="Composer controls">
          <button id="attachBtn" class="icon-btn" type="button" title="Add context (coming later)" aria-label="Add context (coming later)" disabled>+</button>
          <button id="permissionBtn" class="icon-btn" type="button" title="Agent permission" aria-label="Agent permission" aria-haspopup="menu" aria-expanded="false"><span id="permissionChip" class="chip">Ask</span></button>
          <button id="runtimeStatus" class="chip" type="button" title="Open Settings to change runtime" aria-label="Runtime: open Settings to change">Runtime: Meta Model API — Cloud</button>
          <label for="modeSelect">Mode</label>
          <select id="modeSelect" aria-label="Mode">
            <option value="agent" selected>Agent</option>
            <option value="mission">Mission</option>
            <option value="chat">Chat</option>
          </select>
          <button id="send" type="button" title="Send message" aria-label="Send message">&#x2191;</button>
          <button id="cancel" type="button" title="Stop current run" aria-label="Stop current run" hidden>&#x25A0;</button>
        </div>
        <div id="permissionMenu" role="menu" aria-label="Agent permission" hidden>
          <button id="permAsk" type="button" role="menuitemradio" data-profile="ask" aria-checked="true">Ask — every tool action needs approval.</button>
          <button id="permSafe" type="button" role="menuitemradio" data-profile="safe-auto" aria-checked="false">Safe auto — reads run automatically; writes and tests need approval.</button>
          <button id="permFull" type="button" role="menuitemradio" data-profile="workspace-full" aria-checked="false">Workspace full — high risk: reads, patches, and allowlisted tests run without prompts.</button>
        </div>
      </div>
      <div id="agentSection" hidden aria-hidden="true">
        <div class="row" id="agentShieldRow" hidden aria-hidden="true">
          <span id="agentShield" role="img" aria-label="Permission profile">Shield</span>
          <label for="profileSelect" hidden>Permission</label>
          <select id="profileSelect" aria-label="Agent permission profile" hidden tabindex="-1">
            <option value="ask" selected>Ask (safest)</option>
            <option value="safe-auto">Safe auto</option>
            <option value="workspace-full">Workspace full</option>
          </select>
        </div>
        <p id="profileDesc" class="hint" hidden></p>
        <details class="agent-details" id="agentBoundariesDetails" hidden>
          <summary>Security / boundaries</summary>
          <p id="agentBoundaries" class="hint">Agent works only inside the active workspace. Symlink and path escapes are blocked; .git, .env files, credential and key material, secret stores, auth files, and repository control files are protected. Tests run only from an exact derived allowlist with shell:false and no arbitrary shell tool; allowlisted package scripts still execute with your OS permissions and may access files, network, or shells. Ask and Safe-auto require approval before they run, while Workspace-full may run them without prompting and is high risk. Cloud work needs your existing escalation consent and never switches providers silently. Tamper resistance is not claimed.</p>
        </details>
        <p id="agentWarning" role="alert" hidden>Workspace-full is high risk: patches and allowlisted tests run without prompts. First Agent coding validation must target a disposable copy or test fixture, not the live RAME Code repository.</p>
      </div>
    </footer>
  </div>
  <div id="settingsScreen" class="screen" data-screen="settings" hidden>
    <header class="view-header">
      <h2 class="view-title">Settings</h2>
      <div class="view-actions" role="toolbar" aria-label="Settings actions">
        <button id="backToChat" type="button" title="Back to Chat" aria-label="Back to Chat">&#x2190; Back</button>
      </div>
    </header>
    <section class="settings-block" aria-labelledby="runtime-heading">
      <h3 id="runtime-heading">Runtime</h3>
      <label for="runtimeSelect">Runtime</label>
      <select id="runtimeSelect" aria-label="Runtime">
        <option value="cloud" selected>Meta Model API — Cloud</option>
        <option value="local">Muse Glimmer — Local</option>
      </select>
      <p class="hint">One provider only. Change it here; the Chat screen shows a read-only status.</p>
    </section>
    <section class="settings-block" id="cloudSection" aria-labelledby="cloud-heading">
      <h3 id="cloud-heading">Cloud</h3>
      <p id="settingsConnection" role="status">Checking…</p>
      <label for="apiKey">Meta Model API key</label>
      <input id="apiKey" name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Enter a separate Meta Model API key">
      <div class="row">
        <button id="saveKey" type="button">Save key</button>
        <button id="clearKey" type="button">Clear key</button>
      </div>
      <p class="hint">Muse Code subscription credentials are not reused. Sent to the extension host only when you click Save key. Stored only in VS Code SecretStorage; this view only ever learns whether a key exists.</p>
      <h4>Available compatible Meta models</h4>
      <label for="cloudModelSelect">Cloud model</label>
      <select id="cloudModelSelect" aria-label="Cloud model"></select>
      <div class="row">
        <button id="refreshModels" type="button">Refresh available models</button>
      </div>
      <p id="catalogStatus" class="hint" role="status">Fallback catalog. Save a key or refresh to load live models.</p>
      <p class="hint">Only muse-spark and muse-wonder chat models are shown, newest-first as returned. Contributor variants are labeled Contributor (data may be used) and are never selected silently.</p>
    </section>
    <section class="settings-block" id="localSection" aria-labelledby="local-heading">
      <h3 id="local-heading">Local runtime</h3>
      <p id="localStatus" role="status">Local runtime is stopped.</p>
      <label for="exePath">llama-server executable path</label>
      <input id="exePath" type="text" autocomplete="off" spellcheck="false" placeholder="/path/to/llama-server">
      <label for="modelPath">Model path (GGUF)</label>
      <input id="modelPath" type="text" autocomplete="off" spellcheck="false" placeholder="/path/to/model.gguf">
      <label for="projectorPath">Multimodal projector path (optional)</label>
      <input id="projectorPath" type="text" autocomplete="off" spellcheck="false" placeholder="/path/to/mmproj.gguf">
      <label for="draftPath">DFlash / draft-model path (optional)</label>
      <input id="draftPath" type="text" autocomplete="off" spellcheck="false" placeholder="/path/to/draft.gguf">
      <label for="localModelId">Model / display ID</label>
      <input id="localModelId" type="text" autocomplete="off" spellcheck="false" placeholder="local-glimmer">
      <label for="contextSize">Context size</label>
      <input id="contextSize" type="number" min="1024" max="262144" step="1024" value="32768">
      <label for="localPort">Port (loopback only)</label>
      <input id="localPort" type="number" min="1" max="65535" step="1" value="8775">
      <label for="idleTimeout">Idle timeout (seconds, 0 disables)</label>
      <input id="idleTimeout" type="number" min="0" max="86400" step="60" value="600">
      <label for="externalEndpoint">External loopback endpoint (optional, not owned)</label>
      <input id="externalEndpoint" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:8775">
      <div class="row">
        <button id="useSuggestions" type="button">Use detected settings</button>
        <button id="saveLocal" type="button">Save</button>
        <button id="startLocal" type="button">Start Muse Glimmer</button>
        <button id="stopLocal" type="button">Stop</button>
      </div>
      <div class="row">
        <button id="selectExternal" type="button">Use external endpoint</button>
        <button id="clearExternal" type="button">Clear external endpoint</button>
      </div>
      <p class="hint">The server binds to 127.0.0.1 only and is spawned directly with an argument array (no shell). Stopping here stops only the process started by RAME Code.</p>
    </section>
    <section class="settings-block" id="escalationSection" aria-labelledby="escalation-settings-heading">
      <h3 id="escalation-settings-heading">Escalation</h3>
      <label><input id="allowEscalation" type="checkbox"> Allow cloud escalation</label>
      <p class="hint">Default OFF. There is no silent fallback: when local work fails, the Chat screen offers a visible choice and only your explicit approval sends the current request to Meta.</p>
    </section>
    <section class="settings-block" aria-labelledby="privacy-heading">
      <h3 id="privacy-heading">Privacy / Security</h3>
      <p class="hint">The API key stays in VS Code SecretStorage and this view receives only true/false. Chat sends the active thread\u2019s bounded history plus your new message; Mission sends only your new message. Agent may read and change active-workspace files and run allowlisted tests only under the selected permission profile and policy boundary. Meta Billing/Usage is authoritative for cost; token counts below are observed usage, and any dollar figure is an estimate.</p>
    </section>
    <section class="settings-block" aria-labelledby="diagnostics-heading">
      <h3 id="diagnostics-heading">Diagnostics</h3>
      <p id="diagnostics" class="hint" role="status">No diagnostics.</p>
      <p id="settingsStatus" role="status">Starting…</p>
    </section>
  </div>
</main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
