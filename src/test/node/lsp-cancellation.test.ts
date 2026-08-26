import * as assert from "node:assert";
import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CodeActionKind, DocumentDiagnosticReportKind, type Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toDocumentView } from "../../adapters/lsp/document";
import { type AngularCompilerApi, adoptAngularCompiler } from "../../core/angular-compiler";
import { type CancellationSource, createCancellationSource } from "../../core/cancellation";
import type { DocumentView } from "../../core/document";
import { DEFAULT_EXTENSION_CONFIG, type ExtensionConfig } from "../../core/settings";
import { CodeActionHandler } from "../../lsp/code-actions";
import { CompletionHandler } from "../../lsp/completion";
import { DefinitionHandler } from "../../lsp/definition";
import { DiagnosticsHandler } from "../../lsp/diagnostics";
import { ImportEditPlanner } from "../../lsp/import-edit";
import { OpenDocuments } from "../../lsp/open-documents";
import { ProjectRouter } from "../../lsp/project-router";
import { ProjectRuntime } from "../../lsp/project-runtime";
import { FIX_ALL_KIND } from "../../lsp/protocol";

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

/** The planner a completion resolves its import through. */
function plannerFor(router: ProjectRouter, documents: OpenDocuments): ImportEditPlanner {
  return new ImportEditPlanner({ router, documents, readFile: (file) => readFileSync(file, "utf-8") });
}

function documentAt(filePath: string, text: string, languageId: string): DocumentView {
  return toDocumentView(TextDocument.create(pathToFileURL(filePath).toString(), languageId, 1, text));
}

const WHOLE_DOCUMENT: Range = { start: { line: 0, character: 0 }, end: { line: 99, character: 0 } };

function component(name: string, selector: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    `@Component({ selector: "${selector}", standalone: true, template: "" })`,
    `export class ${name} {}`,
    "",
  ].join("\n");
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

describe("LSP request cancellation", function () {
  this.timeout(15000);

  let compiler: AngularCompilerApi;
  let sandbox: string;
  let root: string;
  let runtime: ProjectRuntime;
  let config: ExtensionConfig;
  let templatePath: string;
  let cancellation: CancellationSource;

  let completions: CompletionHandler;
  let diagnostics: DiagnosticsHandler;
  let codeActions: CodeActionHandler;
  let definitions: DefinitionHandler;

  before(async () => {
    compiler = adoptAngularCompiler(await import("@angular/compiler"));
  });

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-cancellation-"));
    root = path.join(sandbox, "apps", "shop");
    config = structuredClone(DEFAULT_EXTENSION_CONFIG);
    cancellation = createCancellationSource();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }), "utf8");
    await fs.writeFile(
      path.join(root, "src", "shop-card.component.ts"),
      component("ShopCardComponent", "shop-card"),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "src", "shop-badge.component.ts"),
      component("ShopBadgeComponent", "shop-badge"),
      "utf8"
    );
    await fs.writeFile(path.join(root, "src", "host.component.ts"), HOST, "utf8");
    templatePath = path.join(root, "src", "host.component.html");
    await fs.writeFile(templatePath, "", "utf8");
    runtime = new ProjectRuntime(root);
    await runtime.load();

    const documents = noOpenDocuments();
    const router = new ProjectRouter({
      rootForPath: (filePath) => (filePath.startsWith(root) ? root : undefined),
      runtimeForRoot: (rootPath) => (rootPath === root ? runtime : undefined),
    });
    completions = new CompletionHandler({
      router,
      documents,
      config: () => config,
      planner: plannerFor(router, documents),
    });
    diagnostics = new DiagnosticsHandler({ router, documents, config: () => config, compiler: () => compiler });
    codeActions = new CodeActionHandler({
      router,
      diagnostics,
      planner: plannerFor(router, documents),
      resolvesActions: () => true,
    });
    definitions = new DefinitionHandler({ router, diagnostics });
  });

  afterEach(async () => {
    runtime.dispose();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("abandons a cancelled completion request", () => {
    const document = documentAt(templatePath, "<shop-c", "html");
    cancellation.cancel();

    const list = completions.provide(document, { line: 0, character: 7 }, cancellation.signal);

    assert.deepStrictEqual(list.items, []);
  });

  it("abandons a cancelled diagnostic request", () => {
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");
    cancellation.cancel();

    const report = diagnostics.provide(document, cancellation.signal);

    assert.strictEqual(report.kind, DocumentDiagnosticReportKind.Full);
    assert.deepStrictEqual("items" in report ? report.items : undefined, []);
  });

  it("keeps no partial result from a cancelled diagnostic request", () => {
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");
    cancellation.cancel();

    diagnostics.provide(document, cancellation.signal);

    assert.strictEqual(
      diagnostics.resultFor(document.uri),
      undefined,
      "A partial result would leave code actions offering a subset of the fixes"
    );
  });

  it("abandons a cancelled code-action request", async () => {
    const document = documentAt(templatePath, "<shop-card></shop-card><shop-badge></shop-badge>", "html");
    cancellation.cancel();

    const offered = await codeActions.provide(document, WHOLE_DOCUMENT, undefined, cancellation.signal);

    assert.deepStrictEqual(offered, []);
  });

  it("does not offer a fix-all that would import less than its title promises", async () => {
    const document = documentAt(templatePath, "<shop-card></shop-card><shop-badge></shop-badge>", "html");
    cancellation.cancel();

    const offered = await codeActions.provide(document, WHOLE_DOCUMENT, [FIX_ALL_KIND], cancellation.signal);

    assert.deepStrictEqual(offered, []);
  });

  it("abandons a cancelled definition request", () => {
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");
    cancellation.cancel();

    assert.deepStrictEqual(definitions.provide(document, { line: 0, character: 5 }, cancellation.signal), []);
  });

  it("answers normally while the request is still wanted", async () => {
    const document = documentAt(templatePath, "<shop-card></shop-card><shop-badge></shop-badge>", "html");

    const report = diagnostics.provide(document, cancellation.signal);
    const offered = await codeActions.provide(document, WHOLE_DOCUMENT, [CodeActionKind.QuickFix], cancellation.signal);

    assert.strictEqual("items" in report ? report.items.length : 0, 2);
    assert.strictEqual(offered.length, 2);
  });
});
