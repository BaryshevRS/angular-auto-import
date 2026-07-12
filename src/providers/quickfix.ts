/**
 *
 * Angular Auto-Import QuickFix Provider
 *
 * @module
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { logger } from "../logger";
import type { AngularIndexer } from "../services";
import * as TsConfigHelper from "../services/tsconfig";
import type { AngularElementData } from "../types";
import { getAngularElementAsync } from "../utils";
import { switchFileType } from "../utils/path";
import { getProjectContextForDocument } from "../utils/project-context";

import type { ProviderContext } from "./index";

/**
 * Provides QuickFix actions for Angular elements.
 */
export class QuickfixImportProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly context: ProviderContext) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): Promise<(vscode.Command | vscode.CodeAction)[]> {
    const filteredDiagnostics = this.filterRelevantDiagnostics(context, range, document);
    if (filteredDiagnostics.length === 0) {
      return [];
    }

    try {
      if (token?.isCancellationRequested) {
        return [];
      }

      const projCtx = this.getProjectContextForDocument(document);
      if (!projCtx) {
        return [];
      }

      const actions = await this.generateQuickFixActions(filteredDiagnostics, projCtx.indexer, document);
      return this.deduplicateAndSortActions(actions);
    } catch (error) {
      logger.error("QuickfixImportProvider: Critical error in provideCodeActions:", error as Error);
      return [];
    }
  }

  /**
   * Filters diagnostics that are relevant to the current range.
   * Gets diagnostics from both VSCode context and internal diagnostic provider storage.
   */
  private filterRelevantDiagnostics(
    context: vscode.CodeActionContext,
    range: vscode.Range | vscode.Selection,
    document: vscode.TextDocument
  ): vscode.Diagnostic[] {
    const contextDiagnostics = context?.diagnostics || [];

    // Also get diagnostics from internal storage (works in 'quickfix-only' mode)
    const internalDiagnostics = this.context.diagnosticProvider?.getDiagnosticsForDocument(document.uri) || [];

    // Merge and deduplicate
    const allDiagnostics = [...contextDiagnostics];
    for (const diag of internalDiagnostics) {
      const exists = allDiagnostics.some((d) => d.message === diag.message && d.range.isEqual(diag.range));
      if (!exists) {
        allDiagnostics.push(diag);
      }
    }

    return allDiagnostics.filter((diagnostic) => diagnostic.range.intersection(range));
  }

  /**
   * Generates quick fix actions for filtered diagnostics.
   */
  private async generateQuickFixActions(
    diagnostics: vscode.Diagnostic[],
    indexer: AngularIndexer,
    document: vscode.TextDocument
  ): Promise<vscode.CodeAction[]> {
    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of diagnostics) {
      if (!diagnostic?.message) {
        continue;
      }

      try {
        if (this.isFixableDiagnostic(diagnostic)) {
          const quickFixes = await this.createQuickFixesForDiagnostic(diagnostic, indexer, document);
          actions.push(...quickFixes);
        }
      } catch (error) {
        logger.error("QuickfixImportProvider: Error processing diagnostic:", error as Error);
      }
    }

    return actions;
  }

  /**
   * Deduplicates and sorts code actions.
   */
  private deduplicateAndSortActions(actions: vscode.CodeAction[]): vscode.CodeAction[] {
    const dedupedActionsMap = new Map<string, vscode.CodeAction>();

    for (const action of actions) {
      const key = this.getActionKey(action);
      const existingAction = dedupedActionsMap.get(key);

      if (existingAction) {
        if (action.isPreferred && !existingAction.isPreferred) {
          dedupedActionsMap.set(key, action);
        }
      } else {
        dedupedActionsMap.set(key, action);
      }
    }

    return Array.from(dedupedActionsMap.values()).sort((a, b) => {
      if (a.isPreferred && !b.isPreferred) {
        return -1;
      }
      if (!a.isPreferred && b.isPreferred) {
        return 1;
      }
      return a.title.localeCompare(b.title);
    });
  }

  /**
   * Creates a unique key for an action for deduplication.
   */
  private getActionKey(action: vscode.CodeAction): string {
    const cmd = action.command?.command || "";
    const args = JSON.stringify(action.command?.arguments || []);
    return `${cmd}:${args}`;
  }

  private isFixableDiagnostic(diagnostic: vscode.Diagnostic): boolean {
    // Only handle diagnostics from our own provider.
    return diagnostic.source === "angular-auto-import";
  }

  private async createQuickFixesForDiagnostic(
    diagnostic: vscode.Diagnostic,
    indexer: AngularIndexer,
    document: vscode.TextDocument
  ): Promise<vscode.CodeAction[]> {
    const actions: vscode.CodeAction[] = [];

    try {
      if (typeof diagnostic.code !== "string" || !diagnostic.code.includes(":")) {
        return [];
      }

      const diagnosticCodeParts = (diagnostic.code as string).split(":");
      const selectorToSearch = diagnosticCodeParts[1];
      // const encodedData = diagnosticCodeParts[2];

      if (selectorToSearch) {
        let elementData: AngularElementData | null = null;

        elementData = (await getAngularElementAsync(selectorToSearch, indexer)) ?? null;

        if (elementData) {
          // The selector passed to the command must be the one found in the index
          const action = await this.createCodeAction(elementData, diagnostic, document);
          if (action) {
            return [action];
          }
        }
      }
    } catch (error) {
      logger.error("QuickfixImportProvider: Error creating quick fixes:", error as Error);
    }

    return actions;
  }

  private async createCodeAction(
    element: AngularElementData,
    diagnostic: vscode.Diagnostic,
    document: vscode.TextDocument
  ): Promise<vscode.CodeAction | null> {
    try {
      const pathInfo = await this.getImportPathInfo(element, document);
      const title = `⟐ Import ${element.name} from '${pathInfo}'`;

      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

      action.command = {
        title: `Import ${element.name}`,
        command: "angular-auto-import.importElement",
        arguments: [element],
      };

      action.diagnostics = [diagnostic];
      action.isPreferred = true;

      return action;
    } catch (error) {
      logger.error("Error creating code action:", error as Error);
      return null;
    }
  }

  private async getImportPathInfo(element: AngularElementData, document: vscode.TextDocument): Promise<string> {
    if (element.isExternal) {
      return element.path;
    }

    const projectContext = this.getProjectContextForDocument(document);
    if (!projectContext) {
      // Fallback for safety, though it should ideally not happen
      return element.path;
    }

    const { projectRootPath } = projectContext;
    const absoluteCurrentFilePath = document.uri.fsPath;
    const absoluteTargetModulePath = path.join(projectRootPath, element.path);
    const absoluteTargetModulePathNoExt = switchFileType(absoluteTargetModulePath, "");

    return await TsConfigHelper.resolveImportPath(
      absoluteTargetModulePathNoExt,
      absoluteCurrentFilePath,
      projectRootPath
    );
  }

  private getProjectContextForDocument(document: vscode.TextDocument) {
    return getProjectContextForDocument(document, this.context.projectIndexers, this.context.projectTsConfigs);
  }
}
