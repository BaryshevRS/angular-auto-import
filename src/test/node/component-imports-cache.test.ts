/**
 * The cache that remembers what a component already imports.
 *
 * Its keys arrive from two places that spell a path differently — ts-morph, which always
 * reports forward slashes, and a document URI, which keeps the platform's separator. On
 * Windows those are two strings for one file, and a cache keyed by one is not reachable
 * through the other. The consequence is not a crash: it is a component that was edited
 * and diagnostics that never noticed.
 * @module
 */

import * as assert from "node:assert";
import { Project } from "ts-morph";
import { ComponentImports } from "../../core/component-imports";
import { AngularElementData } from "../../types";

/** The path as ts-morph reports it: forward slashes, on every platform. */
const componentPath = "/work/src/host.component.ts";

/** The same file as a Windows document URI spells it. */
const windowsSpelling = componentPath.replace(/\//g, "\\");

/** A component that imports `CardComponent`, and can be rewritten so it no longer does. */
function componentSource(withImport: boolean): string {
  return [
    'import { Component } from "@angular/core";',
    withImport ? 'import { CardComponent } from "./card.component";' : "",
    "@Component({",
    '  selector: "app-host",',
    "  standalone: true,",
    `  imports: [${withImport ? "CardComponent" : ""}],`,
    '  template: "",',
    "})",
    "export class HostComponent {}",
    "",
  ].join("\n");
}

const card = new AngularElementData({
  path: "src/card.component",
  name: "CardComponent",
  type: "component",
  originalSelector: "app-card",
  selectors: ["app-card"],
  isStandalone: true,
  isExternal: false,
});

describe("Component import cache", () => {
  let project: Project;
  let componentImports: ComponentImports;

  beforeEach(() => {
    project = new Project({ useInMemoryFileSystem: true });
    componentImports = new ComponentImports({ resolveIndex: () => undefined });
  });

  /** Writes the component and answers whether it imports the card, filling the cache. */
  function askAboutComponent(withImport: boolean): boolean {
    const sourceFile = project.createSourceFile(componentPath, componentSource(withImport), { overwrite: true });
    return componentImports.isImported(sourceFile, card);
  }

  it("answers from the file the first time it is asked", () => {
    assert.strictEqual(askAboutComponent(true), true);
    assert.strictEqual(askAboutComponent(false), true, "The cached answer is what makes the next question cheap");
  });

  it("is invalidated by the spelling ts-morph reports", () => {
    askAboutComponent(true);

    componentImports.invalidate(componentPath);

    assert.strictEqual(askAboutComponent(false), false);
  });

  it("is invalidated by the spelling a Windows document URI reports", () => {
    askAboutComponent(true);

    // The separator is the whole difference, and it is enough to miss the entry.
    componentImports.invalidate(windowsSpelling);

    assert.strictEqual(
      askAboutComponent(false),
      false,
      "An invalidation that misses leaves diagnostics describing a component that has since changed"
    );
  });
});
