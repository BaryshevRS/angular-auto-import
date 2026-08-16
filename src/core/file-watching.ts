/**
 * File-change notification boundary shared by the Extension Host and language server.
 *
 * The Extension Host receives changes from `workspace.createFileSystemWatcher`; the
 * server receives them from the client's watched-file notifications. Both deliver the
 * same three events for absolute paths, so the indexer subscribes to this instead.
 * @module
 */

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
  /** Glob, relative to {@link FileWatchQuery.root}, selecting the files to report. */
  include: string;
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
