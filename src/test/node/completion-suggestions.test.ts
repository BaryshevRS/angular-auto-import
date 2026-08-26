import * as assert from "node:assert";
import { TextDocument } from "vscode-languageserver-textdocument";
import { detectCompletionContext } from "../../core/completion-context";
import {
  buildCompletionSuggestions,
  byCompletionOrder,
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

/**
 * An element as the index really holds one.
 *
 * `selectors` are the variants the index derives from `originalSelector`, in all three
 * places elements are built, so a fixture that overrides one without the other
 * describes something that cannot exist — and the ranking, which reads a variant
 * against the selector it came from, would be asked a question with no honest answer.
 */
function element(overrides: Partial<ConstructorParameters<typeof AngularElementData>[0]>): AngularElementData {
  const selectors = overrides.selectors ?? ["ui-element"];
  return new AngularElementData({
    path: "./src/app/ui",
    name: "UiElement",
    type: "component",
    originalSelector: selectors[0],
    selectors,
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

  describe("a directive scoped to one tag", () => {
    // The index registers `button[matButton]` under the full selector and under the
    // bare attribute, which is the shape every Material directive of this kind has.
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

    it("offers the attribute alone, not the tag it is scoped to", () => {
      // Space is a completion trigger, so this is the state the list opens in. Offering
      // the whole selector here wrote `<button button[matButton]` on accept.
      for (const template of ["<button ¦", "<button m¦", "<div ¦"]) {
        const [suggestion] = buildCompletionSuggestions(source, contextAt(template)).filter(
          (candidate) => candidate.element.name === "ScopedDirective"
        );
        assert.ok(suggestion, `nothing offered for ${template}`);
        assert.strictEqual(suggestion.insertText, "matButton", `for ${template}`);
        assert.strictEqual(suggestion.label, "matButton", `for ${template}`);
      }
    });

    it("ranks it above a generic attribute directive, and keeps doing so while typing", () => {
      // The boost used to be tested against the one selector being evaluated, so it
      // applied only while the filter was empty — and vanished at the first keystroke,
      // which is when ranking starts to matter.
      for (const template of ["<button ¦", "<button m¦"]) {
        const suggestions = buildCompletionSuggestions(source, contextAt(template));
        assert.ok(
          sortTextOf(suggestions, "matButton") < sortTextOf(suggestions, "matBadge"),
          `the tag-scoped directive must rank first for ${template}`
        );
      }
    });

    it("is offered at all when every selector it has is scoped to a tag", () => {
      // The bare variant the index derives — `matButton` — reads exactly like a tag
      // name. Classified as one, it was only ever considered in tag context, so a
      // directive written this way was never offered anywhere, while the diagnostic
      // for the very same directive worked.
      const onlyScoped = element({
        name: "OnlyScopedDirective",
        type: "directive",
        originalSelector: "ng-template[jupiterTemplateRow]",
        selectors: ["ng-template[jupiterTemplateRow]", "jupiterTemplateRow", "[jupiterTemplateRow]"],
      });
      const scopedSource = sourceOf({ selector: "jupiterTemplateRow", element: onlyScoped });

      const suggestions = buildCompletionSuggestions(scopedSource, contextAt("<ng-template jupiterTem¦"));

      assert.deepStrictEqual(labels(suggestions), ["jupiterTemplateRow"]);
    });

    it("keeps a genuine element selector out of attribute context", () => {
      // `jupiter-table, table[jupiter-table]` names both. The tag variant must stay a
      // tag: widening the attribute rule must not turn every component into one.
      const both = element({
        name: "TableDirective",
        type: "directive",
        originalSelector: "jupiter-table, table[jupiter-table]",
        selectors: ["jupiter-table", "table[jupiter-table]"],
      });
      const bothSource = sourceOf({ selector: "jupiter-table", element: both });

      assert.deepStrictEqual(labels(buildCompletionSuggestions(bothSource, contextAt("<jupiter-tab¦"))), [
        "jupiter-table",
      ]);
    });

    it("keeps the boost when the tag is hard to find on the line", () => {
      // The boost used to look for the `<` itself, which a bracket inside an earlier
      // attribute value answers wrongly and a tag opened on an earlier line does not
      // answer at all — dropping the boost exactly where the user has typed the most.
      for (const template of ['<button [title]="a < b" mat¦', ["<button", '  [title]="x"', "  mat¦"].join("\n")]) {
        const suggestions = buildCompletionSuggestions(source, contextAt(template));
        assert.ok(
          sortTextOf(suggestions, "matButton") < sortTextOf(suggestions, "matBadge"),
          `for ${JSON.stringify(template)}`
        );
      }
    });

    it("does not boost it inside a tag it is not scoped to", () => {
      const suggestions = buildCompletionSuggestions(source, contextAt("<div ¦"));

      assert.ok(sortTextOf(suggestions, "matBadge") < sortTextOf(suggestions, "matButton"));
    });
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

    // Measured against the built-in `ngIf`, which always scores 3: an unrelated class
    // name ranks below it, and the class-name boost lifts the indexed directive above
    // it. Both suggestions are ranked on one scale — encoding them from different bases
    // used to make these two scores collide and order the pair by nothing at all.
    assert.ok(
      sortTextOfElement(withUnrelatedName, "NgIf") < sortTextOfElement(withUnrelatedName, "LegacyConditionDirective")
    );
    assert.ok(
      sortTextOfElement(withMatchingName, "NgIfDirective") < sortTextOfElement(withMatchingName, "NgIf"),
      "a project directive named after the attribute it offers is the better answer"
    );
  });

  it("says two equally ranked suggestions are equal, rather than each greater", () => {
    // Two elements can share a selector, and then a key. Asserting on what a sort does
    // with a comparator that answers `greater` in both directions would prove nothing:
    // today's V8 leaves such a pair alone. The contract is what has to hold.
    const first = element({ name: "AlphaDirective", type: "directive", path: "./a", selectors: ["[shared]"] });
    const second = element({ name: "BetaDirective", type: "directive", path: "./b", selectors: ["[shared]"] });
    const source = sourceOf({ selector: "[shared]", element: first }, { selector: "[shared]", element: second });

    const [left, right] = buildCompletionSuggestions(source, contextAt("<div shar¦"));

    assert.strictEqual(left.sortText, right.sortText, "the case only bites when the keys are equal");
    assert.strictEqual(byCompletionOrder(left, right), 0);
    assert.strictEqual(byCompletionOrder(right, left), 0);
    assert.strictEqual(byCompletionOrder(left, left), 0);
  });

  it("hands out suggestions in the order the editor will show them", () => {
    // `sortText` is a key an editor compares ordinally. Sorting it by locale collation
    // produced a list in one order and displayed it in another, which is invisible to a
    // user and misleading to everything else.
    const suggestions = buildCompletionSuggestions(emptySource, contextAt("<div *ng¦"));

    const keys = suggestions.map((suggestion) => suggestion.sortText);
    assert.deepStrictEqual(keys, [...keys].sort(), "the array handed out must already be in sortText order");
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
