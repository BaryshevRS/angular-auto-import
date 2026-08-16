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

import { AngularElementIndex } from "../core/element-index";
import { type CoreLogger, silentLogger } from "../core/logging";
import { TsConfigResolver } from "../core/tsconfig";
import type { ProcessedTsConfig } from "../types/tsconfig";

export interface ProjectRuntimeOptions {
  logger?: CoreLogger;
}

/** Everything the server knows about one Angular project root. */
export class ProjectRuntime {
  /** Absolute path of the Angular package this runtime serves. */
  readonly rootPath: string;
  /** Selectors, per-file elements, and module maps for this root alone. */
  readonly index = new AngularElementIndex();
  private readonly tsConfigResolver: TsConfigResolver;
  private readonly logger: CoreLogger;
  private processedTsConfig: ProcessedTsConfig | null = null;
  private disposed = false;

  constructor(rootPath: string, options: ProjectRuntimeOptions = {}) {
    this.rootPath = rootPath;
    this.logger = options.logger ?? silentLogger;
    this.tsConfigResolver = new TsConfigResolver({ logger: this.logger });
  }

  /** The project's parsed TypeScript configuration, or `null` when it has none. */
  get tsConfig(): ProcessedTsConfig | null {
    return this.processedTsConfig;
  }

  /** Loads what the runtime needs before it can answer requests for this root. */
  async load(): Promise<void> {
    this.processedTsConfig = await this.tsConfigResolver.findAndParseTsConfig(this.rootPath);
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

  /** Releases everything this root owns, leaving nothing behind for another root to read. */
  dispose(): void {
    this.disposed = true;
    this.index.clear();
    this.tsConfigResolver.clearCache();
    this.processedTsConfig = null;
  }
}
