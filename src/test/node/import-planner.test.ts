import * as assert from "node:assert";
import { Project } from "ts-morph";
import { type ImportFormattingOptions, type ImportPlan, planImports } from "../../core/import-planner";
import { AngularElementData } from "../../types";
import { applyTextEdits } from "./harness/text";

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

async function plan(
  text: string,
  elements: AngularElementData[],
  version = 7,
  formatting?: ImportFormattingOptions
): Promise<ImportPlan> {
  return planImports({
    filePath,
    text,
    version,
    elements,
    project: new Project({ useInMemoryFileSystem: true }),
    resolveImportPath: async (candidate) => candidate.path,
    formatting,
  });
}

/** The text the plan produces, which is what applying its edits gives. */
function plannedText(result: ImportPlan, original: string): string {
  return applyTextEdits(original, result.edits);
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

  it("touches only the lines it changed, leaving the template between them alone", async () => {
    const result = await plan(bareComponent, [element()]);

    const changedLines = new Set<number>();
    for (const edit of result.edits) {
      for (let line = edit.range.start.line; line <= edit.range.end.line; line += 1) {
        changedLines.add(line);
      }
    }

    const templateLine = bareComponent.split("\n").findIndex((line) => line.includes("template:"));
    assert.ok(templateLine >= 0, "The fixture must have a template line to leave alone");
    assert.ok(
      !changedLines.has(templateLine),
      `Edits covered the template line; a completion editing it would collide. Covered: ${[...changedLines].join(", ")}`
    );
  });

  it("produces edits an editor can apply together", async () => {
    const result = await plan(bareComponent, [element()]);

    const starts = result.edits.map((edit) => edit.range.start);
    const sorted = [...starts].sort((left, right) => left.line - right.line || left.character - right.character);
    assert.deepStrictEqual(starts, sorted, "Edits must arrive in document order");

    for (let index = 1; index < result.edits.length; index += 1) {
      const previous = result.edits[index - 1].range.end;
      const next = result.edits[index].range.start;
      assert.ok(
        previous.line < next.line || (previous.line === next.line && previous.character <= next.character),
        "Edits must not overlap"
      );
    }
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

  it("uses the configured quote style for a new import", async () => {
    const text = plannedText(
      await plan(bareComponent, [element()], 7, {
        printWidth: 120,
        tabWidth: 2,
        useTabs: false,
        singleQuote: true,
      }),
      bareComponent
    );

    assert.ok(text.includes("import { CardComponent } from '@acme/cards';"), text);
  });

  it("uses the configured width and indentation when wrapping an import", async () => {
    const existing = `import { Component } from "@angular/core";
import { FirstComponent } from "@acme/cards";

@Component({ imports: [FirstComponent], template: "<app-card />" })
export class HostComponent {}
`;

    const text = plannedText(
      await plan(existing, [element()], 7, {
        printWidth: 40,
        tabWidth: 8,
        useTabs: true,
        singleQuote: true,
      }),
      existing
    );

    assert.ok(text.includes("import {\n\tFirstComponent,\n\tCardComponent\n} from '@acme/cards';"), text);
  });

  it("wraps a changed Component imports array at the configured width", async () => {
    const existing = `import { Component } from '@angular/core';
import { DctBadgeModule, DctAlertModule, DctLinkModule, DctTabsModule } from '@mds/ng-uikit';

@Component({
  selector: 'app-host',
  imports: [DctBadgeModule, DctAlertModule, DctLinkModule, DctTabsModule, RouterLink, RouterLinkActive, GtagGoalDirective, RouterOutlet],
  template: '<app-card />',
})
export class HostComponent {}
`;

    const text = plannedText(
      await plan(existing, [element({ name: "DctLoaderModule", path: "@mds/ng-uikit" })], 7, {
        printWidth: 120,
        tabWidth: 2,
        useTabs: false,
        singleQuote: true,
      }),
      existing
    );

    assert.ok(
      text.includes(`  imports: [
    DctBadgeModule,
    DctAlertModule,
    DctLinkModule,
    DctTabsModule,
    RouterLink,
    RouterLinkActive,
    GtagGoalDirective,
    RouterOutlet,
    DctLoaderModule
  ],`),
      text
    );
  });

  it("uses tabs for every changed Component imports indentation level when configured", async () => {
    const existing = `import { Component } from "@angular/core";
import { FirstComponent } from "@acme/cards";

@Component({
  imports: [FirstComponent],
  template: "<app-card />",
})
export class HostComponent {}
`;

    const text = plannedText(
      await plan(existing, [element()], 7, {
        printWidth: 20,
        tabWidth: 8,
        useTabs: true,
        singleQuote: false,
      }),
      existing
    );

    assert.ok(text.includes("\timports: [\n\t\tFirstComponent,\n\t\tCardComponent\n\t],"), text);
  });

  it("formats only the import declaration it changed", async () => {
    const unrelated =
      'import { AnUnrelatedComponentWithAVeryLongName } from "@acme/an-unrelated-package-with-a-long-name";';
    const existing = `import { Component } from "@angular/core";
${unrelated}
import { FirstComponent } from "@acme/cards";

@Component({ imports: [FirstComponent], template: "<app-card />" })
export class HostComponent {}
`;

    const text = plannedText(
      await plan(existing, [element()], 7, {
        printWidth: 60,
        tabWidth: 2,
        useTabs: false,
        singleQuote: true,
      }),
      existing
    );

    assert.ok(text.includes(unrelated), text);
    assert.ok(text.includes("} from '@acme/cards';"), text);
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
