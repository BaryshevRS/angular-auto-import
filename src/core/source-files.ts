/**
 * Which files of a project count as indexable Angular sources.
 *
 * One rule, two shapes: a {@link FileSearchQuery} for the initial scan, and a
 * predicate for the paths that reach the index without going through a search — a
 * watcher reports everything written under the root, including an install writing
 * into `node_modules` or a build writing into `dist`.
 *
 * Both shapes stop at a nested Angular package. A workspace that contains another
 * package draws that boundary deliberately, and a file on the far side of it belongs
 * to a project with its own tsconfig: indexing it here would offer it to templates
 * that cannot import it by the path this project would compute.
 * @module
 */

import * as path from "node:path";
import type { FileSearchQuery } from "./file-system";

/** Directory names that never hold indexable project sources. */
export const NON_SOURCE_DIRECTORIES = ["node_modules", ".git", "dist", "out", "e2e", "bazel-out"] as const;

/** File-name endings that never hold indexable project sources. */
export const NON_SOURCE_SUFFIXES = [".spec.ts", ".test.ts"] as const;

/**
 * Recognizes the packages a project's scan must not reach into.
 *
 * Satisfied by `AngularProjectDiscovery`, which is also what routing asks. Sharing one
 * answer is the point: a directory is a boundary for the scan exactly when it is a root
 * for routing, however the two happen to be ordered — a nested project need not have
 * been discovered yet for the scan containing it to stop there.
 */
export interface ProjectBoundaries {
  /** Whether a directory's own manifest declares `@angular/core`. */
  isAngularProject(directoryPath: string): Promise<boolean>;
  /** The nearest Angular package at or above a file, without leaving `searchBoundary`. */
  findRoot(filePath: string, searchBoundary: string): Promise<string | undefined>;
}

/**
 * Describes the search for a project's indexable sources.
 * @param rootPath Absolute path of the project root.
 * @param boundaries Recognizes nested packages; without it the scan reaches into them.
 */
export function projectSourceQuery(rootPath: string, boundaries?: ProjectBoundaries): FileSearchQuery {
  return {
    root: rootPath,
    extensions: [".ts"],
    excludedDirectories: NON_SOURCE_DIRECTORIES,
    excludeHiddenDirectories: true,
    excludedSuffixes: NON_SOURCE_SUFFIXES,
    enterDirectory: toDirectoryFilter(boundaries),
  };
}

/**
 * Describes the search for a project's external templates.
 *
 * The same exclusions as {@link projectSourceQuery}: a template under `node_modules` or
 * `dist` belongs to no component the user can edit.
 * @param rootPath Absolute path of the project root.
 */
export function projectTemplateQuery(rootPath: string, boundaries?: ProjectBoundaries): FileSearchQuery {
  return {
    root: rootPath,
    extensions: [".html"],
    excludedDirectories: NON_SOURCE_DIRECTORIES,
    excludeHiddenDirectories: true,
    enterDirectory: toDirectoryFilter(boundaries),
  };
}

/**
 * Turns the boundaries into the query's directory filter, or nothing when the caller
 * supplied none — an absent filter costs the walk nothing.
 * @internal
 */
function toDirectoryFilter(
  boundaries: ProjectBoundaries | undefined
): ((directoryPath: string) => Promise<boolean>) | undefined {
  if (!boundaries) {
    return undefined;
  }
  return async (directoryPath: string) => !(await boundaries.isAngularProject(directoryPath));
}

/**
 * Whether a file reported by a watcher should be indexed as a project source.
 * @param rootPath Absolute path of the project root.
 * @param filePath Absolute path of the reported file.
 */
export function isProjectSourceFile(rootPath: string, filePath: string): boolean {
  const relativePath = path.relative(rootPath, filePath);
  if (relativePath === "" || path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
    return false;
  }

  const segments = relativePath.split(path.sep);
  const fileName = segments[segments.length - 1];
  if (NON_SOURCE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) {
    return false;
  }

  return !segments
    .slice(0, -1)
    .some((segment) => (NON_SOURCE_DIRECTORIES as readonly string[]).includes(segment) || segment.startsWith("."));
}

/**
 * Whether a file reported by a watcher belongs to this project rather than to a package
 * nested inside it.
 *
 * The scan already stops at a nested package, but a watcher does not: it reports every
 * file written under the root, and an edit inside a nested package reaches the watchers
 * of both projects. Without this the index would be re-polluted one file at a time.
 *
 * A project whose own boundary cannot be established keeps the file: an unreadable
 * manifest should cost one wrong entry, not the whole index.
 * @param rootPath Absolute path of the project root.
 * @param filePath Absolute path of the reported file.
 * @param boundaries Recognizes nested packages; without it only the name rules apply.
 */
export async function isOwnProjectSourceFile(
  rootPath: string,
  filePath: string,
  boundaries?: ProjectBoundaries
): Promise<boolean> {
  if (!isProjectSourceFile(rootPath, filePath)) {
    return false;
  }
  if (!boundaries) {
    return true;
  }

  const owningRoot = await boundaries.findRoot(filePath, rootPath);
  return owningRoot === undefined || path.resolve(owningRoot) === path.resolve(rootPath);
}
