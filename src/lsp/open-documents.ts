/**
 * The documents the client has synchronized, indexed the way language features need them.
 *
 * `TextDocuments` keys everything by URI, but analysis works in filesystem paths: a
 * template's imports belong in a sibling `.ts` file that may or may not be open. This
 * module keeps the path lookup, and tracks which open documents have unsaved changes —
 * the distinction that decides whether a cached answer about a file may still be used.
 * @module
 */

import { fileUriToPath } from "../core/document";

/** The document surface this module needs, which `TextDocument` already satisfies. */
export interface SynchronizedDocument {
  uri: string;
  languageId: string;
  version: number;
  getText(): string;
}

/** The `TextDocuments` events this module listens to. */
export interface SynchronizedDocumentSource<T extends SynchronizedDocument> {
  get(uri: string): T | undefined;
  all(): T[];
  onDidOpen(listener: (event: { document: T }) => void): unknown;
  onDidSave(listener: (event: { document: T }) => void): unknown;
  onDidClose(listener: (event: { document: T }) => void): unknown;
}

/** Path-keyed access to the synchronized documents, plus their unsaved state. */
export class OpenDocuments<T extends SynchronizedDocument = SynchronizedDocument> {
  private readonly urisByPath = new Map<string, string>();
  /** The version each document was last known to match on disk at. */
  private readonly savedVersions = new Map<string, number>();

  constructor(private readonly documents: SynchronizedDocumentSource<T>) {}

  /** Starts following opens, saves, and closes. Call once, before the first request. */
  listen(): void {
    this.documents.onDidOpen(({ document }) => this.track(document));
    this.documents.onDidSave(({ document }) => this.savedVersions.set(document.uri, document.version));
    this.documents.onDidClose(({ document }) => this.forget(document));

    for (const document of this.documents.all()) {
      this.track(document);
    }
  }

  /** The open document for a filesystem path, or `undefined` when it is not open. */
  byPath(filePath: string): T | undefined {
    const uri = this.urisByPath.get(filePath);
    return uri ? this.documents.get(uri) : undefined;
  }

  /**
   * Whether an open document has changes the file on disk does not have.
   *
   * A closed document is never dirty: its text *is* what is on disk.
   * @param filePath Absolute path of the file to check.
   */
  isDirty(filePath: string): boolean {
    const document = this.byPath(filePath);
    if (!document) {
      return false;
    }
    const savedVersion = this.savedVersions.get(document.uri);
    return savedVersion === undefined || document.version > savedVersion;
  }

  /**
   * The text of a file as the user currently sees it: the open document's text when
   * there is one, and otherwise whatever the caller reads from disk.
   * @param filePath Absolute path of the file.
   * @param readFromDisk Reads the file when it is not open.
   */
  currentText(filePath: string, readFromDisk: (filePath: string) => string): { text: string; version: number | null } {
    const document = this.byPath(filePath);
    if (document) {
      return { text: document.getText(), version: document.version };
    }
    return { text: readFromDisk(filePath), version: null };
  }

  /** @internal */
  private track(document: T): void {
    const filePath = toFilePath(document.uri);
    if (!filePath) {
      return;
    }
    this.urisByPath.set(filePath, document.uri);
    // An editor only synchronizes a document it just read from disk, or one it restored
    // with unsaved changes; treating the opened version as saved matches the common case.
    this.savedVersions.set(document.uri, document.version);
  }

  /** @internal */
  private forget(document: T): void {
    const filePath = toFilePath(document.uri);
    if (filePath) {
      this.urisByPath.delete(filePath);
    }
    this.savedVersions.delete(document.uri);
  }
}

/** @internal */
function toFilePath(uri: string): string | undefined {
  try {
    return fileUriToPath(uri);
  } catch {
    return undefined;
  }
}
