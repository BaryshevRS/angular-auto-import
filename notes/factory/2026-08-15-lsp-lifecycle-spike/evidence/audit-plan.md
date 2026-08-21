# Plan audit

Date: 2026-08-15
Method: local fresh-pass review; separate-agent delegation is unavailable for this task.

## Findings

1. The full migration is XL and must not be implemented as one change. The lifecycle spike is a valid bounded first slice because it does not move production provider behavior.
2. Direct and LSP providers must never be active together. Use a test-only environment flag checked before project discovery/provider registration, plus a dedicated VS Code test label that supplies the flag.
3. The lifecycle test must cross the real JSON-RPC boundary. A unit test of completion DTOs alone would not prove packaging, process startup, synchronization, or shutdown.
4. `compile-tests` does not produce the bundled server artifact used by `LanguageClient`. The spike verification order must build/package before launching its dedicated extension-host test.
5. The server bundle should exercise dynamic imports of both `@angular/compiler` and `ts-morph` during the spike test; otherwise Phase 0 would leave its main packaging uncertainty unresolved.
6. Client and server entry points need separate esbuild outputs. Shared build options are acceptable, but `vscode` must remain external only where imported and both artifacts must be inspected after production packaging.
7. Existing direct-mode unit tests are the regression guard. The LSP test belongs in a separate glob so its environment flag cannot change the regular unit suite.

## Plan corrections applied

- Use `.vscode-test.mjs` `env` support instead of a platform-specific shell environment assignment.
- Add a dedicated `lsp-spike` test label and script.
- Make runtime-dependency loading observable through the completion response used by the protocol test.
- Keep the direct path as the default and preserve all current activation tests.

## Verdict

Proceed with the bounded spike. Stop if the dedicated test cannot prove real process lifecycle without changing the production provider path.
