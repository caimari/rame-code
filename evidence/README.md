# Public evidence index

This directory contains narrowly scoped evidence, not a quality score or a general performance claim.

| Evidence | Label | Reproduce | Scope |
| --- | --- | --- | --- |
| [`real-mission-supervised/`](real-mission-supervised/) | REAL run, public RECORDED extraction | Inspect the fixture and `SHA256SUMS`; run the before and after checks as documented | One historical supervised local-Glimmer Mission on a disposable project |
| [`meta-spark-real-chat/`](meta-spark-real-chat/) | REAL inference, RECORDED human-validation notes | Inspect the build identities, limits and supporting screenshot; verify with `cd evidence/meta-spark-real-chat && sha256sum -c SHA256SUMS` | Three real Chat-only responses from `muse-spark-1.3`; no tools, Agent or Mission claim |
| [`real-agent-web-lmstudio/`](real-agent-web-lmstudio/) | REAL human run, sanitized RECORDED transcript; no direct Windows state export | Inspect the recorded thread, provenance and `SHA256SUMS` | Agent used a private-LAN LM Studio endpoint for one real web search and three reads with four human approvals; model weights were not verified |
| [`project-memory-human-validation/`](project-memory-human-validation/) | REAL human run, sanitized RECORDED transcript and unmodified screenshot | Inspect the decision flow, observed limitation, provenance and `SHA256SUMS` | Local Agent persisted one typed project decision only after human approval, then read it back; initial wording suffered a conservative false rejection |
| [`agent-no-folder-lmstudio-lan/`](agent-no-folder-lmstudio-lan/) | REAL human run, sanitized RECORDED transcript; screenshot retained privately | Inspect the no-folder flow, LM Studio identity, evidence-linkage limitation, provenance and `SHA256SUMS` | Agent answered without a folder, then requested one explicitly; Host record confirms selection but Model evidence did not link the host action |
| [`real-mission-autonomous-clamp/`](real-mission-autonomous-clamp/) | REAL autonomous Mission, sanitized RECORDED summary plus independently rerun artifacts | Inspect the Mission summary, copied project, independent test result and `SHA256SUMS`; run `cd evidence/real-mission-autonomous-clamp/project && npm test` | One empty-folder Autonomous workspace Mission completed 2/2 tasks after the required second authorization; conventional host verification, no frozen acceptance, no Meta or web use |
| [`sabotage/mission-sabotage.SIMULATED.json`](sabotage/mission-sabotage.SIMULATED.json) | SIMULATED | `npm run demo:sabotage` | Scripted adversarial actions against the candidate's real host logic |

Definitions and the complete claims matrix are in [For judges](../docs/JUDGES.md) and [How to verify it](../docs/VERIFICATION.md).

No raw credentials, home-directory paths, persisted VS Code state, full private conversations or model reasoning are published here.
