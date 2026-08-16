import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectRuntime } from "../../lsp/project-runtime";
import { ProjectRuntimeHost } from "../../lsp/project-runtime-host";
import { AngularElementData } from "../../types/angular";

async function writeProject(root: string, paths: Record<string, string[]> = {}): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths } }),
    "utf8"
  );
}

function element(name: string, root: string): AngularElementData {
  return new AngularElementData({
    path: path.join(root, "src", "shared", `${name}.ts`),
    name,
    type: "component",
    originalSelector: name,
    selectors: [name],
    isStandalone: true,
    isExternal: false,
  });
}

describe("LSP project runtime", function () {
  this.timeout(10000);

  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-runtime-"));
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("loads the project's own tsconfig", async () => {
    const root = path.join(sandbox, "apps", "shop");
    await writeProject(root, { "@shop/*": ["src/*"] });
    const runtime = new ProjectRuntime(root);

    await runtime.load();

    assert.strictEqual(runtime.tsConfig?.sourceFilePath, path.join(root, "tsconfig.json"));
    assert.deepStrictEqual(runtime.tsConfig?.paths, { "@shop/*": ["src/*"] });
  });

  it("reports a project without a tsconfig instead of failing", async () => {
    const root = path.join(sandbox, "apps", "plain");
    await fs.mkdir(root, { recursive: true });
    const runtime = new ProjectRuntime(root);

    await runtime.load();

    assert.strictEqual(runtime.tsConfig, null);
  });

  it("resolves import paths through the project's own aliases", async () => {
    const root = path.join(sandbox, "apps", "shop");
    await writeProject(root, { "@shop/*": ["src/*"] });
    const runtime = new ProjectRuntime(root);
    await runtime.load();

    assert.strictEqual(
      await runtime.resolveImportPath(
        path.join(root, "src", "shared", "card.component"),
        path.join(root, "src", "app.ts")
      ),
      "@shop/shared/card.component"
    );
  });

  it("keeps sibling projects' aliases and indexes apart", async () => {
    const legacyRoot = path.join(sandbox, "apps", "legacy");
    const modernRoot = path.join(sandbox, "apps", "modern");
    await writeProject(legacyRoot, { "@legacy/*": ["src/*"] });
    await writeProject(modernRoot, { "@modern/*": ["src/*"] });
    const legacy = new ProjectRuntime(legacyRoot);
    const modern = new ProjectRuntime(modernRoot);
    await Promise.all([legacy.load(), modern.load()]);

    legacy.index.selectors.insert("legacy-card", element("LegacyCard", legacyRoot));

    assert.strictEqual(
      await legacy.resolveImportPath(path.join(legacyRoot, "src", "card"), path.join(legacyRoot, "src", "app.ts")),
      "@legacy/card"
    );
    assert.strictEqual(
      await modern.resolveImportPath(path.join(modernRoot, "src", "card"), path.join(modernRoot, "src", "app.ts")),
      "@modern/card"
    );
    assert.deepStrictEqual(legacy.index.getAllSelectors(), ["legacy-card"]);
    assert.deepStrictEqual(modern.index.getAllSelectors(), []);
  });

  it("drops the index and the parsed configuration when disposed", async () => {
    const root = path.join(sandbox, "apps", "shop");
    await writeProject(root, { "@shop/*": ["src/*"] });
    const runtime = new ProjectRuntime(root);
    await runtime.load();
    runtime.index.selectors.insert("shop-card", element("ShopCard", root));

    runtime.dispose();

    assert.strictEqual(runtime.tsConfig, null);
    assert.deepStrictEqual(runtime.index.getAllSelectors(), []);
  });
});

describe("LSP project runtime host", function () {
  this.timeout(10000);

  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-runtime-host-"));
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("creates one runtime per root and keeps it across repeated requests", async () => {
    const appRoot = path.join(sandbox, "apps", "shop");
    const featureRoot = path.join(appRoot, "packages", "checkout");
    await writeProject(appRoot);
    await writeProject(featureRoot);
    const host = new ProjectRuntimeHost();

    await host.create(appRoot);
    const first = host.get(appRoot);
    await host.create(appRoot);
    await host.create(featureRoot);

    assert.strictEqual(host.get(appRoot), first, "A second request must not replace a live runtime");
    assert.deepStrictEqual(host.roots(), [appRoot, featureRoot]);
    assert.notStrictEqual(host.get(featureRoot), first);
  });

  it("leaves nothing behind when a runtime fails to load", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const disposals: string[] = [];
    const host = new ProjectRuntimeHost({
      createRuntime: (rootPath: string) => {
        const runtime = new ProjectRuntime(rootPath);
        runtime.load = async () => {
          throw new Error("tsconfig unreadable");
        };
        runtime.dispose = () => disposals.push(rootPath);
        return runtime;
      },
    });

    await assert.rejects(host.create(root), /tsconfig unreadable/);

    assert.deepStrictEqual(host.roots(), [], "A failed root must stay retryable");
    assert.deepStrictEqual(disposals, [root]);
  });

  it("disposes one root without touching the others", async () => {
    const appRoot = path.join(sandbox, "apps", "shop");
    const featureRoot = path.join(appRoot, "packages", "checkout");
    await writeProject(appRoot);
    await writeProject(featureRoot);
    const host = new ProjectRuntimeHost();
    await host.create(appRoot);
    await host.create(featureRoot);
    const feature = host.get(featureRoot);

    host.dispose(appRoot);
    host.dispose(appRoot);

    assert.deepStrictEqual(host.roots(), [featureRoot]);
    assert.strictEqual(host.get(featureRoot), feature);
  });

  it("disposes every runtime at shutdown", async () => {
    const appRoot = path.join(sandbox, "apps", "shop");
    const featureRoot = path.join(appRoot, "packages", "checkout");
    await writeProject(appRoot);
    await writeProject(featureRoot);
    const host = new ProjectRuntimeHost();
    await host.create(appRoot);
    await host.create(featureRoot);

    host.disposeAll();

    assert.deepStrictEqual(host.roots(), []);
    assert.strictEqual(host.get(appRoot), undefined);
  });
});
