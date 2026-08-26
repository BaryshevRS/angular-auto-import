/**
 * What a project indexes when its tsconfig maps code from outside its own directory.
 *
 * The rules are small and each one is a decision that could reasonably have gone the
 * other way, so they are pinned here individually rather than through the behavior they
 * produce. What that behavior looks like from a client is in `lsp-monorepo.test.ts`.
 * @module
 */

import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isOwnProjectSourceFile,
  isScopeSourceFile,
  type ProjectBoundaries,
  projectSourceQueries,
  resolveProjectScope,
  rootOnlyScope,
} from "../../core/source-files";
import { aliasRootDirectories, resolveAliasTargets, TsConfigResolver } from "../../core/tsconfig";

describe("Project scope", () => {
  const workspace = path.resolve("/workspace");
  const app = path.join(workspace, "apps", "my-app");

  it("keeps a directory beside the root that the root's own scan cannot reach", () => {
    const scope = resolveProjectScope(app, [path.join(workspace, "libs", "ui-common", "src")]);

    assert.deepStrictEqual(scope.aliasRoots, [path.join(workspace, "libs", "ui-common", "src")]);
  });

  it("drops a directory inside the root, which the root's scan already covers", () => {
    const scope = resolveProjectScope(app, [path.join(app, "src", "shared"), app]);

    assert.deepStrictEqual(scope.aliasRoots, []);
  });

  it("drops an ancestor of the root, which would pull in the whole workspace", () => {
    const scope = resolveProjectScope(app, [workspace]);

    assert.deepStrictEqual(
      scope.aliasRoots,
      [],
      "following a mapping onto the root's own ancestor would undo the choice of root"
    );
  });

  it("keeps only the outermost of two nested directories, and each of them once", () => {
    const libs = path.join(workspace, "libs");
    const scope = resolveProjectScope(app, [path.join(libs, "ui-common"), libs, libs]);

    assert.deepStrictEqual(scope.aliasRoots, [libs]);
  });

  it("searches an alias root without the boundary rule the project root is searched with", () => {
    const boundaries: ProjectBoundaries = {
      isAngularProject: async () => true,
      findRoot: async () => undefined,
    };
    const libs = path.join(workspace, "libs");

    const queries = projectSourceQueries(resolveProjectScope(app, [libs]), boundaries);

    assert.deepStrictEqual(
      queries.map((query) => query.root),
      [app, libs]
    );
    assert.ok(queries[0].enterDirectory, "the project root stops at a package nested inside it");
    assert.strictEqual(
      queries[1].enterDirectory,
      undefined,
      "an aliased library is this project's code however its own manifest reads"
    );
  });

  describe("files reported by a watcher", () => {
    const libs = path.join(workspace, "libs");
    const scope = resolveProjectScope(app, [libs]);

    it("accepts one under an alias root", () => {
      assert.strictEqual(isScopeSourceFile(scope, path.join(libs, "ui", "src", "badge.component.ts")), true);
    });

    it("applies the same name rules there as under the root", () => {
      assert.strictEqual(isScopeSourceFile(scope, path.join(libs, "ui", "src", "badge.spec.ts")), false);
      assert.strictEqual(isScopeSourceFile(scope, path.join(libs, "ui", "node_modules", "x", "a.ts")), false);
    });

    it("rejects one in neither the root nor an alias root", () => {
      assert.strictEqual(isScopeSourceFile(scope, path.join(workspace, "tools", "build.ts")), false);
    });

    it("keeps an alias root's file even when it is a package of its own", async () => {
      // A buildable library declares `@angular/core` and would look like a nested
      // project to the boundary rule. The alias outranks that: the application's
      // tsconfig says these files compile as part of it.
      const boundaries: ProjectBoundaries = {
        isAngularProject: async () => true,
        findRoot: async (filePath) => path.dirname(filePath),
      };

      assert.strictEqual(
        await isOwnProjectSourceFile(scope, path.join(libs, "ui", "src", "badge.component.ts"), boundaries),
        true
      );
      assert.strictEqual(
        await isOwnProjectSourceFile(rootOnlyScope(app), path.join(app, "packages", "x", "a.component.ts"), boundaries),
        false,
        "the root keeps its boundary: a package nested inside it is still not its code"
      );
    });
  });
});

describe("Alias targets", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-alias-targets-"));
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  /** Writes a base config and an application config extending it. */
  async function writeConfigs(base: Record<string, unknown>): Promise<string> {
    const appRoot = path.join(sandbox, "apps", "my-app");
    await fs.mkdir(appRoot, { recursive: true });
    await fs.writeFile(path.join(sandbox, "tsconfig.base.json"), JSON.stringify({ compilerOptions: base }), "utf8");
    await fs.writeFile(
      path.join(appRoot, "tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.base.json" }),
      "utf8"
    );
    return appRoot;
  }

  it("resolves an inherited entry against the config that declared it, not the one reading it", async () => {
    const appRoot = await writeConfigs({ paths: { "@scope/ui": ["./libs/ui/src/index.ts"] } });

    const config = await new TsConfigResolver().findAndParseTsConfig(appRoot);

    assert.ok(config);
    assert.deepStrictEqual(config.aliasTargets, [
      {
        alias: "@scope/ui",
        isWildcard: false,
        physicalPath: path.join(sandbox, "libs", "ui", "src", "index.ts").split(path.sep).join("/"),
      },
    ]);
    assert.deepStrictEqual(config.aliasRoots, [path.join(sandbox, "libs", "ui", "src")]);
  });

  it("takes a wildcard entry's fixed prefix as the directory to scan", () => {
    const targets = resolveAliasTargets(path.join(sandbox, "tsconfig.json"), {
      compilerOptions: { baseUrl: ".", paths: { "@scope/*": ["libs/*/src/index.ts"], "@app/*": ["src/app/*"] } },
    });

    assert.deepStrictEqual(
      targets.map((target) => target.alias),
      ["@scope", "@app"]
    );
    assert.deepStrictEqual(
      aliasRootDirectories(targets).sort(),
      [path.join(sandbox, "libs"), path.join(sandbox, "src", "app")].sort()
    );
  });

  it("reports nothing rather than throwing when an entry is one TypeScript would reject", () => {
    // Without a `baseUrl`, TypeScript requires a relative or absolute substitution.
    const targets = resolveAliasTargets(path.join(sandbox, "tsconfig.json"), {
      compilerOptions: { paths: { "@scope/ui": ["libs/ui/src/index.ts"] } },
    });

    assert.deepStrictEqual(targets, []);
  });
});
