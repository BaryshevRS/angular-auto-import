import * as assert from "node:assert";
import { TextDocument } from "vscode-languageserver-textdocument";
import { detectCompletionContext } from "../../core/completion-context";
import {
  buildCompletionSuggestions,
  type CompletionElementSource,
  type CompletionSuggestion,
} from "../../core/completion-suggestions";
import { AngularElementData } from "../../types";

/** Resolves a template where `¦` marks the cursor into a completion context. */
function contextAt(markedText: string) {
  const cursorOffset = markedText.indexOf("¦");
  assert.notStrictEqual(cursorOffset, -1, "Test template must mark the cursor with ¦");
  const document = TextDocument.create(
    "file:///project/src/app.component.html",
    "html",
    1,
    markedText.replace("¦", "")
  );

  return detectCompletionContext(document, document.positionAt(cursorOffset));
}

function element(overrides: Partial<ConstructorParameters<typeof AngularElementData>[0]>): AngularElementData {
  return new AngularElementData({
    path: "./src/app/ui",
    name: "UiElement",
    type: "component",
    originalSelector: "ui-element",
    selectors: ["ui-element"],
    isStandalone: true,
    isExternal: false,
    ...overrides,
  });
}

/** An index stub that returns the given selector/element pairs for every query. */
function sourceOf(...results: Array<{ selector: string; element: AngularElementData }>): CompletionElementSource {
  return { searchWithSelectors: () => results };
}

const emptySource: CompletionElementSource = { searchWithSelectors: () => [] };

function labels(suggestions: CompletionSuggestion[]): string[] {
  return suggestions.map((suggestion) => suggestion.label);
}

function sortTextOf(suggestions: CompletionSuggestion[], label: string): string {
  const suggestion = suggestions.find((candidate) => candidate.label === label);
  assert.ok(suggestion, `expected a suggestion labelled ${label} among ${labels(suggestions).join(", ")}`);
  return suggestion.sortText;
}

function sortTextOfElement(suggestions: CompletionSuggestion[], elementName: string): string {
  const suggestion = suggestions.find((candidate) => candidate.element.name === elementName);
  assert.ok(suggestion, `expected a suggestion importing ${elementName}`);
  return suggestion.sortText;
}

describe("Completion suggestion ranking", () => {
  it("suggests a component whose element selector matches the typed tag", () => {
    const card = element({ name: "CardComponent", originalSelector: "app-card", selectors: ["app-card"] });

    const suggestions = buildCompletionSuggestions(
      sourceOf({ selector: "app-card", element: card }),
      contextAt("<app-ca¦")
    );

    assert.deepStrictEqual(labels(suggestions), ["app-card"]);
    assert.strictEqual(suggestions[0].kind, "class");
    assert.strictEqual(suggestions[0].insertText, "app-card");
    assert.strictEqual(suggestions[0].element, card);
  });

  it("skips element selectors when the cursor is on an attribute", () => {
    const card = element({ name: "CardComponent", originalSelector: "app-card", selectors: ["app-card"] });

    const suggestions = buildCompletionSuggestions(
      sourceOf({ selector: "app-card", element: card }),
      contextAt("<div app-ca¦")
    );

    assert.deepStrictEqual(labels(suggestions), []);
  });

  it("suggests an attribute directive and strips the brackets from the insert text", () => {
    const highlight = element({
      name: "HighlightDirective",
      type: "directive",
      originalSelector: "[appHighlight]",
      selectors: ["[appHighlight]"],
    });

    const suggestions = buildCompletionSuggestions(
      sourceOf({ selector: "[appHighlight]", element: highlight }),
      contextAt("<div appHigh¦")
    );

    assert.strictEqual(suggestions[0].insertText, "appHighlight");
    assert.strictEqual(suggestions[0].filterText, "appHighlight");
    assert.strictEqual(suggestions[0].kind, "property");
  });

  it("prefixes a structural directive with * when the user has not typed one", () => {
    const forDirective = element({
      name: "MyForDirective",
      type: "directive",
      originalSelector: "[myFor]",
      selectors: ["[myFor]"],
    });

    const withTrigger = buildCompletionSuggestions(
      sourceOf({ selector: "[myFor]", element: forDirective }),
      contextAt("<div *myF¦")
    );
    const withoutTrigger = buildCompletionSuggestions(
      sourceOf({ selector: "[myFor]", element: forDirective }),
      contextAt("<div myF¦")
    );

    assert.strictEqual(withTrigger[0].insertText, "myFor");
    assert.strictEqual(withTrigger[0].kind, "keyword");
    assert.strictEqual(withoutTrigger[0].insertText, "myFor");
    assert.strictEqual(withoutTrigger[0].kind, "property");
  });

  it("only suggests pipes in pipe context", () => {
    const pipe = element({ name: "TruncatePipe", type: "pipe", originalSelector: "truncate", selectors: ["truncate"] });
    const component = element({ name: "TrunkComponent", originalSelector: "trunk", selectors: ["trunk"] });
    const source = sourceOf({ selector: "truncate", element: pipe }, { selector: "trunk", element: component });

    const suggestions = buildCompletionSuggestions(source, contextAt("{{ value | tru¦ }}"));

    assert.deepStrictEqual(labels(suggestions), ["truncate"]);
    assert.strictEqual(suggestions[0].kind, "function");
  });

  it("boosts a directive selector scoped to the tag under the cursor", () => {
    // The index registers `button[matButton]` under the full selector and under the
    // bare attribute, so an empty filter inside `<button ` offers both variants.
    const scoped = element({
      name: "ScopedDirective",
      type: "directive",
      originalSelector: "button[matButton]",
      selectors: ["button[matButton]", "matButton", "[matButton]"],
    });
    const generic = element({
      name: "GenericDirective",
      type: "directive",
      path: "./src/app/generic",
      originalSelector: "[matBadge]",
      selectors: ["[matBadge]"],
    });
    const source = sourceOf(
      { selector: "[matBadge]", element: generic },
      { selector: "[matButton]", element: scoped },
      { selector: "button[matButton]", element: scoped }
    );

    const suggestions = buildCompletionSuggestions(source, contextAt("<button ¦"));

    // sortText encodes relevance descending, and editors compare it ordinally, so the
    // tag-scoped selector sorts ahead of the generic attribute directive.
    assert.ok(sortTextOf(suggestions, "button[matButton]") < sortTextOf(suggestions, "matBadge"));
  });

  it("disambiguates two elements that share an insert text", () => {
    const first = element({
      name: "FirstDirective",
      type: "directive",
      path: "./src/app/first",
      originalSelector: "[shared]",
      selectors: ["[shared]"],
    });
    const second = element({
      name: "SecondDirective",
      type: "directive",
      path: "./src/app/second",
      originalSelector: "[shared]",
      selectors: ["[shared]"],
    });
    const source = sourceOf({ selector: "[shared]", element: first }, { selector: "[shared]", element: second });

    const suggestions = buildCompletionSuggestions(source, contextAt("<div shar¦"));

    assert.deepStrictEqual(labels(suggestions).sort(), ["shared:FirstDirective", "shared:SecondDirective"]);
  });

  it("keeps one suggestion per element when the index returns it under several selectors", () => {
    const input = element({
      name: "InputDirective",
      type: "directive",
      originalSelector: "[appInput], input[appInput]",
      selectors: ["[appInput]", "input[appInput]"],
    });
    const source = sourceOf({ selector: "appInput", element: input }, { selector: "[appInput]", element: input });

    const suggestions = buildCompletionSuggestions(source, contextAt("<input appIn¦"));

    assert.strictEqual(suggestions.length, 1);
    assert.strictEqual(suggestions[0].insertText, "appInput");
  });

  it("suggests built-in Angular directives with no project index at all", () => {
    const suggestions = buildCompletionSuggestions(emptySource, contextAt("<div *ngI¦"));

    // `ngIf` is registered under several keys; only the first one survives deduplication.
    const ngIf = suggestions.find((suggestion) => suggestion.label === "ngIf");
    assert.ok(ngIf, `expected ngIf among ${labels(suggestions).join(", ")}`);
    assert.strictEqual(ngIf.element.name, "NgIf");
    assert.strictEqual(ngIf.element.isStandalone, true);
    assert.strictEqual(ngIf.element.isExternal, true);
    assert.strictEqual(ngIf.detail, "Angular Auto-Import: directive (standalone)");
  });

  it("boosts a directive whose class name matches the attribute it offers", () => {
    const conditionDirective = (name: string) =>
      element({ name, type: "directive", originalSelector: "[ngIf]", selectors: ["[ngIf]"] });

    const withUnrelatedName = buildCompletionSuggestions(
      sourceOf({ selector: "[ngIf]", element: conditionDirective("LegacyConditionDirective") }),
      contextAt("<div *ngIf¦")
    );
    const withMatchingName = buildCompletionSuggestions(
      sourceOf({ selector: "[ngIf]", element: conditionDirective("NgIfDirective") }),
      contextAt("<div *ngIf¦")
    );

    // Measured against the built-in `ngIf`, which always scores 3: an unrelated class name
    // ranks below it, and the class-name boost lifts the indexed directive level with it.
    assert.ok(
      sortTextOfElement(withUnrelatedName, "NgIf") < sortTextOfElement(withUnrelatedName, "LegacyConditionDirective")
    );
    assert.strictEqual(
      sortTextOfElement(withMatchingName, "NgIfDirective"),
      sortTextOfElement(withMatchingName, "NgIf")
    );
  });

  it("documents how an element reaches the template", () => {
    const standalone = element({ name: "StandaloneComponent", selectors: ["app-standalone"] });
    const viaModule = element({
      name: "ModuleComponent",
      path: "./src/app/module",
      selectors: ["app-module"],
      isStandalone: false,
      exportingModuleName: "SharedModule",
    });

    const [standaloneSuggestion] = buildCompletionSuggestions(
      sourceOf({ selector: "app-standalone", element: standalone }),
      contextAt("<app-stand¦")
    );
    const [moduleSuggestion] = buildCompletionSuggestions(
      sourceOf({ selector: "app-module", element: viaModule }),
      contextAt("<app-mod¦")
    );

    assert.strictEqual(standaloneSuggestion.detail, "Angular Auto-Import: standalone component");
    assert.ok(standaloneSuggestion.documentation.includes("✅ Import standalone `StandaloneComponent`"));
    assert.strictEqual(moduleSuggestion.detail, "Angular Auto-Import: from SharedModule");
    assert.ok(moduleSuggestion.documentation.includes("via `SharedModule` module"));
  });

  it("carries the context replacement range onto every suggestion", () => {
    const card = element({ name: "CardComponent", originalSelector: "app-card", selectors: ["app-card"] });
    const context = contextAt("<app-ca¦rd");

    const suggestions = buildCompletionSuggestions(sourceOf({ selector: "app-card", element: card }), context);

    assert.deepStrictEqual(suggestions[0].replacementRange, context.replacementRange);
    assert.deepStrictEqual(suggestions[0].replacementRange, {
      start: { line: 0, character: 1 },
      end: { line: 0, character: 9 },
    });
  });
});
