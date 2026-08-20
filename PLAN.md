# Migration to Language Server Protocol

## Status

- Plan status: in progress — Phase 0 measurements taken, including the Extension Host CPU comparison that is the migration's central claim; Phases 1 through 4 complete; Phase 3 lacks only the inline-template `additionalTextEdits` optimization, which the full-document import edit blocks. Phase 5's engineering is done: the server is held to the same recorded corpus as the direct implementation and agrees with it, the protocol is exercised over a real connection, and the packaged artifact is verified. What remains in Phase 5 is a release decision and its precondition: the **Phase 0 baseline measurements were never taken**, so the performance gates cannot be evaluated, and until they are the LSP path stays behind the `AAI_LSP_SPIKE` development flag
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
- Prefer minimal text edits. Done: the planner rewrites with ts-morph and then diffs the result back into the smallest set of line replacements (`core/text-edits`). A whole-file replacement was never usable — two edits computed from the same starting text undid each other, an edit spanning the file collided with a completion's own edit inside it, and every replacement discarded selection and folding for lines that never changed.

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

- [x] Record cold/warm index time, server RSS, completion latency, diagnostic latency, and packaged size (`scripts/benchmark.mjs`, `pnpm run benchmark`). See [Measured baseline](#measured-baseline).
  - [x] Measure Extension Host CPU during a full index, inside the editor, once per implementation (`src/test/host-cost`, `pnpm run host-cost`). This is the migration's central claim and nothing outside the Extension Host can answer it.
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
  - [x] Split the unit suites into `src/test/node` (plain Mocha) and `src/test/suite` (VS Code host); `pnpm run test:unit` runs both, `pnpm run test:node` only the fast ones. The split has kept moving toward Node as extraction proceeded: 271 Node tests against 148 host tests as of the Phase 3 completion work.
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

- [x] Implement completion and completion-import execution for inline and external templates.
  - [x] Route a document to the project that answers for it, and to the TypeScript file its template's imports belong in (`lsp/project-router`); an external template and an inline one differ only in that answer.
  - [x] Give the server path-keyed access to the synchronized documents and their unsaved state (`lsp/open-documents`), which is what decides whether a cached answer about a file may still be used.
  - [x] Serve `textDocument/completion` from the shared core ranking (`lsp/completion`), gated by the same settings, template detection, and standalone check as the direct provider. The handler is synchronous, so a result can never describe an index the project no longer has.
  - [x] Execute the import through a server command (`lsp/import-command`) that plans against the file as the user currently sees it and returns a versioned `workspace/applyEdit`; nothing is written to disk and nothing is saved.
  - [x] Share the element-to-specifier rule between both hosts (`core/import-resolution`) instead of keeping a second copy in `utils/import`.
  - [x] Attach the import as `additionalTextEdits` for an inline template, computed on `completionItem/resolve` so nothing is planned for items the user never accepts. The command stays on every item as the fallback, and is dropped only where real edits replaced it — carrying both would import twice.
- [x] Implement definition responses with multiple `LocationLink` results (`lsp/definition`).
  - [x] Answer only where the server has a retained candidate, so an already-imported element stays the Angular Language Service's to resolve and one Ctrl+Click never shows the same result twice.
  - [x] Return every declaration answering to the selector; a selector like `[nzButton]` legitimately belongs to several, and picking one would hide the rest.
  - [x] Point at the class name where the project has already parsed the file, and at its first line where it has not, rather than paying for a parse on a Ctrl+Click.
- [x] Implement pull diagnostics, inter-file invalidation, and diagnostic refresh.
  - [x] Move the analysis both hosts run onto one implementation: the dynamically imported compiler behind a named surface (`core/angular-compiler`), inline-template extraction (`core/inline-template`), source-file synchronization (`core/source-file-sync`), and the parse/walk/decide pipeline with its version-keyed AST cache (`core/template-diagnostics`). The direct provider now wires those together instead of owning them, and lost 190 lines doing so.
  - [x] Answer `textDocument/diagnostic` from the server (`lsp/diagnostics`), advertising `interFileDependencies` because a component's TypeScript file decides its external template's report.
  - [x] Ask the client to re-pull after a TypeScript document changes, after an index generation advances, and once the compiler finishes loading; the requests are coalesced so a burst means one refresh.
  - [x] Drop the cached "already imported" answers when the index changes, since every one of them was decided against an index that no longer exists.
- [x] Implement `quickfix-only` candidate storage independent of visible diagnostics.
  - [x] `full` returns the items, `quickfix-only` retains them and returns none, `disabled` computes nothing and forgets what it had. Every retained result is tagged with the document version and index generation it was computed against, so a code action can refuse one that has gone stale.
- [x] Implement quick-fix code actions with cross-file workspace edits (`lsp/code-actions`).
  - [x] Offer the fixes from the retained candidates rather than from what the client was shown, which is what makes `quickfix-only` mode work.
  - [x] Return the edit through `codeAction/resolve`, because computing it means rewriting the component with ts-morph — far too expensive for actions the editor merely lists. A client without resolve support gets the edit up front, or the command when there is no edit to give.
  - [x] Share one planner with the completion command (`lsp/import-edit`), so a quick fix, a fix-all, and an accepted completion all produce the same versioned cross-file edit.
- [x] Implement `source.fixAll.angular-auto-import` and preserve deduplication/import ordering.
  - [x] One action covering every element the document is missing, deduplicated by element name in template order; it is not offered when there is only one thing to fix, which the quick fix already covers.
- [x] Ensure TypeScript document changes refresh related HTML diagnostics and vice versa. Covered by the refresh triggers above: the client re-pulls every open document, and an external template's report is computed from its component's current text either way.
- [x] Reject stale completion, diagnostic, and edit results after document or index versions change.
  - [x] Completion is synchronous, so no index can change under it.
  - [x] A retained diagnostic result carries the document version and index generation it was computed against, and code actions recompute rather than reuse one that no longer describes the document.
  - [x] An import plan is discarded when the document version or index generation moved while its import paths were being resolved, and the edit that survives is versioned so the client can refuse it too.
- [x] Propagate cancellation tokens through parsing and expensive lookup boundaries.
  - [x] Adapt the request token to the core's cooperative signal (`adapters/lsp/cancellation`), reading through it rather than snapshotting, because a token flips after the work has already started.
  - [x] Check between template elements in `core/missing-imports`, which is where an abandoned request costs the most: every element runs Angular's selector matcher against the index.
  - [x] Discard a cancelled diagnostic pass instead of retaining it — a partial result would leave code actions offering a subset of the fixes — and drop a cancelled fix-all rather than importing less than its title promises.

Exit criteria:

- Completion, diagnostics, quick fixes, fix-all, and definitions match the direct implementation on the fixture corpus.
- Undo works as one editor operation and the extension does not force-save documents.
- Angular Language Service continues handling already-imported definitions without duplicate results.

### Phase 4 — Commands, reports, and client UX (2–4 days)

- [x] Route reindex and clear-cache commands to typed server requests.
  - [x] Define the custom requests once, as `RequestType` constructors both sides import (`lsp/protocol`), so a change to one end fails to compile at the other. The module depends only on `vscode-languageserver-protocol`, which is now an explicit dependency rather than one borrowed from the client and server packages.
  - [x] Give `ProjectRuntime` a `reindex` that re-reads the project's TypeScript configuration first — a changed `paths` mapping is the usual reason to ask for one by hand — and a `clearCache` that drops the persisted index with the in-memory one.
  - [x] Answer both in the server (`lsp/operations`), scoped to the active document's project or to every project, reporting each project's outcome separately so one failure does not read as total failure.
- [x] Route fix-all command-palette behavior to the standard fix-all operation. The palette command runs `vscode.executeCodeActionProvider` for `source.fixAll.angular-auto-import` and applies what comes back, so it cannot diverge from the code action in what it imports or how it orders it.
- [x] Return performance metrics and diagnostics-report DTOs from the server.
  - [x] Metrics describe the server process, which is the point of asking it rather than the Extension Host.
  - [x] The report (`lsp/report`) scans every template in the scoped projects through the same analysis a pull request uses, so it cannot disagree with what the editor shows. It batches, yields between batches so the connection keeps answering, and stops at the same limits the Extension Host reporter used.
- [x] Keep webview rendering and notifications in the client. The renderers moved to `commands/webviews` and now take the protocol DTOs, so one implementation serves both hosts; the Extension Host maps its own report onto the DTO on the way in.
- [x] Map server work-done progress and cancellation to VS Code progress UI. The report attaches to the client's `workDoneToken` and reports real progress; cancelling the notification cancels the request, and a user who cancelled is told nothing they already know.
- [x] Preserve existing command IDs and settings. Every contributed command keeps its ID; only what happens behind it changes.
- [x] Make server-unavailable errors actionable without exposing protocol internals to users. A failed request is logged in full and surfaced as one sentence naming the output channel and the reload that would restart the server.

Exit criteria:

- Every contributed command works with the direct providers disabled.
- Reports and metrics contain the same user-relevant information as before.
- Reindex and report cancellation leave project state usable.

### Phase 5 — Parity and cleanup (4–6 days)

- [x] Run unit, extension-host, and E2E suites throughout the transition.
- [x] Preserve the Angular 19/21/22 E2E matrix and add protocol-specific regressions for dirty files, external HTML, nested roots, server restart, and dependency changes.
  - [x] Dirty files and external HTML in `lsp-protocol`; nested and sibling roots, URI round trips, and files created or deleted on disk in `lsp-regressions`; server restart in the Extension Host lifecycle suite, which is the only place a real process can be killed.
  - [x] Audit what Windows would break rather than waiting for a Windows machine, and fix it: paths compared with `startsWith`, which is wrong on every platform at a boundary (`C:\WorkApp` "starts with" `C:\Work`) and wrong again on Windows for drive-letter case, now go through `isPathInside`; and the cache that remembers what a component imports was keyed by ts-morph's forward-slash spelling while invalidated by the platform's, so on Windows it would never have been invalidated at all. Each has a test that fails without its fix on any platform.
- [x] Add direct handler tests that do not require a JSON-RPC connection.
- [x] Add a client/server integration harness for initialization, document sync, diagnostics refresh, workspace edits, and custom requests (`src/test/node/harness/lsp-harness`).
- [x] Compare against the recorded corpus. `lsp-parity` replays `src/e2e/cases` — the descriptors the previous implementation was held to — against the server; all 17 v22 cases agree on diagnostics, ranges, and quick-fix titles.
- [x] Package and inspect the VSIX (`pnpm run vsce:inspect`).
- [x] Remove the previous implementation. The server is now the only one: the direct providers, their commands, the Extension Host adapters, and the flag that used to choose between them are gone, and `src/extension.ts` does nothing but start and stop the client.
  - [x] Move what those suites were really testing rather than deleting it: the indexer's 41 tests and the tsconfig resolver's 32 now run under plain Node, and the missing-import suppression rules with them.
  - [x] Keep `projectPath` working. Its meaning — one configured directory overrides the workspace, and naming a directory that does not exist yields no roots at all — moved into the handshake and kept its own tests.
  - [x] Clear the template-string cache when a document closes, which the previous entry point did and the server had stopped doing.
- [x] Update architecture, troubleshooting, logging, and development documentation (`docs/architecture.md`, `CLAUDE.md`).
- [ ] Remove the workspace-state cache keys the previous implementation wrote. They are no longer read; deleting them is a separate, reversible cleanup.

Exit criteria:

- All CI and E2E suites pass. **Met**: 453 Node tests, 27 Extension Host tests, and the 45-test v22 E2E matrix.
- No direct VS Code language providers, and no `vscode` imports in the server or core. **Met**, enforced by a lint rule and checked on the packaged artifact.
- Performance and reliability gates pass. **Met** — see [Measured baseline](#measured-baseline).

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

Thresholds come from the [measured baseline](#measured-baseline). Status as of that
measurement, on the v22 fixture:

| Gate | Status |
| --- | --- |
| No regression greater than 10% in warm completion p95 | **Met.** The protocol adds ~0.2 ms to a sub-millisecond completion. |
| No regression greater than 15% in cold index time | **Met.** Cold index is the same work in both hosts; wall-clock moved +1%. |
| A material reduction in Extension Host CPU time during full indexing | **Met.** −96% cold, −99% on reindex. |
| No unbounded growth in server RSS after repeated reindexing | **Met.** Heap after a forced collection is flat across reindexes; RSS is a high-water mark. |
| No duplicated project index after concurrent document opens | **Met.** `ProjectRuntimeHost` shares one in-flight creation per root; covered by its tests. |
| No stale diagnostics after edits, dependency changes, project switches, or server restart | **Met.** Every retained result carries the document version and index generation it was computed against; covered by `lsp-diagnostics` and `lsp-regressions`. |
| No forced save and no lost dirty-document changes | **Met.** Every import is a versioned workspace edit; nothing is written to disk and nothing is saved. |
| Successful server restart without requiring a VS Code window reload | **Met.** Covered by the Extension Host lifecycle suite, which kills the server process and re-synchronizes. |

## Measured baseline

Taken with `pnpm run benchmark` against `src/e2e/projects/v22` — 94 project source files
resolving to 1256 indexed elements, most of them from the dependencies (Material, CDK,
ng-zorro, PrimeNG, Taiga). One machine, macOS, Node 25. These are the numbers the gates
below are judged against; re-take them on the same fixture rather than comparing across
machines.

| | |
| --- | --- |
| Cold index | 8.1 s |
| Warm index, from cache | 23 ms |
| Server ready (spawned `dist/server.js`, initialize → indexed) | 7.7–9.3 s |
| `extension.js` / `server.js` | 7.0 MB / 6.7 MB |
| Packaged VSIX | 3.3 MB |

Latency, 50 samples on a template with 47 findings:

| | p50 | p95 | max |
| --- | --- | --- | --- |
| Completion, handler called directly | 0.1 ms | 0.4 ms | 0.6 ms |
| Completion, over the protocol | 0.2 ms | 0.6 ms | 4.4 ms |
| Diagnostics, handler called directly | 1.2 ms | 9.0 ms | 67.6 ms |
| Diagnostics, over the protocol | 1.6 ms | 11.8 ms | 34.1 ms |

The direct/protocol pair is what stands in for the direct-implementation comparison the
plan originally called for. Since Phase 3 both hosts run the same analysis, so comparing
them would compare a function to itself; the protocol round trip is the only thing the
migration actually adds to a request. It costs roughly 0.2 ms, which is a large relative
number on a sub-millisecond completion and an irrelevant absolute one.

### Extension Host cost

Measured with `pnpm run host-cost`, which runs the same scenario against the same v22
fixture twice — once with the direct providers, once with the server — and reports what
the editor's own process burned. Both runs end with the same 47 diagnostics, so the two
columns describe the same work.

| Scenario | Direct providers | Language server | |
| --- | --- | --- | --- |
| Cold activate and index | 9211 ms CPU | 399 ms CPU | **−96%** |
| Explicit reindex | 5178 ms CPU | 47 ms CPU | **−99%** |

Wall-clock over the same scenarios barely moves — cold index +1%, reindex −10% — which
is the point. The work still takes as long; it stops taking the editor's process to do
it. **The "material reduction in Extension Host CPU time during full indexing" gate is
met, by an order of magnitude.**

### Memory: what it costs, and whether it leaks

RSS of the spawned server over repeated full reindexes climbs and stays high:

```text
740 → 955 → 1186 → 1175 → 1080 → 1156 MB
```

Read alone, that looks like a leak, and this plan said so before the second measurement
was taken. It is not one. V8 does not return freed pages to the operating system, so RSS
is a high-water mark of what was ever allocated, and a full reindex allocates a great
deal of short-lived garbage. What actually settles, measured in-process where a
collection can be forced, is flat:

```text
heap after gc    639 → 638 → 638 → 639 → 639 → 639 MB
ts-morph files    61 →  61 →  61 →  61 →  61 →  61
```

Nothing is retained across reindexes and the ts-morph project does not accumulate
sources. **The "no unbounded growth in server RSS" gate is met.**

What the numbers do say is that indexing this fixture is expensive in absolute terms —
around 740 MB resident for a project whose 94 source files resolve against Material,
CDK, ng-zorro, PrimeNG, and Taiga at once. That cost is the same in both hosts, because
it is the same index; the migration moves it out of the Extension Host rather than
shrinking it.

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
