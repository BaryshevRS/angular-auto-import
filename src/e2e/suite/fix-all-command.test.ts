/**
 * The fix-all command, as the palette runs it.
 *
 * Everything the action itself does is covered against the server directly. What nothing
 * covered is the wrapper around it: the action arrives from the editor without its edit
 * — the server computes one only when the client resolves the action it wants — so a
 * command that forgets to ask for that finds the fix-all, applies it, and changes
 * nothing at all. That is invisible to every test that talks to the server, and it is
 * exactly what a user sees as "the command does not work", which is why these cases
 * drive the real command in a real editor.
 * @module
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { waitForDiagnosticsToStabilize } from "../helpers/diagnostics-helper";
import { verifyImportInComponent, waitForExtensionActivation } from "../helpers/file-helper";

const DIAGNOSTIC_SOURCE = "angular-auto-import";

/** Where the fixtures these cases drive live, relative to the workspace. */
const FIXTURES = "apps/angular-demo/src/app/fix-all";

/**
 * The app whose fixtures these are, and the shard filter a parallel run sets.
 *
 * A sharded run splits the suite by app because the apps are disjoint on disk. These
 * cases write their fixtures, so they belong to the one shard that owns the app holding
 * them: run in all three, they would be three editors rewriting the same two files.
 */
const APP = "angular-demo";
const APP_FILTER = process.env.AAI_E2E_APP;

/** How long to keep reading the component before deciding the command changed nothing. */
const APPLIED_TIMEOUT_MS = 20000;

/** An import the command has to leave behind, as the component must end up carrying it. */
interface ExpectedImport {
  className: string;
  moduleSpecifier: string;
}

/** One case: a template the user is looking at, and what running the command must do to it. */
interface FixAllCase {
  name: string;
  /** The fixture's base name under {@link FIXTURES}; each case has one of its own. */
  host: string;
  template: string;
  imports: ExpectedImport[];
}

const CASES: FixAllCase[] = [
  {
    name: "imports everything the open template is missing",
    host: "pair-host",
    template: "<lib-ui-moon></lib-ui-moon>\n<p>{{ 1024 | bytes }}</p>\n",
    imports: [
      { className: "UiMoonComponent", moduleSpecifier: "@angular-demo/ui-moon" },
      { className: "UiDemoBytesPipe", moduleSpecifier: "@angular-demo/ui-demo-one" },
    ],
  },
  {
    // The server used to withhold the fix-all until the second missing element, on the
    // grounds that fixing one thing is the quick fix again. It is not: this command asks
    // for that kind by name and gets nothing else, so the commonest file there is — the
    // one missing a single import — answered "no auto-import diagnostics to fix".
    name: "imports the only element a template is missing",
    host: "single-host",
    template: "<lib-ui-moon></lib-ui-moon>\n",
    imports: [{ className: "UiMoonComponent", moduleSpecifier: "@angular-demo/ui-moon" }],
  },
];

describe("Fix all command", function () {
  this.timeout(120000);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  /** What each case wrote, so the fixtures go back the way they were found. */
  const written = new Map<string, string>();

  before(async function () {
    this.timeout(120000);
    if (!fs.existsSync(path.join(workspaceRoot, FIXTURES)) || (APP_FILTER !== undefined && APP_FILTER !== APP)) {
      this.skip();
      return;
    }
    await waitForExtensionActivation();
  });

  after(async function () {
    this.timeout(30000);
    for (const [file, content] of written) {
      await restore(vscode.Uri.file(file), content);
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  for (const testCase of CASES) {
    it(testCase.name, async () => {
      const componentUri = vscode.Uri.file(path.join(workspaceRoot, FIXTURES, `${testCase.host}.component.ts`));
      const templateUri = vscode.Uri.file(path.join(workspaceRoot, FIXTURES, `${testCase.host}.component.html`));
      written.set(componentUri.fsPath, fs.readFileSync(componentUri.fsPath, "utf-8"));
      written.set(templateUri.fsPath, fs.readFileSync(templateUri.fsPath, "utf-8"));

      fs.writeFileSync(templateUri.fsPath, testCase.template, "utf-8");
      const template = await vscode.workspace.openTextDocument(templateUri);
      await vscode.window.showTextDocument(template, { preview: false });
      await waitForDiagnosticsToStabilize(templateUri, DIAGNOSTIC_SOURCE, 60000, 1000, testCase.imports.length);

      await vscode.commands.executeCommand("angular-auto-import.fix-all");

      const component = await componentOnceItMentions(componentUri, testCase.imports);
      for (const expected of testCase.imports) {
        const carried = verifyImportInComponent(
          component,
          expected.className,
          expected.moduleSpecifier,
          `${testCase.host}.component.html`
        );
        assert.ok(
          carried.hasImportStatement,
          `The command left no "import { ${expected.className} } from '${expected.moduleSpecifier}'" behind:\n${component}`
        );
        assert.ok(
          carried.hasInImportsArray,
          `The command left ${expected.className} out of the decorator's imports:\n${component}`
        );
      }
    });
  }

  /**
   * The component as the command left it.
   *
   * The edit lands in the open document rather than on disk — the extension does not
   * save what it edits, on purpose — and it arrives a moment after the command returns,
   * so this reads the document until it holds every import or the wait runs out. Timing
   * out is not failed here: the assertions report what is missing far better than a
   * timeout does.
   */
  async function componentOnceItMentions(uri: vscode.Uri, expected: ExpectedImport[]): Promise<string> {
    const deadline = Date.now() + APPLIED_TIMEOUT_MS;
    for (;;) {
      const text = (await vscode.workspace.openTextDocument(uri)).getText();
      if (expected.every((wanted) => text.includes(wanted.className)) || Date.now() > deadline) {
        return text;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Puts a fixture back the way it was, in the editor as well as on disk.
   *
   * The command edits the document without saving it, so writing the file alone would
   * leave a dirty editor holding the fix, and the next run would open that instead.
   */
  async function restore(uri: vscode.Uri, content: string): Promise<void> {
    fs.writeFileSync(uri.fsPath, content, "utf-8");
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("workbench.action.files.revert");
  }
});
