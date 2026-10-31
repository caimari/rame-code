# Hackathon Work Log

This log separates work created during the Meta Global AI Developer Hackathon 2026 from prior private research and products. Design choices are informed by Antoni Caimari Caldés's prior private experiments. All public implementation code and Git history start independently in this repository on 2026-10-31; no private code, services, data, documents, results, or history are included or required. Only independently reproduced public results may be claimed.

## 2026-10-31 — Repository bootstrap

- Created a new, independent Git repository.
- Added the Apache-2.0 license, English README, and ignore rules.
- Declared the planned Muse Glimmer local and Muse Spark 1.3 remote architecture.
- Added no functional agent or extension code.
- Attempted to invoke Muse Code 1.4.10 with `muse-spark-1.3` in Standard mode and without write or shell permissions. The call did not run because Muse credentials are stored under a different operating-system account. No model-generated content was attributed to this bootstrap.

## 2026-10-31 — Muse Code documentation review

- Reviewed `README.md` and `HACKATHON_WORK.md` only.
- Refined the product message to describe a reversible local-to-remote cascade as the evaluated technical hypothesis.
- Made no functional implementation change: no agent or extension code was added or modified.
- Documentation assistance is recorded here separately from functional implementation.

## 2026-10-31 — Version 0.1.0 vertical slice

- Used Muse Code 1.4.10 with `muse-spark-1.3`, Contributor Mode off, and no write or shell permission to propose and later review a minimal extension slice.
- Human review corrected the proposed Meta Model API contract before integration: Standard mode is selected by model ID `muse-spark-1.3`; no invented `mode` request field is sent.
- Added API-key storage through VS Code SecretStorage and a bounded command that sends only a user-entered mission goal to Meta Model API.
- Added strict schema-constrained mission plans, defensive response parsing, cancellation, concurrent-run prevention, and unit tests.
- The Muse review incorrectly reported that a test expected a redacted key because its safe review view replaced the test credential. The actual test uses a synthetic key and passed; valid findings from the review were fixed and retested.
- No live Model API call from the extension has yet been claimed. A separate user-supplied Model API key is still required for that verification.
- The extension currently has no workspace read, write, or shell capability.

## Provenance boundary

- This repository must not copy code or Git history from any earlier private implementation.
- This repository must not depend on any earlier private implementation, service, or prototype.
- Standard open-source dependencies may be used under their respective licenses.
- Every released capability must be reproducible from this repository and documented with the model, tools, tests, and human intervention involved.
