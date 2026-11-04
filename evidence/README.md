# Public evidence index

This directory contains narrowly scoped evidence, not a quality score or a general performance claim.

| Evidence | Label | Reproduce | Scope |
| --- | --- | --- | --- |
| [`real-mission-supervised/`](real-mission-supervised/) | REAL run, public RECORDED extraction | Inspect the fixture and `SHA256SUMS`; run the before and after checks as documented | One historical supervised local-Glimmer Mission on a disposable project |
| [`sabotage/mission-sabotage.SIMULATED.json`](sabotage/mission-sabotage.SIMULATED.json) | SIMULATED | `npm run demo:sabotage` | Scripted adversarial actions against the candidate's real host logic |

Definitions and the complete claims matrix are in [For judges](../docs/JUDGES.md) and [How to verify it](../docs/VERIFICATION.md).

No raw credentials, home-directory paths, persisted VS Code state, full private conversations or model reasoning are published here.
