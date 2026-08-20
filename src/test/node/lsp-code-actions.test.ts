import * as assert from "node:assert";
import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type CodeAction, CodeActionKind, type Range } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toDocumentView } from "../../adapters/lsp/document";
import { type AngularCompilerApi, adoptAngularCompiler } from "../../core/angular-compiler";
import type { DocumentView } from "../../core/document";
import { DEFAULT_EXTENSION_CONFIG, type ExtensionConfig } from "../../core/settings";
import { type CodeActionData, CodeActionHandler, FIX_ALL_KIND } from "../../lsp/code-actions";
import { DiagnosticsHandler } from "../../lsp/diagnostics";
import { APPLY_IMPORT_COMMAND } from "../../lsp/import-command";
import { ImportEditPlanner } from "../../lsp/import-edit";
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

/** The whole document, which is what a "fix everything here" request looks like. */
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

describe("LSP code actions", function () {
  this.timeout(15000);

  let compiler: AngularCompilerApi;
  let sandbox: string;
  let root: string;
  let runtime: ProjectRuntime;
  let config: ExtensionConfig;
  let templatePath: string;
  let hostPath: string;
  let resolvesActions: boolean;

  before(async () => {
    compiler = adoptAngularCompiler(await import("@angular/compiler"));
  });

  function handlerFor(): { actions: CodeActionHandler; diagnostics: DiagnosticsHandler } {
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
    const actions = new CodeActionHandler({
      router,
      diagnostics,
      planner: new ImportEditPlanner({ router, documents, readFile: (file) => readFileSync(file, "utf-8") }),
      resolvesActions: () => resolvesActions,
    });
    return { actions, diagnostics };
  }

  /** The text the action's edit would produce. */
  function editedText(action: CodeAction): string {
    const change = action.edit?.documentChanges?.[0];
    assert.ok(change && "edits" in change, `Expected ${action.title} to carry a document edit`);
    const [edit] = change.edits as Array<{ newText: string }>;
    return edit.newText;
  }

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-code-actions-"));
    root = path.join(sandbox, "apps", "shop");
    config = structuredClone(DEFAULT_EXTENSION_CONFIG);
    resolvesActions = true;
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
    hostPath = path.join(root, "src", "host.component.ts");
    templatePath = path.join(root, "src", "host.component.html");
    await fs.writeFile(hostPath, HOST, "utf8");
    await fs.writeFile(templatePath, "", "utf8");
    runtime = new ProjectRuntime(root);
    await runtime.load();
  });

  afterEach(async () => {
    runtime.dispose();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("offers a quick fix for the element the template is missing", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const offered = await actions.provide(document, WHOLE_DOCUMENT);

    assert.strictEqual(offered.length, 1);
    assert.strictEqual(offered[0].title, "⟐ Import ShopCardComponent from './shop-card.component'");
    assert.strictEqual(offered[0].kind, CodeActionKind.QuickFix);
    assert.strictEqual(offered[0].isPreferred, true);
  });

  it("targets the component file, not the external template it was requested in", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const [action] = await actions.provide(document, WHOLE_DOCUMENT);

    assert.strictEqual((action.data as CodeActionData).uri, pathToFileURL(hostPath).toString());
  });

  it("leaves the edit out until the client resolves the action", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const [offered] = await actions.provide(document, WHOLE_DOCUMENT);
    assert.strictEqual(offered.edit, undefined);

    const resolved = await actions.resolve(offered);

    assert.match(editedText(resolved), /import \{ ShopCardComponent } from ".\/shop-card.component";/);
    assert.match(editedText(resolved), /imports: \[ShopCardComponent]/);
  });

  it("attaches the edit up front for a client that cannot resolve actions", async () => {
    resolvesActions = false;
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const [action] = await actions.provide(document, WHOLE_DOCUMENT);

    assert.match(editedText(action), /imports: \[ShopCardComponent]/);
    assert.strictEqual(action.command, undefined, "An action with an edit must not also run a command");
  });

  it("guards the edit with the version of the file it was planned against", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const resolved = await actions.resolve((await actions.provide(document, WHOLE_DOCUMENT))[0]);

    const [change] = resolved.edit?.documentChanges ?? [];
    assert.ok(change && "textDocument" in change);
    assert.strictEqual(change.textDocument.uri, pathToFileURL(hostPath).toString());
    assert.strictEqual(change.textDocument.version, null, "Nobody has the component open");
  });

  it("offers one fix-all that imports everything the document is missing", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card><shop-badge></shop-badge>", "html");

    const offered = await actions.provide(document, WHOLE_DOCUMENT);
    const fixAll = offered.find((action) => action.kind === FIX_ALL_KIND);

    assert.ok(fixAll, "A document missing two elements must offer a fix-all");
    assert.strictEqual(fixAll.title, "⟐ Import 2 missing Angular elements");
    assert.match(editedText(await actions.resolve(fixAll)), /imports: \[ShopCardComponent, ShopBadgeComponent]/);
  });

  it("does not offer a fix-all when there is only one thing to fix", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const offered = await actions.provide(document, WHOLE_DOCUMENT);

    assert.deepStrictEqual(
      offered.filter((action) => action.kind === FIX_ALL_KIND),
      []
    );
  });

  it("imports each element once however often the template uses it", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card><shop-card></shop-card>", "html");

    const offered = await actions.provide(document, WHOLE_DOCUMENT);

    assert.strictEqual(offered.length, 1);
  });

  it("offers only the kinds the client asked for", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card><shop-badge></shop-badge>", "html");

    const fixAllOnly = await actions.provide(document, WHOLE_DOCUMENT, [CodeActionKind.SourceFixAll]);
    const quickFixOnly = await actions.provide(document, WHOLE_DOCUMENT, [CodeActionKind.QuickFix]);

    assert.deepStrictEqual(
      fixAllOnly.map((action) => action.kind),
      [FIX_ALL_KIND]
    );
    assert.deepStrictEqual(new Set(quickFixOnly.map((action) => action.kind)), new Set([CodeActionKind.QuickFix]));
  });

  it("offers only the fix whose range the request touches", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>\n<shop-badge></shop-badge>", "html");
    const secondLine: Range = { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } };

    const offered = await actions.provide(document, secondLine, [CodeActionKind.QuickFix]);

    assert.strictEqual(offered.length, 1);
    assert.match(offered[0].title, /ShopBadgeComponent/);
  });

  it("offers fixes in quickfix-only mode, where the user was shown no diagnostics", async () => {
    config.diagnosticsMode = "quickfix-only";
    const { actions, diagnostics } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");
    diagnostics.provide(document);

    const offered = await actions.provide(document, WHOLE_DOCUMENT);

    assert.strictEqual(offered.length, 1);
  });

  it("offers nothing for a document no discovered project owns", async () => {
    const { actions } = handlerFor();
    const document = documentAt(path.join(sandbox, "elsewhere", "page.html"), "<shop-card></shop-card>", "html");

    assert.deepStrictEqual(await actions.provide(document, WHOLE_DOCUMENT), []);
  });

  it("offers nothing when the template is missing nothing", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<div></div>", "html");

    assert.deepStrictEqual(await actions.provide(document, WHOLE_DOCUMENT), []);
  });

  it("names the fix-all kind and the command a client can request", () => {
    assert.strictEqual(FIX_ALL_KIND, "source.fixAll.angular-auto-import");
    assert.strictEqual(APPLY_IMPORT_COMMAND, "angular-auto-import.lsp.applyImport");
  });
});
