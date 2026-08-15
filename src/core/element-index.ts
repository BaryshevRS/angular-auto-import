/**
 * In-memory Angular element index: selector lookup, per-file element records,
 * and module export maps. Pure state and queries with no scanning, watching, or
 * persistence, so both the Extension Host and the language server can own one.
 * @module
 */

import type { AngularElementData, FileElementsInfo } from "../types";
import { SelectorTrie } from "./selector-trie";

/** Where an element's exporting NgModule lives, and how wide that module's export surface is. */
export type ModuleExportInfo = {
  moduleName: string;
  importPath: string;
  exportCount: number;
};

/** Maps an element class name to the NgModule that exports it. */
export type ComponentToModuleMap = Map<string, ModuleExportInfo>;

/**
 * Everything the analysis features read: selectors, the per-file records that let
 * an incremental update retract what a file previously contributed, and the module
 * maps that tell an element which NgModule exports it.
 */
export class AngularElementIndex {
  /** Selector lookup for project and library elements. */
  public readonly selectors: SelectorTrie = new SelectorTrie();
  /** Elements contributed by each indexed project file, keyed by absolute path. */
  public readonly files: Map<string, FileElementsInfo> = new Map();
  /** Project element class name to its declaring NgModule. */
  public readonly componentModules: ComponentToModuleMap = new Map();
  /** NgModule name to the entity names it exports, after transitive expansion. */
  public readonly moduleExports: Map<string, Set<string>> = new Map();

  /** Drops every indexed element, file record, and module mapping. */
  public clear(): void {
    this.selectors.clear();
    this.files.clear();
    this.componentModules.clear();
    this.moduleExports.clear();
  }

  /**
   * Returns every element registered under an exact selector.
   * @param selector The selector to look up.
   */
  public getElements(selector: string): AngularElementData[] {
    if (typeof selector !== "string" || !selector) {
      return [];
    }
    return this.selectors.findAll(selector);
  }

  /** Returns every selector known to the index. */
  public getAllSelectors(): string[] {
    return this.selectors.getAllSelectors();
  }

  /**
   * Returns all elements whose selector starts with `prefix`, paired with that selector.
   * @param prefix The selector prefix to search for.
   */
  public searchWithSelectors(prefix: string): { selector: string; element: AngularElementData }[] {
    return this.selectors.searchWithSelectors(prefix);
  }

  /**
   * Gets all exported entities from an external module.
   * @param moduleName The name of the external module (e.g., "MatTableModule").
   * @returns A Set of exported entity names or undefined if module not found.
   */
  public getModuleExports(moduleName: string): Set<string> | undefined {
    if (typeof moduleName !== "string" || !moduleName) {
      return undefined;
    }
    return this.moduleExports.get(moduleName);
  }

  /**
   * Checks if an exported element is a module.
   * An element is considered a module if it exists as a key in the module export index.
   * @param name The name of the element to check.
   * @returns True if the element is a module, false otherwise.
   */
  public isModule(name: string): boolean {
    return this.moduleExports.has(name);
  }

  /**
   * Recursively expands module exports to include transitive exports.
   * For example, if ChipsModule exports InputTextModule, and InputTextModule exports InputText,
   * this method will ensure ChipsModule's exports include both InputTextModule and InputText.
   * @param moduleName The name of the module being processed.
   * @param directExports The direct exports of the module.
   * @param visited Set of already visited modules to prevent infinite recursion.
   * @returns A Set containing all direct and transitive exports.
   */
  public expandModuleExports(moduleName: string, directExports: Set<string>, visited: Set<string>): Set<string> {
    // Protect against circular dependencies
    if (visited.has(moduleName)) {
      return new Set<string>();
    }
    visited.add(moduleName);

    const result = new Set<string>();

    // Process each direct export
    for (const exportedItem of directExports) {
      // Always add the item itself
      result.add(exportedItem);

      // If the exported item is a module, recursively expand its exports
      if (this.isModule(exportedItem)) {
        const nestedExports = this.moduleExports.get(exportedItem);

        if (nestedExports) {
          // Recursively expand nested module exports
          const expandedNested = this.expandModuleExports(exportedItem, nestedExports, visited);

          // Add all expanded exports to the result
          for (const item of expandedNested) {
            result.add(item);
          }
        }
      }
    }

    return result;
  }

  /**
   * Replaces the per-file element records, for example after a cache load.
   * @param files The file records to store.
   */
  public replaceFiles(files: Map<string, FileElementsInfo>): void {
    replaceEntries(this.files, files);
  }

  /**
   * Replaces the element-to-NgModule map, for example after a cache load.
   * @param componentModules The mappings to store.
   */
  public replaceComponentModules(componentModules: ComponentToModuleMap): void {
    replaceEntries(this.componentModules, componentModules);
  }

  /**
   * Replaces the module export index, for example after transitive expansion.
   * @param moduleExports The module exports to store.
   */
  public replaceModuleExports(moduleExports: Map<string, Set<string>>): void {
    replaceEntries(this.moduleExports, moduleExports);
  }
}

/**
 * Refills a map in place so the owning index keeps the container identity that
 * callers already hold a reference to.
 * @internal
 */
function replaceEntries<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) {
    target.set(key, value);
  }
}
