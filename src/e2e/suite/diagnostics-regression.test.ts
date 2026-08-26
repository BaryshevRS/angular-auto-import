import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { applyCodeAction, collectQuickFixes, waitForDiagnosticsToStabilize } from "../helpers/diagnostics-helper";
import {
  replaceFileContent,
  stripAngularImports,
  stripNgModuleImports,
  verifyImportInComponent,
  waitForExtensionActivation,
  waitForFileChange,
} from "../helpers/file-helper";
import type { CaseDescriptor } from "../types";
import { severityToString } from "../types";

const DIAGNOSTIC_SOURCE = "angular-auto-import";
const CASE_FILTER = process.env.AAI_E2E_CASE;
// Optional app shard filter (e.g. "angular-material-demo"). When set, only
// cases whose component lives under apps/<APP_FILTER>/ are run. Used to split a
// version's suite into independent parallel processes (see scripts/e2e-parallel.mjs).
const APP_FILTER = process.env.AAI_E2E_APP;

function isInlineTemplateCase(descriptor: CaseDescriptor): boolean {
  return descriptor.componentPath === descriptor.templatePath;
}

function getTemplateFileName(descriptor: CaseDescriptor): string | undefined {
  return isInlineTemplateCase(descriptor) ? undefined : path.basename(descriptor.templatePath);
}

interface CaseContext {
  componentUri: vscode.Uri;
  templateUri: vscode.Uri;
  moduleUri: vscode.Uri | undefined;
  originalContent: string;
  originalModuleContent: string | undefined;
}

/**
 * Resolves file URIs and preserves original content for a test case.
 */
function resolveCaseFiles(workspaceRoot: string, descriptor: CaseDescriptor): CaseContext {
  const componentUri = vscode.Uri.file(path.join(workspaceRoot, descriptor.componentPath));
  const templateUri = vscode.Uri.file(path.join(workspaceRoot, descriptor.templatePath));
  const moduleUri = descriptor.modulePath
    ? vscode.Uri.file(path.join(workspaceRoot, descriptor.modulePath))
    : undefined;

  const originalContent = fs.readFileSync(componentUri.fsPath, "utf-8");
  const originalModuleContent = moduleUri ? fs.readFileSync(moduleUri.fsPath, "utf-8") : undefined;

  return { componentUri, templateUri, moduleUri, originalContent, originalModuleContent };
}

/**
 * Strips imports and writes modified content to disk for a test case.
 */
async function stripAndWriteImports(ctx: CaseContext, descriptor: CaseDescriptor): Promise<void> {
  if (!descriptor.preserveImports) {
    const templateFileName = getTemplateFileName(descriptor);
    const strippedContent = stripAngularImports(ctx.originalContent, templateFileName);
    await replaceFileContent(ctx.componentUri, strippedContent);
  }
  if (ctx.moduleUri && ctx.originalModuleContent !== undefined) {
    await replaceFileContent(ctx.moduleUri, stripNgModuleImports(ctx.originalModuleContent));
  }
}

/**
 * Discovers all descriptor.json files under the cases/ directory.
 */
function discoverCases(casesDir: string): CaseDescriptor[] {
  const cases: CaseDescriptor[] = [];

  if (!fs.existsSync(casesDir)) {
    return cases;
  }

  const entries = fs.readdirSync(casesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const descriptorPath = path.join(casesDir, entry.name, "descriptor.json");
      if (fs.existsSync(descriptorPath)) {
        const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf-8")) as CaseDescriptor;
        const matchesCase = !CASE_FILTER || descriptor.case === CASE_FILTER;
        const matchesApp = !APP_FILTER || descriptor.componentPath.startsWith(`apps/${APP_FILTER}/`);
        if (matchesCase && matchesApp) {
          cases.push(descriptor);
        }
      }
    }
  }

  return cases;
}

describe("E2E Diagnostics Regression", function () {
  this.timeout(120000);

  // Descriptors are namespaced by the Angular version of the active workspace
  // (folder name under src/e2e/projects, e.g. "v19", "v21").
  const version = path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "");
  const casesDir = path.resolve(__dirname, "..", "cases", version);
  const cases = discoverCases(casesDir);

  if (cases.length === 0) {
    // Passing here is how a shard that ran against nothing reported success: one green
    // placeholder, no cases, and a summary that looked like a clean run.
    it("has cases to run", () => {
      assert.fail(
        `No descriptor.json files found in ${casesDir}. ` +
          "Either the generator has not run, or this host started without the workspace folder."
      );
    });
    return;
  }

  // Activate extension and index once for all cases
  before(async function () {
    this.timeout(90000);
    await waitForExtensionActivation();
  });

  for (const descriptor of cases) {
    describe(`Case: ${descriptor.case}`, () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      let ctx: CaseContext;

      before(async function () {
        this.timeout(90000);

        const componentPath = path.join(workspaceRoot, descriptor.componentPath);
        if (!fs.existsSync(componentPath)) {
          this.skip();
          return;
        }

        ctx = resolveCaseFiles(workspaceRoot, descriptor);
        await stripAndWriteImports(ctx, descriptor);

        // Open the template file to trigger diagnostics
        const doc = await vscode.workspace.openTextDocument(ctx.templateUri);
        await vscode.window.showTextDocument(doc);

        // The descriptor says how many diagnostics this case has, so the wait can tell
        // "the index is not finished" from "this document is clean" and fail saying which.
        await waitForDiagnosticsToStabilize(
          ctx.templateUri,
          DIAGNOSTIC_SOURCE,
          60000,
          3000,
          descriptor.diagnostics.length
        );
      });

      after(async function () {
        this.timeout(10000);

        // Always restore original content
        if (ctx.originalContent && ctx.componentUri) {
          await replaceFileContent(ctx.componentUri, ctx.originalContent);
        }
        if (ctx.moduleUri && ctx.originalModuleContent !== undefined) {
          await replaceFileContent(ctx.moduleUri, ctx.originalModuleContent);
        }

        // Close all editors
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      });

      it("diagnostics match expected positions and properties", () => {
        const diagnostics = vscode.languages
          .getDiagnostics(ctx.templateUri)
          .filter((d) => d.source === DIAGNOSTIC_SOURCE);
        const actualDiagnostics = diagnostics
          .map(
            (d) =>
              `${String(d.code)} [${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}] ${d.message}`
          )
          .join("\n");

        assert.strictEqual(
          diagnostics.length,
          descriptor.diagnostics.length,
          `Expected ${descriptor.diagnostics.length} diagnostics, got ${diagnostics.length}\n${actualDiagnostics}`
        );

        for (const expected of descriptor.diagnostics) {
          const match = diagnostics.find(
            (d) =>
              String(d.code) === expected.code &&
              d.range.start.line === expected.startLine &&
              d.range.start.character === expected.startCharacter &&
              d.range.end.line === expected.endLine &&
              d.range.end.character === expected.endCharacter
          );

          assert.ok(
            match,
            `Missing diagnostic "${expected.code}" at [${expected.startLine}:${expected.startCharacter}]-[${expected.endLine}:${expected.endCharacter}]`
          );

          assert.strictEqual(
            severityToString(match.severity),
            expected.severity,
            `Severity mismatch for "${expected.code}" at line ${expected.startLine}`
          );
        }
      });

      it("quickfixes match expected actions", async function () {
        this.timeout(30000);

        const diagnostics = vscode.languages
          .getDiagnostics(ctx.templateUri)
          .filter((d) => d.source === DIAGNOSTIC_SOURCE);

        // Titles only: what each action carries is checked by applying it, below, and
        // resolving every offered action here would cost a ts-morph rewrite apiece.
        const quickfixMap = await collectQuickFixes(ctx.templateUri, diagnostics, 0);

        for (const expected of descriptor.quickfixes) {
          const actions = quickfixMap.get(expected.diagnosticCode);
          assert.ok(actions && actions.length > 0, `No quickfix found for diagnostic "${expected.diagnosticCode}"`);

          assert.ok(
            actions.some((a) => a.title === expected.title),
            `No quickfix with title "${expected.title}" for diagnostic "${expected.diagnosticCode}". Available: ${actions.map((a) => a.title).join(", ")}`
          );
        }
      });

      /**
       * Applies one expected quickfix, if its diagnostic is still there to fix.
       *
       * Actions are collected fresh each time, which is what an editor does: an action's
       * edit is computed against the file as it stands, so a batch collected up front
       * would carry edits that each undo the one before.
       * @returns Whether the fix was applied, so a skipped one can be retried later.
       */
      async function applyExpectedQuickfix(expected: (typeof descriptor.quickfixes)[number]): Promise<boolean> {
        // The previous fix changed the component, so wait for the report to settle.
        const diagnostics = await waitForDiagnosticsToStabilize(ctx.templateUri, DIAGNOSTIC_SOURCE, 30000, 500);

        // An earlier fix can resolve a later diagnostic — importing one symbol from a
        // module makes everything that module exports available — and a diagnostic that
        // is gone has nothing to offer a fix for. The imports themselves are verified
        // afterwards, which is the contract that actually matters.
        if (!diagnostics.some((d) => String(d.code) === expected.diagnosticCode)) {
          return false;
        }

        // Only the one being applied: every other diagnostic's actions would be resolved
        // too, each a ts-morph rewrite, and once per fix that is the whole document's
        // work squared.
        const quickfixMap = await collectQuickFixes(
          ctx.templateUri,
          diagnostics.filter((diagnostic) => String(diagnostic.code) === expected.diagnosticCode)
        );
        const actions = quickfixMap.get(expected.diagnosticCode);
        assert.ok(actions && actions.length > 0, `No quickfix found for diagnostic "${expected.diagnosticCode}"`);

        const matchingAction = actions.find((a) => a.title === expected.title);
        assert.ok(matchingAction, `No quickfix with title "${expected.title}" for "${expected.diagnosticCode}"`);

        await applyCodeAction(matchingAction, ctx.componentUri);
        await waitForFileChange(ctx.componentUri, 1500);
        return true;
      }

      it("quickfixes apply correct imports", async function () {
        const importKeyOf = (quickfix: (typeof descriptor.quickfixes)[number]) =>
          `${quickfix.expectedImport.className}::${quickfix.expectedImport.moduleSpecifier}`;
        const uniqueImportCount = new Set(descriptor.quickfixes.map(importKeyOf)).size;
        this.timeout(Math.max(120000, 30000 + uniqueImportCount * 2000));

        // One application per distinct import, so the same one is not waited on twice.
        // A fix whose diagnostic had already gone is not marked: a later entry for the
        // same import may find it back, and skipping that one would lose the import.
        const applied = new Set<string>();
        for (const expected of descriptor.quickfixes) {
          if (applied.has(importKeyOf(expected))) {
            continue;
          }
          if (await applyExpectedQuickfix(expected)) {
            applied.add(importKeyOf(expected));
          }
        }

        assertExpectedImports();
      });

      /**
       * The contract the applying is for: every recorded import is in the component, as
       * a statement and in the decorator's `imports`. Which fix put it there, or whether
       * one of them turned out to be unnecessary, is not what a user notices.
       */
      function assertExpectedImports(): void {
        const updatedContent = fs.readFileSync(ctx.componentUri.fsPath, "utf-8");
        const templateFileName = getTemplateFileName(descriptor);

        for (const expected of descriptor.quickfixes) {
          const { className, moduleSpecifier } = expected.expectedImport;
          const result = verifyImportInComponent(updatedContent, className, moduleSpecifier, templateFileName);

          // Something imported earlier may already export it, which is a template with an
          // owner for the token — the thing this case is actually about.
          if (!result.hasImportStatement && expected.satisfiedBy) {
            const covering = verifyImportInComponent(
              updatedContent,
              expected.satisfiedBy.className,
              expected.satisfiedBy.moduleSpecifier,
              templateFileName
            );
            assert.ok(
              covering.hasImportStatement && covering.hasInImportsArray,
              `Neither ${className} nor ${expected.satisfiedBy.className}, which exports it, is imported`
            );
            continue;
          }

          assert.ok(
            result.hasImportStatement,
            `No import statement for ${className} from '${moduleSpecifier}' in the component`
          );
          assert.ok(result.hasInImportsArray, `${className} is imported but missing from the @Component imports array`);
        }
      }
    });
  }
});
