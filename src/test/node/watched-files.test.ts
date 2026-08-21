import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { FileChangeType } from "vscode-languageserver/node";
import type { FileChange } from "../../core/file-watching";
import { WatchedFiles } from "../../lsp/watched-files";

const projectRoot = path.resolve(path.sep, "workspace", "apps", "shop");
const sourceWatch = { root: projectRoot, recursive: true, extensions: [".ts"] };
const manifestWatch = {
  root: projectRoot,
  recursive: false,
  fileNames: ["package.json", "pnpm-lock.yaml"],
};

function change(
  filePath: string,
  type: FileChangeType = FileChangeType.Changed
): { uri: string; type: FileChangeType } {
  return { uri: pathToFileURL(filePath).toString(), type };
}

describe("LSP watched files", () => {
  it("delivers a change to the subscription that watches it", () => {
    const watched = new WatchedFiles();
    const reported: FileChange[] = [];
    watched.watch(sourceWatch, (fileChange) => reported.push(fileChange));

    watched.dispatch([change(path.join(projectRoot, "src", "app.component.ts"))]);

    assert.deepStrictEqual(reported, [{ filePath: path.join(projectRoot, "src", "app.component.ts"), kind: "change" }]);
  });

  it("maps every change type the client reports", () => {
    const watched = new WatchedFiles();
    const kinds: string[] = [];
    watched.watch(sourceWatch, ({ kind }) => kinds.push(kind));
    const filePath = path.join(projectRoot, "src", "app.component.ts");

    watched.dispatch([
      change(filePath, FileChangeType.Created),
      change(filePath, FileChangeType.Changed),
      change(filePath, FileChangeType.Deleted),
    ]);

    assert.deepStrictEqual(kinds, ["create", "change", "delete"]);
  });

  it("keeps a recursive source watch and a flat manifest watch apart", () => {
    const watched = new WatchedFiles();
    const sources: string[] = [];
    const manifests: string[] = [];
    watched.watch(sourceWatch, ({ filePath }) => sources.push(filePath));
    watched.watch(manifestWatch, ({ filePath }) => manifests.push(filePath));

    watched.dispatch([
      change(path.join(projectRoot, "src", "deep", "app.component.ts")),
      change(path.join(projectRoot, "package.json")),
      change(path.join(projectRoot, "node_modules", "lib", "package.json")),
      change(path.join(projectRoot, "src", "styles.css")),
    ]);

    assert.deepStrictEqual(sources, [path.join(projectRoot, "src", "deep", "app.component.ts")]);
    assert.deepStrictEqual(
      manifests,
      [path.join(projectRoot, "package.json")],
      "A nested manifest belongs to a dependency, not to this project"
    );
  });

  it("ignores changes outside the watched root and URIs that are not on disk", () => {
    const watched = new WatchedFiles();
    const reported: string[] = [];
    watched.watch(sourceWatch, ({ filePath }) => reported.push(filePath));

    watched.dispatch([
      change(path.resolve(path.sep, "workspace", "apps", "admin", "src", "app.component.ts")),
      change(path.resolve(path.sep, "workspace", "apps", "shop-old", "src", "app.component.ts")),
      { uri: "untitled:Untitled-1", type: FileChangeType.Changed },
    ]);

    assert.deepStrictEqual(reported, []);
  });

  it("stops delivering to a disposed subscription", () => {
    const watched = new WatchedFiles();
    const reported: string[] = [];
    const subscription = watched.watch(sourceWatch, ({ filePath }) => reported.push(filePath));

    subscription.dispose();
    watched.dispatch([change(path.join(projectRoot, "src", "app.component.ts"))]);

    assert.deepStrictEqual(reported, []);
    assert.deepStrictEqual(watched.watches(), []);
  });

  it("keeps one failing listener from starving the others", () => {
    const watched = new WatchedFiles();
    const reported: string[] = [];
    watched.watch(sourceWatch, () => {
      throw new Error("listener failed");
    });
    watched.watch(sourceWatch, ({ filePath }) => reported.push(filePath));

    watched.dispatch([change(path.join(projectRoot, "src", "app.component.ts"))]);

    assert.deepStrictEqual(reported, [path.join(projectRoot, "src", "app.component.ts")]);
  });

  it("asks the client to watch the files a subscription needs", async () => {
    const registered: unknown[] = [];
    const watched = new WatchedFiles({
      register: async (watchers) => {
        registered.push(...watchers);
        return { dispose: () => undefined };
      },
    });

    watched.watch(sourceWatch, () => undefined);
    watched.watch(manifestWatch, () => undefined);
    await Promise.resolve();

    assert.deepStrictEqual(registered, [
      { globPattern: { baseUri: pathToFileURL(projectRoot).toString(), pattern: "**/*.ts" }, kind: 7 },
      {
        globPattern: { baseUri: pathToFileURL(projectRoot).toString(), pattern: "{package.json,pnpm-lock.yaml}" },
        kind: 7,
      },
    ]);
  });

  it("removes the client-side watch when its subscription goes away", async () => {
    let disposals = 0;
    const watched = new WatchedFiles({
      register: async () => ({ dispose: () => (disposals += 1) }),
    });

    const subscription = watched.watch(sourceWatch, () => undefined);
    await Promise.resolve();
    subscription.dispose();

    assert.strictEqual(disposals, 1);
  });

  it("does not leave a registration behind for a subscription disposed while registering", async () => {
    let disposals = 0;
    let resolveRegistration: ((handle: { dispose(): void }) => void) | undefined;
    const watched = new WatchedFiles({
      register: () =>
        new Promise((resolve) => {
          resolveRegistration = resolve;
        }),
    });

    const subscription = watched.watch(sourceWatch, () => undefined);
    subscription.dispose();
    resolveRegistration?.({ dispose: () => (disposals += 1) });
    await Promise.resolve();
    await Promise.resolve();

    assert.strictEqual(disposals, 1);
  });

  it("survives a client that cannot register watchers", () => {
    const watched = new WatchedFiles();

    watched.watch(sourceWatch, () => undefined);

    assert.deepStrictEqual(watched.watches(), [sourceWatch]);
  });
});
