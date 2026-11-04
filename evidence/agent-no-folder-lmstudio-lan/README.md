# Real Agent-without-folder validation through LM Studio on a private LAN

Status: **recorded human run; public screenshot withheld for privacy**.

On 2026-11-04, RAME Code candidate build `src.2f737eddcab9` used an LM
Studio endpoint on another computer in the private network. Agent answered two
requests before a project folder was selected. When the user then asked to work
on a project, the model called `request_project_folder`; RAME presented the
folder choice and bound the selected folder for subsequent messages.

The sanitized sequence is preserved in
[`thread-01-agent-no-folder.RECORDED.md`](thread-01-agent-no-folder.RECORDED.md).
[`provenance.json`](provenance.json) records the private source and screenshot
hashes.

## What this run supports

- Agent could answer without an attached project folder;
- before folder selection, the host exposed no file, test, terminal or memory
  tool and described the available scope as web-only;
- a second request received the exact response `LAN MODEL OK` without tools;
- the model proposed `request_project_folder` when the user explicitly asked
  to begin project work;
- the host recorded that the user chose a folder and that project tools would
  apply only from the next message;
- LM Studio was identified through its own API as running on another computer
  in the private network, rather than being mislabeled as loopback;
- RAME recorded four Agent inferences from the external endpoint;
- no Meta Model API response was observed in this session after the candidate
  was installed.

## Important evidence-linkage limitation

For inference 3, Model evidence recorded the proposed
`request_project_folder` call but displayed **“No host action recorded”**. The
Host record and result card separately recorded that the user selected a folder
and that tools would become available on the next message.

This means the run demonstrates the user-visible and host-recorded folder flow,
but Model evidence did not link that host action back to the proposing
inference. That gap must not be hidden or described as a complete evidence
chain.

## Additional limits

- The exact weights served by the external LM Studio process were not
  cryptographically verified.
- The server reported model metadata; those statements are not equivalent to
  RAME hashing the remote GGUF.
- The recorded flow did not execute any project file tool after folder
  selection.
- The final conversation header showed the folder that had just been selected.
  Initial no-folder operation is evidenced by the earlier Host records, not by
  that final header alone.
- The screenshot remains private because it contains a private endpoint and an
  absolute workspace path. The video should obscure those values before public
  distribution.

## Candidate identity

- Version: `0.2.0`
- Build: `src.2f737eddcab9`
- Channel: `candidate`
- Candidate VSIX SHA-256:
  `be952a9748cdc158e92562c9eba4ff3eeb8ab52759e218f534b4a021722ead67`
- Automated suites communicated with the candidate: 745/745 on Node 20 and
  745/745 on Node 24; these counts are not established by this human run.
