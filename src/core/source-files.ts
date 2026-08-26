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
 *
 * A project is not always one directory. Its tsconfig may map code that lives beside
 * it — a monorepo library the app imports through a `paths` alias and could not import
 * any other way — and that code is as much part of the compilation as anything under
 * the root. {@link ProjectScope} is the root together with those directories.
 * @module
 */

import * as path from "node:path";
import { isPathInside } from "../utils/path";
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
 * A project root together with the directories outside it that its tsconfig maps in.
 *
 * Every rule below is stated against a scope rather than a path, so that a file under
 * an alias root is treated exactly like one under the root: found by the scan, kept by
 * the watcher, and indexed.
 */
export interface ProjectScope {
  /** Absolute path of the project root. */
  rootPath: string;
  /** Absolute paths outside the root, none of them nested in one another. */
  aliasRoots: readonly string[];
}

/**
 * Builds a scope from a root and whatever its `paths` entries resolved to.
 *
 * Three kinds of entry are dropped, and the reasons differ:
 *
 * - one that resolves inside the root, because the root's own scan already covers it;
 * - one that resolves to an ancestor of the root, because following it would index the
 *   whole tree the root was chosen out of — and choosing a root, whether by finding a
 *   manifest or by configuring `projectPath`, is precisely a decision not to;
 * - one nested inside another entry, because the outer one already reaches it.
 * @param rootPath Absolute path of the project root.
 * @param aliasRoots Directories the project's aliases resolve to, in any order.
 */
export function resolveProjectScope(rootPath: string, aliasRoots: Iterable<string>): ProjectScope {
  const root = path.resolve(rootPath);
  const candidates = Array.from(aliasRoots, (aliasRoot) => path.resolve(aliasRoot)).filter(
    (aliasRoot) => aliasRoot !== root && !isPathInside(root, aliasRoot) && !isPathInside(aliasRoot, root)
  );

  const kept = candidates.filter(
    (aliasRoot, index) =>
      candidates.indexOf(aliasRoot) === index &&
      !candidates.some((other) => other !== aliasRoot && isPathInside(other, aliasRoot))
  );

  return { rootPath: root, aliasRoots: kept };
}

/** A scope that is nothing but its root, for a project with no aliases to follow. */
export function rootOnlyScope(rootPath: string): ProjectScope {
  return { rootPath: path.resolve(rootPath), aliasRoots: [] };
}

/**
 * Describes the searches that find a project's indexable sources: one per directory of
 * its {@link ProjectScope}.
 * @param scope The project root and its alias roots.
 * @param boundaries Recognizes nested packages; without it the scan reaches into them.
 */
export function projectSourceQueries(scope: ProjectScope, boundaries?: ProjectBoundaries): FileSearchQuery[] {
  return [
    projectSourceQuery(scope.rootPath, boundaries),
    ...scope.aliasRoots.map((aliasRoot) => projectSourceQuery(aliasRoot)),
  ];
}

/**
 * The same, for a project's external templates.
 * @param scope The project root and its alias roots.
 * @param boundaries Recognizes nested packages; without it the scan reaches into them.
 */
export function projectTemplateQueries(scope: ProjectScope, boundaries?: ProjectBoundaries): FileSearchQuery[] {
  return [
    projectTemplateQuery(scope.rootPath, boundaries),
    ...scope.aliasRoots.map((aliasRoot) => projectTemplateQuery(aliasRoot)),
  ];
}

/**
 * Describes the search for a project's indexable sources.
 *
 * An alias root is searched without `boundaries`, and that is the deliberate part: the
 * boundary rule exists to stop a project swallowing a package it only happens to
 * contain, and an alias is the opposite situation — the tsconfig saying outright that
 * this code compiles as part of this project. A library with its own `package.json`
 * declaring `@angular/core` is still that project's library.
 * @param rootPath Absolute path of the directory to search.
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
  return hasIndexableName(segments);
}

/**
 * Whether a file anywhere in a scope should be indexed as a project source.
 * @param scope The project root and its alias roots.
 * @param filePath Absolute path of the reported file.
 */
export function isScopeSourceFile(scope: ProjectScope, filePath: string): boolean {
  return (
    isProjectSourceFile(scope.rootPath, filePath) ||
    scope.aliasRoots.some((aliasRoot) => isProjectSourceFile(aliasRoot, filePath))
  );
}

/**
 * The name-based half of the rule: the exclusions a search expresses as patterns.
 * @internal
 */
function hasIndexableName(segments: string[]): boolean {
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
 * @param scope The project root and its alias roots.
 * @param filePath Absolute path of the reported file.
 * @param boundaries Recognizes nested packages; without it only the name rules apply.
 */
export async function isOwnProjectSourceFile(
  scope: ProjectScope,
  filePath: string,
  boundaries?: ProjectBoundaries
): Promise<boolean> {
  if (!isScopeSourceFile(scope, filePath)) {
    return false;
  }
  // Only the root has a boundary to respect: see `projectSourceQueries` for why an
  // alias root has none.
  if (!boundaries || !isProjectSourceFile(scope.rootPath, filePath)) {
    return true;
  }

  const owningRoot = await boundaries.findRoot(filePath, scope.rootPath);
  return owningRoot === undefined || path.resolve(owningRoot) === scope.rootPath;
}
