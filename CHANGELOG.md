# Changelog

All notable changes to RAME Code are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- User-authorized, versioned project decisions.
- Stale-artifact detection and resumable missions.

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
