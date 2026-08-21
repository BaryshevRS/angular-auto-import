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

## 5. `pnpm run docs:build` deletes hand-written documentation

**Severity: real, and it fired during this work.**

```json
"docs:build": "rm -rf docs && typedoc"
```

`docs/` holds both typedoc's output and documentation nobody generated:
`docs/architecture.md`, which `CLAUDE.md` tells every contributor to read before touching
`src/core` or `src/lsp`, and `docs/factory/**`, the recorded goals and evidence of past
work. `rm -rf docs` takes all of it, and typedoc puts back only the half it produced.

This is not hypothetical. All 47 tracked files under `docs/` disappeared from the working
tree mid-session and were restored with `git checkout -- docs/`. Nothing was lost because
everything was committed, which is the only reason this is an annoyance rather than a
loss.

**Suggested fix:** generate into `docs/api/` and delete only that, or drop the `rm -rf`
and let typedoc overwrite what it owns. Either way the hand-written files stop sharing a
directory with a directory that gets removed.

---

## 6. The Extension Host cost measurement is a single sample

**Severity: none functionally. It weakens a claim the project makes.**

`docs/architecture.md` reports −96% Extension Host CPU on a cold index, from one run of
`pnpm run host-cost` per implementation, on one machine. The order of magnitude is not in
doubt — 9211 ms against 399 ms is not measurement noise — but the precise percentages are
not defensible as written.

**Suggested fix:** run the measurement several times and report a median, or state the
sample size beside the number. The comparison against the previous implementation can no
longer be re-run at all, since that implementation is gone; its recorded numbers are all
there will ever be.

---

## 7. The Extension Host and E2E suites still run only on one machine

**Severity: low, and narrower than it was.**

`.github/workflows/ci.yml` now runs the Node suites, formatting, and the type check on
`ubuntu-latest` and `windows-latest` for every push to `main` and every pull request.
That closes what mattered: everything known to break on Windows — boundary-unsafe path
comparison, a cache key mixing ts-morph's forward slashes with the platform separator —
is covered by Node suites that need no editor, and the URI regression asserts a round
trip rather than a fixed string, so it is meaningful there.

Setting it up turned up one real portability defect on the way: `copy-test-fixtures` and
`copy-e2e-cases` shelled out to `cp -r`, which is not a command Windows has. They use
`fs.cpSync` now.

What still runs nowhere but one laptop: the Extension Host suite and the E2E matrix. Both
download VS Code and need a display, and the E2E fixtures install their own dependencies,
which this repository does not track — so a CI job for them means committing to
provisioning three Angular workspaces, or building them in the job.

**Suggested fix:** add an `xvfb-run` job for `pnpm run test:unit` first, which needs only
the editor. Leave E2E manual until its fixtures have a story that does not involve a
fresh `pnpm install` of three Angular projects per run.
