# Meta Muse Spark real Chat validation

Label: **REAL inference · RECORDED human-validation note**

On 2026-11-04, RAME Code candidate build `e383ea4.src.48ae3cd77018` made two Chat-only requests through Meta Model API to `muse-spark-1.3`. The human validator used fictitious, non-project text. RAME's Model evidence view recorded both responses as observed and attributed them to Meta selected as the runtime.

## Candidate identity

- Version: `0.2.0`
- Commit: `e383ea4281aaf25a85d66b5955d71707508a9af0`
- Build: `e383ea4.src.48ae3cd77018`
- Channel: `candidate`
- Validated VSIX SHA-256: `cd90e2394d3ab2fee50d5d6347cdf991c03e4197c0b0f2f1a40a90a2c2d061fd`

## Host-recorded observations

| Inference | Mode | Provider | Model | Response observed | Usage recorded by RAME |
| --- | --- | --- | --- | --- | --- |
| 1 | Chat only | Meta Model API | `muse-spark-1.3` | yes | 72 input · 646 output tokens |
| 2 | Chat only | Meta Model API | `muse-spark-1.3` | yes | 139 input · 556 output tokens |

RAME recorded `Authority: Meta selected as the runtime` and retained each text response in the conversation. The same evidence view stated that no local response was verified in the session; the configured local endpoint did not produce these replies. No tool was used.

The first fictitious request asked for a three-sentence explanation of WAV audio. The recorded reply was:

> A WAV file is an uncompressed audio format storing raw PCM samples with a header. A music player opens it by parsing the RIFF header for sample rate, channels, and bit depth. It then streams those samples to the audio output to play sound.

The second request asked in Spanish who the user was speaking with. The recorded reply identified RAME Code as the coding assistant in VS Code.

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

No API key, authorization header, account identifier, private project content or billing data is included here. Original screenshots remain private validation material until a separately reviewed, redacted public image is prepared.
