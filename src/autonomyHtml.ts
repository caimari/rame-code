/**
 * Markup of Autonomy & Permissions (Settings → Security) and of its part of
 * a Mission's authorization card. Rendered and wired by media/autonomyUx.js;
 * every value shown comes from the host.
 */

const hoursOptions = (selected: number, week: boolean): string =>
  [[1, '1 hour'], [8, '8 hours'], [24, '24 hours'], ...(week ? [[168, '7 days'], [720, '30 days']] : [])]
    .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`)
    .join('');

export const autonomyHtml = `
      <section class="settings-block" id="autonomySection" aria-labelledby="autonomy-heading">
        <h3 id="autonomy-heading">Autonomy &amp; Permissions</h3>
        <p id="autonomyProject" class="hint" role="status"></p>
        <p id="autonomyEnv" class="hint" role="status"></p>
        <fieldset id="autonomyModeRow">
          <legend>Mode for this workspace on this computer or server</legend>
          <label><input type="radio" name="autonomyMode" id="autonomyAsk" value="ask"> Ask always (default): each Meta consultation and each action that needs an authorization shows its card</label>
          <label><input type="radio" name="autonomyMode" id="autonomySupervised" value="supervised"> Supervised autonomy: some external requests run without repeating the card, only within the permissions you give below</label>
          <label><input type="radio" name="autonomyMode" id="autonomyFullMode" value="full"> Full Access: RAME works without authorization cards for the parts you choose, until you revoke it (separate from the Agent profile: Workspace full never turns it on)</label>
        </fieldset>
        <fieldset id="autonomyFullRow" hidden>
          <legend>Full Access</legend>
          <p id="autonomyFullNow" class="hint" role="status"></p>
          <label><input type="checkbox" id="autonomyFullFiles" checked> Workspace files: read, create, change, move and delete (protected files and the acceptance check stay refused)</label>
          <label><input type="checkbox" id="autonomyFullTests" checked> Allowlisted tests</label>
          <label><input type="checkbox" id="autonomyFullCommands"> Terminal commands (with the isolation level of Terminal commands; privilege elevation still asks)</label>
          <label><input type="checkbox" id="autonomyFullInstalls"> Installs without administrator rights (downloads from the package registry)</label>
          <label><input type="checkbox" id="autonomyFullJobs"> Long jobs</label>
          <label><input type="checkbox" id="autonomyFullWeb"> Web searches and page reads (read-only)</label>
          <label><input type="checkbox" id="autonomyFullMeta"> Meta: when the main model cannot finish, consult Meta without cards (Agent, blocked Missions, the acceptance review)</label>
          <div id="autonomyFullMetaRow" class="row">
            <label for="autonomyFullMetaMax">Consultations per Mission or conversation</label>
            <select id="autonomyFullMetaMax"><option value="1">1</option><option value="5">5</option><option value="10">10</option><option value="100">100</option><option value="1000">1000</option><option value="-1" selected>No count limit</option></select>
            <label for="autonomyFullMetaBudget">Remote tokens in total, at most</label>
            <select id="autonomyFullMetaBudget"><option value="0">No total (each consultation's limits)</option><option value="100000">100000</option><option value="1000000" selected>1000000</option><option value="10000000">10000000</option></select>
            <label for="autonomyFullMetaScope">What Meta may receive</label>
            <select id="autonomyFullMetaScope"><option value="files" selected>Instructions, the host's notes and test fragments you choose</option><option value="instructions">Only instructions and the host's notes</option></select>
          </div>
          <label><input type="checkbox" id="autonomyFullMetaMain"> Meta as the main model: Agent sends your requests and the results of its tools (files it reads, test and command output, web pages) to the selected Meta model without the card that asks each time. Only this choice allows it; the parts above authorize local tools only. Billed by Meta.</label>
          <label for="autonomyFullHours">Valid for</label>
          <select id="autonomyFullHours"><option value="0" selected>Until you turn it off</option>${hoursOptions(0, true)}</select>
          <div class="row"><button id="autonomyFullGrant" type="button">Turn on Full Access…</button><button id="autonomyFullRevoke" type="button">Turn off Full Access</button></div>
          <p class="hint">A confirmation lists what RAME may then do, where it runs, what can leave this computer and what may cost money. Never bypassed: your operating system's and providers' permissions, project memory (always a card), the Mission authorization card, the verifier's files and each tool's limits. With its Meta part, Meta is pre-authorized in the same confirmation (the selected model and key, these limits) and revoked with Full Access.</p>
        </fieldset>
        <div id="autonomyGrants" hidden>
          <fieldset id="autonomyMetaRow">
            <legend>Meta consultations (the advisor model) in Missions</legend>
            <p id="autonomyMetaNow" class="hint" role="status"></p>
            <label for="autonomyMetaMax">Consultations per Mission, at most</label>
            <select id="autonomyMetaMax"><option value="1" selected>1</option><option value="5">5</option><option value="10">10</option><option value="100">100</option><option value="1000">1000</option><option value="-1">No count limit</option></select>
            <label for="autonomyMetaBudget">Remote tokens for all Missions together, at most</label>
            <select id="autonomyMetaBudget"><option value="0" selected>No total (each Mission's limits)</option><option value="100000">100000</option><option value="1000000">1000000</option><option value="10000000">10000000</option></select>
            <label for="autonomyMetaHours">Valid for</label>
            <select id="autonomyMetaHours">${hoursOptions(8, true)}</select>
            <label for="autonomyMetaScope">What Meta may receive</label>
            <select id="autonomyMetaScope"><option value="instructions" selected>Only the Mission instructions and the host's notes</option><option value="files">Also files or fragments chosen on each Mission's card</option></select>
            <div class="row"><button id="autonomyMetaGrant" type="button">Pre-authorize Meta…</button><button id="autonomyMetaRevoke" type="button">Revoke</button></div>
            <p class="hint">Off by default. A confirmation shows what leaves this computer, to which provider and model, that it may be billed, the limits and how long it lasts. No count limit never means more data or no limits: each consultation keeps its byte and token limits, and each Mission its totals. RAME has no Meta price list, so the budget is in tokens. Each Mission's card still chooses 0 to this limit (0 by default). Never sent automatically: secrets, credentials, the verifier's hidden files, seeds, protected records, web pages. RAME never switches the main model of a Mission.</p>
          </fieldset>
          <fieldset id="autonomyWebRow">
            <legend>Internet</legend>
            <p id="autonomySessionNow" class="hint" role="status"></p>
            <label for="autonomyWebSearches">Agent and Chat, every window of this workspace: searches without a card, at most</label>
            <input id="autonomyWebSearches" type="number" min="0" max="20" step="1" value="5">
            <label for="autonomyWebFetches">Page reads without a card, at most</label>
            <input id="autonomyWebFetches" type="number" min="0" max="40" step="1" value="10">
            <label for="autonomyWebDomains">Only these domains for page reads (optional; otherwise only pages your searches found)</label>
            <input id="autonomyWebDomains" type="text" autocomplete="off" spellcheck="false" placeholder="nodejs.org, docs.python.org">
            <label for="autonomyWebHours">Valid for</label>
            <select id="autonomyWebHours">${hoursOptions(1, true)}</select>
            <div class="row"><button id="autonomyWebGrant" type="button">Pre-authorize web searches…</button><button id="autonomyWebRevoke" type="button">Revoke</button></div>
            <p id="autonomyMissionWebNow" class="hint" role="status"></p>
            <label for="autonomyMissionWebHours">Autonomous Missions may be given a web budget, valid for</label>
            <select id="autonomyMissionWebHours">${hoursOptions(8, true)}</select>
            <div class="row"><button id="autonomyMissionWebGrant" type="button">Pre-authorize web for Missions…</button><button id="autonomyMissionWebRevoke" type="button">Revoke</button></div>
            <p class="hint">Separate from Meta. Only the query or the address leaves this computer: never a file, a key or private information, and a query that is not plain words shows its card. These tools only read (GET): publishing or changing data is not possible through them and keeps needing its own permission.</p>
          </fieldset>
        </div>
        <div class="row"><button id="autonomyRevokeAll" type="button">Revoke all and stop what runs under them</button></div>
        <details id="autonomyHistory">
          <summary>External requests (history)</summary>
          <p class="hint">Recorded before each request leaves: provider, destination, date, reason, what was sent and how it was approved.</p>
          <ol id="autonomyLog"></ol>
        </details>
      </section>
`;

export const missionAutonomyHtml = `
      <fieldset id="missionAutonomyRow">
            <legend>Autonomy &amp; Permissions</legend>
            <p id="missionAutonomyNote" class="hint" role="status"></p>
            <div id="missionMetaFilesRow" hidden>
              <label for="missionMetaFiles">Files or fragments Meta may receive with each consultation (optional, at most 3; path or path:10-80)</label>
              <input id="missionMetaFiles" type="text" autocomplete="off" spellcheck="false" placeholder="src/checksum.js, src/util.js:1-80">
            </div>
            <div class="row"><button id="missionAutonomyOpen" type="button">Autonomy &amp; Permissions…</button></div>
          </fieldset>
`;
