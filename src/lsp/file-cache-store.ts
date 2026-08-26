/**
 * The server's persistent cache: one JSON file per project root.
 *
 * The Extension Host persists its index in `workspaceState`; the server has no
 * memento, so it writes under the storage directory the client hands it at
 * `initialize`. Reads are synchronous because {@link CacheStore} is, so the whole
 * file is loaded once when the store is opened.
 *
 * A cache is only reused when its schema version *and* its fingerprint still match,
 * which is what keeps a stale index from surviving an Angular upgrade or a project
 * move. A mismatch is not an error: the store starts empty and the caller reindexes.
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { CacheStore } from "../core/cache";
import { type CoreLogger, silentLogger } from "../core/logging";

/**
 * Bumped whenever the persisted shape changes in a way older files cannot satisfy.
 *
 * 2: a module's exports are stored per path it is imported from. Version 1 recorded one
 * set per module name, so two libraries declaring a module of the same name overwrote
 * each other — the loser is not recoverable from the file, which is why this is a
 * version bump and not a migration.
 *
 * 3: where each of those exports came from is stored per name as a list, since a module
 * can re-export two modules that share a class name.
 *
 * 4: what a library's bundles hold — the arrays a name in `imports: [...]` can stand for
 * — is read while indexing and stored with the rest.
 *
 * 5: the indexed elements are a list rather than a map keyed by selector, since two
 * directives can declare the same selector and the map kept only one of them.
 */
export const CACHE_SCHEMA_VERSION = 5;

/** What a cached file must still agree with to be reused. */
export type CacheFingerprint = Record<string, string>;

export interface FileCacheStoreOptions {
  /** Directory the client set aside for this workspace's caches. */
  directory: string;
  /** Absolute path of the project root this cache belongs to. */
  rootPath: string;
  /**
   * Identity the cache is only valid for, such as the installed Angular version.
   *
   * Read when the cache is opened rather than when it is built, so a store may be
   * created before everything it identifies is known — a project's alias roots come
   * from a `tsconfig.json` that is parsed after its runtime exists.
   */
  fingerprint?: CacheFingerprint | (() => CacheFingerprint);
  logger?: CoreLogger;
}

interface CacheFile {
  schemaVersion: number;
  rootPath: string;
  fingerprint: CacheFingerprint;
  entries: Record<string, unknown>;
}

/** A project's persisted index, kept in memory and mirrored to one file. */
export class FileCacheStore implements CacheStore {
  private readonly filePath: string;
  private readonly rootPath: string;
  private readonly readFingerprint: () => CacheFingerprint;
  private readonly logger: CoreLogger;
  private entries: Record<string, unknown> = {};
  /** Serializes writes so two saves cannot interleave on the same file. */
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(options: FileCacheStoreOptions) {
    this.rootPath = options.rootPath;
    const fingerprint = options.fingerprint ?? {};
    this.readFingerprint = typeof fingerprint === "function" ? fingerprint : () => fingerprint;
    this.logger = options.logger ?? silentLogger;
    this.filePath = path.join(options.directory, `${cacheFileName(options.rootPath)}.json`);
  }

  /** Where this project's cache is written. */
  get location(): string {
    return this.filePath;
  }

  /**
   * Loads the cached entries, or starts empty when there is nothing usable to load.
   * @returns Whether a matching cache was found and loaded.
   */
  async open(): Promise<boolean> {
    const file = await this.readCacheFile();
    if (!file) {
      return false;
    }

    if (file.schemaVersion !== CACHE_SCHEMA_VERSION) {
      this.logger.info(`Discarding cache for ${this.rootPath}: schema ${file.schemaVersion} is no longer supported`);
      return false;
    }
    if (file.rootPath !== this.rootPath || !fingerprintsMatch(file.fingerprint, this.readFingerprint())) {
      this.logger.info(`Discarding cache for ${this.rootPath}: it was written for a different project state`);
      return false;
    }

    this.entries = file.entries;
    return true;
  }

  get<T>(key: string): T | undefined {
    return this.entries[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.entries[key] = value;
    await this.flush();
  }

  async delete(key: string): Promise<void> {
    if (!(key in this.entries)) {
      return;
    }
    this.entries = Object.fromEntries(Object.entries(this.entries).filter(([entryKey]) => entryKey !== key));
    await this.flush();
  }

  /** Drops every entry, in memory and on disk. */
  async clear(): Promise<void> {
    this.entries = {};
    await this.flush();
  }

  /**
   * Reads and parses the cache file, treating anything unreadable as absent.
   * @internal
   */
  private async readCacheFile(): Promise<CacheFile | undefined> {
    let contents: string;
    try {
      contents = await fs.promises.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(`Could not read the cache at ${this.filePath}: ${(error as Error).message}`);
      }
      return undefined;
    }

    try {
      const parsed = JSON.parse(contents);
      return isCacheFile(parsed) ? parsed : undefined;
    } catch {
      this.logger.warn(`Discarding the unreadable cache file at ${this.filePath}`);
      return undefined;
    }
  }

  /**
   * Writes the current entries through a temporary file, so a crash mid-write leaves
   * the previous cache intact rather than a truncated one.
   * @internal
   */
  private flush(): Promise<void> {
    const file: CacheFile = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      rootPath: this.rootPath,
      fingerprint: this.readFingerprint(),
      entries: this.entries,
    };

    this.pendingWrite = this.pendingWrite.then(async () => {
      const temporaryPath = `${this.filePath}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.promises.writeFile(temporaryPath, JSON.stringify(file), "utf8");
        await fs.promises.rename(temporaryPath, this.filePath);
      } catch (error) {
        this.logger.error(`Could not write the cache at ${this.filePath}`, error as Error);
      }
    });

    return this.pendingWrite;
  }
}

/**
 * Builds a stable, filesystem-safe name for a project root.
 * @internal
 */
function cacheFileName(rootPath: string): string {
  const readable = path.basename(rootPath).replace(/[^a-zA-Z0-9_-]/g, "_") || "project";
  return `${readable}-${hashPath(rootPath)}`;
}

/**
 * The same 32-bit string hash the workspace-state cache keys use.
 * @internal
 */
function hashPath(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/** @internal */
function fingerprintsMatch(stored: CacheFingerprint, expected: CacheFingerprint): boolean {
  const storedKeys = Object.keys(stored);
  const expectedKeys = Object.keys(expected);
  return storedKeys.length === expectedKeys.length && expectedKeys.every((key) => stored[key] === expected[key]);
}

/** @internal */
function isCacheFile(value: unknown): value is CacheFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CacheFile>;
  return (
    typeof candidate.schemaVersion === "number" &&
    typeof candidate.rootPath === "string" &&
    typeof candidate.fingerprint === "object" &&
    candidate.fingerprint !== null &&
    typeof candidate.entries === "object" &&
    candidate.entries !== null
  );
}
