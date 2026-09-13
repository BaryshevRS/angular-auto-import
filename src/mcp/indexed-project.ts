/**
 * One indexed project, in the shape the agent-facing answers ask for.
 *
 * Two processes build this: the standalone MCP server, which indexes a project the
 * moment an agent names a file in it, and the language server, which already has the
 * same project indexed for the editor. Both hand it to the same four answers, so the
 * shape lives here rather than beside either of them.
 * @module
 */

import type { AngularCompilerApi } from "../core/angular-compiler";
import type { ProjectRuntime } from "../lsp/project-runtime";
import { countImporters, packageOf } from "./library-usage";

/** A project, indexed and ready to answer. */
export interface IndexedProject {
  runtime: ProjectRuntime;
  compiler: AngularCompilerApi;
  /**
   * How many of the project's files import from each installed package.
   *
   * Counted on the first question that needs it and reused until the live index changes,
   * because it reads every source file in the workspace.
   */
  libraryUsage(): Promise<ReadonlyMap<string, number>>;
}

/**
 * Presents an indexed runtime as a project the answers can use.
 * @param runtime The project's live index.
 * @param compiler The Angular compiler, shared by every project in the process.
 */
export function indexedProject(runtime: ProjectRuntime, compiler: AngularCompilerApi): IndexedProject {
  let usage: Promise<ReadonlyMap<string, number>> | undefined;
  let usageGeneration = -1;

  return {
    runtime,
    compiler,
    libraryUsage: () => {
      if (!usage || usageGeneration !== runtime.indexGeneration) {
        usageGeneration = runtime.indexGeneration;
        usage = countImporters(runtime, installedPackages(runtime));
      }
      return usage;
    },
  };
}

/**
 * The packages this project's index holds elements from.
 *
 * Only these are worth counting: a file importing `rxjs` says nothing about which UI
 * library a template should be written with.
 * @internal
 */
function installedPackages(runtime: ProjectRuntime): Set<string> {
  const packages = new Set<string>();
  for (const { element } of runtime.indexer.searchWithSelectors("")) {
    if (element.isExternal) {
      packages.add(packageOf(element.path));
    }
  }
  return packages;
}
