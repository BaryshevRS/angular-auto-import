import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { collectQuickFixes, waitForDiagnosticsToStabilize } from "../helpers/diagnostics-helper";
import {
  replaceFileContent,
  stripAngularImports,
  stripNgModuleImports,
  waitForExtensionActivation,
} from "../helpers/file-helper";
import type { CaseConfig, QuickfixDescriptor } from "../types";
import { severityToString } from "../types";

const DIAGNOSTIC_SOURCE = "angular-auto-import";
const CASE_FILTER = process.env.AAI_E2E_CASE;

function isInlineTemplateCase(caseConfig: CaseConfig): boolean {
  return caseConfig.componentPath === caseConfig.templatePath;
}

function getTemplateFileName(caseConfig: CaseConfig): string | undefined {
  return isInlineTemplateCase(caseConfig) ? undefined : path.basename(caseConfig.templatePath);
}

interface CaseRunContext {
  componentUri: vscode.Uri;
  templateUri: vscode.Uri;
  moduleUri?: vscode.Uri;
  originalContent: string;
  originalModuleContent?: string;
}

const CASES: CaseConfig[] = [
  {
    // Regression for https://github.com/ngx-rock/vscode-angular-auto-import/issues/33
    // `translate` pipe provided via TranslateModule must NOT be flagged when the
    // module is present in the standalone component's imports array.
    name: "ngx-translate",
    componentPath: "apps/angular-demo/src/app/ngx-translate/ngx-translate.component.ts",
    templatePath: "apps/angular-demo/src/app/ngx-translate/ngx-translate.component.html",
    preserveImports: true,
  },
  {
    // Companion to `ngx-translate`: with imports stripped the pipe MUST be
    // flagged, proving the no-false-positive case above is not a trivial pass.
    name: "ngx-translate-missing",
    componentPath: "apps/angular-demo/src/app/ngx-translate/ngx-translate-missing.component.ts",
    templatePath: "apps/angular-demo/src/app/ngx-translate/ngx-translate-missing.component.ts",
  },
  {
    name: "control-flow",
    componentPath: "apps/angular-demo/src/app/control-flow/control-flow.component.ts",
    templatePath: "apps/angular-demo/src/app/control-flow/control-flow.component.html",
  },
  {
    name: "base",
    componentPath: "apps/angular-demo/src/app/home/home.component.ts",
    templatePath: "apps/angular-demo/src/app/home/home.component.html",
  },
  {
    name: "standard",
    componentPath: "apps/angular-demo/src/app/standard/standard.component.ts",
    templatePath: "apps/angular-demo/src/app/standard/standard.component.html",
  },
  {
    name: "tsconfig-aliases",
    componentPath: "apps/angular-demo/src/app/tsconfig-aliases/ui-demo-one-alias.component.ts",
    templatePath: "apps/angular-demo/src/app/tsconfig-aliases/ui-demo-one-alias.component.html",
  },
  {
    name: "inline",
    componentPath: "apps/angular-demo/src/app/inline/inline.component.ts",
    templatePath: "apps/angular-demo/src/app/inline/inline.component.ts",
  },
  {
    name: "legacy-modules",
    componentPath: "apps/angular-demo/src/app/module/lib-module-full.component.ts",
    templatePath: "apps/angular-demo/src/app/module/lib-module-full.component.ts",
    modulePath: "apps/angular-demo/src/app/module/lib-module-full.module.ts",
  },
  {
    name: "primeng",
    componentPath: "apps/primeng-demo/src/app/playground/prime-playground.component.ts",
    templatePath: "apps/primeng-demo/src/app/playground/prime-playground.component.html",
  },
  {
    name: "primeng-legacy-modules",
    componentPath: "apps/primeng-demo/src/app/modules/prime-playground-modules.component.ts",
    templatePath: "apps/primeng-demo/src/app/modules/prime-playground-modules.component.html",
    preserveImports: true,
  },
  {
    name: "ng-zorro",
    componentPath: "apps/ng-zorro-demo/src/app/playground/nz-playground.component.ts",
    templatePath: "apps/ng-zorro-demo/src/app/playground/nz-playground.component.html",
  },
  {
    name: "ng-zorro-legacy-modules",
    componentPath: "apps/ng-zorro-demo/src/app/modules/nz-playground-modules.component.ts",
    templatePath: "apps/ng-zorro-demo/src/app/modules/nz-playground-modules.component.html",
    preserveImports: true,
  },
  {
    name: "taiga",
    componentPath: "apps/taiga-demo/src/app/playground/taiga-playground.component.ts",
    templatePath: "apps/taiga-demo/src/app/playground/taiga-playground.component.html",
  },
  {
    name: "material-overview",
    componentPath: "apps/angular-material-demo/src/app/overview/material-overview.component.ts",
    templatePath: "apps/angular-material-demo/src/app/overview/material-overview.component.html",
  },
  {
    name: "material-overview-imported",
    componentPath: "apps/angular-material-demo/src/app/overview/material-overview.component.ts",
    templatePath: "apps/angular-material-demo/src/app/overview/material-overview.component.html",
    preserveImports: true,
  },
  {
    name: "material-overview-legacy-modules",
    componentPath: "apps/angular-material-demo/src/app/modules/overview/material-overview.component.ts",
    templatePath: "apps/angular-material-demo/src/app/modules/overview/material-overview.component.html",
    preserveImports: true,
  },
  {
    name: "material-table",
    componentPath: "apps/angular-material-demo/src/app/table/material-table.component.ts",
    templatePath: "apps/angular-material-demo/src/app/table/material-table.component.html",
  },
];

/**
 * Builds a descriptor object from collected diagnostics and quickfixes.
 */
async function buildDescriptor(caseConfig: CaseConfig, templateUri: vscode.Uri, diagnostics: vscode.Diagnostic[]) {
  const diagnosticDescriptors = diagnostics.map((d) => ({
    code: String(d.code),
    severity: severityToString(d.severity),
    source: DIAGNOSTIC_SOURCE,
    startLine: d.range.start.line,
    startCharacter: d.range.start.character,
    endLine: d.range.end.line,
    endCharacter: d.range.end.character,
  }));

  // Collect quickfixes for each unique diagnostic code
  const quickfixMap = await collectQuickFixes(templateUri, diagnostics);

  const quickfixDescriptors: QuickfixDescriptor[] = [];
  for (const [code, actions] of quickfixMap) {
    for (const action of actions) {
      // Extract className and path from command arguments
      const element = action.command?.arguments?.[0] as
        | { name?: string; isExternal?: boolean; path?: string }
        | undefined;
      const className = element?.name ?? "";

      // For external elements, use the element path directly as moduleSpecifier
      // For local elements, extract from action title: "⟐ Import X from 'path'"
      let moduleSpecifier: string;
      if (element?.isExternal && element.path) {
        moduleSpecifier = element.path;
      } else {
        const moduleMatch = action.title.match(/from\s+'([^']+)'/);
        moduleSpecifier = moduleMatch?.[1] ?? "";
      }

      quickfixDescriptors.push({
        diagnosticCode: code,
        title: action.title,
        expectedImport: { className, moduleSpecifier },
      });
    }
  }

  return {
    case: caseConfig.name,
    componentPath: caseConfig.componentPath,
    templatePath: caseConfig.templatePath,
    modulePath: caseConfig.modulePath,
    preserveImports: caseConfig.preserveImports,
    diagnostics: diagnosticDescriptors,
    quickfixes: quickfixDescriptors,
  };
}

function getCaseRunContext(caseConfig: CaseConfig, workspaceRoot: string): CaseRunContext {
  const componentUri = vscode.Uri.file(path.join(workspaceRoot, caseConfig.componentPath));
  const templateUri = vscode.Uri.file(path.join(workspaceRoot, caseConfig.templatePath));
  const moduleUri = caseConfig.modulePath
    ? vscode.Uri.file(path.join(workspaceRoot, caseConfig.modulePath))
    : undefined;

  return {
    componentUri,
    templateUri,
    moduleUri,
    originalContent: fs.readFileSync(componentUri.fsPath, "utf-8"),
    originalModuleContent: moduleUri ? fs.readFileSync(moduleUri.fsPath, "utf-8") : undefined,
  };
}

async function prepareCaseFiles(caseConfig: CaseConfig, context: CaseRunContext): Promise<void> {
  if (caseConfig.preserveImports) {
    console.log("--- Original content ---");
    console.log(context.originalContent);
    console.log("--- Stripped content ---");
    console.log(context.originalContent);
    return;
  }

  const templateFileName = getTemplateFileName(caseConfig);
  const strippedContent = stripAngularImports(context.originalContent, templateFileName);

  console.log("--- Original content ---");
  console.log(context.originalContent);
  console.log("--- Stripped content ---");
  console.log(strippedContent);

  await replaceFileContent(context.componentUri, strippedContent);

  if (context.moduleUri && context.originalModuleContent !== undefined) {
    await replaceFileContent(context.moduleUri, stripNgModuleImports(context.originalModuleContent));
  }
}

function writeDescriptor(caseConfig: CaseConfig, descriptor: Awaited<ReturnType<typeof buildDescriptor>>): void {
  // Namespace descriptors by the Angular version of the active workspace
  // (folder name under src/e2e/projects, e.g. "v19", "v21").
  const version = path.basename(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "");
  const srcCasesDir = path.resolve(__dirname, "..", "..", "..", "src", "e2e", "cases", version, caseConfig.name);
  fs.mkdirSync(srcCasesDir, { recursive: true });

  const descriptorPath = path.join(srcCasesDir, "descriptor.json");
  fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf-8");

  console.log(`Descriptor written to ${descriptorPath}`);
  console.log(JSON.stringify(descriptor, null, 2));
}

async function restoreCaseFiles(context: CaseRunContext): Promise<void> {
  await replaceFileContent(context.componentUri, context.originalContent);

  if (context.moduleUri && context.originalModuleContent !== undefined) {
    await replaceFileContent(context.moduleUri, context.originalModuleContent);
  }

  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

describe("Descriptor Generator", function () {
  this.timeout(120000);

  // Activate the extension and build the index once for all cases. The project
  // doesn't change between cases, so a full reindex per case is wasteful — the
  // file watcher picks up the per-case strip/restore edits incrementally.
  before(async function () {
    this.timeout(90000);
    await waitForExtensionActivation();
  });

  for (const caseConfig of CASES.filter((config) => !CASE_FILTER || config.name === CASE_FILTER)) {
    it(`generate ${caseConfig.name}`, async function () {
      this.timeout(90000);

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        throw new Error("No workspace folder found");
      }

      const componentPath = path.join(workspaceRoot, caseConfig.componentPath);
      if (!fs.existsSync(componentPath)) {
        this.skip();
        return;
      }

      const context = getCaseRunContext(caseConfig, workspaceRoot);

      try {
        await prepareCaseFiles(caseConfig, context);

        // Open the template file to trigger diagnostics
        const doc = await vscode.workspace.openTextDocument(context.templateUri);
        await vscode.window.showTextDocument(doc);

        const diagnostics = await waitForDiagnosticsToStabilize(context.templateUri, DIAGNOSTIC_SOURCE);
        console.log(`Found ${diagnostics.length} diagnostics for ${caseConfig.name}`);

        const descriptor = await buildDescriptor(caseConfig, context.templateUri, diagnostics);
        writeDescriptor(caseConfig, descriptor);
      } finally {
        await restoreCaseFiles(context);
      }
    });
  }
});
