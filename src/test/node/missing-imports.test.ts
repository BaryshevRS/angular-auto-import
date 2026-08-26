import * as assert from "node:assert";
import type { CoreRange } from "../../core/language-types";
import {
  findMissingImports,
  type MissingImportContext,
  type MissingImportDiagnostic,
} from "../../core/missing-imports";
import type { ScannedTemplateElement } from "../../core/template-scan";
import { AngularElementData } from "../../types";

let selectors: MissingImportContext["selectors"];

const range: CoreRange = { start: { line: 3, character: 4 }, end: { line: 3, character: 12 } };

function element(overrides: Partial<ScannedTemplateElement> = {}): ScannedTemplateElement {
  return {
    type: "component",
    name: "app-card",
    tagName: "app-card",
    isAttribute: false,
    range,
    attributes: [],
    classNames: [],
    ...overrides,
  };
}

function angularElement(overrides: Partial<ConstructorParameters<typeof AngularElementData>[0]>): AngularElementData {
  return new AngularElementData({
    path: "./src/app/card",
    name: "CardComponent",
    type: "component",
    originalSelector: "app-card",
    selectors: ["app-card"],
    isStandalone: true,
    isExternal: false,
    ...overrides,
  });
}

/** A context that knows the given candidates and treats `imported` names as already imported. */
function contextOf(candidates: AngularElementData[], imported: string[] = []): MissingImportContext {
  const importedNames = new Set(imported);
  return {
    findCandidates: () => candidates,
    isImported: (candidate) => importedNames.has(candidate.name),
    getComponentImportNames: () => [...importedNames],
    getNamedImportSpecifiers: () => [],
    getExternalModuleExports: () => undefined,
    selectors,
  };
}

function codes(diagnostics: MissingImportDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

describe("Missing import analysis", () => {
  before(async () => {
    const compiler = (await import("@angular/compiler")) as unknown as Record<string, unknown>;
    selectors = {
      cssSelector: compiler.CssSelector,
      selectorMatcher: compiler.SelectorMatcher,
    } as MissingImportContext["selectors"];
  });

  it("reports a component the template uses but the file does not import", () => {
    const [diagnostic, ...rest] = findMissingImports([element()], "warning", contextOf([angularElement({})]));

    assert.deepStrictEqual(rest, []);
    assert.strictEqual(diagnostic.message, "'app-card' is part of a known component, but it is not imported.");
    assert.strictEqual(diagnostic.code, "missing-component-import:app-card");
    assert.strictEqual(diagnostic.source, "angular-auto-import");
    assert.strictEqual(diagnostic.severity, "warning");
    assert.deepStrictEqual(diagnostic.range, range);
  });

  it("reports nothing once the element is imported", () => {
    const diagnostics = findMissingImports([element()], "warning", contextOf([angularElement({})], ["CardComponent"]));

    assert.deepStrictEqual(diagnostics, []);
  });

  it("carries the configured severity into every diagnostic", () => {
    const diagnostics = findMissingImports([element()], "error", contextOf([angularElement({})]));

    assert.strictEqual(diagnostics[0].severity, "error");
  });

  it("does not report a pipe candidate for a property binding of the same name", () => {
    const pipe = angularElement({ name: "HighlightPipe", type: "pipe", originalSelector: "highlight" });
    const binding = element({ type: "property-binding", name: "highlight", tagName: "div", isAttribute: true });

    assert.deepStrictEqual(findMissingImports([binding], "warning", contextOf([pipe])), []);
    assert.deepStrictEqual(
      codes(
        findMissingImports(
          [element({ type: "pipe", name: "highlight", tagName: "pipe" })],
          "warning",
          contextOf([pipe])
        )
      ),
      ["missing-pipe-import:highlight"]
    );
  });

  it("reports the most specific selector a candidate matched", () => {
    const compound = angularElement({
      name: "ScopedDirective",
      type: "directive",
      originalSelector: "[appScope], button[appScope]",
    });
    const button = element({
      type: "attribute",
      name: "appScope",
      tagName: "button",
      isAttribute: true,
      attributes: [{ name: "appScope", value: "" }],
    });

    assert.deepStrictEqual(codes(findMissingImports([button], "warning", contextOf([compound]))), [
      "missing-directive-import:button[appScope]",
    ]);
  });

  it("skips a candidate whose selector does not match the element as written", () => {
    const scopedToInput = angularElement({
      name: "InputOnlyDirective",
      type: "directive",
      originalSelector: "input[appOnly]",
    });
    const divUsage = element({
      type: "attribute",
      name: "appOnly",
      tagName: "div",
      isAttribute: true,
      attributes: [{ name: "appOnly", value: "" }],
    });

    assert.deepStrictEqual(findMissingImports([divUsage], "warning", contextOf([scopedToInput])), []);
  });

  it("reports each element in the template it was given", () => {
    const card = angularElement({});
    const secondUse = element({
      range: { start: { line: 4, character: 2 }, end: { line: 4, character: 12 } },
    });

    const diagnostics = findMissingImports([element(), secondUse], "warning", contextOf([card]));

    assert.strictEqual(diagnostics.length, 2);
  });

  it("says the same thing about the same text only once", () => {
    const card = angularElement({});

    // A tag with attributes is scanned as both a tag and an attribute, and matches the
    // same element under more than one of its selectors; the user must still see one
    // problem, not one per selector that happened to match.
    const diagnostics = findMissingImports([element(), element()], "warning", contextOf([card]));

    assert.strictEqual(diagnostics.length, 1);
  });
});
