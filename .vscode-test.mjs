import { existsSync, readdirSync } from 'node:fs';
import { defineConfig } from '@vscode/test-cli';

const projectsDir = './src/e2e/projects';

/**
 * Per-shard VS Code isolation. When running suites in parallel (see
 * scripts/e2e-parallel.mjs) each process must use its own user-data / extensions
 * directory, otherwise concurrent instances clash on the shared lock files.
 * Driven by AAI_VSCODE_DATA_DIR; empty for normal sequential runs so default
 * behavior is unchanged.
 */
// Short subdir names ('u'/'e') keep the VS Code IPC socket path under the 103-char
// Unix-socket limit, since macOS tmpdir() is already long.
const dataDir = process.env.AAI_VSCODE_DATA_DIR;
const isolationArgs = dataDir
  ? ['--user-data-dir', `${dataDir}/u`, '--extensions-dir', `${dataDir}/e`]
  : [];

/** Discover test project versions that have node_modules installed. */
const versions = readdirSync(projectsDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name.startsWith('v'))
  .filter(d => existsSync(`${projectsDir}/${d.name}/node_modules`))
  .map(d => d.name)
  .sort();

const e2eTests = versions.map(version => ({
  label: `e2e:${version}`,
  files: 'out/e2e/suite/**/*.test.js',
  workspaceFolder: `${projectsDir}/${version}`,
  launchArgs: isolationArgs,
  mocha: {
    ui: 'bdd',
    timeout: 120000,
    color: true,
    reporter: 'spec',
  },
}));

const generateTests = versions.map(version => ({
  label: `generate:${version}`,
  files: 'out/e2e/generator/**/*.test.js',
  workspaceFolder: `${projectsDir}/${version}`,
  mocha: {
    ui: 'bdd',
    timeout: 120000,
    color: true,
    reporter: 'spec',
  },
}));

export default defineConfig({
  tests: [
    {
      label: 'unit',
      files: 'out/test/suite/**/*.test.js',
      workspaceFolder: './src/test/fixtures/simple-project',
      mocha: {
        ui: 'bdd',
        timeout: 20000,
        color: true,
        reporter: 'spec',
      },
    },
    {
      label: 'lsp-spike',
      files: 'out/test/lsp/**/*.test.js',
      workspaceFolder: './src/test/fixtures/simple-project',
      env: {
        AAI_LSP_SPIKE: '1',
      },
      mocha: {
        ui: 'bdd',
        timeout: 20000,
        color: true,
        reporter: 'spec',
      },
    },
    ...e2eTests,
    ...generateTests,
    // The Extension Host cost of each implementation, measured on the same fixture and
    // the same scenario. scripts/host-cost.mjs runs both and compares them.
    ...['direct', 'lsp'].map(mode => ({
      label: `host-cost:${mode}`,
      files: 'out/test/host-cost/**/*.test.js',
      workspaceFolder: `${projectsDir}/v22`,
      launchArgs: isolationArgs,
      env: {
        ...(mode === 'lsp' ? { AAI_LSP_SPIKE: '1' } : {}),
        ...(process.env.AAI_HOST_COST_OUTPUT ? { AAI_HOST_COST_OUTPUT: process.env.AAI_HOST_COST_OUTPUT } : {}),
      },
      mocha: {
        ui: 'bdd',
        timeout: 240000,
        color: true,
        reporter: 'spec',
      },
    })),
    // Legacy aliases pointing to v19 (default version)
    {
      label: 'e2e',
      files: 'out/e2e/suite/**/*.test.js',
      workspaceFolder: `${projectsDir}/v19`,
      mocha: {
        ui: 'bdd',
        timeout: 120000,
        color: true,
        reporter: 'spec',
      },
    },
    {
      label: 'generate',
      files: 'out/e2e/generator/**/*.test.js',
      workspaceFolder: `${projectsDir}/v19`,
      mocha: {
        ui: 'bdd',
        timeout: 120000,
        color: true,
        reporter: 'spec',
      },
    },
  ],
  coverage: {
    reporter: ['text', 'html', 'lcov'],
    exclude: [
      'out/test/**',
      'out/e2e/**',
      'src/test/**',
      'src/e2e/**',
    ],
  },
});
