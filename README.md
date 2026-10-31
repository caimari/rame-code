# RAME Code

**A local-first coding agent for VS Code with verifiable, resumable missions.**

RAME Code is a new independent open-source project started during the Meta Global AI Developer Hackathon 2026. Its goal is to let a developer delegate a software mission without losing the decisions, evidence, and unfinished work that make the result trustworthy.

## Current status

This repository is a clean project bootstrap. No functional agent or VS Code extension has been released yet.

The first public implementation is being built during the hackathon in this repository. It is not copied from, and does not depend on, any earlier private RAME implementation.

## Planned hackathon MVP

The first installable VS Code extension is intended to:

- connect to **Muse Glimmer** through a local OpenAI-compatible endpoint such as llama.cpp, Ollama, or LM Studio;
- connect to **Muse Spark 1.3** through Meta Model API;
- offer local-only, remote-only, and policy-controlled hybrid execution;
- run a bounded coding loop that can inspect files, propose changes, and execute verification commands;
- preserve an explicit mission goal, user-authorized versioned decisions, changed files, test evidence, and remaining work across restarts;
- detect when verified work has become stale after a decision changes;
- escalate a concrete blocker from Glimmer to Spark only within an authorized data and cost budget.

These are development goals, not claims about the current bootstrap.

## Core idea

RAME Code does not treat a chat transcript as project truth. A mission keeps a small, inspectable record of:

```text
goal -> authorized decisions -> changes -> verification evidence -> current state
```

Models may observe, reason, and propose. Durable decisions, permissions, and promotion of a candidate release remain under explicit user control.

## Model modes

| Mode | Intended behavior |
| --- | --- |
| Local | Muse Glimmer runs on the user's hardware. Project data stays local. |
| Remote | Muse Spark runs through Meta Model API while tools remain local. |
| Hybrid | Glimmer works locally and RAME Code may request bounded Spark assistance when observable progress rules identify a blocker. |

## Trust principles

- Repository content, tool output, and model output are untrusted inputs.
- A model cannot grant itself durable authority.
- Remote transmission must stay within the user's approved scope and budget.
- Candidate changes must be shown and verified before promotion.
- A future version cannot silently weaken the checks that authorize its installation.

## Development provenance

- Public implementation start: **2026-10-31**.
- Competition: **Meta Global AI Developer Hackathon 2026**.
- Track: **Indie Developer**.
- Repository: <https://github.com/caimari/rame-code>
- Author: **Antoni Caimari Caldés**.

Development milestones and model/tool participation are recorded in [`HACKATHON_WORK.md`](HACKATHON_WORK.md).

## Roadmap

- `0.1.0`: installable extension, one model endpoint, bounded file/test tools.
- `0.2.0`: first verified improvement produced with assistance from the previous RAME Code version.
- `0.3.0`: persistent and resumable missions.
- `0.4.0`: policy-controlled Glimmer-to-Spark escalation.
- Hackathon release: reproducible demo, packaged VSIX, independent verification, and frozen evidence.

The roadmap may be reduced to protect reliability. Only implemented and reproducible behavior will be presented as complete.

## Development

Setup instructions will be added with the first executable implementation.

Do not commit API keys or local model files. RAME Code will require users to supply their own model endpoints and credentials.

## License

Licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 Antoni Caimari Caldés.
