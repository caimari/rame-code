# RAME Code architecture

RAME Code is structured so that a supported local model can inspect one
implementation unit without loading the whole extension host. The repository
uses composition around a small orchestration shell rather than adding new
responsibilities to a single provider class.

## Module-size rule

- New implementation modules must stay below approximately **16,000 tokens**
  (estimated conservatively as four characters per token).
- Prefer a new cohesive module over extending an unrelated file.
- A split must follow a responsibility boundary, not arbitrary line counts.
- Public interfaces should be narrow, typed and independently testable.
- Cyclic dependencies between feature modules are not allowed.

`npm run compile` enforces the rule. During the migration,
`src/mainProvider.ts`, `media/main.js` and `media/i18n.js` are frozen legacy
exceptions: they may shrink but cannot grow. The exceptions must be removed
when the extraction is complete.

## Target boundaries

### Extension shell

Owns VS Code lifecycle, webview wiring and composition. It does not implement
Agent, Mission, memory, provider or project-specific behavior.

### Model providers

One `ModelProvider` contract covers chat, planning and Agent inference. Local
llama.cpp-compatible inference and Meta Model API are adapters behind that
contract. Provider selection is explicit and never falls back silently.

### Project adapters

One `ProjectAdapter` contract discovers bounded verification commands,
environment files and protected dependency paths. The existing npm behavior is
the first adapter; future Python, Rust or Go support must be added as separate
adapters with their own security tests.

### Agent engine

Owns the bounded tool loop, permission profiles, approvals, filesystem policy
and host-authored evidence. It receives provider and project capabilities
through interfaces.

### Mission coordinator

Owns persistent plans, grants, checkpoints, leases, autonomous continuation,
acceptance checks and terminal reports. It invokes the Agent engine but does
not implement its tools.

### Project memory

Owns authorized decisions, versions, provenance, verified artifacts and stale
detection. Model text and repository content remain untrusted inputs.

### Presentation

Builds typed view state and renders it. It observes domain state but does not
decide whether actions are authorized or Missions are complete.

## Refactor discipline

1. Preserve behavior with existing tests before moving code.
2. Extract one boundary at a time.
3. Run the full suite after every extraction.
4. Commit only green, reviewable steps.
5. Do not publish a release from an intermediate refactor commit.
