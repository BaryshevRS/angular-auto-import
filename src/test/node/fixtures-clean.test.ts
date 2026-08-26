/**
 * Every warning a fixture project shows is one its corpus asked for.
 *
 * The E2E projects are also read by hand: they are opened in the editor while working on
 * the extension, and a warning nobody put there on purpose is either a false positive or
 * a fixture that quietly stopped compiling — both of which used to be found by noticing
 * a squiggle rather than by a test. This asks the server for the whole project the way
 * the `Generate diagnostics report` command does, and holds the answer against the
 * descriptors.
 *
 * A file is allowed to report only when a case says so with `preserveImports: true`,
 * which is how a descriptor states that the fixture is meant to be missing an import as
 * it is written on disk. Every other case strips imports when it runs, so its fixture
 * must be clean at rest.
 *
 * It is slow — a minute or two per version, since each one indexes its whole
 * `node_modules` — so it runs only when asked: `pnpm run test:fixtures`.
 * @module
 */

import * as assert from "node:assert";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { DiagnosticsReportRequest, PerformanceMetricsRequest } from "../../lsp/protocol";
import { type Harness, startHarness } from "./harness/lsp-harness";

/** The repository root, found by walking up from the compiled test. */
const REPOSITORY_ROOT = findRepositoryRoot(__dirname);
const PROJECTS_ROOT = path.join(REPOSITORY_ROOT, "src", "e2e", "projects");
const CASES_ROOT = path.join(REPOSITORY_ROOT, "src", "e2e", "cases");

/** @internal */
function findRepositoryRoot(from: string): string {
  let directory = from;
  while (!existsSync(path.join(directory, "package.json"))) {
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`No package.json above ${from}`);
    }
    directory = parent;
  }
  return directory;
}

/** The versions to sweep: those whose dependencies are installed. */
function installedVersions(): string[] {
  if (!existsSync(PROJECTS_ROOT)) {
    return [];
  }
  return require("node:fs")
    .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((entry: { isDirectory(): boolean; name: string }) => entry.isDirectory())
    .map((entry: { name: string }) => entry.name)
    .filter((version: string) => existsSync(path.join(PROJECTS_ROOT, version, "node_modules")))
    .sort();
}

/** What one version's corpus records as intentional, by template path. */
async function recordedByFile(version: string): Promise<Map<string, string[]>> {
  const casesRoot = path.join(CASES_ROOT, version);
  const recorded = new Map<string, string[]>();
  if (!existsSync(casesRoot)) {
    return recorded;
  }

  for (const entry of await fs.readdir(casesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const descriptorPath = path.join(casesRoot, entry.name, "descriptor.json");
    if (!existsSync(descriptorPath)) {
      continue;
    }

    const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
    // Only a case that keeps its imports is describing the file at rest. Every other one
    // strips them first, so what it records says nothing about what the file shows.
    if (descriptor.preserveImports !== true) {
      continue;
    }

    const codes = (descriptor.diagnostics ?? []).map((diagnostic: { code: string }) => diagnostic.code);
    recorded.set(normalize(descriptor.templatePath), codes);
  }

  return recorded;
}

/** One spelling of a project-relative path. */
function normalize(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/**
 * Opens one of the project's own files, so the server has a reason to look for a project
 * at all.
 *
 * Discovery is per document: a workspace whose root is not itself an Angular project —
 * `v22-nx`, where the application sits in `apps/shop` — has nothing indexed until
 * something inside it is opened.
 * @internal
 */
async function openSomethingInside(harness: Harness, projectRoot: string): Promise<void> {
  const opened = await firstSourceFile(projectRoot);
  if (!opened) {
    throw new Error(`No component file to open under ${projectRoot}`);
  }
  await harness.open(opened, await fs.readFile(opened, "utf8"), "typescript");
}

/** The first component file under a project, ignoring its dependencies. @internal */
async function firstSourceFile(directory: string): Promise<string | undefined> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) {
      continue;
    }

    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await firstSourceFile(candidate);
      if (found) {
        return found;
      }
    } else if (entry.name.endsWith(".component.ts")) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Waits until the server has something to answer with.
 *
 * Without this the sweep is settled by silence: a server that has not finished indexing
 * reports no problems, which reads exactly like a project that has none.
 */
async function waitUntilIndexed(harness: Harness, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const metrics = await harness.client.sendRequest(PerformanceMetricsRequest);
    const indexed = metrics.projects.reduce((total, project) => total + project.elementCount, 0);
    if (metrics.analysisReady && indexed > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`The server indexed nothing in ${deadlineMs}ms: ${JSON.stringify(metrics.projects)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

const versions = installedVersions();
const asked = process.env.AAI_FIXTURE_SWEEP === "1";

(asked && versions.length > 0 ? describe : describe.skip)("Fixture projects at rest", function () {
  this.timeout(600000);

  for (const version of versions) {
    it(`${version} shows only the warnings its corpus records`, async () => {
      const projectRoot = path.join(PROJECTS_ROOT, version);
      const recorded = await recordedByFile(version);

      let harness: Harness | undefined;
      try {
        harness = await startHarness({ workspaceRoots: [projectRoot] });
        await openSomethingInside(harness, projectRoot);
        await waitUntilIndexed(harness, 300000);

        const report = await harness.client.sendRequest(DiagnosticsReportRequest, {});
        const unexpected: string[] = [];

        for (const file of report.files) {
          const relative = normalize(path.relative(projectRoot, file.filePath));
          const allowed = recorded.get(relative);
          const codes = file.diagnostics.map((diagnostic) => diagnostic.code);

          if (!allowed) {
            unexpected.push(`${relative}\n    ${[...new Set(codes)].join("\n    ")}`);
            continue;
          }

          const surprising = [...new Set(codes.filter((code) => !allowed.includes(code)))];
          if (surprising.length > 0) {
            unexpected.push(`${relative}, beyond what its case records\n    ${surprising.join("\n    ")}`);
          }
        }

        assert.deepStrictEqual(
          unexpected,
          [],
          `Warnings nobody asked for in ${version}. Either the fixture stopped compiling, or the extension is ` +
            `reporting something it should not:\n  ${unexpected.join("\n  ")}`
        );
      } finally {
        await harness?.dispose();
      }
    });
  }
});
