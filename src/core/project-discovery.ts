/**
 * Finds the Angular package that owns a file.
 *
 * Discovery walks from a document toward the workspace boundary and returns the
 * nearest package whose manifest declares `@angular/core`. Both runtimes need the
 * same answer for the same file, so the walk, the manifest reading, and its cache
 * live here rather than in the Extension Host entry point.
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type CoreLogger, silentLogger } from "./logging";
import { isPathInside } from "./project-registry";

/** The file access discovery needs, kept separate from the glob-based {@link FileSystem}. */
export interface ManifestReader {
  /** Reads a UTF-8 file, resolving `undefined` when it does not exist. */
  readTextFile(filePath: string): Promise<string | undefined>;
  /** Whether the path exists and is a directory. */
  isDirectory(filePath: string): Promise<boolean>;
}

/** Reads manifests straight from disk; the default for both runtimes. */
export const nodeManifestReader: ManifestReader = {
  async readTextFile(filePath: string): Promise<string | undefined> {
    try {
      return await fs.promises.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  },
  async isDirectory(filePath: string): Promise<boolean> {
    try {
      return (await fs.promises.stat(filePath)).isDirectory();
    } catch {
      return false;
    }
  },
};

export interface AngularProjectDiscoveryOptions {
  files?: ManifestReader;
  logger?: CoreLogger;
}

/**
 * Discovers Angular package roots and remembers what it learned about each directory.
 *
 * Discovery runs for every opened document and walks each parent directory, so the
 * manifest check is cached per directory. {@link AngularProjectDiscovery.invalidate}
 * drops entries when a manifest changes, which is what makes a freshly installed
 * `@angular/core` discoverable without restarting the host.
 */
export class AngularProjectDiscovery {
  private readonly files: ManifestReader;
  private readonly logger: CoreLogger;
  private readonly manifestChecks = new Map<string, Promise<boolean>>();

  constructor(options: AngularProjectDiscoveryOptions = {}) {
    this.files = options.files ?? nodeManifestReader;
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * Whether a directory's own manifest declares `@angular/core`.
   * @param projectRoot Absolute path of the directory holding the manifest.
   */
  async isAngularProject(projectRoot: string): Promise<boolean> {
    const packageRoot = path.resolve(projectRoot);
    let pendingCheck = this.manifestChecks.get(packageRoot);
    if (!pendingCheck) {
      pendingCheck = this.readAngularCoreDependency(packageRoot);
      this.manifestChecks.set(packageRoot, pendingCheck);
    }
    return pendingCheck;
  }

  /**
   * Walks from a file toward a boundary and returns the nearest Angular package.
   * @param filePath Absolute path of the document (or directory) to start from.
   * @param searchBoundary Absolute path the walk must not leave.
   */
  async findRoot(filePath: string, searchBoundary: string): Promise<string | undefined> {
    const boundary = path.resolve(searchBoundary);
    const target = path.resolve(filePath);

    if (!isPathInside(boundary, target)) {
      return undefined;
    }

    const targetRelativeToBoundary = path.relative(boundary, target);
    if (targetRelativeToBoundary.split(path.sep).includes("node_modules")) {
      return undefined;
    }

    let currentPath = (await this.files.isDirectory(target)) ? target : path.dirname(target);

    while (isPathInside(boundary, currentPath)) {
      if (await this.isAngularProject(currentPath)) {
        return currentPath;
      }
      if (currentPath === boundary) {
        break;
      }
      currentPath = path.dirname(currentPath);
    }

    return undefined;
  }

  /**
   * Forgets what was cached about a manifest so the next lookup reads it again.
   * @param packageJsonPath The manifest that changed. Clears every entry when omitted.
   */
  invalidate(packageJsonPath?: string): void {
    if (packageJsonPath === undefined) {
      this.manifestChecks.clear();
      return;
    }
    this.manifestChecks.delete(path.dirname(path.resolve(packageJsonPath)));
  }

  /**
   * Reads a single `package.json` and reports whether it declares `@angular/core`.
   * @internal
   */
  private async readAngularCoreDependency(packageRoot: string): Promise<boolean> {
    const packageJsonPath = path.join(packageRoot, "package.json");
    try {
      const manifest = await this.files.readTextFile(packageJsonPath);
      if (manifest === undefined) {
        return false;
      }
      const packageJson = JSON.parse(manifest);
      const dependencies = packageJson.dependencies || {};
      const devDependencies = packageJson.devDependencies || {};
      return !!dependencies["@angular/core"] || !!devDependencies["@angular/core"];
    } catch (error) {
      this.logger.error(`Error checking for Angular project in ${packageRoot}:`, error as Error);
      return false;
    }
  }
}
