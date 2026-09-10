/**
 * What an NgModule says a file can import, for the project's own modules and for a
 * library's compiled ones.
 *
 * Both questions are the same shape — read a module's `exports`, decide what each entry
 * really names, and record which module is the one to suggest for it — but they read
 * different things: a project module is source, with an `@NgModule` decorator and an
 * `exports: [...]` array of identifiers, while a library module is a declaration file,
 * where the same list survives only as the fourth type argument of `ɵmod`.
 *
 * These run against a host rather than owning state, because the index, the ts-morph
 * project and the scan they are part of all belong to the indexer.
 * @module
 */

import * as path from "node:path";
import {
  type ArrayLiteralExpression,
  type ClassDeclaration,
  type Decorator,
  type EntityName,
  type ObjectLiteralExpression,
  type Project,
  type PropertyAssignment,
  type SourceFile,
  SyntaxKind,
  type TupleTypeNode,
  type TypeChecker,
  type TypeNode,
  type TypeReferenceNode,
} from "ts-morph";

import {
  type AngularElementIndex,
  type ModuleExportInfo,
  type ModuleExportOrigin,
  moduleEntryKey,
  moduleFitScore,
} from "../core/element-index";
import type { CoreLogger } from "../core/logging";

/** One entry point of a library: the specifier it is imported by, and the file it is. */
export interface LibraryEntryPoint {
  importPath: string;
  filePath: string;
}

/**
 * The best module to import each element from, for the library being indexed.
 *
 * Not the index's own map: this one is built and thrown away inside a single library
 * pass, and only feeds each element's `exportingModuleName` as it is indexed.
 */
export type LibraryModuleMap = Map<string, ModuleExportInfo>;

/** What reading the project's own NgModules needs from the indexer. */
export interface ProjectModuleHost {
  /** The ts-morph project the module files are added to. */
  readonly project: Project;
  /** The index the exports are recorded in. */
  readonly index: AngularElementIndex;
  readonly logger: CoreLogger;
  /** The root every indexed module path is written relative to. */
  readonly projectRootPath: string;
}

/** What reading a library's compiled NgModules needs from the indexer. */
export interface LibraryModuleHost {
  /** The index the external module exports are recorded in. */
  readonly index: AngularElementIndex;
  readonly logger: CoreLogger;
  /**
   * What the running `node_modules` scan has re-indexed, or `undefined` outside one.
   * A module indexed here is named in it so the scan can drop what it did not produce
   * again.
   */
  readonly rescanned: { modules: Set<string> } | undefined;
}

/**
 * Runs a callback only if the SourceFile node is still valid.
 *
 * ts-morph forgets nodes, and a forgotten one throws on any access rather than
 * reporting itself; asking for its path first is what turns that into a skip.
 * @param sourceFile The SourceFile to check.
 * @param callback The callback to execute if the SourceFile is valid.
 * @param context Context string for logging.
 * @param logger The logger to report a forgotten node through.
 * @returns Whether the callback ran, and what it returned.
 */
export function withValidSourceFile<T>(
  sourceFile: SourceFile,
  callback: () => T,
  context: string,
  logger: CoreLogger
): { success: boolean; result?: T } {
  try {
    sourceFile.getFilePath(); // This will throw if the node is forgotten
    const result = callback();
    return { success: true, result };
  } catch {
    logger.warn(`[Indexer] SourceFile node forgotten during ${context}, skipping`);
    return { success: false };
  }
}

/**
 * Parses the `ɵmod` property of a compiled Angular module class.
 * @param classDecl The class declaration to parse.
 * @returns The exports tuple if found, null otherwise.
 */
export function parseModDefinition(classDecl: ClassDeclaration): TupleTypeNode | null {
  const modDef = classDecl.getStaticProperty("ɵmod");
  if (!modDef?.isKind(SyntaxKind.PropertyDeclaration)) {
    return null;
  }

  const typeNode = modDef.getTypeNode();
  if (!typeNode?.isKind(SyntaxKind.TypeReference)) {
    return null;
  }

  const typeRef = typeNode as TypeReferenceNode;
  const typeArgs = typeRef.getTypeArguments();

  if (typeArgs.length <= 3 || !typeArgs[3].isKind(SyntaxKind.TupleType)) {
    return null;
  }

  return typeArgs[3].asKindOrThrow(SyntaxKind.TupleType);
}

/**
 * What a module's `exports` actually name, and where its file got them.
 *
 * Two things are read here, and both are about identity rather than text. An entry in
 * `exports: [...]` is a local name — after `import { SharedModule as LocalShared }` the
 * array says `LocalShared`, while every other file, and the index, call it
 * `SharedModule`; the index has to be told the declared name or it finds nothing. And a
 * name that is another module does not say *which* module of that name, so the specifier
 * its file imported it from is kept beside it. Only the specifier, never a resolved path:
 * this runs for every NgModule in the project, and resolving one makes TypeScript load
 * the file it names.
 * @param sourceFile The file declaring the module.
 * @param exportedNames The identifiers listed in the module's `exports`, as written.
 */
export function readModuleExports(
  sourceFile: SourceFile,
  exportedNames: string[]
): { names: string[]; origins: Map<string, ModuleExportOrigin[]> | undefined } {
  const wanted = new Set(exportedNames);
  const imported = new Map<string, { importedName: string; specifier: string }>();

  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    for (const namedImport of declaration.getNamedImports()) {
      const localName = (namedImport.getAliasNode() ?? namedImport.getNameNode()).getText();
      if (wanted.has(localName)) {
        imported.set(localName, { importedName: namedImport.getName(), specifier });
      }
    }
  }

  const names: string[] = [];
  const origins = new Map<string, ModuleExportOrigin[]>();

  for (const localName of exportedNames) {
    const binding = imported.get(localName);
    // A name the file does not import is declared in it, and is already its own.
    names.push(binding?.importedName ?? localName);
    if (!binding) {
      continue;
    }

    // `exports: [LeftShared, RightShared]` after two imports of `SharedModule` is one
    // name and two modules. Both are kept: dropping either would silently take a module
    // out of what this one exports.
    const forName = origins.get(binding.importedName) ?? [];
    if (!forName.some((origin) => origin.specifier === binding.specifier)) {
      forName.push({ specifier: binding.specifier });
    }
    origins.set(binding.importedName, forName);
  }

  return { names, origins: origins.size > 0 ? origins : undefined };
}

/**
 * The path a project module is indexed under: its file, relative to the project root.
 * @param projectRootPath The root the path is written relative to.
 * @param file The module file, or its path.
 */
export function projectModulePath(projectRootPath: string, file: SourceFile | string): string {
  const filePath = typeof file === "string" ? file : file.getFilePath();
  return path.relative(projectRootPath, filePath).replace(/\\/g, "/");
}

/**
 * Collects the class declarations a file publicly re-exports.
 *
 * Only what an entry point re-exports under its own name is importable API, so private
 * aliases such as `export { Foo as ɵFoo }` are filtered out here rather than being
 * offered to a user as an import.
 * @param sourceFile The source file to collect classes from.
 * @returns A map of class names to their declarations.
 */
export function collectClassDeclarations(sourceFile: SourceFile): Map<string, ClassDeclaration> {
  const classDeclarations = new Map<string, ClassDeclaration>();

  const exportedDeclarations = sourceFile.getExportedDeclarations();
  for (const [exportName, declarations] of exportedDeclarations.entries()) {
    if (exportName.startsWith("ɵ")) {
      continue;
    }

    for (const declaration of declarations) {
      if (declaration.isKind(SyntaxKind.ClassDeclaration)) {
        const classDecl = declaration as ClassDeclaration;
        const name = classDecl.getName();
        if (name && !classDeclarations.has(name)) {
          classDeclarations.set(name, classDecl);
        }
      }
    }
  }

  return classDeclarations;
}

/**
 * Indexes every NgModule the project declares.
 * @param host The indexer state this reads and writes.
 * @param moduleFilePaths An array of absolute module file paths to index.
 */
export async function indexProjectModules(host: ProjectModuleHost, moduleFilePaths: string[]): Promise<void> {
  if (!host.projectRootPath) {
    return;
  }
  host.logger.debug(`[Indexer] Indexing ${moduleFilePaths.length} project NgModules for ${host.projectRootPath}...`);
  host.index.componentModules.clear();

  for (const file of moduleFilePaths) {
    try {
      const sourceFile = host.project.addSourceFileAtPath(file);
      // Check if the sourceFile is still valid before processing
      sourceFile.getFilePath(); // This will throw if the node is forgotten
      processProjectModuleFile(host, sourceFile);
    } catch (error) {
      host.logger.warn(`[Indexer] Could not process project module file ${file}: ${(error as Error).message}`);
    }
  }

  // Process already opened files that might be modules
  for (const sourceFile of host.project.getSourceFiles()) {
    const result = withValidSourceFile(
      sourceFile,
      () => sourceFile.getFilePath(),
      "project module processing",
      host.logger
    );
    if (result.success && result.result) {
      const filePath = result.result;
      if (filePath.endsWith(".module.ts") && !moduleFilePaths.includes(filePath)) {
        processProjectModuleFile(host, sourceFile);
      }
    }
  }
  host.logger.debug(`[Indexer] Found ${host.index.componentModules.size} component-to-module mappings in project.`);
}

/**
 * Processes a single project module file.
 *
 * Exported because a file that changed is re-read on its own, outside any full scan.
 * @param host The indexer state this reads and writes.
 * @param sourceFile The module file to read.
 * @returns Whether the file declared an NgModule whose exports were indexed.
 */
export function processProjectModuleFile(host: ProjectModuleHost, sourceFile: SourceFile): boolean {
  if (!isSourceFileValid(host.logger, sourceFile)) {
    return false;
  }

  let indexed = false;
  const classDeclarations = sourceFile.getClasses();
  for (const classDecl of classDeclarations) {
    indexed = processNgModuleClass(host, classDecl, sourceFile) || indexed;
  }
  return indexed;
}

/** Checks if a source file node is still valid. */
function isSourceFileValid(logger: CoreLogger, sourceFile: SourceFile): boolean {
  try {
    sourceFile.getFilePath();
    return true;
  } catch {
    logger.warn(`[Indexer] SourceFile node forgotten in _processProjectModuleFile, skipping`);
    return false;
  }
}

/**
 * Processes a single NgModule class.
 * @returns Whether the class was an NgModule whose exports were indexed.
 */
function processNgModuleClass(host: ProjectModuleHost, classDecl: ClassDeclaration, sourceFile: SourceFile): boolean {
  const ngModuleDecorator = classDecl.getDecorator("NgModule");
  if (!ngModuleDecorator) {
    return false;
  }

  const moduleName = classDecl.getName();
  if (!moduleName) {
    return false;
  }

  const objectLiteral = getNgModuleObjectLiteral(ngModuleDecorator);
  if (!objectLiteral) {
    return false;
  }

  const exportsProp = objectLiteral.getProperty("exports");
  if (!exportsProp) {
    return false;
  }

  return processModuleExports(host, exportsProp as PropertyAssignment, moduleName, sourceFile);
}

/** Gets the NgModule decorator's object literal. */
function getNgModuleObjectLiteral(ngModuleDecorator: Decorator): ObjectLiteralExpression | null {
  const decoratorArg = ngModuleDecorator.getArguments()[0];
  if (!decoratorArg?.isKind(SyntaxKind.ObjectLiteralExpression)) {
    return null;
  }
  return decoratorArg as ObjectLiteralExpression;
}

/** Processes the `exports` of one project NgModule. */
function processModuleExports(
  host: ProjectModuleHost,
  exportsProp: PropertyAssignment,
  moduleName: string,
  sourceFile: SourceFile
): boolean {
  const listed = identifierNamesFromArrayProp(exportsProp);

  if (listed.length === 0) {
    return false;
  }

  const { names, origins } = readModuleExports(sourceFile, listed);
  storeModuleExports(host, moduleName, names, origins, sourceFile);
  updateProjectModuleMap(host, names, moduleName, sourceFile);
  return true;
}

/**
 * Stores module exports in the index.
 * @param host The indexer state this writes to.
 * @param moduleName The NgModule's class name.
 * @param exportedNames The names its `exports` refer to, as they are declared.
 * @param origins Where the file imported each of those names from.
 * @param sourceFile The file declaring the module, which is what identifies this
 * declaration among others of the same name.
 */
function storeModuleExports(
  host: ProjectModuleHost,
  moduleName: string,
  exportedNames: string[],
  origins: Map<string, ModuleExportOrigin[]> | undefined,
  sourceFile: SourceFile
): void {
  host.index.addModuleExports(moduleName, {
    importPath: projectModulePath(host.projectRootPath, sourceFile),
    absolutePath: sourceFile.getFilePath(),
    declarationPath: sourceFile.getFilePath(),
    exports: new Set(exportedNames),
    origins,
  });
  host.logger.debug(
    `[ProjectModules] Indexed module ${moduleName} with ${exportedNames.length} exports: ${exportedNames.join(", ")}`
  );
}

/**
 * Records this module as one way to import each element it exports.
 *
 * Which of several modules is the one to suggest is decided when the question is asked,
 * not here: a module that stops exporting an element must leave the others standing.
 */
function updateProjectModuleMap(
  host: ProjectModuleHost,
  exportedNames: string[],
  moduleName: string,
  sourceFile: SourceFile
): void {
  const importPath = projectModulePath(host.projectRootPath, sourceFile);
  const exportCount = exportedNames.length;

  for (const componentName of exportedNames) {
    host.index.addComponentModule(componentName, { moduleName, importPath, exportCount });
  }
}

/**
 * Gets the names of identifiers in an array property.
 * @param prop The property assignment to get the identifiers from.
 * @returns An array of identifier names.
 */
function identifierNamesFromArrayProp(prop: PropertyAssignment | undefined): string[] {
  if (!prop) {
    return [];
  }
  const initializer = prop.getInitializer();

  // Handle direct array literals
  if (initializer?.isKind(SyntaxKind.ArrayLiteralExpression)) {
    const arr = initializer as ArrayLiteralExpression;
    return arr.getElements().map((el) => el.getText());
  }

  // Handle variable references (like EXPORTED_DECLARATIONS)
  if (initializer?.isKind(SyntaxKind.Identifier)) {
    const varName = initializer.getText();
    const sourceFile = prop.getSourceFile();

    // Find the variable declaration
    const variableDeclaration = sourceFile.getVariableDeclaration(varName);
    if (variableDeclaration) {
      const varInitializer = variableDeclaration.getInitializer();
      if (varInitializer?.isKind(SyntaxKind.ArrayLiteralExpression)) {
        const arr = varInitializer as ArrayLiteralExpression;
        return arr.getElements().map((el) => el.getText());
      }
    }
  }

  return [];
}

/**
 * Everything one pass over a single library carries.
 *
 * These four travel together through every step of reading that library's modules —
 * the recursion through re-exported modules threads them unchanged — so they are one
 * argument rather than four repeated at each hop.
 */
interface LibraryModulePass {
  /** The indexer state the pass reads and writes. */
  readonly host: LibraryModuleHost;
  /** The best module to import each element from, built up as the pass runs. */
  readonly componentToModuleMap: LibraryModuleMap;
  /** Every class the library entry point re-exports, by name. */
  readonly allLibraryClasses: Map<string, ClassDeclaration>;
  readonly typeChecker: TypeChecker;
}

/**
 * Builds a map of components to the modules that export them.
 * @param host The indexer state this reads and writes.
 * @param sourceFile The source file to process.
 * @param importPath The import path of the source file.
 * @param componentToModuleMap The map to store the component-to-module mappings.
 * @param allLibraryClasses A map of all classes in the library.
 * @param typeChecker The type checker to use.
 */
export function buildComponentToModuleMap(
  host: LibraryModuleHost,
  sourceFile: SourceFile,
  importPath: string,
  componentToModuleMap: LibraryModuleMap,
  allLibraryClasses: Map<string, ClassDeclaration>,
  typeChecker: TypeChecker
): void {
  const pass: LibraryModulePass = { host, componentToModuleMap, allLibraryClasses, typeChecker };
  try {
    const classDeclarations = collectClassDeclarations(sourceFile);
    processNgModuleClasses(pass, classDeclarations, { importPath, filePath: sourceFile.getFilePath() });
  } catch (error) {
    try {
      host.logger.error(`Error building module map for file ${sourceFile.getFilePath()}: ${(error as Error).message}`);
    } catch {
      host.logger.error(`Error building module map for forgotten SourceFile node: ${(error as Error).message}`);
    }
  }
}

/** Processes all NgModule classes of one entry point and maps their exports. */
function processNgModuleClasses(
  pass: LibraryModulePass,
  classDeclarations: Map<string, ClassDeclaration>,
  entryPoint: LibraryEntryPoint
): void {
  // Find all NgModules among the correctly found classes and map their exports
  for (const classDecl of classDeclarations.values()) {
    const className = classDecl.getName();
    // Skip unnamed or internal Angular modules
    if (!className || className.startsWith("ɵ")) {
      continue;
    }

    processLibraryNgModuleClass(pass, classDecl, className, entryPoint);
  }
}

/** Processes a single compiled NgModule class and maps its exports. */
function processLibraryNgModuleClass(
  pass: LibraryModulePass,
  classDecl: ClassDeclaration,
  className: string,
  entryPoint: LibraryEntryPoint
): void {
  const exportsTuple = parseModDefinition(classDecl);
  if (!exportsTuple) {
    return;
  }
  const moduleExports = new Set<string>();

  processLibraryModuleExports(pass, exportsTuple, className, entryPoint.importPath, moduleExports);

  // Store the accumulated exports in the external modules index. The entry is keyed by
  // the entry point it is imported from, which is what tells two libraries' modules of
  // the same name apart. No `absolutePath` is recorded: a library module is named in a
  // component by that same specifier, so the path fallback never applies to it.
  if (moduleExports.size > 0) {
    pass.host.index.addModuleExports(className, {
      importPath: entryPoint.importPath,
      // The entry point's own file, so an import written through a tsconfig alias — a
      // string that matches no key — still resolves to this declaration.
      absolutePath: entryPoint.filePath,
      // And the file the class lives in, which is what makes the same module reached
      // through `@lib`, `@lib/components` and `@lib/components/svg` one module.
      declarationPath: classDecl.getSourceFile().getFilePath(),
      exports: moduleExports,
      external: true,
    });
    pass.host.rescanned?.modules.add(moduleEntryKey(className, entryPoint.importPath));
    pass.host.logger.debug(
      `[ExternalModules] Indexed module ${className} with ${moduleExports.size} exports: ${Array.from(moduleExports).join(", ")}`
    );
  }
}

/**
 * Processes the exports of a compiled module.
 * @param moduleExports Optional Set to accumulate all exports for the module.
 */
function processLibraryModuleExports(
  pass: LibraryModulePass,
  exportsTuple: TupleTypeNode,
  moduleName: string,
  importPath: string,
  moduleExports?: Set<string>
): void {
  const { logger } = pass.host;
  for (const element of exportsTuple.getElements()) {
    const exportedClassName = resolveExportedClassName(element, pass.typeChecker, logger);
    if (!exportedClassName) {
      logger.debug(
        `[ExternalModules] ${moduleName}: could not resolve export name from tuple entry '${element.getText()}' (skipped)`
      );
      continue;
    }

    const exportedClassDecl = pass.allLibraryClasses.get(exportedClassName);
    if (!exportedClassDecl) {
      logger.debug(
        `[ExternalModules] ${moduleName}: export '${exportedClassName}' not found in collected library classes (skipped)`
      );
      continue;
    }

    if (isReexportedModule(exportedClassDecl)) {
      // Add the re-exported module name to parent's exports (for transitive expansion)
      moduleExports?.add(exportedClassName);
      logger.debug(
        `[ExternalModules] ${moduleName} re-exports module ${exportedClassName} (will be expanded transitively)`
      );

      // Still process the module's contents recursively (for componentToModuleMap, etc)
      processReexportedModule(pass, exportedClassDecl, moduleName, importPath, moduleExports);
    } else {
      mapComponentToModule(pass, exportedClassName, moduleName, importPath, moduleExports);
    }
  }
}

/**
 * Resolves the exported class name from an NgModule `ɵmod` exports tuple element.
 *
 * Tuple elements look like `typeof i1.TranslatePipe` (TypeQuery) or `TranslatePipe`
 * (TypeReference). Resolution prefers the TypeChecker (which follows re-export
 * aliases), but falls back to the syntactic name when symbol resolution yields
 * nothing. The fallback matters for environments where cross-file symbol
 * resolution is unreliable (e.g. WSL/Windows mounts with symlinked or
 * case-mismatched `node_modules`): without it, a module's exports are silently
 * dropped, producing false-positive "not imported" diagnostics for pipes/directives
 * that are actually provided via an imported NgModule (e.g. `TranslateModule`).
 * The syntactic name (`TranslatePipe`) matches the keys in `allLibraryClasses`,
 * which are collected without the TypeChecker and therefore stay available.
 *
 * @param element The tuple element to resolve.
 * @param typeChecker The type checker to use.
 * @param logger The logger the TypeChecker fallback is reported through.
 * @returns The exported class name or undefined.
 */
export function resolveExportedClassName(
  element: TypeNode,
  typeChecker: TypeChecker,
  logger: CoreLogger
): string | undefined {
  let exprName: EntityName;
  if (element.isKind(SyntaxKind.TypeQuery)) {
    exprName = element.getExprName();
  } else if (element.isKind(SyntaxKind.TypeReference)) {
    exprName = element.getTypeName();
  } else {
    return undefined;
  }

  // Syntactic name: the right-most identifier of the (possibly qualified) name,
  // e.g. `i1.TranslatePipe` -> `TranslatePipe`. Used as a TypeChecker-independent fallback.
  const syntacticName = exprName.isKind(SyntaxKind.QualifiedName) ? exprName.getRight().getText() : exprName.getText();

  const type = typeChecker.getTypeAtLocation(exprName);
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  const resolvedName = symbol ? (symbol.getAliasedSymbol() ?? symbol).getName() : undefined;

  if (!resolvedName && syntacticName) {
    // TypeChecker could not resolve the symbol (e.g. WSL/Windows mounts with
    // symlinked or case-mismatched node_modules). The syntactic fallback below
    // recovers the export that would otherwise be silently dropped.
    logger.debug(
      `[ExternalModules] TypeChecker could not resolve export '${exprName.getText()}', using syntactic name '${syntacticName}'`
    );
  }

  return resolvedName ?? syntacticName ?? undefined;
}

/** Checks if the exported class declaration is a re-exported NgModule. */
function isReexportedModule(exportedClassDecl: ClassDeclaration): boolean {
  return !!exportedClassDecl.getStaticProperty("ɵmod");
}

/** Processes a re-exported module by recursively processing its exports. */
function processReexportedModule(
  pass: LibraryModulePass,
  exportedClassDecl: ClassDeclaration,
  moduleName: string,
  importPath: string,
  moduleExports?: Set<string>
): void {
  const innerExportsTuple = parseModDefinition(exportedClassDecl);
  if (innerExportsTuple) {
    processLibraryModuleExports(pass, innerExportsTuple, moduleName, importPath, moduleExports);
  }
}

/** Maps a component/directive/pipe to the module that is the best one to import it from. */
function mapComponentToModule(
  pass: LibraryModulePass,
  exportedClassName: string,
  moduleName: string,
  importPath: string,
  moduleExports?: Set<string>
): void {
  // This function is only called during library indexing where we build the module exports on the fly.
  // If moduleExports is not present, we can't perform scoring, so we can't add the mapping.
  if (!moduleExports) {
    return;
  }

  const exportCount = moduleExports.size;
  const existing = pass.componentToModuleMap.get(exportedClassName);

  const newCandidate = { moduleName, importPath, exportCount };

  if (existing) {
    const newScore = moduleFitScore(exportedClassName, newCandidate);
    const existingScore = moduleFitScore(exportedClassName, existing);

    // If new one is better, update the map.
    if (newScore > existingScore) {
      pass.componentToModuleMap.set(exportedClassName, newCandidate);
    }
  } else {
    // If it doesn't exist, add it.
    pass.componentToModuleMap.set(exportedClassName, newCandidate);
  }

  // This is for accumulating all unique exports for the top-level module being processed.
  moduleExports.add(exportedClassName);
}
