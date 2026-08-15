import * as assert from "node:assert";
import * as vscode from "vscode";

async function requestSpikeCompletion(documentUri: vscode.Uri): Promise<vscode.CompletionList> {
  const document = await vscode.workspace.openTextDocument(documentUri);
  await vscode.window.showTextDocument(document);
  const completionOffset = document.getText().lastIndexOf("<sp") + 3;

  return vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    document.uri,
    document.positionAt(completionOffset),
    "<"
  );
}

describe("LSP lifecycle spike", function () {
  this.timeout(20000);

  it("starts, re-synchronizes after a crash, and stops the server", async () => {
    assert.strictEqual(process.env.AAI_LSP_SPIKE, "1", "The LSP suite must run in isolated spike mode");

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, "The LSP suite requires its fixture workspace");

    const extension = vscode.extensions.getExtension("baryshevrs.angular-auto-import");
    assert.ok(extension, "The extension under test must be installed in the Extension Host");
    await extension.activate();

    const htmlUri = vscode.Uri.joinPath(workspaceFolder.uri, "lsp-spike.html");
    const typescriptUri = vscode.Uri.joinPath(workspaceFolder.uri, "lsp-spike.ts");
    for (const completionList of [await requestSpikeCompletion(htmlUri), await requestSpikeCompletion(typescriptUri)]) {
      const spikeItem = completionList.items.find((item) => item.label === "aai-lsp-spike");
      assert.ok(spikeItem, "HTML and TypeScript completions must cross the protocol boundary");
      assert.strictEqual(spikeItem.insertText, "lsp-spike");
      assert.strictEqual(spikeItem.detail, "Angular Auto Import LSP spike (runtime dependencies loaded)");
    }

    await vscode.commands.executeCommand("angular-auto-import.lsp-spike.crash-and-wait-for-restart");
    for (const completionList of [await requestSpikeCompletion(htmlUri), await requestSpikeCompletion(typescriptUri)]) {
      assert.ok(
        completionList.items.some((item) => item.label === "aai-lsp-spike"),
        "Open HTML and TypeScript documents must be re-synchronized after an automatic server restart"
      );
    }

    await vscode.commands.executeCommand("angular-auto-import.lsp-spike.stop");
    const completionAfterStop = await requestSpikeCompletion(htmlUri);
    assert.ok(
      completionAfterStop.items.every((item) => item.label !== "aai-lsp-spike"),
      "Stopping the client must unregister the provider and shut down the server"
    );
  });
});
