# The agent-facing half

The extension answers "what is under the cursor". This is the other half: what an agent
needs, which is a different question asked by something that has no cursor.

Written down because the design turns on facts about what already exists, and those took
an afternoon to establish. Nothing here is a guess about the landscape; every claim below
was checked.

## What already exists, and what it does not do

Angular ships its own MCP server — `ng mcp`, experimental in CLI v20.1, stable in v21.
Its tools:

```
ai_tutor · get_best_practices · search_documentation · list_projects
run_target · onpush_zoneless_migration
devserver.start · devserver.stop · devserver.wait_for_build
```

It knows **Angular**: the documentation, the best practices, `angular.json`, and how to
run a build. It knows nothing about a workspace's own components or the libraries
installed beside them. Its answer to "is this template right" is `devserver.wait_for_build`
— build it and read the log.

Angular's own `llms.txt` has the same shape. It covers syntax and patterns — standalone
over NgModules, `@if` over `*ngIf`, `inject()` over constructor injection — and says
nothing at all about import resolution, which is the one part that cannot be answered
without knowing the project.

The community servers are each scoped narrower than the problem:

| | knows Angular | the workspace's elements | installed libraries | what to import |
| --- | --- | --- | --- | --- |
| `ng mcp` (official) | yes | no | no | no |
| `push-based/angular-toolkit-mcp` | — | a configured design system only, needing `ds.uiRoot` and Storybook paths | no | no |
| Angular Component Inspector | — | one library's `public-api.ts` | no | no |
| Syncfusion MCP | — | no | its own components | for its own only |
| this project | — | yes | yes | yes |

Push-Based's is the serious one, and it is aimed elsewhere: deprecated CSS classes, a
usage graph for refactors, docs pulled from Storybook. It is a design-system tool.

## The failures this is for

Not invented. What developers report about AI-written Angular:

- **Imports that look right and are not.** "AI suggests imports that look perfect — variable
  names matching conventions, paths that look correct — but the build fails, because it
  hallucinated the interface to fit the pattern rather than the reality."
- **Confidently wrong input names.** "Suggesting props like `isLoading` on custom components
  when they actually use `loadingState`" — regressing to the mean of the training data
  rather than reading the definition in the project.
- **Wrong import paths, repeatedly.** Reported as a correction made several times a day.
- **Almost-right code.** Renamed things, decorators where signals belong, `*ngIf` rewritten
  every time.

The second of those is exactly what an indexed input surface answers, and nothing else
currently answers it. The first and third are what a planned import answers.

## What goes in

Ranked by the strength of the evidence that it is needed, not by how obvious the tool is.

**1. `element_api` — what a template may write on one element.** Inputs with their aliases
and whether each is required, outputs, the selectors it projects content into, the host
directives that come with it. Attacks the most-cited failure directly, and the data is
already indexed.

**2. `verify_template` — check a template, get the imports that fix it.** *Built.* The
counterpart to `devserver.wait_for_build`: 3 ms against a build, and the answer names the
class and the specifier, which a build log never does. Returns the component file
rewritten rather than a patch, because an agent writes files.

**3. `orient` — what kind of project this is.** Angular version, standalone or NgModule,
which UI libraries are actually used and how heavily, the path aliases, how many elements
are indexed. One call at the start of a session. Stops a model writing Material in an
ng-zorro workspace.

**4. `search` — find an element by what it does.** Last, and only worth having ranked by
what this workspace already uses: unranked, it returns forty candidates and the model
takes the first.

## What deliberately stays out

- **Anything Angular's own server does better.** No documentation search, no best-practices
  text, no tutor. Those are free, official, and better maintained there. The two servers
  are halves of one answer: that one teaches the model Angular, this one teaches it *this*
  Angular.
- **Anything needing a line and a column.** An agent has no cursor and will invent them.
  This is why the tools are not the language server's requests in another wrapper.
- **Unbounded results.** Five, with an honest count of the rest.

## Why the work cannot be wasted

The MCP is a second consumer of the index the extension already runs on. The input
surface added for `element_api` improves the editor's own suggestions; reading a project's
sources improves both. If the agent-facing half finds no audience, the half that is
already shipping got better anyway.

## State

`verify_template` is built and driven end to end against the v22 fixture: an ng-zorro
template on a real `AppComponent` returns `NzCheckListComponent`, `NzButtonComponent` and
the `NzWaveDirective` that comes with the button, leaves an already-imported
`<router-outlet>` alone, and hands back the component with three imports added. First call
6.5 s — the cold index — and 3 ms after that.

Sources checked: `angular.dev/ai/mcp`, `angular.dev/ai/develop-with-ai`,
`github.com/push-based/angular-toolkit-mcp`, and developer reports collected on dev.to.
