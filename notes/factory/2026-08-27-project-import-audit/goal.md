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
- The report can repair every current finding across the audited scope in one confirmed action.

### Desired outcomes
- The command scans the intended project scope, including unopened inline and external templates owned through `templateUrl`.
- The result reports scanned-template and project counts, issue counts, scope, and incomplete reasons.
- Cancelling, truncating, or failing to read part of a scan never produces an apparently complete audit.
- Every finding can open its exact location, and a complete report can apply one project-wide Fix All through the existing import planner.
- README and changelog describe the audit, bulk repair, and indexed-selector boundary accurately.

### Smallest shippable slice
Productize the report as a truthful Project-wide Missing Import Audit, resolve external templates through component ownership, navigate to findings, and apply all current findings from a complete report in one confirmed workspace edit.

### Stop condition
Stop and re-scope if correct external-template ownership requires replacing project discovery/indexing, or if applying fixes from the report requires a second import-planning implementation.

### Success evidence
- Node tests prove arbitrary `templateUrl` files are scanned and unrelated HTML is excluded.
- Node tests prove complete, cancelled, truncated, and unreadable-file report metadata.
- Protocol tests prove project-wide Fix All re-audits, plans all owning components through the existing planner, and applies one versioned workspace edit.
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
- Reuse the existing `ImportEditPlanner`; project-wide fixing must not implement a second import rewriter.
- Do not claim detection for selectors absent from the index.
- Partial results must be visibly partial.
- Preserve cancellation and responsiveness on large projects.
- Do not touch the dirty MCP worktree.

### Visual checkpoints
One VS Code report capture showing compact file headings, scan scope/counts, an indexed attribute-selector finding, and the project-wide Fix All action.

### Risks
- External-template ownership may be represented differently across project layouts.
- Making findings interactive requires a narrow, CSP-safe webview message path.
- A bulk edit must be rejected rather than partially applied when the re-audit is incomplete or the workspace edit is stale.
- Full-suite tests may expose selector regressions introduced by the cherry-picked class-matching fix.

### Non-goals
- CLI, SARIF, or CI integration.
- Treating every unknown HTML attribute as an error.
- Event-selector diagnostics.
- Redesigning the entire report UI.

### Release constraints
- Target version: 3.1.0.
- No version bump, tag, publish, or push until final human merge/release approval.

---
**Fail rule:** if an outcome cannot be demonstrated by the listed evidence, it does not ship.
