/**
 * One runtime per discovered Angular root.
 *
 * A runtime owns everything that belongs to a single project: its TypeScript
 * configuration, its index, its persistent cache, and the watching that keeps the
 * index current. Keeping the ownership explicit is what keeps nested and sibling
 * projects from sharing an index, and the scan stops where the next project begins. {@link ProjectRuntimeHost} owns their lifecycle.
 * @module
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createNodeFileSystem } from "../adapters/node/file-system";
import { type CacheStore, createMemoryCacheStore } from "../core/cache";
import { type CancellationSource, createCancellationSource } from "../core/cancellation";
import type { FileSystem } from "../core/file-system";
import type { FileWatcherFactory } from "../core/file-watching";
import { type InstrumentedLogger, silentLogger, withInstrumentation } from "../core/logging";
import { type ProgressHost, silentProgressHost } from "../core/progress";
import type { ImportModuleSpecifierPreference } from "../core/settings";
import {
  type ProjectBoundaries,
  type ProjectScope,
  projectSourceQueries,
  projectTemplateQueries,
  resolveProjectScope,
  rootOnlyScope,
} from "../core/source-files";
import { TsConfigResolver } from "../core/tsconfig";
import { AngularIndexer } from "../services/indexer";
import type { ProcessedTsConfig } from "../types/tsconfig";
import { FileCacheStore } from "./file-cache-store";

/** Watches nothing; the default until the client's watched-file notifications are wired. */
const inertFileWatchers: FileWatcherFactory = {
  watch: () => ({ dispose: () => undefined }),
};

export interface ProjectRuntimeOptions {
  logger?: InstrumentedLogger;
  /** How this runtime reaches the disk; the server's own adapter by default. */
  fileSystem?: FileSystem;
  /** How this runtime learns that a watched file changed. */
  fileWatchers?: FileWatcherFactory;
  /**
   * Recognizes the packages nested inside this root. Shared with discovery so a
   * directory is a boundary for this project's index exactly when it is a root of its
   * own — including one no document has opened yet.
   */
  boundaries?: ProjectBoundaries;
  /** Where indexing reports progress; silent unless the caller surfaces it. */
  progressHost?: ProgressHost;
  /** Directory the client set aside for caches; without one the index lives for this session. */
  storagePath?: string;
  /**
   * Called after this project's index changed and its generation advanced. Anything
   * computed against the previous generation is now stale.
   */
  onDidChangeIndex?(rootPath: string, generation: number): void;
  /** Read when an import is planned, so a settings change takes effect without rebuilding the index. */
  importModuleSpecifierPreference?(): ImportModuleSpecifierPreference;
}

/** Everything the server knows about one Angular project root. */
export class ProjectRuntime {
  /** Absolute path of the Angular package this runtime serves. */
  readonly rootPath: string;
  /** Selectors, per-file elements, and module maps for this root alone. */
  readonly indexer: AngularIndexer;
  private readonly tsConfigResolver: TsConfigResolver;
  private readonly logger: InstrumentedLogger;
  private readonly storagePath: string | undefined;
  private readonly fileSystem: FileSystem;
  private readonly boundaries: ProjectBoundaries | undefined;
  private readonly cacheStore: CacheStore;
  private readonly persistentCache: FileCacheStore | undefined;
  private readonly importModuleSpecifierPreference: () => ImportModuleSpecifierPreference;
  private readonly cancellation: CancellationSource = createCancellationSource();
  private readonly indexSubscription: { dispose(): void };
  private generation = 0;
  private processedTsConfig: ProcessedTsConfig | null = null;
  private scope: ProjectScope;
  private loadedFromCache = false;
  private disposed = false;

  constructor(rootPath: string, options: ProjectRuntimeOptions = {}) {
    this.rootPath = rootPath;
    this.scope = rootOnlyScope(rootPath);
    this.logger = options.logger ?? withInstrumentation(silentLogger);
    this.storagePath = options.storagePath;
    this.fileSystem = options.fileSystem ?? createNodeFileSystem({ logger: this.logger });
    this.boundaries = options.boundaries;
    this.importModuleSpecifierPreference = options.importModuleSpecifierPreference ?? (() => "non-relative");
    this.tsConfigResolver = new TsConfigResolver({ logger: this.logger });
    this.persistentCache = this.storagePath ? this.createPersistentCache() : undefined;
    this.cacheStore = this.persistentCache ?? createMemoryCacheStore();
    this.indexer = new AngularIndexer({
      cacheStore: this.cacheStore,
      logger: this.logger,
      fileSystem: this.fileSystem,
      progressHost: options.progressHost ?? silentProgressHost,
      fileWatchers: options.fileWatchers ?? inertFileWatchers,
      boundaries: this.boundaries,
    });
    this.indexSubscription = this.indexer.onDidChangeIndex(() => {
      this.generation += 1;
      options.onDidChangeIndex?.(this.rootPath, this.generation);
    });
  }

  /**
   * Advances whenever this project's index changes.
   *
   * A result computed against an older generation was computed against an index that
   * no longer exists, and must be discarded rather than returned.
   */
  get indexGeneration(): number {
    return this.generation;
  }

  /** The project's parsed TypeScript configuration, or `null` when it has none. */
  get tsConfig(): ProcessedTsConfig | null {
    return this.processedTsConfig;
  }

  /**
   * Everything this project indexes: its root, and the directories outside it that its
   * `paths` aliases map in.
   */
  get projectScope(): ProjectScope {
    return this.scope;
  }

  /**
   * Where this project's index is persisted, or `undefined` when the client gave the
   * server no storage directory and the index only lives for this session.
   */
  get cache(): CacheStore | undefined {
    return this.persistentCache;
  }

  /** Whether the index was restored from the cache instead of scanned. */
  get restoredFromCache(): boolean {
    return this.loadedFromCache;
  }

  /**
   * The project's indexable source files, which is what a full index reads.
   * Excluded directories are never entered, so `node_modules` costs nothing here.
   */
  async listSourceFiles(): Promise<string[]> {
    const searches = await Promise.all(
      projectSourceQueries(this.scope, this.boundaries).map((query) => this.fileSystem.findFiles(query))
    );
    return Array.from(new Set(searches.flat()));
  }

  /**
   * The project's external templates, which the index itself never reads: only a
   * whole-project report has any reason to look at a template nobody has opened.
   */
  async listTemplateFiles(): Promise<string[]> {
    const searches = await Promise.all(
      projectTemplateQueries(this.scope, this.boundaries).map((query) => this.fileSystem.findFiles(query))
    );
    return Array.from(new Set(searches.flat()));
  }

  /**
   * Brings the project's index up: from the cache when it is still usable, from a full
   * scan otherwise, and then keeps it current from watched changes.
   */
  async load(): Promise<void> {
    await this.readTsConfig();
    const reusedCache = (await this.persistentCache?.open()) ?? false;
    if (this.disposed) {
      return;
    }

    this.indexer.setProjectScope(this.scope, this.processedTsConfig?.sourceFilePath);
    this.loadedFromCache = reusedCache && (await this.indexer.loadFromWorkspace());
    if (!this.loadedFromCache) {
      await this.indexer.generateFullIndex(undefined, this.cancellation.signal);
    }
    if (this.disposed) {
      return;
    }

    this.indexer.initializeWatcher();
    this.logger.info(
      `Project runtime ready for ${this.rootPath}: ${this.indexer.getAllSelectors().length} selectors ${
        this.loadedFromCache ? "restored from cache" : "indexed from source"
      }`
    );
  }

  /** How many selectors this project has indexed. */
  get elementCount(): number {
    return this.indexer.getAllSelectors().length;
  }

  /**
   * Rebuilds this project's index from source.
   *
   * The TypeScript configuration is re-read first, because the usual reason to ask for
   * a reindex by hand is that a `paths` mapping changed and the resolved import
   * specifiers are now wrong.
   */
  async reindex(): Promise<void> {
    this.tsConfigResolver.clearCache(this.rootPath);
    await this.readTsConfig();
    if (this.disposed) {
      return;
    }

    this.indexer.setProjectScope(this.scope, this.processedTsConfig?.sourceFilePath);
    this.indexer.initializeWatcher();
    await this.indexer.generateFullIndex(undefined, this.cancellation.signal);
    this.loadedFromCache = false;
  }

  /**
   * Reads the project's TypeScript configuration and works out what it puts in scope.
   *
   * An alias that resolves to nothing is dropped here rather than in the scan: a
   * `paths` entry for a library that has not been generated yet is normal in a
   * monorepo, and a watcher on a directory that does not exist is not.
   * @internal
   */
  private async readTsConfig(): Promise<void> {
    this.processedTsConfig = await this.tsConfigResolver.findAndParseTsConfig(this.rootPath);
    const candidates = resolveProjectScope(this.rootPath, this.processedTsConfig?.aliasRoots ?? []);
    const existing = await Promise.all(
      candidates.aliasRoots.map(async (aliasRoot) => ((await isDirectory(aliasRoot)) ? aliasRoot : undefined))
    );
    this.scope = {
      rootPath: candidates.rootPath,
      aliasRoots: existing.filter((aliasRoot): aliasRoot is string => aliasRoot !== undefined),
    };
  }

  /**
   * Resolves an absolute module path to the import specifier to write for this project.
   * @param targetModulePathNoExt Absolute path of the module to import, without extension.
   * @param currentFilePath Absolute path of the file the import is added to.
   */
  resolveImportPath(targetModulePathNoExt: string, currentFilePath: string): Promise<string> {
    return this.tsConfigResolver.resolveImportPath(
      targetModulePathNoExt,
      currentFilePath,
      this.rootPath,
      this.importModuleSpecifierPreference()
    );
  }

  /** Releases everything this root owns, leaving nothing behind for another root to read. */
  dispose(): void {
    this.disposed = true;
    this.cancellation.cancel();
    this.indexSubscription.dispose();
    this.indexer.dispose();
    this.tsConfigResolver.clearCache();
    this.processedTsConfig = null;
    this.loadedFromCache = false;
  }

  /**
   * Builds this project's persistent cache. The fingerprint decides when a cached
   * index may be reused at all.
   * @internal
   */
  private createPersistentCache(): FileCacheStore {
    return new FileCacheStore({
      directory: this.storagePath as string,
      rootPath: this.rootPath,
      // The alias roots are part of the fingerprint because they decide what the index
      // contains. The cache is keyed by the project root alone, so a `paths` entry that
      // was added, removed, or repointed would otherwise restore an index describing a
      // set of directories that is no longer this project's.
      fingerprint: () => ({ schema: "index", aliasRoots: [...this.scope.aliasRoots].sort().join(path.delimiter) }),
      logger: this.logger,
    });
  }
}

/** @internal */
async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}
