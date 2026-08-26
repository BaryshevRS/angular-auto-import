import * as assert from "node:assert";
import * as path from "node:path";
import { AngularElementIndex, type ModuleExportEntry, moduleEntryKey } from "../../core/element-index";
import { elementIdentityKey } from "../../core/selector-trie";
import { AngularElementData, type FileElementsInfo } from "../../types";

function entry(importPath: string, exports: string[]): ModuleExportEntry {
  return { importPath, exports: new Set(exports) };
}

function element(name: string, selector: string, filePath = `/project/src/${name}.ts`): AngularElementData {
  return new AngularElementData({
    path: filePath,
    name,
    type: "component",
    originalSelector: selector,
    selectors: [selector],
    isStandalone: true,
    isExternal: false,
  });
}

function fileRecord(filePath: string): FileElementsInfo {
  return { filePath, lastModified: 1, hash: "hash", elements: [] };
}

describe("AngularElementIndex selectors", () => {
  it("returns every element registered under an exact selector", () => {
    const index = new AngularElementIndex();
    index.selectors.insert("app-card", element("CardComponent", "app-card"));
    index.selectors.insert("app-card", element("LegacyCardComponent", "app-card"));

    const found = index.getElements("app-card");

    assert.deepStrictEqual(
      found.map((el) => el.name),
      ["CardComponent", "LegacyCardComponent"]
    );
  });

  it("ignores a repeated insert of the same element", () => {
    const index = new AngularElementIndex();
    index.selectors.insert("app-card", element("CardComponent", "app-card"));
    index.selectors.insert("app-card", element("CardComponent", "app-card"));

    assert.strictEqual(index.getElements("app-card").length, 1);
  });

  it("rejects lookups that are empty or not a selector string", () => {
    const index = new AngularElementIndex();
    index.selectors.insert("app-card", element("CardComponent", "app-card"));

    assert.deepStrictEqual(index.getElements(""), []);
    assert.deepStrictEqual(index.getElements(undefined as unknown as string), []);
  });

  it("collects every element under a selector prefix", () => {
    const index = new AngularElementIndex();
    index.selectors.insert("app-card", element("CardComponent", "app-card"));
    index.selectors.insert("app-carousel", element("CarouselComponent", "app-carousel"));
    index.selectors.insert("mat-button", element("MatButton", "mat-button"));

    const matches = index.searchWithSelectors("app-car");

    assert.deepStrictEqual(matches.map((match) => match.selector).sort(), ["app-card", "app-carousel"]);
  });

  it("removes only the element contributed by a given file and name", () => {
    const index = new AngularElementIndex();
    const cardPath = path.resolve(path.sep, "project", "src", "card.component.ts");
    index.selectors.insert("app-card", element("CardComponent", "app-card", cardPath));
    index.selectors.insert("app-card", element("LegacyCardComponent", "app-card", cardPath));

    index.selectors.remove("app-card", cardPath, "LegacyCardComponent");

    assert.deepStrictEqual(
      index.getElements("app-card").map((el) => el.name),
      ["CardComponent"]
    );
  });

  it("reports known selectors and their count", () => {
    const index = new AngularElementIndex();
    index.selectors.insert("app-card", element("CardComponent", "app-card"));
    index.selectors.insert("app-list", element("ListComponent", "app-list"));

    assert.deepStrictEqual(index.getAllSelectors().sort(), ["app-card", "app-list"]);
    assert.strictEqual(index.selectors.size, 2);
  });
});

describe("AngularElementIndex module exports", () => {
  it("guards module lookups against empty names", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("MatTableModule", entry("@angular/material/table", ["MatTable"]));

    assert.deepStrictEqual(index.getModuleExports("MatTableModule"), new Set(["MatTable"]));
    assert.strictEqual(index.getModuleExports(""), undefined);
    assert.strictEqual(index.getModuleExports("UnknownModule"), undefined);
  });

  it("treats any indexed module name as a module", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("ChipsModule", entry("primeng/chips", ["Chips"]));

    assert.strictEqual(index.isModule("ChipsModule"), true);
    assert.strictEqual(index.isModule("Chips"), false);
  });

  it("answers for the declaration the asking file imports", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("ScrollingModule", entry("@angular/cdk/scrolling", ["CdkVirtualScrollViewport"]));
    index.addModuleExports(
      "ScrollingModule",
      entry("@angular/cdk-experimental/scrolling", ["CdkAutoSizeVirtualScroll"])
    );

    assert.deepStrictEqual(
      index.getModuleExports("ScrollingModule", { specifier: "@angular/cdk/scrolling" }),
      new Set(["CdkVirtualScrollViewport"])
    );
    assert.deepStrictEqual(
      index.getModuleExports("ScrollingModule", { specifier: "@angular/cdk-experimental/scrolling" }),
      new Set(["CdkAutoSizeVirtualScroll"])
    );
  });

  it("falls back to the file a specifier resolves to when the specifier is not a key", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("SharedModule", {
      ...entry("libs/ui/shared.module.ts", ["UiButton"]),
      absolutePath: "/project/libs/ui/shared.module.ts",
    });
    index.addModuleExports("SharedModule", {
      ...entry("src/app/shared/shared.module.ts", ["AppCard"]),
      absolutePath: "/project/src/app/shared/shared.module.ts",
    });

    const exports = index.getModuleExports("SharedModule", {
      specifier: "@myorg/ui",
      resolveAbsolutePath: () => "/project/libs/ui/shared.module.ts",
    });

    assert.deepStrictEqual(exports, new Set(["UiButton"]));
  });

  it("unions the declarations of an ambiguous name that nothing decides", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("ScrollingModule", entry("@angular/cdk/scrolling", ["CdkVirtualScrollViewport"]));
    index.addModuleExports(
      "ScrollingModule",
      entry("@angular/cdk-experimental/scrolling", ["CdkAutoSizeVirtualScroll"])
    );

    assert.deepStrictEqual(
      index.getModuleExports("ScrollingModule"),
      new Set(["CdkVirtualScrollViewport", "CdkAutoSizeVirtualScroll"])
    );
  });

  it("refuses an ambiguous name when the asking file names an import it cannot place", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("ScrollingModule", entry("@angular/cdk/scrolling", ["CdkVirtualScrollViewport"]));
    index.addModuleExports(
      "ScrollingModule",
      entry("@angular/cdk-experimental/scrolling", ["CdkAutoSizeVirtualScroll"])
    );

    assert.strictEqual(
      index.getModuleExports("ScrollingModule", { specifier: "@acme/scrolling" }),
      undefined,
      "answering here would describe a module the file does not import"
    );
  });

  it("answers with the expanded exports once expansion has run", () => {
    const index = new AngularElementIndex();
    const chips = entry("primeng/chips", ["InputTextModule"]);
    chips.expanded = new Set(["InputTextModule", "InputText"]);
    index.addModuleExports("ChipsModule", chips);

    assert.deepStrictEqual(index.getModuleExports("ChipsModule"), new Set(["InputTextModule", "InputText"]));
  });

  it("retracts every module a file declared", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("SharedModule", {
      ...entry("src/app/shared/shared.module.ts", ["AppCard"]),
      absolutePath: "/project/src/app/shared/shared.module.ts",
    });
    index.addModuleExports("SharedModule", {
      ...entry("libs/ui/shared.module.ts", ["UiButton"]),
      absolutePath: "/project/libs/ui/shared.module.ts",
    });

    assert.strictEqual(index.removeModuleExportsDeclaredIn("/project/src/app/shared/shared.module.ts"), true);
    assert.deepStrictEqual(index.getModuleExports("SharedModule"), new Set(["UiButton"]));

    assert.strictEqual(index.removeModuleExportsDeclaredIn("/project/libs/ui/shared.module.ts"), true);
    assert.strictEqual(index.getModuleExports("SharedModule"), undefined, "the name goes when its last entry does");
    assert.strictEqual(index.removeModuleExportsDeclaredIn("/project/libs/ui/shared.module.ts"), false);
  });

  it("prunes external elements one by one, even when a module lends them its name", () => {
    const index = new AngularElementIndex();
    // Both are indexed under the module that exports them, which is all a non-standalone
    // element has for a name and a path.
    const gone = new AngularElementData({
      path: "@acme/ui",
      name: "UiModule",
      type: "directive",
      originalSelector: "[acme-gone]",
      selectors: ["[acme-gone]"],
      isStandalone: false,
      isExternal: true,
      absolutePath: "/node_modules/@acme/ui/gone.d.ts",
    });
    const kept = new AngularElementData({
      path: "@acme/ui",
      name: "UiModule",
      type: "directive",
      originalSelector: "[acme-kept]",
      selectors: ["[acme-kept]"],
      isStandalone: false,
      isExternal: true,
      absolutePath: "/node_modules/@acme/ui/kept.d.ts",
    });
    index.selectors.insert("[acme-gone]", gone);
    index.selectors.insert("[acme-kept]", kept);

    index.pruneExternalElements(new Set([elementIdentityKey(kept)]));

    assert.deepStrictEqual(index.getElements("[acme-gone]"), []);
    assert.deepStrictEqual(
      index.getElements("[acme-kept]").map((el) => el.originalSelector),
      ["[acme-kept]"]
    );
  });

  it("replaces an element the index reads again rather than keeping the first reading", () => {
    const index = new AngularElementIndex();
    const options = {
      path: "@acme/ui",
      name: "UiModule",
      type: "directive" as const,
      originalSelector: "[acme-moved]",
      selectors: ["[acme-moved]"],
      isStandalone: false,
      isExternal: true,
    };
    index.selectors.insert("[acme-moved]", new AngularElementData({ ...options, absolutePath: "/old/moved.d.ts" }));
    index.selectors.insert("[acme-moved]", new AngularElementData({ ...options, absolutePath: "/new/moved.d.ts" }));

    assert.deepStrictEqual(
      index.getElements("[acme-moved]").map((el) => el.absolutePath),
      ["/new/moved.d.ts"]
    );
  });

  it("prunes only the library modules a rescan did not produce again", () => {
    const index = new AngularElementIndex();
    index.addModuleExports("KeptModule", { ...entry("@acme/kept", ["Kept"]), external: true });
    index.addModuleExports("GoneModule", { ...entry("@acme/gone", ["Gone"]), external: true });
    index.addModuleExports("LocalModule", entry("src/app/local.module.ts", ["Local"]));

    index.pruneExternalModuleExports(new Set([moduleEntryKey("KeptModule", "@acme/kept")]));

    assert.deepStrictEqual(index.getModuleExports("KeptModule"), new Set(["Kept"]));
    assert.strictEqual(index.getModuleExports("GoneModule"), undefined);
    assert.deepStrictEqual(
      index.getModuleExports("LocalModule"),
      new Set(["Local"]),
      "project modules are not a library rescan's to drop"
    );
  });

  it("expands a re-exported module into its transitive exports", () => {
    const index = new AngularElementIndex();
    const chips = entry("primeng/chips", ["InputTextModule", "ChipsComponent"]);
    index.addModuleExports("ChipsModule", chips);
    index.addModuleExports("InputTextModule", entry("primeng/inputtext", ["InputText"]));

    const expanded = index.expandModuleExports("ChipsModule", chips, new Set());

    assert.deepStrictEqual(expanded, new Set(["InputTextModule", "InputText", "ChipsComponent"]));
  });

  it("expands the re-exported declaration the module file imported", () => {
    const index = new AngularElementIndex();
    const shared = {
      ...entry("src/app/shared/shared.module.ts", ["ScrollingModule"]),
      origins: new Map([["ScrollingModule", [{ specifier: "@angular/cdk-experimental/scrolling" }]]]),
    };
    index.addModuleExports("SharedModule", shared);
    index.addModuleExports("ScrollingModule", entry("@angular/cdk/scrolling", ["CdkVirtualScrollViewport"]));
    index.addModuleExports(
      "ScrollingModule",
      entry("@angular/cdk-experimental/scrolling", ["CdkAutoSizeVirtualScroll"])
    );

    const expanded = index.expandModuleExports("SharedModule", shared, new Set());

    assert.deepStrictEqual(expanded, new Set(["ScrollingModule", "CdkAutoSizeVirtualScroll"]));
  });

  it("expands nothing for a re-exported module whose import it cannot place", () => {
    const index = new AngularElementIndex();
    const feature = {
      ...entry("src/app/feature.module.ts", ["SharedModule"]),
      absolutePath: "/project/src/app/feature.module.ts",
      origins: new Map([["SharedModule", [{ specifier: "@app/unknown-shared" }]]]),
    };
    index.addModuleExports("FeatureModule", feature);
    index.addModuleExports("SharedModule", entry("src/app/a/shared.module.ts", ["AOnly"]));
    index.addModuleExports("SharedModule", entry("src/app/b/shared.module.ts", ["BOnly"]));

    const expanded = index.expandModuleExports("FeatureModule", feature, new Set());

    assert.deepStrictEqual(
      [...expanded],
      ["SharedModule"],
      "the exports of two modules it did not import must not become its own"
    );
  });

  it("expands nothing for a re-export whose module is missing, however few others share its name", () => {
    const index = new AngularElementIndex();
    const feature = {
      ...entry("src/app/feature.module.ts", ["SharedModule"]),
      absolutePath: "/project/src/app/feature.module.ts",
      origins: new Map([["SharedModule", [{ specifier: "@missing/shared" }]]]),
    };
    index.addModuleExports("FeatureModule", feature);
    // The only other module of that name, and not the one that was re-exported.
    index.addModuleExports("SharedModule", entry("src/app/unrelated/shared.module.ts", ["UnrelatedOnly"]));

    const expanded = index.expandModuleExports("FeatureModule", feature, new Set());

    assert.deepStrictEqual(
      [...expanded],
      ["SharedModule"],
      "being the only candidate does not make it the module this file named"
    );
  });

  it("stops expanding when modules re-export each other", () => {
    const index = new AngularElementIndex();
    const first = entry("src/app/first.module.ts", ["SecondModule", "First"]);
    index.addModuleExports("FirstModule", first);
    index.addModuleExports("SecondModule", entry("src/app/second.module.ts", ["FirstModule", "Second"]));

    const expanded = index.expandModuleExports("FirstModule", first, new Set());

    assert.deepStrictEqual(expanded, new Set(["SecondModule", "FirstModule", "Second", "First"]));
  });

  it("replaces module exports without swapping the container", () => {
    const index = new AngularElementIndex();
    const moduleExports = index.moduleExports;
    index.addModuleExports("StaleModule", entry("src/app/stale.module.ts", ["Stale"]));

    index.replaceModuleExports(
      new Map([["FreshModule", new Map([["src/app/fresh.module.ts", entry("src/app/fresh.module.ts", ["Fresh"])]])]])
    );

    assert.strictEqual(index.moduleExports, moduleExports, "Holders of the map must observe the new contents");
    assert.deepStrictEqual([...moduleExports.keys()], ["FreshModule"]);
  });
});

describe("AngularElementIndex file records", () => {
  it("replaces file records without swapping the container", () => {
    const index = new AngularElementIndex();
    const files = index.files;
    files.set("/project/src/stale.ts", fileRecord("/project/src/stale.ts"));

    index.replaceFiles(new Map([["/project/src/fresh.ts", fileRecord("/project/src/fresh.ts")]]));

    assert.strictEqual(index.files, files);
    assert.deepStrictEqual([...files.keys()], ["/project/src/fresh.ts"]);
  });

  it("replaces component-to-module mappings without swapping the container", () => {
    const index = new AngularElementIndex();
    const componentModules = index.componentModules;
    index.addComponentModule("StaleComponent", { moduleName: "StaleModule", importPath: "stale", exportCount: 1 });

    index.replaceComponentModules(
      new Map([["FreshComponent", [{ moduleName: "FreshModule", importPath: "fresh", exportCount: 2 }]]])
    );

    assert.strictEqual(index.componentModules, componentModules);
    assert.deepStrictEqual([...componentModules.keys()], ["FreshComponent"]);
  });

  it("clears selectors, file records, and module maps together", () => {
    const index = new AngularElementIndex();
    index.selectors.insert("app-card", element("CardComponent", "app-card"));
    index.files.set("/project/src/card.ts", fileRecord("/project/src/card.ts"));
    index.addComponentModule("CardComponent", { moduleName: "CardModule", importPath: "card", exportCount: 1 });
    index.addModuleExports("CardModule", entry("src/app/card.module.ts", ["CardComponent"]));

    index.clear();

    assert.deepStrictEqual(index.getAllSelectors(), []);
    assert.strictEqual(index.files.size, 0);
    assert.strictEqual(index.componentModules.size, 0);
    assert.strictEqual(index.moduleExports.size, 0);
  });
});
