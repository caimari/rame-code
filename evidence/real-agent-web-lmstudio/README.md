# Real Agent web run through LM Studio on a private LAN

Status: **recorded human run; sanitized interface transcript, with no direct Windows state export available**.

On 2026-11-04, a RAME Code 0.2.0 candidate ran an Agent request against an
OpenAI-compatible LM Studio endpoint on another computer in the user's private
network. The Agent searched the public web and read three official Meta pages.
Every web request required and received a separate human approval.

The sanitized recorded thread is in
[`thread-01-muse-meta-web.RECORDED.md`](thread-01-muse-meta-web.RECORDED.md).
[`provenance.json`](provenance.json) describes its source and sanitization.

## What the recorded run supports

- one real DuckDuckGo `web_search`, returning eight results;
- three real `web_fetch` calls to official Meta domains;
- four human approvals, one for each web request;
- five local Agent inferences recorded by RAME Code;
- a final answer with public source URLs;
- no Meta Model API response in this thread;
- no reported change to local files or project memory;
- use of an external OpenAI-compatible endpoint on the private LAN.

## Limits

- RAME requested the model id `local-glimmer`, but did not cryptographically
  verify the server or its weights. The run alone therefore does not prove that
  the endpoint served Muse Glimmer 30B.
- This is a sanitized transcription of the RAME interface, not a direct export
  from `ExtensionContext.globalState`. The original Windows `state.vscdb` was
  not published or included because it can contain private state from unrelated
  extensions.
- No video file is included, and this package makes no claim that depends on a
  video recording.
- The response records what the model said. This folder does not independently
  certify every factual statement in that response.
- This run validates Agent web access only. It does not validate real-network
  web access in Chat or Mission.
- The candidate incorrectly described the remote-LAN endpoint as a loopback
  endpoint in Model evidence and displayed a generic `llama-server` explanation
  that did not apply to this LM Studio run. Those presentation defects are
  preserved in the recorded thread rather than silently corrected.

## Candidate identity

At evidence intake, the installed extension reported build revision
`src.059070d384d6`. The corresponding locally retained candidate VSIX has
SHA-256:

`246a8d2d32d1112ef9860f5b0925c1ecb7f7c5927dab0df620a94c8e7941645e`

The pasted thread does not itself contain the build revision. A recording of
the **About** view or a direct internal-store export is still required to bind
the run to that build independently.
