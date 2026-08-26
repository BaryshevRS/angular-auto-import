import * as assert from "node:assert";
import { Project, type SourceFile } from "ts-morph";
import { ComponentImports, type ModuleExportsIndex } from "../../core/component-imports";
import { AngularElementIndex } from "../../core/element-index";
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

  it("answers for the declaration of a colliding module name that the file imports", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("ScrollingModule", {
      importPath: "@angular/cdk/scrolling",
      exports: new Set(["CdkVirtualScrollViewport", "CdkVirtualForOf"]),
    });
    index.addModuleExports("ScrollingModule", {
      importPath: "@angular/cdk-experimental/scrolling",
      exports: new Set(["CdkAutoSizeVirtualScroll"]),
    });

    const viewport = element({
      name: "CdkVirtualScrollViewport",
      path: "@angular/cdk/scrolling",
      isStandalone: false,
      isExternal: true,
    });

    const fromCdk = componentFile(
      "cdk-scrolling",
      `
import { ScrollingModule } from "@angular/cdk/scrolling";

@Component({ selector: "app-cdk", standalone: true, template: "", imports: [ScrollingModule] })
export class CdkComponent {}
`
    );
    const fromExperimental = componentFile(
      "experimental-scrolling",
      `
import { ScrollingModule } from "@angular/cdk-experimental/scrolling";

@Component({ selector: "app-experimental", standalone: true, template: "", imports: [ScrollingModule] })
export class ExperimentalComponent {}
`
    );

    // The indexer exposes the index under this name; the wrapper is that hand-off.
    const scrolling: ModuleExportsIndex = {
      getExternalModuleExports: (moduleName, origin) => index.getModuleExports(moduleName, origin),
    };

    assert.strictEqual(resolverFor(scrolling).isImported(fromCdk, viewport), true);
    assert.strictEqual(
      resolverFor(scrolling).isImported(fromExperimental, viewport),
      false,
      "the experimental package declares its own ScrollingModule, which does not export the viewport"
    );
  });

  it("asks about a renamed module under the name it is declared with", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("ScrollingModule", {
      importPath: "@angular/cdk/scrolling",
      exports: new Set(["CdkVirtualScrollViewport"]),
    });

    const file = componentFile(
      "aliased-module",
      `
import { ScrollingModule as CdkScrolling } from "@angular/cdk/scrolling";

@Component({ selector: "app-aliased", standalone: true, template: "", imports: [CdkScrolling] })
export class AliasedComponent {}
`
    );

    const viewport = element({
      name: "CdkVirtualScrollViewport",
      path: "@angular/cdk/scrolling",
      isStandalone: false,
      isExternal: true,
    });

    assert.strictEqual(
      resolverFor({
        getExternalModuleExports: (moduleName, origin) => index.getModuleExports(moduleName, origin),
      }).isImported(file, viewport),
      true
    );
  });

  it("accepts an element imported under another name", () => {
    const file = componentFile(
      "aliased-element",
      `
import { CardComponent as Card } from "./card";

@Component({ selector: "app-aliased-element", standalone: true, template: "", imports: [Card] })
export class AliasedElementComponent {}
`
    );

    assert.strictEqual(resolverFor(undefined).isImported(file, element()), true);
  });

  it("refuses to answer for a colliding name whose import it cannot place", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("ScrollingModule", {
      importPath: "@angular/cdk/scrolling",
      exports: new Set(["CdkVirtualScrollViewport"]),
    });
    index.addModuleExports("ScrollingModule", {
      importPath: "@angular/cdk-experimental/scrolling",
      exports: new Set(["CdkAutoSizeVirtualScroll"]),
    });

    // A third package of the same name, which the index does not know.
    const file = componentFile(
      "unplaceable",
      `
import { ScrollingModule } from "@acme/scrolling";

@Component({ selector: "app-unplaceable", standalone: true, template: "", imports: [ScrollingModule] })
export class UnplaceableComponent {}
`
    );

    const viewport = element({
      name: "CdkVirtualScrollViewport",
      path: "@angular/cdk/scrolling",
      isStandalone: false,
      isExternal: true,
    });

    assert.strictEqual(
      resolverFor({
        getExternalModuleExports: (moduleName, origin) => index.getModuleExports(moduleName, origin),
      }).isImported(file, viewport),
      false,
      "a module this file does not import must not satisfy the element"
    );
  });

  it("accepts an element a bundle holds, whatever package the bundle comes from", () => {
    // `TuiComboBox` comes from `@taiga-ui/kit` and holds `TuiLabel`, which is
    // `@taiga-ui/core`'s. What each bundle holds is read when its library is indexed.
    const index = new AngularElementIndex();
    index.addBundle("ComboBox", {
      importPath: "@lib/kit",
      members: [{ name: "ComboBoxDirective" }, { name: "LabelDirective" }],
    });

    const bundles: ModuleExportsIndex = {
      getExternalModuleExports: () => undefined,
      bundlesHolding: (names, absolutePath) => index.bundlesHolding(names, absolutePath),
    };

    const file = componentFile(
      "bundle-host",
      `
import { ComboBox } from '@lib/kit';

@Component({ selector: "app-bundle-host", standalone: true, template: "", imports: [ComboBox] })
export class BundleHostComponent {}
`
    );

    assert.strictEqual(
      resolverFor(bundles).isImported(file, element({ name: "LabelDirective", path: "@lib/core", type: "directive" })),
      true
    );
    assert.strictEqual(
      resolverFor(bundles).isImported(file, element({ name: "DropdownDirective", path: "@lib/kit" })),
      false,
      "a bundle answers for what it holds and nothing else"
    );
  });

  it("refuses a bundle of the right name that comes from somewhere else", () => {
    // Two packages, one name. Only what `@lib/b` holds says anything about a file that
    // imports `Bundle` from `@lib/b`.
    const index = new AngularElementIndex();
    index.addBundle("Bundle", { importPath: "@lib/a", members: [{ name: "OnlyInA" }] });
    index.addBundle("Bundle", { importPath: "@lib/b", members: [{ name: "OnlyInB" }] });

    const bundles: ModuleExportsIndex = {
      getExternalModuleExports: () => undefined,
      bundlesHolding: (names, absolutePath) => index.bundlesHolding(names, absolutePath),
    };

    const file = componentFile(
      "wrong-bundle-host",
      `
import { Bundle } from '@lib/b';

@Component({ selector: "app-wrong-bundle", standalone: true, template: "", imports: [Bundle] })
export class WrongBundleHostComponent {}
`
    );

    assert.strictEqual(
      resolverFor(bundles).isImported(file, element({ name: "OnlyInB", path: "@lib/b", type: "directive" })),
      true
    );
    assert.strictEqual(
      resolverFor(bundles).isImported(file, element({ name: "OnlyInA", path: "@lib/a", type: "directive" })),
      false,
      "the bundle this file imports is not the one that holds it"
    );
  });

  it("refuses a bundle whose member is another package's class of the same name", () => {
    // Both libraries ship a `SharedDirective`. The bundle holds one of them, and holding
    // it says nothing about the other.
    const index = new AngularElementIndex();
    index.addBundle("Bundle", {
      importPath: "@lib/b",
      members: [{ name: "SharedDirective", absolutePath: "/node_modules/@lib/b/shared.d.ts" }],
    });

    const file = componentFile(
      "same-name-bundle-host",
      `
import { Bundle } from '@lib/b';

@Component({ selector: "app-same-name", standalone: true, template: "", imports: [Bundle] })
export class SameNameBundleHostComponent {}
`
    );

    const bundles: ModuleExportsIndex = {
      getExternalModuleExports: () => undefined,
      bundlesHolding: (names, absolutePath) => index.bundlesHolding(names, absolutePath),
    };

    assert.strictEqual(
      resolverFor(bundles).isImported(
        file,
        element({
          name: "SharedDirective",
          path: "@lib/b",
          type: "directive",
          absolutePath: "/node_modules/@lib/b/shared.d.ts",
        })
      ),
      true
    );
    assert.strictEqual(
      resolverFor(bundles).isImported(
        file,
        element({
          name: "SharedDirective",
          path: "@lib/a",
          type: "directive",
          absolutePath: "/node_modules/@lib/a/shared.d.ts",
        })
      ),
      false,
      "the same class name from another package is another class"
    );
  });

  it("accepts a workspace bundle imported by a relative path", () => {
    // The index holds the file's project-relative path; the component writes a relative
    // one. One file, two spellings.
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      `${projectRoot}/src/app/modules/ui-kit.ts`,
      "export class KitBadgeDirective {}\nexport const UiKit = [KitBadgeDirective] as const;\n",
      { overwrite: true }
    );
    const file = project.createSourceFile(
      `${projectRoot}/src/app/kit-host.component.ts`,
      `
import { UiKit } from './modules/ui-kit';

@Component({ selector: "app-kit-host", standalone: true, template: "", imports: [UiKit] })
export class KitHostComponent {}
`,
      { overwrite: true }
    );

    const index = new AngularElementIndex();
    index.addBundle("UiKit", {
      importPath: "src/app/modules/ui-kit.ts",
      absolutePath: `${projectRoot}/src/app/modules/ui-kit.ts`,
      members: [{ name: "KitBadgeDirective" }],
    });

    assert.strictEqual(
      resolverFor({
        getExternalModuleExports: () => undefined,
        bundlesHolding: (names, absolutePath) => index.bundlesHolding(names, absolutePath),
      }).isImported(file, element({ name: "KitBadgeDirective", path: "src/app/modules/ui-kit.ts" })),
      true
    );
  });

  it("refuses a name that is a local variable rather than an imported bundle", () => {
    const index = new AngularElementIndex();
    index.addBundle("Bundle", { importPath: "@lib/a", members: [{ name: "OnlyInA" }] });

    const file = componentFile(
      "local-bundle-host",
      `
const Bundle = [];

@Component({ selector: "app-local-bundle", standalone: true, template: "", imports: [Bundle] })
export class LocalBundleHostComponent {}
`
    );

    assert.strictEqual(
      resolverFor({
        getExternalModuleExports: () => undefined,
        bundlesHolding: (names, absolutePath) => index.bundlesHolding(names, absolutePath),
      }).isImported(file, element({ name: "OnlyInA", path: "@lib/a", type: "directive" })),
      false
    );
  });

  it("accepts an element a bundle holds when the bundle is imported under another name", () => {
    const index = new AngularElementIndex();
    index.addBundle("ComboBox", { importPath: "@lib/kit", members: [{ name: "ComboBoxDirective" }] });

    const file = componentFile(
      "aliased-bundle-host",
      `
import { ComboBox as Combo } from '@lib/kit';

@Component({ selector: "app-aliased-bundle", standalone: true, template: "", imports: [Combo] })
export class AliasedBundleHostComponent {}
`
    );

    assert.strictEqual(
      resolverFor({
        getExternalModuleExports: () => undefined,
        bundlesHolding: (names, absolutePath) => index.bundlesHolding(names, absolutePath),
      }).isImported(file, element({ name: "ComboBoxDirective", path: "@lib/kit", type: "directive" })),
      true
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
