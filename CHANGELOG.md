# Changelog

All notable changes to RAME Code are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-11

### Added

- Long Missions can run bounded, resumable work with persistent jobs, progress evidence, host-observed measurements and multi-phase Programmes. A renewable phase lease prevents two VS Code windows from directing the same Programme phase at once and safely permits recovery after an expired owner.
- Autonomy controls now separate approval policy from command isolation. Full Access can remove routine prompts within its explicit grant, while protected verification always keeps its own mandatory boundary. Long jobs, bounded installs and local process limits have dedicated controls and records.
- Reinforced functional cases and differential references run one input at a time. Expected answers, future inputs and host records remain outside the evaluated process, and the host performs the comparison.
- LM Studio can offer a confirmed reload with a larger context after a short-context refusal. Local server errors retain the server's bounded message, distinguish setup failures from an unreachable server, and keep the selected model visible when discovery temporarily omits it.

### Changed

- The user guides (English and Spanish) explain every option of the Mission authorization card, and describe test isolation by level instead of saying that test scripts always run with the user's permissions.
- Full Access is now the top level of the chat's permission selector (Ask → Safe auto → Workspace full → Full Access). Choosing it asks for its usual confirmation with the parts, validity and environment chosen in Autonomy & Permissions; choosing a lower level turns it off at once. It never raises the profile underneath, so it covers only the parts you granted; when it expires, a notice shows the level you are back to. By default it lasts until you turn it off (no expiry); 1 hour to 30 days remain available in Autonomy & Permissions. The Meta and web pre-authorizations keep their own hours.

### Fixed

- Measured acceptance distinguishes host-observed metrics (`wall_ms`, `exit_code`) from values declared by the frozen project check (for example `p95_ms`, `errors`) through a private per-run channel. Every criterion and result states its class and warns that malicious code in the same process can alter project-declared figures; arbitrary project JSON and printed values have no authority.
- Protected verification uses an exact filesystem view and closed network on supported Linux, independently of Full Access or the terminal's `Total` setting. Without protected isolation, verification runs with a warning and results are marked unprotected («sin aislamiento protegido, la verificación se ejecuta con un aviso y los resultados se marcan como no protegidos»).
- Node 24 can load the host-owned case runner inside the protected view without granting access to the surrounding extension tree.
- Local HTTP 400 responses caused by an undersized LM Studio context now explain the required action instead of looking like a generic runtime failure. The same refusal sent inside a streamed reply (HTTP 200, as LM Studio sends it to Agent) is recognized too: the card says the request does not fit the model's context, offers the reload, and no longer reads «Glimmer answered». When LM Studio reports the context the model is loaded with, RAME now refuses a request that does not fit before sending it: LM Studio would otherwise retry by itself with the conversation cut to fit and stream the answer to the cut conversation. Turning cloud escalation on (or saving a key) after a local failure now offers «Run this request with Spark» on the same card; it still waits for approval. Rows of buttons have space above and below the text around them. The Mission's final report states the isolation each test really ran with, as the host noted it at run time (for example Project for the project's tests and the protected verifier for a frozen acceptance check), instead of a fixed «No sandbox» note that contradicted the host record. In «Web access for this Mission», the checkbox and each limit now sit on their own line. Expired Spark offers disappear instead of leaving an unusable action.

### Known limitations

- Protected verification requires Linux with Landlock ABI 4 or newer and `libseccomp.so.2`. On Windows, macOS, older/no Landlock or missing libseccomp, the check runs without isolation, with a prominent warning and an unprotected label in authorization, progress, result and evidence. Equivalent protected isolation on Windows and macOS remains the goal.
- Evaluated code necessarily sees its current input and can alter its own behavior or internal clocks. Only the host's external wall time and exit code are official measurements; those observations do not by themselves prove functional quality.
- Hidden cases provide operating-system-enforced separation of expected answers, future inputs and host evidence, but incomplete cases remain incomplete. Differential verification trusts the frozen original as its behavioral reference, so a defect shared with that original can pass.
- Programme ownership coordinates VS Code processes that share the same host storage. It is not a distributed lock across different computers or replicated stores.
- Local model behavior still depends on the server, model and loaded context. The LM Studio short-context path was checked with a real LM Studio server (refusal before sending at 4096, confirmed reload to 32768, then the same request completed). A server that cuts the conversation silently and does not report its loaded context cannot be detected yet; in LM Studio, set «Context Overflow» to «Stop at limit».

### Security

- Official measured acceptance and Programme baselines classify host observations separately from project declarations received only through the frozen check's private per-run channel. Existing Missions and Programmes that use `p95_ms`, `errors` or other valid project metrics continue without re-authorization. Same-process manipulation remains explicitly possible and visible.
- Protected and reinforced verifiers use the mandatory allowlisted filesystem view whenever it is available. Landlock confines reads and writes; seccomp denies TCP, UDP and Unix sockets plus cross-process inspection; recognized project secret files are excluded. Each functional/reference input runs fresh. Unsupported systems continue unprotected with the warning and label; Full Access/Total never weakens protection when available, and a protected→unprotected transition is recorded rather than stopping silently.
- Programme phases now use a renewable, machine-wide lease and monotonically increasing fencing token. Concurrent VS Code processes cannot start the same phase twice; expiry permits recovery, while late updates and releases from the previous owner are rejected. The lock is per machine, not distributed across computers.

### Migration

- No re-authorization is required for stored measured acceptance or Programmes naming valid project-declared metrics such as `p95_ms` or `errors`. Protected isolation currently requires Linux with Landlock ABI 4+ and `libseccomp`; elsewhere verification continues with the unprotected warning and label.

## [0.2.0] - 2026-11-04

Experimental preview release. It introduces a modularized core, governed project memory, autonomous Missions, acceptance and causal verification, and a strict separation between Meta Advisory and Delegated execution. Modularization is not complete: the presentation assets `media/main.js` and `media/i18n.js` remain inherited exceptions.

### Added

- Web access in Chat and in Missions (experimental: covered by tests against simulated servers only; not yet validated against the real web). Chat (local model, the Settings switch) may call `web_search` and `web_fetch` only, each after approval, with sources in the host record; no file, test, terminal or memory tool. A Mission gets web access only from its own grant: searches and page reads budgets and optional authorized domains chosen in the authorization card, bound to that Mission, project, model and grant, counted in the checkpoint before each request; an autonomous Mission does not ask per request within the budget, reads only URLs its searches returned (or the authorized domains, redirects included) and sends plain-word queries only. Web lines are left out of Advisory consultations to Meta.
- Model servers you run yourself: Ollama, LM Studio, another `llama-server` or any OpenAI-compatible server. **Find models** reads metadata only (Ollama `/api/version`, `/api/tags`, `/api/show`, `/api/ps`; LM Studio `/api/v0/models`; `/v1/models` and `/props` otherwise), tells the servers apart by the content of their answers, and lists chat models with tool use, vision and loaded context; the chosen model id is sent by Chat, Agent and Mission. A model the server says cannot call tools is refused for Agent and Mission with that reason. A server on another computer of the private network, written as a literal private IP (host names other than `localhost` are refused), is used only after the user confirms that local work will be sent there; public addresses are refused by every local client, and no local client follows a redirect. Discovery is bounded (20 s in all, 4 Ollama requests at a time, 4 MiB per answer, read as it arrives). A model the server says cannot call tools is refused for Agent and Mission before any request. Pending approvals become void when the profile, runtime, model or model server changes. Tested for real with Muse Glimmer 30B on LM Studio 0.4.25 (RTX 3090 Ti, over a private network) and with Ollama 0.32.5 (CPU).
- Optional read-only web access for Agent (default OFF): `web_search` (DuckDuckGo HTML, or the user's SearXNG) and `web_fetch`. Local model only; each Agent call is shown and, except in Workspace full, needs approval. Agent web has one recorded REAL validation with LM Studio on a private LAN, DuckDuckGo and `web_fetch`. Chat and Mission web are separate experimental paths, implemented and tested only with simulated servers. Only public addresses are reached, checked after DNS and on every redirect, with the connection pinned to the checked address; at most 4 redirects, 15 s and 2 MiB, text content only. A query or URL with a secret-like value or a local path is not sent. Page text is labelled untrusted and cannot write project memory.
- Optional terminal commands for Agent (default OFF): `run_command` runs one shell command line (bash or sh; PowerShell on Windows) in the project folder with the user's permissions, without a sandbox. Local model only, never in Mission runs; every command is shown in full and needs approval in every profile, Workspace full included, with warnings for chained commands, hidden scripts, sudo, network, installs and writes outside the project; 120 s by default (at most 600 s) and bounded output. Stop signals the command and its normal process group, but a deliberately detached process may survive. A short list of commands that can only destroy is refused. Tested for real with Ollama `llama3.1:8b` (CPU).
- Compatibility: Ollama's numeric `index` in tool calls and LM Studio's empty `tool_calls` list with a plain answer are accepted; any other extra field is still refused.
- English and Spanish "For judges" claim-to-evidence tables, a public evidence index, and a sanitized RECORDED extraction from one historical REAL supervised local-Glimmer Mission. The bundle preserves its historical dirty-build identity, the 36/37 inference-count discrepancy and the limits of an `n=1` disposable-project run; it is not presented as proof of the current commit.
- Practical English and Spanish user guides covering the three modes, Mission authorization and verification, empty-folder bootstrap, project memory, optional cloud use, privacy and current limitations.
- User-authorized, versioned project decisions with provenance and history.
- Verified-file bindings that become stale when a referenced decision changes.
- Persistent, resumable Missions with supervised and trusted autonomous-workspace execution.
- Two-stage bootstrap Missions for empty folders: the first explicit grant may scaffold implementation, `package.json` and tests but cannot run tests or complete the Mission; RAME then revokes that grant and waits for a second explicit authorization that reviews and optionally freezes the newly created verification files.
- An optional independent acceptance review at the bootstrap checkpoint. Before the second authorization, the user can preview and explicitly send the Mission requirements plus up to three selected test fragments to a documented Standard Meta model. Spark receives no tools or authority, returns bounded structured observations, and cannot change files, choose or freeze acceptance, grant permissions, or complete the Mission. The user may consider or dismiss the advice and still makes the final acceptance choice locally. The one-use approval is bound to the Mission, folder, model, processing class, credential revision, exact content and byte/token limits; failures never retry automatically or stop the local path.
- Frozen acceptance checks that the Agent can read and run but cannot modify through RAME Code tools.
- Three Mission verification levels, stated in the host notes and the final report together with the Node version the check ran on: conventional (a project test passes after the last change), protected (the host runs the frozen acceptance check, observes it to its end, needs exit 0 and compares the whole project with its own record from authorization) and reinforced (a frozen `*.rame-cases.json` whose cases RAME's own runner calls in a separate process; the host compares every result, the expected values are not sent to that process and are hidden from the agent's tools, so an early exit or forged output cannot pass). A fourth outcome, **not verifiable**, is reported whenever RAME cannot show that the authorized conditions held: never a pass, and the authorized acceptance stays unchanged.
- A Mission sabotage battery (`npm run demo:sabotage`): 44 SIMULATED attempts to complete a Mission without the work (including the reproductions of independent audits), with a sanitized result file in `evidence/sabotage/`, a verification guide in English and Spanish (`docs/VERIFICATION.md`) and a GitHub Actions workflow running the build, policies, tests and battery on Node 20 and 24.
- Host-verified Mission checkpoints, progress evidence, pause, resume, cancellation and bounded no-progress stopping.
- Explicit, user-approved local-to-Meta advice escalation with a local verification pass afterwards.
- Natural project-memory proposals in English and Spanish, with conservative host checks for negation, temporary instructions and exact boolean values.
- English and Spanish interface selection, project selection for multi-root workspaces, and candidate build information.
- Causal verification for Missions: each failing allowed test opens an identified blocker, and authority returns only when the host runs that original verifier again and it passes. A verifier that can no longer run marks its blocker unrecoverable and blocks the Mission.
- Two separate Meta paths. Advisory ("Ask Spark for advice — Glimmer remains in control") sends one approved, digest-bound text with no tools and, optionally, up to three files the user selects. Delegated ("Run this request with Spark — Spark directs the agent") runs one approved Agent request with the same permission profile; it is never used for a Mission's internal runs.
- Classified Meta failures (authentication, credit, rate limit, network, timeout, cancelled, invalid response, remote error, unknown) with sanitized details and no automatic retries.
- Verifiable limits for a Mission's Advisory grant: consultations, bytes per request, total bytes sent, output tokens per answer and a total remote token budget. Usage and the remaining amount are shown; a consultation that would exceed any limit is refused before it is sent, and limits are never raised automatically.
- Context-aware actions after a failed local request: start the configured local server or open its settings; Delegated is offered only for a normal Agent request with escalation enabled and a stored key, and is otherwise disabled with the reason, or hidden for internal runs.
- A compact runtime line in the view header ("Glimmer local · …", "Meta API · …"); "connected" requires an answer in the current session, so a stored key alone shows as "configured".
- Model evidence in Run details ("Model evidence — recorded by RAME Code"). RAME doesn't just show what an AI agent did. It shows which model proposed it, what the host allowed, and what independent checks actually passed.
  - Three levels are kept apart. Configured: the GGUF basename, context, and whether `mmproj` and a DFlash draft are passed. Running: `llama-server` launched and owned by RAME, with context and template confirmed by `/props`. Response observed: a real inference answered, with its tokens, finish reason and reply kind. Nothing is presented as a cryptographic proof of the weights, and an external endpoint stays "identity not verified".
  - Each tool call is linked to its inference, its approval or policy decision, the host action by its Activity digest, and the first check the host ran after a change in the same run. Where no link exists it says so; order is never presented as cause.
  - "Command passed", "Frozen acceptance passed" and "Mission completed by host" are shown separately, and a Standard Mission says it has no frozen acceptance check.
  - Meta Advisory is labelled "Glimmer retained tool control" and Delegated "Spark proposed tools; RAME applied the existing permission profile". A Meta failure is recorded as a sanitized category, never as a response observed.
  - The record holds host facts only: no prompts, reasoning, tool arguments, file contents, replies, absolute paths or credentials. It is versioned, validated on load, bounded per thread, survives reloads, and is discarded whole if unreadable. The Mission's final report adds a two-line summary.
- Provider-independent long-thread continuity for Agent and Chat: recent history is supplemented with a bounded, extractive set of relevant exact excerpts and past host facts. The packet labels their authority and age, records retrieval in the host record, and never converts them into project memory.
- Context-budgeted continuity now replaces the fixed twenty-message main path: up to 120 complete recent turns are selected conservatively from the active model window, with compact host-derived checkpoints for authorized decisions, files, checks and blockers.
- Advanced local lexical retrieval with Unicode/accent normalization, light English/Spanish morphology, exact entity/path weighting, deduplication and a small general cross-language concept map. Agent and Mission also have a bounded `search_history` tool for model-guided recovery questions; it returns exact low-authority excerpts locally and never discloses protected older local history to Meta.
- Experimental embedding-client and semantic-ranking source modules are retained for a future optional feature, but v0.2.0 has no runtime caller, setting, dependency, download, background service or server change for embeddings.
- Informed model handoff: new assistant turns retain validated provider/model provenance. When the next request changes model, RAME tells the new model what changed without transferring permissions. Additional old local excerpts and host records are withheld at a local-to-Meta boundary.
- A per-thread local-to-Meta disclosure review for Chat, Agent and Delegated requests. Each review lists every local message the request would carry — new ones and, as "also sent again", earlier approvals — within 20 messages and 12,000 characters, plus changed project decisions, with include, withhold, cancel and stop-sharing choices.
- Automatic bounded recovery for local Mission planning and each autonomous internal run, sourced from the user's conversation rather than host-written internal runs.
- A separate recovered-context provenance log under Model evidence. It records bounded turn references, roles, timestamps, match kinds and sha256 values without copying excerpts, queries or replies, and remains distinct from the host record and Mission evidence.
- Regression coverage for long-thread continuity, local/cloud handoffs, exact-content disclosure grants, damaged persisted state, Mission recovery, recovery provenance and the real Chat/Agent request-building paths.

### Changed

- Replaced the extension-host monolith with a bounded composition shell plus dedicated generation, Agent, Mission and project-memory controllers; every TypeScript implementation file now fits the approximate 16,000-token source-file policy. The legacy presentation scripts `media/main.js` and `media/i18n.js` are not yet split.
- The mode selector order is now Agent, Mission, Chat only; Agent remains the default.
- Mission internal runs now receive a bounded host checkpoint instead of replaying earlier internal-run conversations. This keeps the cross-run context approximately flat while preserving the complete stored thread and evidence.
- Mission completion now depends on host-observed changes and successful tests after the last change; verified Missions additionally require the frozen acceptance command to pass.
- Mission setup and progress are presented in the conversation, with distinct planning, authorization, running, paused, blocked, interrupted and completed states.
- Mission authorization now contains its complete Meta Advisory grant in the same card: the selected model and processing class, consultation count, default or custom byte/token limits, and the fact that Glimmer retains every tool. Web and Meta allowances start disabled on every new authorization and are enabled only by an explicit choice on that card; permissions from an earlier Mission are not inherited.
- Local Glimmer generation uses the model's verified reasoning control and a configurable output budget rather than a single fixed response limit.

### Fixed

- Mission grants are independent from Agent's Ask, Safe auto and Workspace full selector. Supervised Missions continue to request approval for writes and tests, while Autonomous workspace Missions perform ordinary authorized writes and allowlisted tests without repeated prompts. The empty-folder bootstrap still requires its separate second authorization before new tests can become verification authority.
- Mission UI and evidence identify autonomous internal runs as Mission work and keep the Mission grant visible; they no longer present Agent's permission selector as if it governed those runs.
- Mission planning uses existing checkpoints and host-observed completion evidence to avoid scheduling work whose criteria are already satisfied, without weakening the final host checks.
- Regression coverage includes the Agent-profile/Mission-permission matrix, empty-folder bootstrap, per-authorization web and Meta defaults, and redundant-run prevention. Preserved implementation logs and the independent final audit both record 759/759 passing tests on Node 20 and 759/759 on Node 24, with zero failures.
- Terminal approval cards now show the complete `run_command` line that the one-use authorization binds, including commands longer than the ordinary action-preview limit.
- Pending tool authorization is invalidated when the user leaves or changes the active thread; the existing workspace, provider, runtime, model, server, file-precondition and generation bindings continue to fail closed.
- A web request whose cancellation signal was already aborted is stopped before opening a connection.
- CI evidence generation no longer mistakes ordinary phrases such as "case runner" for disclosure of GitHub Actions' `runner` account. The public-evidence gate still rejects absolute local paths, structured account fields and key-like material, with regression coverage.
- Prevented model-authored text from impersonating the host record.
- Made malformed local tool-call replies recoverable within a bounded retry budget.
- Added exact-fragment editing with hash-bound approval and atomic rollback.
- Prevented negated or temporary user statements from becoming persistent project decisions without clarification.
- Prevented repeated Mission history from growing on every autonomous internal run.
- Continuity: a local model id that Settings accept but the provenance pattern did not (for example `glimmer#q4 [test]`) made the reply fail after the model had answered; it is now stored under a normalized label.
- Continuity: with host records in the thread, some middle turns were neither in the recent history nor eligible for recovery; the recent/old boundary is now the exact set of turns sent.
- Continuity: recovered context in Agent was placed after the current request, so an old excerpt or objective became the last user message; it now comes before the history, as in Chat.
- Continuity: excerpt diversification was quadratic, about 13 seconds for a 1,000-turn thread on the extension host; it is now linear.
- Continuity: a short local Chat thread bound to a project now receives the current authorized decisions, which were previously included only once the thread exceeded its recent window.
- Privacy: switching a thread from local to Meta could send up to 120 recent local messages (about 70,000 characters in tests) without asking. Meta now receives local-session messages and project decisions only after the user reviews them on **Review what would be sent to Meta**; one request carries at most 20 local messages and 12,000 characters, new and earlier-approved together, and the card lists both as they will be sent.
- Privacy: Agent and Delegated requests to Meta carried the absolute path of the project folder (`PROJECT SCOPE`), even after "Send without it". Only the folder name is used now, and a final check replaces the absolute paths of the open project folders and the home folder — on Windows regardless of case, separator style or UNC form, without touching similar paths.
- Privacy: approving project decisions for Meta also sent pending proposals, verified-file bindings and provenance in Agent mode; Meta now receives exactly the decisions shown on the card, also through `read_decisions`.
- Privacy: Agent tool results reached Meta under the permission profile alone. The card now asks once per thread, processing class, API key and VS Code session; without consent the output is replaced before sending. Secret-like values in results that are sent are redacted in one pass with well-formed markers, now including URL credentials (for example `DATABASE_URL`) and `*-auth=`-style names.
- Privacy: an answer given for a standard Meta model was reused for its Contributor variant, and answers outlived a new or cleared Meta API key. Answers and tool-results permissions are now bound to a processing class (Meta's documented standard models, its documented Contributor variants, or one undocumented model) and to an opaque credential revision that changes whenever the key is saved or cleared; neither the key nor a hash of it is stored. A run whose key changes is stopped before sending more, a pending card is void when the class or the key changes, and exchanges Meta received under another class are asked about again. Disclosure store format v4; older records disclose nothing.
- Privacy: answers are bound to the recipient and to every displayed message field (role, time, text, host record); a pending card's digest also binds the model, mode, delegation and its questions. **Stop sharing with Meta** withdraws every answer for a thread.
- Privacy: the Agent card showed earlier messages longer than 4,000 characters in full although Agent sends them shortened; it now shows them exactly as sent, with the shortening marked.
- Privacy: a final check on the request actually built stops any Meta request that would carry an undisclosed local message; RAME's own notes and retrieval statistics are never offered or sent, and the local model id is no longer named to Meta.
- Mission: local plans and autonomous internal runs now receive bounded, extractive recovery from the user's own conversation, alongside the Mission checkpoints and without changing the grant; excerpts never come from host-written internal runs.
- Coherence: Meta is no longer offered `search_history` (it always refused); on the last Agent step Meta keeps the documented `tool_choice: auto` and is told a tool call will be refused; project memory now precedes the history and the request in Agent mode.
- Chat: a Chat thread joins the open project when that is unambiguous, so it receives that project's authorized decisions; it gets no tools or file access, and Chat never prompts for a folder.
- Clarified runtime state in the header: only a responding Meta API is shown as connected, connected/running states are green, and a stopped local runtime is explicitly labelled stopped/parado. Mission authorization and Settings fields now have consistent spacing between labels, controls and explanatory text. Thread navigation now displays a real pending state while the reactivated extension host confirms opening or leaving a thread, and completed-run status has clear spacing from the runtime header and thread title.
- Runtime errors now open the relevant Runtime settings card directly. Returning to Models re-probes local `/props`, so Muse Glimmer reasoning levels appear as soon as the server verifies them. Meta credentials have an explicit connection test, project memory labels its open-workspace selector as Folder, About identifies the author and repository, and accordion/composer spacing is more legible in both interface languages.
- Project memory now states that Agent and Mission use it automatically, follows the folder bound to an opened thread, hides the folder switcher unless the VS Code window has multiple roots, and presents direct manual entry as an advanced action rather than required setup.
- Documented the candidate's privacy-by-design architecture and its technical relationship to GDPR principles, while explicitly separating implemented controls from lawful-basis, data-subject-rights, retention, processor and international-transfer obligations that remain deployment-specific.

### Security

- A frozen acceptance check also freezes what it uses. At authorization RAME runs it once under its own trace (process entry points with the traced process that started each, CJS and ESM module loads, `fs` and `fs/promises` reads, with the file that caused each) and combines that with static analysis. An access with no project file on the stack counts as the check's own, never as nobody's: the test files a command such as `node --test acceptance/` runs in child processes, and helpers a check starts as processes, are frozen with it, and the test folders it runs or lists are sealed. Other files the check uses must be confirmed as writable in a modal dialog; a check whose dependencies cannot be determined is not protected.
- Before a Mission with a frozen acceptance check can end, the host runs that check itself, even when the agent ran no test. Previously the host waited for an agent test, so a correct implementation ended as blocked and a wrong one was never checked against the user's criteria (S10b).
- A closed or reloaded window starts nothing and writes nothing more: its tools' file system refuses every change, it starts no model request (its request runner is closed), no test or acceptance process, and no Mission state write; the Mission loop also stops when another loop has replaced it. Each barrier is tested on its own. A run stopped by the user, a pause or a reload is recorded as an interruption, not a failed check, and a Stop pressed at any point of the host's acceptance run is no longer lost.
- The optional Spark acceptance review now applies the same secret redaction and local-path replacement to the Mission goal and criteria as to the file fragments; the card shows exactly the text that would be sent, and now also the fixed instructions sent with it.
- The scope a protected check was authorized for is kept in the Mission grant as a manifest (frozen, writable, outputs, sealed folders, process entry points, observed paths, a fingerprint of every project file and the Node version observed), and every host run is compared with it. RAME's trace is no longer trusted as evidence: it runs beside the code under test and can be forged. What decides is what the host checks itself, before and after each run: a file in a sealed or acceptance folder, a frozen or environment file, a file the check uses, or an existing file that is not code, changed outside the scope means the run is not verifiable, whatever the trace says. Other existing code that changed, and every new file not declared as an output at authorization, are shown to the user in a scope review; an approval is recorded as a new authorization. Fixes the false acceptances reproduced by the independent audit (AUDIT-A, AUDIT-A2, AUDIT-C) and the forged-trace cases reported by Codex.
- Reinforced level: the case runner runs under the trace, and a run in which code other than the check reads a `*.rame-cases.json` file is not verifiable; RAME's tools refuse to show the cases file to the agent (AUDIT-B). The guarantee is stated as what it is: the host ran every authorized case and compared every result itself, not that the answers are secret.
- The host's project record hashes the bytes of every file in 1 MiB blocks (SHA-256), with no size-only fingerprint for large files; a file that cannot be read, or that changes while it is read, makes the run not verifiable. A record is taken before the check, after it and after the host-compared cases. On Linux and macOS the kernel's change times also show a file written and restored during the run, even with its modification time put back, and a file added and removed in an acceptance folder; on Windows only the start and end state is claimed and the note and report title say "start and end only". A grant recorded with the earlier fingerprint is not verifiable and must be authorized again.
- Every new file outside the outputs authorized at the start goes to scope review. The trace may report that the implementation loaded a new code file, but the trace is untrusted discovery data and can no longer authorize that file by itself.
- Acceptance-scope path comparisons now preserve letter case on POSIX. A writable authorization for `lib/subject.js` can no longer authorize the distinct `lib/Subject.js` on Linux; Windows retains case-insensitive matching. Likewise, case-distinct `.GIT` or `NODE_MODULES` folders on POSIX are fingerprinted instead of being mistaken for the excluded control/dependency folders.
- The acceptance trace attributes a load made deep in the stack to its project file: with Node 24's extra loader frames, the default stack limit could leave it without an author, counted as the check's own (a false "not verifiable", never a false pass).
- Acceptance and test commands never inherit `NODE_TEST_CONTEXT`: a `node --test` started with it behaves as a child of another test runner and exits 0 without running a single test file.
- A computed module load that only appears in a comment of an acceptance file no longer refuses protection; literal loads are still collected from the original text, so the change can never freeze fewer files.
- Autonomous workspace permission is bound to one Mission, project, provider and model and requires explicit project trust.
- Acceptance files, package metadata and supported configuration files are hash-bound for the Mission; RAME Code tools cannot modify `node_modules`.
- Persistent memory and Mission state use shared atomic files with inter-window locking and damaged-file fail-closed behavior.
- Repository files, model output and tool output remain untrusted and cannot grant themselves persistent authority.
- A pending local-to-Meta disclosure card is specific to one thread, recipient, processing class, API-key revision, Meta model, mode, delegation, current request, decision set and every displayed message field. Recorded answers are bound to the thread, the recipient, the processing class, the API-key revision and the exact content (turn position plus a sha256 over role, time, text and host record); they are reused only between Meta's documented standard models. Incompatible older record formats and damaged records fail closed.
- New local messages, modified content, shifted turn positions and changed decision versions require a new disclosure answer. A disclosure choice never grants tools, changes a Mission grant or converts remembered conversation into project authority.
- Recovered conversation is labelled as untrusted historical context and placed before the current request. Only current authorized-memory versions are persistent project authority; earlier host facts remain past observations that must be rechecked.
- Mission recovery preserves its existing model/project-bound grant, frozen acceptance and host checkpoints. Recovered excerpts do not become Mission evidence or verified host facts.

### Known limitations

- The hackathon candidate prioritises functional behavior, explicit authority and reproducible evidence. Its interface, onboarding and logo are provisional and will be redesigned and polished in later releases.
- Vision is not integrated into the extension yet. A compatible runtime can load Muse Glimmer's separately supplied `mmproj`, but RAME does not attach images or send multimodal messages to local Glimmer or Meta cloud models.
- v0.2.0 is published as an experimental preview through a GitHub Release VSIX. Distribution validation is recorded separately from product claims; Visual Studio Marketplace publication is planned for a later release.
- `run_command` is experimental, has no operating-system sandbox and requires a separate independent security review and human validation before public distribution.
- Mission efficiency (deferred to a later version): after the second authorization of an empty-project Mission, Muse Glimmer still runs the authorized tests through model steps; the host does not yet run them directly on approval. Plans created before this candidate may contain a separate "run the tests and report" step, which costs an extra internal run; new plans are asked not to create such steps, but RAME cannot tell on its own whether a step written in prose is already satisfied.
- A passing acceptance check does not prove the code is correct: a weak check can be satisfied by returning the expected constants (sabotage case S6). At the protected level, code under test runs in the check's own process and can end it early with `process.exit(0)` (S11); only the reinforced level detects that. The reinforced cases are not secret: there is no sandbox, and a read of the cases file that the trace does not see is not detected. `node_modules` is excluded from the project fingerprint. On Windows a file changed and restored within one run is not seen (start and end only); projects with more than 2,000 files or 4 GiB cannot be protected. A scope review the user approves is the user's decision.
- Project fingerprinting is intentionally I/O-heavy: authorization reads every eligible byte once, and a protected run reads it at least before and after the check (once more after reinforced cases). Near the 4 GiB limit this can add substantial latency and disk traffic. A future version should evaluate an isolated verifier or a trustworthy incremental/change-journal design without weakening fail-closed behavior.
- Windows still needs real-machine validation. It claims only start/end content equality, not detection of a modification restored within a run; the preload and `NODE_OPTIONS` paths also need validation on an actual Windows host before stable publication.
- Autonomous verification currently supports Node/npm package scripts only. Python, Rust and Go project adapters are not implemented.
- Autonomous execution is not an operating-system sandbox; approved project scripts run with the VS Code user's permissions.
- Natural decision-source validation is deliberately conservative and its host-side vocabulary is verified only in English and Spanish.
- Agent and Chat history remains bounded and is never semantically rewritten by a model. Recovery in v0.2.0 is extractive and lexical, so paraphrases outside its morphology and small concept map can still be missed. Approved project-memory decisions and Mission host checkpoints are injected separately.
- The complete disclosure-control matrix (card, bounds, processing classes, credential binding, final request check and failure paths) is verified with a simulated Meta API that records each complete request. On 2026-11-04, human validation recorded three real Chat-only inferences with `muse-spark-1.3`; this validates the direct Chat connection, not cloud Agent tool results, Delegated, Mission planning or Advisory. Processing classes come from documented model ids kept in the code and must be reviewed when Meta's catalog or terms change.
- Secret redaction in tool results is pattern-based (keys, tokens, private keys, JWTs, URL credentials, `*_PASSWORD=`/`*-auth=`-style names). It reduces, but cannot exclude, sensitive content in files a Meta Agent is allowed to read: a bare value with no telling name or shape is not recognised, and harmless values may be redacted. Path replacement covers the open project folders and the home folder only; other absolute paths in content the user allows are sent as they appear, and URI-encoded forms (`file:///c%3A/…`) are not rewritten.
- The final request check recognises local text of 24 characters or more. Shorter local messages are kept out by how each request is built, verified path by path in automated tests (Chat, Agent and its tools, Delegated, Mission plan), not by detection.
- Plan entries listed on an Agent card are not part of Agent history, so Agent can send less than the card shows, never more.
- The continuity, consent and provider-handoff paths have automated coverage with simulated local and Meta servers. Real Meta Chat has one bounded human validation with fictitious data; real Glimmer, real Mission/reload and the remaining Meta paths still require their own human validation.
- A large recovered/recent context can reduce the space left for Agent tool schemas and tool results; the request is stopped with an explicit context error rather than silently truncating the current request, but the practical behavior still needs observation with Glimmer's real 32K window.
- Threads bound each individual turn's size and retain at most 50 threads, but do not yet cap the number of turns in one thread. Long-running threads therefore grow persisted storage (about 2.3 MB for the synthetic 3,000-turn audit case); no destructive cleanup policy is applied automatically.
- The recovered-context log proves what RAME selected and referenced, not that a model read, understood or used that context correctly. Its hashes are local provenance aids, not tamper-proof audit evidence.
- Meta escalation has automated coverage but still requires a final real-API validation for this candidate.
- The two legacy presentation assets `media/main.js` and `media/i18n.js` remain above the normal source-file target; their frozen size caps prevent further growth until they are split by UI responsibility.

### Architecture

- Enforce an approximate 16,000-token limit for each new implementation source file, not for a whole functional module; the three legacy monoliths are frozen and may only shrink during extraction.
- Established a `ProjectAdapter` boundary, preserving npm acceptance discovery as the first independently tested adapter.
- Moved VS Code workspace filesystem access, host-result summaries and live Mission leases behind small typed modules.
- Moved npm script discovery and Mission presentation/report construction out of the extension-host coordinator.
- Moved owned `llama-server` process lifecycle, health checks, diagnostics and idle shutdown into a dedicated runtime manager.
- Established the first `ModelProvider` boundary for Agent inference, with explicit llama.cpp-compatible local and Meta adapters and no silent fallback.
- Moved generation, Agent execution, Mission orchestration, checkpoint construction and project-memory host integration out of `mainProvider.ts` into typed controllers without changing the verified behavior.
- Reduced `mainProvider.ts` to the VS Code lifecycle, state-composition and message-routing shell; it now satisfies the same per-file context policy as new source files.
- Keep the remaining presentation exceptions frozen, documented and unable to grow until they are decomposed.

## [0.1.0] - 2026-11-02

The integrated hackathon baseline. It was not yet modular: most of the extension host lived in a single provider file.

### Added

- First public VS Code extension preview.
- Agent, Mission and Chat modes in one Activity Bar view.
- Meta Model API provider with user-owned credentials in SecretStorage.
- Managed Muse Glimmer text runtime through a loopback `llama-server`, using user-supplied executable and GGUF paths or an existing local OpenAI-compatible endpoint; model weights are not bundled.
- Explicit local-to-cloud escalation consent.
- Bounded workspace inspection, file operations, patches and allowlisted test execution.
- Ask, Safe auto and Workspace full permission profiles.
- One-use, digest-bound approvals with stale-precondition detection.
- Host-authored action records separated from model output.
- Persistent threads, cancellation and per-provider token accounting.
- Per-model reasoning, context and output-budget controls.
- Windows-aware path, process and test-command handling.
- English and Spanish installation documentation.

### Security

- Blocked absolute paths, traversal, symlink escapes and selected secret/control paths.
- Prevented repository and tool content from granting authority to itself.
- Discarded incomplete model responses before any partial tool call can run.

### Known limitations

- Persistent versioned project memory is not part of this release.
- Missions do not yet resume after a complete extension restart.
- Vision input is not active in RAME Code v0.1.0. A separately supplied Muse Glimmer `mmproj` may be loaded by the local server, but the extension does not yet attach images or send multimodal messages.
- The local audit is bounded but is not tamper-proof.
- Project test scripts run with the operating-system permissions of VS Code.

[Unreleased]: https://github.com/caimari/rame-code/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/caimari/rame-code/releases/tag/v0.3.0
[0.2.0]: https://github.com/caimari/rame-code/releases/tag/v0.2.0
[0.1.0]: https://github.com/caimari/rame-code/releases/tag/v0.1.0
