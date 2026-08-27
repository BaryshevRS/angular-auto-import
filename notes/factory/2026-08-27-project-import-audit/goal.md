# Goal Contract — Project-wide Missing Import Audit

> Source of truth. Amendments require explicit approval; implementation must not silently expand this scope.

## Core

### Current state
- The language server can scan unopened inline and external templates for missing Angular imports.
- The command is exposed as `Generate Diagnostics Report (Debug)` and is absent from the README.
- A cancelled, partially failed, or conventionally incomplete scan can look like a complete report.

### Desired future state
- Angular Auto Import 3.1.0 exposes the scan as a supported project audit rather than a debugging tool.
- The report states what it scanned and whether the result is complete.
- A finding takes the user directly to the affected template location, where existing quick fixes remain the repair path.

### Desired outcomes
- The command scans the intended project scope, including unopened inline and external templates owned through `templateUrl`.
- The result reports scanned-template and project counts, issue counts, scope, and incomplete reasons.
- Cancelling, truncating, or failing to read part of a scan never produces an apparently complete audit.
- Every rendered finding can open its file at the reported line and column.
- README and changelog describe the audit and its indexed-selector boundary accurately.

### Smallest shippable slice
Rename and productize the existing report command; make scan completeness explicit; resolve external templates through component ownership rather than same-basename convention; add navigation from each finding; document it as the Project-wide Missing Import Audit. Keep repair in the existing per-file Quick Fix/Fix All flow.

### Stop condition
Stop and re-scope if correct external-template ownership requires replacing project discovery/indexing, or if applying fixes from the report requires a second import-planning implementation.

### Success evidence
- Node tests prove arbitrary `templateUrl` files are scanned and unrelated HTML is excluded.
- Node tests prove complete, cancelled, truncated, and unreadable-file report metadata.
- Extension-host/unit tests prove a report finding opens the correct file position.
- README/package/changelog review proves the feature is public and accurately named.
- Repository typecheck, lint, node tests, unit tests, and production package pass; exact commands recorded under `evidence/verify.log`.

### Risk classification
R2 user-facing low-stakes. EU AI Act: Art 5 N/A; Art 50 N/A.

### Tracker
none — one bounded release feature in one worktree.

## Conditional

### Current constraint
The scanner already exists, but users cannot rely on or discover it as a complete project audit.

### Target user / job
An Angular developer migrating, pasting, moving, or AI-generating standalone templates wants to find missing imports even when Angular reports no compiler error and the affected file is not open.

### Non-negotiable constraints
- Reuse the editor's existing diagnostics and per-file fix path.
- Do not claim detection for selectors absent from the index.
- Partial results must be visibly partial.
- Preserve cancellation and responsiveness on large projects.
- Do not touch the dirty MCP worktree.

### Visual checkpoints
One VS Code report capture showing scan scope/counts, an indexed attribute-selector finding, and navigation to its template location.

### Risks
- External-template ownership may be represented differently across project layouts.
- Making findings interactive requires a narrow, CSP-safe webview message path.
- Full-suite tests may expose selector regressions introduced by the cherry-picked class-matching fix.

### Non-goals
- CLI, SARIF, or CI integration.
- Workspace-wide automatic fixing.
- Treating every unknown HTML attribute as an error.
- Event-selector diagnostics.
- Redesigning the entire report UI.

### Release constraints
- Target version: 3.1.0.
- No version bump, tag, publish, or push until final human merge/release approval.

---
**Fail rule:** if an outcome cannot be demonstrated by the listed evidence, it does not ship.
