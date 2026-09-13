/**
 * One indexed Angular project per root, for a process that answers questions about them.
 *
 * The language server holds the same thing behind a router keyed by open documents. An
 * agent has no open documents: it names a file, and the project that owns it has to be
 * found and indexed on the spot. Both roots and runtimes are kept for the life of the
 * process, because an agent asks about the same project many times in a row and indexing
 * a monorepo is measured in seconds.
 * @module
 */

import * as path from "node:path";
import { NodeFileWatchers } from "../adapters/node/file-watching";
import { type AngularCompilerApi, adoptAngularCompiler } from "../core/angular-compiler";
import { AngularProjectDiscovery, nodeManifestReader } from "../core/project-discovery";
import { findDeepestContainingProjectRoot } from "../core/project-registry";
import { ProjectRuntime } from "../lsp/project-runtime";
import { type IndexedProject, indexedProject } from "./indexed-project";

export type { IndexedProject };

/**
 * The projects this process has been asked about.
 *
 * Not a cache with a policy: nothing here is evicted, because an agent's session is
 * short and an index it has already paid for is the only reason a second question is
 * fast.
 */
export class Workspace {
  private readonly discovery = new AngularProjectDiscovery({ files: nodeManifestReader });
  private readonly fileWatchers = new NodeFileWatchers();
  private readonly roots = new Map<string, Promise<string | undefined>>();
  private readonly projects = new Map<string, Promise<IndexedProject>>();
  private compiler: Promise<AngularCompilerApi> | undefined;

  private readonly searchBoundaries: string[];

  constructor(searchBoundaries: Iterable<string> = [process.cwd()]) {
    this.searchBoundaries = [...new Set(Array.from(searchBoundaries, (root) => path.resolve(root)))];
  }

  /**
   * The indexed project that owns one file.
   * @param filePath Absolute path of a file inside the project.
   * @returns The project, or `undefined` when no Angular root contains the file.
   */
  async projectFor(filePath: string): Promise<IndexedProject | undefined> {
    const root = await this.rootFor(path.resolve(filePath));
    if (!root) {
      return undefined;
    }

    let project = this.projects.get(root);
    if (!project) {
      project = this.load(root);
      this.projects.set(root, project);
    }
    const indexed = await project;
    await this.fileWatchers.synchronize();
    return indexed;
  }

  /** Releases every indexed project. */
  dispose(): void {
    for (const project of this.projects.values()) {
      void project.then(({ runtime }) => runtime.dispose()).catch(() => undefined);
    }
    this.projects.clear();
    this.roots.clear();
    this.fileWatchers.dispose();
  }

  /** @internal */
  private rootFor(filePath: string): Promise<string | undefined> {
    const directory = path.dirname(filePath);
    let found = this.roots.get(directory);
    if (!found) {
      const boundary = findDeepestContainingProjectRoot(filePath, this.searchBoundaries);
      found = boundary ? this.discovery.findRoot(filePath, boundary) : Promise.resolve(undefined);
      this.roots.set(directory, found);
    }
    return found;
  }

  /** @internal */
  private async load(root: string): Promise<IndexedProject> {
    const runtime = new ProjectRuntime(root, { fileWatchers: this.fileWatchers });
    await runtime.load();
    return indexedProject(runtime, await this.angularCompiler());
  }

  /**
   * The Angular compiler, imported once.
   *
   * It is the heaviest thing this process loads and it is the same for every project, so
   * it is loaded on the first question rather than at startup — a request that turns out
   * to name no Angular project never pays for it.
   * @internal
   */
  private angularCompiler(): Promise<AngularCompilerApi> {
    this.compiler ??= import("@angular/compiler").then((module) => adoptAngularCompiler(module));
    return this.compiler;
  }
}
