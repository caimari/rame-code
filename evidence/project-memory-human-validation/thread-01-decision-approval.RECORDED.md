# Thread 01 — persistent project decision with human approval

Classification: **sanitized interface record supplied after a human run**
Date: 2026-11-04
Mode: Agent
Runtime: RAME-managed local `llama-server`

## Initial request

> Propose a persistent project decision with key `demo.audio_storage`, boolean
> value `true`, meaning that demo audio files must be stored locally. Do not
> modify any files. Wait for my explicit approval before saving the decision.

## First host outcome

RAME did not prepare the proposal. Its host record stated that the user's words
did not explicitly state `true` or `false` and required confirmation of the
exact value. The assistant asked the user to restate the decision.

This was a false rejection: the initial request already contained “boolean
value `true`”. No memory write occurred during this attempt.

## Explicit restatement

> For this project, I explicitly confirm that `demo.audio_storage` is `true`.
> Demo audio files must be stored locally. Please propose this exact persistent
> decision and show me the approval card before saving it. Do not modify any
> files.

## Host-recorded actions

1. `propose_decision` — approved by the user.
2. `propose_decision` — committed `demo.audio_storage` version 1 with boolean
   value `true`.
   - digest prefix: `502d9a829003…`
3. `read_decisions` — allowed by the permission profile and applied.
   - result: two project decisions in force;
   - digest prefix: `f3b57c5f6d1b…`.

The approval payload displayed by RAME contained:

- key: `demo.audio_storage`;
- value type: boolean;
- value: `true`;
- expected version: 0;
- the user's explicit confirmation;
- a reason linking the proposal to that confirmation.

The final status displayed:

> `demo.audio_storage = true` (v1, approved by the user, proposed by the local
> model)

The Project memory view subsequently showed two decisions in force:

- a pre-existing `audio.process_locally = true`, version 1;
- the new `demo.audio_storage = true`, version 1.

It also showed no verified files yet.

## Model evidence recorded by RAME Code

RAME displayed a configured Muse Glimmer GGUF, 32,768-token context, visual
projector configured and draft model configured. It reported:

- local `llama-server` launched by RAME;
- loopback runtime;
- 32,768 context confirmed through `/props`;
- Muse Glimmer template confirmed through `/props`;
- response observed in this session.

The interface also warned that the filename passed to `llama-server` does not
cryptographically verify the weights.

Five local Agent inferences were recorded:

| Inference | Observed usage | Finish | Recorded outcome |
|---:|---:|---|---|
| 1 | 5,968 in / 610 out | `tool_calls` | proposed `propose_decision`; host refused to prepare it |
| 2 | 6,204 in / 717 out | `stop` | clarification text retained in the conversation |
| 3 | 8,717 in / 597 out | `tool_calls` | proposed `propose_decision`; human-approved and applied, digest `502d9a829003…` |
| 4 | 8,939 in / 187 out | `tool_calls` | proposed `read_decisions`; profile-approved and applied, digest `f3b57c5f6d1b…` |
| 5 | 9,099 in / 618 out | `stop` | final text retained in the conversation |

No earlier conversational context was recovered in this thread.

## Screenshot

[`decision-approved.png`](decision-approved.png) is an unmodified capture of
the final authorized decision and the host record. Two other supplied captures
remain in the private evidence backup because they expose absolute workspace
paths and a server address.
