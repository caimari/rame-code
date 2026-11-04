/** Markup of the local runtime, the external model servers and web access settings. */

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
      </section>
`;

export const webAccessHtml = `
      <section class="settings-block" id="webAccessSection" aria-labelledby="web-access-heading">
        <h3 id="web-access-heading">Web access</h3>
        <label><input id="webEnabled" type="checkbox"> Allow Agent to search and read public web pages (read-only)</label>
        <label for="webSearchEngine">Search with</label>
        <select id="webSearchEngine"><option value="duckduckgo">DuckDuckGo (no key)</option><option value="searxng">My SearXNG</option></select>
        <label for="webSearxngUrl">SearXNG address (JSON format enabled)</label>
        <input id="webSearxngUrl" type="text" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:8888">
        <div class="row"><button id="webSave" type="button">Save web access</button></div>
        <p class="hint">Default OFF. Only with a local model, and never in Mission runs. Each search or page read is shown and, except in Workspace full, waits for your approval. Local and private addresses are refused, and a query or URL with a key or a file path is not sent. Page text is untrusted data, never instructions.</p>
      </section>
      <section class="settings-block" id="shellAccessSection" aria-labelledby="shell-access-heading">
        <h3 id="shell-access-heading">Terminal commands</h3>
        <label><input id="shellEnabled" type="checkbox"> Allow Agent to run terminal commands (bash, sh or PowerShell) in the project folder</label>
        <div class="row"><button id="shellSave" type="button">Save terminal access</button></div>
        <p class="hint">Default OFF. Only with a local model, and never in Mission runs. You see each command exactly before it runs and approve it, in every profile, Workspace full included. The card warns when a line chains commands, runs a script you cannot see, uses sudo or the network, or installs software, but a command line never shows all its effects. A command runs with your permissions: it can change any file, use the network or install software. There is no sandbox. Time and output are limited. Stop signals the command and its normal process group, but a deliberately detached process may survive.</p>
      </section>
`;
