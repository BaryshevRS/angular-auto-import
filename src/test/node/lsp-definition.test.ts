import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Position } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toDocumentView } from "../../adapters/lsp/document";
import { type AngularCompilerApi, adoptAngularCompiler } from "../../core/angular-compiler";
import type { DocumentView } from "../../core/document";
import { DEFAULT_EXTENSION_CONFIG, type ExtensionConfig } from "../../core/settings";
import { DefinitionHandler } from "../../lsp/definition";
import { DiagnosticsHandler } from "../../lsp/diagnostics";
import { OpenDocuments } from "../../lsp/open-documents";
import { ProjectRouter } from "../../lsp/project-router";
import { ProjectRuntime } from "../../lsp/project-runtime";

function noOpenDocuments(): OpenDocuments {
  const open = new OpenDocuments({
    get: () => undefined,
    all: () => [],
    onDidOpen: () => undefined,
    onDidSave: () => undefined,
    onDidClose: () => undefined,
  });
  open.listen();
  return open;
}

function documentAt(filePath: string, text: string, languageId: string): DocumentView {
  return toDocumentView(TextDocument.create(pathToFileURL(filePath).toString(), languageId, 1, text));
}

/** The position just past the last occurrence of a marker. */
function positionAfter(document: DocumentView, marker: string): Position {
  return document.positionAt(document.getText().lastIndexOf(marker) + marker.length);
}

const HOST = [
  'import { Component } from "@angular/core";',
  "",
  "@Component({",
  '  selector: "app-host",',
  "  standalone: true,",
  '  templateUrl: "./host.component.html",',
  "  imports: [],",
  "})",
  "export class HostComponent {}",
  "",
].join("\n");

const CARD = [
  'import { Component } from "@angular/core";',
  "",
  '@Component({ selector: "shop-card", standalone: true, template: "" })',
  "export class ShopCardComponent {}",
  "",
].join("\n");

describe("LSP definition", function () {
  this.timeout(15000);

  let compiler: AngularCompilerApi;
  let sandbox: string;
  let root: string;
  let runtime: ProjectRuntime;
  let config: ExtensionConfig;
  let templatePath: string;
  let cardPath: string;

  before(async () => {
    compiler = adoptAngularCompiler(await import("@angular/compiler"));
  });

  function handlerFor(): DefinitionHandler {
    const documents = noOpenDocuments();
    const router = new ProjectRouter({
      rootForPath: (filePath) => (filePath.startsWith(root) ? root : undefined),
      runtimeForRoot: (rootPath) => (rootPath === root ? runtime : undefined),
    });
    const diagnostics = new DiagnosticsHandler({
      router,
      documents,
      config: () => config,
      compiler: () => compiler,
    });
    return new DefinitionHandler({ router, diagnostics });
  }

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-definition-"));
    root = path.join(sandbox, "apps", "shop");
    config = structuredClone(DEFAULT_EXTENSION_CONFIG);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }), "utf8");
    cardPath = path.join(root, "src", "shop-card.component.ts");
    await fs.writeFile(cardPath, CARD, "utf8");
    await fs.writeFile(path.join(root, "src", "host.component.ts"), HOST, "utf8");
    templatePath = path.join(root, "src", "host.component.html");
    await fs.writeFile(templatePath, "", "utf8");
    runtime = new ProjectRuntime(root);
    await runtime.load();
  });

  afterEach(async () => {
    runtime.dispose();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("resolves an unimported element to the file that declares it", () => {
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const links = handlerFor().provide(document, positionAfter(document, "<shop-c"));

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].targetUri, pathToFileURL(cardPath).toString());
  });

  it("points at the class name rather than the top of the file", () => {
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const [link] = handlerFor().provide(document, positionAfter(document, "<shop-c"));

    const nameLine = CARD.split("\n")[link.targetRange.start.line];
    assert.strictEqual(
      nameLine.slice(link.targetRange.start.character, link.targetRange.end.character),
      "ShopCardComponent"
    );
  });

  it("highlights the template range the request came from", () => {
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const [link] = handlerFor().provide(document, positionAfter(document, "<shop-c"));

    assert.deepStrictEqual(link.originSelectionRange, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 11 },
    });
  });

  it("resolves an element used in an inline template", async () => {
    const text = [
      'import { Component } from "@angular/core";',
      '@Component({ standalone: true, template: "<shop-card></shop-card>" })',
      "export class InlineComponent {}",
      "",
    ].join("\n");
    const inlinePath = path.join(root, "src", "inline.component.ts");
    await fs.writeFile(inlinePath, text, "utf8");
    const document = documentAt(inlinePath, text, "typescript");

    const links = handlerFor().provide(document, positionAfter(document, "<shop-c"));

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].targetUri, pathToFileURL(cardPath).toString());
  });

  it("leaves an already-imported element to the Angular Language Service", async () => {
    await fs.writeFile(
      path.join(root, "src", "host.component.ts"),
      HOST.replace("imports: []", "imports: [ShopCardComponent]").replace(
        'import { Component } from "@angular/core";',
        'import { Component } from "@angular/core";\nimport { ShopCardComponent } from "./shop-card.component";'
      ),
      "utf8"
    );
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    assert.deepStrictEqual(handlerFor().provide(document, positionAfter(document, "<shop-c")), []);
  });

  it("answers nothing away from the element", () => {
    const document = documentAt(templatePath, "<shop-card></shop-card>\n<div></div>", "html");

    assert.deepStrictEqual(handlerFor().provide(document, { line: 1, character: 2 }), []);
  });

  it("answers nothing for a document no discovered project owns", () => {
    const document = documentAt(path.join(sandbox, "elsewhere", "page.html"), "<shop-card></shop-card>", "html");

    assert.deepStrictEqual(handlerFor().provide(document, positionAfter(document, "<shop-c")), []);
  });

  it("answers nothing when the declaring file is gone", async () => {
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");
    const before = handlerFor().provide(document, positionAfter(document, "<shop-c"));
    assert.strictEqual(before.length, 1);

    await fs.rm(cardPath);

    assert.deepStrictEqual(handlerFor().provide(document, positionAfter(document, "<shop-c")), []);
  });

  it("returns every declaration answering to the same selector", async () => {
    await fs.writeFile(
      path.join(root, "src", "shop-card.directive.ts"),
      [
        'import { Directive } from "@angular/core";',
        "",
        '@Directive({ selector: "shop-card", standalone: true })',
        "export class ShopCardDirective {}",
        "",
      ].join("\n"),
      "utf8"
    );
    runtime.dispose();
    runtime = new ProjectRuntime(root);
    await runtime.load();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const links = handlerFor().provide(document, positionAfter(document, "<shop-c"));

    assert.deepStrictEqual(
      new Set(links.map((link) => path.basename(new URL(link.targetUri).pathname))),
      new Set(["shop-card.component.ts", "shop-card.directive.ts"])
    );
  });
});
