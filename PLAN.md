# Migration to Language Server Protocol

## Status

- Plan status: in progress — Phase 0 lifecycle/restart spike implemented; Phase 0 measurements outstanding; Phase 1 complete; Phase 2 complete — the server owns the handshake, lazy discovery, one runtime per root, indexing, watched files, its own cache, log forwarding, and cancellation; Phase 3 (LSP language features) is next
- Scope: preserve the current Angular Auto Import behavior while moving language analysis out of the VS Code Extension Host
- Delivery model: incremental extraction followed by a guarded LSP rollout; no big-bang rewrite
- Estimated effort: 19–30 engineering days, or roughly 4–6 calendar weeks for one developer familiar with the codebase

## Why migrate

The current extension runs project discovery, `ts-morph`, Angular template parsing, dependency indexing, diagnostics, completion, and edits in the VS Code Extension Host. Moving those workloads into a language-server process should:

- keep indexing and Angular compiler work from blocking the Extension Host;
- create a standard boundary for completion, diagnostics, definitions, and code actions;
- make the analysis core easier to test without VS Code/Electron;
- make a future non-VS Code client possible without committing to one in this migration.

LSP will isolate CPU and memory usage from the Extension Host, but it will not necessarily reduce total memory usage. We will measure both before deciding that the migration is successful.

## Goals

- Preserve completion, missing-import diagnostics, quick fixes, fix-all, and go-to-definition behavior for file-based HTML and TypeScript documents.
- Preserve lazy multi-root Angular project discovery, including nested and sibling projects with different Angular versions.
- Move `ts-morph`, `@angular/compiler`, project indexes, dependency indexes, and diagnostic caches into a separate Node process.
- Return standard LSP edits wherever possible and stop force-saving user documents.
- Keep existing command IDs and user-facing settings compatible.
- Retain the Angular 19, 21, and 22 E2E matrix.
- Support cancellation, server restart, and stale-result protection.

## Non-goals

- Building and shipping clients for Neovim, Zed, IntelliJ, or other editors in this project.
- Integrating into or reusing the Angular Language Service process.
- Supporting browser/virtual workspaces in the first migration. The current implementation depends on Node file-system access, `node_modules`, and `ts-morph`.
- Changing selector matching, import ranking, or Angular-version compatibility as part of the protocol migration.
- Rewriting the analysis engine in another language.

## Target architecture

```text
VS Code client
├── starts/stops LanguageClient over IPC
├── owns commands, notifications, webviews, and OutputChannel
├── reads VS Code configuration
└── passes workspace/storage information to the server
                 │
                 │ LSP + small typed custom protocol
                 ▼
Language server
├── owns TextDocuments and request cancellation
├── owns ProjectRegistry and multi-root project contexts
├── owns file/dependency watchers and persistent cache
├── handles completion, diagnostics, definition, and code actions
└── exposes reindex/report/metrics operations
                 │
                 ▼
Editor-agnostic core
├── Angular index and selector search
├── template and import analysis
├── completion ranking
├── missing-import detection
└── import edit planning
```

Run one server process per VS Code window. The server will retain the existing root-keyed project map instead of starting one process per workspace folder, avoiding duplicated dependency indexes in multi-root workspaces.

## Technical decisions

### SDK and transport

- Use `vscode-languageclient/node` in the extension client.
- Use `vscode-languageserver/node` and `vscode-languageserver-textdocument` in the server.
- Start the bundled server with `TransportKind.ipc`.
- Await `client.start()` during activation and return/await `client.stop()` during deactivation.
- Produce two bundles: `dist/extension.js` and `dist/server.js`.
- Start on the current stable SDK line. Do not depend on proposed LSP features unless a required stable API is missing.

### Document model

Introduce a small `DocumentView` abstraction used by the core:

```ts
interface DocumentView {
  uri: string;
  languageId: string;
  version: number;
  getText(): string;
  offsetAt(position: Position): number;
  positionAt(offset: number): Position;
}
```

The existing VS Code providers and the new LSP server will initially provide separate adapters. Core code must not import `vscode` or create VS Code/LSP protocol objects directly. Map enum values such as completion kinds and diagnostic severities explicitly rather than casting between VS Code and LSP enums.

### Diagnostics

- Prefer LSP pull diagnostics through `connection.languages.diagnostics.on`.
- Advertise `interFileDependencies: true` because changes in a component TypeScript file can alter diagnostics in its external HTML template, and index changes can affect multiple documents.
- Start with document diagnostics; add workspace diagnostics only if the diagnostics-report workflow benefits from them.
- Call diagnostic refresh after project-index or dependency-index changes.
- Preserve `full`, `quickfix-only`, and `disabled` modes:
  - `full`: return diagnostics to the client;
  - `quickfix-only`: retain candidates internally for code actions but return no visible diagnostics;
  - `disabled`: skip analysis and clear stored results.
- Tag every computed result with document version/index generation and discard stale results.

Push diagnostics remain an implementation fallback if pull diagnostics expose a client compatibility issue during the spike.

### Completion and imports

- Return ordinary LSP completion items with the existing trigger characters: `<`, `|`, space, `[`, and `*`.
- Preserve ranking, filtering, detail, documentation, replacement ranges, and incomplete-list behavior.
- For an inline template, attach same-document import edits when safe.
- For an external HTML template, completion must execute an internal server command because the import belongs in the related TypeScript URI. The command will calculate a versioned `WorkspaceEdit` and request `workspace/applyEdit`.
- Quick fixes and fix-all will return `CodeAction.edit` with a cross-file `WorkspaceEdit` where possible.
- Implement fix-all as `source.fixAll.angular-auto-import`, while retaining the existing command-palette command as a client-facing wrapper.
- Do not automatically save an edited document. Do not write directly to a file that is open in the client.
- Prefer minimal text edits. A full-document replacement may be retained temporarily for parity, but it must be replaced before the migration is considered complete if it causes conflicts with dirty documents.

### Definitions

- Return `LocationLink[]` for all matching indexed elements.
- Preserve the current rule that this extension resolves only elements considered missing/unimported, leaving already-imported elements to Angular Language Service.
- Convert file paths with URI-aware utilities and cover Windows drive letters in tests.

### Project lifecycle and file watching

- Move `ProjectRegistry`, root discovery, `projectIndexers`, and parsed tsconfig maps into the server.
- Initialize project contexts lazily from opened HTML/TypeScript documents and advertised workspace folders.
- Keep deepest-containing-root selection so nested and sibling Angular projects never share the wrong index.
- Receive source, manifest, and lockfile changes through LSP watched-file notifications where practical.
- Keep all existing source exclusions, dependency-change debounce, incremental update behavior, and periodic reindex configuration.
- Recompute diagnostics after an index generation changes.

### Cache and configuration

- Pass a cache directory derived from `ExtensionContext.globalStorageUri` in initialization options.
- Replace direct `workspaceState` access with a versioned `CacheStore` interface and a server-side JSON/file implementation.
- Include cache schema version, project-root identity, Angular dependency identity, and relevant configuration in cache validation.
- Allow one cold reindex after switching to the server cache. Do not delete the old workspace-state cache until the fallback implementation is removed.
- Send initial configuration during initialization and handle subsequent `workspace/didChangeConfiguration` notifications.
- Treat a `projectPath` change as a project-manager reinitialization rather than only logging it.

### Client-only functionality

Keep these responsibilities in the VS Code extension:

- `showLogs` and output-channel presentation;
- information/error notifications;
- performance and diagnostics-report webviews;
- command-palette registration and active-editor selection;
- progress UI and cancellation forwarding.

Use typed custom requests for operations that are not language features, for example:

- `angularAutoImport/reindex`;
- `angularAutoImport/clearCache`;
- `angularAutoImport/performanceMetrics`;
- `angularAutoImport/diagnosticsReport`.

Define them with current `RequestType` constructors in a dependency-light shared protocol module. Returned data must be serializable DTOs and must not contain `ts-morph`, VS Code, or server implementation objects.

## Work plan

### Phase 0 — Baseline and technical spike (2–3 days)

- [ ] Record activation time, cold/warm index time, Extension Host CPU, server/host RSS, completion latency, diagnostic latency, and packaged size on small and monorepo fixtures.
- [x] Add temporary development-only selection between direct providers and LSP; never activate both implementations simultaneously.
- [x] Add client and server entry points and two esbuild outputs.
- [x] Start the server over IPC, complete initialize/initialized/shutdown/exit, and verify `await start()`/`stop()` lifecycle.
- [x] Synchronize one HTML and one TypeScript document through `TextDocuments<TextDocument>`.
- [x] Implement one fixture-backed completion response as an end-to-end vertical slice.
- [x] Verify server crash reporting and automatic restart behavior.

Exit criteria:

- A packaged development VSIX starts and stops the server reliably.
- The spike demonstrates a real completion response and captures baseline measurements.
- No blocker is found in bundling `ts-morph` or dynamically importing `@angular/compiler` from the server bundle.

### Phase 1 — Extract editor-agnostic core (4–6 days)

- [x] Add `DocumentView`, explicit range/kind/severity mappings, and URI/path helpers.
  - [x] Add the minimal editor-agnostic `DocumentView`, file-URI conversion, and VS Code adapter; migrate inline-template detection to it.
  - [x] Add explicit range/kind/severity DTOs and mappings at active runtime boundaries; defer unused LSP range/severity converters until their first handlers move.
- [x] Add `FileSystem`, `CacheStore`, `ProgressReporter`, event, and disposable ports where the current core touches VS Code.
  - [x] Replace `AngularIndexer`'s VS Code event emitters with shared `EventSource` and `Disposable` core contracts.
  - [x] Route persisted index reads, writes, and deletes through a shared `CacheStore` and VS Code workspace-state adapter.
  - [x] Add filesystem and progress ports alongside their first extracted runtime consumers: `AngularIndexer` now discovers, reads, and reports through injected `FileSystem`/`ProgressHost` ports instead of `workspace.findFiles`, `workspace.fs`, and `window.withProgress`.
- [x] Split `AngularIndexer` into pure index/query state and project runtime concerns such as scanning, watching, persistence, and progress.
  - [x] Extract the selector trie and element/module lookup state into an editor-agnostic index module (`core/selector-trie`, `core/element-index`).
  - [x] Leave scanning, watching, persistence, and progress in a project runtime that owns that index.
- [x] Move `ProjectRegistry` out of the extension entry point without changing its behavior.
  - [x] Move the registry, its document/source contracts, and root-containment helpers into core.
  - [x] Re-point registry and discovery tests at the core module instead of the extension entry point.
- [x] Extract completion context detection/ranking so it returns plain completion DTOs.
  - [x] Move template context detection onto `DocumentView` and return a plain context DTO (`core/completion-context`).
  - [x] Move selector matching/ranking behind plain completion DTOs the providers map to editor items (`core/completion-suggestions`); the VS Code provider only maps DTOs onto `CompletionItem`s.
- [x] Extract diagnostics so parsing and missing-import checks return plain diagnostic DTOs with offsets/ranges.
  - [x] Move the template AST walk into core (`core/template-scan`), returning import candidates with plain ranges; parsing, caching, and logging stay in the provider.
  - [x] Move the missing-import checks behind plain diagnostic DTOs (`core/missing-imports`), reading the component file through an injected context; the provider maps DTOs onto `vscode.Diagnostic`.
  - [x] Move the ts-morph import interrogation and its cache into core (`core/component-imports`), behind a `CoreLogger` port (`core/logging`) that the Extension Host satisfies with its existing logger.
- [x] Extract an `ImportPlanner` that accepts document text and requested elements and returns a versioned edit plan (`core/import-planner`); `utils/import` only chooses the text source and applies the edit.
  - [ ] Reject a plan whose version no longer matches the document before applying it (Phase 2 staleness work).
- [x] Keep the current VS Code providers working through adapters — every extraction above kept completion, diagnostics, quick fixes, and imports behaviour-identical, verified by the unit suites and the v22 e2e matrix at each step.
- [x] Convert suitable tests to plain Node tests; retain Electron tests only where the VS Code host is relevant.
  - [x] Split the unit suites into `src/test/node` (plain Mocha, 107 tests) and `src/test/suite` (VS Code host, 177 tests); `pnpm run test:unit` runs both, `pnpm run test:node` only the fast ones.
  - [x] Enforce the boundary with a lint rule: `src/core` and `src/test/node` may not import `vscode`.

Exit criteria:

- Core/index/feature modules contain no `vscode` imports.
- Existing unit and E2E tests pass without user-visible behavior changes.
- Import planning can be tested without applying or saving an edit.

### Phase 2 — Server project runtime (3–5 days)

- [x] Implement `initialize` capabilities, workspace folders, initialization options, and configuration sync.
  - [x] Move the settings shape, defaults, and coercion into core (`core/settings`); the VS Code reader and the server share one schema.
  - [x] Resolve the handshake into a `ServerEnvironment` (`lsp/server-environment`): workspace roots as paths, storage directory, settings, and the client capabilities the server acts on.
  - [x] Register `didChangeConfiguration`, pull `workspace/configuration`, and track workspace-folder changes; the client sends settings and its storage path at `initialize`.
- [x] Move lazy project discovery and deepest-root context selection into the server.
  - [x] Move the Angular package walk and its manifest cache into core (`core/project-discovery`); the Extension Host entry point only forwards to it.
  - [x] Share one deepest-root selection in core (`core/project-registry`) instead of a second copy in `utils/project-context`.
  - [x] Discover roots in the server from workspace folders and synchronized documents (`lsp/server-projects`), routing a URI to its deepest discovered root and re-scanning when workspace folders change.
- [x] Create and dispose one project runtime per discovered Angular root.
  - [x] Move tsconfig discovery and alias resolution into core as a per-root `TsConfigResolver` (`core/tsconfig`); the Extension Host service is now one shared instance of it.
  - [x] Give the server a `ProjectRuntime` per root (`lsp/project-runtime`) owning that root's tsconfig and element index, with a `ProjectRuntimeHost` creating exactly one per root and disposing it when the root leaves the workspace or the server shuts down.
- [x] Implement full and incremental source indexing in the server.
  - [x] Persist through the `CacheStore` port instead of `vscode.ExtensionContext`: `AngularIndexer` takes its ports at construction and no indexing method receives an editor object any more.
  - [x] Replace the indexer's direct host-logger import with an injected `InstrumentedLogger` (`core/logging`), which adds timers and process metrics over any logger; the host passes its own logger through unchanged.
  - [x] Watch through a `FileWatcherFactory` port (`core/file-watching`) instead of `workspace.createFileSystemWatcher`, so watched-file notifications can drive the same incremental updates in the server.
  - [x] Describe searches structurally instead of as glob strings (`core/file-system`), so the server can satisfy `FileSystem` with a plain directory walk (`adapters/node/file-system`) that never enters an excluded directory; the source-file rule itself now lives once in `core/source-files` and backs both the search and the watcher predicate.
  - [x] Give the shared analysis helpers an installable logger (`installSharedLogger`) instead of the editor-bound one, which was the indexer's last transitive `vscode` dependency; every port is now required rather than defaulted to a VS Code adapter.
  - [x] Instantiate the indexer from `ProjectRuntime`: it restores the index from the project's cache when that is still valid and falls back to a full scan, and it starts watching afterwards.
  - [x] Feed incremental updates from the client's watched-file notifications.
- [x] Implement source/dependency watched-file handling and periodic reindex.
  - [x] Describe a watch structurally (`core/file-watching`) so the server can both register it with the client and decide which subscription a reported path belongs to.
  - [x] Register watches through `client/registerCapability` and route `didChangeWatchedFiles` back to the subscribing runtime (`lsp/watched-files`); a client that cannot register watchers still works, it just reports nothing.
  - [x] Reindex on the `index.refreshInterval` timer in the server, as the Extension Host does, and stop it with the runtime.
  - [x] Fix element removal, which never matched: elements are indexed with a project-relative path while deletions and renames removed them by absolute path, so a deleted file's selector and a renamed element's old selector stayed in the index until a full reindex. Affected the Extension Host too.
- [x] Implement the versioned file cache under the provided storage directory.
  - [x] One JSON file per root under the client's storage directory (`lsp/file-cache-store`), loaded once at open because `CacheStore` reads synchronously, written through a temporary file so a crash cannot truncate it.
  - [x] Reuse a cached index only when the schema version, the root, and the project fingerprint all still match; anything else starts empty and lets the caller reindex.
  - [x] Open one cache per `ProjectRuntime`, so two roots never read each other's index.
- [x] Forward structured server logs to the LanguageClient output channel.
  - [x] Filter and format server logs by the user's existing `logging` settings (`lsp/server-logging`), in the same `[timestamp][LEVEL]` shape the host's output channel uses, or as one JSON object per entry when `outputFormat` is `json`.
  - [x] Reapply the settings on every configuration change, pulled or pushed.
- [x] Add cancellation and index-generation guards around long-running indexing.
  - [x] Add a cooperative `CancellationSignal` (`core/cancellation`); a full index checks it between batches, before dependency indexing, and per dependency, and a cancelled scan clears what it built instead of serving or persisting half an index.
  - [x] Cancel a project's indexing when its runtime is disposed, so a root that left the workspace stops working immediately.
  - [x] Track an index generation per runtime, so Phase 3 can discard results computed against an index that no longer exists.
  - [x] Share one in-flight creation per root in `ProjectRuntimeHost`, so concurrent document opens cannot build two indexes for one project.

Exit criteria:

- Cold/warm starts produce the same selector/module indexes as the direct implementation. Both runtimes now drive the same `AngularIndexer` through the same ports, but the index snapshots have not been compared side by side yet; that comparison belongs with the Phase 5 snapshot work.
- Nested and sibling projects remain isolated. Covered by the runtime tests: separate indexes, separate alias resolution, separate caches.
- Source and dependency changes update the appropriate index without reloading VS Code. Covered by the watched-file routing tests and a runtime test that adds, renames, and deletes a component.

### Phase 3 — LSP language features (4–6 days)

- [ ] Implement completion and completion-import execution for inline and external templates.
- [ ] Implement definition responses with multiple `LocationLink` results.
- [ ] Implement pull diagnostics, inter-file invalidation, and diagnostic refresh.
- [ ] Implement `quickfix-only` candidate storage independent of visible diagnostics.
- [ ] Implement quick-fix code actions with cross-file workspace edits.
- [ ] Implement `source.fixAll.angular-auto-import` and preserve deduplication/import ordering.
- [ ] Ensure TypeScript document changes refresh related HTML diagnostics and vice versa.
- [ ] Reject stale completion, diagnostic, and edit results after document or index versions change.
- [ ] Propagate cancellation tokens through parsing and expensive lookup boundaries.

Exit criteria:

- Completion, diagnostics, quick fixes, fix-all, and definitions match the direct implementation on the fixture corpus.
- Undo works as one editor operation and the extension does not force-save documents.
- Angular Language Service continues handling already-imported definitions without duplicate results.

### Phase 4 — Commands, reports, and client UX (2–4 days)

- [ ] Route reindex and clear-cache commands to typed server requests.
- [ ] Route fix-all command-palette behavior to the standard fix-all operation.
- [ ] Return performance metrics and diagnostics-report DTOs from the server.
- [ ] Keep webview rendering and notifications in the client.
- [ ] Map server work-done progress and cancellation to VS Code progress UI.
- [ ] Preserve existing command IDs and settings.
- [ ] Make server-unavailable errors actionable without exposing protocol internals to users.

Exit criteria:

- Every contributed command works with the direct providers disabled.
- Reports and metrics contain the same user-relevant information as before.
- Reindex and report cancellation leave project state usable.

### Phase 5 — Parity, rollout, and cleanup (4–6 days)

- [ ] Run unit, extension-host, and E2E suites for both direct and LSP modes during the transition.
- [ ] Preserve the Angular 19/21/22 E2E matrix and add protocol-specific regressions for dirty files, external HTML, nested roots, server restart, Windows URIs, and dependency changes.
- [ ] Add direct handler tests that do not require a JSON-RPC connection.
- [ ] Add a small client/server integration harness for initialization, document sync, diagnostics refresh, workspace edits, and custom requests.
- [ ] Compare completion/diagnostic snapshots between implementations.
- [ ] Package and inspect the VSIX to ensure both bundles and runtime dependencies are present.
- [ ] Enable LSP for internal/beta builds while keeping a temporary fallback setting.
- [ ] Make LSP the default after parity and performance gates pass.
- [ ] Remove direct provider registration and the fallback after at least one stable release without a migration blocker.
- [ ] Remove obsolete workspace-state cache keys only after fallback removal.
- [ ] Update architecture, troubleshooting, logging, and development documentation.

Exit criteria:

- All CI and E2E suites pass with LSP as the default.
- No direct VS Code language providers or `vscode` imports remain in the server/core layers.
- Performance and reliability gates below pass.
- The old implementation can be removed without deleting unique business logic.

## Suggested pull-request boundaries

1. Baseline instrumentation and LSP spike.
2. Document/range/URI abstractions and `ProjectRegistry` extraction.
3. Pure `ImportPlanner` and non-saving edit application adapter.
4. Index core/runtime split and cache interface.
5. Completion and diagnostic engine extraction while retaining direct providers.
6. Client/server build, initialization, project runtime, and logging.
7. Completion and definition handlers.
8. Pull diagnostics, quick fixes, and fix-all.
9. Commands, reports, rollout flag, and protocol integration tests.
10. Default switch, fallback observation period, and direct-provider cleanup.

Each PR must keep the default production path working and must avoid mixing unrelated Angular behavior changes into the migration.

## Test strategy

### Core unit tests

- Selector indexing and search.
- Completion context, ranking, deduplication, and replacement ranges.
- Template parsing and missing-import detection.
- Import planning, alias resolution, formatting, and idempotency.
- Multi-root containment and project selection.
- Cache serialization, schema changes, and stale-file detection.

### Protocol handler tests

- Initialize capabilities and configuration.
- Document open/change/close and version handling.
- Completion and command payload serialization.
- Pull diagnostic full/unchanged results and refresh.
- Code actions and cross-file `WorkspaceEdit` generation.
- Definition URI/range conversion.
- Cancellation and stale-result rejection.

### Extension-host and E2E tests

- Inline and external templates.
- Dirty related TypeScript documents.
- `full`, `quickfix-only`, and `disabled` diagnostics modes.
- Nested/sibling Angular roots and tsconfig aliases.
- Dependency install/remove/change events.
- Server crash/restart and window reload.
- Angular 19, 21, and 22 descriptor suites.

## Performance and reliability gates

Capture exact thresholds from the Phase 0 baseline, then require:

- no regression greater than 10% in warm completion p95;
- no regression greater than 15% in cold index time;
- a material reduction in Extension Host CPU time during full indexing;
- no unbounded growth in server RSS after repeated reindexing;
- no duplicated project index after concurrent document opens;
- no stale diagnostics after edits, dependency changes, project switches, or server restart;
- no forced save and no lost dirty-document changes;
- successful server restart without requiring a VS Code window reload.

## Main risks and mitigations

| Risk | Mitigation |
|---|---|
| `ts-morph` state diverges from unsaved `TextDocuments` | Use versioned document snapshots; update source files only from the latest document version; reject stale edits. |
| External HTML completion needs to edit a TypeScript file | Use an internal execute-command handler followed by a versioned cross-file `workspace/applyEdit`. |
| Index refresh invalidates diagnostics in unrelated open documents | Track index generation and request diagnostic refresh after successful index changes. |
| LSP process increases total memory | Keep one server per window, avoid duplicate direct/LSP indexes, and enforce RSS/reindex benchmarks. |
| Old cache is incompatible | Introduce a schema-versioned server cache and tolerate one cold rebuild; retain old cache during fallback period. |
| Dynamic Angular compiler import or bundling fails | Prove it in Phase 0 and inspect the packaged VSIX before core migration proceeds. |
| Windows URI handling breaks path containment | Centralize URI conversion and add Windows, nested-root, and sibling-prefix tests. |
| Direct and LSP providers return duplicate results during rollout | Make modes mutually exclusive and test both paths in CI rather than activating both in one window. |
| Server requests monopolize its event loop | Honor cancellation, debounce document diagnostics, coalesce file events, and retain bounded file-read concurrency. |
| Custom protocol grows into a second ad hoc API | Use standard LSP features for language operations and reserve typed custom requests for UI/reporting operations only. |

## Definition of done

The migration is complete when:

- LSP is the default and only language-feature implementation.
- The client contains UI/lifecycle code but no indexing or Angular analysis.
- The server and core do not import `vscode`.
- All language features and commands have parity with the pre-LSP release.
- Existing Angular-version E2E suites and new protocol regressions pass.
- Performance/reliability gates pass on representative small and monorepo workspaces.
- Imports are applied through editor workspace edits without force-saving or overwriting dirty content.
- Server failure is logged, surfaced clearly, and recoverable.
- Architecture and troubleshooting documentation describe the client/server boundary and cache location.

## Context7 references

The plan was checked against the current Context7 documentation for `/microsoft/vscode-languageserver-node`:

- [VSCode Language Server Node repository](https://github.com/microsoft/vscode-languageserver-node)
- [Language client testbed entry point](https://github.com/microsoft/vscode-languageserver-node/blob/main/testbed/client/src/extension.ts)
- [LanguageClientOptions](https://github.com/microsoft/vscode-languageserver-node/blob/main/client/src/common/client.ts)
- [Server diagnostic feature](https://github.com/microsoft/vscode-languageserver-node/blob/main/server/src/common/diagnostic.ts)
- [LSP diagnostic protocol types](https://github.com/microsoft/vscode-languageserver-node/blob/main/protocol/src/common/protocol.diagnostic.ts)

Context7-specific conclusions incorporated here:

- use async `LanguageClient.start()`/`stop()` lifecycle;
- use Node `TransportKind.ipc` for the bundled server;
- use `TextDocuments` with `vscode-languageserver-textdocument`;
- use the current diagnostic pull API and advertise inter-file dependencies;
- define custom requests with current `RequestType` constructors.
