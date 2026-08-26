import * as assert from "node:assert";
import * as path from "node:path";
import { Project } from "ts-morph";
import { type AngularCompilerApi, adoptAngularCompiler } from "../../core/angular-compiler";
import { ComponentImports, type ModuleExportsIndex } from "../../core/component-imports";
import type { CoreRange } from "../../core/language-types";
import {
  findMissingImports,
  type MissingImportContext,
  type MissingImportDiagnostic,
} from "../../core/missing-imports";
import { createMissingImportContext, type DiagnosticIndex } from "../../core/template-diagnostics";
import type { ScannedTemplateElement } from "../../core/template-scan";
import { AngularElementData } from "../../types";

describe("Missing-import suppression", function () {
  this.timeout(15000);

  const testProjectPath = "/test/project";
  let componentImports: ComponentImports;
  let sourceFile: import("ts-morph").SourceFile;
  let compiler: AngularCompilerApi;
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
        // The trie registers a compound selector under each of its attributes, so a
        // `nz-button` token really does offer this one too.
        new AngularElementData({
          path: "ng-zorro-antd/dropdown",
          name: "NzDropdownButtonDirective",
          type: "directive",
          originalSelector: "[nz-button][nz-dropdown]",
          selectors: ["[nz-button][nz-dropdown]", "nz-button", "[nz-button]", "nz-dropdown", "[nz-dropdown]"],
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
      "tuiSlot",
      [
        new AngularElementData({
          path: "@taiga-ui/layout",
          name: "TuiBlockStatusDirective",
          type: "directive",
          originalSelector: "[tuiSlot]",
          selectors: ["[tuiSlot]", "tuiSlot"],
          isStandalone: true,
          isExternal: true,
        }),
        new AngularElementData({
          path: "@taiga-ui/layout",
          name: "TuiAppBarDirective",
          type: "directive",
          originalSelector: "[tuiSlot]",
          selectors: ["[tuiSlot]", "tuiSlot"],
          isStandalone: true,
          isExternal: true,
        }),
        new AngularElementData({
          path: "@taiga-ui/kit",
          name: "TuiBadgedContentDirective",
          type: "directive",
          originalSelector: "[tuiSlot]",
          selectors: ["[tuiSlot]", "tuiSlot"],
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

  before(async () => {
    compiler = adoptAngularCompiler(await import("@angular/compiler"));
  });

  /** Runs the missing-import analysis wired the way both hosts wire it. */
  function checkElement(
    element: ScannedTemplateElement,
    indexer: unknown,
    componentFile: import("ts-morph").SourceFile
  ): MissingImportDiagnostic[] {
    const context: MissingImportContext = createMissingImportContext({
      index: indexer as DiagnosticIndex,
      componentImports,
      sourceFile: componentFile,
      compiler,
    });
    return findMissingImports([element], "warning", context);
  }

  /** The resolver as it runs for real, answering from the ts-morph AST. */
  function realComponentImports(): ComponentImports {
    return componentImports;
  }

  /** Answers "already imported" from `importedNames` instead of reading the AST. */
  function stubImportedNames(): void {
    componentImports.isImported = (_sourceFile: import("ts-morph").SourceFile, element: AngularElementData) =>
      importedNames.has(element.name) ||
      Boolean(element.exportingModuleName && importedNames.has(element.exportingModuleName));
  }

  beforeEach(() => {
    importedNames = new Set<string>();
    componentImports = new ComponentImports({ resolveIndex: () => mockIndexer as unknown as ModuleExportsIndex });

    const project = new Project({ useInMemoryFileSystem: true });
    sourceFile = project.createSourceFile(
      path.join(testProjectPath, "src/app/playground.component.ts"),
      "export class PlaygroundComponent {}",
      { overwrite: true }
    );
  });

  it("reports the ripple directive an imported button component does not bring with it", () => {
    // `button[nz-button]` and `button[nz-button]:not([nzType="link"]):not([nzType="text"])`
    // are two directives, and importing the first applies only the first. Users who import
    // `NzButtonModule` never see this: the module exports both.
    importedNames = new Set(["NzButtonComponent"]);
    stubImportedNames();

    const element = createElement("nz-button", "button", [
      { name: "nz-button", value: "" },
      { name: "nzType", value: "primary" },
    ]);

    const diagnostics = checkElement(element, mockIndexer, sourceFile);

    assert.deepStrictEqual(
      diagnostics.map((diagnostic) => diagnostic.elements.map((named) => named.name)),
      [["NzWaveDirective"]],
      "the ripple is missing, and it is the only thing missing"
    );
  });

  it("should keep diagnostics for compound selectors like NzDropdownButtonDirective", async () => {
    importedNames = new Set(["NzButtonComponent", "NzDropDownDirective"]);
    stubImportedNames();

    const element = createElement("nz-dropdown", "button", [
      { name: "nz-button", value: "" },
      { name: "nz-dropdown", value: "" },
    ]);

    const diagnostics = checkElement(element, mockIndexer, sourceFile);

    assert.strictEqual(diagnostics.length, 1, "compound directive should still produce one diagnostic");
    assert.strictEqual(
      diagnostics[0].code,
      "missing-directive-import:[nz-button][nz-dropdown]",
      "compound directive diagnostic should remain visible"
    );
  });

  it("suppresses a directive diagnostic when another directive answering the selector is imported", () => {
    // Nothing about the imported directive's name says "tuiSlot" — a selector is not
    // owned by the class named after it, and one of its owners is enough.
    importedNames = new Set(["TuiBlockStatusDirective"]);
    stubImportedNames();

    const element = createElement("tuiSlot", "span", [{ name: "tuiSlot", value: "top" }]);

    const diagnostics = checkElement(element, mockIndexer, sourceFile);

    assert.deepStrictEqual(diagnostics, [], "the attribute has an owner in this file");
  });

  it("keeps a compound directive that asks for more than the imported one on the same tag", () => {
    // The token is the shared attribute, so nothing about the names tells them apart —
    // but `[nz-button][nz-dropdown]` demands an attribute `button[nz-button]` never
    // mentions, which makes it a different directive rather than another owner.
    importedNames = new Set(["NzButtonComponent"]);
    stubImportedNames();

    const element = createElement("nz-button", "button", [
      { name: "nz-button", value: "" },
      { name: "nz-dropdown", value: "" },
    ]);

    const diagnostics = checkElement(element, mockIndexer, sourceFile);

    assert.deepStrictEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ["missing-directive-import:[nz-button][nz-dropdown]"],
      "the compound directive is still missing, the auxiliary wave directive is not"
    );
  });

  it("keeps the marker of the directive that demands the most, not the longest selector", () => {
    // Nothing imported: the wave directive and the dropdown button are both missing on
    // this tag, and one marker has to speak for the token. The dropdown button is what a
    // user has to import to get the behaviour; the wave rides along with the button.
    stubImportedNames();

    const element = createElement("nz-button", "button", [
      { name: "nz-button", value: "" },
      { name: "nz-dropdown", value: "" },
    ]);

    const diagnostics = checkElement(element, mockIndexer, sourceFile);

    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.code === "missing-directive-import:[nz-button][nz-dropdown]"),
      `the compound directive should speak for the token, got ${diagnostics.map((d) => d.code).join(", ")}`
    );
  });

  it("keeps a broader directive when the imported one asks for more than it does", () => {
    // The dropdown button is imported and matches this element, but it is a narrower
    // directive: the attribute's own directive is still missing.
    importedNames = new Set(["NzDropdownButtonDirective"]);
    stubImportedNames();

    const element = createElement("nz-dropdown", "button", [
      { name: "nz-button", value: "" },
      { name: "nz-dropdown", value: "" },
    ]);

    const diagnostics = checkElement(element, mockIndexer, sourceFile);

    assert.deepStrictEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ["missing-directive-import:[nz-dropdown]"],
      "importing a directive that demands more does not answer for the attribute itself"
    );
  });

  it("names every missing element on the one diagnostic a token gets", () => {
    stubImportedNames();

    const element = createElement("tuiSlot", "span", [{ name: "tuiSlot", value: "top" }]);

    const diagnostics = checkElement(element, mockIndexer, sourceFile);

    assert.strictEqual(diagnostics.length, 1, "one token is one marker");
    assert.deepStrictEqual(
      diagnostics[0].elements.map((named) => named.name).sort(),
      ["TuiAppBarDirective", "TuiBadgedContentDirective", "TuiBlockStatusDirective"],
      "the fix chooses between them, so all of them are on the diagnostic"
    );
  });

  it("suppresses pipe diagnostics when another pipe candidate for the same selector is imported", async () => {
    importedNames = new Set(["TranslateModule"]);
    stubImportedNames();

    const element = createPipeElement("translate");

    const diagnostics = checkElement(element, mockIndexer, sourceFile);

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

    const isImported = realComponentImports().isImported(moduleSourceFile, translatePipe);

    assert.strictEqual(isImported, true, "TranslateModule should make TranslatePipe available");
  });

  it("suppresses pipe diagnostics when a matching module is imported from the pipe package", async () => {
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

    const diagnostics = checkElement(createPipeElement("translate"), moduleBackedIndexer, moduleSourceFile);

    assert.deepStrictEqual(
      diagnostics,
      [],
      "translate should not report a missing pipe when TranslateModule is imported from the TranslatePipe package"
    );
  });

  it("keeps pipe diagnostics when a matching module import is from a different package", async () => {
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

    const diagnostics = checkElement(createPipeElement("translate"), workspaceOnlyIndexer, moduleSourceFile);

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

    const diagnostics = checkElement(createPipeElement("date"), dateIndexer, moduleSourceFile);

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
});

function createElement(
  name: string,
  tagName: string,
  attributes: Array<{ name: string; value: string }>
): ScannedTemplateElement {
  return {
    type: "attribute",
    name,
    isAttribute: true,
    range: rangeOf(name),
    tagName,
    attributes,
  };
}

function createPipeElement(name: string): ScannedTemplateElement {
  return {
    type: "pipe",
    name,
    isAttribute: false,
    range: rangeOf(name),
    tagName: "pipe",
    attributes: [],
  };
}

/** A single-line range covering a name, which these tests never assert on. */
function rangeOf(name: string): CoreRange {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } };
}
