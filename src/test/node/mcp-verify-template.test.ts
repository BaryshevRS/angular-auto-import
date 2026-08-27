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
import { type TemplateProject, verifyTemplate } from "../../mcp/verify-template";
import { AngularIndexer } from "../../services";

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

    it("says how many it left out when nothing matched exactly", async () => {
      const files: Record<string, string> = {};
      for (let index = 0; index < 8; index += 1) {
        files[`thing-${index}.component.ts`] =
          `import { Component } from '@angular/core';\n@Component({ selector: 'app-thing-${index}', standalone: true, template: '' })\nexport class Thing${index}Component {}\n`;
      }
      const { project, root } = await projectOf(files);

      const { matches, more } = await describeElements({
        runtime: project,
        fromFile: path.join(root, "host.component.ts"),
        query: "thing",
      });

      assert.strictEqual(matches.length, 5, "a shortlist, not everything");
      assert.strictEqual(more, 3, "and an honest count of the rest");
    });
  });
});
