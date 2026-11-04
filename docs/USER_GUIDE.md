# RAME Code user guide

[Official website](https://ramecode.com/) · [Versión en español](USER_GUIDE.es.md) · [README](../README.md) · [How to verify RAME](VERIFICATION.md)

> Practical guide for the unreleased RAME Code 0.2.0 candidate. The public release is still 0.1.0, so some screens described here are available only in candidate builds.

RAME Code is a local-first coding assistant inside VS Code. It can discuss a project, inspect and edit files, run supported tests, preserve approved project decisions, and carry longer goals through a Mission.

Its central rule is simple: **the model proposes; RAME Code's host controls permissions and records what actually happened**. A model reply is not proof that a file changed or a test passed.

## Start here

1. Install the VSIX using the [README instructions](../README.md#installation).
2. Open one folder you are willing to test with. Use a disposable project while RAME Code is a preview.
3. Select the **R** icon in the VS Code Activity Bar.
4. Open **Settings** and choose a runtime under **Models**:
   - **Muse Glimmer — Local** for local inference through `llama-server`.
   - **Meta Model API — Cloud** for a supported Meta model and your own API key.
5. Start with **Agent** and the **Ask** or **Safe auto** permission profile.

Do not start with confidential source code or real personal data. RAME Code 0.2.0 is a validation candidate, not a production security boundary.

## What RAME Code can and cannot do

### It can

- Converse without tools in **Chat only**.
- Inspect a selected workspace folder and propose changes in **Agent**.
- Run supported `package.json` scripts such as `npm:test` or `npm:check` when policy allows them.
- Organize longer work into a persistent **Mission**.
- Ask for approval before relevant actions and keep host-observed facts separate from model text.
- Keep user-approved project decisions across threads and VS Code reloads on the same installation.
- Work locally with Muse Glimmer without sending the request to Meta Model API.
- Optionally use a Meta model after showing the relevant cloud authorization.

### It cannot promise

- That passing tests proves the whole product is correct.
- An operating-system sandbox. Project test scripts run with your VS Code user's permissions.
- Unrestricted shell or computer control.
- Perfect memory or recovery of every old paraphrase.
- Complete functional verification for every language or platform. Autonomous verification currently uses supported Node/npm scripts.
- That a generated executable, installer or plugin works on its target system unless it is tested there.
- Production readiness, tamper-proof logs or complete protection of sensitive data.

## Local Glimmer and Meta cloud models

### Muse Glimmer — Local

RAME Code can start a compatible `llama-server` bound to `127.0.0.1`, or use an existing OpenAI-compatible loopback endpoint. The model files remain on your machine. A local request is not sent to Meta Model API.

“Local” does not mean sandboxed: files and approved tests still use the permissions of VS Code. An external endpoint is shown as **identity not verified**, because RAME cannot prove which weights it serves.

RAME does not need Ollama for its managed local path: it starts the configured `llama-server` executable directly and loads the Glimmer GGUF from disk.

### Model servers: Ollama, LM Studio, llama-server

RAME can also use a model server you run yourself. Open **Settings › Runtime › Model servers**, choose **Ollama (11434)** or **LM Studio (1234)** (or type another address) and press **Find models**. RAME reads only metadata: it tells Ollama, LM Studio and llama-server apart, lists their chat models and shows, for each one, whether it supports tool calls, whether it has vision and the context it is loaded with. Choose one and press **Use this model**: Chat, Agent and Mission then send that model id to that server. RAME never starts, stops or installs the server.

- A model the server says cannot call tools can be used in Chat only; Agent and Mission stop with that reason.
- Agent needs about 16,384 tokens of context. Ollama loads models with its own context length (often 4,096) unless it is started with `OLLAMA_CONTEXT_LENGTH`; in LM Studio, load the model with a larger context.
- A server on another computer of your private network is used only after you tick that prompts, history and project content will be sent there. Write it as a numeric private address (10.x, 172.16–31.x, 192.168.x): host names other than `localhost` are refused, because a name could point to a public address. A public address is always refused. RAME never follows a redirect from a model server. Plain `http` on your network is not encrypted.
- Muse Glimmer: we have not found or tested a Glimmer model for Ollama on Linux or Windows (another project reports an MLX build for Apple silicon only). LM Studio and llama-server serve the Glimmer GGUF; that is what was tested.
- "vision" in the model list means the model can read images. RAME does not send images to models yet: that capability is not used.

### Meta Model API — Cloud

A cloud request leaves your machine and may consume Meta API credits. The API key is stored in VS Code SecretStorage. RAME shows disclosure and authorization controls before eligible local context is sent to Meta.

There are two different cloud paths:

- **Advisory:** Spark gives advice; Glimmer keeps control of tools.
- **Delegated:** Spark proposes tools for one Agent request; RAME still applies the existing permission profile.

RAME never silently changes provider. Mission never turns Advisory permission into Delegated execution.

## Choose the right mode

| Mode | Best for | File access and tools | Typical interaction |
| --- | --- | --- | --- |
| **Chat only** | Questions, brainstorming and explanations without touching the project | None | Natural conversation |
| **Agent** | Interactive inspection, small changes, debugging and tests | Available under the selected profile | You review work as it happens |
| **Mission** | A broader goal requiring several runs, checkpoints and completion criteria | Governed by a Mission-specific grant | You authorize the goal, then monitor, pause or resume it |

### Chat only

Use **Chat only** when you do not want the model to read files or execute tools. It can reason from the text and bounded authorized context, but it cannot inspect the workspace.

### Agent

**Agent** is the recommended default. It can converse normally and use tools only when needed. Reads, writes and tests follow the selected permission profile. Significant actions remain visible in **Activity**, and a final reply includes a host-authored record when tools ran.

Example requests:

```text
Explain how src/calculator.js works. Do not modify anything.
```

```text
Fix the failing calculator test, change only src/calculator.js, run npm:test,
and report the real result.
```

**Web access (optional, default OFF).** In **Settings › Escalation › Web access** you can let Agent search the web (`web_search`, with DuckDuckGo or your own SearXNG) and read public pages (`web_fetch`), read-only. It works only with a local model and never in Mission runs. Each call is shown and, except in Workspace full, waits for your approval. Local and private addresses are refused (also after DNS and on every redirect), a query or URL that contains a key or a file path is not sent, and pages are limited to 2 MiB and 15 s. Page text reaches the model labelled as untrusted data, never as instructions, and cannot write project memory.

```text
Look up how to build a Windows installer with electron-builder in the current
documentation, cite the pages you used, and do not change any file.
```

**Terminal commands (optional, default OFF).** In **Settings › Escalation › Terminal commands** you can let Agent run a shell command line in the project folder (`run_command`: bash or sh, PowerShell on Windows), for example to install a dependency, build, run a script or use git. This is the most powerful tool and the least bounded one: the command runs with your permissions and can change any file, use the network or install software; there is no sandbox. So it works only with a local model and never in Mission runs, you see each command in full before it runs and approve it in every profile (Workspace full included; the card also warns when a line chains commands, runs a script you cannot see, uses sudo or the network, or installs software, but a command line never shows all its effects), and it has a time limit (120 s by default, at most 600 s) and bounded output. **Stop** signals the command and its normal process group, but a deliberately detached process may survive. A few commands that can only destroy (wiping the root or home folder, formatting a disk, a fork bomb, shutting down) are refused. The other tools stay the safer choice: `run_tests` runs only scripts of `package.json` derived exactly, without a shell, and the file tools check every path.

> **Warning about Workspace full and the terminal.** Workspace full lets patches and allowlisted tests run without asking, but it never does that for terminal commands: each `run_command` still waits for your approval. No change of profile or model authorizes a command silently: turning the terminal on is a separate setting, and it only applies to a local model. A single command line can change files outside the project, install software or reach the internet. Chained commands (`&&`, `;`, pipes), `$(...)`, scripts (`./setup.sh`, `npm run …`, `python tool.py`) and installers can do much more than the line shows: the card warns about them, but read the line and approve only what you understand.

#### When Meta Cloud is selected in Agent

The selected runtime, not the green connection indicators, decides which model receives the request. If **Meta Model API — Cloud (`muse-spark-1.3`)** is selected, Spark still directs Agent even when the header also says that Glimmer local is connected. RAME then shows **Review what would be sent to Meta** before eligible local context leaves the machine. The extra checkbox controls whether Meta may also receive the results of tools Spark asks RAME to run — file contents, searches and test output — for that thread, processing class, credential revision and VS Code session; recognised secret-like values are redacted by patterns, which cannot catch every sensitive value.

- **Checkbox selected:** allow those redacted tool results to reach Meta under the displayed conditions.
- **Checkbox clear:** tools may still run under the local permission profile, but their results are replaced before the next request to Meta.
- **Send with this context:** send the newly displayed context as well as material already authorized under the same conditions.
- **Send without it:** keep the newly offered context local; Meta can still receive the current request, its earlier replies and material authorized previously under the same conditions.
- **Cancel:** send no request.

`web_search`, `web_fetch` and `run_command` are local-model-only tools and are not offered to Spark. To test web or terminal access, cancel the cloud disclosure, select a local Glimmer/Ollama/LM Studio runtime, confirm that local inference responds, enable the tool explicitly and repeat the Agent request. A future interface revision should explain this model/tool mismatch before opening an unrelated cloud disclosure card.

On 2026-11-04, candidate build `e383ea4.src.48ae3cd77018` completed two real Chat-only inferences with `muse-spark-1.3`; RAME recorded consent, provider, model, observed responses and token usage. This validates the direct Meta Chat connection only. The complete disclosure/failure matrix remains covered by the simulated Meta recorder, and cloud Agent tool results, Delegated, Mission planning and Advisory still require separate real-provider validation.

### Mission

Use **Mission** when the result needs more than one model turn: creating a small application, completing related tasks, repeatedly testing after changes, or continuing after a reload.

Mission works through bounded internal runs. RAME saves checkpoints and can start the next run without requiring you to type “continue”. Safety limits still exist: repeated runs without host-observed progress stop as **blocked**, rather than running forever.

In plain language, **Agent** is like programming with Glimmer step by step. **Mission** is like assigning a broader outcome with boundaries and checks. Mission can continue across internal runs, but it pauses or stops when it needs new authorization, encounters an uncertain action, or cannot make verifiable progress.

## Mission, step by step

### 1. Describe the outcome

Select **Mission** and state the goal, restrictions and an objective way to check it:

```text
Correct add in src/calculator.js. Do not modify package.json or test/.
Run npm:test. The work is complete only when npm:check also passes after the last change.
```

RAME asks the selected model for a bounded plan. A plan is not yet permission to edit anything.

### 2. Choose Standard or Verified Mission

- **Standard Mission:** the project's normal supported tests determine when each task is done.
- **Verified Mission:** you additionally choose an acceptance command and the files that define it. RAME hashes those files and runs the command itself before completion.

A Verified Mission provides a stronger finish line that the host checks itself, but it is only as good as the acceptance test you choose.

### 3. Choose the permission

- **Supervised: every write and test asks:** RAME presents approval cards as work progresses.
- **Autonomous workspace: edits and allowlisted tests run without asking:** permitted edits and tests can run under one Mission grant.

Autonomous workspace requires **I trust this project**. This trust is limited to that Mission, folder, local provider and model. It is not an operating-system sandbox. Test scripts can reach files, the network or other processes with your user permissions.

For a prepared project, this can be one initial authorization covering the permitted writes and checks for that specific Mission. It is never a general authorization for other folders or operations on the computer. An empty-folder Mission still uses two authorizations: one for the scaffold and a second one, after your review, for implementation and verification.

RAME still protects selected paths and asks again for operations outside the grant, such as deleting, moving files or changing project memory. A changed `package.json` also invalidates the previously allowed test setup.

### 4. Optionally configure a Meta Advisory budget

A Mission can receive an explicit allowance of between 0 and 5 Meta consultations. Advanced controls also limit bytes per request, total bytes, output tokens per answer and the total remote token budget. These limits are fixed when you grant the authorization.

For example:

| Setting | Example |
| --- | --- |
| Primary model | Local Glimmer |
| Meta consultations | Up to 3 |
| Tool control | Glimmer |
| Cost and data | Explicit byte and token limits |

Mission asks for advice only for an open, reproducible blocker. Spark receives no tools and cannot declare the blocker recovered. Glimmer applies any authorized correction, and the host must rerun the original verifier under the recorded conditions before normal Mission work can continue. Cancelling before a request is sent does not consume a consultation; once sent, the attempt counts even if the remote request fails. Exhausting the allowance never triggers an automatic retry.

### 5. Understand acceptance

An **acceptance check** is an allowlisted `package.json` script such as `npm:check`. The selected files define what it checks. When you authorize a Verified Mission, RAME freezes their hashes.

After freezing:

- RAME's tools cannot silently rewrite those acceptance files.
- If a frozen file changes, the Mission is blocked.
- The host runs the acceptance command before completion.
- A model cannot replace a failing result with a written claim of success.

A green check proves only what that check covers. A weak test can miss broken behavior, usability problems, platform incompatibility or security defects.

**What the check uses is protected too.** Before authorizing, RAME runs the check once and watches which processes it runs and which files it loads and reads. Test helpers, data and the test files the command runs are frozen with it, and the test folders it runs or lists are sealed: nothing can be added there. RAME also records every other file of the project. If anything else the check uses would stay writable, for example the code under test, a dialog lists it and asks you to confirm. Cancel if a listed file is really part of the test, such as expected values, and add it to the acceptance files. If RAME cannot tell what the check depends on, it does not offer a protected check; use a Standard Mission instead.

**Protected or reinforced.** A protected check is decided by its exit code. Code under test runs in the same process and could end it early, so for stronger evidence add a `*.rame-cases.json` file to the acceptance files:

```json
{ "rameCases": 1, "module": "src/calculator.js",
  "cases": [ { "call": "add", "args": [19, 23], "expect": 42 } ] }
```

RAME then calls those functions in a separate process and compares the results itself; the expected values are never sent to that process, and RAME's tools do not show them to the agent. An early exit or a fake "all passed" message cannot pass. The Mission report states which level was reached and the Node version the check ran on. The values are not secret: code running with your permissions can still read the file, so keep the cases varied.

**Not verifiable.** After each run of the check, RAME compares the project with what it recorded when you authorized. If a file the check uses changed (on Linux and macOS, even if it was restored before the end), a file appeared in a sealed folder, an existing data or document file changed, or RAME saw the check use something outside the scope you approved, the Mission stops as **not verifiable**: it is not counted as a pass, and your acceptance stays as you authorized it. If only other code changed, RAME shows the files and asks you (a scope review); approve them only if they are code under test, not tests or expected values. See [How to verify it](VERIFICATION.md).

### 6. Authorize and follow progress

Review the goal, verification level, permission and optional Meta Advisory grant. Select **Authorize and start** only when they match your intention.

During the Mission, inspect:

- **Activity:** tool proposals and host actions.
- **Host record:** concise facts written by RAME, not by the model.
- **Run details → Model evidence — recorded by RAME Code:** which provider answered, how a tool proposal was handled and which later checks were observed.
- **Mission → Evidence:** checkpoints, tests and acceptance state.

“Checked afterwards” describes order, not proof that one action caused the result.

### 7. Pause, resume or recover after a reload

Mission state and checkpoints persist. Closing or reloading VS Code does not automatically repeat an action whose outcome is unknown. Reopen the Mission thread and use **Resume** when necessary. Review the workspace if RAME reports an interrupted or uncertain action.

**Cancel Mission** is final. **Pause** stops current work until you resume it.

### 8. Completion and blocked Missions

RAME completes a Mission only after its host-observed completion conditions pass after the last relevant change. A Verified Mission must also pass its frozen acceptance check.

If several runs make no verifiable progress, the Mission becomes **blocked**. Read the blocker and evidence, then use **Retry with guidance**, start a new authorized verification flow, or cancel. Do not merely accept the model's last explanation.

## Starting in an empty folder

The 0.2.0 candidate supports a two-authorization bootstrap Mission:

1. The first authorization may create the initial project, `package.json`, scripts and tests.
2. It cannot run those new tests or complete the Mission.
3. RAME revokes that bootstrap grant and stops at **Scaffold ready**.
4. You inspect the generated scripts and tests.
5. A second authorization selects Standard or Verified Mission and, for Verified Mission, freezes the chosen acceptance files.
6. Only then may implementation and verification continue.

This prevents a model from creating its own easy test and silently using it as the final authority.

### Experimental optional Spark review

The current working candidate contains an optional independent acceptance review at **Scaffold ready**. It has automated coverage with a simulated Meta API, but has not yet completed real Meta and full human-interface validation. Treat it as experimental until that validation is recorded.

RAME first shows the exact bounded requirement and selected test fragments. A separate one-use authorization sends them to a documented **Standard** Meta model. Spark receives no tools and cannot edit, approve, freeze or complete anything. Its structured observations are untrusted advice; you may consider or dismiss them before making the second local authorization.

Cancellation, malformed output, API failure or an exhausted budget leaves the local path available and never retries automatically.

## Practical example: a WAV player for Windows

Goal:

> Create a WAV player for Windows with a graphical interface, an executable and an installer.

### With Agent

Agent is useful for exploring or building one part at a time:

1. Ask it to inspect the empty or existing project.
2. Choose the language and GUI toolkit yourself.
3. Approve creation of source files.
4. Ask for unit tests and run them.
5. Ask for packaging configuration.
6. Review every artifact and test it on Windows.

This is interactive and offers close control, but you must keep driving the sequence.

### With Mission

Mission is normally more suitable for the full outcome:

```text
Build a small Windows WAV player with play, pause, stop and file selection.
Keep the audio and interface logic testable. Add supported automated checks and
packaging configuration. Do not claim the executable or installer works unless
it is actually built and tested in a compatible Windows environment.
```

Use a Verified Mission only when a meaningful supported acceptance command exists or after the bootstrap checkpoint lets you review one.

Static tests can verify source structure and some logic, but they do not prove that audio playback, the `.exe`, installer permissions, shortcuts or uninstall behavior work on Windows. Those require building and testing on Windows with the necessary toolchain.

## More examples

### Extend RAME Code with native Ollama integration

RAME can work on its own repository like any other project when you deliberately open it as the VS Code workspace. It needs no special capability to write and test a new integration. Use Agent to explore the change interactively; Mission is usually better for coordinating provider settings, model selection, backward compatibility and tests.

A cautious assignment would be:

```text
Add optional native Ollama integration without breaking the managed Muse Glimmer
path through llama-server. Detect an explicit loopback endpoint, allow explicit
model discovery and selection, and add tests that distinguish a RAME-managed
runtime from an external endpoint that RAME must never stop. Keep llama-server
as an option, and do not download or execute anything outside the authorized scope.
```

RAME can modify the source and run permitted checks. That does not mean it should silently replace the extension that is running the Mission. Build the candidate afterwards, install it deliberately, validate it in another VS Code profile or session, and retain a manual path back to the previous version.

### Build an alternative Windows taskbar and Start menu

RAME can attempt to develop an application with a Windows 10-style interface for Windows 11. Treating it as an alternative desktop application is safer than presenting it as a replacement for internal Windows components.

Because the goal is broad, divide it into several Missions: visual prototype and navigation; application launch and search; window and system-tray integration; then packaging, sign-in startup and uninstall. Every phase should preserve a verifiable way back to the normal desktop.

Static checks on another operating system do not prove that the taskbar, Start menu, focus handling, windows, installer or restoration work. Final validation must run on Windows, preferably first in a virtual machine or test account, without replacing or deleting the system shell.

### Correct an existing bug

Use **Agent** for a focused change:

```text
Reproduce the failing test first. Fix only the date parser, run npm:test,
and report the files changed and the real exit code.
```

Use **Mission** if the bug spans several components or needs repeated verification.

### Create a WordPress plugin

Agent can create PHP, JavaScript and CSS files inside the selected folder. Mission can organize the work if the project exposes supported npm scripts for static checks or tests.

RAME 0.2.0 does not provide a complete PHP or WordPress runtime verifier. An npm script that inspects PHP proves only what that script checks; it does not prove installation, hooks, database behavior or compatibility with a real WordPress site.

### Create an application from an empty folder

Use a bootstrap Mission. Let the first authorization create the scaffold, stop at **Scaffold ready**, then examine the generated scripts and tests before the second authorization.

### Continue after restarting VS Code

Open the saved Mission thread, inspect its state and evidence, and select **Resume** if offered. RAME continues from host checkpoints and does not replay every internal conversation or automatically repeat an uncertain action.

### Use persistent project memory

Tell Agent a durable rule:

```text
For this project, supported Node versions start at Node 22.
```

If the model identifies it as durable, RAME presents an approval card. Only your approval saves it. Future Agent and Mission runs for that workspace root automatically receive the current approved decision. Repository text and model replies cannot change project memory by themselves.

The **Project memory** settings card is primarily an inspector. In a multi-root VS Code window, **Folder** selects which open folder's memory you are viewing; it does not merge memories or grant access.

### Use Meta Spark Advisory

Enable cloud escalation in **Security**, configure a Standard Meta model and review the exact authorization. Choose the maximum number of consultations and, if you need stricter bounds, open the advanced byte and token limits. Advisory gives Glimmer a second opinion but leaves tools under Glimmer and RAME's permission checks. No Spark reply can complete a Mission or recover the blocker that caused the consultation; the original verifier must pass.

## Security and privacy in plain language

### Why does RAME ask for permission?

Reading, writing, running tests and sending information to a cloud model have different consequences. RAME keeps them separate so a model cannot grant itself more authority merely by asking for it in text.

Approvals are normally bound to the exact action, project, thread, provider and relevant file state. If those conditions change, an old approval should not be reused.

### Standard and Contributor models

RAME treats Meta's documented Standard and Contributor classes separately. Under Meta's terms, Contributor variants may use submitted data differently. Consent for a Standard model is not automatically reused for a Contributor model. Undocumented model identifiers form their own conservative class.

Always read Meta's current terms before sharing data.

### What can leave the computer?

- Requests made directly with **Meta Model API — Cloud**.
- Context you explicitly approve in a cloud disclosure card.
- Selected content in an approved Advisory or independent acceptance review.
- Tool results only when the relevant Agent disclosure permits them.

RAME does not automatically send the whole repository. It applies bounds and pattern-based redaction, but redaction cannot recognize every secret or private fact. Do not use real credentials, personal data or confidential code in current validation tests.

### Who controls what?

- **Glimmer or Spark:** proposes text, code, tools or advice.
- **You:** choose permissions, cloud disclosure and durable decisions.
- **RAME host:** validates actions, performs allowed operations, freezes acceptance and records observed results.

These controls reduce risk; they do not make VS Code, dependencies or test scripts untrusted-code sandboxes.

## Frequently asked questions

### Can Agent create a complete project?

It can create many project files interactively, subject to permissions and the available toolchain. A broad multi-stage objective is usually easier with Mission.

### Can RAME modify its own code?

Yes, when you deliberately open the RAME repository as the project. Agent can make interactive changes and Mission can coordinate a larger extension with tests. The extension directing that work remains the version currently installed: building and installing a new candidate is a later, deliberate step that should be validated in another VS Code profile or session.

### When should I use Mission?

Use it for several related tasks, autonomous continuation, checkpoints or an explicit finish condition. Use Agent for small or highly interactive changes.

### Does Mission work in an empty folder?

Yes, in the 0.2.0 candidate through the two-authorization bootstrap flow. Review the generated scripts and tests at **Scaffold ready** before continuing.

### Must I write the tests myself?

No. The model can propose them, but you decide whether they represent the requirement. Independent tests supplied by you provide stronger evidence.

### Can RAME declare success without checking anything?

A Mission requires host-observed checks according to its configured level. A Verified Mission must also pass its frozen acceptance command. Checks may still be incomplete, so “passed” is not the same as “perfect”.

### Can it work without Meta cloud access?

Yes. Muse Glimmer can run locally through `llama-server`; cloud escalation is optional and off by default. You need the local model, compatible server and sufficient hardware.

### What if I reject a permission?

That action does not run. The model may choose a different safe approach, ask for clarification or stop. Rejecting one action does not grant a broader alternative.

### What happens if I close VS Code?

Threads, project memory and Mission state persist locally. A reload does not automatically repeat uncertain work. Reopen the thread, inspect its state and resume when appropriate.

### Can it build a Windows installer?

It can write source and packaging configuration and may run available compatible tools. A reliable claim that the installer works requires building and exercising it on Windows under the intended conditions.

### What should I do when a Mission is blocked?

Read the blocker, Activity, host record and evidence. Check whether the verifier still exists and whether frozen files changed. Then retry with precise guidance, create a new authorized verification flow, or cancel. Do not weaken tests merely to obtain green output.

### Is Model evidence a tamper-proof audit log?

No. It is a bounded local provenance record written by RAME's host. It helps distinguish model claims, host actions and later checks, but is not cryptographic proof of model identity or an immutable external audit.

## Before relying on a result

- Check the selected folder and provider.
- Read every requested permission.
- Confirm whether Meta will receive anything.
- Inspect changed files instead of relying only on the summary.
- Read the **Host record** and **Model evidence**.
- Confirm the exact test command and exit code.
- Test platform-specific artifacts on their target platform.
- Keep backups and version control.

For technical details, see [ARCHITECTURE.md](../ARCHITECTURE.md). For release-specific changes and limitations, see the [Changelog](../CHANGELOG.md).
