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
import { type CoreLogger, silentLogger } from "./logging";

/** The slice of an element index that resolves NgModule exports. */
export interface ModuleExportsIndex {
  getExternalModuleExports(moduleName: string): Set<string> | undefined;
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
      const cached = this.cache.get(cacheKey)?.get(element.name);
      if (cached !== undefined) {
        return cached;
      }

      const isImported =
        this.checkDirectElementImport(sourceFile, element) || this.checkExternalModuleImports(sourceFile, element);

      this.rememberResult(cacheKey, element.name, isImported);
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
  }

  /** Drops every cached answer, for example after the index was rebuilt. */
  public clear(): void {
    this.cache.clear();
  }

  /** @internal */
  private rememberResult(cacheKey: string, elementName: string, isImported: boolean): void {
    let fileCache = this.cache.get(cacheKey);
    if (!fileCache) {
      fileCache = new Map();
      this.cache.set(cacheKey, fileCache);
    }
    fileCache.set(elementName, isImported);
  }

  /**
   * Checks if element is directly imported in the Component imports array.
   * @internal
   */
  private checkDirectElementImport(sourceFile: SourceFile, element: AngularElementData): boolean {
    for (const classDeclaration of sourceFile.getClasses()) {
      const importsArray = getComponentImportsArray(classDeclaration);
      if (!importsArray) {
        continue;
      }

      for (const importName of getImportNamesForElement(element)) {
        const isInImportsArray = importsArray
          .getElements()
          .some((el: Expression) => el.getText().trim() === importName);

        if (isInImportsArray) {
          const hasTopLevelImport = sourceFile
            .getImportDeclarations()
            .some((imp) => imp.getNamedImports().some((named) => named.getName() === importName));
          if (hasTopLevelImport) {
            return true;
          }
        }
      }
    }
    return false;
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
      if (this.checkClassImportsForElement(classDeclaration, element, index)) {
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
    index: ModuleExportsIndex
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
      if (this.checkModuleExportsForElement(moduleName, element, index)) {
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
    moduleName: string,
    element: AngularElementData,
    index: ModuleExportsIndex
  ): boolean {
    // First check if it's a standard Angular module (CommonModule, FormsModule, etc.)
    const standardModuleExports = getStandardModuleExports(moduleName);
    if (standardModuleExports?.has(element.name)) {
      this.logger.debug(
        `[ComponentImports] Element '${element.name}' found in standard Angular module '${moduleName}'`
      );
      return true;
    }

    // Then check the index for custom modules
    const moduleExports = index.getExternalModuleExports(moduleName);
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
