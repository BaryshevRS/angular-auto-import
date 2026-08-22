// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the Angular templates under test contain JavaScript template literals.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { PARSE_OPTIONS } from "../../core/angular-compiler";
import {
  type ScannedTemplateElement,
  scanTemplate,
  type TemplateAstConstructors,
  type TemplateElementLookup,
} from "../../core/template-scan";
import type { TemplateAstNode } from "../../types";
import { AngularElementData } from "../../types";

/** The template parser, as the server calls it. */
type ParseTemplate = (text: string, url: string, options: typeof PARSE_OPTIONS) => { nodes: TemplateAstNode[] };

let parseTemplate: ParseTemplate;
let constructors: TemplateAstConstructors;
let recursiveAstVisitor: RecursiveAstVisitorClass;
let combinedAstVisitor: CombinedAstVisitorClass;
let tmplAstVisitAll: (visitor: unknown, nodes: TemplateAstNode[]) => void;

/**
 * The compiler's own walk over a whole template — nodes and the expressions inside
 * them. Using it rather than a walk written here is what makes the corpus check an
 * independent answer instead of a second copy of the one being tested.
 */
type CombinedAstVisitorClass = new () => {
  visitPipe(pipe: { name: string; nameSpan: { start: number } }): void;
};

/** The compiler's expression walker, used here as the oracle the scan is checked against. */
type RecursiveAstVisitorClass = new () => {
  visitPipe(pipe: { name: string }, context: unknown): void;
};

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
  const parsed = parseTemplate(template, "app.component.html", PARSE_OPTIONS);

  return scanTemplate({ nodes: parsed.nodes, document, offset: 0, text: template, lookup, constructors });
}

function named(elements: ScannedTemplateElement[], name: string): ScannedTemplateElement[] {
  return elements.filter((element) => element.name === name);
}

function textOf(template: string, element: ScannedTemplateElement): string {
  const document = TextDocument.create("file:///project/src/app.component.html", "html", 1, template);
  return document.getText({ start: element.range.start, end: element.range.end });
}

/** Every `.html` template under a fixture project. */
function collectTemplates(root: string): string[] {
  const found: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const directory = pending.pop() as string;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.name.endsWith(".html")) {
        found.push(entryPath);
      }
    }
  }
  return found;
}

/**
 * Where the compiler's own walk reports a pipe, as `name@offset`, in document order.
 *
 * The walk reaches a chain outwards — `v | first | second` gives `second` first — so the
 * sites are ordered by offset here, which is what document order means.
 */
function compilerPipeSites(nodes: TemplateAstNode[]): string[] {
  const found: Array<{ name: string; start: number }> = [];
  const Base = combinedAstVisitor;
  const collector = new (class extends Base {
    override visitPipe(pipe: { name: string; nameSpan: { start: number } }): void {
      found.push({ name: pipe.name, start: pipe.nameSpan.start });
      super.visitPipe(pipe);
    }
  })();

  tmplAstVisitAll(collector, nodes);
  return found.sort((left, right) => left.start - right.start).map((pipe) => `${pipe.name}@${pipe.start}`);
}

/** The repository root, so the fixtures are read from the source tree. */
function findRepositoryRoot(from: string): string {
  let directory = from;
  while (!fs.existsSync(path.join(directory, "package.json"))) {
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`No package.json above ${from}`);
    }
    directory = parent;
  }
  return directory;
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
    recursiveAstVisitor = angular.RecursiveAstVisitor as RecursiveAstVisitorClass;
    combinedAstVisitor = angular.CombinedRecursiveAstVisitor as CombinedAstVisitorClass;
    tmplAstVisitAll = angular.tmplAstVisitAll as typeof tmplAstVisitAll;
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

  it("finds a pipe inside a template literal's interpolation", () => {
    // A backtick literal is text, except in its `${…}` holes, which are expressions.
    const template = "{{ `x ${value | access}` }}";

    const elements = scan(template);

    const pipes = elements.filter((element) => element.type === "pipe");
    assert.strictEqual(pipes.length, 1, "the hole is an expression and holds a real pipe");
    assert.strictEqual(textOf(template, pipes[0]), "access");
  });

  it("reads a bar in a template literal's text as text", () => {
    const template = "{{ `a|access` }}";

    const elements = scan(template);

    assert.deepStrictEqual(
      elements.filter((element) => element.type === "pipe"),
      []
    );
  });

  it("descends into a template literal nested inside another one", () => {
    const template = "{{ `outer ${ `inner ${v | access}` }` }}";

    const elements = scan(template);

    const pipes = elements.filter((element) => element.type === "pipe");
    assert.strictEqual(pipes.length, 1);
    assert.strictEqual(textOf(template, pipes[0]), "access");
  });

  it("reads a bar inside a regular expression literal as part of the pattern", () => {
    const template = "{{ /x|access/.test(v) + (v | access) }}";

    const elements = scan(template);

    const pipes = elements.filter((element) => element.type === "pipe");
    assert.strictEqual(pipes.length, 1, "alternation inside a regular expression is not a pipe");
    assert.strictEqual(
      template.slice(0, pipes[0].range.start.character).endsWith("(v | "),
      true,
      "and the range is on the real pipe, not inside the pattern"
    );
  });

  it("does not end a regular expression at a slash inside a character class", () => {
    const template = "{{ /[/x]|access/.test(v) + (v | access) }}";

    const elements = scan(template);

    assert.strictEqual(elements.filter((element) => element.type === "pipe").length, 1);
  });

  it("treats a slash after a value as division rather than a pattern", () => {
    const template = "{{ a / b | access }}";

    const elements = scan(template);

    const pipes = elements.filter((element) => element.type === "pipe");
    assert.strictEqual(pipes.length, 1, "the division must not swallow the rest as a pattern");
    assert.strictEqual(textOf(template, pipes[0]), "access");
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

  it("returns a chain of pipes in document order", () => {
    // A chain parses outwards, so the walk reaches the last one first. The contract of
    // `scanTemplate` is document order, and nothing here sorts to hide the difference.
    const template = "{{ v | first | second | third }}";

    const elements = scan(template);

    assert.deepStrictEqual(
      elements.filter((element) => element.type === "pipe").map((element) => element.name),
      ["first", "second", "third"]
    );
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
    const parsed = parseTemplate(template, "app.component.ts", PARSE_OPTIONS);

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

  describe("agreeing with the parser about what a bar means", () => {
    /**
     * A bar is a pipe operator only outside literals, and only when it is not `||`.
     * Each of these is checked against the parser's own answer rather than against a
     * hand-written expectation, so a new lexical corner cannot be got wrong quietly —
     * which is how the last three were found, one report at a time.
     */
    const expressions = [
      "v | access",
      "'x|access'",
      "`x|access`",
      "/x|access/.test(v)",
      "a || access",
      "'x|access' + (v | access)",
      "`x ${v | access}`",
      '`x ${"}" + (v | access)}`',
      "`x ${ {a:1} }` + (v | access)",
      "/x/ / y | access",
      "{a: 1} / y | access",
      "a / b | access",
      "(a || access) ? x : (y | access)",
      "v | access : 'a|b'",
      "`${ `${ v | access }` }`",
      "[1,2] / 3 | access",
      "f() / 2 | access",
      "'it\\'s a|access' + (v | access)",
      "/[/x]|access/.test(v) + (v | access)",
      "v | access | access",
      "obj.x | access",
      "(v) | access",
      "`a` + /b/ + (v | access)",
      "x ? /a|b/ : (v | access)",
      "'' | access",
      "x! / y | access",
      "!x / y | access",
      "1. / y | access",
      "1.5e-3 / y | access",
      ".5 / y | access",
      "a?.b / y | access",
      "typeof x / y | access",
      "(a as string) | access",
      "x?.[0] / y | access",
    ];

    /** The pipes the compiler itself found in an interpolation. */
    function parserPipes(template: string): string[] {
      const parsed = parseTemplate(template, "app.component.html", PARSE_OPTIONS);
      const found: string[] = [];
      const visitor = new recursiveAstVisitor();
      const walkChildren = visitor.visitPipe.bind(visitor);
      visitor.visitPipe = (pipe, visitContext) => {
        found.push(pipe.name);
        walkChildren(pipe, visitContext);
      };

      for (const node of parsed.nodes as Array<{ value?: { visit?: (v: unknown, c: unknown) => void } }>) {
        node.value?.visit?.(visitor, null);
      }
      return found.sort();
    }

    it("reports the same pipes, at the same offsets, as the compiler does for every fixture template", () => {
      // The list above names corners that were once got wrong; this needs no one to name
      // them. `CombinedRecursiveAstVisitor` is the compiler's own walk over a template
      // and the expressions in it, so the comparison is against Angular rather than
      // against a second implementation of this file. The scan's side is not sorted
      // afterwards, so this pins the document order it promises as well as its contents.
      const root = path.join(findRepositoryRoot(__dirname), "src", "e2e", "projects", "v22");
      const templates = collectTemplates(root);
      assert.ok(templates.length > 20, `expected a corpus to compare against, found ${templates.length}`);

      const disagreements: string[] = [];
      let pipes = 0;

      for (const templatePath of templates) {
        const text = fs.readFileSync(templatePath, "utf8");
        const document = TextDocument.create("file:///project/app.component.html", "html", 1, text);
        const parsed = parseTemplate(text, "app.component.html", PARSE_OPTIONS);

        const scanned = scanTemplate({
          nodes: parsed.nodes,
          document,
          offset: 0,
          text,
          lookup: lookupOf(),
          constructors,
        })
          .filter((element) => element.type === "pipe")
          .map((element) => `${element.name}@${document.offsetAt(element.range.start)}`);

        const expected = compilerPipeSites(parsed.nodes);
        pipes += expected.length;

        if (JSON.stringify(scanned) !== JSON.stringify(expected)) {
          disagreements.push(`${path.relative(root, templatePath)}\n  scan:     ${scanned}\n  compiler: ${expected}`);
        }
      }

      assert.deepStrictEqual(disagreements, [], `The scan and the compiler disagree:\n${disagreements.join("\n")}`);
      assert.ok(pipes > 20, `expected the corpus to exercise pipes, found ${pipes}`);
    });

    for (const expression of expressions) {
      it(`reports the same pipes as the parser for ${expression}`, () => {
        const template = `{{ ${expression} }}`;

        const scanned = scan(template)
          .filter((element) => element.type === "pipe")
          .map((element) => element.name)
          .sort();

        assert.deepStrictEqual(scanned, parserPipes(template));
      });
    }
  });
});
