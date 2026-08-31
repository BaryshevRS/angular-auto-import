/**
 * What activation does now.
 *
 * Almost nothing, and that is the point: the extension starts a language server and
 * registers the commands the palette offers. Everything else happens in the server, and
 * is tested against it directly. What is worth checking here is that the editor really
 * ends up with the commands a user can run, under the IDs they have always had.
 * @module
 */

import * as assert from "node:assert";
import * as vscode from "vscode";
import { createMcpServerDefinition } from "../../lsp/client-mcp";

const FIX_ALL_COMMAND = "angular-auto-import.fix-all";

/** Every command the extension contributes, as `package.json` promises them. */
const CONTRIBUTED_COMMANDS = [
  "angular-auto-import.reindex",
  "angular-auto-import.showLogs",
  FIX_ALL_COMMAND,
  "angular-auto-import.generateDiagnosticsReport",
];

describe("Extension activation", function () {
  this.timeout(60000);

  before(async () => {
    const extension = vscode.extensions.getExtension("baryshevrs.angular-auto-import");
    assert.ok(extension, "The extension under test must be installed in the Extension Host");
    await extension.activate();
  });

  it("activates even where there is no Angular project to serve", () => {
    const extension = vscode.extensions.getExtension("baryshevrs.angular-auto-import");

    assert.strictEqual(extension?.isActive, true);
  });

  it("registers every command it contributes", async () => {
    const registered = new Set(await vscode.commands.getCommands(true));

    const missing = CONTRIBUTED_COMMANDS.filter((command) => !registered.has(command));
    assert.deepStrictEqual(missing, [], "A contributed command nobody registered fails when the user runs it");
  });

  it("starts one MCP server inside every folder of a multi-root workspace", () => {
    const folders: vscode.WorkspaceFolder[] = [
      { index: 0, name: "shop", uri: vscode.Uri.file("/workspace/shop") },
      { index: 1, name: "admin", uri: vscode.Uri.file("/workspace/admin") },
    ];
    const definition = createMcpServerDefinition("/extension/dist/server.js", folders, "3.2.0");

    assert.strictEqual(definition.command, process.execPath);
    assert.strictEqual(definition.cwd?.fsPath, folders[0].uri.fsPath);
    assert.strictEqual(definition.version, "3.2.0");
    assert.deepStrictEqual(definition.args, [
      "/extension/dist/server.js",
      "mcp",
      "--workspace-root",
      folders[0].uri.fsPath,
      "--workspace-root",
      folders[1].uri.fsPath,
    ]);
  });

  it("keeps the command IDs the palette and any keybinding already use", async () => {
    const contributed = vscode.extensions
      .getExtension("baryshevrs.angular-auto-import")
      ?.packageJSON?.contributes?.commands?.map((command: { command: string }) => command.command);

    assert.deepStrictEqual([...(contributed ?? [])].sort(), [...CONTRIBUTED_COMMANDS].sort());
  });

  it("offers the existing fix-all command in an HTML editor context menu", () => {
    const editorContextMenu = vscode.extensions.getExtension("baryshevrs.angular-auto-import")?.packageJSON?.contributes
      ?.menus?.["editor/context"];

    assert.ok(
      editorContextMenu?.some(
        (contribution: { command: string; when?: string }) =>
          contribution.command === FIX_ALL_COMMAND && contribution.when === "editorLangId == html"
      ),
      "HTML editors must offer angular-auto-import.fix-all in editor/context"
    );
  });
});
