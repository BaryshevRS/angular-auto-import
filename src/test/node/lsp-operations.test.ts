import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ServerOperations } from "../../lsp/operations";
import { ProjectRouter } from "../../lsp/project-router";
import { ProjectRuntime } from "../../lsp/project-runtime";

function component(name: string, selector: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    `@Component({ selector: "${selector}", standalone: true, template: "" })`,
    `export class ${name} {}`,
    "",
  ].join("\n");
}

async function writeProject(root: string, paths: Record<string, string[]> = {}): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths } }),
    "utf8"
  );
}

describe("LSP server operations", function () {
  this.timeout(20000);

  let sandbox: string;
  let shopRoot: string;
  let adminRoot: string;
  let shop: ProjectRuntime;
  let admin: ProjectRuntime;
  let operations: ServerOperations;

  function operationsFor(runtimes: ProjectRuntime[]): ServerOperations {
    const router = new ProjectRouter({
      rootForPath: (filePath) =>
        runtimes
          .map((runtime) => runtime.rootPath)
          .filter((root) => filePath.startsWith(root + path.sep))
          .sort((a, b) => b.length - a.length)[0],
      runtimeForRoot: (rootPath) => runtimes.find((runtime) => runtime.rootPath === rootPath),
    });
    return new ServerOperations({ router, runtimes: () => runtimes });
  }

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-operations-"));
    shopRoot = path.join(sandbox, "apps", "shop");
    adminRoot = path.join(sandbox, "apps", "admin");
    await writeProject(shopRoot);
    await writeProject(adminRoot);
    await fs.writeFile(
      path.join(shopRoot, "src", "card.component.ts"),
      component("CardComponent", "shop-card"),
      "utf8"
    );
    shop = new ProjectRuntime(shopRoot);
    admin = new ProjectRuntime(adminRoot);
    await Promise.all([shop.load(), admin.load()]);
    operations = operationsFor([shop, admin]);
  });

  afterEach(async () => {
    shop.dispose();
    admin.dispose();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("reindexes every project when the scope names no document", async () => {
    const result = await operations.reindex({});

    assert.deepStrictEqual(
      result.projects.map((project) => project.rootPath),
      [shopRoot, adminRoot]
    );
    assert.strictEqual(result.projects[0].elementCount, 1);
  });

  it("reindexes only the project owning the scoped document", async () => {
    const uri = pathToFileURL(path.join(shopRoot, "src", "card.component.ts")).toString();

    const result = await operations.reindex({ uri });

    assert.deepStrictEqual(
      result.projects.map((project) => project.rootPath),
      [shopRoot]
    );
  });

  it("falls back to every project for a document no project owns", async () => {
    const uri = pathToFileURL(path.join(sandbox, "elsewhere", "notes.ts")).toString();

    const result = await operations.reindex({ uri });

    assert.strictEqual(result.projects.length, 2);
  });

  it("picks up a component added since the last index", async () => {
    await fs.writeFile(
      path.join(shopRoot, "src", "badge.component.ts"),
      component("BadgeComponent", "shop-badge"),
      "utf8"
    );

    const result = await operations.reindex({ uri: pathToFileURL(path.join(shopRoot, "src")).toString() });

    assert.strictEqual(result.projects[0].elementCount, 2);
    assert.deepStrictEqual(new Set(shop.indexer.getAllSelectors()), new Set(["shop-card", "shop-badge"]));
  });

  it("re-reads the project's TypeScript configuration, so a changed alias takes effect", async () => {
    await writeProject(shopRoot, { "@shop/*": ["src/*"] });

    await operations.reindex({});

    assert.deepStrictEqual(shop.tsConfig?.paths, { "@shop/*": ["src/*"] });
  });

  it("reports one project's failure without hiding the others' success", async () => {
    const broken = {
      rootPath: path.join(sandbox, "apps", "broken"),
      elementCount: 0,
      reindex: () => Promise.reject(new Error("disk went away")),
    } as unknown as ProjectRuntime;

    const result = await operationsFor([shop, broken]).reindex({});

    assert.strictEqual(result.projects[0].error, undefined);
    assert.strictEqual(result.projects[1].error, "disk went away");
  });

  it("clears a project's cache, so the next session indexes from source again", async () => {
    const storagePath = path.join(sandbox, "storage");
    const first = new ProjectRuntime(shopRoot, { storagePath });
    await first.load();
    first.dispose();
    const restored = new ProjectRuntime(shopRoot, { storagePath });
    await restored.load();
    assert.strictEqual(restored.restoredFromCache, true, "The cache must be usable before it is cleared");

    const result = await operationsFor([restored]).clearCache({});
    restored.dispose();

    assert.deepStrictEqual(
      result.projects.map((project) => project.rootPath),
      [shopRoot]
    );
    const afterClear = new ProjectRuntime(shopRoot, { storagePath });
    await afterClear.load();
    assert.strictEqual(afterClear.restoredFromCache, false);
    afterClear.dispose();
  });

  it("reports the server process's own memory and CPU", () => {
    const metrics = operations.metrics();

    assert.ok(metrics.memory.rss > 0, "RSS must describe a real process");
    assert.ok(metrics.memory.heapUsed > 0);
    assert.ok(metrics.cpu.user >= 0 && metrics.cpu.system >= 0);
  });

  it("reports each project's index size", () => {
    const metrics = operations.metrics();

    assert.deepStrictEqual(metrics.projects, [
      { rootPath: shopRoot, elementCount: 1 },
      { rootPath: adminRoot, elementCount: 0 },
    ]);
  });

  it("resolves an empty scope to every project and a scoped one to just its own", () => {
    const uri = pathToFileURL(path.join(adminRoot, "src", "app.ts")).toString();

    assert.strictEqual(operations.resolveScope({}).length, 2);
    assert.deepStrictEqual(
      operations.resolveScope({ uri }).map((runtime) => runtime.rootPath),
      [adminRoot]
    );
  });
});
