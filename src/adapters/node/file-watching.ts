/**
 * Native file watching for long-lived Node processes such as the standalone MCP server.
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Disposable } from "../../core/events";
import {
  type FileChange,
  type FileChangeKind,
  type FileWatcherFactory,
  type FileWatchQuery,
  matchesWatch,
} from "../../core/file-watching";
import { type CoreLogger, silentLogger } from "../../core/logging";

/** Native notifications can arrive shortly after the write that caused them resolves. */
const WATCH_QUIET_MS = 20;
const POLLING_EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "out", "e2e", "bazel-out"]);

type FileSnapshot = Map<string, string>;

interface Subscription {
  query: FileWatchQuery;
  onChange(change: FileChange): void;
  watcher?: fs.FSWatcher;
  snapshot?: FileSnapshot;
  active: boolean;
}

export interface NodeFileWatcherOptions {
  logger?: CoreLogger;
}

/** Watches the local disk and can drain incremental work before a request reads it. */
export class NodeFileWatchers implements FileWatcherFactory, Disposable {
  private readonly subscriptions = new Set<Subscription>();
  private readonly pending = new Set<Promise<void>>();
  private readonly pendingByFile = new Map<string, Promise<void>>();
  private readonly logger: CoreLogger;
  private synchronization: Promise<void> = Promise.resolve();
  private activity = 0;
  private disposed = false;

  constructor(options: NodeFileWatcherOptions = {}) {
    this.logger = options.logger ?? silentLogger;
  }

  watch(query: FileWatchQuery, onChange: (change: FileChange) => void): Disposable {
    if (this.disposed) {
      return { dispose: () => undefined };
    }

    const subscription: Subscription = { query, onChange, active: true };
    this.subscriptions.add(subscription);
    try {
      const watcher = fs.watch(query.root, { recursive: query.recursive }, (eventType, fileName) => {
        if (!subscription.active || subscription.snapshot || fileName === null) {
          return;
        }

        const filePath = path.resolve(query.root, fileName.toString());
        if (!matchesWatch(query, filePath)) {
          return;
        }
        this.activity += 1;

        this.enqueue(filePath, async () => {
          const kind = await fileChangeKind(eventType, filePath);
          if (subscription.active && !this.disposed) {
            await onChange({ filePath, kind });
          }
        });
      });
      subscription.watcher = watcher;
      watcher.on("error", (error) => {
        this.logger.error(`File watcher failed for ${query.root}`, error);
        this.usePolling(subscription);
      });
    } catch (error) {
      this.logger.error(`Could not watch ${query.root}`, error as Error);
      this.usePolling(subscription);
    }

    return {
      dispose: () => {
        if (!subscription.active) {
          return;
        }
        subscription.active = false;
        this.closeNativeWatcher(subscription);
        subscription.snapshot?.clear();
        subscription.snapshot = undefined;
        this.subscriptions.delete(subscription);
      },
    };
  }

  /** Waits for a quiet native-watcher window and every async listener it started. */
  synchronize(): Promise<void> {
    const synchronization = this.synchronization.then(() => this.drain());
    this.synchronization = synchronization.catch(() => undefined);
    return synchronization;
  }

  private async drain(): Promise<void> {
    while (true) {
      const observedActivity = this.activity;
      await Promise.all(Array.from(this.subscriptions, (subscription) => this.poll(subscription)));
      await quietWindow();
      await Promise.all(Array.from(this.pending));
      if (observedActivity === this.activity && this.pending.size === 0) {
        return;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.active = false;
      this.closeNativeWatcher(subscription);
      subscription.snapshot?.clear();
      subscription.snapshot = undefined;
    }
    this.subscriptions.clear();
  }

  private usePolling(subscription: Subscription): void {
    if (!subscription.active || this.disposed || subscription.snapshot) {
      return;
    }

    this.closeNativeWatcher(subscription);
    subscription.snapshot = snapshotFilesSync(subscription.query);
    this.activity += 1;
  }

  private closeNativeWatcher(subscription: Subscription): void {
    const watcher = subscription.watcher;
    if (!watcher) {
      return;
    }
    subscription.watcher = undefined;
    watcher.close();
  }

  private async poll(subscription: Subscription): Promise<void> {
    const previous = subscription.snapshot;
    if (!subscription.active || !previous || this.disposed) {
      return;
    }

    const current = await snapshotFiles(subscription.query);
    if (!subscription.active || this.disposed) {
      return;
    }
    subscription.snapshot = current;

    const paths = Array.from(new Set([...previous.keys(), ...current.keys()])).sort();
    for (const filePath of paths) {
      const before = previous.get(filePath);
      const after = current.get(filePath);
      const kind = changedFileKind(before, after);
      if (!kind) {
        continue;
      }

      this.activity += 1;
      this.enqueue(filePath, async () => {
        if (subscription.active && !this.disposed) {
          await subscription.onChange({ filePath, kind });
        }
      });
    }
  }

  private enqueue(filePath: string, operation: () => Promise<void>): void {
    const previous = this.pendingByFile.get(filePath) ?? Promise.resolve();
    const pending = previous
      .then(operation)
      .catch((error) => {
        this.logger.error(`A watched-file listener failed for ${filePath}`, error as Error);
      })
      .finally(() => {
        this.pending.delete(pending);
        if (this.pendingByFile.get(filePath) === pending) {
          this.pendingByFile.delete(filePath);
        }
      });
    this.pendingByFile.set(filePath, pending);
    this.pending.add(pending);
  }
}

/** A rename event means create or delete; existence distinguishes the two. */
async function fileChangeKind(eventType: string, filePath: string): Promise<FileChangeKind> {
  if (eventType === "change") {
    return "change";
  }
  try {
    await fs.promises.access(filePath);
    return "create";
  } catch {
    return "delete";
  }
}

function quietWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WATCH_QUIET_MS));
}

function snapshotFilesSync(query: FileWatchQuery): FileSnapshot {
  const snapshot: FileSnapshot = new Map();
  collectFilesSync(query.root, query, snapshot);
  return snapshot;
}

function collectFilesSync(directory: string, query: FileWatchQuery, snapshot: FileSnapshot): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (query.recursive && !isExcludedPollingDirectory(query, entry.name)) {
        collectFilesSync(entryPath, query, snapshot);
      }
    } else if (entry.isFile() && matchesWatch(query, entryPath)) {
      try {
        snapshot.set(entryPath, fileIdentity(fs.statSync(entryPath)));
      } catch {
        // A file removed during the walk belongs to the next synchronization.
      }
    }
  }
}

async function snapshotFiles(query: FileWatchQuery): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  await collectFiles(query.root, query, snapshot);
  return snapshot;
}

async function collectFiles(directory: string, query: FileWatchQuery, snapshot: FileSnapshot): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (query.recursive && !isExcludedPollingDirectory(query, entry.name)) {
        await collectFiles(entryPath, query, snapshot);
      }
    } else if (entry.isFile() && matchesWatch(query, entryPath)) {
      try {
        snapshot.set(entryPath, fileIdentity(await fs.promises.stat(entryPath)));
      } catch {
        // A file removed during the walk belongs to the next synchronization.
      }
    }
  }
}

function isExcludedPollingDirectory(query: FileWatchQuery, directoryName: string): boolean {
  if (!(query.extensions ?? []).includes(".ts") || (query.fileNames?.length ?? 0) > 0) {
    return false;
  }
  return directoryName.startsWith(".") || POLLING_EXCLUDED_DIRECTORIES.has(directoryName);
}

function fileIdentity(stats: fs.Stats): string {
  return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`;
}

function changedFileKind(before: string | undefined, after: string | undefined): FileChangeKind | undefined {
  if (before === undefined) {
    return after === undefined ? undefined : "create";
  }
  if (after === undefined) {
    return "delete";
  }
  return before === after ? undefined : "change";
}
