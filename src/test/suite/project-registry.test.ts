import * as assert from "node:assert";
import * as path from "node:path";
import { ProjectRegistry, type RegistryDocument, type RegistryDocumentSource } from "../../core/project-registry";

function document(filePath: string, languageId = "typescript", scheme = "file"): RegistryDocument {
  return {
    uri: { scheme, fsPath: filePath },
    languageId,
  };
}

function createDocumentSource(openDocuments: Iterable<RegistryDocument> = []): {
  source: RegistryDocumentSource;
  emit(documentToOpen: RegistryDocument): void;
  getSubscriptionCount(): number;
  getDisposeCount(): number;
} {
  let listener: ((openedDocument: RegistryDocument) => void) | undefined;
  let subscriptionCount = 0;
  let disposeCount = 0;

  return {
    source: {
      openDocuments,
      onDidOpenDocument(nextListener) {
        listener = nextListener;
        subscriptionCount += 1;
        return {
          dispose() {
            disposeCount += 1;
            listener = undefined;
          },
        };
      },
    },
    emit(documentToOpen) {
      listener?.(documentToOpen);
    },
    getSubscriptionCount: () => subscriptionCount,
    getDisposeCount: () => disposeCount,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

describe("ProjectRegistry lazy lifecycle", function () {
  this.timeout(10000);

  const workspaceRoot = path.join(path.sep, "workspace");
  const nestedRoot = path.join(workspaceRoot, "apps", "storefront");
  const nestedDocumentPath = path.join(nestedRoot, "src", "app.component.ts");

  it("keeps a lightweight open-document listener in a non-Angular workspace", async () => {
    const initializedRoots: string[] = [];
    const source = createDocumentSource();
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async () => undefined,
      initializeRoot: async (rootPath) => {
        initializedRoots.push(rootPath);
      },
      registerProviders: () => assert.fail("Providers must not register before an Angular root is found"),
    });

    await registry.start(source.source);

    assert.strictEqual(source.getSubscriptionCount(), 1, "Nested Angular projects must remain discoverable later");
    assert.deepStrictEqual(initializedRoots, []);

    registry.dispose();
    assert.strictEqual(source.getDisposeCount(), 1);
  });

  it("initializes a nested Angular root found from an already-open document", async () => {
    const initializedRoots: string[] = [];
    let providerRegistrations = 0;
    const source = createDocumentSource([document(nestedDocumentPath)]);
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async (filePath, boundary) => {
        assert.strictEqual(filePath, nestedDocumentPath);
        assert.strictEqual(boundary, workspaceRoot);
        return nestedRoot;
      },
      initializeRoot: async (rootPath) => {
        initializedRoots.push(rootPath);
      },
      registerProviders: () => {
        providerRegistrations += 1;
      },
    });

    await registry.start(source.source);

    assert.deepStrictEqual(initializedRoots, [nestedRoot]);
    assert.strictEqual(providerRegistrations, 1);
    assert.strictEqual(source.getSubscriptionCount(), 1);
  });

  it("creates exactly one root-keyed indexer for each of two sibling Angular roots", async () => {
    const legacyRoot = path.join(workspaceRoot, "apps", "legacy");
    const modernRoot = path.join(workspaceRoot, "apps", "modern");
    const legacyDocument = document(path.join(legacyRoot, "src", "legacy.component.ts"));
    const modernDocument = document(path.join(modernRoot, "src", "modern.component.html"), "html");
    const initializedRoots: string[] = [];
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async (filePath) => (filePath.startsWith(legacyRoot) ? legacyRoot : modernRoot),
      initializeRoot: async (rootPath) => {
        initializedRoots.push(rootPath);
      },
      registerProviders: () => undefined,
    });

    await registry.handleDocument(legacyDocument);
    await registry.handleDocument(modernDocument);
    await registry.handleDocument(legacyDocument);

    assert.deepStrictEqual(initializedRoots.sort(), [legacyRoot, modernRoot].sort());
  });

  it("deduplicates concurrent initialization requests for the same discovered root", async () => {
    const initializationGate = deferred();
    let initializationCount = 0;
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async () => nestedRoot,
      initializeRoot: async () => {
        initializationCount += 1;
        await initializationGate.promise;
      },
      registerProviders: () => undefined,
    });

    const firstOpen = registry.handleDocument(document(nestedDocumentPath));
    const secondOpen = registry.handleDocument(document(path.join(nestedRoot, "src", "other.component.html"), "html"));
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(initializationCount, 1, "The in-flight initialization promise must be shared by root");

    initializationGate.resolve();
    await Promise.all([firstOpen, secondOpen]);
    assert.strictEqual(initializationCount, 1);
  });

  it("does not initialize for non-file, non-TypeScript/HTML, node_modules, or outside-workspace documents", async () => {
    const ignoredDocuments = [
      document(nestedDocumentPath, "typescript", "untitled"),
      document(path.join(nestedRoot, "src", "styles.css"), "css"),
      document(path.join(workspaceRoot, "node_modules", "library", "index.ts")),
      document(path.join(path.sep, "other-workspace", "app", "src", "main.ts")),
    ];
    let discoveryCount = 0;
    let initializationCount = 0;
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async () => {
        discoveryCount += 1;
        return nestedRoot;
      },
      initializeRoot: async () => {
        initializationCount += 1;
      },
      registerProviders: () => undefined,
    });

    for (const ignoredDocument of ignoredDocuments) {
      await registry.handleDocument(ignoredDocument);
    }

    assert.strictEqual(discoveryCount, 0, "Ignored documents should be rejected before filesystem discovery");
    assert.strictEqual(initializationCount, 0);
  });

  it("registers providers once after the first Angular root initializes", async () => {
    const firstRoot = path.join(workspaceRoot, "apps", "first");
    const secondRoot = path.join(workspaceRoot, "apps", "second");
    let providerRegistrations = 0;
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async (filePath) =>
        filePath.includes(`${path.sep}first${path.sep}`) ? firstRoot : secondRoot,
      initializeRoot: async () => undefined,
      registerProviders: () => {
        providerRegistrations += 1;
      },
    });

    await registry.handleDocument(document(path.join(firstRoot, "src", "main.ts")));
    await registry.handleDocument(document(path.join(secondRoot, "src", "main.ts")));
    await registry.handleDocument(document(path.join(firstRoot, "src", "other.component.html"), "html"));

    assert.strictEqual(providerRegistrations, 1);
  });

  it("retries a root after initializeRoot rejects instead of marking it initialized", async () => {
    let initializationAttempts = 0;
    let providerRegistrations = 0;
    const initializedRoots: string[] = [];
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async () => nestedRoot,
      initializeRoot: async () => {
        initializationAttempts += 1;
        if (initializationAttempts === 1) {
          throw new Error("initial indexing failed");
        }
      },
      registerProviders: () => {
        providerRegistrations += 1;
      },
      onDidInitializeRoot: (rootPath) => {
        initializedRoots.push(rootPath);
      },
    });

    await assert.rejects(registry.handleDocument(document(nestedDocumentPath)), /initial indexing failed/);
    await registry.handleDocument(document(nestedDocumentPath));

    assert.strictEqual(initializationAttempts, 2, "A rejected root initialization must remain retryable");
    assert.strictEqual(providerRegistrations, 1, "Providers register only after successful initialization");
    assert.deepStrictEqual(initializedRoots, [nestedRoot]);
  });

  it("retries provider registration after it throws without leaving registered state inconsistent", async () => {
    let initializationAttempts = 0;
    let providerRegistrationAttempts = 0;
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async () => nestedRoot,
      initializeRoot: async () => {
        initializationAttempts += 1;
      },
      registerProviders: () => {
        providerRegistrationAttempts += 1;
        if (providerRegistrationAttempts === 1) {
          throw new Error("provider registration failed");
        }
      },
    });

    await assert.rejects(registry.handleDocument(document(nestedDocumentPath)), /provider registration failed/);
    await registry.handleDocument(document(nestedDocumentPath));
    await registry.handleDocument(document(nestedDocumentPath));

    assert.strictEqual(
      providerRegistrationAttempts,
      2,
      "Provider registration must retry once and then remain registered"
    );
    assert.ok(
      initializationAttempts === 1 || initializationAttempts === 2,
      "The registry may retain or rebuild the initialized root, but it must not initialize it repeatedly"
    );
  });

  it("does not register providers or publish the root when disposed during deferred initialization", async () => {
    const initializationGate = deferred();
    let providerRegistrations = 0;
    const initializedRoots: string[] = [];
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async () => nestedRoot,
      initializeRoot: async () => initializationGate.promise,
      registerProviders: () => {
        providerRegistrations += 1;
      },
      onDidInitializeRoot: (rootPath) => {
        initializedRoots.push(rootPath);
      },
    });

    const opening = registry.handleDocument(document(nestedDocumentPath));
    await Promise.resolve();
    await Promise.resolve();
    registry.dispose();
    initializationGate.resolve();
    await opening;

    assert.strictEqual(providerRegistrations, 0);
    assert.deepStrictEqual(initializedRoots, []);
  });

  it("reports discovery rejection from the open-document event without an unhandled rejection", async () => {
    const source = createDocumentSource();
    const reportedErrors: unknown[] = [];
    let unhandledRejection: unknown;
    const onUnhandledRejection = (error: unknown) => {
      unhandledRejection = error;
    };
    process.once("unhandledRejection", onUnhandledRejection);
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async () => {
        throw new Error("discovery failed");
      },
      initializeRoot: async () => undefined,
      registerProviders: () => undefined,
      onError: (error) => {
        reportedErrors.push(error);
      },
    });

    try {
      await registry.start(source.source);
      source.emit(document(nestedDocumentPath));
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(reportedErrors.length, 1);
      assert.match(String(reportedErrors[0]), /discovery failed/);
      assert.strictEqual(unhandledRejection, undefined);
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
      registry.dispose();
    }
  });

  it("reports initializeRoot rejection from the open-document event without an unhandled rejection", async () => {
    const source = createDocumentSource();
    const reportedErrors: unknown[] = [];
    let unhandledRejection: unknown;
    const onUnhandledRejection = (error: unknown) => {
      unhandledRejection = error;
    };
    process.once("unhandledRejection", onUnhandledRejection);
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async () => nestedRoot,
      initializeRoot: async () => {
        throw new Error("index initialization failed");
      },
      registerProviders: () => undefined,
      onError: (error) => {
        reportedErrors.push(error);
      },
    });

    try {
      await registry.start(source.source);
      source.emit(document(nestedDocumentPath));
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(reportedErrors.length, 1);
      assert.match(String(reportedErrors[0]), /index initialization failed/);
      assert.strictEqual(unhandledRejection, undefined);
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
      registry.dispose();
    }
  });

  it("calls onDidInitializeRoot once for every newly initialized root", async () => {
    const firstRoot = path.join(workspaceRoot, "apps", "first");
    const secondRoot = path.join(workspaceRoot, "apps", "second");
    const initializedRoots: string[] = [];
    const registry = new ProjectRegistry({
      workspaceRoots: [workspaceRoot],
      discoverAngularRoot: async (filePath) =>
        filePath.includes(`${path.sep}first${path.sep}`) ? firstRoot : secondRoot,
      initializeRoot: async () => undefined,
      registerProviders: () => undefined,
      onDidInitializeRoot: (rootPath) => {
        initializedRoots.push(rootPath);
      },
    });

    await registry.handleDocument(document(path.join(firstRoot, "src", "main.ts")));
    await registry.handleDocument(document(path.join(secondRoot, "src", "main.ts")));
    await registry.handleDocument(document(path.join(firstRoot, "src", "other.ts")));

    assert.deepStrictEqual(initializedRoots, [firstRoot, secondRoot]);
  });
});
