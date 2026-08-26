/**
 * The situations a protocol boundary makes newly possible to get wrong.
 *
 * These are not language-feature tests — those live beside their handlers. They cover
 * the things that only break once a client and a server have to agree: which project a
 * URI belongs to when projects nest, whether a URI survives the round trip on a
 * platform that writes paths differently, and whether a dependency appearing on disk
 * ever reaches an index that lives in another process.
 * @module
 */

import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DidChangeWatchedFilesNotification,
  DocumentDiagnosticRequest,
  FileChangeType,
} from "vscode-languageserver-protocol";
import { fileUriToPath } from "../../core/document";
import { PerformanceMetricsRequest } from "../../lsp/protocol";
import { type Harness, startHarness } from "./harness/lsp-harness";

function component(name: string, selector: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    `@Component({ selector: "${selector}", standalone: true, template: "" })`,
    `export class ${name} {}`,
    "",
  ].join("\n");
}

function host(templateName: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-host",',
    "  standalone: true,",
    `  templateUrl: "./${templateName}",`,
    "  imports: [],",
    "})",
    "export class HostComponent {}",
    "",
  ].join("\n");
}

/** Writes a directory that discovery will recognize as an Angular project. */
async function writeProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: path.basename(root), dependencies: { "@angular/core": "^19.0.0" } }),
    "utf8"
  );
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }), "utf8");
}

/** The codes a document's report carries. */
async function diagnosticCodes(harness: Harness, filePath: string): Promise<string[]> {
  const report = (await harness.client.sendRequest(DocumentDiagnosticRequest.type, {
    textDocument: { uri: harness.uri(filePath) },
  })) as { items: Array<{ code?: unknown }> };
  return report.items.map((item) => String(item.code));
}

describe("LSP protocol regressions", function () {
  this.timeout(60000);

  let sandbox: string;
  let harness: Harness | undefined;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-regressions-"));
  });

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  describe("nested and sibling projects", () => {
    it("answers a nested project's document from the nested index, not the one containing it", async () => {
      const outer = path.join(sandbox, "workspace");
      const inner = path.join(outer, "packages", "ui");
      await writeProject(outer);
      await writeProject(inner);
      await fs.writeFile(
        path.join(outer, "src", "outer.component.ts"),
        component("OuterComponent", "app-outer"),
        "utf8"
      );
      await fs.writeFile(
        path.join(inner, "src", "inner.component.ts"),
        component("InnerComponent", "app-inner"),
        "utf8"
      );

      const templatePath = path.join(inner, "src", "host.component.html");
      await fs.writeFile(path.join(inner, "src", "host.component.ts"), host("host.component.html"), "utf8");
      await fs.writeFile(templatePath, "", "utf8");

      harness = await startHarness({ workspaceRoots: [outer] });
      await harness.waitForProjects();
      // The nested project is discovered from a document inside it, not from the folder
      // above it, so it only exists once the client opens one.
      await harness.open(templatePath, "<app-inner></app-inner><app-outer></app-outer>", "html");
      await harness.waitForProjects(2);

      assert.deepStrictEqual(
        await diagnosticCodes(harness, templatePath),
        ["missing-component-import:app-inner"],
        "The nested project must not see the elements of the one it sits inside"
      );
    });

    it("keeps a nested project's elements out of the index of the project containing it", async () => {
      const outer = path.join(sandbox, "workspace");
      const inner = path.join(outer, "packages", "ui");
      await writeProject(outer);
      await writeProject(inner);
      await fs.writeFile(
        path.join(outer, "src", "outer.component.ts"),
        component("OuterComponent", "app-outer"),
        "utf8"
      );
      await fs.writeFile(
        path.join(inner, "src", "inner.component.ts"),
        component("InnerComponent", "app-inner"),
        "utf8"
      );

      const templatePath = path.join(outer, "src", "host.component.html");
      await fs.writeFile(path.join(outer, "src", "host.component.ts"), host("host.component.html"), "utf8");
      await fs.writeFile(templatePath, "", "utf8");

      harness = await startHarness({ workspaceRoots: [outer] });
      // Only the outer project exists here: the nested one is discovered from a document
      // inside it, and none has opened. Its directory must stop the outer scan anyway,
      // or the fix would only hold for whichever project happened to be found first.
      await harness.waitForProjects();
      await harness.open(templatePath, "<app-inner></app-inner><app-outer></app-outer>", "html");

      assert.deepStrictEqual(
        await diagnosticCodes(harness, templatePath),
        ["missing-component-import:app-outer"],
        "A project must not offer an element belonging to a package nested inside it"
      );
    });

    it("keeps a nested project's elements out when a watcher reports them", async () => {
      const outer = path.join(sandbox, "workspace");
      const inner = path.join(outer, "packages", "ui");
      await writeProject(outer);
      await writeProject(inner);
      await fs.writeFile(
        path.join(outer, "src", "outer.component.ts"),
        component("OuterComponent", "app-outer"),
        "utf8"
      );

      const templatePath = path.join(outer, "src", "host.component.html");
      await fs.writeFile(path.join(outer, "src", "host.component.ts"), host("host.component.html"), "utf8");
      await fs.writeFile(templatePath, "", "utf8");

      harness = await startHarness({ workspaceRoots: [outer] });
      await harness.waitForProjects();
      await harness.open(templatePath, "<app-inner></app-inner>", "html");
      const before = await indexSize(harness);

      // The outer project's watcher covers its whole root, so a file written inside the
      // nested package reaches it. The scan boundary has to hold here too, or the index
      // is polluted again one edit at a time.
      const innerPath = path.join(inner, "src", "inner.component.ts");
      await fs.writeFile(innerPath, component("InnerComponent", "app-inner"), "utf8");
      await harness.client.sendNotification(DidChangeWatchedFilesNotification.type, {
        changes: [{ uri: harness.uri(innerPath), type: FileChangeType.Created }],
      });

      await assertStaysTrue(async () => (await indexSize(harness as Harness)) === before);
      assert.deepStrictEqual(
        await diagnosticCodes(harness, templatePath),
        [],
        "A watched file inside a nested package must not enter the containing project's index"
      );
    });

    it("keeps sibling projects' indexes apart", async () => {
      const shop = path.join(sandbox, "apps", "shop");
      const admin = path.join(sandbox, "apps", "admin");
      await writeProject(shop);
      await writeProject(admin);
      await fs.writeFile(path.join(shop, "src", "card.component.ts"), component("ShopCard", "shop-card"), "utf8");
      await fs.writeFile(path.join(admin, "src", "panel.component.ts"), component("AdminPanel", "admin-panel"), "utf8");

      const templatePath = path.join(shop, "src", "host.component.html");
      await fs.writeFile(path.join(shop, "src", "host.component.ts"), host("host.component.html"), "utf8");
      await fs.writeFile(templatePath, "", "utf8");

      harness = await startHarness({ workspaceRoots: [shop, admin] });
      await harness.waitForProjects(2);
      await harness.open(templatePath, "<shop-card></shop-card><admin-panel></admin-panel>", "html");

      assert.deepStrictEqual(
        await diagnosticCodes(harness, templatePath),
        ["missing-component-import:shop-card"],
        "A sibling's elements are not this project's to offer"
      );
    });
  });

  describe("URI handling", () => {
    it("answers for the exact URI the client sent, and round-trips it unchanged", async () => {
      const root = path.join(sandbox, "shop");
      await writeProject(root);
      await fs.writeFile(path.join(root, "src", "card.component.ts"), component("ShopCard", "shop-card"), "utf8");
      const templatePath = path.join(root, "src", "host.component.html");
      await fs.writeFile(path.join(root, "src", "host.component.ts"), host("host.component.html"), "utf8");
      await fs.writeFile(templatePath, "", "utf8");

      harness = await startHarness({ workspaceRoots: [root] });
      await harness.waitForProjects();
      await harness.open(templatePath, "<shop-card></shop-card>", "html");

      const links = (await harness.client.sendRequest("textDocument/definition", {
        textDocument: { uri: harness.uri(templatePath) },
        position: { line: 0, character: 5 },
      })) as Array<{ targetUri: string }>;

      const target = links[0].targetUri;
      assert.strictEqual(fileUriToPath(target), path.join(root, "src", "card.component.ts"));
      assert.strictEqual(
        target,
        pathToFileURL(fileUriToPath(target)).toString(),
        "A URI must survive its own round trip"
      );
    });

    it("answers nothing for a URI that is not a file, rather than failing the request", async () => {
      const root = path.join(sandbox, "shop");
      await writeProject(root);
      await fs.writeFile(path.join(root, "src", "card.component.ts"), component("ShopCard", "shop-card"), "utf8");

      harness = await startHarness({ workspaceRoots: [root] });
      await harness.waitForProjects();
      await harness.client.sendNotification("textDocument/didOpen", {
        textDocument: { uri: "untitled:Untitled-1", languageId: "html", version: 1, text: "<shop-card>" },
      });

      const report = (await harness.client.sendRequest(DocumentDiagnosticRequest.type, {
        textDocument: { uri: "untitled:Untitled-1" },
      })) as { items: unknown[] };

      assert.deepStrictEqual(report.items, []);
    });
  });

  describe("changes on disk", () => {
    it("indexes a component created after the project was scanned", async () => {
      const root = path.join(sandbox, "shop");
      await writeProject(root);
      await fs.writeFile(path.join(root, "src", "card.component.ts"), component("ShopCard", "shop-card"), "utf8");
      const templatePath = path.join(root, "src", "host.component.html");
      await fs.writeFile(path.join(root, "src", "host.component.ts"), host("host.component.html"), "utf8");
      await fs.writeFile(templatePath, "", "utf8");

      harness = await startHarness({ workspaceRoots: [root] });
      await harness.waitForProjects();
      await harness.open(templatePath, "<shop-badge></shop-badge>", "html");
      assert.deepStrictEqual(await diagnosticCodes(harness, templatePath), [], "Nothing knows this element yet");

      const badgePath = path.join(root, "src", "badge.component.ts");
      await fs.writeFile(badgePath, component("ShopBadge", "shop-badge"), "utf8");
      await harness.client.sendNotification(DidChangeWatchedFilesNotification.type, {
        changes: [{ uri: harness.uri(badgePath), type: FileChangeType.Created }],
      });
      await waitFor(async () => (await indexSize(harness as Harness)) > 2);

      assert.deepStrictEqual(await diagnosticCodes(harness, templatePath), ["missing-component-import:shop-badge"]);
    });

    it("forgets a component deleted after the project was scanned", async () => {
      const root = path.join(sandbox, "shop");
      await writeProject(root);
      const cardPath = path.join(root, "src", "card.component.ts");
      await fs.writeFile(cardPath, component("ShopCard", "shop-card"), "utf8");
      const templatePath = path.join(root, "src", "host.component.html");
      await fs.writeFile(path.join(root, "src", "host.component.ts"), host("host.component.html"), "utf8");
      await fs.writeFile(templatePath, "", "utf8");

      harness = await startHarness({ workspaceRoots: [root] });
      await harness.waitForProjects();
      await harness.open(templatePath, "<shop-card></shop-card>", "html");
      assert.strictEqual((await diagnosticCodes(harness, templatePath)).length, 1);

      await fs.rm(cardPath);
      await harness.client.sendNotification(DidChangeWatchedFilesNotification.type, {
        changes: [{ uri: harness.uri(cardPath), type: FileChangeType.Deleted }],
      });
      await waitFor(async () => (await indexSize(harness as Harness)) < 2);

      assert.deepStrictEqual(
        await diagnosticCodes(harness, templatePath),
        [],
        "An element whose file is gone cannot be missing an import"
      );
    });
  });
});

/** How many selectors the first project has indexed. */
async function indexSize(harness: Harness): Promise<number> {
  const metrics = await harness.client.sendRequest(PerformanceMetricsRequest);
  return metrics.projects[0]?.elementCount ?? 0;
}

/**
 * Holds a condition that must stay true, for long enough that work the server started
 * would have landed. Asserting an absence needs the wait a `waitFor` does not give.
 */
async function assertStaysTrue(condition: () => Promise<boolean>, forMs = 1500): Promise<void> {
  const deadline = Date.now() + forMs;
  while (Date.now() < deadline) {
    assert.ok(await condition(), "A condition that had to hold stopped holding");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Waits for work the server started from a watched change to settle. */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the index to catch up with a reported change");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
