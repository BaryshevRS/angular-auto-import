/**
 * The selector rules, as a table rather than as anecdotes.
 *
 * Two questions decide what a template token reports, and both are about selectors alone:
 *
 * - **Is it missing?** An imported element answers for a token only when its selector
 *   demands the same thing — same tag, same attributes, same values, same `:not(...)`.
 *   Anything else is a different directive that merely also matches here.
 * - **Which one speaks for it?** One token is one marker: it goes to the selector that is
 *   exactly the attribute, then to the one that demands the most, then to the longer.
 *
 * Every pair is spelled out below because that is the point: each of these rules was
 * first written to fit one example and then found wrong by the next one, and a table is
 * what a reviewer can read instead of finding the next example.
 * @module
 */

import * as assert from "node:assert";
import { Project } from "ts-morph";
import { type AngularCompilerApi, adoptAngularCompiler } from "../../core/angular-compiler";
import { ComponentImports, type ModuleExportsIndex } from "../../core/component-imports";
import { findMissingImports, type MissingImportContext } from "../../core/missing-imports";
import { createMissingImportContext, type DiagnosticIndex } from "../../core/template-diagnostics";
import type { ScannedTemplateElement } from "../../core/template-scan";
import { AngularElementData } from "../../types";

/**
 * The selectors under test, each on its own directive.
 *
 * They all match `<button foo="check" bar>`, so any pair of them can be put to the same
 * token and the answer is about the rules rather than about what happened to match.
 */
const SELECTORS = [
  "[foo]",
  "button[foo]",
  "[foo=check]",
  "[foo]:not([disabled])",
  "[foo]:not([readonly])",
  "[foo]:not([disabled][readonly])",
  "[foo]:not([readonly][disabled])",
  "[foo][bar]",
  "[bar][foo]",
] as const;

type Selector = (typeof SELECTORS)[number];

/**
 * Which of them ask for the same thing.
 *
 * A selector is a conjunction, so the order it is written in says nothing:
 * `[foo][bar]` and `[bar][foo]` are one selector, and so are two `:not(...)` conditions
 * whose attributes are written the other way round. Two selectors answer for each other
 * exactly when they are in the same group here.
 */
const EQUIVALENT: Record<Selector, string> = {
  "[foo]": "attribute",
  "button[foo]": "tag and attribute",
  "[foo=check]": "attribute with a value",
  "[foo]:not([disabled])": "attribute, not disabled",
  "[foo]:not([readonly])": "attribute, not readonly",
  "[foo]:not([disabled][readonly])": "attribute, not both",
  "[foo]:not([readonly][disabled])": "attribute, not both",
  "[foo][bar]": "two attributes",
  "[bar][foo]": "two attributes",
};

/** The element every case is asked about: it matches all of the selectors above. */
const TOKEN = "foo";
const TAG = "button";
const ATTRIBUTES = [
  { name: "foo", value: "check" },
  { name: "bar", value: "" },
];

/** A directive answering to one selector, named so the name says nothing about the selector. */
function directiveFor(selector: string, token: string = TOKEN): AngularElementData {
  return new AngularElementData({
    path: `@matrix/${selector}`,
    name: `Directive_${selector.replace(/\W/g, "_")}`,
    type: "directive",
    originalSelector: selector,
    selectors: [selector, token, `[${token}]`],
    isStandalone: true,
    isExternal: true,
  });
}

describe("Selector rules", function () {
  this.timeout(20000);

  let compiler: AngularCompilerApi;

  before(async () => {
    compiler = adoptAngularCompiler(await import("@angular/compiler"));
  });

  /**
   * Runs the analysis over an index holding exactly the given selectors, with the given
   * ones already imported.
   * @param present The selectors the index knows about.
   * @param imported The subset of them the component imports.
   * @returns The diagnostic codes reported for the token, in order.
   */
  function report(
    present: readonly string[],
    imported: readonly string[],
    on: { token: string; tag: string; attributes: Array<{ name: string; value: string }> } = {
      token: TOKEN,
      tag: TAG,
      attributes: ATTRIBUTES,
    }
  ): string[] {
    const elements = present.map((selector) => directiveFor(selector, on.token));
    const importedNames = new Set(imported.map((selector) => directiveFor(selector, on.token).name));

    const index = { getElements: () => elements } as unknown as DiagnosticIndex;
    const componentImports = new ComponentImports({ resolveIndex: () => index as unknown as ModuleExportsIndex });
    componentImports.isImported = (_file, element) => importedNames.has(element.name);

    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("/matrix/host.component.ts", "export class Host {}", {
      overwrite: true,
    });

    const context: MissingImportContext = createMissingImportContext({
      index,
      componentImports,
      sourceFile,
      compiler,
    });

    const element: ScannedTemplateElement = {
      type: "attribute",
      name: on.token,
      isAttribute: true,
      tagName: on.tag,
      attributes: on.attributes,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: on.token.length } },
    };

    return findMissingImports([element], "warning", context).map((diagnostic) =>
      diagnostic.code.slice(diagnostic.code.indexOf(":") + 1)
    );
  }

  describe("what an imported element answers for", () => {
    // The whole table: for each missing selector, the imported ones that silence it.
    // Only a selector demanding the same thing does — written the same way or not.
    // Everything else is a different directive that happens to match the same element,
    // and Angular would apply both.
    for (const missing of SELECTORS) {
      for (const imported of SELECTORS) {
        const silenced = EQUIVALENT[imported] === EQUIVALENT[missing];

        it(`${missing} with ${imported} imported is ${silenced ? "silent" : "reported"}`, () => {
          assert.deepStrictEqual(report([missing, imported], [imported]), silenced ? [] : [missing]);
        });
      }
    }

    it("says nothing when the element that matches is imported and nothing else is known", () => {
      assert.deepStrictEqual(report(["[foo]"], ["[foo]"]), []);
    });

    it("reports a directive whose selector nothing imported repeats", () => {
      assert.deepStrictEqual(report(["button[foo]"], []), ["button[foo]"]);
    });

    it("tells apart conditions that ask for one name twice", () => {
      // `[foo=a][foo=b]` asks for an attribute to hold two values at once, so it excludes
      // nothing — but it is still its own directive, and folding it into `[foo=b]` would
      // let one answer for the other on `<div x foo="a">`, where Angular applies both.
      const twice = "[x]:not([foo=a][foo=b])";
      const once = "[x]:not([foo=b])";
      const onDiv = {
        token: "x",
        tag: "div",
        attributes: [
          { name: "x", value: "" },
          { name: "foo", value: "a" },
        ],
      };

      assert.deepStrictEqual(report([twice, once], [once], onDiv), [twice]);
      assert.deepStrictEqual(report([once, twice], [twice], onDiv), [once]);
    });

    it("tells apart conditions that only look alike once written as one string", () => {
      // `[b="c,foo=a"]` is one attribute whose value happens to contain the characters a
      // key would use as separators; `[b=c][foo=a]` is two attributes. Angular applies
      // both directives to `<div x>`, so importing either says nothing about the other.
      const oneAttribute = '[x]:not([b="c,foo=a"])';
      const twoAttributes = "[x]:not([b=c][foo=a])";
      const onDiv = { token: "x", tag: "div", attributes: [{ name: "x", value: "" }] };

      // The code carries the matcher's own spelling, which drops the quotes — which is
      // itself why comparing selectors as text is not enough to tell these two apart.
      assert.deepStrictEqual(report([oneAttribute, twoAttributes], [twoAttributes], onDiv), ["[x]:not([b=c,foo=a])"]);
      assert.deepStrictEqual(report([twoAttributes, oneAttribute], [oneAttribute], onDiv), ["[x]:not([b=c][foo=a])"]);
    });
  });

  describe("which selector speaks for the token", () => {
    // One marker per token. These say which selector it carries when several are missing.
    const markerCases: Array<{ missing: Selector[]; marker: Selector; because: string }> = [
      {
        missing: ["[foo]", "button[foo]", "[foo=check]", "[foo]:not([disabled])", "[foo][bar]"],
        marker: "[foo]",
        because: "a selector that is exactly the attribute is what the attribute is for",
      },
      {
        missing: ["button[foo]", "[foo=check]", "[foo]:not([disabled])", "[foo][bar]"],
        marker: "[foo][bar]",
        because: "failing that, the one that demands the most",
      },
      {
        missing: ["button[foo]", "[foo=check]", "[foo]:not([disabled])"],
        marker: "[foo]:not([disabled])",
        because: "demanding the same, the longer selector is the more particular one",
      },
      {
        missing: ["button[foo]", "[foo=check]"],
        marker: "[foo=check]",
        because: "a value is more particular than a tag at equal length",
      },
    ];

    for (const { missing, marker, because } of markerCases) {
      it(`gives it to ${marker} out of ${missing.length}: ${because}`, () => {
        assert.deepStrictEqual(report(missing, []), [marker]);
      });
    }

    it("moves the marker on when the selector that held it is imported", () => {
      assert.deepStrictEqual(report(["[foo]", "[foo][bar]"], ["[foo]"]), ["[foo][bar]"]);
    });
  });

  describe("what the class is called", () => {
    it("has no bearing on any of it", () => {
      const namedAfterTheToken = new AngularElementData({
        path: "@matrix/named",
        name: "FooDirective",
        type: "directive",
        originalSelector: "[foo]",
        selectors: ["[foo]", "foo"],
        isStandalone: true,
        isExternal: true,
      });
      const namedAnythingElse = new AngularElementData({
        path: "@matrix/other",
        name: "SomethingElse",
        type: "directive",
        originalSelector: "[foo]",
        selectors: ["[foo]", "foo"],
        isStandalone: true,
        isExternal: true,
      });

      for (const [imported, missing] of [
        [namedAfterTheToken, namedAnythingElse],
        [namedAnythingElse, namedAfterTheToken],
      ]) {
        const index = { getElements: () => [imported, missing] } as unknown as DiagnosticIndex;
        const componentImports = new ComponentImports({ resolveIndex: () => index as unknown as ModuleExportsIndex });
        componentImports.isImported = (_file, element) => element.name === imported.name;

        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile("/matrix/named.component.ts", "export class Host {}", {
          overwrite: true,
        });

        const diagnostics = findMissingImports(
          [
            {
              type: "attribute",
              name: TOKEN,
              isAttribute: true,
              tagName: "div",
              attributes: [{ name: "foo", value: "" }],
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ],
          "warning",
          createMissingImportContext({ index, componentImports, sourceFile, compiler })
        );

        assert.deepStrictEqual(diagnostics, [], `${missing.name} should be silent while ${imported.name} is imported`);
      }
    });
  });
});
