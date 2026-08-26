/**
 * Watched files, as the server sees them.
 *
 * The server cannot watch the disk itself — the client does that and reports changes
 * in one flat notification. This module is both halves of that arrangement: it asks
 * the client to watch what a project runtime subscribed to, and it routes each
 * reported change back to the subscriptions whose watch it matches.
 * @module
 */

import { pathToFileURL } from "node:url";
import { type Disposable, FileChangeType, type FileSystemWatcher, WatchKind } from "vscode-languageserver/node";
import { fileUriToPath } from "../core/document";
import {
  type FileChange,
  type FileChangeKind,
  type FileWatcherFactory,
  type FileWatchQuery,
  matchesWatch,
} from "../core/file-watching";
import { type CoreLogger, silentLogger } from "../core/logging";

/** Registers watchers with the client and resolves to the handle that removes them. */
export type WatcherRegistrar = (watchers: FileSystemWatcher[]) => Promise<Disposable>;

export interface WatchedFilesOptions {
  /** How to ask the client to watch. Omitted when the client cannot register watchers. */
  register?: WatcherRegistrar;
  logger?: CoreLogger;
}

interface Subscription {
  query: FileWatchQuery;
  onChange(change: FileChange): void;
  registration?: Disposable;
  disposed: boolean;
}

/** Turns the client's watched-file notifications into the core watching contract. */
export class WatchedFiles implements FileWatcherFactory {
  private readonly subscriptions = new Set<Subscription>();
  private readonly register: WatcherRegistrar | undefined;
  private readonly logger: CoreLogger;

  constructor(options: WatchedFilesOptions = {}) {
    this.register = options.register;
    this.logger = options.logger ?? silentLogger;
  }

  watch(query: FileWatchQuery, onChange: (change: FileChange) => void): Disposable {
    const subscription: Subscription = { query, onChange, disposed: false };
    this.subscriptions.add(subscription);
    void this.requestRegistration(subscription);

    return {
      dispose: () => {
        subscription.disposed = true;
        this.subscriptions.delete(subscription);
        subscription.registration?.dispose();
        subscription.registration = undefined;
      },
    };
  }

  /**
   * Routes one notification to every subscription that watches the reported files.
   * @param changes The changes the client reported.
   */
  dispatch(changes: readonly { uri: string; type: FileChangeType }[]): void {
    for (const { uri, type } of changes) {
      const filePath = toFilePath(uri);
      if (!filePath) {
        continue;
      }

      const change: FileChange = { filePath, kind: toChangeKind(type) };
      for (const subscription of this.subscriptions) {
        if (matchesWatch(subscription.query, filePath)) {
          this.deliver(subscription, change);
        }
      }
    }
  }

  /** The watches currently in place, in subscription order. */
  watches(): FileWatchQuery[] {
    return Array.from(this.subscriptions, (subscription) => subscription.query);
  }

  /** Removes every subscription and the registrations behind them. */
  dispose(): void {
    for (const subscription of Array.from(this.subscriptions)) {
      subscription.disposed = true;
      subscription.registration?.dispose();
    }
    this.subscriptions.clear();
  }

  /**
   * Asks the client to watch a subscription's files, keeping the handle so the watch
   * can be removed again. A subscription disposed while the request was in flight
   * removes its registration immediately.
   * @internal
   */
  private async requestRegistration(subscription: Subscription): Promise<void> {
    if (!this.register) {
      return;
    }

    try {
      const registration = await this.register([toWatcher(subscription.query)]);
      if (subscription.disposed) {
        registration.dispose();
        return;
      }
      subscription.registration = registration;
    } catch (error) {
      this.logger.error(`Could not register a file watcher for ${subscription.query.root}`, error as Error);
    }
  }

  /**
   * Hands a change to one subscription, keeping a failing listener from starving the
   * others.
   * @internal
   */
  private deliver(subscription: Subscription, change: FileChange): void {
    try {
      subscription.onChange(change);
    } catch (error) {
      this.logger.error(`A watched-file listener failed for ${change.filePath}`, error as Error);
    }
  }
}

/**
 * Describes a watch to the client. Both `RelativePattern` and plain globs are allowed
 * by the protocol; a root-relative pattern keeps the watch scoped to the project.
 * @internal
 */
export function toWatcher(query: FileWatchQuery): FileSystemWatcher {
  const names = [...(query.extensions ?? []).map((extension) => `*${extension}`), ...(query.fileNames ?? [])];
  const pattern = names.length === 1 ? names[0] : `{${names.join(",")}}`;

  return {
    globPattern: {
      baseUri: pathToFileURL(query.root).toString(),
      pattern: query.recursive ? `**/${pattern}` : pattern,
    },
    kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete,
  };
}

/** @internal */
function toChangeKind(type: FileChangeType): FileChangeKind {
  if (type === FileChangeType.Created) {
    return "create";
  }
  return type === FileChangeType.Deleted ? "delete" : "change";
}

/** @internal */
function toFilePath(uri: string): string | undefined {
  try {
    return fileUriToPath(uri);
  } catch {
    return undefined;
  }
}
