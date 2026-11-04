# RECORDED real autonomous Mission — clamp utility

This bundle preserves a sanitized record of one real human-run RAME Code
Mission on 2026-11-04. A real locally connected model proposed and performed
the work; RAME's host recorded the actions and completion. Codex later checked
the persisted Mission record and reran the resulting project independently on
a byte-for-byte temporary copy.

## What the run did

The user started from an empty disposable folder and requested a dependency-free
JavaScript `clamp(value, min, max)` utility with three automated tests. The
Mission record identifies:

- permission: **Autonomous workspace**;
- first authorization: create the initial project and proposed tests;
- bootstrap boundary: the first proposed test run was blocked by host policy;
- second authorization: review and allow the new `npm:test` verification;
- files created: `package.json`, `clamp.js` and `clamp.test.js`;
- tasks completed: 2 of 2;
- internal runs: 3;
- host test result: `npm:test`, exit code 0;
- final result: **Mission completed and verified by the host (conventional level)**;
- Meta consultations sent: 0;
- web searches and fetches used: 0.

The persisted record spans 2026-11-04 21:58:47–22:04:34 CET, about 5 minutes
47 seconds from plan creation to completion. RAME's final report separately
shows 3.3 minutes since authorization. Two successful `npm:test` runs were
recorded; the second was redundant.

## Build provenance

This execution belongs to candidate build **`src.be90f7717746`**, not to the
newer candidate. That attribution was established by inspection of the active
extension-host session and its preserved build manifest; the Mission thread
does not itself print the build revision. The preserved candidate VSIX manifest
records SHA-256:

`0eb8d0fd76c28af6960391d74d0c7d5a1f1c2519f69af99397ad5f354b46533b`

## What Codex verified directly

- The isolated persistent record matches Mission id
  `mis_95ac6ed1485527cb1eb8fc62`, scope label
  `rame-mission-final-demo`, the exact goal and the two completed tasks.
- The isolated record was structurally identical to the matching object still
  present in RAME's live Mission store at preservation time.
- The three files in [`project/`](project/) are byte-for-byte copies of the
  original completed project.
- `npm test` on a temporary copy passed 3/3 tests with Node v20.19.0.
- Three additional direct assertions passed on that temporary copy.
- The original files' hashes were unchanged before and after verification.

See [`independent-test.txt`](independent-test.txt) and
[`mission-summary.RECORDED.json`](mission-summary.RECORDED.json).

## What comes from RAME's records

The permission, two-stage bootstrap, blocked pre-authorization test, two
successful host test actions, two completed tasks, three internal runs,
conventional completion level, provider observations and zero Meta/web use are
facts recorded by RAME and cross-checked against the user-supplied thread. They
are not reconstructed model claims.

## Limits

- This was a **Standard Mission** with conventional verification. It had no
  frozen acceptance check, so a passing project test is not equivalent to
  protected or reinforced acceptance.
- The model ran behind an external LM Studio server on a private network. RAME
  observed responses but did not cryptographically verify the model weights.
- The empty-folder safety flow required two user authorizations. This is not an
  unattended run from an unrestricted initial grant.
- The Mission used three internal runs and repeated a successful test. This
  evidence demonstrates completion, not optimal efficiency.
- Test scripts ran with the user's operating-system permissions; project path
  checks are not an OS sandbox.
- No Meta Cloud inference, Meta Advisory response or web request occurred in
  this Mission.

Private-network addresses, absolute paths, unrelated VS Code state and the raw
thread are deliberately excluded from this public bundle.
