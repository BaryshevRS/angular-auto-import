/**
 * Project-wide Fix All, through the same production command used by the audit panel.
 * @module
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { waitForDiagnosticsToStabilize } from "../helpers/diagnostics-helper";
import {
  replaceFileContent,
  stripAngularImports,
  verifyImportInComponent,
  waitForExtensionActivation,
} from "../helpers/file-helper";

const CASE = "project-wide-fix-all";
const CASE_FILTER = process.env.AAI_E2E_CASE;
const DIAGNOSTIC_SOURCE = "angular-auto-import";
const NX_WORKSPACE = "v22-nx";
const AUDIT_COMMAND = "angular-auto-import.generateDiagnosticsReport";
const PROJECT_FIX_ALL_COMMAND = "angular-auto-import.fixAllProject";
const BULK_OWNER = {
  componentPath: "apps/shop/src/app/project-wide-fix-all/bulk-owner.component.ts",
  diagnosticPath: "apps/shop/src/app/project-wide-fix-all/bulk-owner.component.html",
  templateFileName: "bulk-owner.component.html",
};
const BULK_CLASSES = [
  "BulkAlphaComponent",
  "BulkBetaComponent",
  "BulkGammaComponent",
  "BulkDeltaComponent",
  "BulkEpsilonComponent",
  "BulkZetaComponent",
  "BulkEtaComponent",
  "BulkThetaComponent",
  "BulkIotaComponent",
  "BulkKappaComponent",
  "BulkLambdaComponent",
  "BulkMuComponent",
  "BulkNuComponent",
  "BulkXiComponent",
  "BulkOmicronComponent",
  "BulkPiComponent",
] as const;

interface OwnerFixture {
  componentPath: string;
  diagnosticPath: string;
  templateFileName?: string;
  className: string;
  moduleSpecifier: string;
}

interface AppliedFixAll {
  applied: boolean;
  totalIssues: number;
  filesChanged: number;
  importsAdded: number;
  reason?: string;
}

/**
 * One owner is inside the discovered Angular project and the other is outside it,
 * reachable only through the app's inherited tsconfig path aliases. That distinction
 * is the reason this case belongs in v22-nx rather than a regular version fixture.
 */
const OWNERS: readonly OwnerFixture[] = [
  {
    componentPath: "apps/shop/src/app/project-wide-fix-all/app-owner.component.ts",
    diagnosticPath: "apps/shop/src/app/project-wide-fix-all/app-owner.component.html",
    templateFileName: "app-owner.component.html",
    className: "BadgeComponent",
    moduleSpecifier: "@shop/ui-kit",
  },
  {
    componentPath: "libs/ui-kit/src/lib/project-wide-fix-all/lib-owner.component.ts",
    diagnosticPath: "libs/ui-kit/src/lib/project-wide-fix-all/lib-owner.component.html",
    templateFileName: "lib-owner.component.html",
    className: "MoneyPipe",
    moduleSpecifier: "@shop/data-access",
  },
];

describe("Project-wide Fix All (v22-nx)", function () {
  this.timeout(180000);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const workspaceName = path.basename(workspaceRoot);
  const originals = new Map<string, string>();
  let active = false;

  before(async function () {
    this.timeout(120000);
    if (workspaceName !== NX_WORKSPACE || (CASE_FILTER !== undefined && CASE_FILTER !== CASE)) {
      this.skip();
      return;
    }

    for (const owner of OWNERS) {
      const componentPath = path.join(workspaceRoot, owner.componentPath);
      const diagnosticPath = path.join(workspaceRoot, owner.diagnosticPath);
      if (!fs.existsSync(componentPath) || !fs.existsSync(diagnosticPath)) {
        assert.fail(`Missing ${CASE} fixture: ${componentPath} or ${diagnosticPath}`);
      }
      originals.set(componentPath, fs.readFileSync(componentPath, "utf-8"));
    }
    const bulkComponentPath = path.join(workspaceRoot, BULK_OWNER.componentPath);
    const bulkTemplatePath = path.join(workspaceRoot, BULK_OWNER.diagnosticPath);
    if (!fs.existsSync(bulkComponentPath) || !fs.existsSync(bulkTemplatePath)) {
      assert.fail(`Missing ${CASE} bulk fixture: ${bulkComponentPath} or ${bulkTemplatePath}`);
    }
    originals.set(bulkComponentPath, fs.readFileSync(bulkComponentPath, "utf-8"));

    active = true;
    await waitForExtensionActivation();
  });

  after(async function () {
    this.timeout(30000);
    if (!active) {
      return;
    }

    // The bulk edit deliberately leaves documents dirty for the user's undo stack.
    // Restore both disk and editor state even when the command or an assertion fails.
    for (const [filePath, content] of originals) {
      await replaceFileContent(vscode.Uri.file(filePath), content);
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("angular-auto-import.reindex");
  });

  it("repairs app and sibling alias-root owners, then leaves a fresh audit clean", async () => {
    const fixtures = OWNERS.map((owner) => ({
      ...owner,
      componentUri: vscode.Uri.file(path.join(workspaceRoot, owner.componentPath)),
      diagnosticUri: vscode.Uri.file(path.join(workspaceRoot, owner.diagnosticPath)),
    }));

    for (const [index, fixture] of fixtures.entries()) {
      const original = originals.get(fixture.componentUri.fsPath);
      assert.ok(original, `Original fixture was not preserved for ${fixture.componentUri.fsPath}`);
      await replaceFileContent(fixture.componentUri, stripAngularImports(original, fixture.templateFileName));

      const diagnosticDocument = await vscode.workspace.openTextDocument(fixture.diagnosticUri);
      await vscode.window.showTextDocument(diagnosticDocument, { preview: false });
      if (index === 0) {
        // A document in the app root proves analysis is ready. The sibling alias root
        // is intentionally exercised by the project audit, not by document routing.
        await waitForDiagnosticsToStabilize(fixture.diagnosticUri, DIAGNOSTIC_SOURCE, 60000, 1000, 1);
      }
    }

    // Open the real audit first, then run the exact command used by its Fix All button.
    const initialAudit = await vscode.commands.executeCommand<{
      complete: boolean;
      totalIssues: number;
      files: unknown[];
    }>(AUDIT_COMMAND);
    assert.deepStrictEqual(
      initialAudit && { complete: initialAudit.complete, totalIssues: initialAudit.totalIssues },
      { complete: true, totalIssues: 2 },
      `Initial project audit did not contain both owners: ${JSON.stringify(initialAudit)}`
    );
    const outcome = await vscode.commands.executeCommand<AppliedFixAll>(PROJECT_FIX_ALL_COMMAND);
    assert.deepStrictEqual(
      outcome && {
        applied: outcome.applied,
        totalIssues: outcome.totalIssues,
        filesChanged: outcome.filesChanged,
        importsAdded: outcome.importsAdded,
        reason: outcome.reason,
      },
      { applied: true, totalIssues: 2, filesChanged: 2, importsAdded: 2, reason: undefined },
      `Unexpected project-wide transaction outcome: ${JSON.stringify(outcome)}`
    );

    for (const fixture of fixtures) {
      const edited = await componentOnceItCarries(fixture.componentUri, fixture.className);
      const carried = verifyImportInComponent(
        edited,
        fixture.className,
        fixture.moduleSpecifier,
        fixture.templateFileName
      );
      assert.ok(
        carried.hasImportStatement,
        `${fixture.componentPath} has no ${fixture.className} import from ${fixture.moduleSpecifier}:\n${edited}`
      );
      assert.ok(
        carried.hasInImportsArray,
        `${fixture.componentPath} left ${fixture.className} out of @Component imports:\n${edited}`
      );
    }

    // The audit command performs a new server-side scan. Diagnostics on both open
    // templates must agree with that fresh result rather than merely disappearing from
    // the report that supplied the fix.
    const cleanAudit = await vscode.commands.executeCommand<{
      complete: boolean;
      totalIssues: number;
      files: unknown[];
    }>(AUDIT_COMMAND);
    assert.deepStrictEqual(
      cleanAudit && {
        complete: cleanAudit.complete,
        totalIssues: cleanAudit.totalIssues,
        files: cleanAudit.files,
      },
      { complete: true, totalIssues: 0, files: [] },
      `Fresh project audit was not clean: ${JSON.stringify(cleanAudit)}`
    );
    for (const fixture of fixtures) {
      await waitUntilDiagnosticsAreClean(fixture.diagnosticUri);
      assert.deepStrictEqual(
        vscode.languages
          .getDiagnostics(fixture.diagnosticUri)
          .filter((diagnostic) => diagnostic.source === DIAGNOSTIC_SOURCE),
        [],
        `Fresh diagnostics still report ${fixture.diagnosticPath}`
      );
    }
  });

  it("applies 16 unique imports for 50 findings to one v22 Nx owner", async () => {
    for (const owner of OWNERS) {
      const componentPath = path.join(workspaceRoot, owner.componentPath);
      const original = originals.get(componentPath);
      assert.ok(original, `Original fixture was not preserved for ${componentPath}`);
      await replaceFileContent(vscode.Uri.file(componentPath), original);
    }

    const componentUri = vscode.Uri.file(path.join(workspaceRoot, BULK_OWNER.componentPath));
    const templateUri = vscode.Uri.file(path.join(workspaceRoot, BULK_OWNER.diagnosticPath));
    const original = originals.get(componentUri.fsPath);
    assert.ok(original, `Original fixture was not preserved for ${componentUri.fsPath}`);
    await replaceFileContent(componentUri, stripAngularImports(original, BULK_OWNER.templateFileName));
    const template = await vscode.workspace.openTextDocument(templateUri);
    await vscode.window.showTextDocument(template, { preview: false });
    await waitForDiagnosticsToStabilize(templateUri, DIAGNOSTIC_SOURCE, 60000, 1000, 50);

    const initialAudit = await vscode.commands.executeCommand<{
      complete: boolean;
      totalIssues: number;
      files: unknown[];
    }>(AUDIT_COMMAND);
    assert.deepStrictEqual(
      initialAudit && {
        complete: initialAudit.complete,
        totalIssues: initialAudit.totalIssues,
        files: initialAudit.files.length,
      },
      { complete: true, totalIssues: 50, files: 1 },
      `Bulk audit did not report exactly 50 findings in one owner: ${JSON.stringify(initialAudit)}`
    );

    const outcome = await vscode.commands.executeCommand<AppliedFixAll>(PROJECT_FIX_ALL_COMMAND);
    assert.deepStrictEqual(
      outcome && {
        applied: outcome.applied,
        totalIssues: outcome.totalIssues,
        filesChanged: outcome.filesChanged,
        importsAdded: outcome.importsAdded,
        reason: outcome.reason,
      },
      { applied: true, totalIssues: 50, filesChanged: 1, importsAdded: 16, reason: undefined },
      `Unexpected 50/16/1 transaction outcome: ${JSON.stringify(outcome)}`
    );

    const edited = await componentOnceItCarries(componentUri, BULK_CLASSES[BULK_CLASSES.length - 1]);
    for (const className of BULK_CLASSES) {
      const carried = verifyImportInComponent(edited, className, "@shop/ui-kit", BULK_OWNER.templateFileName);
      assert.deepStrictEqual(carried, { hasImportStatement: true, hasInImportsArray: true }, className);
    }

    const cleanAudit = await vscode.commands.executeCommand<{
      complete: boolean;
      totalIssues: number;
      files: unknown[];
    }>(AUDIT_COMMAND);
    assert.deepStrictEqual(
      cleanAudit && {
        complete: cleanAudit.complete,
        totalIssues: cleanAudit.totalIssues,
        files: cleanAudit.files,
      },
      { complete: true, totalIssues: 0, files: [] },
      `Fresh bulk audit was not clean: ${JSON.stringify(cleanAudit)}`
    );
  });
});

async function componentOnceItCarries(uri: vscode.Uri, className: string): Promise<string> {
  const deadline = Date.now() + 20000;
  for (;;) {
    const text = (await vscode.workspace.openTextDocument(uri)).getText();
    if (text.includes(className) || Date.now() >= deadline) {
      return text;
    }
    await delay(200);
  }
}

async function waitUntilDiagnosticsAreClean(uri: vscode.Uri): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const diagnostics = vscode.languages
      .getDiagnostics(uri)
      .filter((diagnostic) => diagnostic.source === DIAGNOSTIC_SOURCE);
    if (diagnostics.length === 0) {
      return;
    }
    await delay(200);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
