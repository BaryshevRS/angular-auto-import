/**
 * Applies an import plan to a component file.
 *
 * Planning lives in `core/import-planner`; this module only decides where the file's
 * current text comes from and how the resulting edit reaches it — through the open
 * editor when the file is open, so unsaved changes are preserved, or straight to disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { toVsCodeRange } from "../adapters/vscode/language-types";
import { type ImportPlan, planImports } from "../core/import-planner";
import { logger } from "../logger";
import * as TsConfigHelper from "../services/tsconfig";
import type { AngularElementData, ProcessedTsConfig } from "../types";
import { switchFileType } from "./path";

/**
 * Gets the active VSCode document for a given file path.
 * @param filePath The absolute path to the file.
 * @returns The active `vscode.TextDocument` or `undefined` if not found.
 * @internal
 */
function getActiveDocument(filePath: string): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === filePath);
}

/**
 * Reads the file as the user currently sees it: the open editor's text when there is
 * one, the file on disk otherwise.
 * @internal
 */
function readCurrentContent(componentFilePathAbs: string): { text: string; version: number } {
  const activeDocument = getActiveDocument(componentFilePathAbs);
  if (activeDocument) {
    return { text: activeDocument.getText(), version: activeDocument.version };
  }
  return { text: fs.readFileSync(componentFilePathAbs, "utf-8"), version: 0 };
}

/**
 * Applies a planned edit through the open editor when there is one, or straight to disk.
 * @internal
 */
async function applyImportPlan(plan: ImportPlan): Promise<boolean> {
  const [edit] = plan.edits;
  if (!edit) {
    return true;
  }

  const activeDocument = getActiveDocument(plan.filePath);
  if (!activeDocument) {
    fs.writeFileSync(plan.filePath, edit.newText);
    return true;
  }

  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.replace(activeDocument.uri, toVsCodeRange(edit.range), edit.newText);

  if (!(await vscode.workspace.applyEdit(workspaceEdit))) {
    logger.error(`Failed to apply WorkspaceEdit to ${path.basename(plan.filePath)}`);
    return false;
  }

  await activeDocument.save();
  return true;
}

/**
 * Imports multiple Angular elements into a component file. This function handles adding the import statements
 * and updating the `@Component` decorator's `imports` array for all elements in one operation.
 *
 * @param elements An array of Angular elements to import.
 * @param componentFilePathAbs The absolute path to the component file.
 * @param projectRootPath The root path of the project.
 * @param indexerProject The ts-morph project instance.
 * @param _tsConfig The processed tsconfig.json.
 * @returns A promise that resolves to `true` if the import was successful, `false` otherwise.
 */
export async function importElementsToFile(
  elements: AngularElementData[],
  componentFilePathAbs: string,
  projectRootPath: string,
  indexerProject: import("ts-morph").Project,
  _tsConfig: ProcessedTsConfig | null
): Promise<boolean> {
  try {
    if (!indexerProject) {
      logger.error("ts-morph Project instance is required for importElementsToFile");
      return false;
    }

    const { text, version } = readCurrentContent(componentFilePathAbs);
    const plan = await planImports({
      filePath: componentFilePathAbs,
      text,
      version,
      elements,
      project: indexerProject,
      resolveImportPath: (element) => resolveImportPathForElement(element, componentFilePathAbs, projectRootPath),
      logger,
    });

    return await applyImportPlan(plan);
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error("Error importing elements:", error);
    vscode.window.showErrorMessage(`Error importing elements: ${error.message}`);
    return false;
  }
}

/**
 * Resolves the import path for a given Angular element.
 * @param element The Angular element.
 * @param componentFilePathAbs The absolute path of the component file where the import will be added.
 * @param projectRootPath The project's root path.
 * @returns The resolved import path string.
 * @internal
 */
async function resolveImportPathForElement(
  element: AngularElementData,
  componentFilePathAbs: string,
  projectRootPath: string
): Promise<string> {
  if (element.isExternal) {
    return element.path;
  }
  // For project elements, resolve the path using tsconfig aliases or relative paths.
  const absoluteTargetModulePath = path.join(projectRootPath, element.path);
  const absoluteTargetModulePathNoExt = switchFileType(absoluteTargetModulePath, "");

  return TsConfigHelper.resolveImportPath(absoluteTargetModulePathNoExt, componentFilePathAbs, projectRootPath);
}
