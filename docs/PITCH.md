# RAME Code — product pitch

## The one-line story

**RAME Code is a local-first AI coding agent built directly into Visual Studio Code, with user-governed memory and autonomous Missions whose authorized results are checked by the host.**

RAME means **Relational Adaptive Memory Engine**. The name reflects earlier research into persistent state and relational memory; RAME Code itself is a new, independent open-source project built during the Meta Global AI Developer Hackathon 2026.

## The promise

> **AI should remember what matters, respect what you decide, and prove what it actually accomplished.**

Most coding agents mix conversation, memory, permission and completion into one stream controlled by the model. RAME separates them:

- the model proposes;
- the user authorizes tools, disclosure and durable decisions; and
- the host records actions and runs the authorized checks that decide whether a verified Mission completed.

## Why it is useful

Developers should not have to choose between local privacy and useful cloud assistance. RAME can run Meta Muse Glimmer locally through its managed `llama-server`, or connect to compatible models served by Ollama and LM Studio, including explicitly authorized servers on a private network. When the user chooses Meta Model API, compatible cloud models can power direct Chat and Agent requests.

For longer work, Mission can continue across bounded internal runs, preserve authorized project decisions and require host-observed evidence before completion. Optional, budget-limited Spark advice can assist an eligible local Mission without transferring control of its tools.

## Four product pillars

### Local-first, not local-only

Use a managed `llama-server`, an existing Ollama or LM Studio server, or explicitly authorized Meta cloud inference. Model weights and runtimes remain user-supplied.

### Memory the user governs

Only approved decisions become persistent project memory. Decisions retain versions and provenance; changing one can mark dependent verified work as **STALE** instead of silently treating old evidence as current.

### Autonomy with boundaries

Agent supports interactive work. Mission handles longer objectives with checkpoints, explicit grants, interruption recovery and bounded stopping conditions.

### Evidence instead of model confidence

RAME distinguishes what a model claimed from what the host allowed, executed and checked. A verified Mission does not complete merely because the model says “done”.

## Thirty-second spoken pitch

> RAME Code is a local-first coding agent built directly into VS Code. It runs Meta Muse Glimmer locally, can connect to Ollama or LM Studio, and can use Meta Model API when the user authorizes cloud processing. What makes RAME different is its control model: only decisions you approve become persistent memory, tools stay behind scoped permissions, and verified Missions finish only after the host runs the authorized checks. AI proposes; you authorize; RAME verifies.

## Suggested three-minute demo story

1. **Identity — 15 seconds.** Show the installed `0.2.0` candidate and state the one-line story.
2. **Local model — 25 seconds.** Show Glimmer responding locally and open Model evidence so the audience sees an observed local response, not only a selected model.
3. **Governed memory — 35 seconds.** Approve one durable decision, show it in another thread, change it and show dependent evidence becoming **STALE**.
4. **Verified Mission — 75 seconds.** Start a small disposable-project Mission, show its scoped grant and frozen acceptance, then show the host-run check and completion evidence.
5. **Authorized cloud — 20 seconds.** Show the Meta disclosure review and the recorded real Spark Chat evidence. State clearly that real Mission Advisory validation is still pending.
6. **Close — 10 seconds.** “AI proposes. You authorize. RAME verifies.” Show GitHub and [ramecode.com](https://ramecode.com/).

## Claims to keep bounded

- Two direct Chat-only inferences with `muse-spark-1.3` have a recorded real-API human validation. This does not validate cloud Agent tool results, Delegated or Mission Advisory.
- Mission Advisory is implemented and tested with a simulated Meta recorder; it has no recorded real-provider execution yet.
- RAME prioritizes local inference and enforces remote budgets; no specific cost saving is claimed without comparative measurements.
- Compatible Meta models depend on their advertised capabilities. RAME does not claim that every model supports every mode.
- Privacy controls support transparency and data minimization but do not by themselves establish GDPR compliance or a legal basis.
- A host-run check proves only the acceptance criteria it actually covers; RAME is not an operating-system sandbox.

Technical substantiation remains in [For judges](JUDGES.md), the [evidence index](../evidence/README.md) and the [verification guide](VERIFICATION.md).
