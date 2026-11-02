# RAME Code

**A local-first VS Code coding agent born at the Meta Global AI Developer Hackathon, powered by Meta Muse models and built around explicit permissions and host-verified evidence.**

[Versión en español](README.es.md) · [Changelog](CHANGELOG.md) · [License](LICENSE)

RAME Code is an independent open-source project started from scratch during the [Meta Global AI Developer Hackathon 2026](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details). It runs as a VS Code extension and supports both a local Muse Glimmer runtime and Meta Model API cloud models.

Version `0.1.0` is the first public preview. It is suitable for evaluation on disposable projects. It is not yet a production security boundary.

## Follow the build

This repository is also a public build journal for people interested in how a coding agent is created from the ground up. The first implementation was bootstrapped by directing **Muse Code CLI** through explicit prompts, then checking the resulting code with automated tests and host-side evidence.

Download the latest [release](https://github.com/caimari/rame-code/releases), install the VSIX and try it on a disposable project. As development advances, new releases will make each verified stage available for testing instead of presenting only a finished demo.

The next important milestone is intentionally recursive: RAME Code should use its own Agent mode and Meta Muse models to inspect, test and improve RAME Code itself. When a release contains a verified improvement produced through RAME Code rather than only through the original Muse Code CLI bootstrap, it will be identified explicitly in the changelog and evidence.

## What works in v0.1.0

- **Agent, Mission and Chat modes** in a single VS Code Activity Bar view.
- **Muse Glimmer locally** through a loopback-only OpenAI-compatible `llama-server` endpoint.
- **Muse Spark and Muse Wonder through Meta Model API**, using a user-supplied API key stored in VS Code SecretStorage.
- Bounded Agent tool loop for workspace inspection, file operations, patches, executable permissions and allowlisted test commands.
- Three permission profiles: Ask, Safe auto and Workspace full.
- One-use, digest-bound approvals tied to the exact action, thread, provider, workspace and file preconditions.
- Protection against absolute paths, traversal, symlink escapes and selected secret/control paths.
- A host-authored action record kept separate from model text.
- Persistent local threads, cancellation, usage accounting and explicit local-to-cloud escalation consent.
- Configurable reasoning and output budgets, validated per provider and model.
- Linux and Windows path/process handling covered by the automated test suite.

## What is not implemented yet

- Persistent, versioned project decisions and stale-artifact detection.
- Resumable missions across a full extension restart.
- Automatic local-to-cloud escalation and verified return to the local model.
- An operating-system sandbox or unrestricted terminal/computer control.
- A claim that local execution, approvals or the audit log are tamper-proof.

Repository content, tool output and model output are treated as untrusted inputs. A model cannot grant itself additional authority, but allowlisted project test scripts still run with the operating-system permissions of VS Code and may themselves access files, networks or shells.

## Install the VSIX manually

Download `rame-code-0.1.0.vsix` from the [v0.1.0 release](https://github.com/caimari/rame-code/releases/tag/v0.1.0).

### From the VS Code interface

1. Open **Extensions** (`Ctrl+Shift+X`).
2. Open the `...` menu in the Extensions panel.
3. Choose **Install from VSIX...**.
4. Select `rame-code-0.1.0.vsix`.
5. Run **Developer: Reload Window** if VS Code asks you to reload.
6. Select the **R** icon in the Activity Bar.

When using Remote SSH, install the extension in the remote workspace when VS Code offers that target.

### From a terminal

```bash
code --install-extension rame-code-0.1.0.vsix
```

If the `code` command is unavailable on a remote host, use **Install from VSIX...** in the connected VS Code window instead.

## Configure a model

Open RAME Code and select the gear button.

### Meta Model API

1. Select **Meta Model API — Cloud**.
2. Create a key in the [Meta Model API dashboard](https://dev.meta.ai/).
3. Paste the separate API key into RAME Code and choose **Save key**.
4. Refresh the available model catalog and select a supported model.

The key is sent to the extension host only when **Save key** is pressed. It is stored in VS Code SecretStorage; the webview only receives whether a key exists. API usage may consume credits or incur charges on the user's Meta account.

### Muse Glimmer locally

RAME Code can start `llama-server` directly; Ollama is not required.

1. Select **Muse Glimmer — Local**.
2. Configure the `llama-server` executable and Muse Glimmer GGUF path.
3. Optionally configure a multimodal projector or DFlash draft model.
4. Choose **Save**, then **Start Muse Glimmer**.

The managed server binds to `127.0.0.1`. RAME Code stops only the process it started. You may also select an existing loopback OpenAI-compatible endpoint.

## Permission profiles

| Profile | Behaviour |
| --- | --- |
| **Ask** | Every tool action waits for approval. This is the default. |
| **Safe auto** | Policy-checked reads run automatically; writes and tests still require approval. |
| **Workspace full** | Allowed workspace actions may run without prompting. Policy checks remain, but this mode is high risk. |

Agent work is restricted to one explicitly selected VS Code workspace folder. RAME Code has no arbitrary shell tool. Test execution is limited to commands derived from an allowlist and uses `shell: false`, but the selected package script may still execute arbitrary project code.

## Generation controls

RAME Code keeps context size, reasoning effort, output budget and the Agent's 12-step budget separate.

- Local Glimmer reasoning controls are offered only when the running server's `/props` template verifies support.
- Meta reasoning options are limited per selected model.
- Automatic cloud output budgets scale from 8,192 to 131,072 tokens according to reasoning effort.
- A cut-off response is discarded; no partial tool call is executed or stored as success.
- Input is never silently shortened to make a request fit the active context window.

## Build from source

Requirements:

- Node.js 22 or later;
- VS Code 1.95 or later.

```bash
git clone https://github.com/caimari/rame-code.git
cd rame-code
npm ci
npm test
npm run package
```

Press `F5` in VS Code to open an Extension Development Host.

## Development provenance

- Public implementation began on **2026-10-31**.
- Competition: **Meta Global AI Developer Hackathon 2026**.
- Track: **Indie Developer**.
- Author: **Antoni Caimari Caldés**.

The public implementation and Git history start independently in this repository. Earlier private code, services, datasets and evaluation results are not included or required. Development milestones are recorded in [HACKATHON_WORK.md](HACKATHON_WORK.md). Private working notes are deliberately excluded from Git and from release packages.

## Roadmap

The next milestone adds the feature that distinguishes RAME Code from a generic coding agent: user-authorized, versioned project decisions whose dependencies can become visibly stale after a decision changes, and whose state can be recovered after a restart.

## License

Licensed under the [Apache License 2.0](LICENSE).

Copyright 2026 Antoni Caimari Caldés.
