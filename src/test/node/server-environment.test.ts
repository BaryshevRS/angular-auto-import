import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { InitializeParams } from "vscode-languageserver/node";
import { DEFAULT_EXTENSION_CONFIG } from "../../core/settings";
import { FIX_ALL_KIND } from "../../lsp/code-actions";
import { APPLY_IMPORT_COMMAND } from "../../lsp/import-command";
import {
  applyWorkspaceFolderChange,
  buildInitializeResult,
  COMPLETION_TRIGGER_CHARACTERS,
  resolveServerEnvironment,
} from "../../lsp/server-environment";

function initializeParams(overrides: Partial<InitializeParams> = {}): InitializeParams {
  return {
    processId: null,
    rootUri: null,
    capabilities: {},
    ...overrides,
  } as InitializeParams;
}

/** A client that advertises everything the server currently looks for. */
const fullClient: Partial<InitializeParams> = {
  capabilities: {
    workspace: {
      configuration: true,
      workspaceFolders: true,
      didChangeWatchedFiles: { dynamicRegistration: true },
      diagnostics: { refreshSupport: true },
    },
    textDocument: { codeAction: { resolveSupport: { properties: ["edit"] } } },
  },
};

/**
 * A path that is absolute on this platform, drive letter and all.
 *
 * `/workspace/app` is not an absolute path on Windows, and a `file:///workspace/app`
 * URI is not a file URL there at all — the server drops what it cannot convert, so a
 * POSIX fixture makes every root vanish rather than disagree.
 */
function root(...segments: string[]): string {
  return path.resolve(path.sep, "workspace", ...segments);
}

/** The same path as the URI a client would send for it. */
function rootUri(...segments: string[]): string {
  return pathToFileURL(root(...segments)).toString();
}

describe("LSP server environment", () => {
  it("reads workspace roots as filesystem paths", () => {
    const environment = resolveServerEnvironment(
      initializeParams({
        workspaceFolders: [
          { uri: rootUri("app"), name: "app" },
          { uri: rootUri("lib"), name: "lib" },
        ],
      })
    );

    assert.deepStrictEqual(environment.workspaceRoots, [root("app"), root("lib")]);
  });

  it("skips workspace folders that are not on disk", () => {
    const environment = resolveServerEnvironment(
      initializeParams({
        workspaceFolders: [
          { uri: "untitled:Untitled-1", name: "scratch" },
          { uri: rootUri("app"), name: "app" },
        ],
      })
    );

    assert.deepStrictEqual(environment.workspaceRoots, [root("app")]);
  });

  it("falls back to the deprecated single-root fields", () => {
    assert.deepStrictEqual(resolveServerEnvironment(initializeParams({ rootUri: rootUri("only") })).workspaceRoots, [
      root("only"),
    ]);
    assert.deepStrictEqual(resolveServerEnvironment(initializeParams({ rootPath: root("legacy") })).workspaceRoots, [
      root("legacy"),
    ]);
    assert.deepStrictEqual(resolveServerEnvironment(initializeParams()).workspaceRoots, []);
  });

  it("prefers workspace folders over the deprecated fields", () => {
    const environment = resolveServerEnvironment(
      initializeParams({
        rootUri: rootUri("legacy"),
        workspaceFolders: [{ uri: rootUri("app"), name: "app" }],
      })
    );

    assert.deepStrictEqual(environment.workspaceRoots, [root("app")]);
  });

  it("resolves settings sent at initialize, falling back to defaults", () => {
    const environment = resolveServerEnvironment(
      initializeParams({
        initializationOptions: {
          settings: { diagnosticsSeverity: "error", completion: { pipes: false } },
          storagePath: "/tmp/aai-storage",
        },
      })
    );

    assert.strictEqual(environment.config.diagnosticsSeverity, "error");
    assert.strictEqual(environment.config.completion.pipes, false);
    assert.strictEqual(environment.config.completion.components, DEFAULT_EXTENSION_CONFIG.completion.components);
    assert.strictEqual(environment.config.indexRefreshInterval, DEFAULT_EXTENSION_CONFIG.indexRefreshInterval);
    assert.strictEqual(environment.storagePath, "/tmp/aai-storage");
  });

  it("uses defaults when the client sends no initialization options", () => {
    const environment = resolveServerEnvironment(initializeParams());

    assert.deepStrictEqual(environment.config, DEFAULT_EXTENSION_CONFIG);
    assert.strictEqual(environment.storagePath, undefined);
  });

  it("records only the client capabilities the server acts on", () => {
    assert.deepStrictEqual(resolveServerEnvironment(initializeParams(fullClient)).client, {
      configuration: true,
      workspaceFolders: true,
      didChangeWatchedFiles: true,
      diagnosticRefresh: true,
      codeActionResolve: true,
    });

    assert.deepStrictEqual(resolveServerEnvironment(initializeParams()).client, {
      configuration: false,
      workspaceFolders: false,
      didChangeWatchedFiles: false,
      diagnosticRefresh: false,
      codeActionResolve: false,
    });
  });

  it("advertises document sync and the direct provider's trigger characters", () => {
    const result = buildInitializeResult(resolveServerEnvironment(initializeParams()), "test-server");

    assert.strictEqual(result.serverInfo?.name, "test-server");
    assert.deepStrictEqual(result.capabilities.completionProvider?.triggerCharacters, COMPLETION_TRIGGER_CHARACTERS);
    assert.deepStrictEqual(COMPLETION_TRIGGER_CHARACTERS, ["<", "|", " ", "[", "*"]);
  });

  it("offers the import command it attaches to completion items", () => {
    const result = buildInitializeResult(resolveServerEnvironment(initializeParams()), "test-server");

    assert.deepStrictEqual(result.capabilities.executeCommandProvider?.commands, [APPLY_IMPORT_COMMAND]);
  });

  it("offers quick fixes and its own fix-all, resolving edits only for a client that asks", () => {
    const resolving = buildInitializeResult(resolveServerEnvironment(initializeParams(fullClient)), "test-server");
    const plain = buildInitializeResult(resolveServerEnvironment(initializeParams()), "test-server");

    assert.deepStrictEqual(resolving.capabilities.codeActionProvider, {
      codeActionKinds: ["quickfix", FIX_ALL_KIND],
      resolveProvider: true,
    });
    assert.strictEqual(
      typeof plain.capabilities.codeActionProvider === "object" &&
        plain.capabilities.codeActionProvider.resolveProvider,
      false
    );
  });

  it("declares that a document's diagnostics depend on other files", () => {
    const result = buildInitializeResult(resolveServerEnvironment(initializeParams()), "test-server");

    assert.deepStrictEqual(result.capabilities.diagnosticProvider, {
      interFileDependencies: true,
      workspaceDiagnostics: false,
    });
  });

  it("announces workspace-folder support only to clients that have it", () => {
    const withFolders = buildInitializeResult(resolveServerEnvironment(initializeParams(fullClient)), "test-server");
    const withoutFolders = buildInitializeResult(resolveServerEnvironment(initializeParams()), "test-server");

    assert.deepStrictEqual(withFolders.capabilities.workspace?.workspaceFolders, {
      supported: true,
      changeNotifications: true,
    });
    assert.strictEqual(withoutFolders.capabilities.workspace, undefined);
  });

  it("adds and removes workspace roots without disturbing the rest", () => {
    const roots = [root("app"), root("lib")];

    const afterAdd = applyWorkspaceFolderChange(roots, {
      added: [{ uri: rootUri("extra") }],
      removed: [],
    });
    assert.deepStrictEqual(afterAdd, [root("app"), root("lib"), root("extra")]);

    const afterRemove = applyWorkspaceFolderChange(afterAdd, {
      added: [],
      removed: [{ uri: rootUri("lib") }],
    });
    assert.deepStrictEqual(afterRemove, [root("app"), root("extra")]);
  });

  it("ignores a root that is already tracked", () => {
    const roots = applyWorkspaceFolderChange([root("app")], {
      added: [{ uri: rootUri("app") }],
      removed: [],
    });

    assert.deepStrictEqual(roots, [root("app")]);
  });
});
