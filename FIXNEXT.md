# FIXNEXT

Defects and scheduled work left after the language-server migration.
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

## 4. The v22 e2e suite has been flaky under parallel load

**Severity: was real. Three of its four causes are fixed; the fourth is unexplained.**

Five runs of `pnpm run test:e2e:v22:parallel` on one bundle: two failed, three passed
with the full 45. What was found and what was done:

**A quiet window that opened before there was anything to be quiet about.** Every failing
diagnostics assertion read zero. `waitForDiagnosticsToStabilize` started its stable timer
immediately and resolved on timeout with whatever it had, so a server that had not
finished indexing looked settled after `stableMs` and the caller asserted against an
empty array. It now takes the count the caller is waiting for, refuses to call anything
short of it settled, and throws on timeout saying what it saw. **Fixed.**

**A run that left the repository changed.** The quickfix cases strip a fixture's imports
and restore them in an `after` hook a timed-out test never reaches, so
`nz-playground.component.ts` was left missing 101 import lines and the next run would
have started from it. `scripts/e2e-parallel.mjs` now restores what the run modified —
and only that, leaving alone whatever was already dirty when it started. **Fixed.**

**A shard that ran against nothing and called it success.** With no descriptors the suite
registered one passing placeholder, so the shard reported green. It now fails. **Fixed.**

**A second Extension Host, unexplained.** In one run the ng-zorro shard started a second
host after its first had already run the cases, and that host reported no descriptors at
a path with no version segment — meaning it came up without the workspace folder. The
guard above means such a host now fails loudly instead of reporting success, but why it
starts at all is unknown.

**Still worth doing:** find out what restarts a host mid-run, and scale the shard count
to the machine rather than always running three VS Code instances at once. The material
shard also once exceeded mocha's 168s timeout on "quickfixes apply correct imports",
which applies edits and saves; that may be the same load problem or its own.

---

## 5. The Extension Host cost measurement is a single sample

**Severity: none functionally. It weakens a claim the project makes.**

`ARCHITECTURE.md` reports −96% Extension Host CPU on a cold index, from one run of
`pnpm run host-cost` per implementation, on one machine. The order of magnitude is not in
doubt — 9211 ms against 399 ms is not measurement noise — but the precise percentages are
not defensible as written.

**Suggested fix:** run the measurement several times and report a median, or state the
sample size beside the number. The comparison against the previous implementation can no
longer be re-run at all, since that implementation is gone; its recorded numbers are all
there will ever be.

---

## 6. The Extension Host and E2E suites still run only on one machine

**Severity: low, and much narrower than it was.**

`.github/workflows/ci.yml` runs formatting, types, and the Node suites on
`ubuntu-latest` and `windows-latest` for every push to `main` and every pull request.
Windows now passes.

It did not at first, and what it found is the point of having it:

- **Line endings.** Git checks out CRLF on Windows and biome formats to LF, so the first
  run reported all 151 files as misformatted before a test ran. `.gitattributes` now
  makes the repository decide.
- **`cp -r` in two npm scripts**, which Windows does not have. They use `fs.cpSync`.
- **29 Node tests written in POSIX.** `path.join(path.sep, "workspace", "app")` is
  `\workspace\app` on Windows, which is relative to the current drive, so the code
  under test resolved `D:\workspace\app` and the assertion still held the drive-less
  string. And `file:///workspace/app` is not a file URL there at all — the server drops
  a folder whose URI it cannot convert, so five assertions compared an empty array
  against the roots that should have been in it, rather than disagreeing about a path.

No defect in the extension itself: everything known to break on Windows had already been
fixed, and those fixes hold. What had never been checked was whether the suites could
run there to say so.

What still runs nowhere but one laptop: the Extension Host suite and the E2E matrix.
Both download VS Code and need a display, and the E2E fixtures install their own
dependencies, which this repository does not track — so a job for them means committing
to provisioning three Angular workspaces per run.

**Suggested fix:** add an `xvfb-run` job for `pnpm run test:unit` first, which needs only
the editor. Leave E2E manual until its fixtures have a story that does not involve a
fresh `pnpm install` of three Angular projects.
