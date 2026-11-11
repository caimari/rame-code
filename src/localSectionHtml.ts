/** Markup of the local runtime, the external model servers and web access settings. */

import { autonomyHtml, missionAutonomyHtml } from './autonomyHtml.js';
import { advisorHtml, isolationHtml } from './advisorHtml.js';

export const localSectionHtml = `
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
        <label for="idleTimeout">Idle timeout (minutes, 0 disables)</label>
        <input id="idleTimeout" type="number" min="0" max="1440" step="1" value="15">
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
        <p class="hint">Bound to 127.0.0.1 and launched without a shell. Closing a terminal does not stop it. Timeout 0 keeps it running while VS Code stays open; reloading or closing VS Code stops RAME Code's server.</p>
        <div class="row">
          <button id="artifactHash" type="button">Compute SHA-256 of the model file</button>
          <button id="artifactHashCancel" type="button" hidden>Cancel</button>
        </div>
        <p id="artifactHashStatus" class="hint" role="status"></p>
        <p class="hint">Reads the GGUF on this computer in blocks; the hash is kept for this session and stops applying if the file changes. It proves the bytes of that file, not what an external server runs.</p>
      </section>
      <section class="settings-block" id="localServersSection" aria-labelledby="local-servers-heading">
        <h3 id="local-servers-heading">Model servers: Ollama, LM Studio, llama-server</h3>
        <p class="hint">Use a model server you run yourself. RAME connects to it and never starts or stops it. LM Studio and llama-server can serve Muse Glimmer.</p>
        <label for="serverEndpoint">Server address</label>
        <input id="serverEndpoint" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:11434">
        <div class="row">
          <button id="serverPresetOllama" type="button">Ollama (11434)</button>
          <button id="serverPresetLmStudio" type="button">LM Studio (1234)</button>
          <button id="serverScan" type="button">Find models</button>
        </div>
        <label for="serverModel">Model</label>
        <select id="serverModel" aria-describedby="serverModelNote"></select>
        <p id="serverModelNote" class="hint" role="status"></p>
        <label id="serverLanRow" hidden><input id="serverLan" type="checkbox"> This server is another computer of my network: send it my prompts, history and project content</label>
        <div class="row"><button id="serverUse" type="button" disabled>Use this model</button></div>
        <p id="serverCurrent" class="hint" role="status"></p>
        <div class="row"><button id="serverIdentityCheck" type="button">Check server identity</button></div>
        <p id="serverIdentity" class="hint" role="status"></p>
      </section>
`;

export const webAccessHtml = `${advisorHtml}
      <section class="settings-block" id="webAccessSection" aria-labelledby="web-access-heading">
        <h3 id="web-access-heading">Web access</h3>
        <label><input id="webEnabled" type="checkbox"> Allow Agent and Chat to search and read public web pages (read-only)</label>
        <label for="webSearchEngine">Search with</label>
        <select id="webSearchEngine"><option value="duckduckgo">DuckDuckGo (no key)</option><option value="searxng">My SearXNG</option></select>
        <label for="webSearxngUrl">SearXNG address (JSON format enabled)</label>
        <input id="webSearxngUrl" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:8888">
        <div class="row"><button id="webSave" type="button">Save web access</button></div>
        <p class="hint">Default OFF. Agent and Chat, with the main model (local or Meta: with Meta, the pages it reads go to Meta as tool results, never into an advisor's consultation); a Mission has its own web permission, chosen when you authorize it. Each search or page read is shown and waits for your approval in Chat and in Agent, whatever the profile, unless Autonomy &amp; Permissions below pre-authorizes it. Local and private addresses are refused, and a query or URL with a key or a file path is not sent. Page text is untrusted data, never instructions.</p>
      </section>
      <section class="settings-block" id="shellAccessSection" aria-labelledby="shell-access-heading">
        <h3 id="shell-access-heading">Terminal commands</h3>
        <label><input id="shellEnabled" type="checkbox"> Allow Agent to run terminal commands (bash, sh or PowerShell) in the project folder</label>${isolationHtml}
        <div class="row"><button id="shellSave" type="button">Save terminal access</button></div>
        <p class="hint">Default OFF. For the main model, local or Meta (with Meta, a command's output goes to Meta), and never in Mission runs. You see each command exactly before it runs and approve it, in every profile, Workspace full included, unless Full Access includes commands. The isolation level also protects allowlisted tests, non-container long jobs and non-administrator installs. Project and Closed fail closed when Linux Landlock cannot be applied; Closed also blocks TCP. Administrator installs remain explicit and open in a VS Code terminal without Landlock. Container jobs keep their own container isolation. Files you can read stay readable, DNS is not blocked, and programs already running keep their rights. Total runs with your permissions. Stop signals the normal process group, but a deliberately detached process may survive.</p>
      </section>
${autonomyHtml}`;

export const missionWebHtml = `
      <fieldset id="missionWebRow">
            <legend>Web access for this Mission</legend>
            <label><input id="missionWebEnabled" type="checkbox"> Allow this Mission to search the web and read pages (read-only)</label>
            <label for="missionWebSearches">Searches, at most</label>
            <input id="missionWebSearches" type="number" min="0" max="20" step="1" value="5">
            <label for="missionWebFetches">Page reads, at most</label>
            <input id="missionWebFetches" type="number" min="0" max="40" step="1" value="10">
            <label for="missionWebDomains">Authorized domains for page reads (optional; for example nodejs.org, docs.python.org)</label>
            <input id="missionWebDomains" type="text" autocomplete="off" spellcheck="false" placeholder="nodejs.org, docs.python.org">
            <p class="hint">Default OFF. Within this budget an autonomous Mission searches and reads without asking each time; a supervised Mission still asks. Queries leave this computer: plain words only, never code, keys or file paths, and the host counts and records every request. Pages are read only from this Mission's own search results, or only from the domains above if you list some. 15 s and 2 MiB per page. Web access adds no write, terminal, memory or file permission. Web text is never put in a consultation of the advisor; with Meta as the Mission's main model, the pages it reads go to Meta as tool results.</p>
          </fieldset>
${missionAutonomyHtml}`;

/**
 * Settings → Models: which Glimmer the local runtime uses, chosen apart from
 * the Meta Model API. The Runtime card then shows only the settings of the
 * source chosen here (localServersUx.js).
 */
export const localSourceChoiceHtml = `
      <section class="settings-block" id="localSourceChoice" aria-labelledby="local-source-heading">
        <h3 id="local-source-heading">Local model (Glimmer)</h3>
        <p class="hint">Used by every local run: Chat, Agent and Mission with the local runtime, and the local side of a Mission that consults Meta. Independent of the Meta Model API key and model.</p>
        <label><input type="radio" name="localSource" id="localSourceManaged" value="managed"> Muse Glimmer on this computer — RAME starts and stops llama-server</label>
        <label><input type="radio" name="localSource" id="localSourceServer" value="server"> Glimmer on a server you run — Ollama, LM Studio or llama-server</label>
        <p id="localSourceNow" class="hint" role="status"></p>
        <div class="row"><button id="localSourceConfigure" type="button">Configure it in Runtime</button></div>
      </section>
`;

/** Settings → Runtime: what is being configured, and where to change it. */
export const localSourceBannerHtml = `
      <p id="localSourceBanner" class="hint" role="status"><span id="localSourceBannerText"></span> <button id="localSourceChange" type="button">Change in Models</button></p>
`;
