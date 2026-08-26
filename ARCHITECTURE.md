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
| Which files does that project index? | `core/source-files` |

What differs between hosts is only how a request reaches that code and how the answer is
rendered. That is the point of the split, and it is what makes the parity suite
meaningful: it compares wiring, not arithmetic.

### What an NgModule is

A module's class name does not identify it. `ScrollingModule` is declared by both
`@angular/cdk/scrolling` and `@angular/cdk-experimental/scrolling`, and they export
different things; so is `SharedModule`, once per library in most monorepos. The index in
`core/element-index` therefore keeps one entry per **path** a module of that name is
imported from — a library's specifier, a project module's file — each with its own export
surface.

Which entry answers a question comes from the file asking it: the component's own
`import` statement names the module, and that specifier selects the entry. A module is
asked about under the name it is *declared* with, never the one the asking file happens
to call it — `import { ScrollingModule as CdkScrolling }` renames it in one file and
nowhere else. The written specifier settles every library module, because that is the
string the entry is keyed by. A project module is written as a relative path or an alias,
so its file is resolved instead — through TypeScript, never by rewriting the string — and
only when a name is genuinely ambiguous, since resolving a specifier makes the compiler
load the file it names.

What happens when nothing decides depends on who asked. A file that names an import gets
nothing back: its import matched no entry, so answering from one of the others would
describe a module that file does not import — and answering from all of them, as a union,
is exactly how a component importing the experimental `ScrollingModule` would be told the
CDK's viewport is already available to it. The union is the right answer only to the
overview question, the one asked with no import in hand: does *any* module of this name
export this.

A name with a single entry is the exception, and only when a component's own
`imports: [...]` is the question: there is nothing to distinguish it from, and refusing
would turn every specifier this project cannot resolve into a false "missing import".
Following a re-export is selected strictly instead — the module said which one it
re-exported, and being the last candidate standing does not make an unrelated module
that one.

Resolving a specifier is TypeScript's answer, so the indexer's `ts-morph` project is
given the project's `tsconfig.json` itself — the path, not options read out of it, and
with its files left unadded. Without it `@app/shared` resolves to nothing, which is most
of how a monorepo is written; with options copied out of it, a `paths` entry inherited
through `extends` would be resolved against the config that *inherited* it rather than
the one that declared it, which in a monorepo is two directories up.

A resolution is never persisted, only the specifier that produced it. Where an alias led
is a fact about the tsconfig, not about the module that used it: repointed while the
extension was down, the specifier still reads the same, and a saved answer beside it
would be believed rather than asked again.

Nor is the path a module is imported from its identity. One module class is commonly
reachable from several entry points — `@lib/components/svg`, `@lib/components` and `@lib`
all export the same `SvgModule` — and those are one module, not three. The file the class
is *declared* in is what says so, and it is what two entries are compared by before one
of them is called a different module. Getting this wrong is not a missed suggestion: it
tells someone the module they are looking at in their imports is not imported.

**A name is not an identity, for elements either.** An element reached through an
NgModule is indexed as that module: same name, same import path, for every element the
module exports. What separates them is the selector, and `elementIdentityKey` is that
triple — used to store one element per identity in the selector trie (a re-read replaces
the older reading rather than sitting beside it), to retract exactly what a rescan did
not produce again, and to key the per-file "is it imported" answers, which by name alone
would hand every element of a module the answer the first one got.

An entry's `exports` are the names as *declared*, not as the file writes them: a module
whose `exports: [LocalShared]` follows `import { SharedModule as LocalShared }` is
recorded as exporting `SharedModule`, alongside the specifier it came from — one name can
carry several, since `exports: [LeftShared, RightShared]` is two modules the collision has
made one name, and both are re-exported. That pair is
what makes a re-exported module resolvable — following it by name alone is the same
collision one level down, which is how a feature module ends up claiming to export both
`SharedModule`s in a workspace that has two. The specifier is resolved to a file only
when the name it refers to is ambiguous, and the answer is kept. When it names a module
the index does not hold, the re-export expands to nothing: the alternatives are modules
this file demonstrably did not import.

An entry keeps those direct names separately from what they expand to. Only the direct
ones are persisted; a file that is edited or deleted retracts its entries and re-expands
the rest, which a merged set could never do, since it can grow but never shrink.

A file that declares both an element and the NgModule exporting it is its own dependent,
so the pass that re-reads dependent elements does not re-read their modules — that is the
same pass, and it would never end.

The same retraction applies to what a module says about the elements it exports: those
are candidates, kept per module, and the one to suggest is chosen when a quick fix asks
rather than fixed at index time — so a module that stops exporting an element leaves the
others standing instead of taking the answer with it. Dependency rescans retract the same
way: a library that is gone stops answering both for its modules and for its elements,
and only a scan that ran to the end is allowed to decide what is gone.

### What a selector says, and what it does not

A selector is not owned by the class named after it. `[tuiSlot]` belongs at once to a
block-status directive, an app-bar directive and a badged-content directive; `translate`
is a pipe in `@ngx-translate/core` and a pipe in the workspace. Two rules follow, and
both are about telling one question from another.

**Is anything missing?** No, if the file imports an element whose selector demands
*exactly* the same thing — whatever that element is called. Two of those are two owners
of one token, and one of them being imported settles it. The cost is that a template
which meant the badged-content directive while importing the block-status one gets no
suggestion; Angular applies the imported one either way, so neither answer is right for
both, and a suggestion that never comes is the cheaper way to be wrong.

Demanding *more* or *less* is a different directive that merely also matches here, and
it settles nothing: an imported `[nz-button][nz-dropdown]` leaves `[nz-dropdown]`
missing, an imported `[foo]` is not the `button[foo]` — or the `[foo=check]` — a template
is asking for, and `[foo]:not([disabled])` is not `[foo]`, since on an element that is
not disabled Angular applies both. What each selector demands is read from the compiler's
parse of it: the tag, the attributes, their values, the conditions.

These rules are written out as a table in `src/test/node/selector-rules.test.ts`, every
pair of selectors against every other. Each of them was first written to fit one example
and then found wrong by the next one, which is what the table is for: a reviewer reads it
instead of finding the next example.

**Which of them speaks for the token?** One token is one marker, and the marker goes to
the directive whose selector is *exactly* that attribute and nothing else — no tag, no
value, no `:not(...)`: `[nz-dropdown]` for a `nz-dropdown` token, whatever else also
matches there. Failing that, to the one that
demands the most: on a `nz-button` token, `[nz-button][nz-dropdown]` is what a user has
to import to make that button a dropdown, while a ripple directive that comes along with
the button merely has a longer selector string.

**What should be imported?** One token is one marker, so its reports are merged — but
the merged diagnostic carries *every* element that would have satisfied it, and the fix
is chosen among those. Ranking over everything the selector matches is a different
question, and its answer routinely includes what the file already imports: that is how a
quick fix comes to offer an import that is already there and do nothing when applied.

All of them are offered, ranked, rather than the best one alone. `[tuiSlot]` is an
app-bar directive and a block-status directive, the template does not say which was
meant, and choosing for the user is worse than it looks: Angular applies whichever the
file imports, so the wrong choice leaves a file with no warning and without the behaviour
its author was after. The most specific one is marked preferred, so an editor's own "fix
this" still has a single answer, and the rest sit in the menu as the alternatives they
are.

Ranked, and not filtered again. The elements a diagnostic carries were matched against
the template node — its tag, its attributes and their values — while the selector in its
code is only the one they were reported under, and running the matcher a second time
against that string drops everything that demands more than the token names:
`button[foo]` from a `[foo]` token, `[foo=check]`, `[foo][bar]`. The second question,
"does this element match at all", is answered only where nothing better is known, when a
diagnostic carries no elements and the selector is all there is.

**Alternatives, or directives that come together?** The same demands comparison decides
both, and it is the difference between one import and several. Two elements that demand
the same thing are two owners of one token: importing either settles it, and the other is
then suppressed rather than reported again — that is what makes the menu a choice. Two
that demand differently are separate directives Angular applies at once, and the token
needs all of them: on `<button foo="check">`, `[foo]`, `button[foo]` and `[foo=check]`
are three imports, not three candidates for one.

The menu does not have to tell them apart — it offers every element and the user picks —
but the fix-all does, since it promises to leave nothing missing. It takes one element
per set of demands: the most specific of each, which stands for the alternatives it was
chosen over. Taking one per *token* imported a third of what `<button foo="check">`
needed and brought the diagnostics it had just cleared straight back. Each element
therefore carries what its selector demands, as a key computed where the compiler already
parses it, since by the time a fix-all runs there is no template node left to ask.

**And nothing along the way may key by it.** Because a selector names several elements,
it cannot be used as an identity anywhere they are stored — the trie keys elements by
name, declaring path and original selector, and the persisted index is a *list* of
elements rather than a map from selector to one of them. The map form was there for a
while and lost whichever of `[tuiSlot]`'s directives was written last, so the fix a user
was offered for that token depended on the order the scan had happened to run in: stable
within a session, different after the next restart, and impossible to see in a test that
counts diagnostics, since the count is the same either way.

### What counts as imported

A name in `imports: [...]` is not always a class. A library ships a component together
with the directives that belong to it as one array — Taiga's `TuiComboBox` is
`readonly [typeof TuiComboBoxDirective, typeof TuiLabel, …]` — and Angular takes that in
`imports` as if its members were written out. A bundle's members need not come from the
package the bundle does: that `TuiLabel` is `@taiga-ui/core`'s.

What each bundle holds is read while its library is indexed, next to that library's
NgModule exports, and a workspace's own `[A, B] as const` is read when its file is. Asking
TypeScript instead, at the moment a template wants to know, means loading declaration
files that indexing deliberately released — and the question is asked for every element a
template is missing, against every name a component imports.

The question is also put the way round that costs nothing when the answer is no: *which
bundles hold this element*, rather than what each of a component's imports holds. A
component can list seventy of them, and every edit makes the answers stale.

The answer carries where each bundle comes from, because a name is not a bundle either:
`@lib/a` and `@lib/b` may both export a `Bundle` holding different things, and a local
variable may be called one and hold nothing. What a file has is what the bundle it
actually imports holds. And a bundle is retracted the way everything else is — with the
file that declared it, or with the library a dependency rescan no longer finds.

One consequence reaches the scan itself: a file whose only Angular content is
`export const UiKit = [KitBadgeDirective] as const` carries no decorator, so the cheap
pattern that decides what to read has to let it through as well.

### What a project is

A project root is a directory whose `package.json` declares `@angular/core`, found by
walking up from an opened document. Discovery is lazy and per document, so a workspace
holding several applications gets one index each, and the deepest root wins for a file
that several contain.

A root is not the whole of a project, though. Its `tsconfig.json` may map code that
lives beside it — in a monorepo, the libraries an application imports through
`compilerOptions.paths` and could not import any other way. `ProjectScope` in
`core/source-files` is the root together with those directories, and every rule about
what to scan, watch, and index is stated against a scope rather than a path.

Three rules decide what a `paths` entry contributes, and each is a decision rather than
a detail:

- an entry resolving **inside the root** adds nothing; the root's own scan covers it;
- an entry resolving to an **ancestor of the root** is dropped, because following it
  would index the whole tree the root was chosen out of;
- an alias root is scanned **without** the nested-package boundary the root is scanned
  with. That boundary exists to stop a project swallowing a package it merely contains;
  an alias is the opposite — the tsconfig saying outright that this code compiles as
  part of this project — so a library with its own manifest is still that project's
  library.

Where an entry points is `get-tsconfig`'s answer, not a heuristic over `baseUrl`: when
`baseUrl` is absent, TypeScript resolves `paths` against the config file that *declared*
them, which through `extends` is often several directories above the one being read.

`angular-auto-import.projectPath` names a root outright, and one named that way is not
re-checked against the manifest rule. The rule is a good guess for a single package and
a wrong one for the root of a monorepo; overruling an explicit setting with a guess, and
then silently indexing nothing, is the failure that avoids.

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

| Thing | Where it lives | How the server reaches it |
| --- | --- | --- |
| Index cache | one JSON file per project root under the client's `storageUri` | written directly; the client only supplies the directory |
| Logs | the client's output channel | `window/logMessage`, filtered by the same `logging` settings |
| Settings | the client's `workspace.getConfiguration` | sent at `initialize`, then pulled on change |
| File watching | the editor's watchers | registered via `client/registerCapability`, delivered as `didChangeWatchedFiles` |

The server cache is keyed by project root and only reused when both its schema version
and its fingerprint — the installed Angular version among them — still match. Anything
that does not match starts empty and reindexes.

The previous implementation cached the index in VS Code's `workspaceState` instead.
Nothing reads those entries now, so `src/legacy-cache.ts` deletes them once, in the
background, on activation. It is temporary by construction and should go after one
stable release.

## Testing

| Suite | Runs under | Covers |
| --- | --- | --- |
| `src/test/node` | plain Mocha | core analysis, server handlers, and the protocol |
| `src/test/node/lsp-protocol` | in-memory client + server | that the wire actually works |
| `src/test/node/lsp-parity` | in-memory client + server | the recorded E2E corpus, replayed against the server |
| `src/test/node/lsp-regressions` | in-memory client + server | nested roots, URI round trips, changes on disk |
| `src/test/suite` | VS Code host | activation, the contributed commands, and host-side utilities |
| `src/test/lsp` | VS Code host | the server's lifecycle, including killing it and recovering |
| `src/test/host-cost` | VS Code host | what a full index costs the editor's own process |
| `src/e2e` | VS Code host | the Angular 19/21/22 fixture matrix, and `v22-nx` for monorepo layout |
| `src/test/node/fixtures-clean` | in-memory client + server | that no fixture project reports anything its corpus did not record |

`.github/workflows/ci.yml` runs the first four on Linux and Windows. The rest need an
editor and a display and run locally — `pnpm run test:unit`, then
`pnpm run test:e2e:v22:parallel`, and last `pnpm run test:fixtures`.

That last one is separate from `test:node` because it indexes each project's
`node_modules` — about forty seconds for the four versions, against seventeen for
everything else — and because it is a check on the fixtures rather than on the code: a
warning a fixture shows that no case asked for is either a false positive or a fixture
that stopped compiling, and both used to be found by noticing a squiggle.

The version projects share one shape: a single manifest at the workspace root, with
`libs/` inside it. That shape cannot reproduce a monorepo's discovery problem, because
the project root *is* the workspace root and the libraries are already under it — an
alias there only decides how the import is written. `v22-nx` is the other shape:
tooling-only manifest at the root, `@angular/core` declared in `apps/shop`, libraries
outside that root reachable only through `compilerOptions.paths`, and no `baseUrl` so
those entries resolve against the config that declared them. It has one app, so there
is nothing to shard: `pnpm run test:e2e:v22-nx`.

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
- **Nothing is indexed anywhere.** The status bar item says so, and its tooltip names
  the reason: most often a monorepo whose root manifest carries only build tooling, in
  which case `angular-auto-import.projectPath` should name the application.
- **A library resolves at build time but is invisible here.** It reaches the index only
  through a `compilerOptions.paths` entry the project's own `tsconfig.json` can see. A
  changed mapping takes effect on `Reindex`.
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
