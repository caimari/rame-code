/**
 * Settings → Security: the advisor model (beside Escalation) and the
 * isolation level shared by commands, tests, long jobs and installs. Rendered and wired by
 * media/advisorUx.js (advisor) and media/localServersUx.js (isolation);
 * text only, every value comes from the host.
 */

export const advisorHtml = `
      <section class="settings-block" id="advisorSection" aria-labelledby="advisor-heading">
        <h3 id="advisor-heading">Advisor model</h3>
        <p id="advisorMain" class="hint" role="status"></p>
        <label for="advisorModelSelect">Model the main model may consult when it is stuck</label>
        <select id="advisorModelSelect" aria-label="Advisor model"></select>
        <p id="advisorStatus" class="hint" role="status"></p>
        <p class="hint">The main model (chosen in Models) does the work and keeps every tool. The advisor only answers in text: it never gets tools and never takes over. Only a Meta model that Meta's documentation describes as more capable than the main model can be chosen, never the main model itself; when there is none, the main model works without consultations. Every consultation keeps its card, pre-authorization or Full Access, its budget and its data limits.</p>
      </section>`;

export const isolationHtml = `
        <label for="shellIsolation">What local processes may do (isolation, the same in every autonomy mode)</label>
        <select id="shellIsolation">
          <option value="project">Project (default): write only in the project, temporary and package-cache folders; network allowed</option>
          <option value="closed">Closed: like Project, and no network</option>
          <option value="total">Total: no isolation, local processes run with your permissions</option>
        </select>
        <p id="shellIsolationStatus" class="hint" role="status"></p>`;
