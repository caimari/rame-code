# RAME Code

**An experimental local-first coding agent for VS Code with verifiable, resumable missions.**

RAME Code is a new independent open-source project started during the Meta Global AI Developer Hackathon 2026. Its goal is to let a developer delegate a software mission without losing the decisions, evidence, and unfinished work that make the result trustworthy.

## Current status

Version `0.1.0` is under active development. Its first bounded vertical slice lets a user store a Meta Model API key in VS Code SecretStorage, submit a mission goal to Muse Spark 1.3, and inspect a schema-constrained plan in a dedicated output channel.

The first public implementation is being built during the hackathon in this repository. It is not copied from, and does not depend on, any earlier private implementation.

Fully local execution and data locality are design goals until validated, not established properties of this bootstrap.

The current slice is not yet a coding agent: it cannot read or change workspace files and cannot run commands. Those permissions will be introduced incrementally with explicit boundaries and tests.

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
