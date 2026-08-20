/**
 * Angular Indexer Service
 * Responsible for indexing Angular components, directives, and pipes.
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ArrayLiteralExpression,
  type ClassDeclaration,
  type Decorator,
  type LiteralTypeNode,
  type ObjectLiteralExpression,
  Project,
  type PropertyAssignment,
  type SourceFile,
  SyntaxKind,
  type TypeChecker,
  type TypeReferenceNode,
} from "ts-morph";

import { isLibraryExcluded } from "../config/excluded-libraries";
import type { CacheStore } from "../core/cache";
import { type CancellationSignal, neverCancelled } from "../core/cancellation";
import { AngularElementIndex, type ComponentToModuleMap } from "../core/element-index";
import type { Disposable } from "../core/events";
import { Emitter, type EventSource } from "../core/events";
import type { FileSystem } from "../core/file-system";
import type { FileChange, FileWatcherFactory } from "../core/file-watching";
import type { CoreLogger, InstrumentedLogger, PerformanceMetrics } from "../core/logging";
import type { ProgressHost, ProgressReporter } from "../core/progress";
import { isProjectSourceFile, projectSourceQuery } from "../core/source-files";
import { AngularElementData, type ComponentInfo, type FileElementsInfo } from "../types";
import { isStandalone, parseAngularSelector } from "../utils/angular";
import { debounce } from "../utils/debounce";
import { findAngularDependencies, getLibraryEntryPoints } from "../utils/package-json";
import { isPathInside } from "../utils/path";

/**
 * Glob (relative to the project root) matching dependency manifests and lock files.
 * A change to any of these means installed packages may have changed, so the
 * external library index must be refreshed. The glob is intentionally
 * non-recursive so nested `node_modules/**\/package.json` files are ignored.
 * @internal
 */
const DEPENDENCY_MANIFEST_NAMES = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;

/**
 * Debounce delay (ms) before reacting to a dependency manifest change. Installs
 * touch these files several times, so the delay coalesces the bursts and lets
 * the file system settle before re-indexing.
 * @internal
 */
const DEPENDENCY_REINDEX_DEBOUNCE_MS = 2000;

/** Maximum number of project source files read at the same time. */
const FILE_FILTER_CONCURRENCY = 8;

/**
 * Helper function to safely remove source files from ts-morph project
 * @param project - The ts-morph Project instance
 * @param context - Context string for logging purposes
 * @param logger - The logger to report skipped nodes through
 */
function removeAllSourceFiles(project: Project, context: string, logger: CoreLogger): void {
  project.getSourceFiles().forEach((sf) => {
    try {
      // Check if the sourceFile is still valid before removing
      sf.getFilePath(); // This will throw if the node is forgotten
      project.removeSourceFile(sf);
    } catch {
      // If the sourceFile node is already forgotten, skip it
      logger.debug(`SourceFile node already forgotten during ${context}, skipping removal`);
    }
  });
}

/**
 * Helper function to log memory usage with delta
 * @param message - The log message prefix
 * @param initialMemory - The initial memory metrics
 * @param logger - The logger the usage is reported through
 */
function logMemoryUsage(message: string, initialMemory: PerformanceMetrics, logger: InstrumentedLogger): void {
  const finalMemory = logger.getPerformanceMetrics();
  const memoryDelta = finalMemory.memoryUsage.heapUsed - initialMemory.memoryUsage.heapUsed;
  logger.info(
    `${message} - Memory: ${Math.round(finalMemory.memoryUsage.heapUsed / 1024 / 1024)}MB (Δ${memoryDelta > 0 ? "+" : ""}${Math.round(memoryDelta / 1024 / 1024)}MB)`
  );
}

/**
 * Helper function to log when no valid cache is found
 * @param projectRootPath - The project root path
 * @param logger - The logger to report through
 */
function logNoCacheFound(projectRootPath: string, logger: CoreLogger): void {
  logger.info(`AngularIndexer (${path.basename(projectRootPath)}): No valid cache found in workspace.`);
}

/**
 * Helper function to safely execute code that accesses a SourceFile.
 * Returns false if the SourceFile node is forgotten.
 *
 * @param sourceFile - The SourceFile to check
 * @param callback - The callback to execute if the SourceFile is valid
 * @param context - Context string for logging
 * @param logger - The logger to report a forgotten node through
 * @returns true if the callback was executed, false if the node was forgotten
 */
function withValidSourceFile<T>(
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
 * Helper function to parse ɵmod property from Angular module classes
 * @param classDecl - The class declaration to parse
 * @returns The exports tuple if found, null otherwise
 */
function parseModDefinition(classDecl: ClassDeclaration): import("ts-morph").TupleTypeNode | null {
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

/** Ports one indexer reads and writes through. */
export interface AngularIndexerOptions {
  /** Where this project's index is persisted between sessions. */
  cacheStore: CacheStore;
  /** Where this indexer reports progress, timings, and failures. */
  logger: InstrumentedLogger;
  /** How this indexer reaches the disk. */
  fileSystem: FileSystem;
  /** Where long operations report their progress. */
  progressHost: ProgressHost;
  /** How this indexer learns that a watched file changed. */
  fileWatchers: FileWatcherFactory;
}

/**
 * The main class responsible for indexing Angular elements in a project.
 */
export class AngularIndexer {
  /**
   * The ts-morph project instance.
   */
  project: Project;
  /**
   * Selectors, per-file element records, and module maps. The runtime below only
   * fills and queries this state; it owns scanning, watching, and persistence.
   */
  private readonly index = new AngularElementIndex();
  /**
   * The source-file subscription for the project, or `null` while it is not watching.
   */
  public fileWatcher: Disposable | null = null;
  /**
   * Watches dependency manifests / lock files to refresh the external library
   * index when packages are installed, removed or upgraded.
   */
  private dependencyWatcher: Disposable | null = null;
  private isReindexingDependencies: boolean = false;
  private readonly _onDidIndexNodeModules = new Emitter<void>();
  private readonly _onDidChangeIndex = new Emitter<void>();
  /**
   * Fires after `node_modules` are re-indexed because a dependency manifest
   * changed. Consumers (e.g. the diagnostic provider) can use this to refresh
   * results that depend on the external library index.
   */
  public readonly onDidIndexNodeModules: EventSource<void> = this._onDidIndexNodeModules.event;
  /**
   * Fires after the selector index changes, whether through a full reindex,
   * dependency refresh, or an incremental project-file update.
   */
  public readonly onDidChangeIndex: EventSource<void> = this._onDidChangeIndex.event;
  private projectRootPath: string = "";
  private isIndexing: boolean = false;

  /**
   * The cache key for the file cache in the workspace state.
   */
  public workspaceFileCacheKey: string = "";
  /**
   * The cache key for the selector index in the workspace state.
   */
  public workspaceIndexCacheKey: string = "";
  /**
   * The cache key for the module map in the workspace state.
   */
  public workspaceModulesCacheKey: string = "";
  /**
   * The cache key for the external modules exports index in the workspace state.
   */
  public workspaceExternalModulesExportsCacheKey: string = "";

  private readonly fileSystem: FileSystem;
  private readonly progressHost: ProgressHost;
  private readonly cacheStore: CacheStore;
  private readonly logger: InstrumentedLogger;
  private readonly fileWatchers: FileWatcherFactory;

  /**
   * Every port is injected: the indexer runs under the Extension Host and under the
   * language server, which has neither `workspace.findFiles` nor notification progress
   * nor a workspace memento, and it must not reach for `vscode` on its own.
   * @param options Ports this indexer reads and writes through.
   */
  constructor(options: AngularIndexerOptions) {
    this.fileSystem = options.fileSystem;
    this.progressHost = options.progressHost;
    this.cacheStore = options.cacheStore;
    this.logger = options.logger;
    this.fileWatchers = options.fileWatchers;
    this.project = new Project({
      useInMemoryFileSystem: false, // Keep this as false for real file system interaction
      skipAddingFilesFromTsConfig: true,
      // Consider adding compilerOptions from tsconfig if available for more accurate parsing,
      // but this might slow down initialization. For now, default is fine.
    });
  }

  /**
   * Sets the root path of the project to be indexed.
   * @param projectPath The absolute path to the project root.
   */
  public setProjectRoot(projectPath: string) {
    this.projectRootPath = projectPath;
    // Re-creating the project instance is a simple approach.
    // If performance becomes an issue, the instance could be reused,
    // but we would need to ensure its file system view is kept consistent.
    this.project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
    });

    const projectHash = this.generateHash(projectPath).replace(/[^a-zA-Z0-9_]/g, "");
    this.workspaceFileCacheKey = `angularFileCache_${projectHash}`;
    this.workspaceIndexCacheKey = `angularSelectorToDataIndex_${projectHash}`;
    this.workspaceModulesCacheKey = `angularModulesCache_${projectHash}`;
    this.workspaceExternalModulesExportsCacheKey = `angularExternalModulesExports_${projectHash}`;
    this.logger.info(
      `AngularIndexer: Project root set to ${projectPath}. Cache keys: ${this.workspaceFileCacheKey}, ${this.workspaceIndexCacheKey}, ${this.workspaceModulesCacheKey}, ${this.workspaceExternalModulesExportsCacheKey}`
    );
  }

  /**
   * Starts watching the project's sources and dependency manifests so the index
   * follows changes made outside the editor.
   */
  initializeWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = null;
    }
    if (!this.projectRootPath) {
      this.logger.error("AngularIndexer: Cannot initialize watcher, projectRootPath not set.");
      return;
    }

    // The watch pattern cannot exclude anything, so an install or a build would
    // otherwise push every written .ts through a full parse and index save.
    this.fileWatcher = this.fileWatchers.watch(
      { root: this.projectRootPath, recursive: true, extensions: [".ts"] },
      (change) => {
        void this.handleSourceChange(change);
      }
    );

    this.logger.info(`AngularIndexer: Source watcher initialized for ${this.projectRootPath}`);

    this.initializeDependencyWatcher();
  }

  /**
   * Applies one watched source change to the index.
   * @param change The reported change.
   * @internal
   */
  private async handleSourceChange({ filePath, kind }: FileChange): Promise<void> {
    if (!this.isIndexableProjectFile(filePath)) {
      return;
    }

    this.logger.info(`Watcher (${path.basename(this.projectRootPath)}): File ${kind}d: ${filePath}`);
    if (kind === "delete") {
      await this.removeFromIndex(filePath);
      // Also remove from ts-morph project
      const sourceFile = this.project.getSourceFile(filePath);
      if (sourceFile) {
        this.project.removeSourceFile(sourceFile);
      }
    } else {
      await this.updateFileIndex(filePath);
    }
    this._onDidChangeIndex.fire();
  }

  /**
   * Initializes a watcher for dependency manifests / lock files so the external
   * library index is refreshed automatically when packages change. This guards
   * against a stale index where a freshly installed library's elements are not
   * yet known (the cause of false "missing import" diagnostics).
   * @internal
   */
  private initializeDependencyWatcher(): void {
    if (this.dependencyWatcher) {
      this.dependencyWatcher.dispose();
      this.dependencyWatcher = null;
    }

    const handler = debounce(() => {
      void this.reindexNodeModulesAfterDependencyChange();
    }, DEPENDENCY_REINDEX_DEBOUNCE_MS);

    this.dependencyWatcher = this.fileWatchers.watch(
      { root: this.projectRootPath, recursive: false, fileNames: DEPENDENCY_MANIFEST_NAMES },
      handler
    );

    this.logger.info(`AngularIndexer: Dependency watcher initialized for ${this.projectRootPath}`);
  }

  /**
   * Re-indexes `node_modules` after a dependency manifest change and notifies
   * listeners via {@link onDidIndexNodeModules}. Skips work while a full index
   * or another dependency reindex is already running.
   * @internal
   */
  private async reindexNodeModulesAfterDependencyChange(): Promise<void> {
    if (this.isIndexing || this.isReindexingDependencies) {
      this.logger.debug(
        `[DependencyWatcher] Skipping reindex for ${path.basename(this.projectRootPath)}: indexing already in progress.`
      );
      return;
    }

    this.isReindexingDependencies = true;
    try {
      this.logger.info(`🔄 Dependencies changed for ${path.basename(this.projectRootPath)}, re-indexing libraries...`);
      await this.indexNodeModules();
      this._onDidIndexNodeModules.fire();
      this._onDidChangeIndex.fire();
    } catch (error) {
      this.logger.error("[DependencyWatcher] Error re-indexing libraries after dependency change:", error as Error);
    } finally {
      this.isReindexingDependencies = false;
    }
  }

  /**
   * Generates a hash for a given string.
   * @param content The string to hash.
   * @returns The hash of the string.
   * @internal
   */
  private generateHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString();
  }

  /**
   * Parses a TypeScript file to find Angular elements.
   * @param filePath The path to the file.
   * @param content The content of the file.
   * @returns An array of `ComponentInfo` objects.
   * @internal
   */
  private parseAngularElementsWithTsMorph(filePath: string, content: string): ComponentInfo[] {
    if (!this.projectRootPath) {
      this.logger.error("AngularIndexer.parseAngularElementsWithTsMorph: projectRootPath is not set.");
      return this.getFallbackResult(filePath, content);
    }

    try {
      const sourceFile = this.getOrCreateSourceFile(filePath, content);
      const elements = this.extractElementsFromSourceFile(sourceFile, filePath, content);
      return this.applyFallbackIfNeeded(elements, filePath, content);
    } catch (error) {
      this.logger.error(`ts-morph parsing error for ${filePath} in project ${this.projectRootPath}:`, error as Error);
      return this.getFallbackResult(filePath, content);
    }
  }

  /**
   * Gets fallback result using regex parsing.
   */
  private getFallbackResult(filePath: string, content: string): ComponentInfo[] {
    const fallbackResult = this.parseAngularElementWithRegex(filePath, content);
    return fallbackResult ? [fallbackResult] : [];
  }

  /**
   * Gets or creates a source file for the given path and content.
   */
  private getOrCreateSourceFile(filePath: string, content: string): SourceFile {
    let sourceFile = this.project.getSourceFile(filePath);

    if (sourceFile) {
      sourceFile = this.updateExistingSourceFile(sourceFile, filePath, content);
    } else {
      sourceFile = this.project.createSourceFile(filePath, content, {
        overwrite: true,
      });
    }

    return sourceFile;
  }

  /**
   * Updates an existing source file or recreates it if forgotten.
   */
  private updateExistingSourceFile(sourceFile: SourceFile, filePath: string, content: string): SourceFile {
    try {
      sourceFile.getFilePath(); // This will throw if the node is forgotten
      sourceFile.replaceWithText(content);
      return sourceFile;
    } catch {
      this.logger.warn(`SourceFile node forgotten for ${filePath}, recreating...`);
      this.project.removeSourceFile(sourceFile);
      return this.project.createSourceFile(filePath, content, {
        overwrite: true,
      });
    }
  }

  /**
   * Extracts Angular elements from a source file.
   */
  private extractElementsFromSourceFile(sourceFile: SourceFile, filePath: string, content: string): ComponentInfo[] {
    const elements: ComponentInfo[] = [];
    const classes = sourceFile.getClasses();

    for (const classDeclaration of classes) {
      try {
        const elementInfo = this.extractAngularElementInfo(classDeclaration, filePath, content);
        if (elementInfo) {
          elements.push(elementInfo);
        }
      } catch (classError) {
        this.logger.warn(`Error processing class in ${filePath}: ${(classError as Error).message}`);
      }
    }

    return elements;
  }

  /**
   * Applies fallback parsing if no elements were found.
   */
  private applyFallbackIfNeeded(elements: ComponentInfo[], filePath: string, content: string): ComponentInfo[] {
    if (elements.length === 0) {
      const fallbackResult = this.parseAngularElementWithRegex(filePath, content);
      if (fallbackResult) {
        elements.push(fallbackResult);
      }
    }
    return elements;
  }

  /**
   * Extracts information about an Angular element from a class declaration.
   * @param classDeclaration The class declaration to extract information from.
   * @param filePath The path to the file.
   * @param fileContent The content of the file.
   * @returns A `ComponentInfo` object or `null` if the class is not an Angular element.
   * @internal
   */
  private extractAngularElementInfo(
    classDeclaration: ClassDeclaration,
    filePath: string,
    fileContent: string
  ): ComponentInfo | null {
    if (!classDeclaration.isExported()) {
      return null;
    }

    const className = classDeclaration.getName();
    if (!className) {
      return null;
    }

    const decorators = classDeclaration.getDecorators();
    for (const decorator of decorators) {
      const decoratorName = decorator.getName();
      let elementType: "component" | "directive" | "pipe" | null = null;
      let selector: string | undefined;
      const isStandaloneElement = isStandalone(classDeclaration);

      switch (decoratorName) {
        case "Component": {
          elementType = "component";
          const componentData = this.extractComponentDecoratorData(decorator);
          selector = componentData.selector;
          break;
        }
        case "Directive": {
          elementType = "directive";
          const directiveData = this.extractDirectiveDecoratorData(decorator);
          selector = directiveData.selector;
          break;
        }
        case "Pipe": {
          elementType = "pipe";
          const pipeData = this.extractPipeDecoratorData(decorator);
          selector = pipeData.name;
          break;
        }
      }

      if (elementType && selector) {
        return {
          path: path.relative(this.projectRootPath, filePath),
          name: className,
          selector,
          lastModified: fs.statSync(filePath).mtime.getTime(), // Ok, but content hash is better
          hash: this.generateHash(fileContent), // Use content for hash
          type: elementType,
          isStandalone: isStandaloneElement,
        };
      }
    }
    return null;
  }

  /**
   * Extracts the selector property from a decorator's argument object.
   * @param decorator The decorator to extract the selector from.
   * @param errorContext Context string for error logging (e.g., "component", "directive").
   * @returns The selector string or undefined.
   * @internal
   */
  private extractSelectorFromDecorator(decorator: Decorator, errorContext: string): string | undefined {
    try {
      const args = decorator.getArguments();
      if (args.length > 0 && args[0].isKind(SyntaxKind.ObjectLiteralExpression)) {
        const objectLiteral = args[0] as ObjectLiteralExpression;

        const selectorProperty = objectLiteral.getProperty("selector");
        if (selectorProperty?.isKind(SyntaxKind.PropertyAssignment)) {
          const initializer = selectorProperty.getInitializer();
          if (initializer?.isKind(SyntaxKind.StringLiteral)) {
            return initializer.getLiteralText();
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error extracting ${errorContext} selector from decorator:`, error as Error);
    }
    return undefined;
  }

  /**
   * Extracts the selector from a `@Component` decorator.
   * @param decorator The decorator to extract information from.
   * @returns An object containing the selector.
   * @internal
   */
  private extractComponentDecoratorData(decorator: Decorator): { selector?: string } {
    return { selector: this.extractSelectorFromDecorator(decorator, "component") };
  }

  /**
   * Extracts the selector from a `@Directive` decorator.
   * @param decorator The decorator to extract information from.
   * @returns An object containing the selector.
   * @internal
   */
  private extractDirectiveDecoratorData(decorator: Decorator): { selector?: string } {
    return { selector: this.extractSelectorFromDecorator(decorator, "directive") };
  }

  /**
   * Extracts the name from a `@Pipe` decorator.
   * @param decorator The decorator to extract information from.
   * @returns An object containing the name.
   * @internal
   */
  private extractPipeDecoratorData(decorator: Decorator): { name?: string } {
    let name: string | undefined;

    try {
      const args = decorator.getArguments();
      if (args.length > 0 && args[0].isKind(SyntaxKind.ObjectLiteralExpression)) {
        const objectLiteral = args[0] as ObjectLiteralExpression;

        const nameProperty = objectLiteral.getProperty("name");
        if (nameProperty?.isKind(SyntaxKind.PropertyAssignment)) {
          const initializer = nameProperty.getInitializer();
          if (initializer?.isKind(SyntaxKind.StringLiteral)) {
            name = initializer.getLiteralText();
          }
        }
      }
    } catch (error) {
      this.logger.error("Error extracting pipe name from decorator:", error as Error);
    }

    return { name };
  }

  /**
   * Parses a TypeScript file using regex to find Angular elements. This is a fallback for when ts-morph fails.
   * @param filePath The path to the file.
   * @param content The content of the file.
   * @returns A `ComponentInfo` object or `null` if no element is found.
   * @internal
   */
  private parseAngularElementWithRegex(filePath: string, content: string): ComponentInfo | null {
    // This is a fallback, ensure it's robust enough or log clearly when it's used.
    // Note: This regex approach only finds the first element, unlike the ts-morph approach
    if (!this.projectRootPath) {
      this.logger.warn(
        "AngularIndexer.parseAngularElementWithRegex: projectRootPath is not set. Regex parsing might be unreliable."
      );
      // Allow to proceed but with caution
    }

    const selectorRegex = /selector:\s*['"]([^'"]*)['"]/;
    const pipeNameRegex = /name:\s*['"]([^'"]*)['"]/;
    const classNameRegex = /export\s+class\s+(\w+)/;
    const decoratorRegex = /@(Component|Directive|Pipe)\s*\(/;

    const decoratorMatch = decoratorRegex.exec(content);
    if (!decoratorMatch) {
      return null;
    }

    const decoratorType = decoratorMatch[1].toLowerCase() as "component" | "directive" | "pipe";

    const classNameMatch = classNameRegex.exec(content);
    if (!classNameMatch?.[1]) {
      return null;
    }

    let selector: string | undefined;
    if (decoratorType === "pipe") {
      selector = pipeNameRegex.exec(content)?.[1];
    } else {
      selector = selectorRegex.exec(content)?.[1];
    }

    if (selector) {
      return {
        path: this.projectRootPath ? path.relative(this.projectRootPath, filePath) : filePath,
        name: classNameMatch[1],
        selector,
        lastModified: fs.statSync(filePath).mtime.getTime(),
        hash: this.generateHash(content),
        type: decoratorType,
        isStandalone: false, // Fallback parser cannot determine this, default to false.
      };
    }
    return null;
  }

  /**
   * Updates the index for a single project source file.
   *
   * Library files never reach this method: dependencies are indexed from their
   * package entry points by {@link indexNodeModules}.
   *
   * @param filePath The path to the file.
   * @param context The extension context.
   * @internal
   */
  private async updateFileIndex(filePath: string): Promise<void> {
    try {
      if (!this.validateFileForIndexing(filePath)) {
        return;
      }

      const { content, hash, lastModified, cachedFile } = this.readFileAndGetMetadata(filePath);

      if (this.isFileUpToDate(cachedFile, lastModified, hash)) {
        this.updateCacheTimestamp(filePath, cachedFile, lastModified);
        return;
      }

      await this.removeOldSelectorsFromIndex(cachedFile);
      const parsedElements = this.parseAngularElementsWithTsMorph(filePath, content);

      if (parsedElements.length > 0) {
        await this.processAndIndexElements(filePath, parsedElements, lastModified, hash);
      } else {
        await this.handleNoElementsFound(filePath);
      }

      await this.saveIndexToWorkspace();
    } catch (error) {
      this.logger.error(`Error updating index for ${filePath} in project ${this.projectRootPath}:`, error as Error);
    }
  }

  /**
   * Reports whether a project file is an indexable source file.
   *
   * Mirrors {@link PROJECT_SOURCE_EXCLUDE_GLOB} for paths that reach the indexer
   * without going through `findFiles`. The file watcher watches the project root
   * recursively and cannot express an exclude pattern, so without this guard every
   * `.ts` written into `node_modules` or `dist` (an install, a build) would be read
   * and parsed with ts-morph.
   *
   * @param filePath - Absolute path to the file.
   * @returns `true` when the file should be indexed as a project source.
   * @internal
   */
  private isIndexableProjectFile(filePath: string): boolean {
    return isProjectSourceFile(this.projectRootPath, filePath);
  }

  private validateFileForIndexing(filePath: string): boolean {
    if (!fs.existsSync(filePath)) {
      this.logger.warn(`File not found, cannot update index: ${filePath} for project ${this.projectRootPath}`);
      return false;
    }
    if (!this.projectRootPath) {
      this.logger.error(`AngularIndexer.updateFileIndex: projectRootPath not set for ${filePath}. Aborting update.`);
      return false;
    }
    if (!isPathInside(this.projectRootPath, filePath)) {
      this.logger.warn(
        `AngularIndexer.updateFileIndex: File ${filePath} is outside of project root ${this.projectRootPath}. Skipping.`
      );
      return false;
    }
    if (!this.isIndexableProjectFile(filePath)) {
      this.logger.debug(`AngularIndexer.updateFileIndex: Skipping non-source file ${filePath}.`);
      return false;
    }
    return true;
  }

  private readFileAndGetMetadata(filePath: string): {
    content: string;
    hash: string;
    lastModified: number;
    cachedFile: FileElementsInfo | undefined;
  } {
    const stats = fs.statSync(filePath);
    const lastModified = stats.mtime.getTime();
    const cachedFile = this.index.files.get(filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const hash = this.generateHash(content);

    return { content, hash, lastModified, cachedFile };
  }

  private isFileUpToDate(cachedFile: FileElementsInfo | undefined, lastModified: number, hash: string): boolean {
    return cachedFile !== undefined && cachedFile.lastModified >= lastModified && cachedFile.hash === hash;
  }

  private updateCacheTimestamp(filePath: string, cachedFile: FileElementsInfo | undefined, lastModified: number): void {
    if (cachedFile && cachedFile.lastModified < lastModified) {
      const updatedCache: FileElementsInfo = {
        ...cachedFile,
        lastModified: lastModified,
      };
      this.index.files.set(filePath, updatedCache);
    }
  }

  /**
   * Drops one element of a selector, matching how that element's path was stored.
   *
   * Project elements are indexed with a project-relative path, so removing them by the
   * absolute path a watcher reports would silently match nothing and leave the selector
   * of a deleted or renamed element in the index. A cache written by an older version
   * can still hold absolute paths, so both forms are attempted.
   * @param selector The selector to remove the element from.
   * @param filePath Absolute path of the file the element came from.
   * @param elementName Class name of the element, when only that one must go.
   * @internal
   */
  private removeIndexedElement(selector: string, filePath: string, elementName?: string): void {
    this.index.selectors.remove(selector, filePath, elementName);
    const indexedPath = this.projectRootPath ? path.relative(this.projectRootPath, filePath) : filePath;
    if (indexedPath !== filePath) {
      this.index.selectors.remove(selector, indexedPath, elementName);
    }
  }

  private async removeOldSelectorsFromIndex(cachedFile: FileElementsInfo | undefined): Promise<void> {
    if (!cachedFile) {
      return;
    }

    for (const oldElement of cachedFile.elements) {
      const individualSelectors = await parseAngularSelector(oldElement.selector);
      for (const selector of individualSelectors) {
        this.removeIndexedElement(selector, cachedFile.filePath, oldElement.name);
      }
    }
  }

  private async processAndIndexElements(
    filePath: string,
    parsedElements: ComponentInfo[],
    lastModified: number,
    hash: string
  ): Promise<void> {
    const fileElementsInfo: FileElementsInfo = {
      filePath: filePath,
      lastModified: lastModified,
      hash: hash,
      elements: parsedElements,
    };
    this.index.files.set(filePath, fileElementsInfo);

    for (const parsed of parsedElements) {
      await this.indexSingleElement(parsed, filePath);
    }
  }

  /** Indexes one element parsed from a project source file; libraries are indexed from entry points. */
  private async indexSingleElement(parsed: ComponentInfo, absolutePath?: string): Promise<void> {
    const individualSelectors = await parseAngularSelector(parsed.selector);
    const { importPath, importName, moduleToImport } = this.resolveElementImportInfo(parsed);

    const elementData = new AngularElementData({
      path: importPath,
      name: importName,
      type: parsed.type,
      originalSelector: parsed.selector,
      selectors: individualSelectors,
      isStandalone: parsed.isStandalone,
      isExternal: false,
      exportingModuleName: moduleToImport,
      absolutePath,
    });

    for (const selector of individualSelectors) {
      this.index.selectors.insert(selector, elementData);
      this.logger.info(`Updated index for ${this.projectRootPath}: ${selector} (${parsed.type}) -> ${parsed.path}`);
    }
  }

  private resolveElementImportInfo(parsed: ComponentInfo): {
    importPath: string;
    importName: string;
    moduleToImport: string | undefined;
  } {
    let importPath = parsed.path;
    let importName = parsed.name;
    let moduleToImport: string | undefined;

    if (!parsed.isStandalone) {
      const moduleInfo = this.index.componentModules.get(parsed.name);
      if (moduleInfo) {
        importPath = moduleInfo.importPath;
        importName = moduleInfo.moduleName;
        moduleToImport = moduleInfo.moduleName;
      }
    }

    return { importPath, importName, moduleToImport };
  }

  /**
   * Safely removes a source file from the ts-morph project.
   * @param filePath The path to the file to remove.
   * @internal
   */
  private removeSourceFileFromProject(filePath: string): void {
    try {
      const sourceFile = this.project.getSourceFile(filePath);
      if (sourceFile) {
        sourceFile.getFilePath();
        this.project.removeSourceFile(sourceFile);
      }
    } catch {
      this.logger.warn(`SourceFile node already forgotten for ${filePath}, skipping removal`);
    }
  }

  private async handleNoElementsFound(filePath: string): Promise<void> {
    this.index.files.delete(filePath);
    this.removeSourceFileFromProject(filePath);
    this.logger.info(`No Angular elements found in ${filePath} for ${this.projectRootPath}`);
  }

  /**
   * Removes a file from the index.
   * @param filePath The path to the file.
   * @param context The extension context.
   * @internal
   */
  private async removeFromIndex(filePath: string): Promise<void> {
    // Remove from file cache
    const fileInfo = this.index.files.get(filePath);
    if (fileInfo) {
      for (const element of fileInfo.elements) {
        const individualSelectors = await parseAngularSelector(element.selector);
        for (const selector of individualSelectors) {
          this.removeIndexedElement(selector, filePath, element.name);
          this.logger.info(`Removed from index for ${this.projectRootPath}: ${selector} from ${filePath}`);
        }
      }
      this.index.files.delete(filePath);
    }

    // Remove from ts-morph project with error handling
    this.removeSourceFileFromProject(filePath);

    if (fileInfo) {
      await this.saveIndexToWorkspace();
    }
  }

  /**
   * Generates a full index of the project.
   * @param progress Optional progress reporter for the caller's UI.
   * @param cancellation Checked between batches; a cancelled scan stops without saving.
   * @returns A map of selectors to `AngularElementData` objects.
   */
  async generateFullIndex(
    progress?: ProgressReporter,
    cancellation: CancellationSignal = neverCancelled
  ): Promise<Map<string, AngularElementData>> {
    if (this.isIndexing) {
      this.logger.info(`AngularIndexer (${path.basename(this.projectRootPath)}): Already indexing, skipping...`);
      return new Map(this.index.selectors.getAllElements().map((e) => [e.originalSelector, e]));
    }

    const timerName = `generateFullIndex:${path.basename(this.projectRootPath)}`;
    this.logger.startTimer(timerName);

    // Log initial memory usage
    const initialMemory = this.logger.getPerformanceMetrics();
    this.logger.info(`Starting full index - Memory: ${Math.round(initialMemory.memoryUsage.heapUsed / 1024 / 1024)}MB`);

    this.isIndexing = true;
    try {
      this.logger.info(`AngularIndexer (${path.basename(this.projectRootPath)}): Starting full index generation...`);
      if (!this.projectRootPath) {
        this.logger.error("AngularIndexer.generateFullIndex: projectRootPath not set. Aborting.");
        return new Map();
      }

      // Clear existing ts-morph project files before full scan to avoid stale data
      removeAllSourceFiles(this.project, "full index", this.logger);
      this.index.clear();

      progress?.report({ message: "Discovering project files..." });
      const projectTsFiles = await this.fileSystem.findFiles(projectSourceQuery(this.projectRootPath));
      this.logger.info(
        `AngularIndexer (${path.basename(this.projectRootPath)}): Found ${projectTsFiles.length} project files.`
      );

      progress?.report({ message: "Filtering project files..." });
      const candidateFiles = await this._filterRelevantFiles(projectTsFiles);

      const moduleFiles = candidateFiles.filter((filePath) => filePath.endsWith(".module.ts"));
      const componentFiles = candidateFiles.filter((filePath) => !filePath.endsWith(".module.ts"));

      this.logger.info(
        `AngularIndexer (${path.basename(this.projectRootPath)}): Found ${
          candidateFiles.length
        } potential Angular files (${moduleFiles.length} modules, ${componentFiles.length} components/directives/pipes).`
      );

      progress?.report({ message: "Indexing project modules..." });
      await this.indexProjectModules(moduleFiles);

      progress?.report({ message: "Indexing project components..." });
      const batchSize = 20; // Process in batches
      for (let i = 0; i < componentFiles.length; i += batchSize) {
        if (cancellation.isCancelled) {
          return this.abandonIndexing();
        }
        const batch = componentFiles.slice(i, i + batchSize);
        // Sequentially process files in a batch to avoid overwhelming ts-morph or fs
        for (const filePath of batch) {
          await this.updateFileIndex(filePath);
        }
        this.logger.info(
          `AngularIndexer (${path.basename(this.projectRootPath)}): Indexed component batch ${
            Math.floor(i / batchSize) + 1
          }/${Math.ceil(componentFiles.length / batchSize)}`
        );
      }

      const totalElements = this.index.selectors.getAllElements().length;
      this.logger.info(`AngularIndexer (${path.basename(this.projectRootPath)}): Indexed ${totalElements} elements.`);

      if (cancellation.isCancelled) {
        return this.abandonIndexing();
      }

      await this.indexNodeModules(progress, cancellation);

      if (cancellation.isCancelled) {
        return this.abandonIndexing();
      }

      // Expand module exports to include transitive dependencies
      // This must happen after all modules are indexed (both project and node_modules)
      progress?.report({ message: "Expanding module exports..." });
      this.expandAllModuleExports();

      await this.saveIndexToWorkspace();

      this._onDidChangeIndex.fire();

      // Log final memory usage and performance metrics
      logMemoryUsage("Full index completed", initialMemory, this.logger);

      return new Map(this.index.selectors.getAllElements().map((e) => [e.originalSelector, e]));
    } finally {
      this.isIndexing = false;
      this.logger.stopTimer(timerName);
    }
  }

  /**
   * Drops the half-built index of a cancelled scan, so nothing partial is served or
   * persisted and the next scan starts from a clean state.
   * @internal
   */
  private abandonIndexing(): Map<string, AngularElementData> {
    this.logger.info(`AngularIndexer (${path.basename(this.projectRootPath)}): Full index cancelled.`);
    this.index.clear();
    removeAllSourceFiles(this.project, "cancelled index", this.logger);
    return new Map();
  }

  /**
   * Quickly filters a list of files to find ones that likely contain Angular declarations.
   * @param filePaths An array of absolute file paths to filter.
   * @param readFile Reader override used by tests; defaults to the injected file system.
   * @returns A promise that resolves to a filtered array of absolute file paths.
   * @internal
   */
  private async _filterRelevantFiles(
    filePaths: string[],
    readFile: (filePath: string) => Promise<string> = (filePath) => this.fileSystem.readFile(filePath)
  ): Promise<string[]> {
    const angularDecoratorRegex = /@(Component|Directive|Pipe|NgModule)\s*\(/;
    const { default: pLimit } = await import("p-limit");
    const limit = pLimit(FILE_FILTER_CONCURRENCY);
    const results = await limit.map(filePaths, async (filePath) => {
      try {
        const content = await readFile(filePath);
        if (angularDecoratorRegex.test(content)) {
          return filePath;
        }
      } catch (error) {
        this.logger.error(`Could not read file ${filePath} during filtering:`, error as Error);
      }
      return null;
    });

    return results.filter((filePath): filePath is string => filePath !== null);
  }

  /**
   * Loads the index from the persisted cache.
   * @returns `true` if the index was loaded successfully, `false` otherwise.
   */
  async loadFromWorkspace(): Promise<boolean> {
    if (!this.projectRootPath || !this.workspaceFileCacheKey || !this.workspaceIndexCacheKey) {
      this.logger.error("AngularIndexer.loadFromWorkspace: projectRootPath or cache keys not set. Cannot load.");
      return false;
    }

    try {
      const workspaceData = this.retrieveWorkspaceData(this.cacheStore);
      if (!workspaceData.storedCache || !workspaceData.storedIndex) {
        logNoCacheFound(this.projectRootPath, this.logger);
        return false;
      }

      await this.loadCacheData(workspaceData);
      this.loadModuleData(workspaceData);
      this.loadExternalModuleExports(workspaceData);

      // Expand module exports after loading from cache
      // This ensures transitive exports are available even when loading old cache
      this.expandAllModuleExports();

      // Guard against a stale cache: if a project file was moved/deleted while the
      // extension was not running (e.g. git pull, branch switch, `git mv`), the file
      // watcher never observed the change and the cached selector still points to a
      // path that no longer exists. Trusting it would make quick-fixes generate broken
      // import paths. In that case discard the cache so the caller performs a full
      // rescan, which rebuilds the index from the current state of the filesystem.
      const staleFile = this.findStaleCachedProjectFile();
      if (staleFile) {
        this.logger.warn(
          `AngularIndexer (${path.basename(
            this.projectRootPath
          )}): Cache references a missing file (${staleFile}). Discarding cache and forcing a full reindex.`
        );
        this.index.clear();
        return false;
      }

      this.logger.info(
        `AngularIndexer (${path.basename(this.projectRootPath)}): Loaded ${
          this.index.selectors.size
        } elements from workspace cache.`
      );
      return true;
    } catch (error) {
      this.logger.error(
        `AngularIndexer (${path.basename(this.projectRootPath)}): Error loading index from workspace:`,
        error as Error
      );
      logNoCacheFound(this.projectRootPath, this.logger);
      return false;
    }
  }

  /**
   * Scans the just-loaded cache for project (non-external) source files that no
   * longer exist on disk. Such entries indicate the cache drifted from the
   * filesystem while the watcher was inactive (offline file move/delete) and
   * therefore cannot be trusted for import-path resolution.
   * @returns The absolute path of the first missing file, or `null` if the cache
   * is consistent with the filesystem.
   * @internal
   */
  private findStaleCachedProjectFile(): string | null {
    const nodeModulesPath = path.join(this.projectRootPath, "node_modules");
    for (const filePath of this.index.files.keys()) {
      // External library files live under node_modules and are refreshed by the
      // dependency watcher; skip them to avoid unnecessary full reindexes.
      if (isPathInside(nodeModulesPath, filePath)) {
        continue;
      }
      if (!fs.existsSync(filePath)) {
        return filePath;
      }
    }
    return null;
  }

  private retrieveWorkspaceData(cacheStore: CacheStore) {
    return {
      storedCache: cacheStore.get<Record<string, FileElementsInfo | ComponentInfo>>(this.workspaceFileCacheKey),
      storedIndex: cacheStore.get<Record<string, AngularElementData>>(this.workspaceIndexCacheKey),
      storedModules: cacheStore.get<Record<string, { moduleName: string; importPath: string; exportCount?: number }>>(
        this.workspaceModulesCacheKey
      ),
      storedExternalModulesExports: cacheStore.get<Record<string, string[]>>(
        this.workspaceExternalModulesExportsCacheKey
      ),
    };
  }

  private async loadCacheData(workspaceData: {
    storedCache: Record<string, FileElementsInfo | ComponentInfo> | undefined;
    storedIndex: Record<string, AngularElementData> | undefined;
    storedModules?: Record<string, { moduleName: string; importPath: string; exportCount?: number }>;
    storedExternalModulesExports?: Record<string, string[]>;
  }): Promise<void> {
    if (!workspaceData.storedCache || !workspaceData.storedIndex) {
      return;
    }

    // Convert old ComponentInfo format to new FileElementsInfo format if needed
    this.index.replaceFiles(this.convertCacheFormat(workspaceData.storedCache));

    // Load index data
    this.index.selectors.clear();
    this.index.moduleExports.clear();

    for (const [key, value] of Object.entries(workspaceData.storedIndex)) {
      await this.loadIndexElement(key, value);
    }
  }

  private convertCacheFormat(
    storedCache: Record<string, FileElementsInfo | ComponentInfo>
  ): Map<string, FileElementsInfo> {
    const convertedCache = new Map<string, FileElementsInfo>();

    for (const [filePath, cacheEntry] of Object.entries(storedCache)) {
      if ("elements" in cacheEntry) {
        // New format - already FileElementsInfo
        convertedCache.set(filePath, cacheEntry as FileElementsInfo);
      } else {
        // Old format - convert ComponentInfo to FileElementsInfo
        const componentInfo = cacheEntry as ComponentInfo;
        const fileElementsInfo: FileElementsInfo = {
          filePath: filePath,
          lastModified: componentInfo.lastModified,
          hash: componentInfo.hash,
          elements: [componentInfo],
        };
        convertedCache.set(filePath, fileElementsInfo);
      }
    }

    return convertedCache;
  }

  private async loadIndexElement(key: string, value: AngularElementData): Promise<void> {
    const elementData = new AngularElementData({
      path: value.path,
      name: value.name,
      type: value.type,
      originalSelector: value.originalSelector || key,
      selectors: await parseAngularSelector(value.originalSelector || key),
      isStandalone: value.isStandalone,
      isExternal: value.isExternal ?? value.path.includes("node_modules"), // Use cached isExternal, fallback for old cache
      exportingModuleName: value.exportingModuleName,
      absolutePath: value.absolutePath,
    });

    // Index under all its selectors
    for (const selector of elementData.selectors) {
      this.index.selectors.insert(selector, elementData);
    }
  }

  private loadModuleData(workspaceData: {
    storedModules?: Record<string, { moduleName: string; importPath: string; exportCount?: number }>;
  }): void {
    if (workspaceData.storedModules) {
      const moduleMapEntries: [string, { moduleName: string; importPath: string; exportCount: number }][] =
        Object.entries(workspaceData.storedModules).map(([key, value]) => {
          // Handle old cache format gracefully by providing a default exportCount.
          const entry = {
            moduleName: value.moduleName,
            importPath: value.importPath,
            exportCount: value.exportCount ?? 10, // Default to a neutral number for old caches
          };
          return [key, entry];
        });
      this.index.replaceComponentModules(new Map(moduleMapEntries));
    }
  }

  private loadExternalModuleExports(workspaceData: { storedExternalModulesExports?: Record<string, string[]> }): void {
    if (!workspaceData.storedExternalModulesExports) {
      return;
    }

    // Convert stored string arrays back to Sets
    this.index.moduleExports.clear();
    for (const [moduleName, exports] of Object.entries(workspaceData.storedExternalModulesExports)) {
      this.index.moduleExports.set(moduleName, new Set(exports));
    }
  }

  /**
   * Saves the index to the persisted cache.
   * @internal
   */
  private async saveIndexToWorkspace(): Promise<void> {
    if (!this.projectRootPath || !this.workspaceFileCacheKey || !this.workspaceIndexCacheKey) {
      this.logger.error("AngularIndexer.saveIndexToWorkspace: projectRootPath or cache keys not set. Cannot save.");
      return;
    }
    try {
      const cacheStore = this.cacheStore;
      await cacheStore.set(this.workspaceFileCacheKey, Object.fromEntries(this.index.files));

      const serializableTrie = Object.fromEntries(
        this.index.selectors.getAllElements().map((el) => [el.originalSelector, el])
      );

      await cacheStore.set(this.workspaceIndexCacheKey, serializableTrie);
      await cacheStore.set(this.workspaceModulesCacheKey, Object.fromEntries(this.index.componentModules));

      // Serialize external modules exports (convert Sets to arrays)
      const serializableExternalModules = Object.fromEntries(
        Array.from(this.index.moduleExports.entries()).map(([moduleName, exportsSet]) => [
          moduleName,
          Array.from(exportsSet),
        ])
      );
      await cacheStore.set(this.workspaceExternalModulesExportsCacheKey, serializableExternalModules);
    } catch (error) {
      this.logger.error(
        `AngularIndexer (${path.basename(this.projectRootPath)}): Error saving index to workspace:`,
        error as Error
      );
    }
  }

  /**
   * Clears the index from memory and from the persisted cache.
   */
  public async clearCache(): Promise<void> {
    if (
      !this.projectRootPath ||
      !this.workspaceFileCacheKey ||
      !this.workspaceIndexCacheKey ||
      !this.workspaceModulesCacheKey ||
      !this.workspaceExternalModulesExportsCacheKey
    ) {
      this.logger.error("AngularIndexer.clearCache: projectRootPath or cache keys not set. Cannot clear cache.");
      return;
    }
    try {
      // Clear in-memory state
      this.index.clear();
      removeAllSourceFiles(this.project, "clearCache", this.logger);

      // Clear persisted state
      const cacheStore = this.cacheStore;
      await cacheStore.delete(this.workspaceFileCacheKey);
      await cacheStore.delete(this.workspaceIndexCacheKey);
      await cacheStore.delete(this.workspaceModulesCacheKey);
      await cacheStore.delete(this.workspaceExternalModulesExportsCacheKey);

      this.logger.info(`AngularIndexer (${path.basename(this.projectRootPath)}): All caches cleared.`);
    } catch (error) {
      this.logger.error(
        `AngularIndexer (${path.basename(this.projectRootPath)}): Error clearing cache:`,
        error as Error
      );
    }
  }

  /**
   * Gets all elements for a given selector.
   * @param selector The selector to search for.
   * @returns An array of `AngularElementData` objects.
   */
  getElements(selector: string): AngularElementData[] {
    return this.index.getElements(selector);
  }

  /**
   * Gets all exported entities from an external module.
   * @param moduleName The name of the external module (e.g., "MatTableModule").
   * @returns A Set of exported entity names or undefined if module not found.
   */
  getExternalModuleExports(moduleName: string): Set<string> | undefined {
    return this.index.getModuleExports(moduleName);
  }

  /**
   * Expands all module exports to include transitive exports.
   * This post-processing step ensures that when a module re-exports another module,
   * all the re-exported module's exports are also available.
   *
   * Example:
   * Before: ChipsModule -> Set(["InputTextModule", "ChipsComponent"])
   * After:  ChipsModule -> Set(["InputTextModule", "InputText", "ChipsComponent"])
   *
   * Should be called after all modules are indexed (both project and node_modules).
   * @internal
   */
  private expandAllModuleExports(): void {
    const expandedIndex = new Map<string, Set<string>>();

    this.logger.info(`[AngularIndexer] Starting module export expansion for ${this.index.moduleExports.size} modules`);

    // Process each module in the index
    for (const [moduleName, directExports] of this.index.moduleExports) {
      this.logger.debug(
        `[AngularIndexer] Expanding ${moduleName}: direct exports = [${Array.from(directExports).join(", ")}]`
      );

      // Recursively expand the module's exports, with a fresh visited set per module
      const expandedExports = this.index.expandModuleExports(moduleName, directExports, new Set<string>());

      this.logger.debug(
        `[AngularIndexer] Expanded ${moduleName}: transitive exports = [${Array.from(expandedExports).join(", ")}]`
      );

      expandedIndex.set(moduleName, expandedExports);
    }

    this.index.replaceModuleExports(expandedIndex);

    this.logger.info(
      `[AngularIndexer] Expanded ${expandedIndex.size} module exports to include transitive dependencies`
    );
  }

  /**
   * Indexes all Angular libraries in `node_modules`.
   * @param progress Optional progress reporter to use instead of creating a new one.
   */
  public async indexNodeModules(
    progress?: ProgressReporter,
    cancellation: CancellationSignal = neverCancelled
  ): Promise<void> {
    const timerName = `indexNodeModules:${path.basename(this.projectRootPath)}`;
    this.logger.startTimer(timerName);

    // Log initial memory before node_modules indexing
    const initialMemory = this.logger.getPerformanceMetrics();
    this.logger.info(
      `Starting node_modules index - Memory: ${Math.round(initialMemory.memoryUsage.heapUsed / 1024 / 1024)}MB`
    );

    const indexingLogic = async (progressReporter: ProgressReporter) => {
      try {
        if (!this.projectRootPath) {
          this.logger.error("AngularIndexer.indexNodeModules: projectRootPath not set.");
          return;
        }
        progressReporter.report({ message: "Finding Angular libraries..." });
        const angularDeps = await findAngularDependencies(this.projectRootPath);
        this.logger.debug(`[indexNodeModules] Found ${angularDeps.length} Angular dependencies.`);

        const totalDeps = angularDeps.length;
        let processedCount = 0;

        for (const dep of angularDeps) {
          if (cancellation.isCancelled) {
            this.logger.info(`[indexNodeModules] Cancelled after ${processedCount}/${totalDeps} libraries.`);
            return;
          }
          processedCount++;
          progressReporter.report({
            message: `Processing ${dep.name}... (${processedCount}/${totalDeps})`,
            increment: (1 / totalDeps) * 100,
          });

          const entryPoints = await getLibraryEntryPoints(dep);
          if (entryPoints.size === 0) {
            continue;
          }

          this.logger.info(`📚 Indexing library: ${dep.name} (${entryPoints.size} entry points)`);
          await this._indexLibrary(entryPoints);
        }
        await this.saveIndexToWorkspace();

        // Log final memory usage after node_modules indexing
        logMemoryUsage("Node modules index completed", initialMemory, this.logger);

        this.logger.debug(`[indexNodeModules] Finished indexing ${processedCount} libraries.`);
      } catch (error) {
        this.logger.error("[indexNodeModules] Error during node_modules indexing:", error as Error);
      } finally {
        this.logger.stopTimer(timerName);
      }
    };

    if (progress) {
      await indexingLogic(progress);
    } else {
      await this.progressHost.withProgress(
        "Angular Auto-Import: Indexing libraries from node_modules...",
        indexingLogic
      );
    }
  }

  /**
   * Indexes a library from its entry points.
   * @param entryPoints A map of import paths to file paths.
   * @internal
   */
  private async _indexLibrary(entryPoints: Map<string, string>): Promise<void> {
    // Snapshot the files already in the project (project sources + anything indexed
    // by a previous step). Everything ts-morph loads while indexing this library —
    // both the entry-point barrels and the transitively resolved declaration files —
    // will be the delta against this snapshot and can be released afterwards.
    const preExistingPaths = new Set(this.project.getSourceFiles().map((sf) => sf.getFilePath()));

    const libraryFiles = this.loadLibrarySourceFiles(entryPoints);

    if (libraryFiles.length === 0) {
      return;
    }

    try {
      const typeChecker = this.project.getTypeChecker();
      const allLibraryClasses = this.collectAllLibraryClasses(libraryFiles);
      const componentToModuleMap = this.buildLibraryComponentToModuleMap(libraryFiles, allLibraryClasses, typeChecker);

      await this.indexLibraryDeclarations(libraryFiles, componentToModuleMap);
    } finally {
      // Free the AST of every source file loaded for this library once all metadata
      // (selectors, modules) has been extracted into the persistent index. Library
      // files are only read, never modified, and the persisted structures
      // (`selectorTrie`, `externalModuleExportsIndex`) hold plain strings/`AngularElementData`
      // with no AST references, so keeping these SourceFiles in memory only inflates
      // the ts-morph Project. Entry points are re-export barrels, so the bulk of the
      // AST lives in the transitively loaded declaration files — releasing the full
      // delta (not just the entry points) is what actually bounds peak heap, which on
      // large monorepos (e.g. Nx) can otherwise grow by 1-2 GB across all dependencies.
      // Removal must happen here, after all three extraction phases complete, because
      // module mapping resolves symbols across files via the TypeChecker; removing
      // mid-loop would forget nodes still referenced by cross-file resolution.
      // Pre-existing files (project sources) are preserved via the snapshot; shared
      // typings (e.g. @angular/core) are reloaded on demand by the next library.
      this.releaseLibrarySourceFiles(preExistingPaths);
    }
  }

  /**
   * Removes from the ts-morph project every source file that was not present in the
   * given snapshot, releasing the AST loaded while indexing a single library. Nodes
   * that are already forgotten are skipped safely.
   * @param preExistingPaths File paths that existed before the library was indexed and must be kept.
   * @internal
   */
  private releaseLibrarySourceFiles(preExistingPaths: Set<string>): void {
    for (const sourceFile of this.project.getSourceFiles()) {
      try {
        const filePath = sourceFile.getFilePath(); // Throws if the node is already forgotten
        if (!preExistingPaths.has(filePath)) {
          this.project.removeSourceFile(sourceFile);
        }
      } catch {
        // SourceFile node already forgotten/removed, nothing to release.
      }
    }
  }

  private loadLibrarySourceFiles(
    entryPoints: Map<string, string>
  ): Array<{ importPath: string; sourceFile: SourceFile }> {
    const libraryFiles: { importPath: string; sourceFile: SourceFile }[] = [];

    for (const [importPath, filePath] of entryPoints.entries()) {
      // Skip excluded libraries
      if (isLibraryExcluded(importPath)) {
        this.logger.info(`[Indexer] Skipping excluded library: ${importPath}`);
        continue;
      }

      try {
        const sourceFile = this.project.addSourceFileAtPathIfExists(filePath);
        if (sourceFile) {
          try {
            sourceFile.getFilePath();
            libraryFiles.push({ importPath, sourceFile });
          } catch {
            this.logger.warn(`[Indexer] SourceFile node forgotten for library file ${filePath}, skipping`);
          }
        }
      } catch (error) {
        this.logger.warn(`[Indexer] Could not process library file ${filePath}: ${(error as Error).message}`);
      }
    }

    return libraryFiles;
  }

  private collectAllLibraryClasses(
    libraryFiles: Array<{ importPath: string; sourceFile: SourceFile }>
  ): Map<string, ClassDeclaration> {
    const allLibraryClasses = new Map<string, ClassDeclaration>();

    for (const { sourceFile } of libraryFiles) {
      withValidSourceFile(
        sourceFile,
        () => this.collectClassesFromSourceFile(sourceFile, allLibraryClasses),
        "class collection",
        this.logger
      );
    }

    return allLibraryClasses;
  }

  private collectClassesFromSourceFile(sourceFile: SourceFile, allLibraryClasses: Map<string, ClassDeclaration>): void {
    const exportedDeclarations = sourceFile.getExportedDeclarations();
    for (const declarations of exportedDeclarations.values()) {
      for (const declaration of declarations) {
        if (declaration.isKind(SyntaxKind.ClassDeclaration)) {
          const name = declaration.getName();
          if (name && !allLibraryClasses.has(name)) {
            allLibraryClasses.set(name, declaration);
          }
        }
      }
    }

    for (const classDecl of sourceFile.getClasses()) {
      const name = classDecl.getName();
      if (name && !allLibraryClasses.has(name)) {
        allLibraryClasses.set(name, classDecl);
      }
    }
  }

  private buildLibraryComponentToModuleMap(
    libraryFiles: Array<{ importPath: string; sourceFile: SourceFile }>,
    allLibraryClasses: Map<string, ClassDeclaration>,
    typeChecker: import("ts-morph").TypeChecker
  ): ComponentToModuleMap {
    const componentToModuleMap: ComponentToModuleMap = new Map();

    for (const { importPath, sourceFile } of libraryFiles) {
      withValidSourceFile(
        sourceFile,
        () =>
          this._buildComponentToModuleMap(sourceFile, importPath, componentToModuleMap, allLibraryClasses, typeChecker),
        `module mapping for ${importPath}`,
        this.logger
      );
    }

    return componentToModuleMap;
  }

  private async indexLibraryDeclarations(
    libraryFiles: Array<{ importPath: string; sourceFile: SourceFile }>,
    componentToModuleMap: ComponentToModuleMap
  ): Promise<void> {
    for (const { importPath, sourceFile } of libraryFiles) {
      await withValidSourceFile(
        sourceFile,
        async () => await this._indexDeclarationsInFile(sourceFile, importPath, componentToModuleMap),
        `declarations indexing for ${importPath}`,
        this.logger
      ).result;
    }
  }

  /**
   * Indexes all NgModules in the project.
   * @param moduleFilePaths An array of absolute module file paths to index.
   * @internal
   */
  private async indexProjectModules(moduleFilePaths: string[]): Promise<void> {
    if (!this.projectRootPath) {
      return;
    }
    this.logger.debug(`[Indexer] Indexing ${moduleFilePaths.length} project NgModules for ${this.projectRootPath}...`);
    this.index.componentModules.clear();

    for (const file of moduleFilePaths) {
      try {
        const sourceFile = this.project.addSourceFileAtPath(file);
        // Check if the sourceFile is still valid before processing
        sourceFile.getFilePath(); // This will throw if the node is forgotten
        this._processProjectModuleFile(sourceFile);
      } catch (error) {
        this.logger.warn(`[Indexer] Could not process project module file ${file}: ${(error as Error).message}`);
      }
    }

    // Process already opened files that might be modules
    for (const sourceFile of this.project.getSourceFiles()) {
      const result = withValidSourceFile(
        sourceFile,
        () => sourceFile.getFilePath(),
        "project module processing",
        this.logger
      );
      if (result.success && result.result) {
        const filePath = result.result;
        if (filePath.endsWith(".module.ts") && !moduleFilePaths.includes(filePath)) {
          this._processProjectModuleFile(sourceFile);
        }
      }
    }
    this.logger.debug(`[Indexer] Found ${this.index.componentModules.size} component-to-module mappings in project.`);
  }

  /**
   * Processes a single project module file.
   * @param sourceFile The source file to process.
   * @internal
   */
  private _processProjectModuleFile(sourceFile: SourceFile) {
    if (!this.isSourceFileValid(sourceFile)) {
      return;
    }

    const classDeclarations = sourceFile.getClasses();
    for (const classDecl of classDeclarations) {
      this.processNgModuleClass(classDecl, sourceFile);
    }
  }

  /**
   * Checks if a source file is valid.
   */
  private isSourceFileValid(sourceFile: SourceFile): boolean {
    try {
      sourceFile.getFilePath();
      return true;
    } catch {
      this.logger.warn(`[Indexer] SourceFile node forgotten in _processProjectModuleFile, skipping`);
      return false;
    }
  }

  /**
   * Processes a single NgModule class.
   */
  private processNgModuleClass(classDecl: ClassDeclaration, sourceFile: SourceFile): void {
    const ngModuleDecorator = classDecl.getDecorator("NgModule");
    if (!ngModuleDecorator) {
      return;
    }

    const moduleName = classDecl.getName();
    if (!moduleName) {
      return;
    }

    const objectLiteral = this.getNgModuleObjectLiteral(ngModuleDecorator);
    if (!objectLiteral) {
      return;
    }

    const exportsProp = objectLiteral.getProperty("exports");
    if (!exportsProp) {
      return;
    }

    this.processModuleExports(exportsProp as PropertyAssignment, moduleName, sourceFile);
  }

  /**
   * Gets the NgModule decorator's object literal.
   */
  private getNgModuleObjectLiteral(ngModuleDecorator: Decorator): ObjectLiteralExpression | null {
    const decoratorArg = ngModuleDecorator.getArguments()[0];
    if (!decoratorArg?.isKind(SyntaxKind.ObjectLiteralExpression)) {
      return null;
    }
    return decoratorArg as ObjectLiteralExpression;
  }

  /**
   * Processes module exports.
   */
  private processModuleExports(exportsProp: PropertyAssignment, moduleName: string, sourceFile: SourceFile): void {
    const exportedIdentifiers = this._getIdentifierNamesFromArrayProp(exportsProp);

    if (exportedIdentifiers.length === 0) {
      return;
    }

    this.storeModuleExports(moduleName, exportedIdentifiers);
    this.updateProjectModuleMap(exportedIdentifiers, moduleName, sourceFile);
  }

  /**
   * Stores module exports in the index.
   */
  private storeModuleExports(moduleName: string, exportedIdentifiers: string[]): void {
    this.index.moduleExports.set(moduleName, new Set(exportedIdentifiers));
    this.logger.debug(
      `[ProjectModules] Indexed module ${moduleName} with ${exportedIdentifiers.length} exports: ${exportedIdentifiers.join(", ")}`
    );
  }

  /**
   * Updates the project module map with exported identifiers.
   */
  private updateProjectModuleMap(exportedIdentifiers: string[], moduleName: string, sourceFile: SourceFile): void {
    const newImportPath = path.relative(this.projectRootPath, sourceFile.getFilePath()).replace(/\\/g, "/");
    const exportCount = exportedIdentifiers.length;

    for (const componentName of exportedIdentifiers) {
      const existing = this.index.componentModules.get(componentName);
      const newCandidate = { moduleName, importPath: newImportPath, exportCount };

      if (existing) {
        const newScore = this._calculateModuleFitScore(
          componentName,
          newCandidate.moduleName,
          newCandidate.exportCount,
          newCandidate.importPath
        );
        const existingScore = this._calculateModuleFitScore(
          componentName,
          existing.moduleName,
          existing.exportCount,
          existing.importPath
        );

        if (newScore > existingScore) {
          this.index.componentModules.set(componentName, newCandidate);
        }
      } else {
        this.index.componentModules.set(componentName, newCandidate);
      }
    }
  }

  /**
   * Gets the names of identifiers in an array property.
   * @param prop The property assignment to get the identifiers from.
   * @returns An array of identifier names.
   * @internal
   */
  private _getIdentifierNamesFromArrayProp(prop: PropertyAssignment | undefined): string[] {
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
   * Builds a map of components to the modules that export them.
   * @param sourceFile The source file to process.
   * @param importPath The import path of the source file.
   * @param componentToModuleMap The map to store the component-to-module mappings.
   * @param allLibraryClasses A map of all classes in the library.
   * @param typeChecker The type checker to use.
   * @internal
   */
  private _buildComponentToModuleMap(
    sourceFile: SourceFile,
    importPath: string,
    componentToModuleMap: ComponentToModuleMap,
    allLibraryClasses: Map<string, ClassDeclaration>,
    typeChecker: TypeChecker
  ) {
    try {
      const classDeclarations = this._collectClassDeclarations(sourceFile);
      this._processNgModuleClasses(classDeclarations, importPath, componentToModuleMap, allLibraryClasses, typeChecker);
    } catch (error) {
      try {
        this.logger.error(
          `Error building module map for file ${sourceFile.getFilePath()}: ${(error as Error).message}`
        );
      } catch {
        this.logger.error(`Error building module map for forgotten SourceFile node: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Processes all NgModule classes and maps their exports.
   * @param classDeclarations Map of class declarations to process.
   * @param importPath The import path of the source file.
   * @param componentToModuleMap The map to store the component-to-module mappings.
   * @param allLibraryClasses A map of all classes in the library.
   * @param typeChecker The type checker to use.
   * @internal
   */
  private _processNgModuleClasses(
    classDeclarations: Map<string, ClassDeclaration>,
    importPath: string,
    componentToModuleMap: ComponentToModuleMap,
    allLibraryClasses: Map<string, ClassDeclaration>,
    typeChecker: TypeChecker
  ) {
    // Find all NgModules among the correctly found classes and map their exports
    for (const classDecl of classDeclarations.values()) {
      const className = classDecl.getName();
      // Skip unnamed or internal Angular modules
      if (!className || className.startsWith("ɵ")) {
        continue;
      }

      this._processNgModuleClass(
        classDecl,
        className,
        importPath,
        componentToModuleMap,
        allLibraryClasses,
        typeChecker
      );
    }
  }

  /**
   * Processes a single NgModule class and maps its exports.
   * @param classDecl The class declaration to process.
   * @param className The name of the class.
   * @param importPath The import path of the source file.
   * @param componentToModuleMap The map to store the component-to-module mappings.
   * @param allLibraryClasses A map of all classes in the library.
   * @param typeChecker The type checker to use.
   * @internal
   */
  private _processNgModuleClass(
    classDecl: ClassDeclaration,
    className: string,
    importPath: string,
    componentToModuleMap: ComponentToModuleMap,
    allLibraryClasses: Map<string, ClassDeclaration>,
    typeChecker: TypeChecker
  ) {
    const exportsTuple = parseModDefinition(classDecl);
    if (!exportsTuple) {
      return;
    }
    const moduleExports = new Set<string>();

    this._processModuleExports(
      exportsTuple,
      className,
      importPath,
      componentToModuleMap,
      allLibraryClasses,
      typeChecker,
      moduleExports
    );

    // Store the accumulated exports in the external modules index
    if (moduleExports.size > 0) {
      this.index.moduleExports.set(className, moduleExports);
      this.logger.debug(
        `[ExternalModules] Indexed module ${className} with ${moduleExports.size} exports: ${Array.from(moduleExports).join(", ")}`
      );
    }
  }

  /**
   * Processes the exports of a module.
   * @param exportsTuple The tuple of exported elements.
   * @param moduleName The name of the module.
   * @param importPath The import path of the module.
   * @param componentToModuleMap The map to store the component-to-module mappings.
   * @param allLibraryClasses A map of all classes in the library.
   * @param typeChecker The type checker to use.
   * @param moduleExports Optional Set to accumulate all exports for the module.
   * @internal
   */
  private _processModuleExports(
    exportsTuple: import("ts-morph").TupleTypeNode,
    moduleName: string,
    importPath: string,
    componentToModuleMap: ComponentToModuleMap,
    allLibraryClasses: Map<string, ClassDeclaration>,
    typeChecker: TypeChecker,
    moduleExports?: Set<string>
  ) {
    for (const element of exportsTuple.getElements()) {
      const exportedClassName = this._resolveExportedClassName(element, typeChecker);
      if (!exportedClassName) {
        this.logger.debug(
          `[ExternalModules] ${moduleName}: could not resolve export name from tuple entry '${element.getText()}' (skipped)`
        );
        continue;
      }

      const exportedClassDecl = allLibraryClasses.get(exportedClassName);
      if (!exportedClassDecl) {
        this.logger.debug(
          `[ExternalModules] ${moduleName}: export '${exportedClassName}' not found in collected library classes (skipped)`
        );
        continue;
      }

      if (this._isReexportedModule(exportedClassDecl)) {
        // Add the re-exported module name to parent's exports (for transitive expansion)
        moduleExports?.add(exportedClassName);
        this.logger.debug(
          `[ExternalModules] ${moduleName} re-exports module ${exportedClassName} (will be expanded transitively)`
        );

        // Still process the module's contents recursively (for componentToModuleMap, etc)
        this._processReexportedModule(
          exportedClassDecl,
          moduleName,
          importPath,
          componentToModuleMap,
          allLibraryClasses,
          typeChecker,
          moduleExports
        );
      } else {
        this._mapComponentToModule(exportedClassName, moduleName, importPath, componentToModuleMap, moduleExports);
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
   * @returns The exported class name or undefined.
   * @internal
   */
  private _resolveExportedClassName(
    element: import("ts-morph").TypeNode,
    typeChecker: TypeChecker
  ): string | undefined {
    let exprName: import("ts-morph").EntityName;
    if (element.isKind(SyntaxKind.TypeQuery)) {
      exprName = element.getExprName();
    } else if (element.isKind(SyntaxKind.TypeReference)) {
      exprName = element.getTypeName();
    } else {
      return undefined;
    }

    // Syntactic name: the right-most identifier of the (possibly qualified) name,
    // e.g. `i1.TranslatePipe` -> `TranslatePipe`. Used as a TypeChecker-independent fallback.
    const syntacticName = exprName.isKind(SyntaxKind.QualifiedName)
      ? exprName.getRight().getText()
      : exprName.getText();

    const type = typeChecker.getTypeAtLocation(exprName);
    const symbol = type.getSymbol() ?? type.getAliasSymbol();
    const resolvedName = symbol ? (symbol.getAliasedSymbol() ?? symbol).getName() : undefined;

    if (!resolvedName && syntacticName) {
      // TypeChecker could not resolve the symbol (e.g. WSL/Windows mounts with
      // symlinked or case-mismatched node_modules). The syntactic fallback below
      // recovers the export that would otherwise be silently dropped.
      this.logger.debug(
        `[ExternalModules] TypeChecker could not resolve export '${exprName.getText()}', using syntactic name '${syntacticName}'`
      );
    }

    return resolvedName ?? syntacticName ?? undefined;
  }

  /**
   * Checks if the exported class declaration is a re-exported NgModule.
   * @param exportedClassDecl The class declaration to check.
   * @returns True if it's a re-exported module.
   * @internal
   */
  private _isReexportedModule(exportedClassDecl: ClassDeclaration): boolean {
    return !!exportedClassDecl.getStaticProperty("ɵmod");
  }

  /**
   * Processes a re-exported module by recursively processing its exports.
   * @param exportedClassDecl The re-exported module class declaration.
   * @param moduleName The current module name.
   * @param importPath The import path.
   * @param componentToModuleMap The component-to-module mapping.
   * @param allLibraryClasses Map of all class declarations.
   * @param typeChecker The type checker.
   * @param moduleExports Optional set to accumulate exports.
   * @internal
   */
  private _processReexportedModule(
    exportedClassDecl: ClassDeclaration,
    moduleName: string,
    importPath: string,
    componentToModuleMap: ComponentToModuleMap,
    allLibraryClasses: Map<string, ClassDeclaration>,
    typeChecker: TypeChecker,
    moduleExports?: Set<string>
  ) {
    const innerExportsTuple = parseModDefinition(exportedClassDecl);
    if (innerExportsTuple) {
      this._processModuleExports(
        innerExportsTuple,
        moduleName,
        importPath,
        componentToModuleMap,
        allLibraryClasses,
        typeChecker,
        moduleExports
      );
    }
  }

  /**
   * Maps a component/directive/pipe to its module.
   * @param exportedClassName The name of the exported class.
   * @param moduleName The module name.
   * @param importPath The import path.
   * @param componentToModuleMap The mapping to update.
   * @param moduleExports Optional set to add exports to.
   * @internal
   */
  private _mapComponentToModule(
    exportedClassName: string,
    moduleName: string,
    importPath: string,
    componentToModuleMap: ComponentToModuleMap,
    moduleExports?: Set<string>
  ) {
    // This function is only called during library indexing where we build the module exports on the fly.
    // If moduleExports is not present, we can't perform scoring, so we can't add the mapping.
    if (!moduleExports) {
      return;
    }

    const exportCount = moduleExports.size;
    const existing = componentToModuleMap.get(exportedClassName);

    const newCandidate = { moduleName, importPath, exportCount };

    if (existing) {
      const newScore = this._calculateModuleFitScore(
        exportedClassName,
        newCandidate.moduleName,
        newCandidate.exportCount,
        newCandidate.importPath
      );
      const existingScore = this._calculateModuleFitScore(
        exportedClassName,
        existing.moduleName,
        existing.exportCount,
        existing.importPath
      );

      // If new one is better, update the map.
      if (newScore > existingScore) {
        componentToModuleMap.set(exportedClassName, newCandidate);
      }
    } else {
      // If it doesn't exist, add it.
      componentToModuleMap.set(exportedClassName, newCandidate);
    }

    // This is for accumulating all unique exports for the top-level module being processed.
    moduleExports.add(exportedClassName);
  }

  /**
   * Calculates a "fit score" for a module-component pair.
   * Higher score is better.
   * @internal
   */
  private _calculateModuleFitScore(
    componentName: string,
    moduleName: string,
    exportCount: number,
    importPath: string
  ): number {
    let score = 0;

    // 1. Major bonus for direct name match (e.g., InputNumber in InputNumberModule)
    if (moduleName.startsWith(componentName)) {
      score += 100;
    }

    // 2. Penalty for generic module names that don't relate to the component
    if (moduleName.toLowerCase().includes("module")) {
      const baseModuleName = moduleName.replace(/module$/i, "");
      if (baseModuleName.length > 0 && !componentName.toLowerCase().includes(baseModuleName.toLowerCase())) {
        score -= 10;
      }
    }

    // 3. Bonus for specificity (fewer exports is better)
    score += 50 / (exportCount + 1);

    // 4. Small penalty for longer import paths as a tie-breaker
    score -= importPath.length * 0.1;

    return score;
  }

  /**
   * Determines if an element is standalone from its compiled type reference.
   * @param typeRef The type reference node from a static property (e.g., `ɵcmp`).
   * @param elementType The type of the Angular element.
   * @returns `true` if the element is standalone, `false` otherwise.
   * @internal
   */
  private _isStandaloneFromTypeReference(
    typeRef: TypeReferenceNode,
    elementType: "component" | "directive" | "pipe"
  ): boolean {
    const typeArgs = typeRef.getTypeArguments();
    let standaloneIndex: number;

    switch (elementType) {
      case "component":
      case "directive":
        standaloneIndex = 7;
        break;
      case "pipe":
        standaloneIndex = 2;
        break;
      default:
        return false;
    }

    if (typeArgs.length > standaloneIndex) {
      return typeArgs[standaloneIndex].getText() === "true";
    }

    return false;
  }

  /**
   * Collects all class declarations from a source file.
   * @param sourceFile The source file to collect classes from.
   * @returns A map of class names to their declarations.
   * @internal
   */
  private _collectClassDeclarations(sourceFile: SourceFile): Map<string, ClassDeclaration> {
    const classDeclarations = new Map<string, ClassDeclaration>();

    // This logic is duplicated from _buildComponentToModuleMap to ensure we have all class definitions.
    // For entry-point indexing we only want classes that are publicly re-exported from this entry point.
    // This filters out private aliases such as `export { Foo as ɵFoo }`, which are not importable API.
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
   * Recursively searches for a static property (e.g., ɵcmp) in the inheritance chain.
   * @param cls The class to search in.
   * @param propName The property name to search for.
   * @returns An object containing the owner class and the property declaration.
   * @internal
   */
  private _findInheritedStaticProperty(
    cls: ClassDeclaration,
    propName: "ɵcmp" | "ɵdir" | "ɵpipe"
  ): { owner: ClassDeclaration; prop: import("ts-morph").PropertyDeclaration | undefined } {
    let current: ClassDeclaration | undefined = cls;
    while (current) {
      const prop = current.getStaticProperty(propName);
      if (prop?.isKind(SyntaxKind.PropertyDeclaration)) {
        return { owner: current, prop };
      }
      current = current.getBaseClass();
    }
    return { owner: cls, prop: undefined };
  }

  /**
   * Extracts selector from a type reference node.
   * @param typeRef The type reference node.
   * @returns The selector string or undefined.
   * @internal
   */
  private _extractSelectorFromTypeReference(typeRef: TypeReferenceNode): string | undefined {
    const typeArgs = typeRef.getTypeArguments();
    if (typeArgs.length > 1) {
      const selectorNode = typeArgs[1];
      if (selectorNode.isKind(SyntaxKind.LiteralType)) {
        const literal = selectorNode.getLiteral();
        if (literal.isKind(SyntaxKind.StringLiteral)) {
          return literal.getLiteralText();
        }
      } else if (selectorNode.isKind(SyntaxKind.TemplateLiteralType)) {
        // Handle template literals like `button[mat-icon-button]`
        return selectorNode.getText().slice(1, -1);
      }
    }
    return undefined;
  }

  /**
   * Analyzes a class declaration to extract Angular element information.
   * @param classDecl The class declaration to analyze.
   * @returns The element information or null if not an Angular element.
   * @internal
   */
  private _analyzeAngularElement(classDecl: ClassDeclaration): {
    elementType: "component" | "directive" | "pipe";
    selector: string;
    isStandalone: boolean;
  } | null {
    // Check for component, then directive, then pipe
    const componentResult = this._analyzeElementType(classDecl, "ɵcmp", "component");
    if (componentResult) {
      return componentResult;
    }

    const directiveResult = this._analyzeElementType(classDecl, "ɵdir", "directive");
    if (directiveResult) {
      return directiveResult;
    }

    const pipeResult = this._analyzePipeElement(classDecl);
    if (pipeResult) {
      return pipeResult;
    }

    return null;
  }

  private _analyzeElementType(
    classDecl: ClassDeclaration,
    propertyName: "ɵcmp" | "ɵdir",
    elementType: "component" | "directive"
  ): { elementType: "component" | "directive"; selector: string; isStandalone: boolean } | null {
    const { prop } = this._findInheritedStaticProperty(classDecl, propertyName);
    if (!prop) {
      return null;
    }

    const typeNode = prop.getTypeNode();
    if (!typeNode?.isKind(SyntaxKind.TypeReference)) {
      return null;
    }

    const typeRef = typeNode as TypeReferenceNode;
    const selector = this._extractSelectorFromTypeReference(typeRef);
    if (!selector) {
      return null;
    }

    return {
      elementType,
      selector,
      isStandalone: this._isStandaloneFromTypeReference(typeRef, elementType),
    };
  }

  private _analyzePipeElement(
    classDecl: ClassDeclaration
  ): { elementType: "pipe"; selector: string; isStandalone: boolean } | null {
    const { prop: pipeDef } = this._findInheritedStaticProperty(classDecl, "ɵpipe");
    if (!pipeDef) {
      return null;
    }

    const typeNode = pipeDef.getTypeNode();
    if (!typeNode?.isKind(SyntaxKind.TypeReference)) {
      return null;
    }

    const typeRef = typeNode as TypeReferenceNode;
    const selector = this._extractPipeSelectorFromTypeReference(typeRef);
    if (!selector) {
      return null;
    }

    return {
      elementType: "pipe",
      selector,
      isStandalone: this._isStandaloneFromTypeReference(typeRef, "pipe"),
    };
  }

  private _extractPipeSelectorFromTypeReference(typeRef: TypeReferenceNode): string | null {
    const typeArgs = typeRef.getTypeArguments();
    if (typeArgs.length <= 1 || !typeArgs[1].isKind(SyntaxKind.LiteralType)) {
      return null;
    }

    const literal = (typeArgs[1] as LiteralTypeNode).getLiteral();
    if (!literal.isKind(SyntaxKind.StringLiteral)) {
      return null;
    }

    return literal.getLiteralText();
  }

  /**
   * Creates and indexes Angular element data.
   * @param className The class name.
   * @param elementType The element type.
   * @param selector The selector string.
   * @param isStandalone Whether the element is standalone.
   * @param importPath The original import path.
   * @param componentToModuleMap Map of components to modules.
   * @param absoluteFilePath The absolute file path of the element.
   * @internal
   */
  private async _createAndIndexElementData(
    className: string,
    elementType: "component" | "directive" | "pipe",
    selector: string,
    isStandalone: boolean,
    importPath: string,
    componentToModuleMap: Map<string, { moduleName: string; importPath: string; exportCount: number }>,
    absoluteFilePath: string
  ): Promise<void> {
    const exportingModule = componentToModuleMap.get(className);
    const individualSelectors = await parseAngularSelector(selector);

    let finalImportPath = importPath;
    let finalImportName = className;

    if (exportingModule) {
      finalImportPath = exportingModule.importPath;
      finalImportName = isStandalone ? className : exportingModule.moduleName;
    }

    // For standalone external components, ensure we only store the one with the shortest import path.
    if (isStandalone) {
      const bestPath = this._handleStandaloneExternalComponent(
        className,
        elementType,
        finalImportPath,
        individualSelectors
      );
      if (bestPath === null) {
        return; // A better candidate already exists, so skip this one.
      }
      finalImportPath = bestPath;
    }

    const elementData = new AngularElementData({
      path: finalImportPath,
      name: finalImportName,
      type: elementType,
      originalSelector: selector,
      selectors: individualSelectors,
      isStandalone,
      isExternal: true, // This method only indexes elements coming from node_modules.
      exportingModuleName: !isStandalone && exportingModule ? exportingModule.moduleName : undefined,
      absolutePath: absoluteFilePath,
    });

    for (const sel of individualSelectors) {
      this.index.selectors.insert(sel, elementData);
    }

    const via = exportingModule ? `via ${exportingModule.moduleName}` : "directly";
    const standaloneTag = isStandalone ? "standalone" : "non-standalone";
    this.logger.info(
      `[NodeModulesIndexer] Indexed ${standaloneTag} ${elementType}: ${className} (${selector}) ${via} from ${finalImportPath}. Import target: ${finalImportName}`
    );
  }

  /**
   * Handles the special indexing logic for standalone components from external libraries.
   * It ensures that only one candidate with the shortest (most public) import path is stored.
   * @returns The determined final import path if processing should continue, or null if the candidate should be skipped.
   * @internal
   */
  private _handleStandaloneExternalComponent(
    className: string,
    elementType: "component" | "directive" | "pipe",
    currentImportPath: string,
    selectors: string[]
  ): string | null {
    // Use a representative selector to find existing candidates to avoid iterating over all selectors.
    const representativeSelector = selectors.length > 0 ? selectors[0] : "";
    if (!representativeSelector) {
      return currentImportPath; // Should not happen with valid components, but as a safeguard.
    }

    const existingCandidates = this.index.selectors.findAll(representativeSelector);
    const existingElement = existingCandidates.find((c) => c.name === className);

    if (existingElement) {
      // An element with the same name already exists. Compare import paths.
      if (currentImportPath.length >= existingElement.path.length) {
        // The existing path is shorter or equal, so we keep it and discard this new one.
        this.logger.debug(
          `[NodeModulesIndexer] Skipping standalone ${elementType} ${className} from ${currentImportPath} because a better candidate from ${existingElement.path} already exists.`
        );
        return null; // Signal to skip this element.
      }

      // The new path is shorter. Remove the old element before adding this new, better one.
      this.logger.debug(
        `[NodeModulesIndexer] Found better path for standalone ${elementType} ${className}. Replacing ${existingElement.path} with ${currentImportPath}.`
      );
      for (const sel of existingElement.selectors) {
        // Use the precise remove operation.
        this.index.selectors.remove(sel, existingElement.path, existingElement.name);
      }
    }

    // This is either the first time we see this element, or it's a better candidate.
    return currentImportPath;
  }

  /**
   * Indexes the declarations in a file.
   * @param sourceFile The source file to process.
   * @param importPath The import path of the source file.
   * @param componentToModuleMap A map of components to the modules that export them.
   * @internal
   */
  private async _indexDeclarationsInFile(
    sourceFile: SourceFile,
    importPath: string,
    componentToModuleMap: Map<string, { moduleName: string; importPath: string; exportCount: number }>
  ) {
    try {
      const classDeclarations = this._collectClassDeclarations(sourceFile);

      // Find all Components, Directives, and Pipes
      for (const classDecl of classDeclarations.values()) {
        const className = classDecl.getName();
        // Skip unnamed or internal Angular classes
        if (!className || className.startsWith("ɵ")) {
          continue;
        }

        const elementInfo = this._analyzeAngularElement(classDecl);
        if (elementInfo) {
          // For re-exported classes, get the ACTUAL file where the class is declared
          // Not the entry point (public-api.ts) but the file with the actual class declaration
          const actualSourceFile = classDecl.getSourceFile();
          const actualAbsoluteFilePath = actualSourceFile.getFilePath();

          await this._createAndIndexElementData(
            className,
            elementInfo.elementType,
            elementInfo.selector,
            elementInfo.isStandalone,
            importPath,
            componentToModuleMap,
            actualAbsoluteFilePath
          );
        }
      }
    } catch (error) {
      try {
        this.logger.error(
          `Error indexing declarations in file ${sourceFile.getFilePath()}: ${(error as Error).message}`
        );
      } catch {
        this.logger.error(`Error indexing declarations in forgotten SourceFile node: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Gets all indexed selectors.
   * @returns An array of selectors.
   */
  getAllSelectors(): string[] {
    return this.index.getAllSelectors();
  }

  /**
   * Searches for selectors with a given prefix.
   * @param prefix The prefix to search for.
   * @returns An array of objects containing the selector and the corresponding `AngularElementData`.
   */
  searchWithSelectors(prefix: string): { selector: string; element: AngularElementData }[] {
    return this.index.searchWithSelectors(prefix);
  }

  /**
   * Disposes the file watcher and clears the caches.
   */
  dispose() {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = null;
    }
    if (this.dependencyWatcher) {
      this.dependencyWatcher.dispose();
      this.dependencyWatcher = null;
    }
    this._onDidIndexNodeModules.dispose();
    this._onDidChangeIndex.dispose();
    this.index.clear();
    // Note: Should we dispose the ts-morph Project as well? It doesn't have a dispose method, but we can clear its files
    removeAllSourceFiles(this.project, "dispose", this.logger);
  }
}
