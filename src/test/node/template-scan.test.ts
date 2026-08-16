import * as assert from "node:assert";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  type ScannedTemplateElement,
  scanTemplate,
  type TemplateAstConstructors,
  type TemplateElementLookup,
} from "../../core/template-scan";
import type { TemplateAstNode } from "../../types";
import { AngularElementData } from "../../types";

/** The template parser, as the provider calls it. */
type ParseTemplate = (
  text: string,
  url: string,
  options: { alwaysAttemptHtmlToR3AstConversion: boolean; collectCommentNodes: boolean }
) => { nodes: TemplateAstNode[] };

let parseTemplate: ParseTemplate;
let constructors: TemplateAstConstructors;

/** Indexes the given selectors as components, mirroring what the real indexer returns. */
function lookupOf(...selectors: string[]): TemplateElementLookup {
  const known = new Set(selectors);
  return {
    getElements: (selector) =>
      known.has(selector)
        ? [
            new AngularElementData({
              path: "./src/app/indexed",
              name: "IndexedComponent",
              type: "component",
              originalSelector: selector,
              selectors: [selector],
              isStandalone: true,
              isExternal: false,
            }),
          ]
        : [],
  };
}

function scan(template: string, lookup: TemplateElementLookup = lookupOf()): ScannedTemplateElement[] {
  const document = TextDocument.create("file:///project/src/app.component.html", "html", 1, template);
  const parsed = parseTemplate(template, "app.component.html", {
    alwaysAttemptHtmlToR3AstConversion: true,
    collectCommentNodes: true,
  });

  return scanTemplate({ nodes: parsed.nodes, document, offset: 0, text: template, lookup, constructors });
}

function named(elements: ScannedTemplateElement[], name: string): ScannedTemplateElement[] {
  return elements.filter((element) => element.name === name);
}

function textOf(template: string, element: ScannedTemplateElement): string {
  const document = TextDocument.create("file:///project/src/app.component.html", "html", 1, template);
  return document.getText({ start: element.range.start, end: element.range.end });
}

describe("Template scan", () => {
  before(async () => {
    const angular = (await import("@angular/compiler")) as unknown as Record<string, unknown>;
    parseTemplate = angular.parseTemplate as ParseTemplate;
    constructors = {
      tmplAstElement: angular.TmplAstElement,
      tmplAstTemplate: angular.TmplAstTemplate,
      tmplAstBoundEvent: angular.TmplAstBoundEvent,
      tmplAstReference: angular.TmplAstReference,
      tmplAstBoundAttribute: angular.TmplAstBoundAttribute,
      tmplAstBoundText: angular.TmplAstBoundText,
    } as TemplateAstConstructors;
  });

  it("records an indexed component tag with the range of its opening tag", () => {
    const template = '<div>\n  <app-card [title]="t"></app-card>\n</div>';

    const elements = scan(template, lookupOf("app-card"));

    const [card] = named(elements, "app-card");
    assert.ok(card, "expected the indexed tag to be reported");
    assert.strictEqual(card.type, "component");
    assert.strictEqual(card.isAttribute, false);
    assert.strictEqual(textOf(template, card), '<app-card [title]="t">');
  });

  it("ignores plain HTML tags that the index does not know", () => {
    const elements = scan("<div><span>text</span></div>", lookupOf("app-card"));

    assert.deepStrictEqual(named(elements, "div"), []);
    assert.deepStrictEqual(named(elements, "span"), []);
  });

  it("reports a directive on a known HTML tag at the attribute, not the tag", () => {
    const template = '<button mat-button type="button">Go</button>';

    const elements = scan(template, lookupOf("button[mat-button]"));

    const [directive] = named(elements, "mat-button").filter((element) => element.tagName === "button");
    assert.ok(directive, "expected the compound selector to be reported");
    assert.strictEqual(directive.isAttribute, true);
    assert.strictEqual(textOf(template, directive), "mat-button");
  });

  it("classifies attributes, property bindings, structural directives, and references", () => {
    const template = '<div appPlain [appBound]="x" *appStructural="y" #ref></div>';

    const elements = scan(template);

    assert.strictEqual(named(elements, "appPlain")[0]?.type, "attribute");
    assert.strictEqual(named(elements, "appBound")[0]?.type, "property-binding");
    assert.strictEqual(named(elements, "appStructural")[0]?.type, "structural-directive");
    assert.strictEqual(named(elements, "ref")[0]?.type, "template-reference");
  });

  it("skips event bindings, which can never be imported", () => {
    const elements = scan('<div (click)="go()"></div>');

    assert.deepStrictEqual(named(elements, "click"), []);
  });

  it("finds pipes in interpolations, bound values, and control flow expressions", () => {
    const template = [
      "{{ value | truncate }}",
      '<div [title]="name | titlecase"></div>',
      "@if (items | slice) { <span>{{ n | number }}</span> }",
    ].join("\n");

    const elements = scan(template);

    for (const pipeName of ["truncate", "titlecase", "slice", "number"]) {
      const [pipe] = named(elements, pipeName);
      assert.ok(pipe, `expected the ${pipeName} pipe to be reported`);
      assert.strictEqual(pipe.type, "pipe");
      assert.strictEqual(pipe.tagName, "pipe");
      assert.strictEqual(textOf(template, pipe), pipeName);
    }
  });

  it("walks into control flow blocks and their alternative branches", () => {
    const template = [
      "@if (ready) {",
      "  <app-card />",
      "} @else {",
      "  <app-fallback />",
      "}",
      "@for (item of items; track item) {",
      "  <app-row />",
      "} @empty {",
      "  <app-none />",
      "}",
    ].join("\n");

    const elements = scan(template, lookupOf("app-card", "app-fallback", "app-row", "app-none"));

    for (const tag of ["app-card", "app-fallback", "app-row", "app-none"]) {
      assert.strictEqual(named(elements, tag).length, 1, `expected ${tag} to be reported once`);
    }
  });

  it("reports elements nested in a @defer block and its placeholder", () => {
    const template = ["@defer {", "  <app-heavy />", "} @placeholder {", "  <app-skeleton />", "}"].join("\n");

    const elements = scan(template, lookupOf("app-heavy", "app-skeleton"));

    assert.strictEqual(named(elements, "app-heavy").length, 1);
    assert.strictEqual(named(elements, "app-skeleton").length, 1);
  });

  it("treats ng-template as its own tag and keeps its structural attributes", () => {
    const elements = scan('<ng-template [ngIf]="ready"><span>ok</span></ng-template>');

    const [binding] = named(elements, "ngIf");
    assert.ok(binding);
    assert.strictEqual(binding.tagName, "ng-template");
  });

  it("offsets every range by the template's position inside its document", () => {
    const template = "<app-card></app-card>";
    const componentFile = `@Component({ template: \`${template}\` })\nclass C {}`;
    const offset = componentFile.indexOf(template);
    const document = TextDocument.create("file:///project/src/app.component.ts", "typescript", 1, componentFile);
    const parsed = parseTemplate(template, "app.component.ts", {
      alwaysAttemptHtmlToR3AstConversion: true,
      collectCommentNodes: true,
    });

    const elements = scanTemplate({
      nodes: parsed.nodes,
      document,
      offset,
      text: template,
      lookup: lookupOf("app-card"),
      constructors,
    });

    const [card] = named(elements, "app-card");
    assert.ok(card);
    assert.strictEqual(document.getText({ start: card.range.start, end: card.range.end }), "<app-card>");
  });

  it("carries the element's own attributes so selector matching can use them", () => {
    const elements = scan('<app-card title="hello" [subtitle]="sub"></app-card>', lookupOf("app-card"));

    const [card] = named(elements, "app-card");
    assert.ok(card);
    assert.deepStrictEqual(
      card.attributes.map((attribute) => attribute.name),
      ["title", "subtitle"]
    );
  });
});
