# Goal Contract — LSP lifecycle spike

> Source of truth for the first bounded slice of the LSP migration. Amendments require explicit approval.

Status: implementation in progress; Amendment 1 adds deterministic crash/restart recovery evidence.

## Goal Amendment 1 — automatic crash recovery

Approved by the user's instruction to continue on 2026-08-15.

- Desired outcome: after an induced server-process crash, the language client automatically restarts, re-synchronizes already open HTML and TypeScript documents, and serves the same completion response without a window reload.
- Success evidence: the isolated Extension Host lifecycle test observes the client leave and re-enter its running state, then repeats protocol completions for both open fixture documents.
- Constraint: the crash hook and command remain development-only and are registered only while `AAI_LSP_SPIKE=1`.
- Stop condition: stop if recovery requires changing the default direct-provider path or adding timing-based assertions.

## Core

### Current state (≤3)

- The extension is built as one `dist/extension.js` bundle and registers language providers directly in the VS Code Extension Host.
- There is no Language Client/Server lifecycle, document synchronization, or protocol-level test path.
- The migration plan contains unresolved implementation risk around server packaging, startup, shutdown, and `@angular/compiler`/`ts-morph` bundling.

### Desired future state (≤3)

- A development-only mode can start a bundled Node language server over IPC, synchronize HTML/TypeScript documents, return one deterministic completion response, and shut down cleanly.
- The current direct-provider implementation remains the default and behaves unchanged.
- The repository has deterministic evidence that the client/server build and lifecycle are viable before domain logic is migrated.

### Desired outcomes (solution-independent, measurable; ≤5)

- A normal build emits both client and server artifacts without type or bundle errors.
- The client/server lifecycle completes activation, initialization, document sync, completion, shutdown, and exit without leaked registrations or duplicate providers.
- One fixture-backed completion request returns the expected stable payload through the protocol boundary.
- Existing unit/E2E behavior remains unchanged with LSP mode disabled.
- Baseline activation, indexing, latency, memory, and package-size measurements are recorded for later migration gates.

### Smallest shippable slice   <!-- required -->

A non-default, development-only LSP vertical slice containing two bundles, IPC lifecycle, HTML/TypeScript document sync, and one deterministic fixture-backed completion response. It does not migrate the production completion/indexing implementation.

### Stop condition   <!-- required -->

Stop and re-scope if the slice requires changing default provider behavior, activating direct and LSP providers simultaneously, redesigning Angular analysis, or accepting an untestable/broken packaged server or dynamic Angular compiler import.

### Success evidence (≤5)

- A red-then-green lifecycle/protocol test covering initialization, document sync, completion, and shutdown.
- `pnpm run check-types`, the relevant unit test command, and the production package/build command pass.
- Packaged artifact inspection shows both runtime bundles and required dependencies.
- Existing tests pass with the direct implementation still selected by default.
- `evidence/verify.log` records exact commands/results and a baseline-measurement note records any metrics that can be measured deterministically in this slice.

### Risk classification

R1 internal developer/infrastructure change; the new path is development-only and does not handle sensitive data.
EU AI Act: Art 5 prohibited use? N/A · Art 50 labelling? N/A

### Tracker

none — this is one bounded vertical slice governed by `PLAN.md`.

## Conditional

### Current constraint (Theory of Constraints)

The migration cannot safely proceed until the repository proves that a separately bundled Node language server can be started, synchronized, tested, packaged, and stopped under the existing VS Code extension runtime.

### Target user / job (JTBD)

The extension maintainer needs a low-risk proof of the LSP process boundary before moving indexing and user-facing language behavior out of the Extension Host.

### Non-negotiable constraints (≤5)

- Direct providers remain the default production path.
- Direct and LSP providers are mutually exclusive in one extension window.
- The spike uses the repository's existing TypeScript, pnpm, esbuild, and VS Code test stack.
- Lifecycle tests are deterministic and contain no sleep-based assertions.
- No Angular selector, diagnostic, completion-ranking, or import behavior changes enter this slice.

### Visual checkpoints

N/A — no user-visible layout, styling, onboarding, authentication, or safety flow changes.

### Rollback note

The LSP path is development-only and disabled by default. Roll back by removing/reverting the client/server spike files and second build entry; the current direct-provider entry remains intact throughout.

### Risks (≤5)

- esbuild may mishandle the server entry or dynamic Angular compiler import.
- LanguageClient lifecycle may interact poorly with the existing activation/deactivation contract.
- Test infrastructure may accidentally require two active language-provider implementations.
- The packaged VSIX may omit the server artifact or runtime dependencies.
- A fixture-only completion could become throwaway code; isolate it clearly so Phase 1 can replace it.

### Non-goals (≤5)

- Moving `AngularIndexer` or `ProjectRegistry` into the server.
- Migrating production completion, diagnostics, definitions, quick fixes, or fix-all.
- Introducing the final persistent server cache.
- Enabling LSP by default or publishing it to Marketplace users.
- Supporting non-VS Code clients or browser workspaces.

### Release constraints

- Do not publish this slice as the default runtime path.
- Any development toggle must be clearly internal/experimental and absent from normal user behavior.

---

**Fail rule:** every desired outcome above must be backed by the listed deterministic evidence before the slice is presented for merge.
