/**
 * One runtime per discovered Angular root.
 *
 * A runtime owns everything that belongs to a single project: its TypeScript
 * configuration, its index, its persistent cache, and the watching that keeps the
 * index current. Keeping the ownership explicit is what keeps nested and sibling
 * projects from sharing an index. {@link ProjectRuntimeHost} owns their lifecycle.
 * @module
 */

import { createNodeFileSystem } from "../adapters/node/file-system";
import { type CacheStore, createMemoryCacheStore } from "../core/cache";
import type { FileSystem } from "../core/file-system";
import type { FileWatcherFactory } from "../core/file-watching";
import { type InstrumentedLogger, silentLogger, withInstrumentation } from "../core/logging";
import { type ProgressHost, silentProgressHost } from "../core/progress";
import { projectSourceQuery } from "../core/source-files";
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
  /** Where indexing reports progress; silent unless the caller surfaces it. */
  progressHost?: ProgressHost;
  /** Directory the client set aside for caches; without one the index lives for this session. */
  storagePath?: string;
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
  private readonly cacheStore: CacheStore;
  private readonly persistentCache: FileCacheStore | undefined;
  private processedTsConfig: ProcessedTsConfig | null = null;
  private loadedFromCache = false;
  private disposed = false;

  constructor(rootPath: string, options: ProjectRuntimeOptions = {}) {
    this.rootPath = rootPath;
    this.logger = options.logger ?? withInstrumentation(silentLogger);
    this.storagePath = options.storagePath;
    this.fileSystem = options.fileSystem ?? createNodeFileSystem();
    this.tsConfigResolver = new TsConfigResolver({ logger: this.logger });
    this.persistentCache = this.storagePath ? this.createPersistentCache() : undefined;
    this.cacheStore = this.persistentCache ?? createMemoryCacheStore();
    this.indexer = new AngularIndexer({
      cacheStore: this.cacheStore,
      logger: this.logger,
      fileSystem: this.fileSystem,
      progressHost: options.progressHost ?? silentProgressHost,
      fileWatchers: options.fileWatchers ?? inertFileWatchers,
    });
  }

  /** The project's parsed TypeScript configuration, or `null` when it has none. */
  get tsConfig(): ProcessedTsConfig | null {
    return this.processedTsConfig;
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
  listSourceFiles(): Promise<string[]> {
    return this.fileSystem.findFiles(projectSourceQuery(this.rootPath));
  }

  /**
   * Brings the project's index up: from the cache when it is still usable, from a full
   * scan otherwise, and then keeps it current from watched changes.
   */
  async load(): Promise<void> {
    this.processedTsConfig = await this.tsConfigResolver.findAndParseTsConfig(this.rootPath);
    const reusedCache = (await this.persistentCache?.open()) ?? false;
    if (this.disposed) {
      return;
    }

    this.indexer.setProjectRoot(this.rootPath);
    this.loadedFromCache = reusedCache && (await this.indexer.loadFromWorkspace());
    if (!this.loadedFromCache) {
      await this.indexer.generateFullIndex();
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

  /**
   * Resolves an absolute module path to the import specifier to write for this project.
   * @param targetModulePathNoExt Absolute path of the module to import, without extension.
   * @param currentFilePath Absolute path of the file the import is added to.
   */
  resolveImportPath(targetModulePathNoExt: string, currentFilePath: string): Promise<string> {
    return this.tsConfigResolver.resolveImportPath(targetModulePathNoExt, currentFilePath, this.rootPath);
  }

  /** Releases everything this root owns, leaving nothing behind for another root to read. */
  dispose(): void {
    this.disposed = true;
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
      fingerprint: { schema: "index" },
      logger: this.logger,
    });
  }
}
