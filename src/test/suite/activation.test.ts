import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate } from "../../extension";

describe("extension activation", () => {
  it("does not register workspace features when no Angular project is present", async () => {
    const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    const nonAngularProject = path.join(__dirname, "..", "fixtures", "non-angular-project");
    const subscriptions: vscode.Disposable[] = [];
    const context = {
      subscriptions,
      // biome-ignore lint/style/useNamingConvention: VS Code API property name.
      extension: { packageJSON: { version: "test" } },
    } as unknown as vscode.ExtensionContext;

    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      get: () => [{ uri: vscode.Uri.file(nonAngularProject), name: "non-angular-project", index: 0 }],
    });

    try {
      await activate(context);
      assert.strictEqual(
        subscriptions.length,
        0,
        "Providers, commands, and document listeners must not be registered outside Angular projects"
      );
    } finally {
      Object.defineProperty(vscode.workspace, "workspaceFolders", {
        configurable: true,
        get: () => originalWorkspaceFolders,
      });
    }
  });
});
