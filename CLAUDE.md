# CLAUDE.md

### Architecture

- `ARCHITECTURE.md` describes the layers, the client/server boundary, and where
  caches, logs, and settings live at runtime. Read it before changing anything under
  `src/core` or `src/lsp`.
- `src/core`, `src/lsp` (except its `client*.ts` modules), and the `node`/`lsp` adapters
  must not import `vscode`. A lint rule in `biome.json` enforces it, and
  `pnpm run vsce:inspect` checks the packaged artifact.

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
