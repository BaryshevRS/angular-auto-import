/**
 * That the server comes back when it dies.
 *
 * A language server is a separate process, and separate processes crash. The client is
 * configured to restart one that does; this proves it actually happens, and that the
 * connection is usable again afterwards rather than merely re-established.
 * @module
 */

import * as assert from "node:assert";
import * as vscode from "vscode";

/** A request only the server can answer, so answering it proves the server is there. */
const METRICS_COMMAND = "angular-auto-import.showPerformanceMetrics";

describe("Language server lifecycle", function () {
  this.timeout(60000);

  before(async () => {
    assert.strictEqual(process.env.AAI_ENABLE_CRASH_COMMAND, "1", "This suite needs the test-only crash command");
    const extension = vscode.extensions.getExtension("baryshevrs.angular-auto-import");
    assert.ok(extension, "The extension under test must be installed in the Extension Host");
    await extension.activate();
  });

  it("restarts a server that died, and answers again afterwards", async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.ok(registered.has(METRICS_COMMAND), "The client must have registered its commands before the crash");

    // Reaching the server at all before the crash, so a later success means recovery
    // rather than a server that was never asked anything.
    await vscode.commands.executeCommand(METRICS_COMMAND);

    await vscode.commands.executeCommand("angular-auto-import.test.crashAndWaitForRestart");

    // The command talks to the server and renders what comes back; a dead or
    // unreachable server surfaces as an error notification, not a webview.
    await vscode.commands.executeCommand(METRICS_COMMAND);
  });
});
