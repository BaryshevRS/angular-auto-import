# FIXNEXT

Defects and scheduled work left after the language-server migration (see `PLAN.md`).
Separate from `TOFIX.md`, which records pre-existing quirks in the analysis itself that
were deliberately preserved.

Ordered by what a user would notice first.

---

## 1. A nested Angular project's elements pollute the index of the project containing it

**Severity: real, user-visible. Affects monorepos, which is most of the audience.**

The project scan walks the whole root, including directories that are themselves Angular
packages. In a workspace shaped like:

```
workspace/                 ← an Angular project
  src/outer.component.ts       app-outer
  packages/ui/               ← also an Angular project
    src/inner.component.ts     app-inner
```

the outer project indexes both:

```
outer project indexed selectors: ["app-inner", "app-outer"]
app-inner indexed path: packages/ui/src/inner.component.ts
```

Routing is not the problem — a document inside `packages/ui` is correctly served by the
nested project, and `lsp-regressions` pins that. The problem is the outer project's own
index: a template in `workspace/src` is offered `app-inner`, and accepting it writes an
import resolved against the *outer* project's tsconfig, for a file that belongs to a
package with its own. The path may not resolve at all, and if it does it reaches across a
package boundary the workspace deliberately drew.

This is not new — the previous implementation scanned the same way — but it is worth
fixing now that discovery knows where every nested root is.

**Where:** `core/source-files.ts` (`projectSourceQuery`), which excludes only
`node_modules`, `dist`, and similar. `services/indexer.ts` consumes it.

**Suggested fix:** exclude directories that are themselves discovered Angular roots. The
scan would need the set of known roots, which `ServerProjects` has and `ProjectRuntime`
does not — so this is a small plumbing change plus one filter, and a regression test that
asserts the outer index does *not* contain the nested project's selectors.

---

## 2. An inline completion inside a single-line decorator still needs a round trip

**Severity: minor. Correct today, just slower and a separate undo step.**

An accepted completion in an inline template carries its import as
`additionalTextEdits`, applied and undone in one step. That is skipped when the import's
edits would overlap the text the completion itself replaces, which happens when the
decorator is written on one line:

```ts
@Component({ standalone: true, template: "<shop-c", imports: [] })
```

Here `imports: []` and the template are the same line, so the two edits are the same
range and no client may apply both. The item falls back to the server command, which is
correct — the import lands — but costs a round trip and lands as a second undo entry.

**Where:** `lsp/completion.ts`, `overlaps()`.

**Suggested fix:** split the overlapping edit at the completion's range instead of
abandoning the whole set — the import's insertion point and the completion's are never
actually the same characters, only the same line. Worth doing only if single-line
decorators turn out to be common; they are not idiomatic.

---

## 3. `src/legacy-cache.ts` is temporary and has no removal trigger

**Severity: none today. It becomes dead weight silently.**

It deletes the index cache the previous implementation wrote into VS Code's workspace
state. Once users have opened their workspaces once on a version that includes it, it has
nothing left to do — but nothing will announce that moment.

**Suggested fix:** delete the module, its test, and its call in `extension.ts` after one
stable release. Cheap to keep, cheaper to remember.

---

## 4. The Extension Host cost measurement is a single sample

**Severity: none functionally. It weakens a claim the project makes.**

`PLAN.md` reports −96% Extension Host CPU on a cold index, from one run of
`pnpm run host-cost` per implementation, on one machine. The order of magnitude is not in
doubt — 9211 ms against 399 ms is not measurement noise — but the precise percentages are
not defensible as written.

**Suggested fix:** run the measurement several times and report a median, or state the
sample size beside the number. The comparison against the previous implementation can no
longer be re-run at all, since that implementation is gone; its recorded numbers are all
there will ever be.

---

## 5. The suites have never run on Windows

**Severity: unknown, which is the point.**

Everything known to break on Windows has been fixed rather than deferred — boundary-unsafe
path comparison, and a cache key that mixed ts-morph's forward slashes with the platform's
separator. Both have tests that fail without their fix on any platform.

What has not happened is a run on Windows. The URI regression asserts a round trip rather
than a fixed string, so it is meaningful there; it has simply never executed there.

**Suggested fix:** a CI job on `windows-latest` running `pnpm run test:node`. The Node
suites need no editor and are the ones that would catch a path defect.
