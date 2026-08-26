# E2E Snapshot-Based Regression Tests

End-to-end tests that verify diagnostics (missing Angular imports) and quickfixes (auto-import suggestions) work correctly inside a real VS Code Extension Dev Host against multiple Angular version test projects and a dedicated Nx monorepo layout fixture.

## How It Works

1. **Generator** strips `imports: [...]` from a component, opens the template in VS Code, collects all diagnostics and quickfixes produced by the extension, and saves them as a `descriptor.json` snapshot.
2. **Regression runner** repeats the same strip-and-open flow, then asserts that every diagnostic and quickfix matches the snapshot exactly — code, severity, line/character positions, quickfix titles and commands.
3. **Quickfix execution** applies each quickfix via `vscode.commands.executeCommand`, then reads the component file and verifies that both the TypeScript `import` statement and `@Component({ imports: [...] })` entry were added correctly.

```
src/e2e/
  helpers/
    diagnostics-helper.ts   # waitForDiagnosticsToStabilize, collectQuickFixes
    file-helper.ts          # stripAngularImports, replaceFileContent, waitForExtensionActivation
  suite/
    diagnostics-regression.test.ts   # Universal regression runner
  generator/
    generate-descriptor.test.ts      # Descriptor generator
  cases/
    control-flow/
      descriptor.json                # Generated snapshot (committed to git)
```

## Multi-Version Test Projects

Tests run against Nx workspaces in `src/e2e/projects/v{18,19,20,21,22}`. Each workspace contains Angular demo apps with different UI library combinations:

| Version | Angular | Nx     | Apps                                                              |
|---------|---------|--------|-------------------------------------------------------------------|
| v18     | ~18.2   | 20.3.0 | angular-demo, angular-material, ng-zorro, primeng                 |
| v19     | ~19.2   | 21.1.3 | angular-demo, angular-material, ng-zorro, primeng, taiga (v4)     |
| v20     | ~20.0   | 21.1.3 | angular-demo, angular-material, ng-zorro, primeng                 |
| v21     | ~21.0   | 22.6.0 | angular-demo, angular-material, ng-zorro, primeng, taiga (v5-rc)  |
| v22     | ~22.0   | 22.0.3 | angular-demo, angular-material, ng-zorro, primeng                 |

- **v19** is the reference project used by the generator.
- **v18 and v20** are gitignored and generated on demand. The currently committed
  version fixtures are v19, v21, and v22.
- Test cases that reference apps missing in a given version are automatically skipped.

### The layout project: `v22-nx`

`v22-nx` is not another Angular version. It exists because of a shape none of the
version projects can have, and it is the regression net for
[issue #35](https://github.com/BaryshevRS/angular-auto-import/issues/35).

#### What it is

Every version project above has **one manifest**, at the workspace root, with `libs/`
inside it. So the project root *is* the workspace root, the libraries are already under
it, and the plain scan finds them. A path alias there only ever decides how the import
gets *written*.

`v22-nx` splits the manifests the way Nx and pnpm workspaces actually split them:

| | version projects | `v22-nx` |
|---|---|---|
| `@angular/core` declared in | workspace root | `apps/shop/package.json` |
| project root discovery finds | the workspace | the application |
| workspace root is itself a project | yes | **no** — tooling only |
| `libs/` relative to that root | inside | **outside** |
| reachable by | the plain scan | `compilerOptions.paths` only |
| `baseUrl` | set | **absent** |

#### What it closes

| Case | Fixture | Records |
|---|---|---|
| Library with no manifest of its own | `libs/ui-kit` | `@shop/ui-kit` |
| Library that is a package of its own | `libs/data-access` | `@shop/data-access` |
| Alias whose `*` sits mid-path | `libs/wild/beacon` | a **relative** path |
| Declared dependency hoisted above the app | `node_modules/@fixture/hoisted-ui` | `@fixture/hoisted-ui` |

The four are separate decisions, not four shots at the same one:

- **No manifest.** The library is not a package at all, just a directory the
  application's tsconfig maps in. Nothing but a `paths` entry can reach it.
- **Its own manifest, declaring `@angular/core`.** The boundary rule — which stops a
  project swallowing a package nested inside it — would call this someone else's code.
  The alias outranks it: the tsconfig says outright that this compiles as part of the
  application. Without a fixture, that decision is a comment nobody checks.
- **Mid-path `*`.** Such an entry maps a name *into* the path rather than appending to
  it, so no specifier can be rebuilt from a file under it. The alias is deliberately
  skipped and the import falls back to a relative path. What must never happen is an
  absolute path, which is not an import any TypeScript file can carry — and that is
  exactly what used to come out.
- **Hoisted dependency.** `apps/shop/package.json` declares `@fixture/hoisted-ui`, but
  `apps/shop/node_modules` does not exist. The package is materialized only in the
  workspace ancestor's `node_modules`, so dependency discovery must walk upward from
  the application root. The snapshot asserts the resulting diagnostic, the quick-fix
  module specifier, and the import actually applied to the component.

The absent `baseUrl` is load-bearing rather than incidental. TypeScript resolves `paths`
against the config file that **declared** them, which through `extends` is the base
config several directories above the one being read — not against the reading config's
own directory. Get that wrong and every alias points at a directory that does not
exist, silently. `v22-nx` is the only project where that rule is exercised.

#### Why it is not a fourth app inside `v22`

Two of the reasons are hard blockers, not preferences:

1. **The root manifest is mutually exclusive.** The core of #35 is that the workspace
   root is *not* an Angular project, so there is nothing to fall back to. `v22`'s root
   declares `@angular/core` and must — its three apps depend on it. A nested app inside
   `v22` would reproduce "the app is the root, libs are outside" and miss "there is
   nothing above it", which is the half that makes `projectPath`, trusted roots, and
   the status bar's message necessary in the first place.
2. **`baseUrl` cannot be removed from `v22`.** All of its `paths` substitutions are
   non-relative, and `get-tsconfig` rejects the whole config without a `baseUrl`
   (`Non-relative paths are not allowed when 'baseUrl' is not set`). Dropping it would
   kill every existing alias case at once; keeping it means the rule above is never
   tested.

And one matter of cost: `scripts/e2e-parallel.mjs` shards by app, so a fourth app is a
fourth VS Code instance on a run that already takes four minutes — for a scenario that
needs no full workspace install.

#### Running it

It needs no package-manager install: the Angular compiler comes from the extension and
most fixtures are read as sources. `.e2e-no-install` tells `.vscode-test.mjs` to run it
as-is. For the hoisting regression, `.vscode-test.mjs` copies the committed tiny package
from `.e2e-fixtures/hoisted-ui` into the workspace-level
`node_modules/@fixture/hoisted-ui` before VS Code starts. Nothing is copied into
`apps/shop/node_modules`; that absence is the condition under test. One app means there
is nothing to shard, and the suite finishes in seconds:

```bash
pnpm run test:e2e:v22-nx
```

To run only the hoisted-dependency regression or regenerate only its descriptor:

```bash
AAI_E2E_CASE=nx-hoisted-package pnpm run test:e2e:v22-nx
AAI_E2E_CASE=nx-hoisted-package pnpm run test:generate:v22-nx
```

It is not part of the default `e2e` label, which points at `v19`. The same scenario is
also covered without an editor in `src/test/node/lsp-monorepo.test.ts`, while the
ancestor resolver itself has a focused test in `src/test/suite/package-json.test.ts`.

### Generating Test Projects

```bash
# Generate all missing versions (skips existing ones)
pnpm run generate:test-projects

# Generate a specific version
pnpm run generate:test-projects -- --version v21
```

The generator (`scripts/generate-test-projects.ts`):
1. Creates an Nx workspace with `create-nx-workspace`
2. Generates additional apps (`@nx/angular:app`)
3. Installs UI library dependencies
4. Copies `libs/` and `apps/*/src/` from v19
5. Merges `tsconfig.base.json` paths from v19

## Commands

```bash
# Run e2e regression tests against v19 (default)
pnpm run test:e2e

# Run e2e against a specific Angular version
pnpm run test:e2e:v18
pnpm run test:e2e:v19
pnpm run test:e2e:v20
pnpm run test:e2e:v21
pnpm run test:e2e:v22
pnpm run test:e2e:v22-nx

# Regenerate descriptor snapshots (run after template or extension logic changes)
pnpm run test:generate

# Regenerate for a specific version
pnpm run test:generate:v19
pnpm run test:generate:v21
pnpm run test:generate:v22
pnpm run test:generate:v22-nx

# Run only unit tests
pnpm run test:unit

# Run all tests (unit + e2e + generate)
pnpm run test
```

## Running Individual Cases

For targeted runs, do not use `pnpm run test:e2e -- --grep ...` or `pnpm run test:generate -- --grep ...`.
Those scripts also rebuild `out/` and copy fixtures, so the extra `--grep` is passed to the wrong command in the chain.

Use this flow instead:

```bash
# 1. Rebuild compiled tests
pnpm run compile-tests

# 2. Copy committed descriptor snapshots into out/
pnpm run copy-e2e-cases

# 3a. Run one regression case
pnpm exec vscode-test --label e2e --grep "Case: taiga"

# 3b. Run one generator case
pnpm exec vscode-test --label generate --grep "generate taiga"
```

Alternatively, `AAI_E2E_CASE` filters both the generator and regression runner without
depending on Mocha title matching. This is the preferred form for the Nx layout cases:

```bash
AAI_E2E_CASE=nx-hoisted-package pnpm run test:e2e:v22-nx
AAI_E2E_CASE=nx-hoisted-package pnpm run test:generate:v22-nx
```

Examples:

```bash
# One standalone regression case
pnpm exec vscode-test --label e2e --grep "Case: material-table"

# One legacy-modules regression case
pnpm exec vscode-test --label e2e --grep "Case: material-overview-legacy-modules"

# Regenerate exactly one descriptor snapshot
pnpm exec vscode-test --label generate --grep "generate material-table"
```

Notes:

- `e2e` matches the `describe("Case: ...")` title from `src/e2e/suite/diagnostics-regression.test.ts`
- `generate` matches the `it("generate ...")` title from `src/e2e/generator/generate-descriptor.test.ts`
- If you changed `src/e2e/cases/**/descriptor.json`, rerun `pnpm run copy-e2e-cases` before a targeted `e2e` run
- If VS Code says `Running extension tests from the command line is currently only supported if no other instance of Code is running`, close leftover `.vscode-test` instances and rerun

## Adding a New Test Case

### 1. Register the case in the generator

Open `src/e2e/generator/generate-descriptor.test.ts` and add an entry to the `CASES` array:

```typescript
const CASES: CaseConfig[] = [
  {
    name: "control-flow",
    componentPath: "apps/angular-demo/src/app/control-flow/control-flow.component.ts",
    templatePath: "apps/angular-demo/src/app/control-flow/control-flow.component.html",
  },
  // Add your new case here:
  {
    name: "standard",
    componentPath: "apps/angular-demo/src/app/standard/standard.component.ts",
    templatePath: "apps/angular-demo/src/app/standard/standard.component.html",
  },
];
```

### 2. Create the cases directory

```bash
mkdir -p src/e2e/cases/standard
```

### 3. Generate the descriptor

```bash
pnpm run test:generate
```

This will create `src/e2e/cases/standard/descriptor.json` with all diagnostics and quickfixes captured from the live extension.

### 4. Review and commit the descriptor

Inspect the generated JSON — it contains every diagnostic with exact positions and every quickfix with its title. Commit it to git.

### 5. Run the regression

```bash
pnpm run test:e2e
```

The runner auto-discovers all `cases/*/descriptor.json` files — no additional registration needed.

## Descriptor Format

```jsonc
{
  "case": "control-flow",
  "componentPath": "apps/angular-demo/src/app/control-flow/control-flow.component.ts",
  "templatePath": "apps/angular-demo/src/app/control-flow/control-flow.component.html",
  "diagnostics": [
    {
      "code": "missing-component-import:lib-ui-demo-one",
      "severity": "Warning",
      "source": "angular-auto-import",
      "startLine": 5,        // 0-based line number
      "startCharacter": 8,   // 0-based column
      "endLine": 5,
      "endCharacter": 25
    }
  ],
  "quickfixes": [
    {
      "diagnosticCode": "missing-component-import:lib-ui-demo-one",
      "title": "Import UiDemoOneComponent from '@angular-demo/ui-demo-one'",
      "command": "angular-auto-import.importElement",
      "expectedImport": {
        "className": "UiDemoOneComponent",
        "moduleSpecifier": "@angular-demo/ui-demo-one"
      }
    }
  ]
}
```

Each diagnostic is validated by its exact position in the template file (`startLine:startCharacter` to `endLine:endCharacter`), not just by count.

## When to Regenerate Descriptors

Run `pnpm run test:generate` after:

- Changing a template file used by a test case
- Changing diagnostic range calculation logic in the extension
- Adding/removing elements from a component's `imports` array
- Changing how the extension produces diagnostic codes or quickfix titles

## How `stripAngularImports` Works

The function parses the component source to:

1. Extract class names from the `imports: [Foo, Bar, ...]` array in `@Component`
2. Remove those names from TypeScript `import { ... } from '...'` statements (deletes the entire statement if it becomes empty)
3. Set `imports: []`
4. Keep non-template imports (`Component`, `inject`, `FormBuilder`, `Validators`, etc.)

No stripped files are committed — stripping happens on the fly during test execution, and the original file is always restored in the `after()` hook.

## Configuration

Test labels are defined in `.vscode-test.mjs` and generated dynamically by scanning `src/e2e/projects/v*` directories:

| Label            | Files                                 | Workspace                            | Timeout |
|------------------|---------------------------------------|--------------------------------------|---------|
| `unit`           | `out/test/suite/**/*.test.js`         | `./src/test/fixtures/simple-project` | 20s     |
| `e2e`            | `out/e2e/suite/**/*.test.js`     | `./src/e2e/projects/v19`            | 120s    |
| `e2e:v18`        | `out/e2e/suite/**/*.test.js`     | `./src/e2e/projects/v18`            | 120s    |
| `e2e:v19`        | `out/e2e/suite/**/*.test.js`     | `./src/e2e/projects/v19`            | 120s    |
| `e2e:v20`        | `out/e2e/suite/**/*.test.js`     | `./src/e2e/projects/v20`            | 120s    |
| `e2e:v21`        | `out/e2e/suite/**/*.test.js`     | `./src/e2e/projects/v21`            | 120s    |
| `e2e:v22`        | `out/e2e/suite/**/*.test.js`     | `./src/e2e/projects/v22`            | 120s    |
| `e2e:v22-nx`     | `out/e2e/suite/**/*.test.js`     | `./src/e2e/projects/v22-nx`         | 120s    |
| `generate`       | `out/e2e/generator/**/*.test.js` | `./src/e2e/projects/v19`            | 120s    |
| `generate:v18`   | `out/e2e/generator/**/*.test.js` | `./src/e2e/projects/v18`            | 120s    |
| `generate:v19`   | `out/e2e/generator/**/*.test.js` | `./src/e2e/projects/v19`            | 120s    |
| `generate:v20`   | `out/e2e/generator/**/*.test.js` | `./src/e2e/projects/v20`            | 120s    |
| `generate:v21`   | `out/e2e/generator/**/*.test.js` | `./src/e2e/projects/v21`            | 120s    |
| `generate:v22`   | `out/e2e/generator/**/*.test.js` | `./src/e2e/projects/v22`            | 120s    |
| `generate:v22-nx`| `out/e2e/generator/**/*.test.js` | `./src/e2e/projects/v22-nx`         | 120s    |

Labels `e2e` and `generate` (without version suffix) are legacy aliases pointing to v19.

Installed version projects appear as labels when they have `node_modules/`. A fixture
can opt in without a full install by committing `.e2e-no-install`; `v22-nx` does this.
Generate or install a version project first if its label is missing.

## The fixture sweep

`pnpm run test:fixtures` asks the server, for every installed fixture project, whether it
reports anything the corpus did not record. A file may report only when a case says so
with `preserveImports: true` — the flag that means "this fixture is missing an import as
it is written". Every other case strips imports when it runs, so its fixture has to be
clean at rest.

It is what keeps a warning that nobody put there on purpose from being noticed by eye,
and it is separate from `test:node` because it indexes each project's `node_modules`:
about forty seconds for all four versions against seventeen for the rest of the suite.

## Troubleshooting

**Tests time out waiting for diagnostics**
The extension needs time to activate and index the project. The default timeout is 120s. If your machine is slow, increase `timeoutMs` in `waitForDiagnosticsToStabilize()` and `waitForExtensionActivation()`.

**Descriptor is stale after template changes**
Regenerate it: `pnpm run test:generate`. The e2e runner compares exact positions, so any template edit will cause mismatches.

**`copy-e2e-cases` fails**
Ensure `src/e2e/cases/` exists. The `cp -r` command copies descriptor files to `out/e2e/` where the compiled tests expect them.

**Test version label not found (e.g. `e2e:v21`)**
The project hasn't been generated yet, or `node_modules/` is missing. Run:
```bash
pnpm run generate:test-projects -- --version v21
```

**`create-nx-workspace` fails with "paths are ignored by .gitignore"**
This is expected — generated projects are gitignored. The generator tolerates this error and continues. The workspace is still created successfully.

**Some test cases are skipped for a version**
This is by design. If an app (e.g. `taiga-demo`) doesn't exist in a given version, all its test cases are skipped automatically via `this.skip()` in the `before()` hook.
