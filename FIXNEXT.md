# FIXNEXT

Defects and scheduled work left after the language-server migration (see `PLAN.md`).
Separate from `TOFIX.md`, which records pre-existing quirks in the analysis itself that
were deliberately preserved.

Ordered by what a user would notice first.

---

## 1. Symbolic links in a source tree are not followed — decided, not deferred

**Severity: none for the layouts that were checked. Recorded so it is not rediscovered
as a bug.**

The scan this replaced ran through `vscode.workspace.findFiles`, and therefore on
ripgrep, which follows symbolic links by default. The server's own walk does not: a
`Dirent` reports a link as neither a file nor a directory, so it falls through both
branches of `collectFiles`.

Every layout suspected of needing it turned out not to:

- **pnpm** puts all of its links under `node_modules`, which the source scan excludes
  before entering. Dependencies are indexed through a different path that resolves
  them with `fs.realpath` (`utils/package-json.ts`), pnpm included, by name.
- **A pnpm workspace package** (`node_modules/@org/ui` → `packages/ui`) arrives by that
  same path and the same `realpath`.
- **A git worktree** holds real files; its `.git` is a regular file, not a link. The
  `node_modules` people symlink into one is skipped by the scan either way and resolved
  by `realpath` for dependencies. A symlinked *root* works too: `readdir` follows links
  in the path it is given, only entries below are skipped.

What is left is a link to a source directory placed by hand. Restoring it is not a
one-liner: it needs a `stat` per link entry to tell a directory from a file, and a set
of visited real paths, because a link to an ancestor is otherwise walked until the
kernel raises `ELOOP` — about thirty times over, indexing the same component under
thirty different paths.

**Decision:** do not follow. Instead the walk logs `Skipping <path>: symbolic links are
not followed`, so a user whose element never appears has a trail rather than silence.
Pinned by "does not follow a symbolic link, and reports each one it skipped" in
`src/test/node/node-file-system.test.ts`, and explained where the decision lives, in the
module note of `src/adapters/node/file-system.ts`.

Revisit only if someone reports a real layout that needs it — then it is the `stat` plus
the visited set, and a test for the loop.

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

## 4. The v22 e2e suite fails intermittently under parallel load

**Severity: unknown, and it sits on the last gate before shipping.**

Five runs of `pnpm run test:e2e:v22:parallel` on the same `dist/` bundle: two failed,
three passed with the full 45. The two failures had different shapes, which is what
makes this worth writing down rather than re-running.

**First shape — the index was not there yet.** Three tests in each of the three shards,
nine in total, across three independent VS Code processes:

```
AssertionError: Expected 47 diagnostics, got 0
AssertionError: Expected 106 diagnostics, got 0
```

Every one of those assertions reads what a `before` hook collected from
`waitForDiagnosticsToStabilize`. A server that had not finished indexing when the hook
gave up produces exactly this, in every shard at once, under load. Nothing points at the
extension: the same fixture indexes identically in-process, 94 source files and 1256
elements.

**Second shape — two different races in one run.** The material shard exceeded mocha's
168s timeout on "quickfixes apply correct imports", which applies edits and saves. The
ng-zorro shard launched a second Extension Host that reported

```
No descriptor.json files found in out/e2e/cases. Run the generator first.
```

and passed one placeholder test, after its first host had already run the real cases.
The descriptors were present before and after the run, so `out/` was momentarily not
what the shard expected — `compile-tests` begins with `rm -rf out`, and
`copy-e2e-cases` fills `out/e2e/cases` after it.

**And a failed run does not clean up after itself.** The quickfix cases strip a
fixture's imports, apply the fixes, and restore the file in an `after` hook. A test that
times out never reaches it, so
`src/e2e/projects/v22/apps/ng-zorro-demo/src/app/playground/nz-playground.component.ts`
was left in the repository with 101 of its import lines gone. The next run therefore
starts from a state nobody chose, which is one way a single flake turns into a streak.

**Suggested fix, in the order they are worth doing:**

1. Make the wait observable rather than timed. The server already answers
   `PerformanceMetricsRequest` with a per-project element count, which the node
   regression suite uses to wait for the index. Have the e2e `before` hook wait on that
   before it waits for diagnostics, so a timeout means a hang rather than a slow machine.
2. Find out why a shard starts a second Extension Host at all, and whether anything can
   rebuild `out/` while shards are running.
3. Restore the fixtures from git after the suite, whatever its outcome, so one failure
   cannot change what the next run measures.
4. Scale the parallelism to the machine, or let a shard report its own load, so three
   VS Code instances on a laptop are not the default.

---

## 5. The Extension Host cost measurement is a single sample

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

## 6. The suites have never run on Windows

**Severity: unknown, which is the point.**

Everything known to break on Windows has been fixed rather than deferred — boundary-unsafe
path comparison, and a cache key that mixed ts-morph's forward slashes with the platform's
separator. Both have tests that fail without their fix on any platform.

What has not happened is a run on Windows. The URI regression asserts a round trip rather
than a fixed string, so it is meaningful there; it has simply never executed there.

**Suggested fix:** a CI job on `windows-latest` running `pnpm run test:node`. The Node
suites need no editor and are the ones that would catch a path defect.
