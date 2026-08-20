# Architecture

Angular Auto Import is being moved out of the VS Code Extension Host and into a language
server. Both implementations are present today: the direct providers are what ships, and
the server runs behind a flag. `PLAN.md` tracks the migration; this document describes
what exists now and where each concern lives.

## The three layers

```text
src/extension.ts, src/providers, src/commands      VS Code Extension Host
src/lsp                                            language server (and its client half)
src/core                                           editor-agnostic analysis
```

**`src/core` may not import `vscode`.** Neither may `src/lsp` (apart from its two
client-side modules) or the `node`/`lsp` adapters. This is enforced by a lint rule in
`biome.json` rather than by convention, and by a check on the packaged artifact — see
[Packaging](#packaging).

Anything the analysis needs from its host arrives as a port it is given, never as a
module it reaches for: `FileSystem`, `CacheStore`, `FileWatcherFactory`, `ProgressHost`,
`CoreLogger`, `CancellationSignal`. Each has an adapter under `src/adapters/<host>`.

## What the two hosts share

Since the analysis moved into `src/core`, both hosts run the same code for every
decision a user can see:

| Question | Module |
| --- | --- |
| What is the cursor completing? | `core/completion-context` |
| Which elements answer to it, in what order? | `core/completion-suggestions` |
| What does this template use? | `core/template-scan` |
| Which of those is missing an import? | `core/missing-imports` |
| What edits add an import? | `core/import-planner` |
| Which specifier is the import written with? | `core/import-resolution` |
| Which project owns this file? | `core/project-registry`, `core/project-discovery` |

The hosts differ only in how a request reaches that code and how the answer is rendered.
That is the point of the split, and it is what makes the parity suite meaningful: it
compares wiring, not arithmetic.

## The client/server boundary

The client starts one server per window over IPC and owns everything with a UI —
commands, notifications, webviews, progress, the output channel. The server owns
everything with a cost: `ts-morph`, `@angular/compiler`, the project indexes, the
dependency indexes, the caches, and the watching that keeps them current.

Language features go over standard LSP. Only the extension's own operations — reindex,
clear cache, metrics, the diagnostics report — use custom requests, declared once in
`src/lsp/protocol.ts` as `RequestType` constructors both sides import.

### Applying an import

An import belongs in the component's TypeScript file, which for an external template is
not the file being edited. No completion edit can express that, so:

1. The completion item carries a command, `angular-auto-import.lsp.applyImport`.
2. The client runs it; it reaches the server's `executeCommand` handler.
3. The server plans the edit against the file as the user currently sees it — the open
   document's unsaved text when there is one, the file on disk otherwise.
4. The server returns a **versioned** `workspace/applyEdit`, so the client rejects it if
   the file moved on.

Nothing is written to disk and nothing is saved. Code actions take the same planner but
deliver the edit through `codeAction/resolve` instead, because computing it means
rewriting the component with `ts-morph` — far too expensive for actions the editor is
merely listing.

### Diagnostics

The server answers pull diagnostics and advertises `interFileDependencies`, because a
component's TypeScript file decides its external template's report. It asks the client
to re-pull after a TypeScript document changes, after a project's index generation
advances, and once the Angular compiler finishes loading; those requests are coalesced.

The three modes behave as they always have — `full` returns the items, `quickfix-only`
retains them for code actions and returns none, `disabled` computes nothing — because
what is *shown* and what is *retained* are answered separately.

Every retained result carries the document version and index generation it was computed
against. A code action recomputes rather than reusing one that no longer describes the
document.

## Where things live at runtime

| Thing | Extension Host | Language server |
| --- | --- | --- |
| Index cache | `workspaceState` | one JSON file per project root under the client's `storageUri` |
| Logs | output channel, optional log files | forwarded to the client's channel, filtered by the same `logging` settings |
| Settings | `workspace.getConfiguration` | sent at `initialize`, then pulled on change |
| File watching | `workspace.createFileSystemWatcher` | registered via `client/registerCapability`, delivered as `didChangeWatchedFiles` |

The server cache is schema-versioned and keyed by project root and project fingerprint.
Anything that does not match starts empty and reindexes; the old workspace-state cache is
left alone until the direct implementation is removed.

## Testing

| Suite | Runs under | Covers |
| --- | --- | --- |
| `src/test/node` | plain Mocha | core analysis, server handlers, and the protocol |
| `src/test/node/lsp-protocol` | in-memory client + server | that the wire actually works |
| `src/test/node/lsp-parity` | in-memory client + server | the recorded E2E corpus, replayed against the server |
| `src/test/node/lsp-regressions` | in-memory client + server | nested roots, URI round trips, changes on disk |
| `src/test/suite` | VS Code host | the direct providers and activation |
| `src/e2e` | VS Code host | the Angular 19/21/22 fixture matrix |

`src/test/node/harness/lsp-harness.ts` runs the real `createServer` over a duplex pair,
so both sides speak JSON-RPC exactly as they would across a process boundary. Note that
it sends `processId: null` deliberately: a process id makes the server poll whether its
parent is alive, forever, and an in-process client is not a process the server could
outlive.

## Packaging

`pnpm run vsce:package` produces the archive; `pnpm run vsce:inspect` then checks it.
Bundling is where this migration can fail silently — the source can be clean, the tests
can pass, and the shipped archive can still carry a server that reaches for `vscode` or
leaves `@angular/compiler` as a bare require that resolves to nothing. That is checked on
the artifact, not on the source tree.

## Troubleshooting

- **Diagnostics report nothing at all.** The Angular compiler is imported lazily, and
  until it lands every request answers empty — which reads exactly like a clean
  workspace. `Show Performance Metrics` reports whether it has loaded.
- **A newly installed dependency is invisible.** Discovery caches its manifest checks;
  writing `package.json` invalidates the entry for that package.
- **An element is indexed but never offered.** Check whether the component is standalone:
  a component that cannot hold `imports` of its own is skipped, and an unsaved edit that
  makes it standalone is trusted before the file on disk is.
- **Nothing works and the output channel is silent.** The server may have failed to
  start. `Show Logs` opens the channel; reloading the window restarts it.
