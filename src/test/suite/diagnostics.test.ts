import * as assert from "node:assert";
import * as path from "node:path";
import { Project } from "ts-morph";
import * as vscode from "vscode";
import { DiagnosticProvider } from "../../providers/diagnostics";
import { AngularElementData } from "../../types";

describe("DiagnosticProvider", function () {
  this.timeout(15000);

  const testProjectPath = "/test/project";
  let provider: DiagnosticProvider;
  let sourceFile: import("ts-morph").SourceFile;
  let cssSelectorCtor: unknown;
  let selectorMatcherCtor: unknown;
  let importedNames = new Set<string>();

  const indexEntries = new Map<string, AngularElementData[]>([
    [
      "nz-button",
      [
        new AngularElementData({
          path: "ng-zorro-antd/button",
          name: "NzButtonComponent",
          type: "component",
          originalSelector: "button[nz-button], a[nz-button]",
          selectors: ["button[nz-button]", "a[nz-button]", "nz-button", "[nz-button]"],
          isStandalone: true,
          isExternal: true,
        }),
        new AngularElementData({
          path: "ng-zorro-antd/core/wave",
          name: "NzWaveDirective",
          type: "directive",
          originalSelector: '[nz-wave],button[nz-button]:not([nzType="link"]):not([nzType="text"])',
          selectors: [
            "[nz-wave]",
            'button[nz-button]:not([nzType="link"]):not([nzType="text"])',
            "nz-wave",
            "[nz-wave]",
            "nz-button",
            "[nz-button]",
          ],
          isStandalone: true,
          isExternal: true,
        }),
      ],
    ],
    [
      "nz-dropdown",
      [
        new AngularElementData({
          path: "ng-zorro-antd/dropdown",
          name: "NzDropDownDirective",
          type: "directive",
          originalSelector: "[nz-dropdown]",
          selectors: ["nz-dropdown", "[nz-dropdown]"],
          isStandalone: true,
          isExternal: true,
        }),
        new AngularElementData({
          path: "ng-zorro-antd/dropdown",
          name: "NzDropdownButtonDirective",
          type: "directive",
          originalSelector: "[nz-button][nz-dropdown]",
          selectors: ["[nz-button][nz-dropdown]", "nz-button", "[nz-button]", "nz-dropdown", "[nz-dropdown]"],
          isStandalone: true,
          isExternal: true,
        }),
      ],
    ],
    [
      "translate",
      [
        new AngularElementData({
          path: "@org/internal-lib",
          name: "RedactedPipe2",
          type: "pipe",
          originalSelector: "translate",
          selectors: ["translate"],
          isStandalone: true,
          isExternal: true,
        }),
        new AngularElementData({
          path: "@ngx-translate/core",
          name: "TranslatePipe",
          type: "pipe",
          originalSelector: "translate",
          selectors: ["translate"],
          isStandalone: false,
          isExternal: true,
          exportingModuleName: "TranslateModule",
        }),
      ],
    ],
  ]);

  const mockIndexer = {
    getElements: (selector: string) => indexEntries.get(selector) || [],
  };

  const mockExtensionContext = {
    subscriptions: [],
    workspaceState: {
      get: () => undefined,
      update: async () => undefined,
      keys: () => [],
    },
    globalState: {
      get: () => undefined,
      update: async () => undefined,
      keys: () => [],
      setKeysForSync: () => undefined,
    },
    extensionPath: "",
    extensionUri: vscode.Uri.file(""),
    environmentVariableCollection: {} as any,
    extensionMode: vscode.ExtensionMode.Test,
    logUri: vscode.Uri.file(""),
    storageUri: vscode.Uri.file(""),
    globalStorageUri: vscode.Uri.file(""),
    secrets: {} as any,
    extension: {} as any,
    languageModelAccessInformation: {} as any,
    asAbsolutePath: (relativePath: string) => relativePath,
    storagePath: undefined,
    globalStoragePath: "",
    logPath: "",
  } as unknown as vscode.ExtensionContext;

  before(async () => {
    const compiler = await import("@angular/compiler");
    cssSelectorCtor = compiler.CssSelector;
    selectorMatcherCtor = compiler.SelectorMatcher;
  });

  beforeEach(() => {
    importedNames = new Set<string>();

    provider = new DiagnosticProvider({
      projectIndexers: new Map([[testProjectPath, mockIndexer as any]]),
      projectTsConfigs: new Map([[testProjectPath, null]]),
      extensionConfig: {
        projectPath: null,
        indexRefreshInterval: 60,
        completion: {
          pipes: true,
          components: true,
          directives: true,
        },
        diagnosticsMode: "full",
        diagnosticsSeverity: "warning" as const,
        logging: {
          enabled: false,
          level: "INFO",
          fileLoggingEnabled: false,
          logDirectory: null,
          rotationMaxSize: 5,
          rotationMaxFiles: 5,
          outputFormat: "plain",
        },
      },
      extensionContext: mockExtensionContext,
    });

    const project = new Project({ useInMemoryFileSystem: true });
    sourceFile = project.createSourceFile(
      path.join(testProjectPath, "src/app/playground.component.ts"),
      "export class PlaygroundComponent {}",
      { overwrite: true }
    );

    (provider as any).isElementImported = (_sourceFile: import("ts-morph").SourceFile, element: AngularElementData) =>
      importedNames.has(element.name) ||
      Boolean(element.exportingModuleName && importedNames.has(element.exportingModuleName));
  });

  afterEach(() => {
    provider.deactivate();
  });

  it("should suppress auxiliary diagnostics for nz-button when NzButtonComponent is already imported", async () => {
    importedNames = new Set(["NzButtonComponent"]);

    const element = createElement("nz-button", "button", [
      { name: "nz-button", value: "" },
      { name: "nzType", value: "primary" },
    ]);

    const diagnostics = await (provider as any).checkElement(
      element,
      mockIndexer,
      vscode.DiagnosticSeverity.Warning,
      sourceFile,
      cssSelectorCtor,
      selectorMatcherCtor
    );

    assert.deepStrictEqual(diagnostics, [], "nz-button should not report a missing NzWaveDirective diagnostic");
  });

  it("should keep diagnostics for compound selectors like NzDropdownButtonDirective", async () => {
    importedNames = new Set(["NzButtonComponent", "NzDropDownDirective"]);

    const element = createElement("nz-dropdown", "button", [
      { name: "nz-button", value: "" },
      { name: "nz-dropdown", value: "" },
    ]);

    const diagnostics = await (provider as any).checkElement(
      element,
      mockIndexer,
      vscode.DiagnosticSeverity.Warning,
      sourceFile,
      cssSelectorCtor,
      selectorMatcherCtor
    );

    assert.strictEqual(diagnostics.length, 1, "compound directive should still produce one diagnostic");
    assert.strictEqual(
      diagnostics[0].code,
      "missing-directive-import:[nz-button][nz-dropdown]",
      "compound directive diagnostic should remain visible"
    );
  });

  it("suppresses pipe diagnostics when another pipe candidate for the same selector is imported", async () => {
    importedNames = new Set(["TranslateModule"]);

    const element = createPipeElement("translate");

    const diagnostics = await (provider as any).checkElement(
      element,
      mockIndexer,
      vscode.DiagnosticSeverity.Warning,
      sourceFile,
      cssSelectorCtor,
      selectorMatcherCtor
    );

    assert.deepStrictEqual(
      diagnostics,
      [],
      "translate should not report a missing pipe when TranslatePipe is available through TranslateModule"
    );
  });

  it("treats an imported exporting module as an import for its non-standalone pipe", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const moduleSourceFile = project.createSourceFile(
      path.join(testProjectPath, "src/app/translate-playground.component.ts"),
      `
import { Component } from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";

@Component({
  selector: "app-translate-playground",
  standalone: true,
  template: "{{ 'demo.title' | translate }}",
  imports: [TranslateModule],
})
export class TranslatePlaygroundComponent {}
`,
      { overwrite: true }
    );
    const translatePipe = new AngularElementData({
      path: "@ngx-translate/core",
      name: "TranslatePipe",
      type: "pipe",
      originalSelector: "translate",
      selectors: ["translate"],
      isStandalone: false,
      isExternal: true,
      exportingModuleName: "TranslateModule",
    });

    const isImported = (DiagnosticProvider.prototype as any).isElementImported.call(
      provider,
      moduleSourceFile,
      translatePipe
    );

    assert.strictEqual(isImported, true, "TranslateModule should make TranslatePipe available");
  });

  it("suppresses pipe diagnostics when a matching module is imported from the pipe package", async () => {
    (provider as any).isElementImported = (DiagnosticProvider.prototype as any).isElementImported.bind(provider);

    const project = new Project({ useInMemoryFileSystem: true });
    const moduleSourceFile = project.createSourceFile(
      path.join(testProjectPath, "src/app/standalone-translate-playground.component.ts"),
      `
import { Component } from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";

@Component({
  selector: "app-standalone-translate-playground",
  standalone: true,
  template: "{{ 'demo.title' | translate }}",
  imports: [TranslateModule],
})
export class StandaloneTranslatePlaygroundComponent {}
`,
      { overwrite: true }
    );
    const moduleBackedIndexer = {
      getElements: (selector: string) =>
        selector === "translate"
          ? [
              new AngularElementData({
                path: "src/app/workspace-translate.pipe",
                name: "WorkspaceTranslatePipe",
                type: "pipe",
                originalSelector: "translate",
                selectors: ["translate"],
                isStandalone: true,
                isExternal: false,
              }),
              new AngularElementData({
                path: "@ngx-translate/core",
                name: "TranslatePipe",
                type: "pipe",
                originalSelector: "translate",
                selectors: ["translate"],
                isStandalone: true,
                isExternal: true,
              }),
            ]
          : [],
      getExternalModuleExports: () => undefined,
    };

    const diagnostics = await (provider as any).checkElement(
      createPipeElement("translate"),
      moduleBackedIndexer,
      vscode.DiagnosticSeverity.Warning,
      moduleSourceFile,
      cssSelectorCtor,
      selectorMatcherCtor
    );

    assert.deepStrictEqual(
      diagnostics,
      [],
      "translate should not report a missing pipe when TranslateModule is imported from the TranslatePipe package"
    );
  });

  it("keeps pipe diagnostics when a matching module import is from a different package", async () => {
    (provider as any).isElementImported = (DiagnosticProvider.prototype as any).isElementImported.bind(provider);

    const project = new Project({ useInMemoryFileSystem: true });
    const moduleSourceFile = project.createSourceFile(
      path.join(testProjectPath, "src/app/module-name-translate-playground.component.ts"),
      `
import { Component } from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";

@Component({
  selector: "app-module-name-translate-playground",
  standalone: true,
  template: "{{ 'demo.title' | translate }}",
  imports: [TranslateModule],
})
export class ModuleNameTranslatePlaygroundComponent {}
`,
      { overwrite: true }
    );
    const workspaceOnlyIndexer = {
      getElements: (selector: string) =>
        selector === "translate"
          ? [
              new AngularElementData({
                path: "src/app/workspace-translate.pipe",
                name: "WorkspaceTranslatePipe",
                type: "pipe",
                originalSelector: "translate",
                selectors: ["translate"],
                isStandalone: true,
                isExternal: false,
              }),
            ]
          : [],
      getExternalModuleExports: () => undefined,
    };

    const diagnostics = await (provider as any).checkElement(
      createPipeElement("translate"),
      workspaceOnlyIndexer,
      vscode.DiagnosticSeverity.Warning,
      moduleSourceFile,
      cssSelectorCtor,
      selectorMatcherCtor
    );

    assert.strictEqual(
      diagnostics.length,
      1,
      "translate should still report a missing local pipe when TranslateModule is from another package"
    );
    assert.strictEqual(
      diagnostics[0].code,
      "missing-pipe-import:translate",
      "the unrelated module-name match should not suppress the pipe diagnostic"
    );
  });

  it("keeps pipe diagnostics when a matching module has explicit exports without the pipe", async () => {
    (provider as any).isElementImported = (DiagnosticProvider.prototype as any).isElementImported.bind(provider);

    const project = new Project({ useInMemoryFileSystem: true });
    const moduleSourceFile = project.createSourceFile(
      path.join(testProjectPath, "src/app/date-playground.component.ts"),
      `
import { Component } from "@angular/core";
import { DateModule } from "@org/date";

@Component({
  selector: "app-date-playground",
  standalone: true,
  template: "{{ today | date }}",
  imports: [DateModule],
})
export class DatePlaygroundComponent {}
`,
      { overwrite: true }
    );
    const dateIndexer = {
      getElements: (selector: string) =>
        selector === "date"
          ? [
              new AngularElementData({
                path: "@org/date",
                name: "DatePipe",
                type: "pipe",
                originalSelector: "date",
                selectors: ["date"],
                isStandalone: true,
                isExternal: true,
              }),
            ]
          : [],
      getExternalModuleExports: (moduleName: string) =>
        moduleName === "DateModule" ? new Set(["UnrelatedPipe"]) : undefined,
    };

    const diagnostics = await (provider as any).checkElement(
      createPipeElement("date"),
      dateIndexer,
      vscode.DiagnosticSeverity.Warning,
      moduleSourceFile,
      cssSelectorCtor,
      selectorMatcherCtor
    );

    assert.strictEqual(
      diagnostics.length,
      1,
      "date should still report a missing pipe when DateModule is indexed and does not export DatePipe"
    );
    assert.strictEqual(
      diagnostics[0].code,
      "missing-pipe-import:date",
      "explicit module export data should win over the module-name fallback"
    );
  });

  it("refreshOpenDocuments clears the import resolution cache", async () => {
    // Simulate a previously cached (stale) "not imported" result, e.g. captured
    // before a library was indexed. After the external index is rebuilt this
    // must be dropped so the refreshed resolution is used.
    const cache = (provider as any).importedElementsCache as Map<string, Map<string, boolean>>;
    cache.set(path.join(testProjectPath, "src/app/foo.component.ts"), new Map([["TranslatePipe", false]]));
    assert.ok(cache.size > 0, "precondition: import cache populated");

    await provider.refreshOpenDocuments();

    assert.strictEqual(cache.size, 0, "import cache should be cleared after refreshOpenDocuments");
  });

  it("clears diagnostics for Source Control virtual documents", async () => {
    const filePath = path.join(testProjectPath, "src/app/review.component.ts");
    const uri = vscode.Uri.from({ scheme: "git", path: filePath, query: JSON.stringify({ ref: "HEAD" }) });
    const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "stale review diagnostic");
    const candidateDiagnostics = (provider as any).candidateDiagnostics as Map<string, vscode.Diagnostic[]>;
    const diagnosticCollection = (provider as any).diagnosticCollection as vscode.DiagnosticCollection;
    candidateDiagnostics.set(uri.toString(), [diagnostic]);
    diagnosticCollection.set(uri, [diagnostic]);

    const reviewDocument = {
      uri,
      fileName: filePath,
      languageId: "typescript",
      version: 1,
      getText: () => "export class HistoricalSnapshot {}",
    } as unknown as vscode.TextDocument;

    await (provider as any).updateDiagnostics(reviewDocument);

    assert.deepStrictEqual(provider.getDiagnosticsForDocument(uri), []);
    assert.deepStrictEqual(
      [...(diagnosticCollection.get(uri) || [])],
      [],
      "Virtual-document diagnostics should be removed"
    );
  });

  it("uses the exact file document text when Source Control has a document with the same path", () => {
    const filePath = path.join(testProjectPath, "src/app/exact-document.component.ts");
    const currentText = "export class CurrentWorkingTreeComponent {}";
    const historicalDocument = {
      uri: vscode.Uri.from({ scheme: "git", path: filePath, query: JSON.stringify({ ref: "HEAD" }) }),
      fileName: filePath,
      languageId: "typescript",
      version: 1,
      getText: () => "export class HistoricalSnapshotComponent {}",
    } as unknown as vscode.TextDocument;
    const workingTreeDocument = {
      uri: vscode.Uri.file(filePath),
      fileName: filePath,
      languageId: "typescript",
      version: 2,
      getText: () => currentText,
    } as unknown as vscode.TextDocument;
    (mockIndexer as any).project = sourceFile.getProject();
    const originalTextDocuments = vscode.workspace.textDocuments;
    Object.defineProperty(vscode.workspace, "textDocuments", {
      configurable: true,
      get: () => [historicalDocument, workingTreeDocument],
    });

    try {
      const exactSourceFile = (provider as any).getSourceFile(workingTreeDocument) as import("ts-morph").SourceFile;

      assert.strictEqual(exactSourceFile.getFullText(), currentText);
    } finally {
      Object.defineProperty(vscode.workspace, "textDocuments", {
        configurable: true,
        get: () => originalTextDocuments,
      });
    }
  });
});

function createElement(
  name: string,
  tagName: string,
  attributes: Array<{ name: string; value: string }>
): {
  type: "attribute";
  name: string;
  isAttribute: true;
  range: vscode.Range;
  tagName: string;
  attributes: Array<{ name: string; value: string }>;
} {
  return {
    type: "attribute",
    name,
    isAttribute: true,
    range: new vscode.Range(0, 0, 0, name.length),
    tagName,
    attributes,
  };
}

function createPipeElement(name: string): {
  type: "pipe";
  name: string;
  isAttribute: false;
  range: vscode.Range;
  tagName: string;
  attributes: Array<{ name: string; value: string }>;
} {
  return {
    type: "pipe",
    name,
    isAttribute: false,
    range: new vscode.Range(0, 0, 0, name.length),
    tagName: "pipe",
    attributes: [],
  };
}
