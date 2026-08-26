import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { DiagnosticSeverity, DocumentDiagnosticReportKind } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toDocumentView } from "../../adapters/lsp/document";
import { type AngularCompilerApi, adoptAngularCompiler } from "../../core/angular-compiler";
import type { DocumentView } from "../../core/document";
import { DEFAULT_EXTENSION_CONFIG, type ExtensionConfig } from "../../core/settings";
import { DiagnosticsHandler } from "../../lsp/diagnostics";
import { OpenDocuments, type SynchronizedDocument } from "../../lsp/open-documents";
import { ProjectRouter } from "../../lsp/project-router";
import { ProjectRuntime } from "../../lsp/project-runtime";

/** Presents whatever documents a test declares as synchronized. */
function documentSource(documents: SynchronizedDocument[] = []): OpenDocuments {
  const open = new OpenDocuments({
    get: (uri) => documents.find((document) => document.uri === uri),
    all: () => documents,
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

/** The items a full report carries; asserts the report was a full one. */
function itemsOf(report: { kind: string; items?: unknown[] }): Array<{ code?: unknown; severity?: number }> {
  assert.strictEqual(report.kind, DocumentDiagnosticReportKind.Full);
  return (report.items ?? []) as Array<{ code?: unknown; severity?: number }>;
}

const ACCESS_PIPE = [
  'import { Pipe, PipeTransform } from "@angular/core";',
  "",
  '@Pipe({ name: "access", standalone: true })',
  "export class AccessPipe implements PipeTransform { transform(value: unknown) { return value; } }",
  "",
].join("\n");

const CARD_COMPONENT = [
  'import { Component } from "@angular/core";',
  "",
  '@Component({ selector: "shop-card", standalone: true, template: "" })',
  "export class ShopCardComponent {}",
  "",
].join("\n");

/** A host component with an external template, importing whatever it is given. */
function hostComponent(options: { standalone?: boolean; imports?: string } = {}): string {
  return [
    'import { Component } from "@angular/core";',
    options.imports ?? "",
    "@Component({",
    '  selector: "app-host",',
    `  standalone: ${options.standalone ?? true},`,
    '  templateUrl: "./host.component.html",',
    `  imports: [${options.imports ? "ShopCardComponent" : ""}],`,
    "})",
    "export class HostComponent {}",
    "",
  ].join("\n");
}

describe("LSP diagnostics", function () {
  this.timeout(15000);

  let compiler: AngularCompilerApi;
  let sandbox: string;
  let root: string;
  let runtime: ProjectRuntime;
  let config: ExtensionConfig;
  let templatePath: string;
  let hostPath: string;

  before(async () => {
    compiler = adoptAngularCompiler(await import("@angular/compiler"));
  });

  function handlerFor(documents = documentSource(), withCompiler = true): DiagnosticsHandler {
    const router = new ProjectRouter({
      rootForPath: (filePath) => (filePath.startsWith(root) ? root : undefined),
      runtimeForRoot: (rootPath) => (rootPath === root ? runtime : undefined),
    });
    return new DiagnosticsHandler({
      router,
      documents,
      config: () => config,
      compiler: () => (withCompiler ? compiler : undefined),
    });
  }

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-diagnostics-"));
    root = path.join(sandbox, "apps", "shop");
    config = structuredClone(DEFAULT_EXTENSION_CONFIG);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }), "utf8");
    await fs.writeFile(path.join(root, "src", "shop-card.component.ts"), CARD_COMPONENT, "utf8");
    await fs.writeFile(path.join(root, "src", "access.pipe.ts"), ACCESS_PIPE, "utf8");
    hostPath = path.join(root, "src", "host.component.ts");
    templatePath = path.join(root, "src", "host.component.html");
    await fs.writeFile(hostPath, hostComponent(), "utf8");
    await fs.writeFile(templatePath, "", "utf8");
    runtime = new ProjectRuntime(root);
    await runtime.load();
  });

  afterEach(async () => {
    runtime.dispose();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("reports an element the external template uses but the component does not import", () => {
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const items = itemsOf(handlerFor().provide(document));

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].code, "missing-component-import:shop-card");
  });

  it("reports an element for a deeply nested Angular 19 component with implicit standalone", async () => {
    const deepDirectory = path.join(
      root,
      "src",
      "app",
      "features",
      "calls",
      "presentation",
      "modules",
      "recording",
      "components",
      "recognition",
      "engine"
    );
    hostPath = path.join(deepDirectory, "host.component.ts");
    templatePath = path.join(deepDirectory, "host.component.html");
    await fs.mkdir(deepDirectory, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@angular/core": "^19.0.0" } }),
      "utf8"
    );
    await fs.writeFile(
      hostPath,
      [
        'import { Component } from "@angular/core";',
        "",
        "@Component({",
        '  selector: "app-host",',
        '  templateUrl: "./host.component.html",',
        "  imports: [],",
        "})",
        "export class HostComponent {}",
        "",
      ].join("\n"),
      "utf8"
    );
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const items = itemsOf(handlerFor().provide(document));

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].code, "missing-component-import:shop-card");
  });

  it("reports a pipe the template uses but the component does not import", () => {
    const document = documentAt(templatePath, "<div>{{ value | access }}</div>", "html");

    const items = itemsOf(handlerFor().provide(document));

    assert.deepStrictEqual(
      items.map((item) => String(item.code)),
      ["missing-pipe-import:access"]
    );
  });

  it("reports no pipe for a logical OR followed by a name a pipe happens to share", () => {
    // Two things had to coincide for this to be visible: an expression containing `||`,
    // and an identifier after it naming a pipe the project really declares. Reading the
    // parsed expression instead of its source text is what tells the two apart.
    const document = documentAt(templatePath, "@if (access().canEdit || access().canShare) {\n<div></div>\n}", "html");

    assert.deepStrictEqual(itemsOf(handlerFor().provide(document)), []);
  });

  it("reports no pipe for a bar inside a string literal", () => {
    const document = documentAt(templatePath, "<div [title]=\"'a|access'\"></div>", "html");

    assert.deepStrictEqual(itemsOf(handlerFor().provide(document)), []);
  });

  it("reports nothing once the component imports the element", async () => {
    await fs.writeFile(
      hostPath,
      hostComponent({ imports: 'import { ShopCardComponent } from "./shop-card.component";' }),
      "utf8"
    );
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    assert.deepStrictEqual(itemsOf(handlerFor().provide(document)), []);
  });

  it("reports an element used in an inline template", () => {
    const text = [
      'import { Component } from "@angular/core";',
      "",
      '@Component({ selector: "app-inline", standalone: true, template: "<shop-card></shop-card>" })',
      "export class InlineComponent {}",
      "",
    ].join("\n");
    const inlinePath = path.join(root, "src", "inline.component.ts");
    const document = documentAt(inlinePath, text, "typescript");

    const items = itemsOf(handlerFor(documentSource([asSynchronized(document)])).provide(document));

    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].code, "missing-component-import:shop-card");
  });

  it("locates the diagnostic inside the document, not inside the inline template", () => {
    const text = [
      'import { Component } from "@angular/core";',
      '@Component({ standalone: true, template: "<shop-card></shop-card>" })',
      "export class InlineComponent {}",
      "",
    ].join("\n");
    const document = documentAt(path.join(root, "src", "inline.component.ts"), text, "typescript");

    const [item] = itemsOf(handlerFor(documentSource([asSynchronized(document)])).provide(document)) as Array<{
      range: { start: { line: number; character: number } };
    }>;

    assert.strictEqual(item.range.start.line, 1, "The range must point at the decorator's line");
    assert.strictEqual(
      text.split("\n")[1].slice(item.range.start.character, item.range.start.character + 10),
      "<shop-card"
    );
  });

  it("carries the configured severity", () => {
    config.diagnosticsSeverity = "error";
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    assert.strictEqual(itemsOf(handlerFor().provide(document))[0].severity, DiagnosticSeverity.Error);
  });

  it("shows nothing in quickfix-only mode but keeps the candidates for the fix", () => {
    config.diagnosticsMode = "quickfix-only";
    const handler = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    assert.deepStrictEqual(itemsOf(handler.provide(document)), []);
    assert.strictEqual(handler.resultFor(document.uri)?.candidates.length, 1);
  });

  it("computes nothing at all when diagnostics are disabled", () => {
    config.diagnosticsMode = "disabled";
    const handler = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    assert.deepStrictEqual(itemsOf(handler.provide(document)), []);
    assert.strictEqual(handler.resultFor(document.uri), undefined);
  });

  it("tags a result with the document version and index generation it was computed against", () => {
    const handler = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    handler.provide(document);

    const result = handler.resultFor(document.uri);
    assert.strictEqual(result?.version, document.version);
    assert.strictEqual(result?.generation, runtime.indexGeneration);
  });

  it("reports nothing for a component that cannot hold imports of its own", async () => {
    await fs.writeFile(hostPath, hostComponent({ standalone: false }), "utf8");
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    assert.deepStrictEqual(itemsOf(handlerFor().provide(document)), []);
  });

  it("reports nothing for a template with no component beside it", () => {
    const document = documentAt(path.join(root, "src", "orphan.html"), "<shop-card></shop-card>", "html");

    assert.deepStrictEqual(itemsOf(handlerFor().provide(document)), []);
  });

  it("reports nothing for a document no discovered project owns", () => {
    const document = documentAt(path.join(sandbox, "elsewhere", "page.html"), "<shop-card></shop-card>", "html");

    assert.deepStrictEqual(itemsOf(handlerFor().provide(document)), []);
  });

  it("reports nothing until the Angular compiler has loaded", () => {
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const handler = handlerFor(documentSource(), false);

    assert.deepStrictEqual(itemsOf(handler.provide(document)), []);
    assert.strictEqual(handler.resultFor(document.uri), undefined);
  });

  it("analyzes the component's unsaved text rather than the file on disk", async () => {
    const unsaved = hostComponent({ imports: 'import { ShopCardComponent } from "./shop-card.component";' });
    const componentDocument = documentAt(hostPath, unsaved, "typescript");
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const items = itemsOf(handlerFor(documentSource([asSynchronized(componentDocument)])).provide(document));

    assert.deepStrictEqual(items, [], "An import the user has typed but not saved must already count");
  });

  it("forgets a closed document's result", () => {
    const handler = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");
    handler.provide(document);

    handler.forget(document.uri);

    assert.strictEqual(handler.resultFor(document.uri), undefined);
  });
});

/** Presents a document view as the synchronized document `OpenDocuments` tracks. */
function asSynchronized(document: DocumentView): SynchronizedDocument {
  return {
    uri: document.uri,
    languageId: document.languageId,
    version: document.version,
    getText: () => document.getText(),
  };
}
