# Real human validation of governed project memory

Status: **recorded human run with one unmodified public screenshot**.

On 2026-11-04, a RAME Code 0.2.0 candidate used its RAME-managed local
`llama-server` to process an Agent request for a persistent boolean project
decision. The host did not save the proposal until the user approved it. It
then stored `demo.audio_storage = true` as version 1 and read the project memory
back with two decisions in force.

The sanitized sequence is in
[`thread-01-decision-approval.RECORDED.md`](thread-01-decision-approval.RECORDED.md).
[`decision-approved.png`](decision-approved.png) is an unmodified screenshot of
the authorized result and host record. [`provenance.json`](provenance.json)
describes the two supplied text sources and the private screenshots.

## What this run supports

- a local Agent proposed a typed boolean project decision;
- RAME associated the proposal with the user's explicit words;
- one human approval authorized the write to project memory;
- the host recorded the action digest prefix `502d9a829003…`;
- the decision became `demo.audio_storage = true`, version 1;
- `read_decisions` subsequently reported two decisions in force;
- the Project memory settings view showed the new decision and its history;
- all five recorded inferences in this thread used the local RAME-managed
  runtime; no Meta inference is recorded for this thread.

## Important observed limitation

The first user message already contained the literal phrase “boolean value
`true`”, but the host refused to prepare the proposal because it considered the
value insufficiently explicit. The user then restated the decision in the
exact form requested and the flow completed. This is a conservative false
rejection, not evidence that the first wording was actually ambiguous.

The evidence preserves this behavior because a validation record must not hide
an observed product defect.

## What this run does not prove

- version 2 replacement, revocation or invalidation of dependent evidence;
- memory recovery after restarting VS Code;
- automatic use of the decision in a later Mission;
- absence of every possible filesystem change (the run reported no file
  modification, but no independent before/after filesystem snapshot was
  supplied);
- cryptographic identity of the GGUF weights; or
- a Meta Model API call in this thread.

The session-level interface stated that Meta had answered earlier in the VS
Code session. That is not attributed to this memory thread: its Model evidence
lists only local Agent inferences.

## Candidate identity

At evidence intake, the installed candidate reported revision
`src.059070d384d6`. The corresponding retained VSIX has SHA-256:

`246a8d2d32d1112ef9860f5b0925c1ecb7f7c5927dab0df620a94c8e7941645e`

The recorded thread and screenshot show version 0.2.0 but not the full build
revision, so this association remains an environment observation rather than
an identity embedded in the run.
