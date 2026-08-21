# Baseline

Captured: 2026-08-15 before the LSP spike implementation.

## Deterministic environment facts

- Git branch before work: `main`; implementation branch: `feat/lsp-lifecycle-spike`.
- Node: `v25.9.0`.
- pnpm: `10.32.0`.
- Existing development bundle `dist/extension.js`: 6,839,141 bytes.
- Existing source map `dist/extension.js.map`: 6,868,678 bytes.
- Installed `node_modules`: approximately 452 MiB.

## Behavioral/performance baseline

The repository already records per-operation and memory metrics through its logger, but Phase 0 has no checked-in deterministic benchmark runner for activation/index/completion p95. Do not invent timing assertions from a single noisy extension-host run. The spike will record build artifact sizes and lifecycle correctness; representative latency/RSS measurements remain a required manual benchmark before the LSP path becomes the default.
