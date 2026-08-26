/**
 * Packages that are committed as sources and materialized into an e2e project's
 * `node_modules` before VS Code starts.
 *
 * They live outside the ignored `node_modules` tree so they are committed, and are copied
 * in with the exact layout the extension must resolve — which is the point of each of
 * them, and not something a package manager would reproduce from a manifest.
 * @module
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const PROJECTS_DIR = "./src/e2e/projects";

/** Every staged package: where it is kept, and where it has to appear. */
const FIXTURE_PACKAGES = [
  {
    version: "v22-nx",
    // Ancestor `node_modules` lookup: the package sits above the app that uses it.
    source: `${PROJECTS_DIR}/v22-nx/.e2e-fixtures/hoisted-ui`,
    destination: `${PROJECTS_DIR}/v22-nx/node_modules/@fixture/hoisted-ui`,
  },
  {
    version: "v22",
    // One NgModule class reachable from three entry points, the way a design-system
    // package is built: the index must read those as one module, not three.
    source: `${PROJECTS_DIR}/v22/.e2e-fixtures/uikit`,
    destination: `${PROJECTS_DIR}/v22/node_modules/@fixture/uikit`,
  },
];

/**
 * Copies the packages one version's suite needs.
 *
 * Not safe to run while that version's tests are running: a shard reading a package
 * being replaced would see it half-copied. Callers stage before anything starts.
 * @param version The fixture project, or `undefined` to stage every one of them.
 */
export function stageFixturePackages(version) {
  for (const fixture of FIXTURE_PACKAGES) {
    if (version !== undefined && fixture.version !== version) {
      continue;
    }
    if (!existsSync(fixture.source)) {
      continue;
    }

    rmSync(fixture.destination, { recursive: true, force: true });
    mkdirSync(dirname(fixture.destination), { recursive: true });
    cpSync(fixture.source, fixture.destination, { recursive: true });
  }
}
