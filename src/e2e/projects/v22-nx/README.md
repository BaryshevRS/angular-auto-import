# v22-nx — the layout issue #35 reports

Every other fixture project is one package: a `package.json` at the workspace root
declaring `@angular/core`, with `libs/` inside it. That shape can never reproduce #35,
because the project root is the workspace root and the libraries are already under it.
The alias only ever decided how the import was *written*.

Here the manifests are split the way Nx and pnpm workspaces actually split them:

- the workspace `package.json` carries build tooling and **no** `@angular/core`;
- `apps/shop/package.json` declares it, so **the application is the project root**;
- `libs/*` sit **outside** that root, and most have no manifest at all.

A library is then reachable only through `compilerOptions.paths`. `tsconfig.base.json`
deliberately declares no `baseUrl`, so those entries resolve against the config that
declared them rather than the one reading them — the rule that has to hold for any of
this to find anything.

`libs/data-access` has a manifest of its own declaring `@angular/core`, which makes it
look like a nested package to the boundary rule. The alias outranks that: the tsconfig
says it compiles as part of the application.

The same application also declares `@fixture/hoisted-ui`, but deliberately has no local
`apps/shop/node_modules`. Before the test starts, `.vscode-test.mjs` copies the committed
fixture from `.e2e-fixtures/hoisted-ui` to the workspace-level
`node_modules/@fixture/hoisted-ui`. That reproduces a hoisted dependency without a full
package-manager install and proves that package lookup walks above the application root.

The Angular compiler still comes from the extension, and all other fixtures are read as
sources. `.e2e-no-install` is what tells `.vscode-test.mjs` the workspace is runnable
without installing it.
