import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toDocumentView } from "../../adapters/lsp/document";
import type { DocumentView } from "../../core/document";
import { DEFAULT_EXTENSION_CONFIG, type ExtensionConfig } from "../../core/settings";
import { CompletionHandler } from "../../lsp/completion";
import { APPLY_IMPORT_COMMAND, type ApplyImportArguments } from "../../lsp/import-command";
import { OpenDocuments, type SynchronizedDocument } from "../../lsp/open-documents";
import { ProjectRouter } from "../../lsp/project-router";
import { ProjectRuntime } from "../../lsp/project-runtime";

/** Nothing is open unless a test says so; the handler only needs the dirty answer. */
function noOpenDocuments(): OpenDocuments {
  return new OpenDocuments({
    get: () => undefined,
    all: () => [],
    onDidOpen: () => undefined,
    onDidSave: () => undefined,
    onDidClose: () => undefined,
  });
}

/** Presents one document as open and unsaved, which is the optimistic-completion case. */
function withDirtyDocument(uri: string, text: string): OpenDocuments {
  const opened: SynchronizedDocument = { uri, languageId: "typescript", version: 1, getText: () => text };
  const edited: SynchronizedDocument = { ...opened, version: 2 };
  const documents = new OpenDocuments({
    get: () => edited,
    all: () => [opened],
    onDidOpen: () => undefined,
    onDidSave: () => undefined,
    onDidClose: () => undefined,
  });
  documents.listen();
  return documents;
}

async function writeProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }), "utf8");
}

async function writeComponent(root: string, className: string, selector: string): Promise<void> {
  await fs.writeFile(
    path.join(root, "src", `${selector}.component.ts`),
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

/** Writes the host component whose template the completion requests are made in. */
async function writeHost(root: string, options: { standalone: boolean; external: boolean }): Promise<string> {
  const hostPath = path.join(root, "src", "host.component.ts");
  await fs.writeFile(
    hostPath,
    [
      'import { Component } from "@angular/core";',
      "",
      "@Component({",
      '  selector: "app-host",',
      `  standalone: ${options.standalone},`,
      options.external ? '  templateUrl: "./host.component.html",' : "  template: `<div></div>`,",
      "})",
      "export class HostComponent {}",
      "",
    ].join("\n"),
    "utf8"
  );
  if (options.external) {
    await fs.writeFile(path.join(root, "src", "host.component.html"), "", "utf8");
  }
  return hostPath;
}

/** Builds a document view over text the client would have synchronized. */
function documentAt(filePath: string, text: string, languageId: string): DocumentView {
  return toDocumentView(TextDocument.create(pathToFileURL(filePath).toString(), languageId, 1, text));
}

/** The position just past the last occurrence of a marker. */
function positionAfter(document: DocumentView, marker: string) {
  return document.positionAt(document.getText().lastIndexOf(marker) + marker.length);
}

describe("LSP completion", function () {
  this.timeout(15000);

  let sandbox: string;
  let root: string;
  let runtime: ProjectRuntime;
  let config: ExtensionConfig;

  async function handlerFor(documents = noOpenDocuments()): Promise<CompletionHandler> {
    const router = new ProjectRouter({
      rootForPath: (filePath) => (filePath.startsWith(root) ? root : undefined),
      runtimeForRoot: (rootPath) => (rootPath === root ? runtime : undefined),
    });
    return new CompletionHandler({ router, documents, config: () => config });
  }

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-completion-"));
    root = path.join(sandbox, "apps", "shop");
    config = structuredClone(DEFAULT_EXTENSION_CONFIG);
    await writeProject(root);
    await writeComponent(root, "ShopCardComponent", "shop-card");
    runtime = new ProjectRuntime(root);
  });

  afterEach(async () => {
    runtime.dispose();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("ranks the project's own components in an external template", async () => {
    const hostPath = await writeHost(root, { standalone: true, external: true });
    await runtime.load();
    const templatePath = path.join(root, "src", "host.component.html");
    const document = documentAt(templatePath, "<shop-c", "html");

    const list = (await handlerFor()).provide(document, positionAfter(document, "<shop-c"));

    assert.deepStrictEqual(
      list.items.map((item) => item.label),
      ["shop-card"]
    );
    assert.ok(list.isIncomplete, "Completion must stay incomplete so the next keystroke re-ranks");
    assert.ok(hostPath.endsWith("host.component.ts"));
  });

  it("sends the import command to the component, not to the external template", async () => {
    await writeHost(root, { standalone: true, external: true });
    await runtime.load();
    const templatePath = path.join(root, "src", "host.component.html");
    const document = documentAt(templatePath, "<shop-c", "html");

    const [item] = (await handlerFor()).provide(document, positionAfter(document, "<shop-c")).items;

    assert.strictEqual(item?.command?.command, APPLY_IMPORT_COMMAND);
    const [args] = item.command.arguments as [ApplyImportArguments];
    assert.strictEqual(args.uri, pathToFileURL(path.join(root, "src", "host.component.ts")).toString());
    assert.strictEqual(args.elements[0]?.name, "ShopCardComponent");
  });

  it("replaces the token the user was typing instead of inserting beside it", async () => {
    await writeHost(root, { standalone: true, external: true });
    await runtime.load();
    const document = documentAt(path.join(root, "src", "host.component.html"), "<shop-c", "html");

    const [item] = (await handlerFor()).provide(document, positionAfter(document, "<shop-c")).items;

    assert.deepStrictEqual(item?.textEdit, {
      range: { start: { line: 0, character: 1 }, end: { line: 0, character: 7 } },
      newText: "shop-card",
    });
  });

  it("completes an inline template and imports into the same document", async () => {
    const hostPath = path.join(root, "src", "host.component.ts");
    const text = [
      'import { Component } from "@angular/core";',
      "",
      "@Component({",
      '  selector: "app-host",',
      "  standalone: true,",
      "  template: `<shop-c`,",
      "})",
      "export class HostComponent {}",
      "",
    ].join("\n");
    await fs.writeFile(hostPath, text, "utf8");
    await runtime.load();
    const document = documentAt(hostPath, text, "typescript");

    const [item] = (await handlerFor()).provide(document, positionAfter(document, "<shop-c")).items;

    assert.strictEqual(item?.label, "shop-card");
    const [args] = item.command?.arguments as [ApplyImportArguments];
    assert.strictEqual(args.uri, document.uri);
  });

  it("stays silent outside an inline template", async () => {
    const hostPath = await writeHost(root, { standalone: true, external: false });
    await runtime.load();
    const text = await fs.readFile(hostPath, "utf8");
    const document = documentAt(hostPath, text, "typescript");

    const list = (await handlerFor()).provide(document, positionAfter(document, "export class "));

    assert.deepStrictEqual(list.items, []);
  });

  it("stays silent for a document no discovered project owns", async () => {
    await runtime.load();
    const document = documentAt(path.join(sandbox, "elsewhere", "page.html"), "<shop-c", "html");

    const list = (await handlerFor()).provide(document, positionAfter(document, "<shop-c"));

    assert.deepStrictEqual(list.items, []);
  });

  it("stays silent for a component that cannot hold imports of its own", async () => {
    await writeHost(root, { standalone: false, external: true });
    await runtime.load();
    const document = documentAt(path.join(root, "src", "host.component.html"), "<shop-c", "html");

    const list = (await handlerFor()).provide(document, positionAfter(document, "<shop-c"));

    assert.deepStrictEqual(list.items, []);
  });

  it("still completes for a non-standalone component whose unsaved text may already fix it", async () => {
    const hostPath = await writeHost(root, { standalone: false, external: true });
    await runtime.load();
    const document = documentAt(path.join(root, "src", "host.component.html"), "<shop-c", "html");
    const documents = withDirtyDocument(pathToFileURL(hostPath).toString(), "standalone: true");

    const list = (await handlerFor(documents)).provide(document, positionAfter(document, "<shop-c"));

    assert.deepStrictEqual(
      list.items.map((item) => item.label),
      ["shop-card"]
    );
  });

  it("honors the setting that turns component completion off", async () => {
    await writeHost(root, { standalone: true, external: true });
    await runtime.load();
    config.completion.components = false;
    const document = documentAt(path.join(root, "src", "host.component.html"), "<shop-c", "html");

    const list = (await handlerFor()).provide(document, positionAfter(document, "<shop-c"));

    assert.deepStrictEqual(list.items, []);
  });

  it("re-reads a component after it is saved", async () => {
    const hostPath = await writeHost(root, { standalone: false, external: true });
    await runtime.load();
    const handler = await handlerFor();
    const document = documentAt(path.join(root, "src", "host.component.html"), "<shop-c", "html");
    assert.deepStrictEqual(handler.provide(document, positionAfter(document, "<shop-c")).items, []);

    await writeHost(root, { standalone: true, external: true });
    runtime.indexer.project.getSourceFile(hostPath)?.refreshFromFileSystemSync();
    handler.invalidate(hostPath);

    assert.deepStrictEqual(
      handler.provide(document, positionAfter(document, "<shop-c")).items.map((item) => item.label),
      ["shop-card"]
    );
  });
});
