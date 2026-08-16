import * as assert from "node:assert";
import { Project, type SourceFile } from "ts-morph";
import { ComponentImports, type ModuleExportsIndex } from "../../core/component-imports";
import { AngularElementData } from "../../types";

const projectRoot = "/workspace/app";

function componentFile(name: string, text: string): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(`${projectRoot}/src/app/${name}.component.ts`, text, { overwrite: true });
}

function element(overrides: Partial<ConstructorParameters<typeof AngularElementData>[0]> = {}): AngularElementData {
  return new AngularElementData({
    path: "./src/app/card",
    name: "CardComponent",
    type: "component",
    originalSelector: "app-card",
    selectors: ["app-card"],
    isStandalone: true,
    isExternal: false,
    ...overrides,
  });
}

/** An index whose only knowledge is which module exports what. */
function indexOf(moduleExports: Map<string, string[]>): ModuleExportsIndex {
  return {
    getExternalModuleExports: (moduleName) => {
      const exported = moduleExports.get(moduleName);
      return exported ? new Set(exported) : undefined;
    },
  };
}

function resolverFor(index: ModuleExportsIndex | undefined): ComponentImports {
  return new ComponentImports({ resolveIndex: () => index });
}

describe("Component imports", () => {
  it("accepts an element listed in the imports array and imported at the top of the file", () => {
    const file = componentFile(
      "direct",
      `
import { CardComponent } from "./card";

@Component({ selector: "app-direct", standalone: true, template: "", imports: [CardComponent] })
export class DirectComponent {}
`
    );

    assert.strictEqual(resolverFor(undefined).isImported(file, element()), true);
  });

  it("rejects an element listed in the imports array without a top-level import", () => {
    const file = componentFile(
      "unresolved",
      `
@Component({ selector: "app-unresolved", standalone: true, template: "", imports: [CardComponent] })
export class UnresolvedComponent {}
`
    );

    assert.strictEqual(resolverFor(undefined).isImported(file, element()), false);
  });

  it("accepts an element reached through the NgModule that exports it", () => {
    const file = componentFile(
      "via-module",
      `
import { CardModule } from "@acme/cards";

@Component({ selector: "app-via-module", standalone: true, template: "", imports: [CardModule] })
export class ViaModuleComponent {}
`
    );

    const resolver = resolverFor(indexOf(new Map([["CardModule", ["CardComponent"]]])));

    assert.strictEqual(resolver.isImported(file, element()), true);
    assert.strictEqual(
      resolver.isImported(file, element({ name: "OtherComponent" })),
      false,
      "a module that does not export the element must not satisfy it"
    );
  });

  it("accepts an element exported by a standard Angular module", () => {
    const file = componentFile(
      "common",
      `
import { CommonModule } from "@angular/common";

@Component({ selector: "app-common", standalone: true, template: "", imports: [CommonModule] })
export class CommonComponent {}
`
    );

    const ngIf = element({ name: "NgIf", path: "@angular/common", type: "directive" });

    // Module resolution runs only for files an index owns, so even the built-in
    // modules need one; an empty index is enough.
    assert.strictEqual(resolverFor(indexOf(new Map())).isImported(file, ngIf), true);
    assert.strictEqual(resolverFor(undefined).isImported(file, ngIf), false);
  });

  it("accepts an element whose exporting module is imported directly", () => {
    const file = componentFile(
      "exporting-module",
      `
import { TranslateModule } from "@ngx-translate/core";

@Component({ selector: "app-exporting", standalone: true, template: "", imports: [TranslateModule] })
export class ExportingComponent {}
`
    );

    const pipe = element({
      name: "TranslatePipe",
      path: "@ngx-translate/core",
      type: "pipe",
      isStandalone: false,
      isExternal: true,
      exportingModuleName: "TranslateModule",
    });

    assert.strictEqual(resolverFor(undefined).isImported(file, pipe), true);
  });

  it("answers false when no index owns the file and nothing is imported directly", () => {
    const file = componentFile(
      "orphan",
      `
import { CardModule } from "@acme/cards";

@Component({ selector: "app-orphan", standalone: true, template: "", imports: [CardModule] })
export class OrphanComponent {}
`
    );

    assert.strictEqual(resolverFor(undefined).isImported(file, element()), false);
  });

  it("reuses a cached answer until the file is invalidated", () => {
    const file = componentFile(
      "cached",
      `
@Component({ selector: "app-cached", standalone: true, template: "", imports: [] })
export class CachedComponent {}
`
    );
    const resolver = resolverFor(undefined);

    assert.strictEqual(resolver.isImported(file, element()), false);

    file.replaceWithText(`
import { CardComponent } from "./card";

@Component({ selector: "app-cached", standalone: true, template: "", imports: [CardComponent] })
export class CachedComponent {}
`);
    assert.strictEqual(resolver.isImported(file, element()), false, "the cached answer is reused");

    resolver.invalidate(file.getFilePath());
    assert.strictEqual(resolver.isImported(file, element()), true, "invalidation forces a fresh read");
  });

  it("lists the identifiers in the component's imports array and their module specifiers", () => {
    const file = componentFile(
      "listing",
      `
import { CardComponent } from "./card";
import { CardModule } from "@acme/cards";

@Component({
  selector: "app-listing",
  standalone: true,
  template: "",
  imports: [CardComponent, CardModule],
})
export class ListingComponent {}
`
    );
    const resolver = resolverFor(undefined);

    assert.deepStrictEqual(resolver.getImportNames(file), ["CardComponent", "CardModule"]);
    assert.deepStrictEqual(resolver.getNamedImportSpecifiers(file, "CardModule"), ["@acme/cards"]);
    assert.deepStrictEqual(resolver.getNamedImportSpecifiers(file, "Unknown"), []);
  });
});
