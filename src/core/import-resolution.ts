/**
 * Where an indexed element is imported from.
 *
 * An element's indexed `path` is project-relative for a project element and already a
 * module specifier for an external one. Turning that into the text an import statement
 * should carry is the same decision in both hosts, so it is made once here and each
 * host only supplies its own module-path resolution.
 * @module
 */

import * as path from "node:path";
import type { AngularElementData } from "../types";
import { switchFileType } from "../utils/path";

/** Resolves an absolute module path, without extension, to this project's specifier. */
export type ModulePathResolver = (targetModulePathNoExt: string, currentFilePath: string) => Promise<string>;

/**
 * Resolves the specifier to import an element from.
 * @param element The element the template needs.
 * @param componentFilePath Absolute path of the file the import is added to.
 * @param projectRootPath Absolute path of the Angular project the element is indexed in.
 * @param resolveModulePath The project's tsconfig-aware path resolution.
 * @returns An external element's own module specifier, or the project element's resolved path.
 */
export function resolveElementImportPath(
  element: AngularElementData,
  componentFilePath: string,
  projectRootPath: string,
  resolveModulePath: ModulePathResolver
): Promise<string> {
  if (element.isExternal) {
    return Promise.resolve(element.path);
  }

  const absoluteTargetModulePath = path.join(projectRootPath, element.path);
  return resolveModulePath(switchFileType(absoluteTargetModulePath, ""), componentFilePath);
}
