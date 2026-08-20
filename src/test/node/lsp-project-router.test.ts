import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectRouter } from "../../lsp/project-router";
import type { ProjectRuntime } from "../../lsp/project-runtime";

const root = path.join(path.sep === "\\" ? "C:\\work" : "/work", "apps", "shop");
const nested = path.join(root, "libs", "ui");

/** The router only ever hands the runtime back, so an identifiable stand-in suffices. */
function fakeRuntime(rootPath: string): ProjectRuntime {
  return { rootPath } as ProjectRuntime;
}

function routerFor(roots: string[], loaded: string[] = roots): ProjectRouter {
  const runtimes = new Map(loaded.map((rootPath) => [rootPath, fakeRuntime(rootPath)]));
  return new ProjectRouter({
    rootForPath: (filePath) =>
      roots.filter((candidate) => filePath.startsWith(candidate + path.sep)).sort((a, b) => b.length - a.length)[0],
    runtimeForRoot: (rootPath) => runtimes.get(rootPath),
  });
}

describe("LSP project router", () => {
  it("routes a TypeScript document to its own file", () => {
    const filePath = path.join(root, "src", "host.component.ts");

    const routed = routerFor([root]).resolve(pathToFileURL(filePath).toString());

    assert.strictEqual(routed?.filePath, filePath);
    assert.strictEqual(routed?.componentFilePath, filePath);
    assert.strictEqual(routed?.externalTemplate, false);
  });

  it("routes an external template to the component that holds its imports", () => {
    const templatePath = path.join(root, "src", "host.component.html");

    const routed = routerFor([root]).resolve(pathToFileURL(templatePath).toString());

    assert.strictEqual(routed?.filePath, templatePath);
    assert.strictEqual(routed?.componentFilePath, path.join(root, "src", "host.component.ts"));
    assert.strictEqual(routed?.externalTemplate, true);
  });

  it("prefers the deepest project containing the file", () => {
    const filePath = path.join(nested, "src", "card.component.ts");

    const routed = routerFor([root, nested]).resolve(pathToFileURL(filePath).toString());

    assert.strictEqual(routed?.runtime.rootPath, nested);
  });

  it("routes nothing for a URI that is not a file on disk", () => {
    assert.strictEqual(routerFor([root]).resolve("untitled:Untitled-1"), undefined);
  });

  it("routes nothing for a file outside every discovered project", () => {
    const outside = path.join(path.sep === "\\" ? "C:\\work" : "/work", "notes", "scratch.html");

    assert.strictEqual(routerFor([root]).resolve(pathToFileURL(outside).toString()), undefined);
  });

  it("routes nothing while the project's runtime is still being built", () => {
    const filePath = path.join(root, "src", "host.component.ts");

    const routed = routerFor([root], []).resolve(pathToFileURL(filePath).toString());

    assert.strictEqual(routed, undefined);
  });
});
