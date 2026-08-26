/**
 * In-memory Angular element index: selector lookup, per-file element records,
 * and module export maps. Pure state and queries with no scanning, watching, or
 * persistence, so both the Extension Host and the language server can own one.
 * @module
 */

import type { AngularElementData, FileElementsInfo } from "../types";
import { normalizePath } from "../utils/path";
import type { BundleMember } from "./bundles";
import { elementIdentityKey, SelectorTrie } from "./selector-trie";

/** Where an element's exporting NgModule lives, and how wide that module's export surface is. */
export type ModuleExportInfo = {
  moduleName: string;
  importPath: string;
  exportCount: number;
};

/**
 * Maps an element class name to every NgModule known to export it.
 *
 * Candidates rather than a winner, because the winner is not a stable property of the
 * element: a module that stops exporting it, or the file that declared that module going
 * away, has to leave the others standing. {@link moduleFitScore} picks between them when
 * the answer is asked for.
 */
export type ComponentToModuleMap = Map<string, ModuleExportInfo[]>;

/**
 * How well a module fits as the one to import for an element. Higher is better.
 *
 * A wide barrel that happens to export the element is a worse suggestion than the small
 * module named after it, which is what the name bonus and the export-count term say.
 * @param componentName The element being imported.
 * @param candidate The module offering it.
 */
export function moduleFitScore(componentName: string, candidate: ModuleExportInfo): number {
  let score = 0;

  // 1. Major bonus for direct name match (e.g., InputNumber in InputNumberModule)
  if (candidate.moduleName.startsWith(componentName)) {
    score += 100;
  }

  // 2. Penalty for generic module names that don't relate to the component
  if (candidate.moduleName.toLowerCase().includes("module")) {
    const baseModuleName = candidate.moduleName.replace(/module$/i, "");
    if (baseModuleName.length > 0 && !componentName.toLowerCase().includes(baseModuleName.toLowerCase())) {
      score -= 10;
    }
  }

  // 3. Bonus for specificity (fewer exports is better)
  score += 50 / (candidate.exportCount + 1);

  // 4. Small penalty for longer import paths as a tie-breaker
  score -= candidate.importPath.length * 0.1;

  return score;
}

/**
 * One declaration of an NgModule name: where it is imported from, and what it exports.
 *
 * A class name does not identify a module. `ScrollingModule` is declared by both
 * `@angular/cdk/scrolling` and `@angular/cdk-experimental/scrolling`, and each exports
 * something different, so the index keeps one entry per path a module of that name is
 * imported from and lets the asking file say which one it means.
 */
export interface ModuleExportEntry {
  /** A library module's specifier (`@angular/cdk/scrolling`), or a project module's project-relative path. */
  importPath: string;
  /** Absolute path of the file this entry was read from: a library entry point, or the module's own file. */
  absolutePath?: string;
  /**
   * Absolute path of the file the module class is *declared* in.
   *
   * Not the same as {@link absolutePath} for a library: one module class is commonly
   * reachable from several entry points — `@lib/components/svg`, `@lib/components` and
   * `@lib` can all export the same `SvgModule` — and those are one module, not three.
   * The file it is declared in is what says so.
   */
  declarationPath?: string;
  /**
   * The names this declaration lists in its own `exports`, as written.
   *
   * Kept separate from {@link expanded} so expansion stays a function of what was read
   * from the file: a module whose `exports` change is re-read and everything is expanded
   * again, which is impossible once the two are merged into one set.
   */
  exports: Set<string>;
  /** The direct exports plus everything the modules among them export. Filled by expansion. */
  expanded?: Set<string>;
  /**
   * For each exported name, where the declaring file got it. It is what lets transitive
   * expansion follow a re-exported module to the declaration that was actually
   * re-exported rather than to another one of the same name.
   *
   * Keyed by the name the module is *declared* with, like {@link exports} itself, so an
   * `exports: [LocalAlias]` still finds the module the index knows. A list per name,
   * because `exports: [LeftShared, RightShared]` is two different modules that a name
   * collision has made one entry: both were re-exported, and both have to be followed.
   */
  origins?: Map<string, ModuleExportOrigin[]>;
  /** Set for a module read from a package, so dependency reindexing can retract them as a group. */
  external?: boolean;
}

/** Where one of a module's exports came from, as its own file names it. */
export interface ModuleExportOrigin {
  /** The specifier the declaring file imported the name from. */
  specifier?: string;
  /**
   * The file that specifier resolves to. Filled in the first time expansion has to ask,
   * since resolving one makes TypeScript load the file it names.
   */
  absolutePath?: string;
}

/** Every declaration of one module name, keyed by the path it is imported from. */
export type ModuleExportEntries = Map<string, ModuleExportEntry>;

/**
 * One bundle: an array a library exports in place of a class, and what it holds.
 *
 * `imports: [TuiComboBox]` names one of these, and Angular takes it as if its members had
 * been written out.
 */
export interface BundleEntry {
  /** A library's specifier, or a project file's project-relative path. */
  importPath: string;
  /** Absolute path of the file declaring it, so an alias or a relative import still finds it. */
  absolutePath?: string;
  /** The classes it holds. */
  members: BundleMember[];
}

/**
 * Whether a bundle member is one of the classes being looked for.
 *
 * By identity when both sides know where the class is declared, and by name when either
 * does not: two libraries can each ship a `SharedDirective`, and the one a bundle holds is
 * not the other.
 * @internal
 */
function holds(member: BundleMember, names: ReadonlySet<string>, absolutePath: string | undefined): boolean {
  if (!names.has(member.name)) {
    return false;
  }
  if (member.absolutePath === undefined || absolutePath === undefined) {
    return true;
  }
  return normalizePath(member.absolutePath) === absolutePath;
}

/**
 * Resolves a specifier written in one file to the file it names, the way TypeScript does.
 * Expansion is given one so it can place a re-exported module whose specifier is a
 * relative path or an alias, and only for the names where that is in doubt.
 */
export type SpecifierResolver = (fromFile: string, specifier: string) => string | undefined;

/**
 * How the file under analysis names a module, so an ambiguous name selects one declaration.
 *
 * `resolveAbsolutePath` is separate from `specifier` and lazy because resolving a specifier
 * means asking TypeScript to load the file it names; the written specifier alone answers
 * for every library module, whose entry is keyed by that same specifier.
 */
export interface ModuleImportOrigin {
  /** The specifier as written in the importing file. */
  specifier?: string;
  /** The file that specifier resolves to, as TypeScript resolves it. */
  resolveAbsolutePath?: () => string | undefined;
}

/** How hard a selection insists on the origin naming the declaration it returns. */
export interface SelectModuleEntryOptions {
  /**
   * Refuse the only declaration of a name unless the origin actually names it.
   *
   * The lenient default is for a file's own `imports: [...]`, where refusing would turn
   * every specifier this project cannot resolve into a false "missing import". Following
   * a re-export is the opposite case: the module said which one it re-exported, and
   * handing it the exports of the only other module of that name is how an unrelated
   * library ends up inside a project module's export surface.
   */
  strict?: boolean;
}

/**
 * Picks the declaration an importing file meant.
 * @param entries Every declaration indexed under one module name.
 * @param origin How the importing file names the module.
 * @param options Whether the only declaration may answer for an origin it does not match.
 * @returns The entry the origin names, the only entry when that is allowed, or `undefined`.
 */
export function selectModuleEntry(
  entries: ModuleExportEntries,
  origin?: ModuleImportOrigin,
  options?: SelectModuleEntryOptions
): ModuleExportEntry | undefined {
  if (entries.size === 1 && options?.strict !== true) {
    return entries.values().next().value;
  }

  if (origin?.specifier) {
    const written = entries.get(origin.specifier);
    if (written) {
      return written;
    }
  }

  // A project module reaches here: it is imported by a relative path or an alias, which
  // is a different string from the project-relative path its entry is keyed by. So does
  // any strict selection whose specifier is not a key.
  const resolved = origin?.resolveAbsolutePath?.();
  if (!resolved) {
    return undefined;
  }

  const target = normalizePath(resolved);
  for (const entry of entries.values()) {
    if (entry.absolutePath && normalizePath(entry.absolutePath) === target) {
      return entry;
    }
    // A specifier can also name the class's own file rather than an entry point that
    // re-exports it.
    if (entry.declarationPath && normalizePath(entry.declarationPath) === target) {
      return entry;
    }
  }

  return undefined;
}

/**
 * Whether two entries are the same module rather than two modules of one name.
 *
 * The class's own file decides it: several entry points re-exporting one module are one
 * module, and two files declaring a class of the same name are two. Where that file is
 * not known, the path each is imported from is all there is to compare.
 * @param one An entry.
 * @param other Another entry under the same name.
 */
export function sameModuleDeclaration(one: ModuleExportEntry, other: ModuleExportEntry): boolean {
  if (one.declarationPath && other.declarationPath) {
    return normalizePath(one.declarationPath) === normalizePath(other.declarationPath);
  }
  return one.importPath === other.importPath;
}

/**
 * Names one declaration among every module in the index.
 * @param moduleName The module's class name.
 * @param importPath The path that declaration is imported from.
 */
export function moduleEntryKey(moduleName: string, importPath: string): string {
  return `${moduleName} from ${importPath}`;
}

/** What a declaration makes available: its transitive exports once expanded, its own until then. */
function exportsOf(entry: ModuleExportEntry): Set<string> {
  return entry.expanded ?? entry.exports;
}

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
  /** NgModule name to every declaration of it, each with its own export surface. */
  public readonly moduleExports: Map<string, ModuleExportEntries> = new Map();
  /**
   * Bundle name to what it holds, by the path it is imported from.
   *
   * A library ships a component with the directives that belong to it as one array, and
   * `imports: [TuiComboBox]` names that array rather than any class. Read while indexing,
   * because doing it when a template asks means loading a library's declaration files
   * again — one lookup here against seconds there.
   */
  public readonly bundles: Map<string, Map<string, BundleEntry>> = new Map();
  /**
   * The library entry points this index has read.
   *
   * What separates "this package exports no bundle by that name" from "nobody has looked":
   * the first is an answer, and without it every ordinary import would be opened again to
   * find out that it is an ordinary import.
   */
  public readonly libraryPaths: Set<string> = new Set();

  /** Drops every indexed element, file record, and module mapping. */
  public clear(): void {
    this.selectors.clear();
    this.files.clear();
    this.componentModules.clear();
    this.moduleExports.clear();
    this.bundles.clear();
    this.libraryPaths.clear();
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
   * Records what a bundle holds.
   * @param name The exported name of the bundle.
   * @param importPath The path it is imported from.
   * @param members The classes it holds.
   */
  public addLibraryPath(importPath: string): void {
    this.libraryPaths.add(importPath);
  }

  /**
   * Whether this index has read the library a specifier names, and can therefore answer
   * for it rather than sending the caller to TypeScript.
   * @param specifier The specifier as an importing file writes it.
   */
  public knowsLibrary(specifier: string | undefined): boolean {
    return specifier !== undefined && this.libraryPaths.has(specifier);
  }

  public addBundle(name: string, entry: BundleEntry): void {
    let byPath = this.bundles.get(name);
    if (!byPath) {
      byPath = new Map();
      this.bundles.set(name, byPath);
    }
    byPath.set(entry.importPath, entry);
  }

  /**
   * The bundles that hold one of these classes, and where each of them is imported from.
   *
   * The question a template asks is not "what does this bundle hold" but "is what I need
   * inside one of the names this file imports", and answering it the other way round is
   * what keeps a file with seventy imports from being read seventy times over.
   *
   * The paths come with it because a name is not a bundle: `@lib/a` and `@lib/b` may both
   * export a `Bundle`, holding different things, and only the one the file actually
   * imports says anything about what that file has.
   * @param members The class names to look for.
   * @returns Bundle name to the paths whose bundle of that name holds one of them.
   */
  public bundlesHolding(names: Iterable<string>, absolutePath?: string): Map<string, BundleEntry[]> {
    const wanted = new Set(names);
    const target = absolutePath === undefined ? undefined : normalizePath(absolutePath);
    const holders = new Map<string, BundleEntry[]>();

    for (const [name, byPath] of this.bundles) {
      for (const entry of byPath.values()) {
        if (!entry.members.some((member) => holds(member, wanted, target))) {
          continue;
        }
        holders.set(name, [...(holders.get(name) ?? []), entry]);
      }
    }

    return holders;
  }

  /**
   * What a bundle of this name holds.
   * @param name The name as the importing file wrote it.
   * @param specifier Where that file imported it from, when it is known.
   * @returns The members of that bundle, of every bundle of the name when the specifier
   * names none of them, or nothing when no bundle answers to the name.
   */
  public getBundleEntries(name: string): Map<string, BundleEntry> | undefined {
    return this.bundles.get(name);
  }

  /**
   * Replaces the bundle index, for example after a cache load.
   * @param bundles The bundles to store.
   */
  public replaceBundles(bundles: Map<string, Map<string, BundleEntry>>): void {
    replaceEntries(this.bundles, bundles);
  }

  /**
   * Retracts every bundle declared in one file, so a file that is edited or deleted stops
   * answering with what it used to hold.
   * @param importPath The path those bundles are indexed under.
   * @returns Whether anything was removed.
   */
  public removeBundlesDeclaredIn(importPath: string): boolean {
    let removed = false;

    for (const [name, byPath] of this.bundles) {
      if (byPath.delete(importPath)) {
        removed = true;
      }
      if (byPath.size === 0) {
        this.bundles.delete(name);
      }
    }

    return removed;
  }

  /**
   * Drops the bundles read from packages that a rescan did not produce again.
   * @param keep Keys, as {@link moduleEntryKey} builds them, that the rescan re-indexed.
   * @param within The paths the rescan is answerable for: everything it read this time,
   * and everything it had read before. A path outside them belongs to the workspace and
   * is retracted by the file it lives in, not by a dependency scan.
   */
  public pruneBundles(keep: ReadonlySet<string>, within: ReadonlySet<string>): void {
    for (const [name, byPath] of this.bundles) {
      for (const importPath of byPath.keys()) {
        if (within.has(importPath) && !keep.has(moduleEntryKey(name, importPath))) {
          byPath.delete(importPath);
        }
      }
      if (byPath.size === 0) {
        this.bundles.delete(name);
      }
    }
  }

  /**
   * Replaces the set of libraries read, for example after a cache load.
   * @param libraryPaths The entry points to store.
   */
  public replaceLibraryPaths(libraryPaths: Iterable<string>): void {
    this.libraryPaths.clear();
    for (const importPath of libraryPaths) {
      this.libraryPaths.add(importPath);
    }
  }

  /**
   * Records one module declaration, replacing whatever was indexed for the same import path.
   * @param moduleName The declared NgModule's class name.
   * @param entry Where that declaration is imported from and what it exports.
   */
  public addModuleExports(moduleName: string, entry: ModuleExportEntry): void {
    let entries = this.moduleExports.get(moduleName);
    if (!entries) {
      entries = new Map();
      this.moduleExports.set(moduleName, entries);
    }
    entries.set(entry.importPath, entry);
  }

  /**
   * Records that a module exports an element, replacing what the same module said before.
   * @param elementName The exported element's class name.
   * @param info The module offering it.
   */
  public addComponentModule(elementName: string, info: ModuleExportInfo): void {
    const candidates = this.componentModules.get(elementName);
    if (!candidates) {
      this.componentModules.set(elementName, [info]);
      return;
    }

    const existing = candidates.findIndex(
      (candidate) => candidate.importPath === info.importPath && candidate.moduleName === info.moduleName
    );
    if (existing === -1) {
      candidates.push(info);
    } else {
      candidates[existing] = info;
    }
  }

  /**
   * The module to import so an element becomes usable, chosen by {@link moduleFitScore}.
   * @param elementName The element's class name.
   */
  public getComponentModule(elementName: string): ModuleExportInfo | undefined {
    const candidates = this.componentModules.get(elementName);
    if (!candidates || candidates.length === 0) {
      return undefined;
    }

    let best = candidates[0];
    let bestScore = moduleFitScore(elementName, best);
    for (const candidate of candidates.slice(1)) {
      const score = moduleFitScore(elementName, candidate);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Retracts what a module declared in one file said about the elements it exports, so an
   * edited or deleted module stops being suggested for them.
   * @param importPath The path that module is indexed under.
   * @returns Whether anything was removed.
   */
  public removeComponentModulesFrom(importPath: string): boolean {
    let removed = false;

    for (const [elementName, candidates] of this.componentModules) {
      const kept = candidates.filter((candidate) => candidate.importPath !== importPath);
      if (kept.length === candidates.length) {
        continue;
      }
      removed = true;
      if (kept.length === 0) {
        this.componentModules.delete(elementName);
      } else {
        this.componentModules.set(elementName, kept);
      }
    }

    return removed;
  }

  /**
   * Drops the elements read from packages that a rescan did not produce again, so an
   * uninstalled library stops offering its components to templates.
   * @param keep Keys, as {@link externalElementKey} builds them, that the rescan re-indexed.
   */
  public pruneExternalElements(keep: ReadonlySet<string>): void {
    for (const element of this.selectors.getAllElements()) {
      if (!element.isExternal || keep.has(elementIdentityKey(element))) {
        continue;
      }
      this.selectors.removeElement(element);
    }
  }

  /**
   * The names the modules declared in one file export.
   * @param absolutePath The declaring file.
   */
  public exportNamesDeclaredIn(absolutePath: string): Set<string> {
    const target = normalizePath(absolutePath);
    const names = new Set<string>();

    for (const entries of this.moduleExports.values()) {
      for (const entry of entries.values()) {
        if (entry.absolutePath && normalizePath(entry.absolutePath) === target) {
          for (const name of entry.exports) {
            names.add(name);
          }
        }
      }
    }

    return names;
  }

  /**
   * Retracts every module declared by one file, so a file that is edited or deleted stops
   * answering with the exports it used to have.
   * @param absolutePath The declaring file.
   * @returns Whether anything was removed, which tells the caller a re-expansion is due.
   */
  public removeModuleExportsDeclaredIn(absolutePath: string): boolean {
    const target = normalizePath(absolutePath);
    let removed = false;

    for (const [moduleName, entries] of this.moduleExports) {
      for (const [importPath, entry] of entries) {
        if (entry.absolutePath && normalizePath(entry.absolutePath) === target) {
          entries.delete(importPath);
          removed = true;
        }
      }
      if (entries.size === 0) {
        this.moduleExports.delete(moduleName);
      }
    }

    return removed;
  }

  /**
   * Drops the module declarations read from packages that a rescan did not produce again,
   * so an uninstalled library or a removed entry point stops answering.
   * @param keep Keys, as {@link moduleEntryKey} builds them, that the rescan re-indexed.
   */
  public pruneExternalModuleExports(keep: ReadonlySet<string>): void {
    for (const [moduleName, entries] of this.moduleExports) {
      for (const [importPath, entry] of entries) {
        if (entry.external && !keep.has(moduleEntryKey(moduleName, importPath))) {
          entries.delete(importPath);
        }
      }
      if (entries.size === 0) {
        this.moduleExports.delete(moduleName);
      }
    }
  }

  /**
   * Returns every declaration indexed under a module name.
   * @param moduleName The name of the module (e.g. "MatTableModule").
   */
  public getModuleEntries(moduleName: string): ModuleExportEntries | undefined {
    if (typeof moduleName !== "string" || !moduleName) {
      return undefined;
    }
    return this.moduleExports.get(moduleName);
  }

  /**
   * Gets all exported entities from a module.
   * @param moduleName The name of the module (e.g., "MatTableModule").
   * @param origin How the asking file imports that module, needed only when several
   * declarations share the name.
   * @returns The exports of the declaration the origin names, the union of every
   * declaration's exports when the name stays ambiguous, or undefined when the module
   * is not indexed.
   */
  public getModuleExports(moduleName: string, origin?: ModuleImportOrigin): Set<string> | undefined {
    const entries = this.getModuleEntries(moduleName);
    if (!entries || entries.size === 0) {
      return undefined;
    }

    const selected = selectModuleEntry(entries, origin);
    if (selected) {
      return exportsOf(selected);
    }

    if (origin?.specifier !== undefined) {
      // The asking file imports one specific declaration and it is not among these.
      // Answering with any of them — or with all of them — would describe a module this
      // file does not import, so the honest answer is that nothing here is known to
      // export it.
      return undefined;
    }

    // Nobody asked about a particular import: this is the overview question, "does any
    // module of this name export it", and the union is exactly that.
    const union = new Set<string>();
    for (const entry of entries.values()) {
      for (const exportedName of exportsOf(entry)) {
        union.add(exportedName);
      }
    }
    return union;
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
   * Recursively expands one declaration's exports to include transitive exports.
   * For example, if ChipsModule exports InputTextModule, and InputTextModule exports InputText,
   * this method will ensure ChipsModule's exports include both InputTextModule and InputText.
   * @param moduleName The name of the module being processed.
   * @param entry The declaration of that module whose exports are being expanded.
   * @param visited Declarations already expanded in this pass, to prevent infinite recursion.
   * @returns A Set containing all direct and transitive exports.
   */
  public expandModuleExports(
    moduleName: string,
    entry: ModuleExportEntry,
    visited: Set<string>,
    resolveSpecifier?: SpecifierResolver
  ): Set<string> {
    // Protect against circular dependencies. Two declarations of one name are two
    // different modules, so the guard is keyed by both.
    const visitKey = moduleEntryKey(moduleName, entry.importPath);
    if (visited.has(visitKey)) {
      return new Set<string>();
    }
    visited.add(visitKey);

    const result = new Set<string>();

    // Process each direct export
    for (const exportedItem of entry.exports) {
      // Always add the item itself
      result.add(exportedItem);

      const nested = this.getModuleEntries(exportedItem);
      if (!nested) {
        continue;
      }

      // If the exported item is a module, recursively expand its exports
      for (const nestedEntry of this.reexportedEntries(entry, exportedItem, nested, resolveSpecifier)) {
        for (const item of this.expandModuleExports(exportedItem, nestedEntry, visited, resolveSpecifier)) {
          result.add(item);
        }
      }
    }

    return result;
  }

  /**
   * The declarations a re-exported module name can stand for, narrowed by what the
   * re-exporting file imported and, failing that, by what is declared beside it. Every
   * declaration is returned when neither decides, for the reason `getModuleExports`
   * unions them.
   * @internal
   */
  private reexportedEntries(
    parent: ModuleExportEntry,
    exportedItem: string,
    nested: ModuleExportEntries,
    resolveSpecifier?: SpecifierResolver
  ): ModuleExportEntry[] {
    const origins = parent.origins?.get(exportedItem);

    if (origins && origins.length > 0) {
      // Each re-export is followed on its own: two imports that ended up under one name
      // are two modules, and the module in front of them exports what both of them do.
      const selected = new Map<string, ModuleExportEntry>();
      for (const origin of origins) {
        const entry = this.entryForOrigin(parent, nested, origin, resolveSpecifier);
        if (entry) {
          selected.set(entry.importPath, entry);
        }
        // An origin that names a module the index does not hold expands to nothing:
        // the alternatives are modules this file demonstrably did not import.
      }
      return [...selected.values()];
    }

    // Nothing said where it came from. A module declared beside this one is the better
    // guess than any other of that name; failing that, the name is all there is to go on.
    const sameFile = nested.get(parent.importPath);
    return sameFile ? [sameFile] : [...nested.values()];
  }

  /**
   * The declaration one re-export refers to.
   * @internal
   */
  private entryForOrigin(
    parent: ModuleExportEntry,
    nested: ModuleExportEntries,
    origin: ModuleExportOrigin,
    resolveSpecifier?: SpecifierResolver
  ): ModuleExportEntry | undefined {
    return selectModuleEntry(
      nested,
      {
        specifier: origin.specifier,
        // A re-exported project module is imported by a relative path or an alias, which
        // is never one of the keys. Its file is: resolve it, once, and keep the answer on
        // the origin so a later expansion does not ask TypeScript again.
        resolveAbsolutePath: () => {
          if (origin.absolutePath === undefined && origin.specifier && parent.absolutePath && resolveSpecifier) {
            origin.absolutePath = resolveSpecifier(parent.absolutePath, origin.specifier);
          }
          return origin.absolutePath;
        },
      },
      // This module named the one it re-exported. Another module that merely shares the
      // name is not it, however alone it stands in the index.
      { strict: true }
    );
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
  public replaceModuleExports(moduleExports: Map<string, ModuleExportEntries>): void {
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
