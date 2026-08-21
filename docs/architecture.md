# Architecture

Angular Auto Import runs its language analysis in a language server rather than in the
VS Code Extension Host. The migration is finished: the direct providers, their commands,
and the flag that used to choose between the two are gone, and `src/extension.ts` does
nothing but start and stop the client. This document describes what exists now and where
each concern lives; what the move cost and saved is at the [end](#what-the-move-bought).

## The three layers

```text
src/extension.ts, src/commands      VS Code Extension Host (client half)
src/lsp                             language server (and its client half)
src/core                            editor-agnostic analysis
```

**`src/core` may not import `vscode`.** Neither may `src/lsp` (apart from its two
client-side modules) or the `node`/`lsp` adapters. This is enforced by a lint rule in
`biome.json` rather than by convention, and by a check on the packaged artifact — see
[Packaging](#packaging).

Anything the analysis needs from its host arrives as a port it is given, never as a
module it reaches for: `FileSystem`, `CacheStore`, `FileWatcherFactory`, `ProgressHost`,
`CoreLogger`, `CancellationSignal`. Each has an adapter under `src/adapters/<host>`.

## What lives in the analysis core

`src/core` holds every decision a user can see, so that the server and the client's own
code paths cannot disagree about them:

| Question | Module |
| --- | --- |
| What is the cursor completing? | `core/completion-context` |
| Which elements answer to it, in what order? | `core/completion-suggestions` |
| What does this template use? | `core/template-scan` |
| Which of those is missing an import? | `core/missing-imports` |
| What edits add an import? | `core/import-planner` |
| Which specifier is the import written with? | `core/import-resolution` |
| Which project owns this file? | `core/project-registry`, `core/project-discovery` |

What differs between hosts is only how a request reaches that code and how the answer is
rendered. That is the point of the split, and it is what makes the parity suite
meaningful: it compares wiring, not arithmetic.

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

## What the move bought

Measured with `pnpm run host-cost`, which runs one scenario against `src/e2e/projects/v22`
— 94 project source files resolving to 1256 indexed elements, most of them from
dependencies — and reports what the editor's own process burned. One machine, macOS,
Node 25. Both columns ended with the same 47 diagnostics, so they describe the same work.

| Scenario | Direct providers | Language server | |
| --- | --- | --- | --- |
| Cold activate and index | 9211 ms CPU | 399 ms CPU | **−96%** |
| Explicit reindex | 5178 ms CPU | 47 ms CPU | **−99%** |

Wall-clock barely moves — cold index +1%, reindex −10% — which is the point. The work
still takes as long; it stops taking the editor's process to do it. Completion is
unchanged apart from the protocol round trip, roughly 0.2 ms, a large relative number on
a sub-millisecond request and an irrelevant absolute one.

Server memory looks alarming and is not. RSS over repeated full reindexes climbs and
stays high, because V8 does not return freed pages to the operating system and a reindex
allocates a great deal of short-lived garbage. Measured in-process where a collection can
be forced, what settles is flat across reindexes.

The left-hand column cannot be re-measured: the implementation it describes no longer
exists. It is recorded here because it is the whole justification for the split, and
because the numbers are one sample each — see `FIXNEXT.md`. The right-hand column is
still checked by `src/test/host-cost`, which keeps it honest as the server changes.
