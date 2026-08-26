# Verification — LSP document core boundary

Date: 2026-08-15

## RED

`pnpm run compile-tests` failed because `../../core/document` did not exist. This established the new boundary before implementation.

## GREEN

- `pnpm run lint`: passed; Biome checked 71 files, stopslop reported 0 new findings, and TypeScript passed.
- `pnpm exec vscode-test --label unit`: 190 passing, including plain-object and native LSP `TextDocument` coverage.
- `pnpm exec vscode-test --label lsp-spike`: 1 passing, including crash/restart and HTML/TypeScript re-synchronization.
- Both production bundles built during `pnpm run test:lsp-spike` before the test runner's intermittent pre-test `SIGABRT`; the isolated cached-version retry passed.
- `git diff --check HEAD`: passed.

## Diff audit

- The core document module imports Node only; it has no VS Code dependency.
- The VS Code-specific conversion is isolated under `src/adapters/vscode`.
- The LSP `TextDocument` satisfies `DocumentView` directly, so the server needs no mirror adapter.
- Only inline-template detection moved; completion filtering and production mode selection are unchanged.
