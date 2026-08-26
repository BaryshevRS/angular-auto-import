/**
 * File-change notification boundary shared by the Extension Host and language server.
 *
 * The Extension Host receives changes from `workspace.createFileSystemWatcher`; the
 * server receives them from the client's watched-file notifications and has to decide
 * for itself which subscription a reported path belongs to. A watch is therefore
 * described structurally rather than as a glob string: the editor adapter turns it
 * into a pattern, and the server matches paths against it with {@link matchesWatch}.
 * @module
 */

import * as path from "node:path";
import type { Disposable } from "./events";

/** What happened to a watched file. */
export type FileChangeKind = "create" | "change" | "delete";

export interface FileChange {
  /** Absolute path of the file that changed. */
  filePath: string;
  kind: FileChangeKind;
}

/** Describes which files a subscription is interested in. */
export interface FileWatchQuery {
  /** Absolute path of the directory the watch is rooted at. */
  root: string;
  /** Whether files in subdirectories are watched too. */
  recursive: boolean;
  /** File extensions to report, including the leading dot. */
  extensions?: readonly string[];
  /** Exact file names to report, such as `package.json`. */
  fileNames?: readonly string[];
}

/** Creates file-change subscriptions on behalf of a runtime. */
export interface FileWatcherFactory {
  /**
   * Reports changes to the files matching `query` until the subscription is disposed.
   * @param query The files to watch.
   * @param onChange Called for every matching change.
   */
  watch(query: FileWatchQuery, onChange: (change: FileChange) => void): Disposable;
}

/**
 * Whether a reported path belongs to a watch.
 * @param query The watch to test against.
 * @param filePath Absolute path of the reported file.
 */
export function matchesWatch(query: FileWatchQuery, filePath: string): boolean {
  const relativePath = path.relative(query.root, filePath);
  if (relativePath === "" || path.isAbsolute(relativePath) || relativePath.startsWith("..")) {
    return false;
  }
  if (!query.recursive && relativePath.includes(path.sep)) {
    return false;
  }

  const fileName = path.basename(relativePath);
  const matchesExtension = (query.extensions ?? []).some((extension) => fileName.endsWith(extension));
  const matchesName = (query.fileNames ?? []).includes(fileName);
  return matchesExtension || matchesName;
}
