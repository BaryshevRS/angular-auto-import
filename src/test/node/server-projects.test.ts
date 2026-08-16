import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { AngularProjectDiscovery, type ManifestReader } from "../../core/project-discovery";
import { type ServerDocument, type ServerDocumentSource, ServerProjects } from "../../lsp/server-projects";

const workspaceRoot = path.join(path.sep, "workspace");
const appRoot = path.join(workspaceRoot, "apps", "shop");
const featureRoot = path.join(appRoot, "packages", "checkout");

function uriOf(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

function document(filePath: string, languageId = "typescript"): ServerDocument {
  return { uri: uriOf(filePath), languageId };
}

/** A document store shaped like `TextDocuments`, without a live connection. */
function createDocuments(open: ServerDocument[] = []): {
  source: ServerDocumentSource;
  open(document: ServerDocument): void;
  getDisposeCount(): number;
} {
  const documents = [...open];
  let listener: ((event: { document: ServerDocument }) => void) | undefined;
  let disposeCount = 0;

  return {
    source: {
      all: () => [...documents],
      onDidOpen(nextListener) {
        listener = nextListener;
        return {
          dispose() {
            disposeCount += 1;
            listener = undefined;
          },
        };
      },
    },
    open(openedDocument) {
      documents.push(openedDocument);
      listener?.({ document: openedDocument });
    },
    getDisposeCount: () => disposeCount,
  };
}

/** Discovery over an in-memory tree of manifests, so no fixture has to exist on disk. */
function createDiscovery(angularRoots: string[]): AngularProjectDiscovery {
  const roots = new Set(angularRoots.map((root) => path.resolve(root)));
  const files: ManifestReader = {
    readTextFile: async (filePath) =>
      roots.has(path.dirname(filePath)) ? JSON.stringify({ dependencies: { "@angular/core": "^22.0.0" } }) : undefined,
    isDirectory: async (filePath) => path.extname(filePath) === "",
  };
  return new AngularProjectDiscovery({ files });
}

function createProjects(options: {
  angularRoots: string[];
  workspaceRoots?: string[];
  initializeRoot?(rootPath: string): Promise<void>;
  disposeRoot?(rootPath: string): void;
}): ServerProjects {
  return new ServerProjects({
    workspaceRoots: options.workspaceRoots ?? [workspaceRoot],
    discovery: createDiscovery(options.angularRoots),
    initializeRoot: options.initializeRoot,
    disposeRoot: options.disposeRoot,
  });
}

describe("LSP server projects", () => {
  it("discovers a workspace root that is itself an Angular project", async () => {
    const projects = createProjects({ angularRoots: [workspaceRoot] });

    await projects.start(createDocuments().source);

    assert.deepStrictEqual(projects.knownRoots(), [workspaceRoot]);
  });

  it("discovers a nested project from an already-synchronized document", async () => {
    const projects = createProjects({ angularRoots: [appRoot] });

    await projects.start(createDocuments([document(path.join(appRoot, "src", "app.component.ts"))]).source);

    assert.deepStrictEqual(projects.knownRoots(), [appRoot]);
  });

  it("discovers a project from a document opened later", async () => {
    const documents = createDocuments();
    const projects = createProjects({ angularRoots: [appRoot] });
    await projects.start(documents.source);
    assert.deepStrictEqual(projects.knownRoots(), []);

    documents.open(document(path.join(appRoot, "src", "app.component.html"), "html"));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepStrictEqual(projects.knownRoots(), [appRoot]);
  });

  it("initializes each discovered root exactly once", async () => {
    const initialized: string[] = [];
    const projects = createProjects({
      angularRoots: [appRoot, featureRoot],
      initializeRoot: async (rootPath) => {
        initialized.push(rootPath);
      },
    });

    await projects.start(createDocuments().source);
    await projects.handleDocument(document(path.join(appRoot, "src", "app.component.ts")));
    await projects.handleDocument(document(path.join(featureRoot, "src", "checkout.component.ts")));
    await projects.handleDocument(document(path.join(featureRoot, "src", "cart.component.html"), "html"));

    assert.deepStrictEqual(initialized, [appRoot, featureRoot]);
  });

  it("routes a file to the deepest discovered root", async () => {
    const projects = createProjects({ angularRoots: [appRoot, featureRoot] });
    await projects.start(
      createDocuments([
        document(path.join(appRoot, "src", "app.component.ts")),
        document(path.join(featureRoot, "src", "checkout.component.ts")),
      ]).source
    );

    assert.strictEqual(projects.rootForPath(path.join(appRoot, "src", "shell.component.ts")), appRoot);
    assert.strictEqual(projects.rootForPath(path.join(featureRoot, "src", "cart.component.ts")), featureRoot);
    assert.strictEqual(projects.rootForUri(uriOf(path.join(featureRoot, "src", "cart.component.html"))), featureRoot);
  });

  it("routes nothing for a file outside every discovered root or a URI that is not on disk", async () => {
    const projects = createProjects({ angularRoots: [appRoot] });
    await projects.start(createDocuments([document(path.join(appRoot, "src", "app.component.ts"))]).source);

    assert.strictEqual(projects.rootForPath(path.join(workspaceRoot, "tools", "build.ts")), undefined);
    assert.strictEqual(projects.rootForUri("untitled:Untitled-1"), undefined);
  });

  it("ignores documents the registry does not route", async () => {
    const initialized: string[] = [];
    const projects = createProjects({
      angularRoots: [appRoot, path.join(workspaceRoot, "node_modules", "widget")],
      initializeRoot: async (rootPath) => {
        initialized.push(rootPath);
      },
    });
    await projects.start(createDocuments().source);

    await projects.handleDocument({ uri: "untitled:Untitled-1", languageId: "typescript" });
    await projects.handleDocument(document(path.join(appRoot, "src", "styles.css"), "css"));
    await projects.handleDocument(document(path.join(workspaceRoot, "node_modules", "widget", "index.ts")));

    assert.deepStrictEqual(initialized, []);
  });

  it("picks up a project in a workspace folder added after initialize", async () => {
    const addedRoot = path.join(path.sep, "elsewhere", "admin");
    const documents = createDocuments([document(path.join(addedRoot, "src", "admin.component.ts"))]);
    const projects = createProjects({ angularRoots: [addedRoot] });
    await projects.start(documents.source);
    assert.deepStrictEqual(projects.knownRoots(), [], "A document outside every workspace folder stays unrouted");

    await projects.setWorkspaceRoots([workspaceRoot, addedRoot]);

    assert.deepStrictEqual(projects.knownRoots(), [addedRoot]);
  });

  it("releases the projects of a removed workspace folder and rediscovers them if it returns", async () => {
    const disposed: string[] = [];
    const initialized: string[] = [];
    const documents = createDocuments([document(path.join(appRoot, "src", "app.component.ts"))]);
    const projects = createProjects({
      angularRoots: [appRoot],
      initializeRoot: async (rootPath) => {
        initialized.push(rootPath);
      },
      disposeRoot: (rootPath) => disposed.push(rootPath),
    });
    await projects.start(documents.source);

    await projects.setWorkspaceRoots([path.join(path.sep, "other-workspace")]);
    assert.deepStrictEqual(disposed, [appRoot]);
    assert.deepStrictEqual(projects.knownRoots(), []);

    await projects.setWorkspaceRoots([workspaceRoot]);
    assert.deepStrictEqual(projects.knownRoots(), [appRoot]);
    assert.deepStrictEqual(initialized, [appRoot, appRoot], "A returning folder must be initialized again");
  });

  it("keeps a project whose folder is still in the workspace", async () => {
    const disposed: string[] = [];
    const projects = createProjects({
      angularRoots: [appRoot],
      disposeRoot: (rootPath) => disposed.push(rootPath),
    });
    await projects.start(createDocuments([document(path.join(appRoot, "src", "app.component.ts"))]).source);

    await projects.setWorkspaceRoots([workspaceRoot, path.join(path.sep, "extra")]);

    assert.deepStrictEqual(disposed, []);
    assert.deepStrictEqual(projects.knownRoots(), [appRoot]);
  });

  it("disposes every project and stops following documents", async () => {
    const disposed: string[] = [];
    const documents = createDocuments([document(path.join(appRoot, "src", "app.component.ts"))]);
    const projects = createProjects({
      angularRoots: [appRoot],
      disposeRoot: (rootPath) => disposed.push(rootPath),
    });
    await projects.start(documents.source);

    projects.dispose();

    assert.deepStrictEqual(disposed, [appRoot]);
    assert.deepStrictEqual(projects.knownRoots(), []);
    assert.strictEqual(documents.getDisposeCount(), 1);
  });

  it("keeps a rejected root discoverable and reports the failure once", async () => {
    let attempts = 0;
    const projects = createProjects({
      angularRoots: [appRoot],
      initializeRoot: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("initial indexing failed");
        }
      },
    });
    const documents = createDocuments();
    await projects.start(documents.source);

    documents.open(document(path.join(appRoot, "src", "app.component.ts")));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(projects.knownRoots(), [], "A failed initialization must not publish the root");

    await projects.handleDocument(document(path.join(appRoot, "src", "shell.component.ts")));

    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(projects.knownRoots(), [appRoot]);
  });
});
