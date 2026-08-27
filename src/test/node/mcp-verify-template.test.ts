/**
 * The answer an agent gets for a template it is about to write.
 *
 * The point of the tool is not that it finds the problem — the compiler finds it too,
 * later — but that it says what to import and hands back the component with the import
 * in it. So the assertions are about the fix, not about the diagnostic.
 * @module
 */

import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNodeFileSystem } from "../../adapters/node/file-system";
import { type AngularCompilerApi, adoptAngularCompiler } from "../../core/angular-compiler";
import { createMemoryCacheStore } from "../../core/cache";
import { silentLogger, withInstrumentation } from "../../core/logging";
import { silentProgressHost } from "../../core/progress";
import { describeElements } from "../../mcp/element-api";
import { orient } from "../../mcp/orient";
import { searchElements } from "../../mcp/search";
import { type TemplateProject, verifyTemplate } from "../../mcp/verify-template";
import { AngularIndexer } from "../../services";
import { AngularElementData } from "../../types";

let compiler: AngularCompilerApi;

/** A project of loose files, indexed, with import paths resolved the way a relative one is. */
async function projectOf(files: Record<string, string>): Promise<{ project: TemplateProject; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-mcp-"));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0" }), "utf8");

  for (const [name, text] of Object.entries(files)) {
    const filePath = path.join(root, name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, "utf8");
  }

  const indexer = new AngularIndexer({
    cacheStore: createMemoryCacheStore(),
    logger: withInstrumentation(silentLogger),
    fileSystem: createNodeFileSystem(),
    progressHost: silentProgressHost,
    fileWatchers: { watch: () => ({ dispose: () => undefined }) },
  });
  indexer.setProjectRoot(root);
  await indexer.generateFullIndex();

  return {
    root,
    project: {
      rootPath: root,
      indexer,
      // Standing in for the runtime's tsconfig-aware resolution, which would prefer an
      // alias where one maps: a relative specifier is what it falls back to, and what a
      // project with no tsconfig gets.
      resolveImportPath: async (targetModulePathNoExt, currentFilePath) => {
        const relative = path.relative(path.dirname(currentFilePath), targetModulePathNoExt);
        return relative.startsWith(".") ? relative : `./${relative}`;
      },
    },
  };
}

/** The same index with more elements in it, without touching the one it was made from. */
function withLibraries(
  indexer: TemplateProject["indexer"],
  extra: Array<{ selector: string; element: AngularElementData }>
): TemplateProject["indexer"] {
  const indexed = indexer.searchWithSelectors("");
  return Object.create(indexer, {
    searchWithSelectors: { value: () => [...extra, ...indexed] },
  }) as TemplateProject["indexer"];
}

/** A library element, as the indexer records one. */
function external(name: string, importPath: string): AngularElementData {
  return new AngularElementData({
    path: importPath,
    name,
    type: "component",
    originalSelector: name.toLowerCase(),
    selectors: [name.toLowerCase()],
    isStandalone: true,
    isExternal: true,
  });
}

const HOST = `import { Component } from '@angular/core';

@Component({
  selector: 'app-host',
  standalone: true,
  imports: [],
  template: '',
})
export class HostComponent {}
`;

const CARD = `import { Component } from '@angular/core';

@Component({ selector: 'app-card', standalone: true, template: '' })
export class CardComponent {}
`;

describe("Verifying a template for an agent", function () {
  this.timeout(30000);

  before(async () => {
    compiler = adoptAngularCompiler(await import("@angular/compiler"));
  });

  it("names what to import, and hands back the component with the import in it", async () => {
    const { project, root } = await projectOf({ "host.component.ts": HOST, "card.component.ts": CARD });
    const componentPath = path.join(root, "host.component.ts");

    const verdict = await verifyTemplate({
      runtime: project,
      compiler,
      componentPath,
      componentText: HOST,
      template: "<app-card></app-card>",
    });

    assert.deepStrictEqual(
      verdict.problems.map(({ line, column, token, fixes }) => ({ line, column, token, fixes })),
      [{ line: 1, column: 1, token: "app-card", fixes: [{ name: "CardComponent", from: "./card.component" }] }]
    );
    assert.deepStrictEqual(verdict.addedImports, ["CardComponent"]);

    const updated = verdict.updatedComponent ?? "";
    assert.ok(updated.includes('import { CardComponent } from "./card.component"'), "the import statement is added");
    assert.ok(updated.includes("imports: [CardComponent]"), "and the component's imports array carries it");
  });

  it("imports every directive one token needs, not one of them", async () => {
    // `[appMark]` and `button[appMark]` both apply to `<button appMark>`, and they demand
    // different things, so Angular applies both. Taking the most specific alone leaves the
    // template still missing an import after the fix was applied — which is the failure
    // this rule exists for, and the one an outcome that happens to look right hides.
    const { project, root } = await projectOf({
      "host.component.ts": HOST,
      "mark.directive.ts": `import { Directive } from '@angular/core';

@Directive({ selector: '[appMark]', standalone: true })
export class MarkDirective {}

@Directive({ selector: 'button[appMark]', standalone: true })
export class ButtonMarkDirective {}
`,
    });

    const verdict = await verifyTemplate({
      runtime: project,
      compiler,
      componentPath: path.join(root, "host.component.ts"),
      componentText: HOST,
      template: "<button appMark>ok</button>",
    });

    assert.deepStrictEqual(
      [...verdict.addedImports].sort(),
      ["ButtonMarkDirective", "MarkDirective"],
      "both, because one token here is two directives rather than a choice between two"
    );
  });

  it("says nothing about an element the component already imports", async () => {
    const { project, root } = await projectOf({ "host.component.ts": HOST, "card.component.ts": CARD });
    const componentPath = path.join(root, "host.component.ts");
    const alreadyImporting = HOST.replace("imports: []", "imports: [CardComponent]").replace(
      "import { Component } from '@angular/core';",
      "import { Component } from '@angular/core';\nimport { CardComponent } from './card.component';"
    );

    const verdict = await verifyTemplate({
      runtime: project,
      compiler,
      componentPath,
      componentText: alreadyImporting,
      template: "<app-card></app-card>",
    });

    assert.deepStrictEqual(verdict.problems, []);
    assert.deepStrictEqual(verdict.addedImports, []);
    assert.strictEqual(verdict.updatedComponent, undefined, "nothing to change means nothing to write");
  });

  it("checks the template it is given, not the one the component carries", async () => {
    // The whole point: an agent asks about the template it is about to write.
    const { project, root } = await projectOf({ "host.component.ts": HOST, "card.component.ts": CARD });

    const verdict = await verifyTemplate({
      runtime: project,
      compiler,
      componentPath: path.join(root, "host.component.ts"),
      componentText: HOST,
      template: "<div>nothing angular here</div>",
    });

    assert.deepStrictEqual(verdict.problems, []);
  });

  describe("describing an element for an agent", () => {
    const Table = `import { Component, Input, input, model, output } from '@angular/core';

@Component({
  selector: 'app-table',
  standalone: true,
  template: '<ng-content select="[caption]"></ng-content><ng-content></ng-content>',
})
export class TableComponent {
  @Input({ required: true }) dataSource!: unknown[];
  @Input('appLoadingState') loadingState = 'idle';
  pageSize = input(10);
  selected = model<string>();
  closed = output<void>();
}
`;

    it("answers with the names a template actually writes", async () => {
      const { project, root } = await projectOf({ "table.component.ts": Table, "card.component.ts": CARD });

      const { matches, more } = await describeElements({
        runtime: project,
        fromFile: path.join(root, "host.component.ts"),
        query: "app-table",
      });

      assert.strictEqual(more, 0, "an exact hit is the answer, not one candidate among five");
      assert.strictEqual(matches.length, 1);
      const [table] = matches;

      assert.strictEqual(table.name, "TableComponent");
      assert.strictEqual(table.importFrom, "./table.component");
      assert.deepStrictEqual(table.inputs, [
        { name: "dataSource", required: true },
        // The alias, which is the name a template writes — and the case a model gets
        // wrong by writing the property name it never saw.
        { name: "appLoadingState" },
        { name: "pageSize", signal: true },
        { name: "selected", signal: true },
      ]);
      assert.deepStrictEqual(table.outputs, ["selectedChange", "closed"]);
    });

    it("finds an element by its class name as readily as by its selector", async () => {
      const { project, root } = await projectOf({ "table.component.ts": Table });

      const { matches } = await describeElements({
        runtime: project,
        fromFile: path.join(root, "host.component.ts"),
        query: "TableComponent",
      });

      assert.deepStrictEqual(
        matches.map((match) => match.name),
        ["TableComponent"]
      );
    });

    it("names what it did not describe, rather than hiding it", async () => {
      const files: Record<string, string> = {};
      for (let index = 0; index < 8; index += 1) {
        files[`thing-${index}.component.ts`] =
          `import { Component } from '@angular/core';\n@Component({ selector: 'app-thing-${index}', standalone: true, template: '' })\nexport class Thing${index}Component {}\n`;
      }
      const { project, root } = await projectOf(files);

      const { matches, others, more } = await describeElements({
        runtime: project,
        fromFile: path.join(root, "host.component.ts"),
        query: "thing",
      });

      assert.strictEqual(matches.length, 5, "a surface is expensive to describe");
      assert.strictEqual(more, 0, "but nothing is dropped");
      assert.deepStrictEqual(
        others?.map((line) => line.split(" · ")[0]),
        ["Thing5Component", "Thing6Component", "Thing7Component"],
        "the rest are named, so a ranking this got wrong is still recoverable"
      );
    });
  });

  describe("orienting an agent in a workspace", () => {
    it("counts what the workspace uses, not merely what it has", async () => {
      // The distinction the whole tool exists for: a workspace with two UI libraries
      // installed writes one of them, and availability cannot tell which.
      const { project, root } = await projectOf({
        "host.component.ts": HOST,
        "card.component.ts": CARD,
        "uses-a.component.ts": `import { Component } from '@angular/core';\nimport { AButton } from 'lib-a/button';\nimport { AIcon } from 'lib-a/icon';\n@Component({ selector: 'app-uses-a', standalone: true, template: '' })\nexport class UsesAComponent {}\n`,
        "also-uses-a.component.ts": `import { Component } from '@angular/core';\nimport { AButton } from 'lib-a/button';\n@Component({ selector: 'app-also-uses-a', standalone: true, template: '' })\nexport class AlsoUsesAComponent {}\n`,
      });

      const overview = await orient({
        runtime: {
          ...project,
          listSourceFiles: async () => [
            path.join(root, "uses-a.component.ts"),
            path.join(root, "also-uses-a.component.ts"),
            path.join(root, "card.component.ts"),
          ],
          tsConfig: { paths: { "@app/*": ["src/app/*"] } },
          // The project's own elements plus three from libraries nothing installed here.
          // Taken before the override so that it does not call itself.
          indexer: withLibraries(project.indexer, [
            { selector: "a-button", element: external("AButton", "lib-a/button") },
            { selector: "a-icon", element: external("AIcon", "lib-a/icon") },
            { selector: "b-table", element: external("BTable", "lib-b/table") },
          ]),
        },
      });

      assert.deepStrictEqual(overview.libraries, [
        // Two files reach for it, across two of its entry points.
        { name: "lib-a", importedBy: 2, elements: 2 },
        // Installed and indexed, and nothing here writes it.
        { name: "lib-b", importedBy: 0, elements: 1 },
      ]);
      assert.deepStrictEqual(overview.own, { standalone: 4, nonStandalone: 0 });
      assert.deepStrictEqual(overview.aliases, { "@app/*": ["src/app/*"] });
      assert.strictEqual(overview.moreAliases, undefined, "with nothing left over, nothing is said about it");
    });
  });

  describe("finding an element by what it is for", () => {
    /** Two libraries offering the same concept, one of them the one this workspace writes. */
    async function twoLibraries() {
      const { project, root } = await projectOf({ "host.component.ts": HOST, "card.component.ts": CARD });
      return {
        root,
        runtime: {
          ...project,
          indexer: withLibraries(project.indexer, [
            { selector: "a-date-picker", element: external("ADatePicker", "lib-a/date-picker") },
            { selector: "b-date-picker", element: external("BDatePicker", "lib-b/date-picker") },
            { selector: "b-spin", element: external("BSpin", "lib-b/progress-spinner") },
          ]),
        },
        // lib-b is installed and lib-a is what the files here import.
        usage: new Map([
          ["lib-a", 9],
          ["lib-b", 1],
        ]),
      };
    }

    it("ranks by what the workspace writes, not by what it has installed", async () => {
      const { runtime, root, usage } = await twoLibraries();

      const { hits } = await searchElements({
        runtime,
        fromFile: path.join(root, "host.component.ts"),
        query: "date picker",
        libraryUsage: usage,
      });

      assert.deepStrictEqual(
        hits.map((hit) => [hit.name, hit.usedByProject]),
        [
          ["ADatePicker", 9],
          ["BDatePicker", 1],
        ]
      );
    });

    it("puts the workspace's own elements ahead of any library", async () => {
      const { runtime, root, usage } = await twoLibraries();

      const { hits } = await searchElements({
        runtime,
        fromFile: path.join(root, "host.component.ts"),
        query: "card",
        libraryUsage: usage,
      });

      assert.deepStrictEqual(
        hits.map((hit) => [hit.name, hit.importFrom]),
        [["CardComponent", "./card.component"]],
        "and its specifier is one the asking file could write"
      );
    });

    it("reads the entry point as words, which is where a concept often is", async () => {
      // `lib-b/progress-spinner` says "spinner" while the class and selector do not.
      const { runtime, root, usage } = await twoLibraries();

      const { hits } = await searchElements({
        runtime,
        fromFile: path.join(root, "host.component.ts"),
        query: "spinner",
        libraryUsage: usage,
      });

      assert.deepStrictEqual(
        hits.map((hit) => hit.name),
        ["BSpin"]
      );
    });

    it("answers nothing rather than something close, and says what to do", async () => {
      const { runtime, root, usage } = await twoLibraries();

      const { hits, advice } = await searchElements({
        runtime,
        fromFile: path.join(root, "host.component.ts"),
        query: "sortable date picker",
        libraryUsage: usage,
      });

      assert.deepStrictEqual(hits, [], "every word has to match, so a model retries with another word");
      assert.ok(advice?.includes("a different word"), "and is told to, rather than left with silence");
    });
  });
});
