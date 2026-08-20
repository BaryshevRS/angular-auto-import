import * as fs from "node:fs";

import * as vscode from "vscode";

import { findComponentDecorator, getImportsArrayInfo, parseContent } from "./strip-imports";

export { stripAngularImports, stripNgModuleImports } from "./strip-imports";

/**
 * Result of verifying whether an import was correctly added to a component file.
 */
export interface ImportVerificationResult {
  hasImportStatement: boolean;
  hasInImportsArray: boolean;
}

/**
 * Verifies that a class is properly imported in a component file.
 * Checks both the TypeScript `import { ... } from '...'` statement
 * and the `imports: [...]` array in the `@Component` decorator.
 *
 * @param content - The component file content
 * @param className - The class name to look for (e.g. "UiDemoOneComponent")
 * @param moduleSpecifier - The module path to look for (e.g. "@angular-demo/ui-demo-one")
 * @param templateFileName - Optional template file name to match against templateUrl
 * @returns Verification result with both checks
 */
export function verifyImportInComponent(
  content: string,
  className: string,
  moduleSpecifier: string,
  templateFileName?: string
): ImportVerificationResult {
  const sourceFile = parseContent(content);

  // Check TypeScript import statement
  const importDecl = sourceFile.getImportDeclaration(
    (d) =>
      d.getModuleSpecifierValue() === moduleSpecifier && d.getNamedImports().some((ni) => ni.getName() === className)
  );
  const hasImportStatement = importDecl !== undefined;

  // Check @Component imports array
  const decorator = findComponentDecorator(sourceFile, templateFileName);
  let hasInImportsArray = false;
  if (decorator) {
    const info = getImportsArrayInfo(decorator);
    if (info) {
      hasInImportsArray = info.elementNames.some((name) => name === className);
    }
  }

  return { hasImportStatement, hasInImportsArray };
}

const EXTENSION_ID = "baryshevrs.angular-auto-import";

/**
 * Writes content to a file on disk and reverts the VS Code document if it's open.
 *
 * @param uri - The file URI to write to
 * @param content - The new file content
 */
export async function replaceFileContent(uri: vscode.Uri, content: string): Promise<void> {
  fs.writeFileSync(uri.fsPath, content, "utf-8");

  // If the document is open in VS Code, revert it to pick up disk changes
  const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  if (openDoc) {
    await vscode.commands.executeCommand("workbench.action.files.revert");
  }
}

/**
 * Waits for a file change event on the specified URI.
 * Resolves when `onDidChangeTextDocument` fires for the URI, or after timeout as safety net.
 *
 * @param uri - The file URI to watch
 * @param timeoutMs - Maximum wait time in milliseconds
 */
export function waitForFileChange(uri: vscode.Uri, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      resolve();
    }, timeoutMs);

    const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === uri.toString()) {
        clearTimeout(timeout);
        disposable.dispose();
        resolve();
      }
    });
  });
}

/**
 * Waits for the extension to be activated and ready.
 *
 * @param timeoutMs - Maximum wait time
 */
export async function waitForExtensionActivation(timeoutMs = 30000): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) {
    throw new Error(`Extension ${EXTENSION_ID} not found`);
  }

  if (!ext.isActive) {
    await ext.activate();
  }

  // Wait for commands to be registered, then force a full reindex and await completion.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes("angular-auto-import.reindex")) {
      await vscode.commands.executeCommand("angular-auto-import.reindex");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Extension ${EXTENSION_ID} did not activate within ${timeoutMs}ms`);
}
