import * as assert from "node:assert";
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

describe("LSP server environment", () => {
  it("reads workspace roots as filesystem paths", () => {
    const environment = resolveServerEnvironment(
      initializeParams({
        workspaceFolders: [
          { uri: "file:///workspace/app", name: "app" },
          { uri: "file:///workspace/lib", name: "lib" },
        ],
      })
    );

    assert.deepStrictEqual(environment.workspaceRoots, ["/workspace/app", "/workspace/lib"]);
  });

  it("skips workspace folders that are not on disk", () => {
    const environment = resolveServerEnvironment(
      initializeParams({
        workspaceFolders: [
          { uri: "untitled:Untitled-1", name: "scratch" },
          { uri: "file:///workspace/app", name: "app" },
        ],
      })
    );

    assert.deepStrictEqual(environment.workspaceRoots, ["/workspace/app"]);
  });

  it("falls back to the deprecated single-root fields", () => {
    assert.deepStrictEqual(
      resolveServerEnvironment(initializeParams({ rootUri: "file:///workspace/only" })).workspaceRoots,
      ["/workspace/only"]
    );
    assert.deepStrictEqual(
      resolveServerEnvironment(initializeParams({ rootPath: "/workspace/legacy" })).workspaceRoots,
      ["/workspace/legacy"]
    );
    assert.deepStrictEqual(resolveServerEnvironment(initializeParams()).workspaceRoots, []);
  });

  it("prefers workspace folders over the deprecated fields", () => {
    const environment = resolveServerEnvironment(
      initializeParams({
        rootUri: "file:///workspace/legacy",
        workspaceFolders: [{ uri: "file:///workspace/app", name: "app" }],
      })
    );

    assert.deepStrictEqual(environment.workspaceRoots, ["/workspace/app"]);
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
    const roots = ["/workspace/app", "/workspace/lib"];

    const afterAdd = applyWorkspaceFolderChange(roots, {
      added: [{ uri: "file:///workspace/extra" }],
      removed: [],
    });
    assert.deepStrictEqual(afterAdd, ["/workspace/app", "/workspace/lib", "/workspace/extra"]);

    const afterRemove = applyWorkspaceFolderChange(afterAdd, {
      added: [],
      removed: [{ uri: "file:///workspace/lib" }],
    });
    assert.deepStrictEqual(afterRemove, ["/workspace/app", "/workspace/extra"]);
  });

  it("ignores a root that is already tracked", () => {
    const roots = applyWorkspaceFolderChange(["/workspace/app"], {
      added: [{ uri: "file:///workspace/app" }],
      removed: [],
    });

    assert.deepStrictEqual(roots, ["/workspace/app"]);
  });
});
