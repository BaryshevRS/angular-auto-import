/**
 * The language server's file access: a plain directory walk.
 *
 * The server has no `workspace.findFiles`, and the one search the analysis performs —
 * source files of one extension, minus a fixed set of directories and suffixes — is
 * expressed by {@link FileSearchQuery} without glob syntax. Excluded directories are
 * skipped before they are entered, so an install-sized `node_modules` is never walked.
 *
 * Symbolic links are deliberately not followed, which is a decision rather than an
 * omission. The search this replaced ran on ripgrep and did follow them, but every
 * layout that made that matter turns out not to need it: pnpm's links all live under
 * `node_modules`, which is excluded, and dependencies are indexed through `realpath`
 * elsewhere; a git worktree's files are real, and the `node_modules` people symlink
 * into one is resolved the same way. What remains is a link to a source directory
 * placed by hand. Following one costs a `stat` per entry and a set of visited real
 * paths to break loops — a link to an ancestor otherwise indexes the same file about
 * thirty times over before the kernel stops it. The walk skips them and says so, so a
 * missing element leaves a trail instead of nothing.
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileSearchQuery, FileSystem } from "../../core/file-system";
import { type CoreLogger, silentLogger } from "../../core/logging";

export interface NodeFileSystemOptions {
  /** Where the walk reports what it skipped; silent unless the caller supplies one. */
  logger?: CoreLogger;
}

/** Reads and searches straight from disk. */
export function createNodeFileSystem(options: NodeFileSystemOptions = {}): FileSystem {
  const logger = options.logger ?? silentLogger;
  return {
    findFiles: (query: FileSearchQuery) => collectFiles(query.root, query, logger),
    readFile: (filePath: string) => fs.promises.readFile(filePath, "utf8"),
  };
}

/**
 * Walks one directory, recursing into the subdirectories the query allows.
 * @internal
 */
async function collectFiles(directory: string, query: FileSearchQuery, logger: CoreLogger): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    // A directory that disappeared or cannot be read simply contributes nothing.
    return [];
  }

  const files: string[] = [];
  const subdirectories: Promise<string[]>[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!isExcludedDirectory(entry.name, query)) {
        subdirectories.push(collectSubdirectory(entryPath, query, logger));
      }
    } else if (entry.isFile() && isRequestedFile(entry.name, query)) {
      files.push(entryPath);
    } else if (entry.isSymbolicLink()) {
      // Neither branch above takes a symlink: `Dirent` reports it as neither a file nor
      // a directory. Saying so is the whole remedy — see the note at the top.
      logger.info(`Skipping ${entryPath}: symbolic links are not followed`);
    }
  }

  const nested = await Promise.all(subdirectories);
  return files.concat(...nested);
}

/**
 * Enters one subdirectory, unless the query rejects it.
 *
 * Kept separate from {@link collectFiles} so the question is asked inside the promise
 * this directory already contributes, and siblings are still walked in parallel.
 * @internal
 */
async function collectSubdirectory(directory: string, query: FileSearchQuery, logger: CoreLogger): Promise<string[]> {
  if (query.enterDirectory && !(await query.enterDirectory(directory))) {
    return [];
  }
  return collectFiles(directory, query, logger);
}

/** @internal */
function isExcludedDirectory(name: string, query: FileSearchQuery): boolean {
  if (query.excludeHiddenDirectories && name.startsWith(".")) {
    return true;
  }
  return (query.excludedDirectories ?? []).includes(name);
}

/** @internal */
function isRequestedFile(name: string, query: FileSearchQuery): boolean {
  if (!query.extensions.some((extension) => name.endsWith(extension))) {
    return false;
  }
  return !(query.excludedSuffixes ?? []).some((suffix) => name.endsWith(suffix));
}
