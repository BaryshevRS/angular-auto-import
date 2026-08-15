import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findDeepestContainingProjectRoot, isPathInside } from "../../core/project-registry";
import * as extensionModule from "../../extension";

type DependencyRootApi = {
  findAngularDependencyRoot(filePath: string, searchBoundary: string): Promise<string | undefined>;
  invalidateAngularProjectCache(packageJsonPath?: string): void;
};

// Keep the RED tests type-checkable before the new public API is exported. At runtime,
// an absent helper still fails clearly and directs the implementation to the expected API.
const { findAngularDependencyRoot, invalidateAngularProjectCache } = extensionModule as unknown as DependencyRootApi;

/** Counts manifest reads performed while running `run`, so cached lookups are observable. */
async function countManifestReads(run: () => Promise<void>): Promise<number> {
  const fsPromises = fs as unknown as { readFile: typeof fs.readFile };
  const originalReadFile = fsPromises.readFile;
  let manifestReads = 0;

  fsPromises.readFile = ((filePath: Parameters<typeof fs.readFile>[0], ...rest: unknown[]) => {
    if (typeof filePath === "string" && filePath.endsWith("package.json")) {
      manifestReads += 1;
    }
    return (originalReadFile as (...args: unknown[]) => unknown)(filePath, ...rest);
  }) as typeof fs.readFile;

  try {
    await run();
  } finally {
    fsPromises.readFile = originalReadFile;
  }

  return manifestReads;
}

async function writePackageJson(
  packageRoot: string,
  manifest: Record<string, unknown> = { dependencies: { "@angular/core": "^21.0.0" } }
): Promise<void> {
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify(manifest), "utf8");
}

async function writeDocument(documentPath: string): Promise<void> {
  await fs.mkdir(path.dirname(documentPath), { recursive: true });
  await fs.writeFile(documentPath, "export class TestComponent {}\n", "utf8");
}

describe("Angular dependency root discovery", function () {
  this.timeout(10000);

  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-roots-"));
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("finds an Angular package at the search boundary", async () => {
    const documentPath = path.join(sandbox, "src", "app", "app.component.ts");
    await writePackageJson(sandbox);
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), sandbox);
  });

  it("lazily finds a nested Angular package from an opened TypeScript document", async () => {
    const appRoot = path.join(sandbox, "packages", "client-app");
    const documentPath = path.join(appRoot, "src", "app", "app.component.ts");
    await writePackageJson(sandbox, { name: "workspace" });
    await writePackageJson(appRoot);
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), appRoot);
  });

  it("lazily finds a nested Angular package from an opened HTML document", async () => {
    const appRoot = path.join(sandbox, "apps", "shop");
    const documentPath = path.join(appRoot, "src", "app", "checkout.component.html");
    await writePackageJson(appRoot);
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), appRoot);
  });

  it("chooses the nearest package when Angular packages are nested", async () => {
    const outerRoot = path.join(sandbox, "apps", "shell");
    const innerRoot = path.join(outerRoot, "packages", "feature");
    const documentPath = path.join(innerRoot, "src", "feature.component.ts");
    await writePackageJson(outerRoot, { dependencies: { "@angular/core": "^20.0.0" } });
    await writePackageJson(innerRoot, { dependencies: { "@angular/core": "^21.0.0" } });
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), innerRoot);
  });

  it("keeps sibling Angular versions in separate dependency roots", async () => {
    const legacyRoot = path.join(sandbox, "apps", "legacy");
    const modernRoot = path.join(sandbox, "apps", "modern");
    const legacyDocument = path.join(legacyRoot, "src", "legacy.component.ts");
    const modernDocument = path.join(modernRoot, "src", "modern.component.ts");
    await writePackageJson(legacyRoot, { dependencies: { "@angular/core": "^19.0.0" } });
    await writePackageJson(modernRoot, { dependencies: { "@angular/core": "^22.0.0" } });
    await writeDocument(legacyDocument);
    await writeDocument(modernDocument);

    assert.strictEqual(await findAngularDependencyRoot(legacyDocument, sandbox), legacyRoot);
    assert.strictEqual(await findAngularDependencyRoot(modernDocument, sandbox), modernRoot);
  });

  for (const dependencySection of ["dependencies", "devDependencies"] as const) {
    it(`recognizes @angular/core in ${dependencySection}`, async () => {
      const appRoot = path.join(sandbox, dependencySection);
      const documentPath = path.join(appRoot, "src", "main.ts");
      await writePackageJson(appRoot, { [dependencySection]: { "@angular/core": "^21.0.0" } });
      await writeDocument(documentPath);

      assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), appRoot);
    });
  }

  it("supports Angular packages in scoped and deeply nested workspace locations", async () => {
    const appRoot = path.join(sandbox, "packages", "@company", "products", "admin");
    const documentPath = path.join(appRoot, "src", "pages", "users", "users.component.ts");
    await writePackageJson(appRoot);
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), appRoot);
  });

  it("does not search outside the supplied boundary", async () => {
    const boundary = path.join(sandbox, "packages", "plain-package");
    const documentPath = path.join(boundary, "src", "file.ts");
    await writePackageJson(sandbox);
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, boundary), undefined);
  });

  it("rejects a document that is outside the supplied boundary", async () => {
    const boundary = path.join(sandbox, "allowed");
    const appRoot = path.join(sandbox, "outside-app");
    const documentPath = path.join(appRoot, "src", "app.component.ts");
    await fs.mkdir(boundary, { recursive: true });
    await writePackageJson(appRoot);
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, boundary), undefined);
  });

  it("rejects package roots discovered inside node_modules", async () => {
    const dependencyRoot = path.join(sandbox, "node_modules", "@company", "angular-widget");
    const documentPath = path.join(dependencyRoot, "src", "widget.component.ts");
    await writePackageJson(dependencyRoot);
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), undefined);
  });

  it("skips malformed package.json files and continues toward the boundary", async () => {
    const malformedRoot = path.join(sandbox, "packages", "broken");
    const documentPath = path.join(malformedRoot, "src", "app.component.ts");
    await writePackageJson(sandbox);
    await fs.mkdir(malformedRoot, { recursive: true });
    await fs.writeFile(path.join(malformedRoot, "package.json"), "{ not valid JSON", "utf8");
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), sandbox);
  });

  it("returns undefined when no containing package declares Angular", async () => {
    const documentPath = path.join(sandbox, "packages", "plain", "src", "file.ts");
    await writePackageJson(sandbox, { name: "workspace", dependencies: { typescript: "^5.9.0" } });
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), undefined);
  });

  it("accepts an exact package-root path and a boundary with a trailing separator", async () => {
    const appRoot = path.join(sandbox, "apps", "exact");
    await writePackageJson(appRoot);

    assert.strictEqual(await findAngularDependencyRoot(appRoot, `${sandbox}${path.sep}`), appRoot);
  });

  it("reads each manifest once when many documents of the same project are opened", async () => {
    const appRoot = path.join(sandbox, "packages", "client-app");
    const documentPaths = [
      path.join(appRoot, "src", "app", "app.component.ts"),
      path.join(appRoot, "src", "app", "shell.component.ts"),
      path.join(appRoot, "src", "app", "pages", "home.component.ts"),
      path.join(appRoot, "src", "app", "pages", "about.component.html"),
    ];
    await writePackageJson(sandbox, { name: "workspace" });
    await writePackageJson(appRoot);
    for (const documentPath of documentPaths) {
      await writeDocument(documentPath);
    }

    const firstOpenReads = await countManifestReads(async () => {
      assert.strictEqual(await findAngularDependencyRoot(documentPaths[0], sandbox), appRoot);
    });
    assert.ok(firstOpenReads > 0, "The first document open must read the manifest at least once");

    const laterOpenReads = await countManifestReads(async () => {
      for (const documentPath of documentPaths) {
        assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), appRoot);
      }
    });

    assert.strictEqual(laterOpenReads, 0, "Opening further documents must not re-read package.json files");
  });

  it("does not re-read manifests while repeatedly discovering a document outside any Angular package", async () => {
    const plainRoot = path.join(sandbox, "packages", "plain");
    const documentPath = path.join(plainRoot, "src", "util.ts");
    await writePackageJson(sandbox, { name: "workspace" });
    await writePackageJson(plainRoot, { name: "plain", dependencies: { typescript: "^5.9.0" } });
    await writeDocument(documentPath);

    await findAngularDependencyRoot(documentPath, sandbox);

    const repeatedLookupReads = await countManifestReads(async () => {
      assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), undefined);
      assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), undefined);
    });

    assert.strictEqual(repeatedLookupReads, 0, "A negative discovery result must also stay cached");
  });

  it("discovers a package again after its manifest cache entry is invalidated", async () => {
    const appRoot = path.join(sandbox, "packages", "late-angular");
    const documentPath = path.join(appRoot, "src", "app.component.ts");
    await writePackageJson(sandbox, { name: "workspace" });
    await writePackageJson(appRoot, { name: "late-angular" });
    await writeDocument(documentPath);

    assert.strictEqual(await findAngularDependencyRoot(documentPath, sandbox), undefined);

    // Simulate `npm install @angular/core` inside the package.
    await writePackageJson(appRoot);
    invalidateAngularProjectCache(path.join(appRoot, "package.json"));

    assert.strictEqual(
      await findAngularDependencyRoot(documentPath, sandbox),
      appRoot,
      "A manifest change must make the package discoverable without a window reload"
    );
  });
});

describe("boundary-safe project-root containment", () => {
  it("contains the exact root path", () => {
    const root = path.join(path.sep, "workspace", "app");
    assert.strictEqual(isPathInside(root, root), true);
  });

  it("contains descendants and tolerates trailing separators", () => {
    const root = path.join(path.sep, "workspace", "app");
    const filePath = path.join(root, "src", "app.component.ts");
    assert.strictEqual(isPathInside(`${root}${path.sep}`, filePath), true);
  });

  it("normalizes dot segments before comparing paths", () => {
    const root = path.join(path.sep, "workspace", "app");
    const filePath = path.join(root, "src", "..", "src", "app.component.ts");
    assert.strictEqual(isPathInside(root, filePath), true);
  });

  it("does not confuse a sibling with a shared string prefix for a child", () => {
    const root = path.join(path.sep, "workspace", "app");
    const siblingFile = path.join(path.sep, "workspace", "app-old", "src", "app.component.ts");
    assert.strictEqual(isPathInside(root, siblingFile), false);
  });

  it("rejects parent and unrelated paths", () => {
    const root = path.join(path.sep, "workspace", "app");
    assert.strictEqual(isPathInside(root, path.dirname(root)), false);
    assert.strictEqual(isPathInside(root, path.join(path.sep, "other", "file.ts")), false);
  });
});

describe("document context project-root selection", () => {
  it("selects the nested dependency root even when the workspace root is already known", () => {
    const workspaceRoot = path.join(path.sep, "workspace");
    const nestedRoot = path.join(workspaceRoot, "apps", "storefront");
    const documentPath = path.join(nestedRoot, "src", "app.component.ts");

    assert.strictEqual(
      findDeepestContainingProjectRoot(documentPath, [workspaceRoot, nestedRoot]),
      nestedRoot,
      "A workspace-level indexer must not mask a more specific nested Angular indexer"
    );
  });

  it("is independent of known-root insertion order", () => {
    const workspaceRoot = path.join(path.sep, "workspace");
    const appRoot = path.join(workspaceRoot, "apps", "storefront");
    const featureRoot = path.join(appRoot, "packages", "checkout");
    const documentPath = path.join(featureRoot, "src", "checkout.component.html");
    const orders = [
      [workspaceRoot, appRoot, featureRoot],
      [featureRoot, workspaceRoot, appRoot],
      [appRoot, featureRoot, workspaceRoot],
    ];

    for (const roots of orders) {
      assert.strictEqual(findDeepestContainingProjectRoot(documentPath, roots), featureRoot);
    }
  });

  it("selects the matching sibling root so dependency indexes never mix", () => {
    const workspaceRoot = path.join(path.sep, "workspace");
    const angular19Root = path.join(workspaceRoot, "apps", "angular-19");
    const angular22Root = path.join(workspaceRoot, "apps", "angular-22");
    const roots = new Set([workspaceRoot, angular19Root, angular22Root]);

    assert.strictEqual(
      findDeepestContainingProjectRoot(path.join(angular19Root, "src", "main.ts"), roots),
      angular19Root
    );
    assert.strictEqual(
      findDeepestContainingProjectRoot(path.join(angular22Root, "src", "main.ts"), roots),
      angular22Root
    );
  });

  it("does not select app for a document in app-old", () => {
    const workspaceRoot = path.join(path.sep, "workspace");
    const appRoot = path.join(workspaceRoot, "app");
    const appOldRoot = path.join(workspaceRoot, "app-old");
    const documentPath = path.join(appOldRoot, "src", "main.ts");

    assert.strictEqual(findDeepestContainingProjectRoot(documentPath, [appRoot, appOldRoot]), appOldRoot);
  });

  it("selects a root when the document path is exactly that root", () => {
    const root = path.join(path.sep, "workspace", "app");
    assert.strictEqual(findDeepestContainingProjectRoot(root, [root]), root);
  });

  it("normalizes known roots before choosing the deepest context", () => {
    const workspaceRoot = path.join(path.sep, "workspace");
    const appRoot = path.join(workspaceRoot, "apps", "storefront");
    const documentPath = path.join(appRoot, "src", "pages", "..", "app.component.ts");
    const unnormalizedAppRoot = `${workspaceRoot}${path.sep}apps${path.sep}..${path.sep}apps${path.sep}storefront${path.sep}`;

    assert.strictEqual(
      findDeepestContainingProjectRoot(documentPath, [`${workspaceRoot}${path.sep}`, unnormalizedAppRoot]),
      appRoot
    );
  });

  it("returns undefined for empty roots or a document outside all known roots", () => {
    const documentPath = path.join(path.sep, "workspace", "app", "src", "main.ts");
    assert.strictEqual(findDeepestContainingProjectRoot(documentPath, []), undefined);
    assert.strictEqual(
      findDeepestContainingProjectRoot(documentPath, [path.join(path.sep, "other-workspace")]),
      undefined
    );
  });
});
