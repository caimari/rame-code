# Real supervised Mission — sanitized public evidence

**Evidence status:** this is a **RECORDED, sanitized extraction from a REAL run** captured on 2026-11-03. It was not rerun while preparing this directory.

## What happened

A supervised Verified Mission used local Muse Glimmer to repair one deliberately defective function in a disposable Node project. The host first observed `npm:check` fail, applied one model-proposed replacement to `src/calculator.js` after approval, observed `npm:test` and the same `npm:check` pass, confirmed the frozen files were intact, and completed the Mission after four internal runs.

The recorded runtime facts say that RAME launched `llama-server` on loopback with the configured basename `Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf`; `/props` confirmed context 32,768 and the Muse Glimmer template. No Meta consultation was allowed or observed.

## Inspect and replay the fixture

The public fixture excludes the raw persisted Mission, the full conversation and a synthetic privacy fixture. It contains only the defect, the repaired project and sanitized run facts.

```bash
sha256sum -c SHA256SUMS

# Use a temporary copy. The initial state must fail its acceptance check.
cp project-before/src/calculator.js project-after/src/calculator.js
(cd project-after && npm run check)

# Restore the recorded repair; both checks must pass.
cp project-repaired/src/calculator.js project-after/src/calculator.js
(cd project-after && npm test && npm run check)
```

The first check is expected to exit non-zero. Use a temporary copy so replay does not dirty this repository.

## What this supports

- Real local model responses were recorded in RAME.
- RAME managed a loopback `llama-server` for the recorded run.
- The host recorded an initial failing acceptance check, one source edit, passing unit and acceptance checks, intact frozen files and host completion.
- The before and repaired source hashes match the hashes in the stored source bundle.

## What this does not support

- It is not proof of the current repository commit. The historical build was `eb89d04-dirty.src.568a25d1d810`, installed from a VSIX whose recorded SHA-256 was `a9e21321269a222e94f182469397b9e7fe43618c0622c3810988af75274fbaba`.
- It is one small supervised run, not a benchmark or a claim of general reliability.
- It does not prove the identity of the model weights; the evidence records the configured filename and server properties, not a cryptographic weights digest.
- It does not prove sandboxing. Project tests ran with the user's operating-system permissions.
- It does not demonstrate Meta Model API use or a model cascade.
- The host summary recorded 36 answered local inferences while the final evidence view listed 37. The discrepancy is preserved in `run.RECORDED.json`.

The private source archive's own `SHA256SUMS` verified all 12 files before this extraction. The public files have their own independent [`SHA256SUMS`](SHA256SUMS).
