# CLAUDE.md

### Key Build Scripts
- `compile`: Type check + lint + esbuild (development)
- `package`: Type check + lint + esbuild (production, minified)
- `watch`: Parallel watch for both esbuild and TypeScript

### Testing Framework

- Uses VS Code Extension Test Runner (`@vscode/test-cli`)
- Test fixtures in `src/test/fixtures/` for different project scenarios
- Mocha-based test suites in `src/test/suite/`
- E2E projects live in `src/e2e/projects/` (`v19`, `v21`, `v22` — one per supported Angular version)
- The final e2e run before shipping is the v22 project in parallel mode: `pnpm run test:e2e:v22:parallel`
