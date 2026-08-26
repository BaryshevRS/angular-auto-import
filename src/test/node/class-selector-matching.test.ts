/**
 * What a class on an element decides, through the whole path rather than at one function.
 *
 * The unit table in `selector-rules.test.ts` hands `findMissingImports` an element it
 * built itself, which is the wrong instrument for this question: what a class does
 * depends on what the scan put in the element, and on whether the index answers the keys
 * the scan asks with. Both were wrong in ways a hand-built element cannot show — a bound
 * `[class]` reaching the matcher as three invented classes, and a token that the scan
 * names `class` rather than after the directive.
 *
 * So every case here starts at `parseTemplate`, runs the real `scanTemplate`, and asks an
 * index keyed the way the indexer keys one — by `parseAngularSelector`, not by the
 * selector as written.
 * @module
 */

import * as assert from "node:assert";
import { Project } from "ts-morph";
import { TextDocument } from "vscode-languageserver-textdocument";
import { type AngularCompilerApi, adoptAngularCompiler, PARSE_OPTIONS } from "../../core/angular-compiler";
import { ComponentImports, type ModuleExportsIndex } from "../../core/component-imports";
import { findMissingImports } from "../../core/missing-imports";
import { createMissingImportContext, type DiagnosticIndex } from "../../core/template-diagnostics";
import { scanTemplate, type TemplateAstConstructors } from "../../core/template-scan";
import type { TemplateAstNode } from "../../types";
import { AngularElementData } from "../../types";
import { parseAngularSelector } from "../../utils/angular";

type ParseTemplate = (text: string, url: string, options: typeof PARSE_OPTIONS) => { nodes: TemplateAstNode[] };

let compiler: AngularCompilerApi;
let parseTemplate: ParseTemplate;
let constructors: TemplateAstConstructors;

/**
 * Reports what the analysis says about one template, given one directive in the index.
 * @param template The template, as a user would write it.
 * @param selector The single directive the index holds.
 * @returns The selectors reported as missing, in order.
 */
async function report(template: string, selector: string): Promise<string[]> {
  const element = new AngularElementData({
    path: "@probe/directive",
    name: "ProbeDirective",
    type: "directive",
    originalSelector: selector,
    selectors: await parseAngularSelector(selector),
    isStandalone: true,
    isExternal: true,
  });

  // The scan asks by key, exactly as it asks the real indexer, so a case only reaches the
  // matcher when production would have reached it too.
  const keys = new Set(element.selectors);
  const lookup = { getElements: (key: string) => (keys.has(key) ? [element] : []) };

  const document = TextDocument.create("file:///project/src/app.component.html", "html", 1, template);
  const parsed = parseTemplate(template, "app.component.html", PARSE_OPTIONS);
  const scanned = scanTemplate({
    nodes: parsed.nodes,
    document,
    offset: 0,
    text: template,
    lookup,
    constructors,
  });

  // Keyed the same way, because the diagnostics ask it by token: with an index that
  // answers everything, `<div foo class="x">` reports twice — once for `foo` and once
  // for a `class` token no real index holds anything under.
  const index = {
    getElements: (key: string) => (keys.has(key) ? [element] : []),
    getExternalModuleExports: () => undefined,
  } as unknown as DiagnosticIndex;
  const componentImports = new ComponentImports({ resolveIndex: () => index as unknown as ModuleExportsIndex });
  componentImports.isImported = () => false;

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile("/project/src/app.component.ts", "export class Host {}", {
    overwrite: true,
  });

  return findMissingImports(
    scanned,
    "warning",
    createMissingImportContext({ index, componentImports, sourceFile, compiler })
  ).map((diagnostic) => diagnostic.code.slice(diagnostic.code.indexOf(":") + 1));
}

describe("Class selectors, through the scan", function () {
  this.timeout(20000);

  before(async () => {
    const angular = (await import("@angular/compiler")) as unknown as Record<string, unknown>;
    compiler = adoptAngularCompiler(angular);
    parseTemplate = angular.parseTemplate as ParseTemplate;
    constructors = {
      tmplAstElement: angular.TmplAstElement,
      tmplAstTemplate: angular.TmplAstTemplate,
      tmplAstBoundEvent: angular.TmplAstBoundEvent,
      tmplAstReference: angular.TmplAstReference,
      tmplAstBoundAttribute: angular.TmplAstBoundAttribute,
      tmplAstBoundText: angular.TmplAstBoundText,
      tmplAstTextAttribute: angular.TmplAstTextAttribute,
      bindingType: angular.BindingType,
      recursiveAstVisitor: angular.RecursiveAstVisitor,
    } as TemplateAstConstructors;
  });

  const Excluded = "[foo]:not(.disabled)";

  it("says nothing when the element carries the class the selector excludes", async () => {
    assert.deepStrictEqual(await report('<div foo class="disabled">x</div>', Excluded), []);
  });

  it("reports it when the element carries some other class", async () => {
    assert.deepStrictEqual(await report('<div foo class="enabled">x</div>', Excluded), [Excluded]);
  });

  it("reports it when the element carries no class at all", async () => {
    assert.deepStrictEqual(await report("<div foo>x</div>", Excluded), [Excluded]);
  });

  it("reads the excluded class out of a list rather than out of the whole attribute", async () => {
    assert.deepStrictEqual(await report('<div foo class="a disabled b">x</div>', Excluded), []);
  });

  it("takes no classes from a bound [class], which selects no directive", async () => {
    // Angular decides which directives apply before any expression has a value, so a
    // computed class excludes nothing. The value the scan keeps for a bound attribute is
    // the expression's own `toString` — `"disabled in app.component.html@0:11"` — and
    // splitting that on whitespace would invent three classes and silence a real report.
    assert.deepStrictEqual(await report('<div foo [class]="disabled">x</div>', Excluded), [Excluded]);
  });

  it("takes none from [class.disabled] either", async () => {
    assert.deepStrictEqual(await report('<div foo [class.disabled]="on">x</div>', Excluded), [Excluded]);
  });

  it("matches a class the selector asks for outright", async () => {
    // Reported under the matcher's own spelling of the selector, which puts the class first.
    assert.deepStrictEqual(await report('<div foo class="ant">x</div>', "[foo].ant"), [".ant[foo]"]);
    assert.deepStrictEqual(await report('<div foo class="other">x</div>', "[foo].ant"), []);
  });

  it("never gets as far as the class on a known HTML tag, whatever the class says", async () => {
    // Not an endorsement, a boundary. `th:not(.nz-disable-th)` — one of the four
    // class-bearing selectors in the v22 fixture's dependencies — is indexed under `th`
    // and under itself, while a known HTML tag is only ever looked up by compound
    // selectors: `th[class]`, which nothing holds. So the directive never reaches the
    // matcher and the class decides nothing, in either direction.
    //
    // If this ever starts reporting, the lookup for known tags has changed and the class
    // rule above became load-bearing for tag selectors too, which is worth knowing.
    assert.deepStrictEqual(await report('<th class="nz-disable-th">x</th>', "th:not(.nz-disable-th)"), []);
    assert.deepStrictEqual(await report('<th class="other">x</th>', "th:not(.nz-disable-th)"), []);
  });

  it("takes no class from the element a structural directive is written on", async () => {
    // `<div *foo class="disabled">` parses into a synthetic template that keeps the
    // div's own attributes. Angular matches that template against its `templateAttrs`
    // alone, so `*foo` is decided without the class — and the directive does apply,
    // which makes the import missing.
    assert.deepStrictEqual(await report('<div *foo class="disabled">x</div>', Excluded), [Excluded]);
  });

  it("still takes the class of a written-out ng-template", async () => {
    // The other side of the same rule: here `tagName` is `ng-template`, the attributes
    // are the template's own, and the class excludes the directive as it should.
    assert.deepStrictEqual(await report('<ng-template foo class="disabled">x</ng-template>', Excluded), []);
    assert.deepStrictEqual(await report('<ng-template foo class="other">x</ng-template>', Excluded), [Excluded]);
  });

  it("does not mistake a reference spelled #class for one", async () => {
    // `#class="disabled"` is a template reference whose name and value are both plain
    // strings; only the node's kind tells it apart from the attribute it looks like.
    assert.deepStrictEqual(await report('<div foo #class="disabled">x</div>', Excluded), [Excluded]);
  });

  it("loses the static class to a full [class] binding, which overwrites it", async () => {
    // `getAttrsForDirectiveMatching` folds the node into one map and the binding is
    // written after the attribute, with an empty value. The compiler's own
    // `createCssSelectorFromNode` returns `classNames: [""]` here — no class at all — so
    // the directive applies and the import is missing.
    assert.deepStrictEqual(await report('<div foo class="disabled" [class]="classes">x</div>', Excluded), [Excluded]);
  });

  it("loses it to a two-way [(class)] as well", async () => {
    assert.deepStrictEqual(await report('<div foo class="disabled" [(class)]="classes">x</div>', Excluded), [Excluded]);
  });

  it("keeps it beside a [class.x] binding, which overwrites nothing", async () => {
    // `[class.disabled]` is a class binding named `disabled`, not a property binding
    // named `class`, so it never reaches the attribute the static classes come from.
    // Only the binding kind tells the two apart: `[class.class]` would be named `class`.
    assert.deepStrictEqual(await report('<div foo class="disabled" [class.disabled]="on">x</div>', Excluded), []);
  });
});
