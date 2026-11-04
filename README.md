# RAME Code

### Local-First AI Coding Agent for Visual Studio Code

**Muse Glimmer · llama-server · Ollama · LM Studio · Meta Model API**

Build software inside VS Code with local-first inference, user-governed memory, scoped permissions and autonomous Missions whose authorized acceptance is checked by the host.

[Installation](#installation) · [Product pitch](docs/PITCH.md) · [User guide](docs/USER_GUIDE.md) · [**For judges**](docs/JUDGES.md) · [Evidence](evidence/README.md) · [Verification](docs/VERIFICATION.md) · [Public VSIX](https://github.com/caimari/rame-code/releases/latest) · [Website](https://ramecode.com/) · [Español](README.es.md)

**Official website:** [https://ramecode.com/](https://ramecode.com/)

Run Meta Muse Glimmer through RAME's managed loopback `llama-server`, or connect to compatible chat models served by Ollama, LM Studio, another `llama-server` or an OpenAI-compatible server. A server on another computer of the private network requires explicit authorization. The executable and model weights are installed separately; RAME does not bundle them.

Use Meta Model API for direct cloud Chat and Agent with models whose advertised capabilities fit the selected mode. During an authorized local Mission, RAME can request optional, budget-limited advice from Meta Muse Spark after an eligible capability stop while the local model retains tool control. This Advisory route is implemented and covered with a simulated Meta API; only direct Spark Chat has a recorded real-API validation so far.

> **Controlled cloud escalation — default OFF.** Enable **Settings › Security › Escalation › Allow cloud escalation** to make cloud assistance available; there is no silent fallback. After an eligible local Agent stop, RAME offers a visible choice and sends the current request to Meta only after explicit approval. For a local Mission, you separately authorize **0–5 Meta consultations** when starting it and may cap request bytes, total bytes, output tokens per answer and total remote tokens. A consultation supplies bounded advice only: Glimmer keeps tool control, and the Mission's original verifier must pass before the blocker is considered recovered.

**Local inference first. Cloud assistance when authorized. Explicit budgets, persistent decisions and evidence-backed verification.**

> **AI should remember what matters, respect what you decide, and prove what it actually accomplished.**

> **Version status — v0.2.0 experimental preview release.** Download the audited VSIX from the [v0.2.0 release](https://github.com/caimari/rame-code/releases/tag/v0.2.0). This release is suitable for controlled evaluation on disposable projects; it is not a production security boundary.

| Local-first | Meta Model API | Verified Missions | Governed memory |
| --- | --- | --- | --- |
| Managed `llama-server` or an existing Ollama/LM Studio-compatible server | Direct cloud Chat and Agent; bounded optional Mission advice | Autonomous continuation with host-run authorized acceptance | User-approved, versioned decisions and traceable stale evidence |

RAME Code is an independent open-source project started from scratch during the [Meta Global AI Developer Hackathon 2026](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details).

## Understand RAME in 20 seconds

| Capability | What RAME does |
| --- | --- |
| Native VS Code agent | Chat, Agent and Mission run inside a graphical VS Code extension with RAME's own tools, permissions, memory and execution host. It is not only a front end for another coding agent. |
| Local Muse Glimmer | RAME can launch and stop its own loopback `llama-server`; Ollama is not required. Model weights remain on infrastructure chosen by the user. |
| Governed memory | Only the user can authorize a durable project decision. Versions and provenance remain visible, and remembered text never grants tool authority. |
| Causal invalidation | When an approved decision changes, verified artifacts linked to the earlier version can become **STALE** until they are checked again. |
| Verifiable Missions | For Missions with authorized acceptance, the host runs the frozen checks and decides completion; a model's claim is not evidence of success. |
| Exact authority and disclosure | One-use approvals bind the action and its preconditions. Before eligible local context goes to Meta, RAME shows the bounded material and recipient conditions. |

For example, if the approved decision “target Node.js 20” becomes “target Node.js 24”, an installer verified against the earlier decision can be marked **STALE**. RAME preserves the history; it does not silently treat the old evidence as current.

Start with [the claims-to-evidence table](docs/JUDGES.md). It links one supervised local-Glimmer Mission, the reproducible simulated sabotage battery, exact reproduction commands and the limits of every claim. A green check proves only what that check actually covers.

## The v0.2.0 preview release

For the hackathon, development has deliberately prioritised working functionality, explicit authority and reproducible evidence over visual polish. The current interface and logo are provisional. Later releases will refine the information architecture, accessibility, onboarding and visual identity after the core behavior has completed independent and human validation.

Compared with the first public baseline, v0.2.0 adds governed project memory, restartable and host-verified Missions, stronger acceptance integrity, model evidence, Ollama and LM Studio connectivity, optional read-only web access, and an experimental local-Agent terminal. Read the complete, auditable list in the [Changelog](CHANGELOG.md#020---2026-11-04).

## The 0.1.0 baseline

The first release records what was built in the opening days of the project. It established:

- a VS Code extension with Chat, Agent and Mission modes;
- local text inference through a managed `llama-server` and optional Meta Model API access;
- bounded workspace tools, permission profiles and exact one-use approvals;
- persistent threads, cancellation and host-authored action records.

It is a historical research baseline, not the best description of the current release. Its complete capabilities, security work and limitations remain in the [0.1.0 Changelog](CHANGELOG.md#010---2026-11-02).

## Important work still pending

- **Vision in RAME:** Muse Glimmer and its `mmproj` can support images, but the extension does not yet attach images or send multimodal requests to either local Glimmer or Meta cloud models.
- **Meta validation:** three direct Chat-only inferences with Muse Spark 1.3 were validated against the real API. Cloud Agent tool results, Delegated execution, Mission planning and Mission Advisory remain validated only with a simulated Meta recorder.
- **Causal model return:** automatic escalation and a verifier-governed return to the local model remain research work, not a shipped claim.
- **Terminal limitation:** `run_command` is experimental, disabled by default, local-Agent only and excluded from Mission; every command requires approval even in Workspace full. It has no operating-system sandbox, and a deliberately detached process may survive Stop.
- **Distribution:** v0.2.0 is distributed as a GitHub Release VSIX. Visual Studio Marketplace publication comes later.
- **Platforms and interface:** real Windows validation remains pending. The current interface and logo are functional prototypes that will be redesigned and polished in later releases.
- **Security boundary:** local execution, approvals and evidence are not claimed to be tamper-proof; approved commands and project scripts run with the VS Code user's operating-system permissions.

Repository content, tool output and model output are treated as untrusted inputs. A model cannot grant itself additional authority. See the [user guide](docs/USER_GUIDE.md) for safe use and the [Changelog](CHANGELOG.md#known-limitations) for the detailed limits.

## Installation

### Build v0.2.0 from GitHub

The tagged source builds an installable `rame-code-0.2.0.vsix`:

```bash
git clone https://github.com/caimari/rame-code.git
cd rame-code
npm ci
npm run package
code --install-extension rame-code-0.2.0.vsix
```

Use Node.js 20 or 24. Review the source commit and generated VSIX before installing; packaging runs the complete automated suite.

### Install the published VSIX

Download `rame-code-0.2.0.vsix` from the [v0.2.0 release](https://github.com/caimari/rame-code/releases/tag/v0.2.0).

### From the VS Code interface

1. Open **Extensions** (`Ctrl+Shift+X`).
2. Open the `...` menu in the Extensions panel.
3. Choose **Install from VSIX...**.
4. Select `rame-code-0.2.0.vsix`.
5. Run **Developer: Reload Window** if VS Code asks you to reload.
6. Select the **R** icon in the Activity Bar.

When using Remote SSH, install the extension in the remote workspace when VS Code offers that target.

### From a terminal

```bash
code --install-extension rame-code-0.2.0.vsix
```

If the `code` command is unavailable on a remote host, use **Install from VSIX...** in the connected VS Code window instead.

## Configure a model

Open RAME Code and select the gear button.

### Meta Model API

1. Select **Meta Model API — Cloud**.
2. Create a key in the [Meta Model API dashboard](https://dev.meta.ai/).
3. Paste the separate API key into RAME Code and choose **Save key**.
4. Refresh the available model catalog and select a supported model.

The key is sent to the extension host only when **Save key** is pressed. It is stored in VS Code SecretStorage; the webview only receives whether a key exists. API usage may consume credits or incur charges on the user's Meta account.

### Muse Glimmer locally

RAME Code can start `llama-server` directly; Ollama is not required.

1. Select **Muse Glimmer — Local**.
2. Configure the `llama-server` executable and Muse Glimmer GGUF path.
3. Optionally configure a multimodal projector or DFlash draft model for the local server.
4. Choose **Save**, then **Start Muse Glimmer**.

The managed server binds to `127.0.0.1`. RAME Code stops only the process it started.

**Model servers (v0.2.0).** RAME can also connect to a server you run yourself: Ollama, LM Studio, another `llama-server` or any OpenAI-compatible server. **Find models** tells them apart, lists their chat models with tool, vision and context information, and a model the server says cannot call tools is limited to Chat. A server on another computer of your private network (a numeric private IP) is used only after you confirm that local work will be sent there; public addresses and host names are refused, and redirects are never followed. "Vision" in the list is the model's capability; RAME does not send images yet. Tested for real with Muse Glimmer 30B on LM Studio (RTX 3090 Ti, over the private network) and with Ollama 0.32.5.

**Optional web access (v0.2.0, default OFF).** With a local model, Agent can use `web_search` and `web_fetch`; this path has one recorded REAL validation with LM Studio on a private LAN, DuckDuckGo and `web_fetch`. Chat web is implemented but experimental and tested only with simulated servers. Mission web is also implemented but experimental: it is authorized separately with search/read budgets and optional domains, and has only simulated-server coverage. Do not present Chat or Mission web as validated against the real internet. Private destinations are refused after DNS and on every redirect, and queries containing recognized keys or file paths are not sent. See the [user guide](docs/USER_GUIDE.md#agent-chat-and-mission-web-access).

**Terminal commands for Agent (v0.2.0, default OFF).** `run_command` runs one shell command line in the project folder with your permissions (no sandbox), local model only and never in Mission runs; each command is shown in full and approved in every profile, Workspace full included, with a time limit and bounded output. **Stop** signals the command and its normal process group, but a deliberately detached process may survive. See the [user guide](docs/USER_GUIDE.md).

Local operation sends requests only to the user-selected local server. Model files are read from user-configured locations and are not included in the extension or this repository. The alternative cloud runtime sends requests to Meta Model API using the user's own API key.

### Tested local Meta Muse stack

The development system has been tested with the following independently supplied files:

| Component | Tested file | Approximate disk size |
| --- | --- | ---: |
| Text model | Muse Glimmer 30B Q4_K_M GGUF | 15.61 GiB |
| Vision projector | Muse Glimmer 30B Q4_K_M `mmproj` GGUF | 1.30 GiB |
| Optional text acceleration | Muse Glimmer 30B Q4_K_M DFlash GGUF | 1.52 GiB |

The RAME Code development machine is equipped with an NVIDIA RTX 5090 and runs Muse Glimmer locally through `llama-server`. The full tested set occupies approximately 18.43 GiB on disk. On this machine, loading the model, projector and DFlash used approximately 21.3 GiB of VRAM; actual memory use depends on the build, context and offload settings.

A recent Muse-Glimmer-compatible build of `llama.cpp` is required. A generic older `llama-server` may not recognize this model or its projector. A minimal standalone launch with vision support looks like:

```bash
llama-server \
  -m /path/to/Muse-Glimmer-30B-Q4_K_M.gguf \
  --mmproj /path/to/mmproj-Muse-Glimmer-30B-Q4_K_M.gguf \
  -ngl 99 \
  -c 32768 \
  --jinja
```

**Vision is not active in the RAME Code v0.2.0 user experience.** The local runtime can be configured to load the separately supplied `mmproj`, and that runtime has been validated independently with images and OCR, but RAME Code does not yet provide image attachment or send multimodal messages. Until that integration is implemented and verified, RAME Code uses this local stack for text-only Agent, Mission and Chat requests.

## Permission profiles

| Profile | Behaviour |
| --- | --- |
| **Ask** | Every tool action waits for approval. This is the default. |
| **Safe auto** | Policy-checked reads run automatically; writes and tests still require approval. |
| **Workspace full** | Allowed workspace actions may run without prompting. Policy checks remain, but this mode is high risk. |

Agent work is restricted to one explicitly selected VS Code workspace folder. The optional `run_command` terminal is a separate, high-risk capability: it is off by default, local-Agent only, excluded from Mission, and always requires approval of the complete command. Test execution through `run_tests` remains limited to commands derived from an allowlist and uses `shell: false`, although the selected package script may still execute arbitrary project code.

## Bootstrap and verified Missions (v0.2.0)

A Mission may start in an empty folder. Its first, explicit bootstrap authorization can create the project scaffold, package scripts and tests, but it cannot run those tests or complete the Mission. RAME then revokes that grant and stops at **Scaffold ready**. The user reviews the new allowlisted command and test files in a second authorization; only that second authorization can freeze acceptance and let the Mission continue.

At that checkpoint, an **optional independent acceptance review** may be prepared for a documented Standard Meta model. Preparing it sends nothing: RAME shows the exact bounded text first, including the original requirement and up to three test fragments selected from the offered acceptance candidates. Sending requires a separate one-use approval bound to the Mission, folder, model, processing class, credential revision, content and byte/token limits. Spark receives no tools and cannot edit files, grant permissions, select or freeze the acceptance criteria, or complete the Mission. Its structured result is untrusted advice that the user may consider or dismiss before making the final local choice. Cancellation, budget refusal, malformed output or an API failure leaves the local two-stage flow available and never retries automatically. This path is verified with a simulated Meta API only in this candidate.

## Acceptance integrity (v0.2.0)

A Mission is verified at one of three levels, and the level is written in its host notes and final report:

- **Conventional (Standard Mission).** An allowlisted project test passes after the last change.
- **Protected (Verified Mission).** The host itself runs the user's frozen acceptance check, observes it to its end and requires exit 0. Before authorizing, RAME runs the check once under its own trace and analyses it, to find the processes it runs and the modules and files it uses, and records that scope in the grant together with a fingerprint of every project file. Test helpers, data and the test files the command runs are frozen, and test folders it runs or lists are sealed. Anything that would stay writable is shown in a modal dialog for you to confirm. A check whose dependencies cannot be determined is not protected: RAME offers conventional verification instead. Writes that would change a frozen file, a sealed folder or how Node resolves them are refused. After every host run, RAME compares the whole project with its own record (the SHA-256 of every file's bytes): a change outside the authorized scope is never counted as a pass. On Linux and macOS, kernel change times also show a file changed and restored during the run; on Windows only the start and end state is claimed, and the report says so.
- **Reinforced.** A protected check plus a frozen `*.rame-cases.json` file. RAME's case runner calls the code under test in a separate process and the host compares every result itself; the expected values are not sent to that process and are hidden from the agent's tools. An early `process.exit(0)` or forged output cannot pass. This does not make the expected values secret: there is no sandbox, and code running with your permissions can find the file on disk. At the protected level, a check is only as trustworthy as its exit code: code under test that runs in the check's own process can end it early.

When RAME cannot show that the authorized conditions held, the result is **not verifiable**: never a pass, the Mission is blocked with the reason and the authorized acceptance stays unchanged.

These guarantees are exercised by a **SIMULATED** sabotage battery (`npm run demo:sabotage`): 44 attempts to complete a Mission without the work, including the reproductions from independent audits. 3 still succeed and are documented as limits:

- a weak check satisfied by constants;
- a helper the user confirmed as writable;
- `process.exit(0)` at the protected level.

RAME's trace runs beside the code under test and can be forged, so it is only a discovery aid; what the host checks itself (hashes and the project fingerprint) decides. Process separation is not a sandbox. When VS Code closes or reloads during a Mission, the old window starts nothing and writes nothing more. See [How to verify it](docs/VERIFICATION.md). Results are labelled **REAL**, **SIMULATED** or **RECORDED**, and a simulation is never presented as a real Glimmer or Meta run.

## Model evidence (v0.2.0)

> RAME doesn't just show what an AI agent did. It shows which model proposed it, what the host allowed, and what independent checks actually passed.

In v0.2.0, **Run details → Model evidence — recorded by RAME Code** shows, for the open thread, facts written by the host and never by the model. The section starts folded. Inferences that proposed a change or a test, produced the final reply, involved Meta, or are linked to a check come first. Exploratory reads sit one level further down and are bounded.

Three levels are kept apart:

| Level | What it means | What it does not mean |
| --- | --- | --- |
| **Configured** | The settings name a model file (its basename only), context size, and whether an `mmproj` and a DFlash draft are passed. | That anything is running or has answered. |
| **Running** | RAME launched `llama-server` with those arguments and owns the process, or an endpoint answered its check. `/props` may confirm the context and the Muse Glimmer template. | That the weights are those exact weights. Nothing is verified cryptographically. |
| **Response observed** | That provider answered a real inference in the recorded run, with the tokens, finish reason and kind of reply (text or tool calls) it reported. | Anything beyond that answer. A stored key or a saved endpoint never counts. |

An external OpenAI-compatible endpoint is shown as **identity not verified**, even after it answers. RAME does not assume it is llama.cpp.

When the host can link them by its own ids, each inference is linked to the tool calls it proposed. Each call is linked to the approval or policy decision, the host action (with its Activity digest), and the first check the host ran after a change in the same run. When no link exists, the view says so: "No host action recorded" or "No linked verification recorded". A check that ran afterwards is order, not proof of cause.

For a Mission, three states are shown separately:

- **Command passed** (for example `npm:check exit=0`): one command exited 0. That alone does not mean the goal was met.
- **Frozen acceptance passed**: the user's frozen acceptance check, run by the host, passed. A Standard Mission says "No frozen acceptance check".
- **Mission completed by host**: shown only when the Mission's own logic completed it.

When Meta Model API takes part, the record shows the model, its authority, whether a response was observed, and the usage. **Advisory** means Glimmer retained tool control. **Delegated** means Spark proposed tools and RAME applied the existing permission profile. A Meta failure is recorded as a sanitized category, never as a response observed. The consent card stays the place to review what was authorized; the payload is not copied into the evidence.

The record keeps no prompts, messages, reasoning, tool arguments, file contents, replies, absolute paths or credentials. It is versioned, validated when loaded, bounded per thread, and survives reloads. Anything unreadable is discarded whole, and restoring it never repeats an action. The evidence is a local convenience record, not a tamper-proof audit log.

## Project memory, saved threads and model context

These are three different layers:

- **Project memory** holds only durable decisions that the user approved, plus version history and optional verified-file bindings. It is not a transcript and it is never populated merely because a repository file or model reply mentions a value. RAME stores it outside the repository in the extension's VS Code global storage, in a separate scope derived from each canonical workspace-root path. It survives threads and VS Code reloads on that VS Code installation, but it is not synchronized to another machine or profile. Moving or renaming the root gives it a new identity.
- **Saved threads** retain the conversation for the interface and recovery. Saving a thread does not mean every old turn is sent to the model again.
- **Model context** is the bounded request assembled for one inference. It is temporary and is not persistent memory.

The **Folder** selector under Project memory is an inspector for multi-root VS Code windows: it chooses which open folder's decisions, history and artifact status Settings displays. It does not grant access, merge memories, or force Agent runs in other folders to use that memory. With one open workspace folder RAME selects it automatically. With several roots, an Agent thread is bound to the root chosen for that run and automatically receives that root's authorized memory. A Chat thread joins the project too when that is unambiguous (the only open folder, or the folder chosen here); it never asks, and joining gives it the project's authorized decisions, not tools or file access. A newly added root starts with empty project memory until its first durable decision is approved. A subdirectory shares its containing workspace root's memory unless it is opened or added as a workspace root in its own right.

Current continuity bounds are explicit:

- Agent and Chat select recent complete turns by the active model's context budget, up to 120 turns and 120,000 characters. An unknown window uses a conservative 12,000-character allowance. Twenty messages is no longer the primary continuity boundary.
- RAME additionally builds a compact operational checkpoint from the persisted thread: current authorized-memory versions, exact source references, host-recorded files and actions, tests, and errors or blockers. Model prose is never promoted into a host fact. The checkpoint is derived again after a reload, so it stays current without creating a second competing memory store.
- For Agent and Chat, RAME can recover up to six exact older excerpts and eight earlier host-record facts. Retrieval is local and lexical: Unicode and accent normalization, light English/Spanish morphology, exact entities and paths, and a deliberately small set of general cross-language concepts. Agent and Mission can also formulate up to three short recovery questions in a bounded `search_history` call (at most twice per run). The host searches the persisted thread and returns exact excerpts; a cloud Agent receives no protected older local excerpts. The extra automatic packet remains bounded from 4,000 to 24,000 characters.
- A local Mission plan receives the same bounded continuity packet as Chat, plus the project's authorized decisions; a Meta plan receives only the request. Autonomous internal runs continue from bounded, host-written checkpoints and evidence rather than replaying every earlier internal conversation, and each run also recovers up to six exact excerpts of the user's own conversation, searched by the Mission's goal, current task and the user's latest request. Excerpts never come from the host-written internal runs and never change the Mission's grant.

Retrieval is extractive: the model receives the exact stored excerpt with its turn number, timestamp and match kind, never a generated recollection. Every recovery (automatic in Chat, Agent, a Mission plan or run, and each `search_history` call) is recorded under **Run details → Model evidence → Recovered context — recorded by RAME Code**, apart from the host record and the Mission's evidence: the turn positions, roles, times, match kinds and the sha256 of the exact stored text each excerpt came from, plus a hash of the query and how many local messages were not shared with Meta. It stores no excerpt, query or reply; anyone can recompute the hashes from the saved thread. Exact excerpts are labelled as untrusted conversation; earlier host facts are past observations that may be stale and must be rechecked. Neither becomes a decision. Approved project-memory decisions remain the only persistent project authority, and their current version supersedes any older conversation. Lexical recovery can still miss paraphrases outside its normalization, morphology and small concept map.

An experimental local-embedding client and semantic-ranking bridge are retained in the source tree for future work, but they are disabled and have no runtime caller in v0.2.0. They add no package dependency, download, background service, setting or change to the shipped Glimmer server. Optional semantic retrieval is deferred to a later version.

Changing runtime or cloud model affects the next request, not the stored thread. RAME records the provider and model that produced each new assistant reply. On the next request it tells the selected model when a handoff occurred, supplies the bounded continuity packet, and explicitly says that permissions and authority do not transfer between models; toward Meta a local model is named only as "a local model". Meta's Chat Completions API is stateless between requests, so RAME selects and resends each item it wants a model to see. An authorized Mission remains bound to its provider and model and is never silently migrated. Older stored replies from before provenance tracking have no assumed origin and receive the conservative local treatment.

**Disclosure to Meta.** With Meta selected, pressing **Send** authorizes the new message itself; RAME does not add a second confirmation for that message alone. Before a Meta Chat, Agent or Delegated request would additionally carry eligible local history Meta has not received under the same conditions, or the project's authorized decisions, RAME shows **Review what would be sent to Meta**. The card lists every additional local message the request would carry: the newly eligible ones and, as **also sent again**, those approved earlier; together they stay within 20 messages and 12,000 characters, with their host records, so approvals do not accumulate. **Send with this context** sends exactly that additional context; **Send without it** sends the new request, Meta's own earlier replies under the same conditions and any messages approved earlier, keeps the newly offered material local and does not offer it again; **Cancel** sends nothing. Each answer is bound to the recipient (Meta Model API), to every displayed field of each message (role, time, text, host record), to the processing class — Meta's documented standard models share one, its documented Contributor variants (under Meta's terms they may use what they receive) share another, and any other model id is its own class — and to the Meta API key it was given under (an opaque revision that changes whenever a key is saved or cleared; neither the key nor a hash of it is stored). Changing between standard models reuses the answers; a Contributor variant, an undocumented model, or a new or cleared key asks again, including for exchanges Meta received under other conditions. A pending card is void if the model, its class, the key, the thread or the decisions change. Approved project decisions reach Meta exactly as shown (key, value, version): never pending proposals, verified-file bindings or provenance. In Agent mode the card also asks, once per thread, processing class, key and VS Code session, whether Meta may receive tool results (file contents, searches, test output); without that answer the tools still run locally but their output is replaced before sending. A delegated run's own approval card covers its tool output. Message and project-decision choices persist for the same thread, processing class and API-key revision; tool-result permission lasts only for the current VS Code session. **Stop sharing with Meta**, under the conversation, withdraws every answer for future requests in the thread; it cannot recall what Meta already received, and an active request must be stopped first. An unreadable disclosure record counts as nothing disclosed.

**What the Agent card means in practice.** A checked tool-results box allows Meta to receive the pattern-redacted results of tools during the displayed thread/session conditions; clearing it keeps those results from Meta even when RAME runs the tools locally. **Send without it** withholds only the newly offered context: previously authorized material may still be reused under the same recipient, processing class, credential and content bindings. The selected runtime decides who controls Agent: if Meta Cloud is selected, Spark remains the model even when Glimmer also shows as connected. The local-only `web_search`, `web_fetch` and `run_command` tools are not offered to Spark; cancel and select a responding local runtime to use them. These are technical privacy-by-design controls related to transparency and data minimisation, not by themselves proof of GDPR compliance or a legal basis for processing.

Before any Meta request leaves, RAME checks the request it actually built: it stops one that would carry a local message not approved under its conditions, or whose API key changed while it was running; it replaces the absolute paths of the open project folders and of the home folder (on Windows regardless of case, with `\`, `/` or UNC forms, without touching similar paths); and it redacts values that look like secrets (keys, tokens, private keys, JWTs, URL credentials, `*_PASSWORD=` or `*-auth=` style assignments) from the tool results it sends. Redaction and path replacement are pattern-based: they reduce, but cannot exclude, sensitive content in material you allow Meta to receive, and absolute paths other than those folders are sent as they appear. The check recognises local text of 24 characters or more; shorter local messages are kept out by how each request is built — only the approved part of the thread, no history search for Meta, only approved decisions, never RAME's own notes — which automated tests verify on every path (Chat, Agent and its tools, Delegated, Mission plan), not by detection. This is a technical disclosure control, not legal consent under data-protection law.

**v0.2.0 privacy limitations:** exhaustive request inspection and failure-path coverage still use a simulated Meta API that records each complete request. On 2026-11-04, human validation recorded three real Chat-only inferences with `muse-spark-1.3`, with consent and Model evidence recorded by RAME; that validates the direct Chat connection only, not cloud Agent tool results, Delegated, Mission planning or Advisory. The processing classes come from the documented model ids listed in the code and must be reviewed when Meta's catalog or terms change. In Agent, earlier messages longer than 4,000 characters are sent shortened, and the card shows them exactly as sent, with the shortening marked; plan entries the card lists are not part of Agent history, so Agent may send less than the card shows, never more. Do not use real personal, confidential or otherwise sensitive data with Meta during experimental preview use.

## Privacy by Design — Privacidad desde el diseño

RAME Code is designed around **governed autonomy with privacy controls**, rather than treating every remembered item as permission to disclose it or act on it. This is a technical design direction, not a statement that RAME Code or a particular deployment complies with the GDPR.

Confirmed mechanisms in v0.2.0 include:

- local text inference through a loopback-only server, without sending that request to a cloud provider;
- separate project memory, conversation recovery, tool permissions and host evidence;
- versioned, user-approved project decisions, where an older conversation does not override the current authorized version;
- local-to-Meta review listing every local message a request carries (new and earlier approved) within one bound, with include, withhold, cancel and stop-sharing choices;
- answers bound to Meta's processing class (standard, Contributor, or one undocumented model) and to the API key revision, with a pending card void when either changes;
- a final check on each request built for Meta, which stops undisclosed local content and replaces local project and home paths;
- per-session consent for Agent tool results toward Meta, with pattern-based redaction of secret-like values;
- content-bound disclosure records using SHA-256 as an integrity reference (not encryption and not a proof that the underlying device is uncompromised);
- bounded recovery records that retain references and hashes instead of making another copy of recovered excerpts;
- historical excerpts labelled as untrusted context, never as current instructions or permissions; and
- separate grants and limits for Mission Advisory and Delegated Agent execution.

Remaining limitations: the three real Meta inferences cover Chat only; the full disclosure and failure matrix remains verified against the simulated recorder. Secret redaction and path replacement are pattern-based and cannot exclude every sensitive value; once you allow Agent tool results for a session, their future contents (after redaction) cannot be previewed before the run; and the processing classes depend on the documented model ids kept in the code. Do not use real personal, confidential or otherwise sensitive data with Meta during experimental preview use.

### Relationship to GDPR principles

The table describes how verified technical mechanisms may support an operator's compliance work. It does not establish a lawful basis, validate a transfer, or satisfy an article by itself.

| GDPR area | Technical relationship in RAME Code | Still required outside RAME |
| --- | --- | --- |
| Article 5 — transparency, minimisation, integrity/confidentiality and accountability | Local execution is available; the disclosure card previews every local message of each Meta request within one bound, transfer choices and bounded provenance make selected processing more visible, and memory and authority are separated. Verified with a simulated provider only. | Define purposes, data categories, retention and deletion, recipients, access controls and demonstrable organisational measures. |
| Article 6 — lawfulness | RAME records a user's technical disclosure choice. | The controller must identify and document the applicable lawful basis. A RAME button is not necessarily GDPR consent and does not replace notices or data-subject rights. |
| Article 25 — data protection by design and by default | The architecture separates local processing, persistent memory, permissions, external transfer and evidence, binds disclosure to recipient, processing class and credential, and fails closed on damaged disclosure state. | Assess the actual processing, risks, defaults and effectiveness throughout the lifecycle, including validation against the real provider. |
| Article 32 — security of processing | SecretStorage, bounded inputs, policy checks, one-use approvals and integrity hashes can contribute to confidentiality and integrity controls. | Select risk-appropriate technical and organisational measures, test them regularly, manage incidents and secure the host, network and providers. SHA-256 references are not encryption. |
| GDPR Chapter V — international transfers | RAME can identify when Meta is the remote recipient and can technically restrict some local context. | Determine whether a restricted transfer occurs and establish the applicable adequacy decision, safeguards or lawful derogation. RAME does not provide that legal mechanism automatically. |

Authoritative references: the [GDPR text on EUR-Lex](https://eur-lex.europa.eu/eli/reg/2016/679/), the EDPB [Guidelines 4/2019 on Article 25](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-42019-article-25-data-protection-design_en), and the European Commission's overview of [international data-transfer rules](https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/rules-international-data-transfers_en).

An operational deployment may additionally require privacy notices, data-subject request handling, retention and erasure policies, processor agreements, records of processing, international-transfer assessment, contractual and organisational safeguards, and a data-protection impact assessment where applicable. Project maintainers and deployers should obtain appropriate legal advice for their use case.

## Generation controls

RAME Code keeps context size, reasoning effort, output budget and the Agent's 12-step budget separate.

- Local Glimmer reasoning controls are offered only when the running server's `/props` template verifies support.
- Meta reasoning options are limited per selected model.
- Automatic cloud output budgets scale from 8,192 to 131,072 tokens according to reasoning effort.
- A cut-off response is discarded; no partial tool call is executed or stored as success.
- Input is never silently shortened to make a request fit the active context window.

For local inference, the running loopback server's `/props` response is authoritative. The tested Muse Glimmer setup uses a 32,768-token context per request and a 4,096-token automatic output budget. Settings accepts larger configured contexts, but the model, server build and available memory determine what is actually usable; RAME probes `/props`, reserves room for the response and refuses clearly when the complete request cannot fit.

For the known Meta model ids profiled by this candidate, RAME currently uses a 1,048,576-token context profile. Meta's current [model catalog](https://dev.meta.ai/docs/models) documents that context for Muse Spark 1.1, 1.2 and 1.3 and Muse Wonder. RAME refreshes available model ids from `/models`, but does not dynamically infer a context size from that response: the standard [Model schema](https://dev.meta.ai/docs/api-reference/models/schemas) does not expose one. The explicit profile must therefore be rechecked when Meta changes its catalog. This large context is per request, not persistent memory, and RAME's bounded thread-history rules above still apply. Unknown model ids are not assigned an assumed context size.

## Build from source

Requirements:

- Node.js 22 or later;
- VS Code 1.95 or later.

```bash
git clone https://github.com/caimari/rame-code.git
cd rame-code
npm ci
npm test
npm run package
```

Press `F5` in VS Code to open an Extension Development Host.

## Development provenance

- Public implementation began on **2026-10-31**.
- Competition: **Meta Global AI Developer Hackathon 2026**.
- Track: **Indie Developer**.
- Human architect, product lead, maintainer and release decision-maker: **Antoni Caimari Caldés**.

The public implementation and Git history start independently in this repository. Earlier private code, services, datasets and evaluation results are not included or required. Development milestones are recorded in [HACKATHON_WORK.md](HACKATHON_WORK.md). Private working notes are deliberately excluded from Git and from release packages.

**RAME Code was conceived and directed by Antoni Caimari Caldés, its human architect and product lead, with development assisted by Muse Code, Muse Glimmer, OpenAI Codex and Claude Code.**

Implementation began with **Muse Code** and `muse-spark-1.3` through Meta Model API, under Antoni's direction and review. The project log records USD 150.00 in initial free credits and USD 122.96 remaining after the intensive early implementation windows: USD 27.04 used (about 18% of the initial amount). Those are cumulative dashboard figures, not a per-feature cost, and Meta Billing/Usage remains authoritative. The decision to change the development mix was a budget-allocation decision—not a conclusion that Muse could not do the work—so the remaining credits could be reserved for RAME inference, validation and demonstrations with Meta models.

Later construction and review combined existing access to **OpenAI Codex** and **Claude Code**, local **Muse Glimmer**, and Antoni's continued architecture, prompting, approval and testing. Codex and Claude Code acted as development and audit assistants, not as the project's architect. Git records Antoni as the human integrator; the available evidence does not support exact line-by-line or percentage attribution for every mixed change. Autonomous Glimmer work in disposable trials is reported separately from code actually integrated into a public release. Models used in the final demonstration will be named only after that run has been verified.

## Roadmap

After the v0.2.0 preview release, the priorities are real Windows validation, explicitly authorized validation of the remaining Meta workflows, image input for Glimmer, a refined interface and visual identity, Visual Studio Marketplace distribution, broader verified project adapters and continued research into verifier-governed model handoffs.

## License

Licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 Antoni Caimari Caldés.
