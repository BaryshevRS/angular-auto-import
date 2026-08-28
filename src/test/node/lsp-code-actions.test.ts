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
import { DEFAULT_IMPORT_FORMATTING } from "../../core/import-planner";
import type { CoreRange } from "../../core/language-types";
import { DEFAULT_EXTENSION_CONFIG, type ExtensionConfig } from "../../core/settings";
import { type CodeActionData, CodeActionHandler } from "../../lsp/code-actions";
import { DiagnosticsHandler } from "../../lsp/diagnostics";
import { APPLY_IMPORT_COMMAND } from "../../lsp/import-command";
import { ImportEditPlanner } from "../../lsp/import-edit";
import { OpenDocuments } from "../../lsp/open-documents";
import { ProjectRouter } from "../../lsp/project-router";
import { ProjectRuntime } from "../../lsp/project-runtime";
import { FIX_ALL_KIND } from "../../lsp/protocol";
import { applyTextEdits } from "./harness/text";

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

  function handlerFor(options: { resolveFormatting?: () => Promise<typeof DEFAULT_IMPORT_FORMATTING> } = {}): {
    actions: CodeActionHandler;
    diagnostics: DiagnosticsHandler;
  } {
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
      planner: new ImportEditPlanner({
        router,
        documents,
        readFile: (file) => readFileSync(file, "utf-8"),
        resolveFormatting: options.resolveFormatting,
      }),
      resolvesActions: () => resolvesActions,
    });
    return { actions, diagnostics };
  }

  /** The component as the action's edits would leave it. */
  function editedText(action: CodeAction): string {
    const change = action.edit?.documentChanges?.[0];
    assert.ok(change && "edits" in change, `Expected ${action.title} to carry a document edit`);
    return applyTextEdits(readFileSync(hostPath, "utf8"), change.edits as Array<{ range: CoreRange; newText: string }>);
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
    const quickFixes = offered.filter((action) => action.kind === CodeActionKind.QuickFix);

    assert.strictEqual(quickFixes.length, 1);
    assert.strictEqual(quickFixes[0].title, "⟐ Import ShopCardComponent from './shop-card.component'");
    assert.strictEqual(quickFixes[0].isPreferred, true);
  });

  it("offers every directive a shared selector could mean, most specific first", async () => {
    // `[tuiSlot]` is an app-bar directive in one Taiga entry point and a block-status
    // directive in another, and the template says nothing about which was meant. Angular
    // applies whichever is imported, so importing the wrong one leaves the file with no
    // warning and without the behaviour its author was after: both belong in the menu.
    await fs.writeFile(
      path.join(root, "src", "slot.directives.ts"),
      [
        'import { Directive } from "@angular/core";',
        "",
        '@Directive({ selector: "[shopSlot]", standalone: true })',
        "export class ShopHeaderSlotDirective {}",
        "",
        '@Directive({ selector: "[shopSlot]", standalone: true })',
        "export class ShopPanelSlotDirective {}",
        "",
      ].join("\n"),
      "utf8"
    );
    await runtime.reindex();

    const { actions } = handlerFor();
    const document = documentAt(templatePath, '<span shopSlot="top"></span>', "html");

    const offered = await actions.provide(document, WHOLE_DOCUMENT);
    const quickFixes = offered.filter((action) => action.kind === CodeActionKind.QuickFix);

    assert.deepStrictEqual(
      quickFixes.map((action) => action.title),
      [
        "⟐ Import ShopHeaderSlotDirective from './slot.directives'",
        "⟐ Import ShopPanelSlotDirective from './slot.directives'",
      ]
    );
    assert.deepStrictEqual(
      quickFixes.map((action) => action.isPreferred),
      [true, false],
      'one of them is the preferred fix, so an editor\'s own "fix this" still has one answer'
    );
  });

  it("withholds Fix All when two exports need the same local import name", async () => {
    await fs.writeFile(path.join(root, "src", "one.component.ts"), component("SharedComponent", "one-shared"), "utf8");
    await fs.writeFile(path.join(root, "src", "two.component.ts"), component("SharedComponent", "two-shared"), "utf8");
    await runtime.reindex();
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<one-shared></one-shared><two-shared></two-shared>", "html");

    const offered = await actions.provide(document, WHOLE_DOCUMENT);

    assert.strictEqual(
      offered.filter((action) => action.kind === CodeActionKind.QuickFix).length,
      2,
      "Each element remains individually fixable"
    );
    assert.strictEqual(
      offered.some((action) => action.kind === FIX_ALL_KIND),
      false,
      "The planner cannot alias colliding local names, so a combined edit would be invalid"
    );
  });

  it("offers the directives whose selectors say more than the token does", async () => {
    // The token is `shopSlot` and its diagnostic records the selector one of them
    // matched under; the others demand a tag, a value, a second attribute. All of them
    // apply to `<button shopSlot="check" shopTone>` — Angular matched them against the
    // element, not against that one selector — so all of them belong in the menu.
    await fs.writeFile(
      path.join(root, "src", "slot.directives.ts"),
      [
        'import { Directive } from "@angular/core";',
        "",
        '@Directive({ selector: "[shopSlot]", standalone: true })',
        "export class ShopSlotDirective {}",
        "",
        '@Directive({ selector: "button[shopSlot]", standalone: true })',
        "export class ShopButtonSlotDirective {}",
        "",
        '@Directive({ selector: "[shopSlot=check]", standalone: true })',
        "export class ShopCheckedSlotDirective {}",
        "",
        '@Directive({ selector: "[shopSlot][shopTone]", standalone: true })',
        "export class ShopTonedSlotDirective {}",
        "",
      ].join("\n"),
      "utf8"
    );
    await runtime.reindex();

    const { actions } = handlerFor();
    const document = documentAt(templatePath, '<button shopSlot="check" shopTone></button>', "html");

    const offered = await actions.provide(document, WHOLE_DOCUMENT);
    const titles = offered
      .filter((action) => action.kind === CodeActionKind.QuickFix)
      .map((action) => action.title)
      .sort();

    assert.deepStrictEqual(titles, [
      "⟐ Import ShopButtonSlotDirective from './slot.directives'",
      "⟐ Import ShopCheckedSlotDirective from './slot.directives'",
      "⟐ Import ShopSlotDirective from './slot.directives'",
      "⟐ Import ShopTonedSlotDirective from './slot.directives'",
    ]);
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

  it("takes its stale-plan snapshot after resolving project formatting", async () => {
    const { actions } = handlerFor({
      resolveFormatting: async () => {
        await runtime.reindex();
        return DEFAULT_IMPORT_FORMATTING;
      },
    });
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const resolved = await actions.resolve((await actions.provide(document, WHOLE_DOCUMENT))[0]);

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

  it("fixes all of a token's directives, and one of two that are alternatives", async () => {
    // `[shopSlot]`, `button[shopSlot]` and `[shopSlot=check]` demand different things, so
    // Angular applies all three to `<button shopSlot="check">` and a fix-all that imports
    // one leaves two diagnostics behind. The second `[shopSlot]` is a different matter:
    // twin owns the same token, so importing either settles it and importing both would
    // apply a directive nobody asked for; the one imported is the first of them ranked.
    await fs.writeFile(
      path.join(root, "src", "slot.directives.ts"),
      [
        'import { Directive } from "@angular/core";',
        "",
        '@Directive({ selector: "[shopSlot]", standalone: true })',
        "export class ShopSlotDirective {}",
        "",
        '@Directive({ selector: "[shopSlot]", standalone: true })',
        "export class ShopTwinSlotDirective {}",
        "",
        '@Directive({ selector: "button[shopSlot]", standalone: true })',
        "export class ShopButtonSlotDirective {}",
        "",
        '@Directive({ selector: "[shopSlot=check]", standalone: true })',
        "export class ShopCheckedSlotDirective {}",
        "",
      ].join("\n"),
      "utf8"
    );
    await runtime.reindex();

    const { actions } = handlerFor();
    const document = documentAt(templatePath, '<button shopSlot="check"></button>', "html");

    const offered = await actions.provide(document, WHOLE_DOCUMENT);
    const fixAll = offered.find((action) => action.kind === FIX_ALL_KIND);

    assert.ok(fixAll, "the document is missing imports, so a fix-all is offered");
    assert.match(
      editedText(await actions.resolve(fixAll)),
      /imports: \[ShopSlotDirective, ShopButtonSlotDirective, ShopCheckedSlotDirective]/
    );
  });

  it("offers a fix-all for a single missing element too", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card>", "html");

    const offered = await actions.provide(document, WHOLE_DOCUMENT);
    const fixAll = offered.find((action) => action.kind === FIX_ALL_KIND);

    // The palette command, the editor's own Fix All and `codeActionsOnSave` all ask for
    // this kind by name and get nothing else, so withholding it left a file missing one
    // import unfixable by every one of them.
    assert.ok(fixAll, "A document missing one element must still offer a fix-all");
    assert.strictEqual(fixAll.title, "⟐ Import 1 missing Angular element");
    assert.match(editedText(await actions.resolve(fixAll)), /imports: \[ShopCardComponent]/);
  });

  it("imports each element once however often the template uses it", async () => {
    const { actions } = handlerFor();
    const document = documentAt(templatePath, "<shop-card></shop-card><shop-card></shop-card>", "html");

    const offered = await actions.provide(document, WHOLE_DOCUMENT);

    assert.deepStrictEqual(
      offered.map((action) => action.title),
      ["⟐ Import ShopCardComponent from './shop-card.component'", "⟐ Import 1 missing Angular element"]
    );
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

    assert.deepStrictEqual(
      offered.map((action) => action.kind),
      [CodeActionKind.QuickFix, FIX_ALL_KIND]
    );
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
