/**
 * Answers what a component file already imports.
 *
 * Reads the component's `imports: [...]` and the file's top-level imports through
 * ts-morph, resolving elements that arrive through an NgModule as well, and caches
 * the answer per file so one template pass asks the AST once per element.
 * @module
 */

import {
  type ArrayLiteralExpression,
  type ClassDeclaration,
  type Expression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import { getStandardModuleExports } from "../config/standard-modules";
import type { AngularElementData } from "../types";
import { normalizePath } from "../utils/path";
import type { BundleEntry } from "./element-index";
import {
  type ModuleExportEntries,
  type ModuleImportOrigin,
  sameModuleDeclaration,
  selectModuleEntry,
} from "./element-index";
import { type CoreLogger, silentLogger } from "./logging";
import { elementIdentityKey } from "./selector-trie";

/** The slice of an element index that resolves NgModule exports. */
export interface ModuleExportsIndex {
  getExternalModuleExports(moduleName: string, origin?: ModuleImportOrigin): Set<string> | undefined;
  /** Every declaration of a module name, for deciding which of them a file imports. */
  getModuleEntries?(moduleName: string): ModuleExportEntries | undefined;
  /**
   * The bundles that hold one of these classes, read while their libraries were indexed.
   * @param names The class names to look for.
   * @param absolutePath Where that class is declared, so a bundle holding another class of
   * the same name is not mistaken for one holding it.
   */
  bundlesHolding?(names: Iterable<string>, absolutePath?: string): Map<string, BundleEntry[]>;
}

export interface ComponentImportsOptions {
  /**
   * Finds the index that owns a file, so a nested project resolves against its own
   * index rather than the workspace root's.
   */
  resolveIndex(filePath: string): ModuleExportsIndex | undefined;
  logger?: CoreLogger;
}

/**
 * Resolves and caches "does this component already import that element", for every
 * component file the analysis touches.
 */
export class ComponentImports {
  private readonly cache = new Map<string, Map<string, boolean>>();
  /**
   * Per file, what each identifier it imports is actually called and where it came from.
   *
   * Reading it costs an AST walk, and one template pass asks about the same handful of
   * identifiers once per element, so the answers live here for as long as the file's
   * other answers do.
   */
  private readonly bindings = new Map<string, Map<string, ModuleBinding>>();
  private readonly logger: CoreLogger;

  constructor(private readonly options: ComponentImportsOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * Checks whether the element is usable in the file's templates already.
   * @param sourceFile The component's source file.
   * @param element The element the template needs.
   */
  public isImported(sourceFile: SourceFile, element: AngularElementData): boolean {
    try {
      if (!sourceFile) {
        return false;
      }

      const cacheKey = cacheKeyFor(sourceFile.getFilePath());
      // Keyed by what the element *is*, not what it is called: an element reached through
      // an NgModule is named after that module, so every element the module exports would
      // otherwise share one answer — the first one asked about.
      const elementKey = elementIdentityKey(element);
      const cached = this.cache.get(cacheKey)?.get(elementKey);
      if (cached !== undefined) {
        return cached;
      }

      const isImported =
        this.checkDirectElementImport(sourceFile, element) || this.checkExternalModuleImports(sourceFile, element);

      this.rememberResult(cacheKey, elementKey, isImported);
      return isImported;
    } catch (error) {
      this.logger.error("[ComponentImports] Error checking element import with ts-morph:", error as Error);
      return false;
    }
  }

  /**
   * Returns every identifier listed in a `@Component({ imports: [...] })` in this file.
   * @param sourceFile The component's source file.
   */
  public getImportNames(sourceFile: SourceFile): string[] {
    const importNames = new Set<string>();

    for (const classDeclaration of sourceFile.getClasses()) {
      const importsArray = getComponentImportsArray(classDeclaration);
      if (!importsArray) {
        continue;
      }

      for (const element of importsArray.getElements()) {
        if (element.isKind(SyntaxKind.Identifier)) {
          importNames.add(element.getText().trim());
        }
      }
    }

    return [...importNames];
  }

  /**
   * Returns the module specifiers of every top-level named import of `importName`.
   * @param sourceFile The component's source file.
   * @param importName The imported identifier to look for.
   */
  public getNamedImportSpecifiers(sourceFile: SourceFile, importName: string): string[] {
    const moduleSpecifiers: string[] = [];

    for (const declaration of sourceFile.getImportDeclarations()) {
      if (!declaration.getNamedImports().some((namedImport) => namedImport.getName() === importName)) {
        continue;
      }

      moduleSpecifiers.push(declaration.getModuleSpecifierValue());
    }

    return moduleSpecifiers;
  }

  /**
   * Drops the cached answers for one file, for example after it was edited.
   * @param filePath The file whose answers are stale.
   */
  public invalidate(filePath: string): void {
    this.cache.delete(cacheKeyFor(filePath));
    this.bindings.delete(cacheKeyFor(filePath));
  }

  /** Drops every cached answer, for example after the index was rebuilt. */
  public clear(): void {
    this.cache.clear();
    this.bindings.clear();
  }

  /**
   * What an identifier this file uses is really called, and where it was imported from.
   * @internal
   */
  private bindingFor(sourceFile: SourceFile, localName: string): ModuleBinding {
    const cacheKey = cacheKeyFor(sourceFile.getFilePath());
    let fileBindings = this.bindings.get(cacheKey);
    if (!fileBindings) {
      fileBindings = new Map();
      this.bindings.set(cacheKey, fileBindings);
    }

    let binding = fileBindings.get(localName);
    if (!binding) {
      binding = readBinding(sourceFile, localName);
      fileBindings.set(localName, binding);
    }
    return binding;
  }

  /** @internal */
  private rememberResult(cacheKey: string, elementKey: string, isImported: boolean): void {
    let fileCache = this.cache.get(cacheKey);
    if (!fileCache) {
      fileCache = new Map();
      this.cache.set(cacheKey, fileCache);
    }
    fileCache.set(elementKey, isImported);
  }

  /**
   * Checks if element is directly imported in the Component imports array.
   * @internal
   */
  private checkDirectElementImport(sourceFile: SourceFile, element: AngularElementData): boolean {
    const wanted = new Set(getImportNamesForElement(element));

    for (const classDeclaration of sourceFile.getClasses()) {
      const importsArray = getComponentImportsArray(classDeclaration);
      if (!importsArray) {
        continue;
      }

      if (
        this.listsTheElement(importsArray, wanted, element, sourceFile) ||
        this.listsBundleHolding(importsArray, element, wanted, sourceFile)
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Whether one of the listed names is the element, or the module that exports it.
   * @internal
   */
  private listsTheElement(
    importsArray: ArrayLiteralExpression,
    wanted: ReadonlySet<string>,
    element: AngularElementData,
    sourceFile: SourceFile
  ): boolean {
    for (const entry of importsArray.getElements()) {
      // What the file calls it says nothing about what it is: `imports: [Card]` after
      // `import { CardComponent as Card }` is the element, imported under another name.
      const binding = this.bindingFor(sourceFile, entry.getText().trim());
      if (binding.specifier === undefined || !wanted.has(binding.importedName)) {
        continue;
      }
      if (this.namesTheElementsOwnModule(binding, element, sourceFile)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Whether one of the listed names is a bundle holding the element.
   *
   * A name in `imports: [...]` is not always a class: libraries ship a component with the
   * directives that belong to it as one array — `TuiComboBox` is
   * `readonly [typeof TuiComboBoxDirective, typeof TuiLabel, …]` — and Angular takes that
   * as if its members were written out. A bundle's members need not come from the package
   * the bundle does: that `TuiLabel` is `@taiga-ui/core`'s, listed by a bundle from
   * `@taiga-ui/kit`.
   *
   * What each bundle holds was read when it was indexed, and the question is asked the way
   * round that costs nothing when the answer is no: which bundles hold this element,
   * rather than what each of a file's imports holds. A component can list seventy of them,
   * and every edit to it makes the answers stale.
   * @internal
   */
  private listsBundleHolding(
    importsArray: ArrayLiteralExpression,
    element: AngularElementData,
    wanted: ReadonlySet<string>,
    sourceFile: SourceFile
  ): boolean {
    const holders = this.options.resolveIndex(sourceFile.getFilePath())?.bundlesHolding?.(wanted, element.absolutePath);
    if (!holders || holders.size === 0) {
      return false;
    }

    for (const listedEntry of importsArray.getElements()) {
      // Nothing is read about an import until its written name could be one of the bundles
      // in question — which, holders being empty almost always, is almost never.
      const listed = listedEntry.getText().trim();
      const binding = holders.has(listed) ? undefined : this.bindingFor(sourceFile, listed);
      const candidates = holders.get(listed) ?? (binding && holders.get(binding.importedName));
      if (!candidates) {
        continue;
      }

      // The name is not enough. A file that imports `Bundle` from `@lib/b` has what
      // *that* bundle holds, and a local variable of the same name has nothing at all.
      const origin = binding ?? this.bindingFor(sourceFile, listed);
      if (origin.specifier !== undefined && candidates.some((candidate) => isTheSameBundle(candidate, origin))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Whether the module this file imports is the one the element is exported by.
   *
   * The name alone does not say so. An element reached through an NgModule is indexed as
   * that module — same name, same path — so a file importing a *different* module of the
   * same name would otherwise satisfy every element the first one exports.
   * @internal
   */
  private namesTheElementsOwnModule(
    binding: ModuleBinding,
    element: AngularElementData,
    sourceFile: SourceFile
  ): boolean {
    if (binding.importedName !== element.exportingModuleName) {
      return true; // The file imports the element itself, not a module that offers it.
    }

    const entries = this.options.resolveIndex(sourceFile.getFilePath())?.getModuleEntries?.(binding.importedName);
    if (!entries || entries.size <= 1) {
      return true; // Only one module answers to the name, so it is that one.
    }

    const selected = selectModuleEntry(entries, binding);
    if (!selected) {
      // Nothing matched this file's import. That is absence of knowledge, not evidence
      // that it imported a different module — and the visible cost of guessing wrong
      // here is telling someone an import they are looking at is missing.
      this.logger.debug(
        `[ComponentImports] '${binding.importedName}' is declared in several places and this file's import matched none`
      );
      return true;
    }

    // `path` is where the element is imported from, which for one reached through a
    // module is that module's own path — one of possibly several it is reachable by.
    const own = entries.get(element.path);
    return own ? sameModuleDeclaration(selected, own) : true;
  }

  /**
   * Checks if element is imported via external modules.
   * @internal
   */
  private checkExternalModuleImports(sourceFile: SourceFile, element: AngularElementData): boolean {
    const index = this.options.resolveIndex(sourceFile.getFilePath());
    if (!index) {
      return false;
    }

    for (const classDeclaration of sourceFile.getClasses()) {
      if (this.checkClassImportsForElement(classDeclaration, element, index, sourceFile)) {
        return true;
      }
    }
    this.logger.debug(`[ComponentImports] Element '${element.name}' not found in any imported modules`);
    return false;
  }

  /**
   * Checks if a class declaration imports an element via its module imports.
   * @internal
   */
  private checkClassImportsForElement(
    classDeclaration: ClassDeclaration,
    element: AngularElementData,
    index: ModuleExportsIndex,
    sourceFile: SourceFile
  ): boolean {
    const importsArray = getComponentImportsArray(classDeclaration);
    if (!importsArray) {
      return false;
    }

    const importedModules = importsArray.getElements().map((el: Expression) => el.getText().trim());
    this.logger.debug(
      `[ComponentImports] Checking element '${element.name}' against ${importedModules.length} imported modules: [${importedModules.join(", ")}]`
    );

    for (const moduleName of importedModules) {
      if (this.checkModuleExportsForElement(this.bindingFor(sourceFile, moduleName), element, index)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks if a module exports a specific element.
   * @internal
   */
  private checkModuleExportsForElement(
    binding: ModuleBinding,
    element: AngularElementData,
    index: ModuleExportsIndex
  ): boolean {
    // The module is asked about under the name it is declared with, not the one this
    // file happens to call it: `import { ScrollingModule as CdkScrolling }` is still
    // ScrollingModule everywhere but in this file.
    const moduleName = binding.importedName;

    // First check if it's a standard Angular module (CommonModule, FormsModule, etc.)
    const standardModuleExports = getStandardModuleExports(moduleName);
    if (standardModuleExports?.has(element.name)) {
      this.logger.debug(
        `[ComponentImports] Element '${element.name}' found in standard Angular module '${moduleName}'`
      );
      return true;
    }

    // Then check the index for custom modules, saying which of them this file imports:
    // one name can stand for a module in each of several libraries.
    const moduleExports = index.getExternalModuleExports(moduleName, binding);
    if (!moduleExports) {
      this.logger.debug(
        `[ComponentImports] Module '${moduleName}' not found in indexer. This module may not be indexed yet.`
      );
      return false;
    }

    this.logger.debug(
      `[ComponentImports] Module '${moduleName}' exports ${moduleExports.size} items: [${Array.from(moduleExports).slice(0, 10).join(", ")}${moduleExports.size > 10 ? ", ..." : ""}]`
    );

    if (moduleExports.has(element.name)) {
      this.logger.debug(
        `[ComponentImports] Element '${element.name}' found in external module '${moduleName}' exports`
      );
      return true;
    }

    return false;
  }
}

/**
 * Whether an import names this bundle.
 *
 * The specifier as written settles a library's, whose path is that same string. A
 * workspace's bundle is indexed by its file and imported by a relative path or an alias,
 * which is a different string for one file — so the file is what those are compared by.
 * @internal
 */
function isTheSameBundle(bundle: BundleEntry, origin: ModuleBinding): boolean {
  if (bundle.importPath === origin.specifier) {
    return true;
  }

  const resolved = origin.resolveAbsolutePath?.();
  return (
    bundle.absolutePath !== undefined &&
    resolved !== undefined &&
    normalizePath(bundle.absolutePath) === normalizePath(resolved)
  );
}

/**
 * One identifier a component file uses, resolved back to what it actually is.
 *
 * The two are not the same string once an import renames it, and every answer about a
 * module has to be asked under its declared name: the index is keyed by that, not by
 * what this file calls it. The specifier doubles as the origin the index needs to tell
 * two declarations of one name apart, which is why this is also a {@link ModuleImportOrigin}.
 * @internal
 */
interface ModuleBinding extends ModuleImportOrigin {
  /** The name the declaring module is exported under, which the index is keyed by. */
  importedName: string;
  /** The specifier it is imported from, absent when this file does not import it at all. */
  specifier?: string;
}

/**
 * Reads what an identifier is bound to in this file.
 *
 * Resolving the specifier to a file is left as a callback rather than done here: it is
 * needed only for a project module whose name several files declare, and asking for it
 * makes TypeScript load the file the specifier names.
 * @internal
 */
function readBinding(sourceFile: SourceFile, localName: string): ModuleBinding {
  for (const declaration of sourceFile.getImportDeclarations()) {
    for (const named of declaration.getNamedImports()) {
      if ((named.getAliasNode() ?? named.getNameNode()).getText() !== localName) {
        continue;
      }

      return {
        importedName: named.getName(),
        specifier: declaration.getModuleSpecifierValue(),
        resolveAbsolutePath: () => {
          try {
            return declaration.getModuleSpecifierSourceFile()?.getFilePath();
          } catch {
            // The specifier names nothing this project can resolve.
            return undefined;
          }
        },
      };
    }
  }

  // Not imported here: declared in this file, or not imported at all.
  return { importedName: localName };
}

/**
 * Gets the imports array from a Component decorator.
 * @internal
 */
function getComponentImportsArray(classDeclaration: ClassDeclaration): ArrayLiteralExpression | undefined {
  const componentDecorator = classDeclaration.getDecorator("Component");
  if (!componentDecorator) {
    return undefined;
  }

  const decoratorArgs = componentDecorator.getArguments();
  if (decoratorArgs.length === 0 || !decoratorArgs[0].isKind(SyntaxKind.ObjectLiteralExpression)) {
    return undefined;
  }

  const importsProperty = decoratorArgs[0].getProperty("imports");
  if (!importsProperty?.isKind(SyntaxKind.PropertyAssignment)) {
    return undefined;
  }

  const initializer = importsProperty.getInitializer();
  return initializer?.isKind(SyntaxKind.ArrayLiteralExpression) ? initializer : undefined;
}

/**
 * The identifiers that would make an element available: the element itself, or the
 * NgModule that exports it.
 * @internal
 */
function getImportNamesForElement(element: AngularElementData): string[] {
  const names = [element.name];
  if (element.exportingModuleName && element.exportingModuleName !== element.name) {
    names.push(element.exportingModuleName);
  }
  return names;
}

/**
 * One spelling of a path, so a key written by one caller is found by another.
 *
 * ts-morph reports paths with forward slashes whatever the platform, while a path taken
 * from a document URI keeps the platform's own separator. On Windows those are two
 * different strings for one file, and a cache keyed by one would never be invalidated
 * through the other — leaving diagnostics that never noticed the component had changed.
 * @internal
 */
function cacheKeyFor(filePath: string): string {
  return normalizePath(filePath);
}
