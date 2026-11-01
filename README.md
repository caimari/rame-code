# RAME Code

**An experimental local-first coding agent for VS Code with verifiable, resumable missions.**

RAME Code is a new independent open-source project started during the Meta Global AI Developer Hackathon 2026. Its goal is to let a developer delegate a software mission without losing the decisions, evidence, and unfinished work that make the result trustworthy.

## Current status

Version `0.1.0` is an unverified local development base under active development — not released. It contributes exactly one Activity Bar view, `RAME Code`, with internal Chat ⇄ Settings navigation inside the same webview (gear opens Settings, Back returns to Chat; threads and running state are preserved; no second view or tab is created). The Chat screen header always shows `RAME Code` plus compact icon buttons (new thread, refresh, gear) that fit a 220px sidebar. With no thread selected it shows a home screen (scrollable full bounded thread list with honest update metadata, calm empty space); selecting a thread opens a dedicated conversation screen (back arrow to the list, compact thread title, existing Settings access; the full list is hidden there). A `backToList` exact-key message clears only the selection; thread data is never deleted. The conversation shows user/assistant cards, a structured Activity timeline inside the conversation, and an integrated prominent pending-approval card, with a unified rounded bottom composer card (textarea, disabled Add-context control, permission shield popover, compact Agent/Mission/Chat mode control defaulting to Agent, compact runtime button opening Settings, circular Send; Cancel appears only while running), connection/runtime state, and a usage summary. Local-unreachable failures show `Local model is not reachable at 127.0.0.1:8775. Start it in Settings.` with an Open Settings action instead of raw stacks, and never switch providers silently. New threads default to `Agent` mode (order `Agent`, `Mission`, `Chat`); persisted history is never rewritten. The single runtime selector lives in Settings only (`Muse Spark 1.3 — Meta cloud` or `Muse Glimmer — Local`); the host derives the provider+model pair from that one choice, so mismatched pairs cannot be sent or stored. The Settings screen groups Cloud, Local runtime, Escalation, Privacy/Security, and Diagnostics sections. The views reveal from the `RAME Code: Open RAME Code`, `RAME Code: New Thread`, `RAME Code: Set Meta API Key`, and `RAME Code: Start Mission` commands. Tests were not run for this change (shell-disabled authoring environment); no live Model API success is claimed and the UI is not verified until a human tests it. The key travels to the extension host only on explicit Save, is stored only in VS Code SecretStorage, and the view only ever learns whether a key exists.

Implemented in this slice: `Chat` mode (conversational prose; sends only the active thread's bounded recent history plus the new message — other threads are never sent), `Mission` mode (strict schema-constrained plan; sends only the new message, now with real plan-plus-usage accounting through a cancellation-safe runner), and `Agent` mode (bounded permission-gated tool-call loop with the explicitly selected provider only: local Glimmer via the configured `llama-server` or cloud `muse-spark-1.3`; never switched silently). Cloud provider is Meta Model API with `muse-spark-1.3`; a successful call marks the connection verified. Local provider is a direct OpenAI-compatible `llama-server` (Ollama is not required) bound to `127.0.0.1` only, spawned with an argument array and `shell: false`, with Start/Stop controls, startup health check, cancellation, idle shutdown, and ownership tracking that never kills processes RAME Code did not start. Cloud escalation defaults OFF with no silent fallback: a failed local request becomes a pending visible choice, and only an explicit approval sends that request to Meta. Token usage (input/output/cached/total) is shown per call and cumulatively per provider, including every Agent loop step; Meta Billing/Usage is authoritative and no balance is claimed.

Agent implemented boundaries: three original profiles defaulting to `ask` (every action needs approval), `safe-auto` (policy-checked reads auto-run; patches and tests need approval), and `workspace-full` (reads, patches, and allowlisted tests can run without prompts only after explicit selection, instantly reversible to Ask). The permission profile shows only in Agent mode with a concise description plus a collapsed Security/boundaries section; the workspace-full warning stays prominent while selected. Agent runs bind one explicitly QuickPicked workspace folder (name plus full path; cancellation is a concise cancelled status with no transcript change; a single folder auto-uses; no folder shows a friendly empty state with an Open Folder action) and every tool call stays under canonical-root/symlink checks; model/webview-supplied paths are never accepted and the first folder is never chosen silently. The selected workspace shows as a compact chip in the conversation header/activity area and a new thread never silently inherits an ambiguous target. The Settings local section orders `Use detected settings`, `Save`, `Start Muse Glimmer`, `Stop` with obvious runtime state. Even `workspace-full` stays inside the active workspace, blocks absolute/`..`/NUL/canonical/symlink escapes and protected `.git`, `.env*`, credential/key, secret-store, auth, and control files, allows only named test commands spawned executable-plus-argv with `shell:false` and time/output limits, performs no arbitrary shell or external network, and never bypasses cloud-escalation consent. Approvals bind one opaque action id plus a host-side digest to the exact payload, workspace, thread, provider, and file preconditions; stale, mismatched, replayed, used, or superseded approvals are rejected and cancellation invalidates pending approvals. Patches use path-plus-expected-hash preconditions with validate-then-write atomicity and verified digests. A bounded local audit records timestamps, provider, thread, profile, digest, decision source, and short results without content or secrets; tamper-proofness is not claimed. The first Agent coding validation must target a disposable copy or test fixture, not the live RAME Code repository.

Planned and NOT implemented: automatic escalation, persistent/resumable missions across restarts beyond the bounded audit/thread store, verified Glimmer-to-Spark cascade with return, live self-modification validation (deliberately not run here), broader machine portability beyond the detected local-runtime suggestions, and any claim of unrestricted computer control, arbitrary internet access, terminal emulation, or memory safety.

The first public implementation is being built during the hackathon in this repository. It is not copied from, and does not depend on, any earlier private implementation.

Fully local execution and data locality are design goals until validated, not established properties of this bootstrap.

Tests were not run for this change (shell-disabled authoring environment); no live Model API success is claimed and the UI is not verified until a human tests it.

## Planned hackathon MVP

The first installable VS Code extension is intended to:

- connect to **Muse Glimmer** through a local OpenAI-compatible endpoint such as llama.cpp, Ollama, or LM Studio;
- connect to **Muse Spark 1.3** through Meta Model API;
- offer local-only, remote-only, and policy-controlled hybrid execution;
- run a bounded coding loop that can inspect files, propose changes, and execute verification commands;
- preserve an explicit mission goal, user-authorized versioned decisions, changed files, test evidence, and remaining work across restarts;
- detect when verified work has become stale after a decision changes;
- evaluate a reversible Glimmer-to-Spark cascade under an authorized data and cost budget.

These are development goals, not claims about the current bootstrap.

## Technical hypothesis under evaluation

The hypothesis to be tested is a reversible local-to-remote cascade:

1. Muse Glimmer works locally on the assigned mission.
2. An observable, verifier-backed blocker can trigger bounded Muse Spark 1.3 assistance.
3. The relevant verifier is rerun after the assisted change.
4. When recovery is verified and cooldown rules allow it, work returns to Glimmer without losing the mission state.

No novelty or superiority is claimed before evaluation. The comparison to be reported is between candidate cascade policies, not against other systems.

## Core idea

RAME Code does not treat a chat transcript as project truth. A mission keeps a small, inspectable record of:

```text
goal -> authorized decisions -> changes -> verification evidence -> current state
```

Models may observe, reason, and propose. Durable decisions, permissions, and promotion of a candidate release remain under explicit user control.

Previously authorized policies can permit routine actions without repeated prompts. Scope expansion, out-of-policy remote data, and candidate release promotion require control.

## Model modes

| Mode | Intended behavior |
| --- | --- |
| Local | Muse Glimmer runs on the user's hardware. Keeping project data local is a design goal until validated. |
| Remote | Muse Spark runs through Meta Model API while tools remain local. |
| Hybrid | Glimmer works locally and RAME Code may request bounded Spark assistance when observable, verifier-backed progress rules identify a blocker, then return to Glimmer when recovery is verified and cooldown rules allow it. |

## Trust principles

- Repository content, tool output, and model output are untrusted inputs.
- A model cannot grant itself durable authority.
- Remote transmission must stay within the user's approved scope and budget.
- Candidate changes must be shown and verified before promotion.
- A future version cannot silently weaken the checks that authorize its installation.

## Planned cascade comparison

Using the same tasks and models, the planned evaluation compares ascending-only escalation against verified return, measuring task success, cost, latency, verification overhead, and oscillations between models.

## Development provenance

- Public implementation start: **2026-10-31**.
- Competition: **Meta Global AI Developer Hackathon 2026**.
- Track: **Indie Developer**.
- Repository: <https://github.com/caimari/rame-code>
- Author: **Antoni Caimari Caldés**.

Design choices are informed by Antoni Caimari Caldés's prior private experiments. All public implementation code and Git history start independently in this repository on 2026-10-31; no private code, services, data, documents, results, or history are included or required. Only independently reproduced public results may be claimed.

Development milestones and model/tool participation are recorded in [`HACKATHON_WORK.md`](HACKATHON_WORK.md).

## Roadmap

- `0.1.0`: installable extension, secret-backed Meta Model API connection, and structured mission planning.
- `0.2.0`: bounded read-only workspace inspection and verifier execution.
- `0.3.0`: persistent and resumable missions.
- `0.4.0`: reversible policy-controlled Glimmer-to-Spark cascade with verified return to Glimmer.
- Hackathon release: reproducible demo, packaged VSIX, independent verification, and frozen evidence.

The roadmap may be reduced to protect reliability. Only implemented and reproducible behavior will be presented as complete.

## Development

Requirements:

- Node.js 22 or later for the complete development and packaging toolchain;
- VS Code 1.95 or later;
- a separate Meta Model API key with access to `muse-spark-1.3`.

```bash
npm ci
npm run check
npm run package
```

Press `F5` in VS Code to open an Extension Development Host. Then run:

1. `RAME Code: Set Meta API Key`
2. `RAME Code: Start Mission`

The API key is stored in VS Code SecretStorage. The current mission command sends only the goal entered in the prompt to Meta Model API; it does not read or transmit workspace content.

Do not commit API keys or local model files. RAME Code will require users to supply their own model endpoints and credentials.

## License

Licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 Antoni Caimari Caldés.
