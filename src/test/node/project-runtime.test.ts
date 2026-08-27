import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { FileChangeType } from "vscode-languageserver/node";
import { ProjectRuntime } from "../../lsp/project-runtime";
import { ProjectRuntimeHost } from "../../lsp/project-runtime-host";
import { WatchedFiles } from "../../lsp/watched-files";

async function writeProject(root: string, paths: Record<string, string[]> = {}): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths } }),
    "utf8"
  );
}

/** Writes a standalone component the indexer can actually pick up. */
async function writeComponent(root: string, className: string, selector: string): Promise<void> {
  const filePath = path.join(root, "src", `${selector}.component.ts`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    [
      'import { Component } from "@angular/core";',
      "",
      "@Component({",
      `  selector: "${selector}",`,
      "  standalone: true,",
      '  template: "",',
      "})",
      `export class ${className} {}`,
      "",
    ].join("\n"),
    "utf8"
  );
}

/** Waits for work the indexer started from a watched change to settle. */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the index to catch up with a watched change");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  it("takes into scope what its aliases map in from outside the root", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const libs = path.join(sandbox, "libs", "ui");
    await writeProject(root, { "@ui/*": ["../../libs/ui/*"], "@shop/*": ["src/*"] });
    await fs.mkdir(libs, { recursive: true });
    const runtime = new ProjectRuntime(root);

    await runtime.load();

    assert.deepStrictEqual(
      runtime.projectScope.aliasRoots,
      [libs],
      "the mapping onto `src` is already covered by the root's own scan"
    );
  });

  it("leaves out an alias root that is not there, rather than watching nothing", async () => {
    const root = path.join(sandbox, "apps", "shop");
    await writeProject(root, { "@ui/*": ["../../libs/not-generated-yet/*"] });
    const runtime = new ProjectRuntime(root);

    await runtime.load();

    assert.deepStrictEqual(
      runtime.projectScope.aliasRoots,
      [],
      "a `paths` entry for a library nobody has generated is normal in a monorepo"
    );
  });

  it("finds a library added to the scope by a changed tsconfig when asked to reindex", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const libs = path.join(sandbox, "libs", "ui");
    await writeProject(root);
    await fs.mkdir(path.join(libs, "src"), { recursive: true });
    await writeComponent(libs, "UiBadgeComponent", "ui-badge");

    const runtime = new ProjectRuntime(root);
    await runtime.load();
    assert.strictEqual(
      runtime.indexer.getElements("ui-badge").length,
      0,
      "nothing maps the library in yet, so it is another project's code"
    );

    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@ui/*": ["../../libs/ui/*"] } } }),
      "utf8"
    );
    await runtime.reindex();

    assert.deepStrictEqual(runtime.projectScope.aliasRoots, [libs]);
    assert.strictEqual(runtime.indexer.getElements("ui-badge").length, 1);
    runtime.dispose();
  });

  it("never writes an absolute path for a library its own aliases put in scope", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const libs = path.join(sandbox, "libs");
    // A `*` in the middle of the mapped path: the alias cannot be rebuilt from the
    // target, so there is no specifier to write and the fallback decides.
    await writeProject(root, { "@ui/*": ["../../libs/*/src/index.ts"] });
    await fs.mkdir(path.join(libs, "badge", "src"), { recursive: true });
    const runtime = new ProjectRuntime(root);
    await runtime.load();

    const written = await runtime.resolveImportPath(
      path.join(libs, "badge", "src", "index"),
      path.join(root, "src", "host.component.ts")
    );

    assert.ok(!path.isAbsolute(written), `an absolute path is not an import: ${written}`);
    assert.ok(written.startsWith("."), `expected a relative specifier, got ${written}`);
  });

  it("still refuses to guess for a file no part of the project reaches", async () => {
    const root = path.join(sandbox, "apps", "shop");
    await writeProject(root);
    const runtime = new ProjectRuntime(root);
    await runtime.load();

    const outside = path.join(sandbox, "unrelated", "module");
    const written = await runtime.resolveImportPath(outside, path.join(root, "src", "host.component.ts"));

    assert.strictEqual(written, outside, "nothing maps it in, so there is no specifier to invent");
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
    await writeComponent(legacyRoot, "LegacyCardComponent", "legacy-card");
    const legacy = new ProjectRuntime(legacyRoot);
    const modern = new ProjectRuntime(modernRoot);
    await Promise.all([legacy.load(), modern.load()]);

    assert.strictEqual(
      await legacy.resolveImportPath(path.join(legacyRoot, "src", "card"), path.join(legacyRoot, "src", "app.ts")),
      "@legacy/card"
    );
    assert.strictEqual(
      await modern.resolveImportPath(path.join(modernRoot, "src", "card"), path.join(modernRoot, "src", "app.ts")),
      "@modern/card"
    );
    assert.deepStrictEqual(legacy.indexer.getAllSelectors(), ["legacy-card"]);
    assert.deepStrictEqual(modern.indexer.getAllSelectors(), []);
  });

  it("lists the project's indexable sources and nothing else", async () => {
    const root = path.join(sandbox, "apps", "shop");
    await writeProject(root);
    await fs.writeFile(path.join(root, "src", "app.component.ts"), "", "utf8");
    await fs.writeFile(path.join(root, "src", "app.component.spec.ts"), "", "utf8");
    await fs.mkdir(path.join(root, "node_modules", "lib"), { recursive: true });
    await fs.writeFile(path.join(root, "node_modules", "lib", "index.ts"), "", "utf8");
    const runtime = new ProjectRuntime(root);
    await runtime.load();

    const sources = await runtime.listSourceFiles();

    assert.deepStrictEqual(sources, [path.join(root, "src", "app.component.ts")]);
  });

  it("keeps no persistent cache when the client gave the server no storage directory", async () => {
    const root = path.join(sandbox, "apps", "shop");
    await writeProject(root);
    const runtime = new ProjectRuntime(root);

    await runtime.load();

    assert.strictEqual(runtime.cache, undefined);
  });

  it("persists its index under the storage directory and reads it back next session", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const storagePath = path.join(sandbox, "storage");
    await writeProject(root);
    const first = new ProjectRuntime(root, { storagePath });
    await first.load();
    await first.cache?.set("selectors", { "app-card": 1 });

    const second = new ProjectRuntime(root, { storagePath });
    await second.load();

    assert.deepStrictEqual(second.cache?.get("selectors"), { "app-card": 1 });
  });

  it("does not read another root's cache", async () => {
    const storagePath = path.join(sandbox, "storage");
    const shopRoot = path.join(sandbox, "apps", "shop");
    const adminRoot = path.join(sandbox, "apps", "admin");
    await writeProject(shopRoot);
    await writeProject(adminRoot);
    const shop = new ProjectRuntime(shopRoot, { storagePath });
    await shop.load();
    await shop.cache?.set("selectors", { "app-card": 1 });

    const admin = new ProjectRuntime(adminRoot, { storagePath });
    await admin.load();

    assert.strictEqual(admin.cache?.get("selectors"), undefined);
  });

  it("indexes the project's own components at load", async () => {
    const root = path.join(sandbox, "apps", "shop");
    await writeProject(root);
    await writeComponent(root, "ShopCardComponent", "shop-card");
    const runtime = new ProjectRuntime(root);

    await runtime.load();

    assert.deepStrictEqual(runtime.indexer.getAllSelectors(), ["shop-card"]);
    assert.strictEqual(runtime.restoredFromCache, false);
  });

  it("restores the index from the cache instead of rescanning", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const storagePath = path.join(sandbox, "storage");
    await writeProject(root);
    await writeComponent(root, "ShopCardComponent", "shop-card");
    const first = new ProjectRuntime(root, { storagePath });
    await first.load();
    first.dispose();

    const second = new ProjectRuntime(root, { storagePath });
    await second.load();

    assert.strictEqual(second.restoredFromCache, true);
    assert.deepStrictEqual(second.indexer.getAllSelectors(), ["shop-card"]);
  });

  it("restores template ownership when component and template basenames differ", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const storagePath = path.join(sandbox, "storage");
    const componentPath = path.join(root, "src", "host-shell.component.ts");
    const templatePath = path.join(root, "src", "templates", "dashboard.html");
    await writeProject(root);
    await fs.mkdir(path.dirname(templatePath), { recursive: true });
    await fs.writeFile(
      componentPath,
      [
        'import { Component } from "@angular/core";',
        "",
        "@Component({",
        '  selector: "host-shell",',
        "  standalone: true,",
        '  templateUrl: "./templates/dashboard.html",',
        "})",
        "export class HostShellComponent {}",
        "",
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(templatePath, "<main>Dashboard</main>\n", "utf8");

    const first = new ProjectRuntime(root, { storagePath });
    await first.load();
    first.dispose();

    const restored = new ProjectRuntime(root, { storagePath });
    await restored.load();

    assert.strictEqual(restored.restoredFromCache, true);
    assert.strictEqual(restored.componentFileForTemplate(templatePath), componentPath);
    restored.dispose();
  });

  it("rejects stale cached template ownership when the component source changed while stopped", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const storagePath = path.join(sandbox, "storage");
    const componentPath = path.join(root, "src", "host-shell.component.ts");
    const oldTemplatePath = path.join(root, "src", "old.html");
    const newTemplatePath = path.join(root, "src", "templates", "new.html");
    await writeProject(root);
    await fs.writeFile(
      componentPath,
      '@Component({ selector: "host-shell", standalone: true, templateUrl: "./old.html" })\n' +
        "export class HostShellComponent {}\n",
      "utf8"
    );
    await fs.writeFile(oldTemplatePath, "<main>Old</main>\n", "utf8");

    const first = new ProjectRuntime(root, { storagePath });
    await first.load();
    first.dispose();

    await fs.mkdir(path.dirname(newTemplatePath), { recursive: true });
    await fs.writeFile(
      componentPath,
      '@Component({ selector: "host-shell", standalone: true, templateUrl: "./templates/new.html" })\n' +
        "export class HostShellComponent {}\n",
      "utf8"
    );
    await fs.writeFile(newTemplatePath, "<main>New</main>\n", "utf8");

    const restored = new ProjectRuntime(root, { storagePath });
    await restored.load();

    assert.strictEqual(restored.restoredFromCache, false);
    assert.strictEqual(restored.componentFileForTemplate(newTemplatePath), componentPath);
    assert.notStrictEqual(restored.componentFileForTemplate(oldTemplatePath), componentPath);
    restored.dispose();
  });

  it("rejects a cached index when a stopped component switches to an external template", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const storagePath = path.join(sandbox, "storage");
    const componentPath = path.join(root, "src", "host-shell.component.ts");
    const templatePath = path.join(root, "src", "templates", "dashboard.html");
    await writeProject(root);
    await fs.writeFile(
      componentPath,
      '@Component({ selector: "host-shell", standalone: true, template: "" })\n' +
        "export class HostShellComponent {}\n",
      "utf8"
    );

    const first = new ProjectRuntime(root, { storagePath });
    await first.load();
    first.dispose();

    await fs.writeFile(
      componentPath,
      '@Component({ selector: "host-shell", standalone: true, templateUrl: "./templates/dashboard.html" })\n' +
        "export class HostShellComponent {}\n",
      "utf8"
    );
    await fs.mkdir(path.dirname(templatePath), { recursive: true });
    await fs.writeFile(templatePath, "<main>Dashboard</main>\n", "utf8");

    const restored = new ProjectRuntime(root, { storagePath });
    await restored.load();

    assert.strictEqual(restored.restoredFromCache, false);
    assert.strictEqual(restored.componentFileForTemplate(templatePath), componentPath);
    restored.dispose();
  });

  it("follows watched source changes without rescanning the project", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const componentPath = path.join(root, "src", "shop-card.component.ts");
    await writeProject(root);
    const watched = new WatchedFiles();
    const runtime = new ProjectRuntime(root, { fileWatchers: watched });
    await runtime.load();
    assert.deepStrictEqual(runtime.indexer.getAllSelectors(), []);

    await writeComponent(root, "ShopCardComponent", "shop-card");
    watched.dispatch([{ uri: pathToFileURL(componentPath).toString(), type: FileChangeType.Created }]);
    await waitFor(() => runtime.indexer.getAllSelectors().length === 1);

    assert.deepStrictEqual(runtime.indexer.getAllSelectors(), ["shop-card"]);

    await fs.rm(componentPath);
    watched.dispatch([{ uri: pathToFileURL(componentPath).toString(), type: FileChangeType.Deleted }]);
    await waitFor(() => runtime.indexer.getAllSelectors().length === 0);

    assert.deepStrictEqual(runtime.indexer.getAllSelectors(), []);
  });

  it("drops a renamed selector instead of keeping both", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const componentPath = path.join(root, "src", "shop-card.component.ts");
    await writeProject(root);
    await writeComponent(root, "ShopCardComponent", "shop-card");
    const watched = new WatchedFiles();
    const runtime = new ProjectRuntime(root, { fileWatchers: watched });
    await runtime.load();
    assert.deepStrictEqual(runtime.indexer.getAllSelectors(), ["shop-card"]);

    const renamed = (await fs.readFile(componentPath, "utf8")).replace('"shop-card"', '"shop-basket"');
    await fs.writeFile(componentPath, renamed, "utf8");
    watched.dispatch([{ uri: pathToFileURL(componentPath).toString(), type: FileChangeType.Changed }]);
    await waitFor(() => runtime.indexer.getAllSelectors().includes("shop-basket"));

    assert.deepStrictEqual(runtime.indexer.getAllSelectors(), ["shop-basket"]);
  });

  it("advances its index generation only when the index changes", async () => {
    const root = path.join(sandbox, "apps", "shop");
    const componentPath = path.join(root, "src", "shop-card.component.ts");
    await writeProject(root);
    const watched = new WatchedFiles();
    const runtime = new ProjectRuntime(root, { fileWatchers: watched });
    await runtime.load();
    const afterLoad = runtime.indexGeneration;

    watched.dispatch([
      { uri: pathToFileURL(path.join(root, "src", "styles.css")).toString(), type: FileChangeType.Changed },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(runtime.indexGeneration, afterLoad, "An unwatched file must not invalidate anything");

    await writeComponent(root, "ShopCardComponent", "shop-card");
    watched.dispatch([{ uri: pathToFileURL(componentPath).toString(), type: FileChangeType.Created }]);
    await waitFor(() => runtime.indexGeneration > afterLoad);

    assert.ok(runtime.indexGeneration > afterLoad);
  });

  it("drops the index and the parsed configuration when disposed", async () => {
    const root = path.join(sandbox, "apps", "shop");
    await writeProject(root, { "@shop/*": ["src/*"] });
    await writeComponent(root, "ShopCardComponent", "shop-card");
    const runtime = new ProjectRuntime(root);
    await runtime.load();
    assert.deepStrictEqual(runtime.indexer.getAllSelectors(), ["shop-card"]);

    runtime.dispose();

    assert.strictEqual(runtime.tsConfig, null);
    assert.deepStrictEqual(runtime.indexer.getAllSelectors(), []);
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

  it("creates one runtime when two documents of the same root arrive at once", async () => {
    const root = path.join(sandbox, "apps", "shop");
    await writeProject(root);
    let creations = 0;
    const host = new ProjectRuntimeHost({
      createRuntime: (rootPath: string) => {
        creations += 1;
        return new ProjectRuntime(rootPath);
      },
    });

    await Promise.all([host.create(root), host.create(root), host.create(root)]);

    assert.strictEqual(creations, 1, "Concurrent opens must not build a second index for one root");
    assert.deepStrictEqual(host.roots(), [root]);
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
