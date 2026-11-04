# RAME Code — for judges

RAME Code is a local-first VS Code coding agent built for the Meta Global AI Developer Hackathon 2026. Its central claim is deliberately narrow: **models may propose work, but durable memory, tool authority and Mission completion remain separate host-controlled decisions.**

[Official website](https://ramecode.com/) · [Source](https://github.com/caimari/rame-code) · [User guide](USER_GUIDE.md) · [Verification guide](VERIFICATION.md) · [Evidence index](../evidence/README.md) · [Español](JUDGES.es.md)

## Claims and evidence

| Claim | Concrete evidence | How to reproduce or inspect it | What it does not prove |
| --- | --- | --- | --- |
| RAME can run Muse Glimmer locally through a `llama-server` process managed by the extension | The [REAL supervised Mission record](../evidence/real-mission-supervised/README.md) records a loopback server launched by RAME, `/props` confirmation and 37 observed local inference records | Read the evidence notes; verify the published extraction with `cd evidence/real-mission-supervised && sha256sum -c SHA256SUMS` | The GGUF weights were not cryptographically identified; this is one historical run, not a benchmark or a new execution |
| A real local Mission changed a disposable project and the host completed it only after its frozen acceptance passed | [Sanitized RECORDED run facts](../evidence/real-mission-supervised/run.RECORDED.json), the [project-after fixture](../evidence/real-mission-supervised/project-after/) and checksums | Inspect the RECORDED JSON and fixture, then verify `SHA256SUMS`; the historical REAL run itself is not reproducible from this sanitized bundle | General task success, autonomous operation without approvals, a sandbox, or proof for the current source commit |
| The 0.2.0 candidate has governed project memory: only the user can authorize durable decisions, versions are retained and linked verified files can become stale | Source and automated memory, provenance and invalidation tests | Run `npm ci && npm run check` on Node.js 20 or 24 | A tamper-proof store, cross-machine synchronization, perfect retrieval, or exclusivity over other projects |
| Mission acceptance is host-run and can freeze dependencies, seal folders and fingerprint project files | Source, automated tests and the [SIMULATED sabotage battery](../evidence/sabotage/mission-sabotage.SIMULATED.json) | Run `npm run demo:sabotage`; compare the regenerated SIMULATED result and summary | That a weak acceptance check proves correct software, or that project code is OS-sandboxed |
| One-use approvals are bound to the exact action and relevant preconditions | Source and automated policy tests | Run `npm run check` | Protection against an already-compromised VS Code host or operating system |
| Local-to-Meta disclosure is reviewed and bound to recipient conditions before sending | Source and tests using a simulated Meta API | Run `npm run check`; inspect the disclosure and provider-policy tests | Validation against the real Meta Model API; do not use sensitive data for that path yet |
| A failing Mission verifier opens an identified blocker and normal local control returns only after the host reruns that verifier successfully | Source and automated causal-verification tests | Run `npm run check`; inspect the causal-verification test cases | A completed real Glimmer→Spark→Glimmer run; cloud behaviour is simulated in this candidate |

## Reproduce without a model or API key

Requirements: Node.js 20 or 24 and npm.

```bash
npm ci
npm run check
npm run demo:sabotage
```

`npm run check` compiles the extension and runs the automated tests. `npm run demo:sabotage` regenerates the sanitized SIMULATED result. Neither command needs a GPU, model weights or a Meta key. The GitHub Actions workflow performs the same core checks on Node 20 and 24.

## Evidence labels

- **REAL** — a real model answered in the recorded run.
- **SIMULATED** — scripted model replies or a simulated Meta API exercised real host logic.
- **RECORDED** — a sanitized extraction or replay from stored evidence; it is not a new model run.

The public Mission bundle is a **RECORDED extraction from a REAL run**. Its source archive was checksum-verified before extraction, but the run used historical candidate build `eb89d04-dirty.src.568a25d1d810`. It therefore supports only the facts stated in the bundle and is not a certification of the current commit.

## Current limits

- No operating-system sandbox: allowed project scripts execute with the VS Code user's permissions.
- The real supervised Mission is `n=1`, on a deliberately small disposable project.
- The real run required human supervision and did not use Meta Model API.
- The real run's host summary says 36 answered local inferences while its final evidence view contains 37. Both counts are preserved.
- On Windows, acceptance integrity compares start and end state; temporary change-and-restore detection is not claimed.
- A check can be weak. The reinforced case runner narrows some attacks but does not make expected values secret.
- Meta privacy and Advisory/Delegated paths are tested against a simulated API, not yet validated against the live service.
- This is a 0.2.0 preview candidate, not a production security boundary.

The demo video is intentionally not linked until its final recording and evidence notes exist.
