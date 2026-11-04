# Hackathon Work Log

This log separates work created during the Meta Global AI Developer Hackathon 2026 from prior private research and products. Design choices are informed by Antoni Caimari Caldés's prior private experiments. All public implementation code and Git history start independently in this repository on 2026-10-31; no private code, services, data, documents, results, or history are included or required. Only independently reproduced public results may be claimed.

## 2026-10-31 — Repository bootstrap

- Created a new, independent Git repository.
- Added the Apache-2.0 license, English README, and ignore rules.
- Declared the planned Muse Glimmer local and Muse Spark 1.3 remote architecture.
- Added no functional agent or extension code.
- Attempted to invoke Muse Code 1.4.10 with `muse-spark-1.3` in Standard mode and without write or shell permissions. The call did not run because Muse credentials are stored under a different operating-system account. No model-generated content was attributed to this bootstrap.

## 2026-10-31 — Muse Code documentation review

- Reviewed `README.md` and `HACKATHON_WORK.md` only.
- Refined the product message to describe a reversible local-to-remote cascade as the evaluated technical hypothesis.
- Made no functional implementation change: no agent or extension code was added or modified.
- Documentation assistance is recorded here separately from functional implementation.

## 2026-10-31 — Version 0.1.0 vertical slice

- Used Muse Code 1.4.10 with `muse-spark-1.3`, Contributor Mode off, and no write or shell permission to propose and later review a minimal extension slice.
- Human review corrected the proposed Meta Model API contract before integration: Standard mode is selected by model ID `muse-spark-1.3`; no invented `mode` request field is sent.
- Added API-key storage through VS Code SecretStorage and a bounded command that sends only a user-entered mission goal to Meta Model API.
- Added strict schema-constrained mission plans, defensive response parsing, cancellation, concurrent-run prevention, and unit tests.
- The Muse review incorrectly reported that a test expected a redacted key because its safe review view replaced the test credential. The actual test uses a synthetic key and passed; valid findings from the review were fixed and retested.
- No live Model API call from the extension has yet been claimed. A separate user-supplied Model API key is still required for that verification.
- The extension currently has no workspace read, write, or shell capability.

## 2026-10-31 — Local panel base (unverified)

- Implemented by Muse Code 1.4.10 with `muse-spark-1.3`, Contributor Mode off, under the architect's requirements: no shell, no commits, repository-local changes only.
- Added a provisional original SVG icon (`media/rame-icon.svg`) and a RAME Code Activity Bar container with a movable Mission webview view.
- Added a native-feeling webview panel (connection status, password key input, Save/Clear key, multiline mission input, Start/Cancel, status and plan areas) with strict CSP, nonce-protected local script/style, no remote content, validated messages, and disposable lifecycle handling.
- Key handling: the key travels webview-to-host only on explicit Save, is stored only in VS Code SecretStorage, and the webview receives only a boolean `hasKey` flag; it never appears in HTML, logs, config, or error text.
- Kept the `createMissionPlan` provider and `muse-spark-1.3`; missions run through a shared runner with AbortController cancellation and concurrent-run prevention. Palette commands reveal the panel and cooperate with it. Still no workspace read/write or shell capability.
- Added pure modules (`src/webviewMessages.ts`, `src/panelState.ts`, `src/panelHtml.ts`, `src/missionRunner.ts`) and `node:test` coverage for message validation, key non-disclosure/state, and runner behavior.
- Status: unverified local development base, not released. Tests were not run here (shell disabled); the architect runs them afterward. No live API success may be claimed until human testing with a user-supplied key.

## 2026-10-31 — Coding-agent shell base (unverified)

- Implemented by Muse Code 1.4.10 with `muse-spark-1.3`, Contributor Mode off, under architectural requirements: no shell, no commits, repository-local changes only.
- Replaced the mission-form prototype with a Chats view (thread list, transcript, composer, Mission-only mode, Muse Spark 1.3-only model) and a Settings view (connection state, separate Meta Model API key, Save/Clear), sharing one runner and one versioned `globalState` thread store (bounded to 50 threads, validated/migrated, key-free).
- Each send transmits only the newly submitted composer text; earlier thread content is never sent. Muse Code subscription credentials are not reused. Added pure unit tests for thread-store validation/bounds/titles, both view protocols, no-key outbound state, and independent-message behavior; kept existing runner/provider/security tests.
- Status: unverified local development base, not released. Tests were not run here (shell disabled); the architect runs them afterward. No agent tools, workspace read/write, shell execution, or local-model support yet.

## 2026-11-01 — Single-view product slice (unverified)

- A canary succeeded on 2026-11-01 using Muse Code 1.4.14 and `muse-spark-1.3`, Contributor Mode off. Subsequent account evidence showed that the canary and implementation used the active Muse Code Everyday subscription rather than pay-as-you-go credits: the subscription window reached 100%, while the Meta Model API pay-as-you-go dashboard still displayed EUR 0.00 (the dashboard notes that reporting can be delayed). This attribution supersedes the initial assumption that the separate API key had taken priority.
- Implemented by Muse Code under the architect's requirements: no shell, no commits, repository-local changes only, no new dependencies.
- Replaced the two stacked `Chats`/`Settings` views with exactly one `RAME Code` webview view (`rameCode.main`) with internal Chat ⇄ Settings navigation; state and the active thread survive navigation. Obsolete providers/HTML/media were unregistered from the runtime and excluded from compilation and VSIX packaging (physical `git rm` of `src/chatsProvider.ts`, `src/settingsProvider.ts`, `src/chatsHtml.ts`, `src/settingsHtml.ts`, `src/panel.ts`, `src/panelHtml.ts`, and `media/{chats,settings,panel}.*` left for the architect — no delete tool was available).
- Replaced the icon with an original capital-`R` SVG using explicit white fill/stroke on a transparent background.
- Added `Chat` (bounded active-thread history) and `Mission` (new message only) modes; user turns persist and render before the network call and assistant/plan results render immediately after. No Agent/workspace execution, file-write, or shell tools were added.
- Added a direct `llama-server` local provider (loopback-only, `shell: false` spawn, Start/Stop, health check, idle shutdown, owned-child-only stop, optional unowned external loopback endpoint), escalation default-OFF with explicit-approval-only pending choice, and per-call/cumulative Cloud/Local token usage (Meta Billing/Usage authoritative; no balance claimed; monetary figures only as labeled estimates from dated named rates).
- Extended `node:test` coverage for the unified protocol, navigation state, Chat vs Mission construction, bounded context, provider selection, local arg/path/numeric validation, loopback enforcement, ownership transitions, escalation defaults, usage accounting, and secret non-disclosure. Fixed no test expectations; noted that the `meta-provider` Authorization assertion already expects the real test key on disk (the `[REDACTED]` rendering is a safe-view mask).
- Independent architect verification after the Muse edit compiled the project and ran 65 tests: 64 passed and one CSP test failed because it rejected an inert loopback endpoint placeholder. The slice is therefore not accepted, packaged, installed, or released. Mission usage accounting also remains under review. The UI is not verified until a human tests it.

## 2026-11-01 — Local Glimmer tool-calling canary

- Loaded the already-downloaded `Muse-Glimmer-30B` Q4_K_M GGUF with the repository-external `llama.cpp` runtime, DFlash draft model, and multimodal projector. The temporary server was bound only to `127.0.0.1:8775`; no Meta Model API request was involved.
- In the first controlled request, Glimmer returned `finish_reason: tool_calls` and an exact structured `read_file` call for `package.json` rather than inventing file contents (505 total tokens).
- In the second controlled request, Glimmer consumed a synthetic tool result and returned only the requested package name without issuing a spurious write or claiming an unperformed action (600 total tokens).
- No workspace tool was actually exposed, no file was read or modified by the model, and the temporary local server was stopped immediately after the canary.
- Result: the local model demonstrated the protocol behavior needed for a future permission-gated Agent loop. This does not yet demonstrate safe workspace execution, patch application, test execution, or autonomous self-modification.

## 2026-11-01 — Permission-gated Agent slice plus slice-close fixes

- Implemented by Muse Code 1.4.14 with `muse-spark-1.3` through Meta Model API, Contributor Mode off. API-mode implementation work began at approximately 00:32 CET and independent verification concluded around 01:08 CET on 2026-11-01. Meta Billing/Usage remains authoritative for cost; no exact spend is claimed here.
- Phase A: fixed `test/view-html.test.ts` to allow the intentional inert loopback `placeholder="http://127.0.0.1:8775"` while keeping strict CSP coverage (no remote `src`/`href`/`action`/CSP sources, `connect-src 'none'`, `default-src 'none'`); added `MissionRunner.startWithUsage` (cancellation/concurrency-safe, returns real plan-plus-usage via `createMissionPlanWithUsage`, legacy `start` preserved) and switched the cloud Mission path to record real usage. Added `test/mission-usage.test.ts`.
- Phase B: added original permission-gated `Agent` mode beside `Chat`/`Mission` for the explicitly selected provider only (local Glimmer via configurable `llama-server` or cloud `muse-spark-1.3`; no silent switching). Profiles `ask` (default/safest), `safe-auto`, and `workspace-full` persist only the profile id and fall back to `ask` on unknown state. Small typed tool allowlist only (`list_files`, `search_text`, `read_file`, `apply_patch`, `run_tests`); no generic shell. Policy confinement to the held single workspace root with absolute/`..`/NUL/canonical/symlink, protected secret/control path, and size/count/output/step/test-duration bounds. Structured patches with hash preconditions and validate-then-write atomicity. Test commands from safe package scripts only, spawned executable-plus-argv with `shell:false`, timeouts, and cancellation. One-approval-one-action binding with host-side digests over the exact payload plus workspace/thread/provider/preconditions; stale/mismatched/replayed/used/superseded approvals rejected and cancellation invalidates pending approvals. Bounded tool loop runs serially with the same model, bounded active-thread context only, and stops on reply/rejection/cancel/policy/budget/provider-error/stale workspace. Bounded local audit (timestamps, provider, thread, profile, digest, decision, short result; no content/secrets; tamper-proofness not claimed). Single-webview shield/profile selector, active-profile description, boundaries text, disposable-copy warning, pending-action view (tool, targets, exact patch/command, provider, workspace, digest), approve/reject by id-plus-digest, and transcript/action log; DOM/`textContent` only, no `innerHTML`. Separated Cloud/Local usage includes every Agent step.
- The prior local canary established structured tool-call compatibility but not safe execution; this slice adds the policy, approval, patch-integrity, and audit boundaries plus pure `node:test` coverage and docs. The live self-modification validation was deliberately not run here; first Agent coding validation must target a disposable copy or test fixture, not the live repository.
- Hardening added after independent review: canonical/parent-symlink confinement, rollback removes newly created files and verifies restoration, `run_tests` approval binds the exact resolved command, script, and `package.json` hash and revalidates before spawn, and a truthful Workspace-full warning.
- Limitation: package scripts are not OS-sandboxed and execute with the user's permissions. Ask/Safe-auto require confirmation; Workspace-full may run them without prompting and is high risk. There is no arbitrary shell tool, but that does not make project scripts harmless.
- Independent verification result: TypeScript compiled; 118/118 `node:test` tests passed; `npm audit --omit=dev` reported 0 vulnerabilities; `git diff --check` clean; secret-pattern repository scan returned no matches. UI/live extension interaction is still pending until the VSIX is packaged, installed, and human-tested.
- No live self-modification has been run: the local Glimmer canary demonstrated structured tool-call protocol compatibility only, not safe workspace execution. First Agent coding validation must target a disposable copy or test fixture, not the live repository. No API key appears in code, messages, logs, state, diagnostics, tests, docs, or fixtures; SecretStorage plus boolean key state only. No silent cloud escalation and no private/pre-existing code or service dependency.

## 2026-11-01 — Runtime UX correction and API usage checkpoint

- The observed Meta Model API authoring window ran from approximately 00:32 to 01:47 CET (about 1 hour 15 minutes elapsed, including human review, independent tests, packaging, and pauses). Muse Code 1.4.14 used `muse-spark-1.3` in Standard mode with Contributor Mode off.
- At the 01:47 CET dashboard checkpoint, free credits remaining were USD 136.76 from the initial USD 150.00: USD 13.24 of cumulative credits used. The dashboard reported 52.5M input tokens, a 95.8% aggregate cache-hit rate, 420.5K output tokens, and 954 requests. These are rounded, dashboard-wide figures; requests are individual model/API turns, not human prompts, and Meta Billing/Usage is authoritative.
- Relative to the immediately preceding checkpoint (USD 140.46 remaining, 32.9M input, 284.7K output, 723 requests), this correction/verification segment added USD 3.70, approximately 19.6M input tokens, 135.8K output tokens, and 231 requests. The dashboard does not expose an exact segment-only cache rate in that view.
- Corrected the human-facing runtime UX after direct visual review: the main composer can no longer represent a Cloud/Local mismatch; runtime is one exact choice in Settings (`Muse Spark 1.3 — Meta cloud` or `Muse Glimmer — Local`), a compact gear remains visible in narrow sidebars, Settings has Back navigation, and Agent boundaries are collapsed while the Workspace-full warning remains prominent.
- Independent verification after the UX correction: TypeScript compiled, 124/124 `node:test` tests passed, `npm audit --omit=dev` reported 0 vulnerabilities, and the local VSIX was rebuilt and installed for human testing. VSIX SHA-256: `ff4ab728352d21e677805ff8904bb52303c2b58db966e6fc8dd891531f5e84cf`. Human visual/runtime validation remains pending; no release, commit, or push is claimed.

## 2026-11-01 — Conditional Settings and model catalog correction

- Correction window: 01:58:18–02:06:43 CET (8 minutes 25 seconds elapsed, including Muse implementation, independent review, tests, packaging, and installation).
- Meta Usage checkpoint captured at 02:13 CET: USD 131.31 free credits remained from the initial USD 150.00, so cumulative credits used were USD 18.69. The dashboard headline reported 83.4M input tokens, a 96.1% aggregate cache-hit rate, 609.7K output tokens, approximately 1.4K requests, and 0 images. The visible output-chart tooltip showed 609.1K rather than the 609.7K headline; both displayed values are retained here instead of inventing precision.
- Relative to the preceding 01:47 checkpoint (USD 136.76 remaining, 52.5M input, 95.8% aggregate cache hit, 420.5K output, 954 requests), this correction window corresponds to USD 5.45 additional credits, approximately 30.9M additional input tokens, approximately 188.6K–189.2K additional output tokens, and roughly 446 additional requests if the rounded `1.4K` display is interpreted as 1,400. Because the request total is rounded and dashboard reporting may lag, the exact request delta is not claimed. From the rounded aggregate figures, the segment's cache-hit rate is approximately 96.6%; Meta does not display that segment-only value directly.
- Fixed a human-observed functional defect: `Use detected settings` changed host state but did not populate the visible fields. Non-secret local settings and a bounded revision now reach the webview; first render and explicit detection visibly populate the complete form without overwriting a field being edited.
- Runtime-specific Settings are now conditional. Local selection hides the cloud key/catalog and shows only local configuration plus explicit escalation controls; Cloud selection hides local controls and shows the key plus compatible Meta cloud models.
- Added a bounded host-side Meta Model API catalog refresh using `GET /v1/models`. Only enabled `muse-spark-*` and `muse-wonder-*` text/agent models are shown; incompatible Image, Voice and SAM endpoint families are excluded. Contributor variants are explicitly labeled and are never selected silently.
- Local startup is atomic: one exact-key message carries the visible configuration, which the host validates and persists before a direct loopback-only `llama-server` spawn. The previous save/start message race is removed.
- Independent verification: TypeScript compiled, 133/133 `node:test` tests passed, `npm audit --omit=dev` reported 0 vulnerabilities, and the VSIX was rebuilt and installed. VSIX SHA-256: `62bdffee35dcb17d2267e8ace0442a4ad20a58b88391cfdefbd8fad613352562`. Human visual and live-runtime validation remain pending; no release, commit, or push is claimed.

## Meta API usage logging protocol

- After every Meta Model API implementation window, request a fresh dashboard checkpoint before closing the work block.
- Record the start/end time and elapsed duration; free credits remaining and cumulative credits used; input tokens; aggregate cache-hit rate; output tokens; requests; and any other explicitly labeled modality count.
- Record both the cumulative values and the delta from the immediately preceding checkpoint. Mark rounded values, dashboard discrepancies, inferred segment values, and reporting delay explicitly; never present an inference as an exact billable figure.
- Requests are API/model turns, not human prompts. Meta Billing/Usage remains authoritative.

## 2026-11-01 — Agent sidebar UX correction (unverified)

- Default mode for every new thread is now `Agent`; mode order/labels are `Agent`, `Mission`, `Chat`. Persisted thread content is never rewritten; only the composer default resets and `ask` remains the permission default.
- Replaced the multi-root hard error with a native extension-host QuickPick showing folder name plus full path. Explicit choice binds the canonical root to that run and every tool call; cancellation is a concise cancelled status with no transcript change; a single folder auto-uses; no folder shows a friendly empty state with an Open Folder action. Canonical/symlink checks preserved; model/webview paths never accepted; first folder never chosen silently. New threads clear the displayed target so ambiguous reuse cannot happen silently.
- Redesigned the single webview with local HTML/CSS/JS and theme variables only (no framework, remote assets, `innerHTML`, `eval`, or CSP weakening): compact header, secondary recent list, primary conversation cards, structured Activity timeline, collapsible scope/boundaries, modal-like pending-approval card with exact action/targets/digest binding summary, bottom composer with runtime/permission/workspace chips, and an empty state directing to a new Agent thread. Host one-use/hash-bound verification is unchanged; UI is not the authority.
- Async buttons (Save, Start Muse Glimmer, Stop, model refresh, Send, and others) now disable while pending, show explicit labels (`Saving...`, `Starting...`, `Stopping...`, `Loading models...`, `Running...`) plus progress styling, prevent duplicate clicks, and only report success after host confirmation; long local startup keeps progress visible.
- Tests: updated mode order/default expectations and added pure `node:test` coverage for mode defaults, webview structure, async pending labels, and multi-root selection policy/helpers. Existing security boundaries, provider isolation, SecretStorage, loopback-only runtime, atomic patching, exact approval binding, protected paths, and tests preserved.
- Status: unverified local development base, not released. Tests were not run here (shell-disabled authoring environment); no commit, push, publish, release, version change, or co-author attribution occurred.

### Independent verification and local installation

- Implementation and correction window: 02:44:36–02:51:10 CET (6 minutes 34 seconds elapsed, including two Muse API runs, independent review, two full test executions, audit, packaging, and installation). Muse Code 1.4.14 used `muse-spark-1.3` with Contributor Mode off. The post-window Meta Billing/Usage checkpoint is pending and will be recorded separately; the prior checkpoint remains USD 131.31 free credits, 83.4M input tokens, 96.1% aggregate cache hit, 609.7K headline output tokens (609.1K tooltip), and approximately 1.4K requests.
- The first independent run compiled successfully and produced 140/142 passing tests. The two failures were obsolete/brittle test expectations introduced by the UI change, not accepted as a pass. Muse then made two test-only corrections that retained substantive coverage; no production file changed in that correction.
- Final independent verification: TypeScript compiled; 142/142 `node:test` tests passed; `npm audit --omit=dev` reported 0 vulnerabilities; and `git diff --check` was clean. The multi-root host path was also manually reviewed: the native picker obtains candidates only from VS Code's open workspace folders, validates the chosen path against that same set, and binds the selected root to the run; model/webview paths are not accepted.
- The VSIX was rebuilt and installed locally for human testing. SHA-256: `8d67e099b2c9a132501acfd92de738ca101719f78d8f47a0b91ef6134aa326c8`. Installed extension: `caimari.rame-code@0.1.0`; the existing `ramesystem.rame-code@4.18.19` remained installed and untouched.
- No commit, push, public release, package publication, or version change occurred. Visual behavior, native workspace selection, approval presentation, and the complete local Agent run still require human validation before this base is accepted.

### Meta Billing/Usage checkpoint after the Agent sidebar correction

- Post-window dashboard checkpoint supplied after installation: outstanding pay-as-you-go balance EUR 0.00; USD 127.52 free credits remained from the initial USD 150.00, so cumulative free credits used were USD 22.48. The dashboard reported 100.7M input tokens, a 96.2% aggregate cache-hit rate, 718.5K headline output tokens, approximately 1.6K requests, and 0 images. The visible output-chart tooltip showed 717.8K rather than the 718.5K headline; both displayed values are retained.
- Relative to the immediately preceding checkpoint (USD 131.31 remaining; 83.4M input; 96.1% aggregate cache hit; 609.7K headline output / 609.1K tooltip; approximately 1.4K requests; 0 images), the complete Agent-sidebar implementation and test-correction window used USD 3.79, added approximately 17.3M input tokens, approximately 108.7K–108.8K output tokens, and roughly 200 requests. Request totals are rounded to one decimal thousand, so the request delta is not exact.
- From the rounded aggregate input/cache figures, the segment-only cache-hit rate is approximately 96.7%; Meta did not display that segment value directly, so it is recorded as an inference rather than an exact billing measurement. Outstanding balance remained EUR 0.00 because free credits were still in use.

## 2026-11-01 — Coherent sidebar UX: home, conversation, unified composer (unverified)

- Implemented repository-local changes only under architect requirements: no shell, no commits, no version change, no proprietary copying; original RAME Code layout with VS Code theme variables only.
- Navigation: one registered webview with internal navigation kept. No thread selected renders a home screen (compact header, new/refresh/Settings toolbar, scrollable full bounded thread list with honest update metadata only, calm empty space, composer fixed at bottom). Selecting a thread opens a dedicated conversation screen (back arrow posting exact-key `backToList`, compact thread title, existing Settings access; full list hidden). Settings Back returns to the correct prior home/conversation state. New thread opens a blank Agent-default composer without creating a persisted empty thread until first valid send.
- Conversation: selected thread is the primary scrollable area with user/assistant cards; Agent progress renders as compact structured activity rows inside the conversation; pending approval stays host-authoritative and prominent but integrated; boundaries/diagnostics stay collapsed; empty/running/success/cancelled/error states are explicit. Local/provider failures replace generic `Request failed.` with concise actionable detail (local unreachable uses `Local model is not reachable at 127.0.0.1:8775. Start it in Settings.` plus an Open Settings action; no raw stacks, no silent cloud switch).
- Composer: one rounded cohesive card fixed at bottom; textarea main area; toolbar with safely disabled Add-context control (coming later), permission shield popover (Ask `ask`, Safe auto `safe-auto`, Workspace full `workspace-full` with honest descriptions and Workspace-full risk emphasis; posts existing `setAgentProfile`), compact Agent/Mission/Chat mode control (Agent default), compact runtime button opening Settings (no invented providers), circular Send with Cancel only while running; narrow 220–500px safe with wrapping, keyboard accessible (Esc/outside-click closes menu), no horizontal overflow; microphone omitted as unsupported.
- Async/runtime: Send/Save/Start/Stop/model-refresh/approval keep disabled plus spinner/status pending labels and confirm only after host state. Reload reflects stopped/unreachable local state from the documented ownership model (no lifecycle persistence). Multi-root native QuickPick with exact choice, canonical binding, and cancellation is preserved; selected workspace shows compactly in the conversation status.
- Security: local HTML/CSS/JS only; strict CSP unchanged; DOM plus `textContent` only (no `innerHTML`/`eval`/remote assets); SecretStorage hasKey-only contract, loopback-only runtime, provider isolation, atomic patch/rollback, protected paths, hash-bound one-use approvals, exact-key validation, and bounded audit/threads preserved.
- Tests: added `test/home-conversation.test.ts` covering home vs conversation structure, full thread rendering, `backToList` exact keys, Agent default/order, permission mapping, actionable unreachable-local error, pending states, and CSP/no-`innerHTML`. Existing security tests were not weakened.
- Status: unverified local development base, not released. Tests were not run here (shell-disabled authoring environment); no commit, push, publish, release, version change, or co-author attribution occurred.

### Independent verification and local installation

- Complete implementation/review window: 03:09:20–03:19:24 CET (02:09:20–02:19:24 UTC), 10 minutes 4 seconds elapsed. Four Meta Model API authoring calls used Muse Code 1.4.14 with exact model `muse-spark-1.3`, Standard mode, Contributor Mode off. The window included initial implementation, two test-only corrections, an architect-requested production UX polish, independent review, repeated full tests, audit, packaging, and installation.
- The first full run compiled but produced 149/150 tests because a new test incorrectly searched inline HTML for a scroll rule stored in the local CSS asset. The first test-only correction exposed a second expectation that incorrectly searched static HTML for a class created safely at runtime with DOM/textContent. Neither partial result was accepted. After the second test-only correction, 150/150 passed.
- Manual architect review then found a real UX deficiency not caught by the passing suite: the new composer still coexisted with a duplicate legacy permission form/action log, and runtime was absent from the home composer. Muse made a production correction: the legacy controls remain internal and hidden, runtime appears once in the shared composer, Workspace-full keeps a compact visible warning, structured Activity remains visible, and status/usage/audit details are grouped under one collapsed conversation-scoped `Run details` disclosure.
- Final independent verification after that production correction: TypeScript compiled; 153/153 `node:test` tests passed; `npm audit --omit=dev` reported 0 vulnerabilities; and `git diff --check` was clean. Packaging repeated the full 153-test suite successfully.
- Local VSIX installed for human testing: `caimari.rame-code@0.1.0`, SHA-256 `de4c56db79ead915dde5606da99636fd536e4b2f879bfbd56bbb3bcb9bf5a513`. Existing `ramesystem.rame-code@4.18.19` remained installed and untouched.
- No commit, push, public release, package publication, version change, proprietary code inspection/copying, or co-author attribution occurred. Human visual acceptance and the complete local Agent editing run remain pending.

### Meta Billing/Usage checkpoint after the coherent-sidebar window

- Post-window dashboard checkpoint: outstanding pay-as-you-go balance EUR 0.00; USD 122.96 free credits remained from the initial USD 150.00, so cumulative free credits used were USD 27.04. The dashboard reported 119.7M input tokens, a 96.0% aggregate cache-hit rate, 902.2K output tokens, approximately 2K requests, and 0 images. The billing page also displayed its separate notice that content used with free credits may be used for product improvement; this account-level notice is recorded independently from the per-run `--contributor-mode off` setting and is not represented as being overridden by that flag.
- Relative to the immediately preceding checkpoint (USD 127.52 remaining; 100.7M input; 96.2% aggregate cache hit; 718.5K output; approximately 1.6K requests; 0 images), the coherent-sidebar implementation/review window used USD 4.56, added approximately 19.0M input tokens, 183.7K output tokens, and roughly 400 requests. Both request totals are dashboard-rounded, so the request delta is not exact.
- From the rounded aggregate figures, the segment-only cache-hit rate is approximately 94.9%; Meta did not display that segment value directly, so this is an inference rather than an exact billing measurement. Outstanding balance remained EUR 0.00 because free credits were still active.

## Provenance boundary

- This repository must not copy code or Git history from any earlier private implementation.
- This repository must not depend on any earlier private implementation, service, or prototype.
- Standard open-source dependencies may be used under their respective licenses.
- Every released capability must be reproducible from this repository and documented with the model, tools, tests, and human intervention involved.

## Development-assistance and budget decision

- **Antoni Caimari Caldés is RAME Code's human architect, product lead, maintainer and release decision-maker.** Muse Code, Muse models, OpenAI Codex and Claude Code are development or audit assistants operating under his direction; they are not identified as the project's architect.
- The original development plan was to build RAME Code primarily with Muse Code and Meta Muse models. The early slices documented above used Muse Code 1.4.x with exact model `muse-spark-1.3`, directed and reviewed by the human maintainer.
- Meta's dashboard recorded USD 150.00 in initial free credits and USD 122.96 remaining after the intensive early implementation windows: USD 27.04 used, approximately 18% of the initial amount. These are cumulative, potentially rounded or delayed dashboard figures rather than a per-feature bill; Meta Billing/Usage remains authoritative.
- The human maintainer then chose to reserve the remaining Meta credits for RAME Code inference, real-API validation and demonstrations. This was a budget-allocation decision, not evidence that Muse was unable to implement the software.
- Subsequent construction and review combined existing access to OpenAI Codex and Claude Code, local Muse Glimmer, and human product direction, architecture, prompting, approval and testing. The Git author identifies the human integrator; it does not by itself identify which assistant contributed each line.
- Exact line-by-line or percentage attribution is not claimed where the evidence cannot establish it. Mixed work remains labelled as mixed or unknown. Autonomous Glimmer changes produced in disposable self-improvement trials are distinguished from changes actually integrated into a public release.
- Supported models, development assistants and models used in a final demonstration are separate facts. The final demonstration models will be recorded only after the corresponding run has been verified.

## 2026-11-02 — Public preview v0.1.0

- Consolidated the independently implemented Agent, Mission and Chat slices into the first installable public preview.
- Added local Muse Glimmer execution through a managed loopback `llama-server` and cloud execution through user-selected Meta Model API models.
- Added bounded tools, explicit permission profiles, one-use hash-bound approvals, stale-precondition checks, verified host records and Windows-aware path/process handling.
- Added per-model reasoning, context and output-budget controls. Incomplete generations are discarded before any partial action can run.
- Added English and Spanish installation documentation plus a public changelog.
- The release intentionally does not claim persistent versioned project decisions, restart-resumable missions, automatic escalation or tamper-proof execution; those remain future work.
