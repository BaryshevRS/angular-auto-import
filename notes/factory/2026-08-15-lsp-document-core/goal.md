# Goal Contract — LSP document core boundary

Status: first bounded extraction implemented and verified.

## Core

### Current state

- Inline-template detection accepts VS Code document and position types directly.
- The LSP server's `TextDocument` cannot call that logic without an editor adapter or duplicated implementation.

### Desired future state

- Shared analysis accepts a minimal editor-agnostic `DocumentView` implemented by both runtimes.
- File URI conversion is explicit and centralized at the core boundary.

### Desired outcomes

- Inline-template detection compiles and runs against a plain object with no VS Code dependency.
- A `vscode-languageserver-textdocument` document satisfies the same interface without an adapter.
- The existing VS Code completion provider preserves behavior through a narrow adapter.

### Smallest shippable slice

Introduce `DocumentView`, a file-URI helper, and the VS Code adapter, then migrate only inline-template detection.

### Stop condition

Stop if the extraction requires changing completion semantics, moving indexing, or widening the interface for unrelated providers.

### Success evidence

- Red-then-green unit tests for a plain document, encoded file URI, and LSP `TextDocument`.
- Existing unit suite and LSP lifecycle/restart suite pass.
- Typecheck, lint, and both production bundles pass.

### Risk classification

R1 internal refactor; no user-visible or data-handling change.

## Conditional

### Non-goals

- Completion/diagnostic DTO mappings.
- Moving project discovery or indexing into the server.
- Enabling the LSP production path.

### Rollback note

Revert the core interface and VS Code adapter, then restore the previous VS Code types in template detection.
