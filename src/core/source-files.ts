/**
 * Which files of a project count as indexable Angular sources.
 *
 * One rule, two shapes: a {@link FileSearchQuery} for the initial scan, and a
 * predicate for the paths that reach the index without going through a search — a
 * watcher reports everything written under the root, including an install writing
 * into `node_modules` or a build writing into `dist`.
 * @module
 */

import * as path from "node:path";
import type { FileSearchQuery } from "./file-system";

/** Directory names that never hold indexable project sources. */
export const NON_SOURCE_DIRECTORIES = ["node_modules", ".git", "dist", "out", "e2e", "bazel-out"] as const;

/** File-name endings that never hold indexable project sources. */
export const NON_SOURCE_SUFFIXES = [".spec.ts", ".test.ts"] as const;

/**
 * Describes the search for a project's indexable sources.
 * @param rootPath Absolute path of the project root.
 */
export function projectSourceQuery(rootPath: string): FileSearchQuery {
  return {
    root: rootPath,
    extensions: [".ts"],
    excludedDirectories: NON_SOURCE_DIRECTORIES,
    excludeHiddenDirectories: true,
    excludedSuffixes: NON_SOURCE_SUFFIXES,
  };
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
