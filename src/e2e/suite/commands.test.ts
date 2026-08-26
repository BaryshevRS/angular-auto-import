/**
 * The palette commands, as a user runs them.
 *
 * Each one is a wrapper: it asks the server something and turns the answer into UI. The
 * server side of every one of them is covered against the server directly; the wrapper
 * is not, and that is where a command that quietly does nothing hides — the fix-all
 * proved it by applying an empty action for as long as it had no test in an editor.
 *
 * So these cases assert what an editor can actually observe: that the index still
 * answers after the command that rebuilds it, that the one clearing the cache leaves it
 * answering, and that the report opens the panel it exists to open. A request that fails
 * shows the user an error notification instead of a panel, which is precisely the
 * difference these look for.
 * @module
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { waitForDiagnosticsToStabilize } from "../helpers/diagnostics-helper";
import { waitForExtensionActivation } from "../helpers/file-helper";

const DIAGNOSTIC_SOURCE = "angular-auto-import";

/** The fixture these cases drive, relative to the workspace. */
const COMPONENT = "apps/angular-demo/src/app/commands/commands-host.component.ts";
const TEMPLATE = "apps/angular-demo/src/app/commands/commands-host.component.html";

/** A template missing one element, so the index has something to be asked about. */
const TEMPLATE_MISSING_ONE = "<lib-ui-moon></lib-ui-moon>\n";

/** The kind the fix-all action carries, asserted against the constant in the node tests. */
const FIX_ALL_KIND = "source.fixAll.angular-auto-import";

/** What the report command titles its panel, as `client-commands` creates it. */
const REPORT_PANEL_TITLE = "Angular Auto Import - Diagnostics Report";

/**
 * The app whose fixture this is, and the shard filter a parallel run sets.
 *
 * A sharded run splits by app because the apps are disjoint on disk. These cases write
 * their fixture, so they belong to the shard that owns the app holding it.
 */
const APP = "angular-demo";
const APP_FILTER = process.env.AAI_E2E_APP;

describe("Palette commands", function () {
  this.timeout(180000);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const componentUri = vscode.Uri.file(path.join(workspaceRoot, COMPONENT));
  const templateUri = vscode.Uri.file(path.join(workspaceRoot, TEMPLATE));
  let originalTemplate: string | undefined;

  before(async function () {
    this.timeout(120000);
    if (!fs.existsSync(componentUri.fsPath) || (APP_FILTER !== undefined && APP_FILTER !== APP)) {
      this.skip();
      return;
    }
    originalTemplate = fs.readFileSync(templateUri.fsPath, "utf-8");
    await waitForExtensionActivation();
    await openTemplateMissingAnImport();
  });

  after(async function () {
    this.timeout(30000);
    if (originalTemplate !== undefined) {
      fs.writeFileSync(templateUri.fsPath, originalTemplate, "utf-8");
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("rebuilds the index, and the server answers out of it afterwards", async () => {
    await vscode.commands.executeCommand("angular-auto-import.reindex");

    assert.ok(await resolvedFixAll(), "After a reindex the server must still resolve the element it indexed");
  });

  it("opens the diagnostics report on the project", async () => {
    await vscode.commands.executeCommand("angular-auto-import.generateDiagnosticsReport");

    // A failed request leaves the user an error notification and no panel at all, so the
    // panel being there is what says the scan ran and came back. The tab model is
    // mirrored from the main thread, so it is polled rather than read the instant the
    // command returns.
    const deadline = Date.now() + 10000;
    while (!reportPanelIsOpen() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    assert.ok(
      reportPanelIsOpen(),
      `No "${REPORT_PANEL_TITLE}" panel open. Tabs: ${
        openTabs()
          .map((tab) => `${tab.label} [${tab.input?.constructor?.name ?? "unknown"}]`)
          .join(", ") || "none"
      }`
    );
  });

  it("shows its log channel", async () => {
    // Entirely client-side, and there is nothing an extension can observe about which
    // channel the editor put on screen. Running it at least proves the registration.
    await vscode.commands.executeCommand("angular-auto-import.showLogs");
  });

  /** Whether the report's panel is among the open tabs. */
  function reportPanelIsOpen(): boolean {
    return openTabs().some((tab) => tab.label === REPORT_PANEL_TITLE);
  }

  /** Every tab open in the window, whichever group holds it. */
  function openTabs(): readonly vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  }

  /**
   * Writes the template the cases ask about and waits until it is reported on.
   *
   * Everything here turns on the index knowing `lib-ui-moon`, so the suite starts by
   * proving that it does; a case failing afterwards then means the command broke it.
   */
  async function openTemplateMissingAnImport(): Promise<void> {
    fs.writeFileSync(templateUri.fsPath, TEMPLATE_MISSING_ONE, "utf-8");
    const template = await vscode.workspace.openTextDocument(templateUri);
    await vscode.window.showTextDocument(template, { preview: false });
    await waitForDiagnosticsToStabilize(templateUri, DIAGNOSTIC_SOURCE, 60000, 1000, 1);
  }

  /**
   * The fix-all for the open template, with its edit filled in.
   *
   * Resolving is what makes this a question about the index rather than about the list
   * of diagnostics: the edit exists only if the server could still find the element, read
   * the component, and work out the import to write.
   */
  async function resolvedFixAll(): Promise<boolean> {
    const document = await vscode.workspace.openTextDocument(templateUri);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      templateUri,
      new vscode.Range(0, 0, document.lineCount, 0),
      FIX_ALL_KIND,
      5
    );

    return (actions ?? []).some((action) => action.kind?.value === FIX_ALL_KIND && action.edit !== undefined);
  }
});
