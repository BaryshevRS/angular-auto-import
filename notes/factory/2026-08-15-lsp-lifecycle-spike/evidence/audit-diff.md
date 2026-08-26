# Diff audit

Date: 2026-08-15
Method: local fresh-pass review; separate-agent delegation is unavailable for this task.

## Scope reviewed

- development-only activation gate;
- LanguageClient lifecycle and IPC server options;
- server initialization, document sync, runtime dependency load, completion, and shutdown;
- two-entry esbuild configuration;
- dependency and test-runner changes;
- extension-host test isolation and VSIX contents.

## Findings and actions

1. **Fixed:** `test:lsp-spike` originally compiled tests before `package`, while `package` runs a source-mutating formatter. Reordered it to package first and compile tests second so the executed test output always matches formatted source.
2. **Fixed:** the first VSIX included `PLAN.md`. Added it to `.vscodeignore`; the final archive contains only the expected 12 files and both runtime bundles.
3. **Fixed:** upgrading both VS Code test packages pulled Mocha 11 into the CLI and broke one existing Mocha 10 import. Kept `@vscode/test-cli` at 0.0.10 and upgraded only `@vscode/test-electron` to 3.1.0, which solves the macOS executable issue without migrating the test framework.
4. **Verified:** the environment gate returns before configuration, project discovery, commands, and direct provider registration, so direct and LSP providers cannot coexist in spike mode.
5. **Verified:** the integration test activates the packaged extension, crosses the real LanguageClient/IPC server boundary, proves `@angular/compiler` and `ts-morph` loaded, then stops the client and proves the completion provider was unregistered.
6. **Accepted for spike:** the server contains a marker-only completion and eagerly verifies runtime dependencies. Both are isolated behind `AAI_LSP_SPIKE=1` and must be replaced rather than generalized in Phase 1.
7. **Fixed:** the first protocol test covered only HTML even though the slice contract named HTML and TypeScript synchronization. Added a TypeScript fixture and asserted the same completion over both synchronized document types.
8. **Fixed:** an induced server-process exit now proves the client's automatic restart and re-synchronization of already-open HTML and TypeScript documents without sleep-based assertions.
9. **Accepted residual:** SSH/WSL execution and representative performance/RSS measurements are still open in `PLAN.md`; neither changes the current production path.

## Verdict

No blocking correctness or scope issue remains for the bounded lifecycle spike. The diff is ready for human review; it must not be interpreted as completion of the full LSP migration.
