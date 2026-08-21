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
      recursiveAstVisitor: angular.RecursiveAstVisitor,
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

  it("does not mistake the second bar of a logical OR for a pipe", () => {
    // Both halves have to coincide for this to have been visible: an expression with
    // `||`, and an identifier after it that names a pipe the project really declares.
    const template = "@if (access().canEdit || access().canShare) {\n  <div></div>\n}";

    const elements = scan(template);

    assert.deepStrictEqual(
      elements.filter((element) => element.type === "pipe"),
      [],
      "`||` is an operator; nothing after it is a pipe"
    );
  });

  it("does not read a bar inside a string literal as a pipe", () => {
    const template = ["<div [title]=\"'a|access'\"></div>", "{{ 'x|access' }}"].join("\n");

    const elements = scan(template);

    assert.deepStrictEqual(
      elements.filter((element) => element.type === "pipe"),
      [],
      "A bar inside a string is part of the string"
    );
  });

  it("still finds a real pipe beside an expression that only looks like one", () => {
    const template = '<div [title]="(a || b) | titlecase"></div>';

    const elements = scan(template);

    const pipes = elements.filter((element) => element.type === "pipe");
    assert.deepStrictEqual(
      pipes.map((pipe) => pipe.name),
      ["titlecase"]
    );
    assert.strictEqual(textOf(template, pipes[0]), "titlecase", "and its range still covers the name alone");
  });

  it("keeps the range on the real pipe when the same name also follows a logical OR", () => {
    const template = '<div [title]="(a || access) ? x : (y | access)"></div>';

    const elements = scan(template);

    const pipes = elements.filter((element) => element.type === "pipe");
    assert.strictEqual(pipes.length, 1, "only one of the two is a pipe");
    assert.strictEqual(textOf(template, pipes[0]), "access");
    assert.strictEqual(
      template.slice(0, pipes[0].range.start.character).endsWith("(y | "),
      true,
      "and it is the one after the single bar, not the one after ||"
    );
  });

  it("keeps the range on the real pipe when the same name also appears inside a string", () => {
    // Names alone cannot separate these two: both spell `access`, and only their
    // positions differ. The range has to come from the parsed node, not from a search.
    const template = "{{ 'x|access' + (value | access) }}";

    const elements = scan(template);

    const pipes = elements.filter((element) => element.type === "pipe");
    assert.strictEqual(pipes.length, 1, "the one in the string is not a pipe");
    assert.strictEqual(
      template.slice(0, pipes[0].range.start.character).endsWith("(value | "),
      true,
      "and the range is on the real one, not on the text inside the quotes"
    );
  });

  it("keeps track of an escaped quote while skipping a string", () => {
    const template = `<div [title]="'it\\'s a|access' + (v | access)"></div>`;

    const elements = scan(template);

    const pipes = elements.filter((element) => element.type === "pipe");
    assert.strictEqual(pipes.length, 1, "the escaped quote does not end the string early");
    assert.strictEqual(template.slice(0, pipes[0].range.start.character).endsWith("(v | "), true);
  });

  it("places a pipe correctly when the expression is indented", () => {
    // The parser measures a pipe against the slice it was handed, which for an indented
    // interpolation does not start where the node does.
    const template = "<p>x</p>\n  {{ '123' | bytes }}\n";

    const elements = scan(template);

    const [pipe] = elements.filter((element) => element.type === "pipe");
    assert.ok(pipe, "expected the pipe to be reported");
    assert.strictEqual(textOf(template, pipe), "bytes");
  });

  it("finds a pipe applied to the argument of another pipe", () => {
    const template = "{{ value | slice: (other | number) }}";

    const elements = scan(template);

    assert.deepStrictEqual(
      elements
        .filter((element) => element.type === "pipe")
        .map((pipe) => pipe.name)
        .sort(),
      ["number", "slice"],
      "the walk has to descend into a pipe's own arguments"
    );
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
