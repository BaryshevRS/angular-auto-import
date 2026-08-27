import { existsSync, readdirSync } from 'node:fs';
import { defineConfig } from '@vscode/test-cli';
import { stageFixturePackages } from './scripts/stage-e2e-fixtures.mjs';

const projectsDir = './src/e2e/projects';

const labelArgument = process.argv.findIndex(argument => argument === '--label');
const selectedLabel = labelArgument >= 0
  ? process.argv[labelArgument + 1]
  : process.argv.find(argument => argument.startsWith('--label='))?.slice('--label='.length);

// A command with no label may run the whole matrix. Explicit non-Nx shards must not
// race while replacing a fixture they never read. Under the parallel runner the staging
// already happened once, before any shard started, so nothing is replaced here.
if (process.env.AAI_VSCODE_DATA_DIR === undefined) {
  stageFixturePackages(selectedLabel?.split(':').pop());
}

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

/**
 * Discover the test projects that are ready to run.
 *
 * Normally that means installed: a fixture without its dependencies is not a project
 * the extension would index, and running it would fail for a reason that has nothing
 * to do with the change under test. A project may also declare that it needs no
 * install — what `v22-nx` tests is where manifests sit and what a tsconfig maps in,
 * both read from source — and it says so with a `.e2e-no-install` file.
 */
const versions = readdirSync(projectsDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name.startsWith('v'))
  .filter(d =>
    existsSync(`${projectsDir}/${d.name}/node_modules`) ||
    existsSync(`${projectsDir}/${d.name}/.e2e-no-install`)
  )
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
      launchArgs: isolationArgs,
      mocha: {
        ui: 'bdd',
        timeout: 20000,
        color: true,
        reporter: 'spec',
      },
    },
    {
      label: 'lsp-lifecycle',
      files: 'out/test/lsp/**/*.test.js',
      workspaceFolder: './src/test/fixtures/simple-project',
      env: {
        // Killing the server on purpose is a test's business; the command that does it
        // exists only when this says so.
        AAI_ENABLE_CRASH_COMMAND: '1',
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
    // What the extension costs the Extension Host, measured on a real fixture.
    {
      label: 'host-cost',
      files: 'out/test/host-cost/**/*.test.js',
      workspaceFolder: `${projectsDir}/v22`,
      launchArgs: isolationArgs,
      env: process.env.AAI_HOST_COST_OUTPUT ? { AAI_HOST_COST_OUTPUT: process.env.AAI_HOST_COST_OUTPUT } : {},
      mocha: {
        ui: 'bdd',
        timeout: 240000,
        color: true,
        reporter: 'spec',
      },
    },
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
