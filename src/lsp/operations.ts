/**
 * The operations that are not language features.
 *
 * Reindexing, clearing a cache, and reading metrics are things the user asks for from
 * the command palette, and LSP has no vocabulary for any of them. The server does the
 * work and returns plain DTOs; deciding what the user sees stays entirely with the
 * client, which is the only side that has a UI.
 * @module
 */

import { type CoreLogger, silentLogger } from "../core/logging";
import type { ProjectRouter } from "./project-router";
import type { ProjectRuntime } from "./project-runtime";
import type { PerformanceMetrics, ProjectOperationResult, ProjectOutcome, ProjectScope } from "./protocol";

export interface ServerOperationsOptions {
  router: ProjectRouter;
  /** Every project that currently has a runtime, in discovery order. */
  runtimes(): ProjectRuntime[];
  logger?: CoreLogger;
}

/** Answers the extension's own requests. */
export class ServerOperations {
  private readonly logger: CoreLogger;

  constructor(private readonly options: ServerOperationsOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * Rebuilds the scoped projects' indexes.
   * @param scope Which projects to touch.
   */
  reindex(scope: ProjectScope): Promise<ProjectOperationResult> {
    return this.forEachProject(scope, "Reindex", (runtime) => runtime.reindex());
  }

  /**
   * Discards the scoped projects' persisted indexes.
   * @param scope Which projects to touch.
   */
  clearCache(scope: ProjectScope): Promise<ProjectOperationResult> {
    return this.forEachProject(scope, "Clear cache", (runtime) => runtime.clearCache());
  }

  /** What this server process is costing, and what each of its projects holds. */
  metrics(): PerformanceMetrics {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();

    return {
      memory: {
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        rss: memory.rss,
        external: memory.external,
      },
      cpu: { user: cpu.user, system: cpu.system },
      projects: this.options.runtimes().map((runtime) => ({
        rootPath: runtime.rootPath,
        elementCount: runtime.elementCount,
      })),
    };
  }

  /**
   * The projects an operation applies to: the one owning the scoped document, or all of
   * them when the scope names no document or names one no project owns.
   * @param scope The requested scope.
   */
  resolveScope(scope: ProjectScope): ProjectRuntime[] {
    const scoped = scope.uri ? this.options.router.resolve(scope.uri)?.runtime : undefined;
    return scoped ? [scoped] : this.options.runtimes();
  }

  /**
   * Runs one operation over the scoped projects, reporting each project's outcome
   * separately: one project failing does not mean the others did.
   * @internal
   */
  private async forEachProject(
    scope: ProjectScope,
    operation: string,
    run: (runtime: ProjectRuntime) => Promise<void>
  ): Promise<ProjectOperationResult> {
    const projects: ProjectOutcome[] = [];

    for (const runtime of this.resolveScope(scope)) {
      try {
        await run(runtime);
        projects.push({ rootPath: runtime.rootPath, elementCount: runtime.elementCount });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[Operations] ${operation} failed for ${runtime.rootPath}`, error as Error);
        projects.push({ rootPath: runtime.rootPath, elementCount: runtime.elementCount, error: message });
      }
    }

    return { projects };
  }
}
