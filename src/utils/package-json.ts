/**
 * Utilities for working with `package.json` files.
 * @module
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sharedLogger } from "../core/logging";

/**
 * Information about an Angular dependency found in `node_modules`.
 */
export interface AngularDependency {
  /** The name of the dependency (e.g., '@angular/core'). */
  name: string;
  /** The real path to the library's folder. */
  path: string;
}

/**
 * Represents the structure of a `package.json` file.
 * @internal
 */
interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, string | ExportTarget>;
  types?: string;
  typings?: string;
}

/**
 * Represents an export target in `package.json`.
 * @internal
 */
interface ExportTarget {
  types?: string;
}

/**
 * Finds and reads the root `package.json` of the project.
 * @param projectRootPath The root path of the project.
 * @returns The parsed `package.json` object or `null` if not found.
 * @internal
 */
async function getRootPackageJson(projectRootPath: string): Promise<PackageJson | null> {
  const packageJsonPath = path.join(projectRootPath, "package.json");
  try {
    const content = await fs.readFile(packageJsonPath, "utf-8");
    return JSON.parse(content) as PackageJson;
  } catch (error) {
    sharedLogger().error(
      `[PackageJson] Error reading or parsing root package.json at ${packageJsonPath}`,
      error as Error
    );
    return null;
  }
}

async function resolveDependencyPath(projectRootPath: string, dependencyName: string): Promise<string> {
  let currentPath = projectRootPath;

  while (true) {
    try {
      return await fs.realpath(path.join(currentPath, "node_modules", dependencyName));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }
      currentPath = parentPath;
    }
  }
}

/**
 * Finds all Angular libraries in the project's dependencies.
 *
 * @param projectRootPath The root path of the project.
 * @returns A list of Angular libraries.
 */
export async function findAngularDependencies(projectRootPath: string): Promise<AngularDependency[]> {
  const rootPackageJson = await getRootPackageJson(projectRootPath);
  if (!rootPackageJson) {
    return [];
  }

  const dependencies = {
    ...(rootPackageJson.dependencies ?? {}),
    ...(rootPackageJson.devDependencies ?? {}),
  };

  const angularDependencies: AngularDependency[] = [];
  const processedDeps = new Set<string>();

  for (const depName of Object.keys(dependencies)) {
    if (processedDeps.has(depName)) {
      continue;
    }
    processedDeps.add(depName);

    try {
      const realDepPath = await resolveDependencyPath(projectRootPath, depName);
      const depPackageJsonPath = path.join(realDepPath, "package.json");
      const depPackageJsonContent = await fs.readFile(depPackageJsonPath, "utf-8");
      const depPackageJson = JSON.parse(depPackageJsonContent) as PackageJson;

      const isAngularLib =
        depPackageJson.peerDependencies?.["@angular/core"] ||
        depPackageJson.dependencies?.["@angular/core"] ||
        depName.startsWith("@angular/");

      if (isAngularLib) {
        angularDependencies.push({ name: depName, path: realDepPath });
      }
    } catch (_error) {
      // console.warn(`[PackageJson] Could not process dependency: ${depName}`, error);
    }
  }

  return angularDependencies;
}

/**
 * Gets the entry points for a library from its `package.json`.
 *
 * @param library Information about the library.
 * @returns A map where the key is the import path and the value is the absolute path to the `.d.ts` file.
 */
export async function getLibraryEntryPoints(library: AngularDependency): Promise<Map<string, string>> {
  const entryPoints = new Map<string, string>();

  try {
    const packageJson = await loadPackageJson(library.path);
    processPackageJsonEntryPoints(packageJson, library, entryPoints);
  } catch (error) {
    sharedLogger().error(`[PackageJson] Error getting entry points for ${library.name}`, error as Error);
  }

  return entryPoints;
}

async function loadPackageJson(libraryPath: string): Promise<PackageJson> {
  const packageJsonPath = path.join(libraryPath, "package.json");
  const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
  return JSON.parse(packageJsonContent) as PackageJson;
}

function processPackageJsonEntryPoints(
  packageJson: PackageJson,
  library: AngularDependency,
  entryPoints: Map<string, string>
): void {
  if (packageJson.exports) {
    processExportsField(packageJson.exports, library, entryPoints);
  } else {
    processFallbackTypes(packageJson, library, entryPoints);
  }
}

function processExportsField(
  exports: Record<string, unknown>,
  library: AngularDependency,
  entryPoints: Map<string, string>
): void {
  for (const [exportPath, target] of Object.entries(exports)) {
    processExportTarget(exportPath, target, library, entryPoints);
  }
}

function processExportTarget(
  exportPath: string,
  target: unknown,
  library: AngularDependency,
  entryPoints: Map<string, string>
): void {
  if (typeof target === "string" && target.endsWith(".d.ts")) {
    addEntryPoint(exportPath, target, library, entryPoints);
  } else if (isObjectWithTypes(target)) {
    const typesPath = target.types;
    if (typeof typesPath === "string" && typesPath.endsWith(".d.ts")) {
      addEntryPoint(exportPath, typesPath, library, entryPoints);
    }
  }
}

function isObjectWithTypes(target: unknown): target is { types: unknown } {
  return typeof target === "object" && target !== null && "types" in target;
}

function addEntryPoint(
  exportPath: string,
  typesPath: string,
  library: AngularDependency,
  entryPoints: Map<string, string>
): void {
  const importPath = path.join(library.name, exportPath).replace(/\\/g, "/");
  entryPoints.set(importPath, path.resolve(library.path, typesPath));
}

function processFallbackTypes(
  packageJson: PackageJson,
  library: AngularDependency,
  entryPoints: Map<string, string>
): void {
  const typesFile = packageJson.types || packageJson.typings;
  if (typeof typesFile === "string" && typesFile.endsWith(".d.ts")) {
    entryPoints.set(library.name, path.resolve(library.path, typesFile));
  }
}
