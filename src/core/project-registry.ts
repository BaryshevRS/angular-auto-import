/**
 * Lazy, root-keyed Angular project initialization shared by the Extension Host
 * and the language server. Documents arrive as plain descriptors so the registry
 * works with `TextDocument`s from either runtime.
 * @module
 */

import * as path from "node:path";

/** Returns whether candidatePath is rootPath itself or one of its descendants. */
export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relativePath === "" ||
    (!path.isAbsolute(relativePath) && !relativePath.startsWith(`..${path.sep}`) && relativePath !== "..")
  );
}

/** Finds the most specific known project root containing a document. */
export function findDeepestContainingProjectRoot(filePath: string, roots: Iterable<string>): string | undefined {
  let deepestRoot: string | undefined;

  for (const root of roots) {
    const normalizedRoot = path.resolve(root);
    if (
      isPathInside(normalizedRoot, filePath) &&
      (deepestRoot === undefined || normalizedRoot.length > deepestRoot.length)
    ) {
      deepestRoot = normalizedRoot;
    }
  }

  return deepestRoot;
}

/**
 * Finds the entry of the most specific root containing a file.
 * @param filePath Absolute path of the file to route.
 * @param contexts Per-root values keyed by the root path.
 */
export function findDeepestContainingEntry<T>(
  filePath: string,
  contexts: ReadonlyMap<string, T>
): [string, T] | undefined {
  const normalizedFilePath = path.resolve(filePath);
  let deepestEntry: [string, T] | undefined;

  for (const [rootPath, context] of contexts) {
    const normalizedRoot = path.resolve(rootPath);
    if (
      isPathInside(normalizedRoot, normalizedFilePath) &&
      (!deepestEntry || normalizedRoot.length > deepestEntry[0].length)
    ) {
      deepestEntry = [normalizedRoot, context];
    }
  }

  return deepestEntry;
}

/** Returns the value belonging to the deepest root that contains filePath. */
export function findDeepestContainingProjectContext<T>(
  filePath: string,
  contexts: ReadonlyMap<string, T>
): T | undefined {
  return findDeepestContainingEntry(filePath, contexts)?.[1];
}

/** The subset of a text document the registry needs to route it to a project root. */
export type RegistryDocument = {
  uri: { scheme: string; fsPath: string };
  languageId: string;
};

/** Supplies the documents that drive lazy project initialization. */
export type RegistryDocumentSource = {
  openDocuments: Iterable<RegistryDocument>;
  initialRoots?: Iterable<string>;
  onDidOpenDocument(listener: (document: RegistryDocument) => void): { dispose(): void };
};

export type ProjectRegistryOptions = {
  workspaceRoots: Iterable<string>;
  discoverAngularRoot(filePath: string, searchBoundary: string): Promise<string | undefined>;
  initializeRoot(rootPath: string): Promise<void>;
  /** Called once, after the first root initializes. Runtimes without providers may omit it. */
  registerProviders?(): void;
  onDidInitializeRoot?(rootPath: string): void;
  onError?(error: unknown): void;
};

/** Coordinates lazy, root-keyed Angular project initialization. */
export class ProjectRegistry {
  private workspaceRoots: string[];
  private readonly initializedRoots = new Set<string>();
  private readonly initializingRoots = new Map<string, Promise<void>>();
  private readonly discoverAngularRoot: ProjectRegistryOptions["discoverAngularRoot"];
  private readonly initializeRoot: ProjectRegistryOptions["initializeRoot"];
  private readonly registerProviders: ProjectRegistryOptions["registerProviders"];
  private readonly onDidInitializeRoot: ProjectRegistryOptions["onDidInitializeRoot"];
  private readonly onError: ProjectRegistryOptions["onError"];
  private documentSubscription: { dispose(): void } | undefined;
  private providersRegistered = false;
  private disposed = false;

  constructor(options: ProjectRegistryOptions) {
    this.workspaceRoots = Array.from(options.workspaceRoots, (root) => path.resolve(root));
    this.discoverAngularRoot = options.discoverAngularRoot;
    this.initializeRoot = options.initializeRoot;
    this.registerProviders = options.registerProviders;
    this.onDidInitializeRoot = options.onDidInitializeRoot;
    this.onError = options.onError;
  }

  async start(source: RegistryDocumentSource): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.documentSubscription?.dispose();
    this.documentSubscription = source.onDidOpenDocument((document) => {
      void this.handleDocument(document).catch((error) => {
        try {
          this.onError?.(error);
        } catch {
          // Event callbacks must never create an unhandled rejection.
        }
      });
    });
    const initialRootDocuments = Array.from(
      source.initialRoots ?? [],
      (rootPath): RegistryDocument => ({
        uri: { scheme: "file", fsPath: rootPath },
        languageId: "typescript",
      })
    );
    await Promise.all([
      ...Array.from(source.openDocuments, (document) => this.handleDocument(document)),
      ...initialRootDocuments.map((document) => this.handleDocument(document)),
    ]);
  }

  /**
   * Replaces the boundaries discovery searches within, for a host whose workspace
   * folders change while it runs. Roots that already initialized stay initialized.
   * @param roots The workspace roots known now.
   */
  setWorkspaceRoots(roots: Iterable<string>): void {
    this.workspaceRoots = Array.from(roots, (root) => path.resolve(root));
  }

  /**
   * Forgets an initialized root so a later document can initialize it again. Callers
   * are responsible for releasing whatever `initializeRoot` created for it.
   * @param rootPath The root to forget.
   */
  forgetRoot(rootPath: string): void {
    this.initializedRoots.delete(path.resolve(rootPath));
  }

  async handleDocument(document: RegistryDocument): Promise<void> {
    if (this.disposed || document.uri.scheme !== "file" || !["typescript", "html"].includes(document.languageId)) {
      return;
    }

    const filePath = path.resolve(document.uri.fsPath);
    if (filePath.split(path.sep).includes("node_modules")) {
      return;
    }

    const boundary = findDeepestContainingProjectRoot(filePath, this.workspaceRoots);
    if (!boundary) {
      return;
    }

    const discoveredRoot = await this.discoverAngularRoot(filePath, boundary);
    if (!discoveredRoot) {
      return;
    }

    const root = path.resolve(discoveredRoot);
    if (this.initializedRoots.has(root)) {
      this.ensureProvidersRegistered();
      return;
    }

    const existingInitialization = this.initializingRoots.get(root);
    if (existingInitialization) {
      await existingInitialization;
      return;
    }

    const initialization = this.initializeRoot(root).then(() => {
      if (this.disposed) {
        return;
      }
      this.initializedRoots.add(root);
      this.onDidInitializeRoot?.(root);
      this.ensureProvidersRegistered();
    });
    this.initializingRoots.set(root, initialization);

    try {
      await initialization;
    } finally {
      this.initializingRoots.delete(root);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.documentSubscription?.dispose();
    this.documentSubscription = undefined;
  }

  private ensureProvidersRegistered(): void {
    if (this.disposed || this.providersRegistered) {
      return;
    }
    this.registerProviders?.();
    this.providersRegistered = true;
  }
}
