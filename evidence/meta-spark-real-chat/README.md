# Meta Muse Spark real Chat validation

Label: **REAL inference · RECORDED human-validation note**

On 2026-11-04, RAME Code candidate builds made three Chat-only requests through Meta Model API to `muse-spark-1.3`. The human validator used fictitious, non-project text. RAME's Model evidence view recorded the responses as observed and attributed them to Meta selected as the runtime.

## Candidate identity for inferences 1 and 2

- Version: `0.2.0`
- Commit: `e383ea4281aaf25a85d66b5955d71707508a9af0`
- Build: `e383ea4.src.48ae3cd77018`
- Channel: `candidate`
- Validated VSIX SHA-256: `cd90e2394d3ab2fee50d5d6347cdf991c03e4197c0b0f2f1a40a90a2c2d061fd`

## Candidate identity for inference 3

- Version: `0.2.0`
- Build installed at evidence intake: `src.059070d384d6`
- Candidate VSIX SHA-256: `246a8d2d32d1112ef9860f5b0925c1ecb7f7c5927dab0df620a94c8e7941645e`
- Source state: combined validation candidate, not a committed release

The third thread did not display the build revision itself. The association is
therefore an environment observation at evidence intake, not a build identity
embedded in the thread. See the
[`recorded thread`](thread-03-local-first-cloud-chat.RECORDED.md) and its
[`supporting screenshot`](thread-03-meta-spark-chat.png).

## Host-recorded observations

| Inference | Mode | Provider | Model | Response observed | Usage recorded by RAME |
| --- | --- | --- | --- | --- | --- |
| 1 | Chat only | Meta Model API | `muse-spark-1.3` | yes | 72 input · 646 output tokens |
| 2 | Chat only | Meta Model API | `muse-spark-1.3` | yes | 139 input · 556 output tokens |
| 3 | Chat only | Meta Model API | `muse-spark-1.3` | yes | 80 input · 554 output tokens |

RAME recorded `Authority: Meta selected as the runtime` and retained each text response in the conversation. The same evidence view stated that no local response was verified in the session; the configured local endpoint did not produce these replies. No tool was used.

The first fictitious request asked for a three-sentence explanation of WAV audio. The recorded reply was:

> A WAV file is an uncompressed audio format storing raw PCM samples with a header. A music player opens it by parsing the RIFF header for sample rate, channels, and bit depth. It then streams those samples to the audio output to play sound.

The second request asked in Spanish who the user was speaking with. The recorded reply identified RAME Code as the coding assistant in VS Code.

The third request asked for three short sentences explaining how a local-first
coding assistant can combine local models with optional cloud AI while keeping
the user in control of data sharing. Its recorded response is preserved in the
separate thread file. RAME recorded one Chat inference, no tools and no recovered
earlier context for that thread.

## Bounded claim supported

> RAME Code has executed real Muse Spark 1.3 Chat inferences through Meta Model API.

This is a human-validation record produced from RAME's host-authored Model evidence and the visible conversation. It is not a Meta attestation, cryptographic proof of the remote weights or a reproducible fixture containing credentials. Meta Billing/Usage remains authoritative for provider-side accounting.

## It does not prove

- Meta tool use in Agent;
- permission handling for real cloud tool results;
- Delegated execution;
- Mission planning or Mission Advisory against the real API;
- the identity or behavior of every model returned by Meta's catalog; or
- correctness of every disclosure and failure path, whose exhaustive coverage still uses the simulated Meta recorder.

No API key, authorization header, account identifier, private project content or billing data is included here. The screenshot published for inference 3 shows the selected Meta runtime and the two validation-thread titles; it does not by itself show the response or prove provider-side execution, so the bounded claim relies on the recorded conversation and Model evidence as well.
