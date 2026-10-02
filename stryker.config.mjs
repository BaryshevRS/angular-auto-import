// @ts-check
/**
 * Mutation testing over the Node suites.
 *
 * Mocha runs the TypeScript sources through tsx instead of the `tsc → out/` build the
 * other scripts use: Stryker mutates `src`, and a mutant has to reach the tests without
 * a compile step per mutant.
 *
 * Only what the Node suites can load is mutated. The modules that import `vscode` are
 * covered by the Extension Host suites, which Stryker cannot drive; mutating them would
 * report every mutant as uncovered and say nothing about the tests.
 *
 * The sandbox leaves out every `node_modules`, the E2E projects' included, so the
 * suites that sweep an installed project see none and skip it. That keeps a run from
 * copying gigabytes per worker; the parity and fixture sweeps stay the job of
 * `test:node` and `test:fixtures`.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  packageManager: "pnpm",
  // Named, not discovered: under pnpm the core cannot see its sibling packages.
  plugins: ["@stryker-mutator/mocha-runner"],
  testRunner: "mocha",
  mochaOptions: {
    spec: ["src/test/node/**/*.test.ts"],
    require: ["tsx/cjs"],
    // Only for the timeout the harness suites need, which the runner has no option for.
    config: ".mocharc.stryker.json",
    "no-package": true,
  },
  coverageAnalysis: "perTest",
  // tsx strips types without checking them, so there is nothing to disable; and the
  // `// @ts-nocheck` line it would prepend to every .ts file, fixtures included, moves
  // each position the fixture suites assert on down by one line.
  disableTypeChecks: false,
  mutate: [
    "src/**/*.ts",
    "!src/test/**",
    "!src/e2e/**",
    "!src/**/*.d.ts",
    // These import `vscode`; see above.
    "!src/extension.ts",
    "!src/legacy-cache.ts",
    "!src/commands/webviews.ts",
    "!src/config/settings.ts",
    "!src/logger/channel-transport.ts",
    "!src/logger/config.ts",
    "!src/logger/logger.ts",
    "!src/lsp/client*.ts",
  ],
  ignorePatterns: ["dist", "out", "coverage", "docs", "packages", "reports", ".vscode-test"],
  incremental: true,
  incrementalFile: "reports/stryker-incremental.json",
  reporters: ["html", "clear-text", "progress"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  timeoutMS: 20000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
};
