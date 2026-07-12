import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import * as extensionModule from "../../extension";

type RegistryDocument = Pick<vscode.TextDocument, "languageId" | "uri">;

type RegistryDocumentSource = {
  openDocuments: Iterable<RegistryDocument>;
  onDidOpenDocument(listener: (document: RegistryDocument) => void): vscode.Disposable;
};

type RegistryOptions = {
  workspaceRoots: Iterable<string>;
  discoverAngularRoot(filePath: string, searchBoundary: string): Promise<string | undefined>;
  initializeRoot(rootPath: string): Promise<void>;
  registerProviders(): void;
};

type Registry = vscode.Disposable & {
  start(source: RegistryDocumentSource): Promise<void>;
};

type ActivationDependencies = {
  createProjectRegistry(options: RegistryOptions): Registry;
};

type ActivateWithDependencies = (
  context: vscode.ExtensionContext,
  dependencies?: ActivationDependencies
) => Promise<void>;

type FindDeepestContext = <T>(filePath: string, contexts: ReadonlyMap<string, T>) => T | undefined;

const activate = extensionModule.activate as unknown as ActivateWithDependencies;
const { findDeepestContainingProjectContext } = extensionModule as unknown as {
  findDeepestContainingProjectContext: FindDeepestContext;
};

function createExtensionContext(subscriptions: vscode.Disposable[]): vscode.ExtensionContext {
  return {
    subscriptions,
    // biome-ignore lint/style/useNamingConvention: VS Code API property name.
    extension: { packageJSON: { version: "test" } },
  } as unknown as vscode.ExtensionContext;
}

function fakeDocument(filePath: string, languageId = "typescript"): RegistryDocument {
  return {
    uri: vscode.Uri.file(filePath),
    languageId,
  };
}

async function withWorkspace(
  workspaceRoot: string,
  openDocuments: RegistryDocument[],
  callback: () => Promise<void>
): Promise<void> {
  const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
  const originalTextDocuments = vscode.workspace.textDocuments;

  Object.defineProperty(vscode.workspace, "workspaceFolders", {
    configurable: true,
    get: () => [{ uri: vscode.Uri.file(workspaceRoot), name: path.basename(workspaceRoot), index: 0 }],
  });
  Object.defineProperty(vscode.workspace, "textDocuments", {
    configurable: true,
    get: () => openDocuments,
  });

  try {
    await callback();
  } finally {
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      get: () => originalWorkspaceFolders,
    });
    Object.defineProperty(vscode.workspace, "textDocuments", {
      configurable: true,
      get: () => originalTextDocuments,
    });
  }
}

async function withWorkspaceFeatureRegistrationSpies(callback: (getRegistrationCount: () => number) => Promise<void>) {
  const commandApi = vscode.commands as unknown as {
    registerCommand: typeof vscode.commands.registerCommand;
  };
  const languageApi = vscode.languages as unknown as {
    registerCodeActionsProvider: typeof vscode.languages.registerCodeActionsProvider;
    registerCompletionItemProvider: typeof vscode.languages.registerCompletionItemProvider;
  };
  const originalRegisterCommand = commandApi.registerCommand;
  const originalRegisterCodeActionsProvider = languageApi.registerCodeActionsProvider;
  const originalRegisterCompletionItemProvider = languageApi.registerCompletionItemProvider;
  let registrationCount = 0;
  const disposable = {
    dispose() {
      // Registration spies do not own resources.
    },
  };

  commandApi.registerCommand = (() => {
    registrationCount += 1;
    return disposable;
  }) as typeof vscode.commands.registerCommand;
  languageApi.registerCodeActionsProvider = (() => {
    registrationCount += 1;
    return disposable;
  }) as typeof vscode.languages.registerCodeActionsProvider;
  languageApi.registerCompletionItemProvider = (() => {
    registrationCount += 1;
    return disposable;
  }) as typeof vscode.languages.registerCompletionItemProvider;

  try {
    await callback(() => registrationCount);
  } finally {
    commandApi.registerCommand = originalRegisterCommand;
    languageApi.registerCodeActionsProvider = originalRegisterCodeActionsProvider;
    languageApi.registerCompletionItemProvider = originalRegisterCompletionItemProvider;
  }
}

describe("extension activation lifecycle", function () {
  this.timeout(10000);

  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-activation-"));
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("keeps only lightweight lifecycle/configuration wiring in a non-Angular workspace", async () => {
    const subscriptions: vscode.Disposable[] = [];
    let factoryCalls = 0;
    let starts = 0;
    let capturedOptions: RegistryOptions | undefined;
    const fakeRegistry: Registry = {
      async start() {
        starts += 1;
      },
      dispose() {
        // The fake registry does not own resources.
      },
    };

    await withWorkspaceFeatureRegistrationSpies(async (getRegistrationCount) => {
      await withWorkspace(sandbox, [], async () => {
        await activate(createExtensionContext(subscriptions), {
          createProjectRegistry(options) {
            factoryCalls += 1;
            capturedOptions = options;
            return fakeRegistry;
          },
        });
      });

      assert.strictEqual(getRegistrationCount(), 0, "Language providers and commands must remain unregistered");
    });

    assert.strictEqual(factoryCalls, 1, "Activation must instantiate the lazy project registry");
    assert.strictEqual(starts, 1, "Activation must start document discovery even before Angular is found");
    assert.ok(capturedOptions, "Activation must wire registry dependencies");
    assert.ok(
      subscriptions.length > 0,
      "Lifecycle/configuration disposables must be retained by the extension context"
    );
    assert.ok(
      subscriptions.every((subscription) => typeof subscription.dispose === "function"),
      "Only lightweight disposables should be registered"
    );
  });

  it("passes already-open TS/HTML documents to a registry wired for nested-root discovery", async () => {
    const nestedRoot = path.join(sandbox, "packages", "nested-app");
    const typescriptPath = path.join(nestedRoot, "src", "app.component.ts");
    const htmlPath = path.join(nestedRoot, "src", "app.component.html");
    await fs.mkdir(path.dirname(typescriptPath), { recursive: true });
    await fs.writeFile(
      path.join(nestedRoot, "package.json"),
      JSON.stringify({ dependencies: { "@angular/core": "^21.0.0" } }),
      "utf8"
    );
    await fs.writeFile(typescriptPath, "export class AppComponent {}\n", "utf8");
    await fs.writeFile(htmlPath, "<main>App</main>\n", "utf8");

    const openDocuments = [fakeDocument(typescriptPath), fakeDocument(htmlPath, "html")];
    let capturedOptions: RegistryOptions | undefined;
    let capturedSource: RegistryDocumentSource | undefined;
    const fakeRegistry: Registry = {
      async start(source) {
        capturedSource = source;
      },
      dispose() {
        // The fake registry does not own resources.
      },
    };

    await withWorkspace(sandbox, openDocuments, async () => {
      await activate(createExtensionContext([]), {
        createProjectRegistry(options) {
          capturedOptions = options;
          return fakeRegistry;
        },
      });
    });

    assert.ok(capturedOptions, "Activation must instantiate and configure ProjectRegistry");
    assert.ok(capturedSource, "Activation must start ProjectRegistry with the VS Code document source");
    assert.deepStrictEqual(Array.from(capturedSource.openDocuments), openDocuments);
    assert.strictEqual(
      await capturedOptions.discoverAngularRoot(typescriptPath, sandbox),
      nestedRoot,
      "The registry must receive the real nested Angular dependency-root discovery helper"
    );
  });
});

describe("findDeepestContainingProjectContext", () => {
  it("returns the nested indexer instead of an existing workspace-root indexer", () => {
    const workspaceRoot = path.join(path.sep, "workspace");
    const nestedRoot = path.join(workspaceRoot, "apps", "storefront");
    const workspaceIndexer = { name: "workspace" };
    const nestedIndexer = { name: "nested" };
    const indexers = new Map([
      [workspaceRoot, workspaceIndexer],
      [nestedRoot, nestedIndexer],
    ]);

    assert.strictEqual(
      findDeepestContainingProjectContext(path.join(nestedRoot, "src", "app.component.ts"), indexers),
      nestedIndexer
    );
  });

  it("uses boundary-safe matching for sibling roots with shared prefixes", () => {
    const workspaceRoot = path.join(path.sep, "workspace");
    const appIndexer = { name: "app" };
    const appOldIndexer = { name: "app-old" };
    const appRoot = path.join(workspaceRoot, "app");
    const appOldRoot = path.join(workspaceRoot, "app-old");
    const indexers = new Map([
      [appRoot, appIndexer],
      [appOldRoot, appOldIndexer],
    ]);

    assert.strictEqual(
      findDeepestContainingProjectContext(path.join(appOldRoot, "src", "main.ts"), indexers),
      appOldIndexer
    );
  });

  it("returns undefined when no indexer contains the document", () => {
    const indexers = new Map([[path.join(path.sep, "workspace", "app"), { name: "app" }]]);
    assert.strictEqual(
      findDeepestContainingProjectContext(path.join(path.sep, "other-workspace", "main.ts"), indexers),
      undefined
    );
  });
});
