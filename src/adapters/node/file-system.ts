/**
 * The language server's file access: a plain directory walk.
 *
 * The server has no `workspace.findFiles`, and the one search the analysis performs —
 * source files of one extension, minus a fixed set of directories and suffixes — is
 * expressed by {@link FileSearchQuery} without glob syntax. Excluded directories are
 * skipped before they are entered, so an install-sized `node_modules` is never walked.
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileSearchQuery, FileSystem } from "../../core/file-system";

/** Reads and searches straight from disk. */
export function createNodeFileSystem(): FileSystem {
  return {
    findFiles: (query: FileSearchQuery) => collectFiles(query.root, query),
    readFile: (filePath: string) => fs.promises.readFile(filePath, "utf8"),
  };
}

/**
 * Walks one directory, recursing into the subdirectories the query allows.
 * @internal
 */
async function collectFiles(directory: string, query: FileSearchQuery): Promise<string[]> {
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
        subdirectories.push(collectSubdirectory(entryPath, query));
      }
    } else if (entry.isFile() && isRequestedFile(entry.name, query)) {
      files.push(entryPath);
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
async function collectSubdirectory(directory: string, query: FileSearchQuery): Promise<string[]> {
  if (query.enterDirectory && !(await query.enterDirectory(directory))) {
    return [];
  }
  return collectFiles(directory, query);
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
