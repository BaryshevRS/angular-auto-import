/**
 * The server's project runtimes, keyed by Angular root.
 * @module
 */

import type { FileWatcherFactory } from "../core/file-watching";
import { type InstrumentedLogger, silentLogger, withInstrumentation } from "../core/logging";
import { ProjectRuntime } from "./project-runtime";

export interface ProjectRuntimeHostOptions {
  logger?: InstrumentedLogger;
  /** Directory the client set aside for caches, passed on to every runtime. */
  storagePath?: string;
  /** How every runtime learns that a watched file changed. */
  fileWatchers?: FileWatcherFactory;
  /** Minutes between automatic reindexes, passed on to every runtime. */
  reindexIntervalMinutes?: number;
  /** Called whenever any runtime's index changes, with that root's new generation. */
  onDidChangeIndex?(rootPath: string, generation: number): void;
  /** Overrides how a runtime is built, for tests and for future runtime variants. */
  createRuntime?(rootPath: string, logger: InstrumentedLogger): ProjectRuntime;
}

/**
 * The server's runtimes, keyed by root.
 *
 * Creation is idempotent per root and a failed creation leaves nothing behind, so the
 * root stays discoverable and the next document that needs it retries.
 */
export class ProjectRuntimeHost {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  /** Creations still in flight, so two documents opening at once share one runtime. */
  private readonly creating = new Map<string, Promise<void>>();
  private readonly logger: InstrumentedLogger;
  private readonly createRuntime: (rootPath: string, logger: InstrumentedLogger) => ProjectRuntime;

  constructor(options: ProjectRuntimeHostOptions = {}) {
    this.logger = options.logger ?? withInstrumentation(silentLogger);
    this.createRuntime =
      options.createRuntime ??
      ((rootPath, logger) =>
        new ProjectRuntime(rootPath, {
          logger,
          storagePath: options.storagePath,
          fileWatchers: options.fileWatchers,
          reindexIntervalMinutes: options.reindexIntervalMinutes,
          onDidChangeIndex: options.onDidChangeIndex,
        }));
  }

  /**
   * Creates the runtime for a root, or keeps the existing one.
   * @param rootPath Absolute path of the discovered Angular root.
   */
  async create(rootPath: string): Promise<void> {
    if (this.runtimes.has(rootPath)) {
      return;
    }

    const pending = this.creating.get(rootPath);
    if (pending) {
      await pending;
      return;
    }

    const creation = this.load(rootPath);
    this.creating.set(rootPath, creation);
    try {
      await creation;
    } finally {
      this.creating.delete(rootPath);
    }
  }

  /**
   * Builds and loads one runtime, leaving nothing behind if either step fails or if the
   * root was released while it was loading.
   * @internal
   */
  private async load(rootPath: string): Promise<void> {
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

  /** Every runtime that currently exists, in creation order. */
  all(): ProjectRuntime[] {
    return Array.from(this.runtimes.values());
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
