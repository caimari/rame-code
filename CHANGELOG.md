# Changelog

All notable changes to RAME Code are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

Candidate for 0.2.0. It introduces a modularized core, governed project memory, autonomous Missions, acceptance and causal verification, and a strict separation between Meta Advisory and Delegated execution. Modularization is not complete: the presentation assets `media/main.js` and `media/i18n.js` remain inherited exceptions.

### Added

- User-authorized, versioned project decisions with provenance and history.
- Verified-file bindings that become stale when a referenced decision changes.
- Persistent, resumable Missions with supervised and trusted autonomous-workspace execution.
- Two-stage bootstrap Missions for empty folders: the first explicit grant may scaffold implementation, `package.json` and tests but cannot run tests or complete the Mission; RAME then revokes that grant and waits for a second explicit authorization that reviews and optionally freezes the newly created verification files.
- Frozen acceptance checks that the Agent can read and run but cannot modify through RAME Code tools.
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
- Mission authorization now contains its complete Meta Advisory grant in the same card: the selected model and processing class, consultation count, default or custom byte/token limits, and the fact that Glimmer retains every tool. When cloud escalation and a key are already configured, one bounded consultation is visibly selected by default; choosing zero disables it for that Mission.
- Local Glimmer generation uses the model's verified reasoning control and a configurable output budget rather than a single fixed response limit.

### Fixed

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

- Autonomous workspace permission is bound to one Mission, project, provider and model and requires explicit project trust.
- Acceptance files, package metadata and supported configuration files are hash-bound for the Mission; RAME Code tools cannot modify `node_modules`.
- Persistent memory and Mission state use shared atomic files with inter-window locking and damaged-file fail-closed behavior.
- Repository files, model output and tool output remain untrusted and cannot grant themselves persistent authority.
- A pending local-to-Meta disclosure card is specific to one thread, recipient, processing class, API-key revision, Meta model, mode, delegation, current request, decision set and every displayed message field. Recorded answers are bound to the thread, the recipient, the processing class, the API-key revision and the exact content (turn position plus a sha256 over role, time, text and host record); they are reused only between Meta's documented standard models. Incompatible older record formats and damaged records fail closed.
- New local messages, modified content, shifted turn positions and changed decision versions require a new disclosure answer. A disclosure choice never grants tools, changes a Mission grant or converts remembered conversation into project authority.
- Recovered conversation is labelled as untrusted historical context and placed before the current request. Only current authorized-memory versions are persistent project authority; earlier host facts remain past observations that must be rechecked.
- Mission recovery preserves its existing model/project-bound grant, frozen acceptance and host checkpoints. Recovered excerpts do not become Mission evidence or verified host facts.

### Known limitations

- Autonomous verification currently supports Node/npm package scripts only. Python, Rust and Go project adapters are not implemented.
- Autonomous execution is not an operating-system sandbox; approved project scripts run with the VS Code user's permissions.
- Natural decision-source validation is deliberately conservative and its host-side vocabulary is verified only in English and Spanish.
- Agent and Chat history remains bounded and is never semantically rewritten by a model. Recovery in v0.2.0 is extractive and lexical, so paraphrases outside its morphology and small concept map can still be missed. Approved project-memory decisions and Mission host checkpoints are injected separately.
- The disclosure controls (card, bounds, processing classes, credential binding, final request check) are verified with a simulated Meta API that records each complete request, not yet against the real Meta Model API; the processing classes come from documented model ids kept in the code and must be reviewed when Meta's catalog or terms change.
- Secret redaction in tool results is pattern-based (keys, tokens, private keys, JWTs, URL credentials, `*_PASSWORD=`/`*-auth=`-style names). It reduces, but cannot exclude, sensitive content in files a Meta Agent is allowed to read: a bare value with no telling name or shape is not recognised, and harmless values may be redacted. Path replacement covers the open project folders and the home folder only; other absolute paths in content the user allows are sent as they appear, and URI-encoded forms (`file:///c%3A/…`) are not rewritten.
- The final request check recognises local text of 24 characters or more. Shorter local messages are kept out by how each request is built, verified path by path in automated tests (Chat, Agent and its tools, Delegated, Mission plan), not by detection.
- Plan entries listed on an Agent card are not part of Agent history, so Agent can send less than the card shows, never more.
- The continuity, consent and provider-handoff paths have automated coverage with simulated local and Meta servers. They still require real Glimmer, real Mission/reload and explicitly authorized real Meta validation with fictitious data.
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

[Unreleased]: https://github.com/caimari/rame-code/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/caimari/rame-code/releases/tag/v0.1.0
