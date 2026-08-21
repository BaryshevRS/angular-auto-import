import * as assert from "node:assert";
import * as path from "node:path";
import { AngularElementIndex } from "../../core/element-index";
import { AngularElementData, type FileElementsInfo } from "../../types";

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
    index.moduleExports.set("MatTableModule", new Set(["MatTable"]));

    assert.deepStrictEqual(index.getModuleExports("MatTableModule"), new Set(["MatTable"]));
    assert.strictEqual(index.getModuleExports(""), undefined);
    assert.strictEqual(index.getModuleExports("UnknownModule"), undefined);
  });

  it("treats any indexed module name as a module", () => {
    const index = new AngularElementIndex();
    index.moduleExports.set("ChipsModule", new Set(["Chips"]));

    assert.strictEqual(index.isModule("ChipsModule"), true);
    assert.strictEqual(index.isModule("Chips"), false);
  });

  it("expands a re-exported module into its transitive exports", () => {
    const index = new AngularElementIndex();
    index.moduleExports.set("ChipsModule", new Set(["InputTextModule", "ChipsComponent"]));
    index.moduleExports.set("InputTextModule", new Set(["InputText"]));

    const expanded = index.expandModuleExports(
      "ChipsModule",
      new Set(["InputTextModule", "ChipsComponent"]),
      new Set()
    );

    assert.deepStrictEqual(expanded, new Set(["InputTextModule", "InputText", "ChipsComponent"]));
  });

  it("stops expanding when modules re-export each other", () => {
    const index = new AngularElementIndex();
    index.moduleExports.set("FirstModule", new Set(["SecondModule", "First"]));
    index.moduleExports.set("SecondModule", new Set(["FirstModule", "Second"]));

    const expanded = index.expandModuleExports("FirstModule", new Set(["SecondModule", "First"]), new Set());

    assert.deepStrictEqual(expanded, new Set(["SecondModule", "FirstModule", "Second", "First"]));
  });

  it("replaces module exports without swapping the container", () => {
    const index = new AngularElementIndex();
    const moduleExports = index.moduleExports;
    moduleExports.set("StaleModule", new Set(["Stale"]));

    index.replaceModuleExports(new Map([["FreshModule", new Set(["Fresh"])]]));

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
    componentModules.set("StaleComponent", { moduleName: "StaleModule", importPath: "stale", exportCount: 1 });

    index.replaceComponentModules(
      new Map([["FreshComponent", { moduleName: "FreshModule", importPath: "fresh", exportCount: 2 }]])
    );

    assert.strictEqual(index.componentModules, componentModules);
    assert.deepStrictEqual([...componentModules.keys()], ["FreshComponent"]);
  });

  it("clears selectors, file records, and module maps together", () => {
    const index = new AngularElementIndex();
    index.selectors.insert("app-card", element("CardComponent", "app-card"));
    index.files.set("/project/src/card.ts", fileRecord("/project/src/card.ts"));
    index.componentModules.set("CardComponent", { moduleName: "CardModule", importPath: "card", exportCount: 1 });
    index.moduleExports.set("CardModule", new Set(["CardComponent"]));

    index.clear();

    assert.deepStrictEqual(index.getAllSelectors(), []);
    assert.strictEqual(index.files.size, 0);
    assert.strictEqual(index.componentModules.size, 0);
    assert.strictEqual(index.moduleExports.size, 0);
  });
});
