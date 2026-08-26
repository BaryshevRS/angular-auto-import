/**
 * What the settings do once a user changes one.
 *
 * Every setting reaches the server twice over: once in `initializationOptions` at
 * startup, and again whenever the user edits one, when the editor answers
 * `workspace/configuration`. Only the second path goes through the editor's own
 * configuration API, and only an editor can produce what that API hands back — which is
 * why these cases are here and not against the server, where a harness decides the shape
 * itself and agrees with whatever the parser expects.
 *
 * Each case changes one setting the way a user does, waits for what it governs to
 * change, and puts it back.
 * @module
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { applyCodeAction, collectQuickFixes, waitForDiagnosticsToStabilize } from "../helpers/diagnostics-helper";
import { verifyImportInComponent, waitForExtensionActivation } from "../helpers/file-helper";

const DIAGNOSTIC_SOURCE = "angular-auto-import";
const SECTION = "angular-auto-import";

/** The fixture these cases drive, relative to the workspace. */
const COMPONENT = "apps/angular-demo/src/app/settings/settings-host.component.ts";
const TEMPLATE = "apps/angular-demo/src/app/settings/settings-host.component.html";

/** A template missing one component, so there is one diagnostic to govern. */
const TEMPLATE_MISSING_ONE = "<lib-ui-moon></lib-ui-moon>\n";

/** How long a changed setting is given to reach the server and take effect. */
const SETTLE_TIMEOUT_MS = 20000;

/** The app whose fixture this is; a sharded run gives it to one shard only. */
const APP = "angular-demo";
const APP_FILTER = process.env.AAI_E2E_APP;

describe("Settings", function () {
  this.timeout(180000);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const componentUri = vscode.Uri.file(path.join(workspaceRoot, COMPONENT));
  const templateUri = vscode.Uri.file(path.join(workspaceRoot, TEMPLATE));
  let originalTemplate: string | undefined;
  /** Settings a case changed, put back in the order they were changed. */
  const changed: string[] = [];

  before(async function () {
    this.timeout(120000);
    if (!fs.existsSync(componentUri.fsPath) || (APP_FILTER !== undefined && APP_FILTER !== APP)) {
      this.skip();
      return;
    }
    originalTemplate = fs.readFileSync(templateUri.fsPath, "utf-8");
    await waitForExtensionActivation();

    fs.writeFileSync(templateUri.fsPath, TEMPLATE_MISSING_ONE, "utf-8");
    const template = await vscode.workspace.openTextDocument(templateUri);
    await vscode.window.showTextDocument(template, { preview: false });
    await waitForDiagnosticsToStabilize(templateUri, DIAGNOSTIC_SOURCE, 60000, 1000, 1);
  });

  afterEach(async function () {
    this.timeout(30000);
    for (const setting of changed.splice(0)) {
      await vscode.workspace.getConfiguration(SECTION).update(setting, undefined, vscode.ConfigurationTarget.Global);
    }
    // The next case starts from the default again, and the setting it changes only
    // matters once the server is back to reporting what it reports by default.
    await settleUntil(() => ours().length === 1);
  });

  after(async function () {
    this.timeout(30000);
    if (originalTemplate !== undefined) {
      fs.writeFileSync(templateUri.fsPath, originalTemplate, "utf-8");
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("stops reporting when diagnostics are turned off", async () => {
    await change("diagnostics.mode", "disabled");

    assert.ok(
      await settleUntil(() => ours().length === 0),
      `diagnostics.mode=disabled left ${ours().length} diagnostic(s) on screen`
    );
  });

  it("reports at the severity the user asked for", async () => {
    await change("diagnostics.severity", "error");

    assert.ok(
      await settleUntil(() => ours().every((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)),
      `diagnostics.severity=error left ${ours()
        .map((diagnostic) => vscode.DiagnosticSeverity[diagnostic.severity])
        .join(", ")}`
    );
  });

  it("withholds component completions when they are turned off", async () => {
    // A pipe is asked for in the same breath: the setting names components, so proving
    // it silenced everything would prove the wrong thing.
    assert.ok(await offers("<lib-ui-mo", "lib-ui-moon"), "the component must be offered before the setting is changed");

    await change("completion.components.enabled", false);

    assert.ok(
      await settleUntil(async () => !(await offers("<lib-ui-mo", "lib-ui-moon"))),
      "completion.components.enabled=false went on offering the component"
    );
    assert.ok(await offers("<p>{{ value | byt", "bytes"), "a pipe must still be offered");
  });

  it("formats an applied quick fix with the closest Prettier config", async () => {
    const diagnosticCode = "missing-component-import:lib-ui-moon";
    const originalComponent = fs.readFileSync(componentUri.fsPath, "utf-8");

    try {
      const diagnostics = await waitForDiagnosticsToStabilize(templateUri, DIAGNOSTIC_SOURCE, 30000, 500, 1);
      const actions = (await collectQuickFixes(templateUri, diagnostics)).get(diagnosticCode) ?? [];
      const action = actions.find(
        (candidate) => candidate.title === "⟐ Import UiMoonComponent from '@angular-demo/ui-moon'"
      );
      assert.ok(
        action,
        `Expected the UiMoonComponent quick fix. Available: ${actions.map((item) => item.title).join(", ")}`
      );

      await applyCodeAction(action, componentUri);

      const component = fs.readFileSync(componentUri.fsPath, "utf-8");
      assert.ok(
        component.includes("import {\n    UiMoonComponent\n} from '@angular-demo/ui-moon';"),
        `The nearest Prettier config was not applied:\n${component}`
      );
      assert.ok(
        component.includes("    imports: [\n        UiMoonComponent\n    ],"),
        `The configured space indentation was not applied to Component imports:\n${component}`
      );
    } finally {
      await replaceFixture(componentUri, originalComponent);
      await replaceFixture(templateUri, TEMPLATE_MISSING_ONE);
    }
  });

  it("applies a changed module-specifier preference to the same component quick fix without restarting", async () => {
    const diagnosticCode = "missing-component-import:app-nx-welcome";
    const missingNxWelcome = "<app-nx-welcome></app-nx-welcome>\n";
    const originalComponent = fs.readFileSync(componentUri.fsPath, "utf-8");

    try {
      const template = await replaceFixture(templateUri, missingNxWelcome);

      await change("importModuleSpecifier", "shortest");

      const relativeDiagnostics = await waitForDiagnosticsToStabilize(templateUri, DIAGNOSTIC_SOURCE, 30000, 500, 1);
      assert.ok(
        relativeDiagnostics.some((diagnostic) => String(diagnostic.code) === diagnosticCode),
        `Expected ${diagnosticCode} before applying the shortest quick fix`
      );

      let relativeAction: vscode.CodeAction | undefined;
      let relativeTitles: string[] = [];
      assert.ok(
        await settleUntil(async () => {
          const actions = (await collectQuickFixes(templateUri, relativeDiagnostics)).get(diagnosticCode) ?? [];
          relativeTitles = actions.map((action) => action.title);
          relativeAction = actions.find(
            (action) => action.title === "⟐ Import NxWelcomeComponent from '../nx-welcome.component'"
          );
          return relativeAction !== undefined;
        }),
        `importModuleSpecifier=shortest did not offer the relative quick fix. Available: ${relativeTitles.join(", ")}`
      );
      assert.ok(relativeAction, "Expected the relative NxWelcomeComponent quick fix to be available");
      await applyCodeAction(relativeAction, componentUri);

      const relativeComponent = fs.readFileSync(componentUri.fsPath, "utf-8");
      assert.deepStrictEqual(
        verifyImportInComponent(relativeComponent, "NxWelcomeComponent", "../nx-welcome.component"),
        { hasImportStatement: true, hasInImportsArray: true },
        "The shortest quick fix did not add the relative import completely"
      );

      await replaceFixture(componentUri, originalComponent);
      await vscode.window.showTextDocument(template, { preview: false });

      const aliasDiagnostics = await waitForDiagnosticsToStabilize(templateUri, DIAGNOSTIC_SOURCE, 30000, 500, 1);
      assert.ok(
        aliasDiagnostics.some((diagnostic) => String(diagnostic.code) === diagnosticCode),
        `Expected ${diagnosticCode} to return after restoring the component fixture`
      );

      await change("importModuleSpecifier", "non-relative");

      let aliasAction: vscode.CodeAction | undefined;
      let aliasTitles: string[] = [];
      assert.ok(
        await settleUntil(async () => {
          const actions = (await collectQuickFixes(templateUri, aliasDiagnostics)).get(diagnosticCode) ?? [];
          aliasTitles = actions.map((action) => action.title);
          aliasAction = actions.find(
            (action) => action.title === "⟐ Import NxWelcomeComponent from '@angular-demo/app/nx-welcome'"
          );
          return aliasAction !== undefined;
        }),
        `importModuleSpecifier=non-relative did not offer the configured path-alias quick fix. Available: ${aliasTitles.join(", ")}`
      );
      assert.ok(aliasAction, "Expected the path-alias NxWelcomeComponent quick fix to be available");
      await applyCodeAction(aliasAction, componentUri);

      const aliasedComponent = fs.readFileSync(componentUri.fsPath, "utf-8");
      assert.deepStrictEqual(
        verifyImportInComponent(aliasedComponent, "NxWelcomeComponent", "@angular-demo/app/nx-welcome"),
        { hasImportStatement: true, hasInImportsArray: true },
        "The non-relative quick fix did not add the configured path-alias import completely"
      );
      assert.strictEqual(
        verifyImportInComponent(aliasedComponent, "NxWelcomeComponent", "../nx-welcome.component").hasImportStatement,
        false,
        "The non-relative quick fix reused the previous relative module specifier"
      );
    } finally {
      await replaceFixture(componentUri, originalComponent);
      await replaceFixture(templateUri, TEMPLATE_MISSING_ONE);
    }
  });

  /** Replaces a fixture on disk and reloads its open editor document. */
  async function replaceFixture(uri: vscode.Uri, content: string): Promise<vscode.TextDocument> {
    fs.writeFileSync(uri.fsPath, content, "utf-8");
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("workbench.action.files.revert");
    return document;
  }

  /** Our diagnostics on the fixture, as the editor currently holds them. */
  function ours(): vscode.Diagnostic[] {
    return vscode.languages.getDiagnostics(templateUri).filter((diagnostic) => diagnostic.source === DIAGNOSTIC_SOURCE);
  }

  /** Changes one setting the way a user does, and remembers to put it back. */
  async function change(setting: string, value: unknown): Promise<void> {
    changed.push(setting);
    await vscode.workspace.getConfiguration(SECTION).update(setting, value, vscode.ConfigurationTarget.Global);
  }

  /**
   * Waits for a condition the changed setting is supposed to bring about.
   *
   * A setting travels to the server and back through the editor before anything it
   * governs moves, so nothing here is true the instant `update` resolves.
   * @returns Whether it came true before the wait ran out.
   */
  async function settleUntil(condition: () => boolean | Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    for (;;) {
      if (await condition()) {
        return true;
      }
      if (Date.now() > deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * Whether completing the given template at its end offers a label of ours.
   *
   * The fixture is rewritten for the question and left holding the template the
   * diagnostics cases need, so the two kinds of case do not have to run in an order.
   */
  async function offers(typed: string, label: string): Promise<boolean> {
    fs.writeFileSync(templateUri.fsPath, typed, "utf-8");
    const document = await vscode.workspace.openTextDocument(templateUri);
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("workbench.action.files.revert");

    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      templateUri,
      document.positionAt(typed.length)
    );
    const offered = (list?.items ?? [])
      .filter((item) => item.detail?.startsWith("Angular Auto-Import"))
      .map((item) => (typeof item.label === "string" ? item.label : item.label.label));

    fs.writeFileSync(templateUri.fsPath, TEMPLATE_MISSING_ONE, "utf-8");
    await vscode.commands.executeCommand("workbench.action.files.revert");
    return offered.includes(label);
  }
});
