# CLAUDE.md

### Architecture

- `ARCHITECTURE.md` describes the layers, the client/server boundary, and where
  caches, logs, and settings live at runtime. Read it before changing anything under
  `src/core` or `src/lsp`.
- `src/core`, `src/lsp` (except its `client*.ts` modules), and the `node`/`lsp` adapters
  must not import `vscode`. A lint rule in `biome.json` enforces it, and
  `pnpm run vsce:inspect` checks the packaged artifact.

### The Angular compiler decides, not a heuristic

- **Anything about Angular syntax is the compiler's answer, not ours.** What a template
  node is, what an expression means, where a construct sits in the source — ask
  `@angular/compiler`. It is already a dependency and it is already parsing the file.
- **Heuristics over template or expression text are not allowed.** No regular
  expressions over an expression, no counting brackets, no classifying by the previous
  character. If a problem looks like it needs one, stop and raise it — a heuristic goes
  in only after an explicit decision, and with the reason written down beside it.
  The reason for the rule: a bar in a template is a pipe operator only outside string,
  template and regular-expression literals, only when it is not `||`, and again inside
  the `${…}` holes of a template literal — and getting that from the text means
  reimplementing the expression grammar, one reported bug at a time.
- **Parse through `PARSE_OPTIONS` in `core/angular-compiler`**, never with options
  written out again. `preserveWhitespaces: true` is what makes the compiler's spans
  offsets into the file as written; without it whitespace is normalized before
  expressions are parsed and every position it reports is wrong by however much was
  removed ahead of it.

### Key Build Scripts
- `compile`: Type check + lint + esbuild (development)
- `package`: Type check + lint + esbuild (production, minified)
- `watch`: Parallel watch for both esbuild and TypeScript
- `vsce:package` then `vsce:inspect`: build the VSIX and verify it carries both bundles
  and their runtime dependencies
- `benchmark`: index time, request latency, and server memory (run the underlying script
  with `node --expose-gc` to include the retention check)
- `host-cost`: what each implementation costs the Extension Host, measured inside the
  editor and compared

### Testing Framework

- Uses VS Code Extension Test Runner (`@vscode/test-cli`)
- Test fixtures in `src/test/fixtures/` for different project scenarios
- Mocha-based test suites in `src/test/suite/` need the VS Code host; suites in `src/test/node/` must not import `vscode` and run under plain Mocha
- `pnpm run test:unit` runs both; `pnpm run test:node` runs only the fast Node ones
- `src/test/node/harness/lsp-harness.ts` runs the real server over an in-memory
  transport; the protocol, parity, and regression suites drive it
- `src/test/node/lsp-parity.test.ts` replays the recorded E2E descriptors against the
  server, and reads its fixtures from `src/e2e/projects/v22` in the source tree
- E2E projects live in `src/e2e/projects/` (`v19`, `v21`, `v22` — one per supported Angular version)
- The final e2e run before shipping is the v22 project in parallel mode: `pnpm run test:e2e:v22:parallel`
