/**
 * The server's project runtimes, keyed by Angular root.
 * @module
 */

import { type CoreLogger, silentLogger } from "../core/logging";
import { ProjectRuntime } from "./project-runtime";

export interface ProjectRuntimeHostOptions {
  logger?: CoreLogger;
  /** Overrides how a runtime is built, for tests and for future runtime variants. */
  createRuntime?(rootPath: string, logger: CoreLogger): ProjectRuntime;
}

/**
 * The server's runtimes, keyed by root.
 *
 * Creation is idempotent per root and a failed creation leaves nothing behind, so the
 * root stays discoverable and the next document that needs it retries.
 */
export class ProjectRuntimeHost {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private readonly logger: CoreLogger;
  private readonly createRuntime: (rootPath: string, logger: CoreLogger) => ProjectRuntime;

  constructor(options: ProjectRuntimeHostOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.createRuntime = options.createRuntime ?? ((rootPath, logger) => new ProjectRuntime(rootPath, { logger }));
  }

  /**
   * Creates the runtime for a root, or keeps the existing one.
   * @param rootPath Absolute path of the discovered Angular root.
   */
  async create(rootPath: string): Promise<void> {
    if (this.runtimes.has(rootPath)) {
      return;
    }

    const runtime = this.createRuntime(rootPath, this.logger);
    try {
      await runtime.load();
    } catch (error) {
      runtime.dispose();
      throw error;
    }
    this.runtimes.set(rootPath, runtime);
  }

  /** The runtime serving a root, if one was created for it. */
  get(rootPath: string): ProjectRuntime | undefined {
    return this.runtimes.get(rootPath);
  }

  /** The roots that currently have a runtime, in creation order. */
  roots(): string[] {
    return Array.from(this.runtimes.keys());
  }

  /**
   * Disposes the runtime of one root.
   * @param rootPath The root to release.
   */
  dispose(rootPath: string): void {
    const runtime = this.runtimes.get(rootPath);
    if (!runtime) {
      return;
    }
    this.runtimes.delete(rootPath);
    runtime.dispose();
    this.logger.info(`Project runtime disposed for ${rootPath}`);
  }

  /** Disposes every runtime. */
  disposeAll(): void {
    for (const rootPath of this.roots()) {
      this.dispose(rootPath);
    }
  }
}
