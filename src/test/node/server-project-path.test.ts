/**
 * The `projectPath` setting, which overrides what the client advertises.
 *
 * A user who names one directory does not want the rest of their workspace indexed, and
 * that has been true since long before the language server existed. The decision moved
 * from the Extension Host's activation into the handshake; the behavior did not.
 * @module
 */

import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { InitializeParams } from "vscode-languageserver/node";
import { resolveServerEnvironment } from "../../lsp/server-environment";

function initializeParams(projectPath: string | null, workspaceRoots: string[] = []): InitializeParams {
  return {
    processId: null,
    rootUri: null,
    capabilities: {},
    workspaceFolders: workspaceRoots.map((root) => ({
      uri: pathToFileURL(root).toString(),
      name: path.basename(root),
    })),
    initializationOptions: { settings: { projectPath } },
  } as InitializeParams;
}

describe("Configured project path", () => {
  let sandbox: string;
  let configured: string;
  let workspace: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-project-path-"));
    configured = path.join(sandbox, "configured");
    workspace = path.join(sandbox, "workspace");
    await fs.mkdir(configured);
    await fs.mkdir(workspace);
  });

  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("wins over the workspace folders the client advertised", () => {
    const environment = resolveServerEnvironment(initializeParams(configured, [workspace]));

    assert.deepStrictEqual(environment.workspaceRoots, [configured]);
  });

  it("resolves a relative path against the process working directory", () => {
    const relative = path.relative(process.cwd(), configured);

    const environment = resolveServerEnvironment(initializeParams(relative, [workspace]));

    assert.deepStrictEqual(environment.workspaceRoots, [configured]);
  });

  it("yields no roots when it names something that is not a directory", async () => {
    const file = path.join(sandbox, "not-a-directory.txt");
    await fs.writeFile(file, "", "utf8");

    for (const candidate of [file, path.join(sandbox, "missing")]) {
      const environment = resolveServerEnvironment(initializeParams(candidate, [workspace]));
      assert.deepStrictEqual(
        environment.workspaceRoots,
        [],
        `${candidate} must not silently fall back to the workspace the user overrode`
      );
    }
  });

  it("falls back to the workspace folders when it is absent or blank", () => {
    for (const value of [null, "", "   "]) {
      const environment = resolveServerEnvironment(initializeParams(value, [workspace]));
      assert.deepStrictEqual(environment.workspaceRoots, [workspace], `for ${JSON.stringify(value)}`);
    }
  });

  it("keeps every workspace folder when several are advertised", () => {
    const environment = resolveServerEnvironment(initializeParams(null, [workspace, configured]));

    assert.deepStrictEqual(environment.workspaceRoots, [workspace, configured]);
  });

  it("yields no roots when there is neither a configured path nor a folder", () => {
    assert.deepStrictEqual(resolveServerEnvironment(initializeParams(null)).workspaceRoots, []);
  });
});
