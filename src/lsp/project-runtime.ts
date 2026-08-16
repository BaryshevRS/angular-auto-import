/**
 * One runtime per discovered Angular root.
 *
 * A runtime owns everything that belongs to a single project: its TypeScript
 * configuration, its element index, and — as the following increments land — its
 * scanning, watching, and persistence. Keeping the ownership explicit is what keeps
 * nested and sibling projects from sharing an index. {@link ProjectRuntimeHost} owns
 * their lifecycle.
 * @module
 */

import { createNodeFileSystem } from "../adapters/node/file-system";
import type { CacheStore } from "../core/cache";
import { AngularElementIndex } from "../core/element-index";
import type { FileSystem } from "../core/file-system";
import { type CoreLogger, silentLogger } from "../core/logging";
import { projectSourceQuery } from "../core/source-files";
import { TsConfigResolver } from "../core/tsconfig";
import type { ProcessedTsConfig } from "../types/tsconfig";
import { FileCacheStore } from "./file-cache-store";

export interface ProjectRuntimeOptions {
  logger?: CoreLogger;
  /** How this runtime reaches the disk; the server's own adapter by default. */
  fileSystem?: FileSystem;
  /** Directory the client set aside for caches; without one the runtime stays in memory. */
  storagePath?: string;
}

/** Everything the server knows about one Angular project root. */
export class ProjectRuntime {
  /** Absolute path of the Angular package this runtime serves. */
  readonly rootPath: string;
  /** Selectors, per-file elements, and module maps for this root alone. */
  readonly index = new AngularElementIndex();
  private readonly tsConfigResolver: TsConfigResolver;
  private readonly logger: CoreLogger;
  private readonly storagePath: string | undefined;
  private readonly fileSystem: FileSystem;
  private persistentCache: FileCacheStore | undefined;
  private processedTsConfig: ProcessedTsConfig | null = null;
  private disposed = false;

  constructor(rootPath: string, options: ProjectRuntimeOptions = {}) {
    this.rootPath = rootPath;
    this.logger = options.logger ?? silentLogger;
    this.storagePath = options.storagePath;
    this.fileSystem = options.fileSystem ?? createNodeFileSystem();
    this.tsConfigResolver = new TsConfigResolver({ logger: this.logger });
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

  /**
   * The project's indexable source files, which is what a full index reads.
   * Excluded directories are never entered, so `node_modules` costs nothing here.
   */
  listSourceFiles(): Promise<string[]> {
    return this.fileSystem.findFiles(projectSourceQuery(this.rootPath));
  }

  /** Loads what the runtime needs before it can answer requests for this root. */
  async load(): Promise<void> {
    this.processedTsConfig = await this.tsConfigResolver.findAndParseTsConfig(this.rootPath);
    await this.openCache();
    if (this.disposed) {
      return;
    }
    this.logger.info(
      this.processedTsConfig
        ? `Project runtime ready for ${this.rootPath} (tsconfig: ${this.processedTsConfig.sourceFilePath})`
        : `Project runtime ready for ${this.rootPath} (no tsconfig found)`
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

  /**
   * Opens this project's persistent cache, if the client provided a place for it.
   * A cache that no longer matches the project is simply not reused.
   * @internal
   */
  private async openCache(): Promise<void> {
    if (!this.storagePath) {
      return;
    }

    const cache = new FileCacheStore({
      directory: this.storagePath,
      rootPath: this.rootPath,
      fingerprint: { tsconfig: this.processedTsConfig?.sourceFilePath ?? "none" },
      logger: this.logger,
    });
    const reused = await cache.open();
    this.persistentCache = cache;
    this.logger.info(
      reused ? `Reusing the cached index for ${this.rootPath}` : `No usable cached index for ${this.rootPath}`
    );
  }

  /** Releases everything this root owns, leaving nothing behind for another root to read. */
  dispose(): void {
    this.disposed = true;
    this.index.clear();
    this.tsConfigResolver.clearCache();
    this.processedTsConfig = null;
    this.persistentCache = undefined;
  }
}
