/**
 * The server's view of the Angular projects in a workspace.
 *
 * Projects are discovered lazily from the documents the client synchronizes, exactly
 * as the Extension Host discovers them from opened editors. This module owns the
 * routing — which root a file belongs to — and leaves what a root *is* to its caller,
 * so the project runtime can be attached without touching discovery again.
 * @module
 */

import { fileUriToPath } from "../core/document";
import { type CoreLogger, silentLogger } from "../core/logging";
import { AngularProjectDiscovery } from "../core/project-discovery";
import { findDeepestContainingProjectRoot, ProjectRegistry, type RegistryDocument } from "../core/project-registry";

/** The document surface `TextDocuments` already provides. */
export interface ServerDocument {
  uri: string;
  languageId: string;
}

/** Supplies the documents that drive lazy discovery, satisfied by `TextDocuments`. */
export interface ServerDocumentSource {
  all(): ServerDocument[];
  onDidOpen(listener: (event: { document: ServerDocument }) => void): { dispose(): void };
}

export interface ServerProjectsOptions {
  workspaceRoots: Iterable<string>;
  /** Prepares a newly discovered root. Rejecting leaves the root retryable. */
  initializeRoot?(rootPath: string): Promise<void>;
  /** Releases whatever {@link ServerProjectsOptions.initializeRoot} created. */
  disposeRoot?(rootPath: string): void;
  discovery?: AngularProjectDiscovery;
  logger?: CoreLogger;
}

/** Discovers, tracks, and routes documents to the workspace's Angular project roots. */
export class ServerProjects {
  private readonly registry: ProjectRegistry;
  private readonly discovery: AngularProjectDiscovery;
  private readonly logger: CoreLogger;
  private readonly disposeRoot: ServerProjectsOptions["disposeRoot"];
  private readonly roots = new Set<string>();
  private workspaceRoots: string[];
  private documents: ServerDocumentSource | undefined;

  constructor(options: ServerProjectsOptions) {
    this.discovery = options.discovery ?? new AngularProjectDiscovery({ logger: options.logger });
    this.logger = options.logger ?? silentLogger;
    this.disposeRoot = options.disposeRoot;
    this.workspaceRoots = Array.from(options.workspaceRoots);
    this.registry = new ProjectRegistry({
      workspaceRoots: this.workspaceRoots,
      discoverAngularRoot: (filePath, boundary) => this.discovery.findRoot(filePath, boundary),
      initializeRoot: options.initializeRoot ?? (async () => undefined),
      onDidInitializeRoot: (rootPath) => {
        this.roots.add(rootPath);
        this.logger.info(`Angular project discovered at ${rootPath}`);
      },
      onError: (error) => {
        this.logger.error("Error discovering or initializing an Angular project", error as Error);
      },
    });
  }

  /**
   * Starts discovery from the workspace roots and the documents the client has already
   * synchronized, then keeps following the ones it opens later.
   * @param documents The server's document store.
   */
  async start(documents: ServerDocumentSource): Promise<void> {
    this.documents = documents;
    await this.registry.start({
      openDocuments: documents.all().map(toRegistryDocument),
      initialRoots: this.workspaceRoots,
      onDidOpenDocument: (listener) => documents.onDidOpen(({ document }) => listener(toRegistryDocument(document))),
    });
  }

  /**
   * Applies a workspace-folder change: roots that left the workspace are released, and
   * the remaining folders and open documents are rechecked so a project in a newly
   * added folder does not wait for its documents to be reopened.
   * @param roots The workspace roots known now.
   */
  async setWorkspaceRoots(roots: Iterable<string>): Promise<void> {
    this.workspaceRoots = Array.from(roots);
    this.registry.setWorkspaceRoots(this.workspaceRoots);

    for (const knownRoot of Array.from(this.roots)) {
      if (!findDeepestContainingProjectRoot(knownRoot, this.workspaceRoots)) {
        this.releaseRoot(knownRoot);
      }
    }

    await Promise.all([
      ...this.workspaceRoots.map((rootPath) => this.registry.handleDocument(rootDocument(rootPath))),
      ...(this.documents?.all() ?? []).map((document) => this.handleDocument(document)),
    ]);
  }

  /**
   * Routes one document through discovery.
   * @param document The document to consider.
   */
  async handleDocument(document: ServerDocument): Promise<void> {
    await this.registry.handleDocument(toRegistryDocument(document));
  }

  /**
   * The Angular root that owns a file, or `undefined` when none has been discovered.
   * Nested roots win over the workspace roots that contain them.
   * @param filePath Absolute path of the file to route.
   */
  rootForPath(filePath: string): string | undefined {
    return findDeepestContainingProjectRoot(filePath, this.roots);
  }

  /**
   * The Angular root that owns a document URI, or `undefined` for a URI that is not on
   * disk or belongs to no discovered project.
   * @param uri The document URI to route.
   */
  rootForUri(uri: string): string | undefined {
    const filePath = toFilePath(uri);
    return filePath ? this.rootForPath(filePath) : undefined;
  }

  /** The discovered Angular roots, in discovery order. */
  knownRoots(): string[] {
    return Array.from(this.roots);
  }

  /** Forgets a cached manifest check so an installed dependency becomes discoverable. */
  invalidateManifest(packageJsonPath?: string): void {
    this.discovery.invalidate(packageJsonPath);
  }

  dispose(): void {
    this.registry.dispose();
    this.documents = undefined;
    for (const rootPath of Array.from(this.roots)) {
      this.releaseRoot(rootPath);
    }
  }

  /**
   * Drops a root and whatever the caller attached to it, keeping it discoverable again.
   * @internal
   */
  private releaseRoot(rootPath: string): void {
    this.roots.delete(rootPath);
    this.registry.forgetRoot(rootPath);
    try {
      this.disposeRoot?.(rootPath);
    } catch (error) {
      this.logger.error(`Error disposing the Angular project at ${rootPath}`, error as Error);
    }
  }
}

/**
 * Converts a synchronized document into the descriptor the registry routes, keeping a
 * non-file URI recognizable so the registry still ignores it.
 * @internal
 */
function toRegistryDocument(document: ServerDocument): RegistryDocument {
  const filePath = toFilePath(document.uri);
  return {
    uri: { scheme: filePath ? "file" : "unsupported", fsPath: filePath ?? document.uri },
    languageId: document.languageId,
  };
}

/**
 * Presents a workspace folder as a document so a folder that is itself an Angular
 * project is discovered without waiting for a document in it.
 * @internal
 */
function rootDocument(rootPath: string): RegistryDocument {
  return { uri: { scheme: "file", fsPath: rootPath }, languageId: "typescript" };
}

/** @internal */
function toFilePath(uri: string): string | undefined {
  try {
    return fileUriToPath(uri);
  } catch {
    return undefined;
  }
}
