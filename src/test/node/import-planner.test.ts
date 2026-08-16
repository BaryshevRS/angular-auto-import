import * as assert from "node:assert";
import { Project } from "ts-morph";
import { type ImportPlan, planImports } from "../../core/import-planner";
import { AngularElementData } from "../../types";

const filePath = "/workspace/app/src/app/host.component.ts";

function element(overrides: Partial<ConstructorParameters<typeof AngularElementData>[0]> = {}): AngularElementData {
  return new AngularElementData({
    path: "@acme/cards",
    name: "CardComponent",
    type: "component",
    originalSelector: "app-card",
    selectors: ["app-card"],
    isStandalone: true,
    isExternal: true,
    ...overrides,
  });
}

async function plan(text: string, elements: AngularElementData[], version = 7): Promise<ImportPlan> {
  return planImports({
    filePath,
    text,
    version,
    elements,
    project: new Project({ useInMemoryFileSystem: true }),
    resolveImportPath: async (candidate) => candidate.path,
  });
}

/** The text the plan produces, or the original when the plan is empty. */
function plannedText(result: ImportPlan, original: string): string {
  return result.edits[0]?.newText ?? original;
}

const bareComponent = `import { Component } from "@angular/core";

@Component({
  selector: "app-host",
  standalone: true,
  template: "<app-card />",
})
export class HostComponent {}
`;

describe("Import planner", () => {
  it("adds both the import statement and the decorator entry", async () => {
    const result = await plan(bareComponent, [element()]);

    const text = plannedText(result, bareComponent);
    assert.ok(text.includes('import { CardComponent } from "@acme/cards";'));
    assert.ok(text.includes("imports: [CardComponent]"));
    assert.deepStrictEqual(result.addedImports, ["CardComponent"]);
  });

  it("carries the version it was planned against", async () => {
    const result = await plan(bareComponent, [element()], 42);

    assert.strictEqual(result.version, 42);
    assert.strictEqual(result.filePath, filePath);
  });

  it("plans nothing when the element is already imported", async () => {
    const already = `import { Component } from "@angular/core";
import { CardComponent } from "@acme/cards";

@Component({
  selector: "app-host",
  standalone: true,
  template: "<app-card />",
  imports: [CardComponent],
})
export class HostComponent {}
`;

    const result = await plan(already, [element()]);

    assert.deepStrictEqual(result.edits, []);
    assert.deepStrictEqual(result.addedImports, []);
  });

  it("replaces the whole file, so the edit range spans it", async () => {
    const result = await plan(bareComponent, [element()]);

    const lines = bareComponent.split("\n");
    assert.deepStrictEqual(result.edits[0].range, {
      start: { line: 0, character: 0 },
      end: { line: lines.length - 1, character: lines[lines.length - 1].length },
    });
  });

  it("adds an imports array to a decorator that has none", async () => {
    const noImports = `import { Component } from "@angular/core";

@Component({ selector: "app-host", template: "<app-card />" })
export class HostComponent {}
`;

    const text = plannedText(await plan(noImports, [element()]), noImports);

    assert.ok(text.includes("imports: [CardComponent]"), text);
  });

  it("reuses an existing import statement from the same module", async () => {
    const sharedModule = `import { Component } from "@angular/core";
import { ButtonComponent } from "@acme/cards";

@Component({
  selector: "app-host",
  standalone: true,
  template: "<app-card />",
  imports: [ButtonComponent],
})
export class HostComponent {}
`;

    const text = plannedText(await plan(sharedModule, [element()]), sharedModule);

    assert.ok(text.includes('import { ButtonComponent, CardComponent } from "@acme/cards";'), text);
    assert.ok(text.includes("imports: [ButtonComponent, CardComponent]"), text);
  });

  it("imports the exporting NgModule instead of a non-standalone element", async () => {
    const pipe = element({
      path: "@ngx-translate/core",
      name: "TranslatePipe",
      type: "pipe",
      isStandalone: false,
      exportingModuleName: "TranslateModule",
    });

    const text = plannedText(await plan(bareComponent, [pipe]), bareComponent);

    assert.ok(text.includes('import { TranslatePipe } from "@ngx-translate/core";'), text);
    assert.ok(text.includes("imports: [TranslateModule]"), text);
    assert.deepStrictEqual((await plan(bareComponent, [pipe])).addedImports, ["TranslateModule"]);
  });

  it("plans every requested element in one pass", async () => {
    const result = await plan(bareComponent, [
      element(),
      element({ name: "ButtonComponent", path: "@acme/buttons", originalSelector: "app-button" }),
    ]);

    const text = plannedText(result, bareComponent);
    assert.deepStrictEqual(result.addedImports, ["CardComponent", "ButtonComponent"]);
    assert.ok(text.includes("imports: [CardComponent, ButtonComponent]"), text);
  });

  it("wraps an import statement that grows past the line-length limit", async () => {
    const longModule = "@acme/a-very-long-package-name-for-testing-line-wrapping";
    const wide = `import { Component } from "@angular/core";
import { FirstLongComponentName, SecondLongComponentName, ThirdLongComponentName } from "${longModule}";

@Component({
  selector: "app-host",
  standalone: true,
  template: "<app-card />",
  imports: [FirstLongComponentName],
})
export class HostComponent {}
`;

    const text = plannedText(await plan(wide, [element({ path: longModule })]), wide);

    assert.ok(text.includes("import {\n  FirstLongComponentName,\n"), text);
    assert.ok(text.includes(`} from "${longModule}";`), text);
  });

  it("leaves a non-array imports property alone", async () => {
    const spread = `import { Component } from "@angular/core";
import { SHARED } from "./shared";

@Component({ selector: "app-host", template: "", imports: SHARED })
export class HostComponent {}
`;

    const result = await plan(spread, [element()]);
    const text = plannedText(result, spread);

    assert.ok(text.includes("imports: SHARED"), "the unusual imports property must be left untouched");
    assert.deepStrictEqual(result.addedImports, []);
    assert.ok(text.includes('import { CardComponent } from "@acme/cards";'), "the import statement is still added");
  });
});
