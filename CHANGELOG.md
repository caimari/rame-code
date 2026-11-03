# Changelog

All notable changes to RAME Code are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- User-authorized, versioned project decisions with provenance and history.
- Verified-file bindings that become stale when a referenced decision changes.
- Persistent, resumable Missions with supervised and trusted autonomous-workspace execution.
- Frozen acceptance checks that the Agent can read and run but cannot modify through RAME Code tools.
- Host-verified Mission checkpoints, progress evidence, pause, resume, cancellation and bounded no-progress stopping.
- Explicit, user-approved local-to-Meta advice escalation with a local verification pass afterwards.
- Natural project-memory proposals in English and Spanish, with conservative host checks for negation, temporary instructions and exact boolean values.
- English and Spanish interface selection, project selection for multi-root workspaces, and candidate build information.

### Changed

- Replaced the extension-host monolith with a bounded composition shell plus dedicated generation, Agent, Mission and project-memory controllers; every TypeScript implementation file now fits the approximate 16,000-token source-file policy.
- Mission internal runs now receive a bounded host checkpoint instead of replaying earlier internal-run conversations. This keeps the cross-run context approximately flat while preserving the complete stored thread and evidence.
- Mission completion now depends on host-observed changes and successful tests after the last change; verified Missions additionally require the frozen acceptance command to pass.
- Mission setup and progress are presented in the conversation, with distinct planning, authorization, running, paused, blocked, interrupted and completed states.
- Local Glimmer generation uses the model's verified reasoning control and a configurable output budget rather than a single fixed response limit.

### Fixed

- Prevented model-authored text from impersonating the host record.
- Made malformed local tool-call replies recoverable within a bounded retry budget.
- Added exact-fragment editing with hash-bound approval and atomic rollback.
- Prevented negated or temporary user statements from becoming persistent project decisions without clarification.
- Prevented repeated Mission history from growing on every autonomous internal run.

### Security

- Autonomous workspace permission is bound to one Mission, project, provider and model and requires explicit project trust.
- Acceptance files, package metadata and supported configuration files are hash-bound for the Mission; RAME Code tools cannot modify `node_modules`.
- Persistent memory and Mission state use shared atomic files with inter-window locking and damaged-file fail-closed behavior.
- Repository files, model output and tool output remain untrusted and cannot grant themselves persistent authority.

### Known limitations

- Autonomous verification currently supports Node/npm package scripts only. Python, Rust and Go project adapters are not implemented.
- Autonomous execution is not an operating-system sandbox; approved project scripts run with the VS Code user's permissions.
- Natural decision-source validation is deliberately conservative and its host-side vocabulary is verified only in English and Spanish.
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

### Added

- First public VS Code extension preview.
- Agent, Mission and Chat modes in one Activity Bar view.
- Meta Model API provider with user-owned credentials in SecretStorage.
- Managed Muse Glimmer runtime through loopback `llama-server`.
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
- The local audit is bounded but is not tamper-proof.
- Project test scripts run with the operating-system permissions of VS Code.

[Unreleased]: https://github.com/caimari/rame-code/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/caimari/rame-code/releases/tag/v0.1.0
