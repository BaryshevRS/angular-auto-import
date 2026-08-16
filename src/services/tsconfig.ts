/**
 * TypeScript Configuration Helper Service
 *
 * The Extension Host's single {@link TsConfigResolver}: the resolution itself lives in
 * core so the language server can own one resolver per project root.
 * @module
 */

import { TsConfigResolver } from "../core/tsconfig";
import { logger } from "../logger";
import type { ProcessedTsConfig } from "../types";

const resolver = new TsConfigResolver({ logger });

/**
 * Clears the tsconfig and trie caches.
 * @param projectRoot If provided, only clears the cache for that project.
 */
export function clearCache(projectRoot?: string): void {
  resolver.clearCache(projectRoot);
}

/**
 * Finds and parses the `tsconfig.json` or `tsconfig.base.json` file for a given project.
 * @param projectRoot The root directory of the project.
 * @returns A processed tsconfig object or `null` if not found.
 */
export function findAndParseTsConfig(projectRoot: string): Promise<ProcessedTsConfig | null> {
  return resolver.findAndParseTsConfig(projectRoot);
}

/**
 * Resolves an absolute module path to an import path, using a tsconfig alias or
 * falling back to a relative path.
 * @param absoluteTargetModulePathNoExt Absolute path to the file to be imported, without extension.
 * @param absoluteCurrentFilePath Absolute path to the file where the import will be added.
 * @param projectRoot The root directory of the current project.
 * @returns A string for the import statement (e.g., '@app/components/my-comp' or '../../my-comp').
 */
export function resolveImportPath(
  absoluteTargetModulePathNoExt: string,
  absoluteCurrentFilePath: string,
  projectRoot: string
): Promise<string> {
  return resolver.resolveImportPath(absoluteTargetModulePathNoExt, absoluteCurrentFilePath, projectRoot);
}
