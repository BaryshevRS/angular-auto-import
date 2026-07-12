/**
 * Angular Auto-Import Definition Provider
 *
 * Provides "Go to Definition" (Ctrl+Click) functionality for Angular elements
 * highlighted by diagnostics but not yet imported.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { logger } from "../logger";
import type { AngularElementData } from "../types";
import { getAngularElements } from "../utils";
import { getProjectContextForDocument } from "../utils/project-context";
import type { ProviderContext } from "./index";

/**
 * Provides definition links for unimported Angular elements.
 *
 * This provider only responds when:
 * 1. The position has a diagnostic from angular-auto-import
 * 2. The element is not yet imported (identified by diagnostic presence)
 *
 * This strategy prevents conflicts with Angular Language Service,
 * which handles already-imported elements.
 */
export class DefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly context: ProviderContext) {}

  /**
   * Provides definition information for the given position.
   *
   * @param document - The document in which the command was invoked
   * @param position - The position at which the command was invoked
   * @param token - A cancellation token
   * @returns Definition locations or undefined if not applicable
   */
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
    try {
      if (token?.isCancellationRequested) {
        return undefined;
      }

      // Only handle positions that have OUR diagnostic
      const diagnostic = this.getDiagnosticAtPosition(document, position);
      if (!diagnostic) {
        // No diagnostic = element is already imported or not an Angular element
        // Let Angular Language Service handle it
        return undefined;
      }

      // Extract selector from diagnostic code
      const selector = this.extractSelectorFromDiagnostic(diagnostic);
      if (!selector) {
        logger.debug("[DefinitionProvider] Could not extract selector from diagnostic");
        return undefined;
      }

      // Find all matching elements in the indexer
      const matches = this.findMatchingElements(document, selector);
      if (matches.length === 0) {
        logger.debug(`[DefinitionProvider] No matches found for selector: ${selector}`);
        return undefined;
      }

      // Build LocationLink objects for all matches
      const locationLinks = this.buildLocationLinks(matches, diagnostic.range, document);

      logger.debug(`[DefinitionProvider] Found ${locationLinks.length} definition(s) for selector: ${selector}`);

      return locationLinks;
    } catch (error) {
      logger.error("[DefinitionProvider] Error in provideDefinition:", error as Error);
      return undefined;
    }
  }

  /**
   * Gets the angular-auto-import diagnostic at the given position.
   *
   * Checks both VS Code's diagnostic collection and internal diagnostics
   * (for quickfix-only mode).
   *
   * @param document - The document to check
   * @param position - The position to check
   * @returns The diagnostic if found, undefined otherwise
   */
  private getDiagnosticAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Diagnostic | undefined {
    // Get diagnostics from VS Code's collection
    const vscDiagnostics = vscode.languages.getDiagnostics(document.uri);

    // Also check internal diagnostics (works in quickfix-only mode)
    const internalDiagnostics = this.context.diagnosticProvider?.getDiagnosticsForDocument(document.uri) || [];

    // Merge and deduplicate
    const allDiagnostics = [...vscDiagnostics];
    for (const diag of internalDiagnostics) {
      const exists = allDiagnostics.some((d) => d.message === diag.message && d.range.isEqual(diag.range));
      if (!exists) {
        allDiagnostics.push(diag);
      }
    }

    // Find diagnostic from our extension at the given position
    return allDiagnostics.find((d) => d.source === "angular-auto-import" && d.range.contains(position));
  }

  /**
   * Extracts the selector from a diagnostic code.
   *
   * Diagnostic code format: "missing-{type}-import:{selector}"
   *
   * @param diagnostic - The diagnostic to extract from
   * @returns The selector string or undefined
   */
  private extractSelectorFromDiagnostic(diagnostic: vscode.Diagnostic): string | undefined {
    if (typeof diagnostic.code !== "string" || !diagnostic.code.includes(":")) {
      return undefined;
    }

    const parts = diagnostic.code.split(":");
    return parts[1]; // The selector is after the first colon
  }

  /**
   * Finds all Angular elements matching the given selector.
   *
   * @param document - The document context
   * @param selector - The selector to search for
   * @returns Array of matching Angular elements
   */
  private findMatchingElements(document: vscode.TextDocument, selector: string): AngularElementData[] {
    const projCtx = this.getProjectContextForDocument(document);
    if (!projCtx) {
      return [];
    }

    return getAngularElements(selector, projCtx.indexer);
  }

  /**
   * Builds LocationLink objects for all matching elements.
   *
   * @param matches - Array of matching Angular elements
   * @param originRange - The range in the source document
   * @param document - The source document
   * @returns Array of LocationLink objects
   */
  private buildLocationLinks(
    matches: AngularElementData[],
    originRange: vscode.Range,
    document: vscode.TextDocument
  ): vscode.LocationLink[] {
    const links: vscode.LocationLink[] = [];
    const projCtx = this.getProjectContextForDocument(document);
    if (!projCtx) {
      return links;
    }

    for (const match of matches) {
      try {
        const targetLocation = this.getElementLocation(match, projCtx.projectRootPath);
        if (targetLocation) {
          links.push({
            originSelectionRange: originRange,
            targetUri: targetLocation.uri,
            targetRange: targetLocation.range,
            targetSelectionRange: targetLocation.range, // Highlight the entire class declaration
          });
        }
      } catch (error) {
        logger.error(`[DefinitionProvider] Error building LocationLink for ${match.name}:`, error as Error);
      }
    }

    return links;
  }

  /**
   * Gets the location of an Angular element in its source file.
   *
   * @param element - The Angular element to locate
   * @param projectRootPath - The project root path
   * @returns Location object or undefined if not found
   */
  private getElementLocation(element: AngularElementData, projectRootPath: string): vscode.Location | undefined {
    try {
      // For external elements, use the absolutePath stored during indexing
      let absolutePath: string | undefined;

      if (element.isExternal && element.absolutePath) {
        absolutePath = element.absolutePath;
      } else if (!element.isExternal) {
        absolutePath = path.join(projectRootPath, element.path);
      } else {
        // Fallback: try to resolve external path
        absolutePath = this.resolveExternalPath(element.path, projectRootPath);
      }

      if (!absolutePath) {
        logger.debug(`[DefinitionProvider] Could not resolve path for element: ${element.name}`);
        return undefined;
      }

      // Check if the file exists
      if (!fs.existsSync(absolutePath)) {
        logger.debug(`[DefinitionProvider] File does not exist: ${absolutePath}`);
        return undefined;
      }

      const uri = vscode.Uri.file(absolutePath);

      // Get the project and source file
      const indexer = this.context.projectIndexers.get(projectRootPath);
      if (!indexer) {
        return new vscode.Location(uri, new vscode.Position(0, 0));
      }

      let sourceFile = indexer.project.getSourceFile(absolutePath);

      // For external files not in the project, try to add them temporarily
      if (!sourceFile && element.isExternal) {
        try {
          const fileContent = fs.readFileSync(absolutePath, "utf-8");
          sourceFile = indexer.project.createSourceFile(absolutePath, fileContent, { overwrite: true });
        } catch {
          logger.debug(`[DefinitionProvider] Could not read external file ${absolutePath}`);
          // Return file location at start of file
          return new vscode.Location(uri, new vscode.Position(0, 0));
        }
      }

      if (!sourceFile) {
        logger.debug(`[DefinitionProvider] Source file not found in project: ${absolutePath}`);
        // Fallback: return file location without specific range
        return new vscode.Location(uri, new vscode.Position(0, 0));
      }

      // Find the class declaration
      const classDeclaration = sourceFile.getClass(element.name);
      if (!classDeclaration) {
        logger.debug(`[DefinitionProvider] Class ${element.name} not found in ${absolutePath}`);
        // Fallback: return file location
        return new vscode.Location(uri, new vscode.Position(0, 0));
      }

      // Get the range of the class name (not the entire declaration)
      const nameNode = classDeclaration.getNameNode();
      if (nameNode) {
        const start = sourceFile.getLineAndColumnAtPos(nameNode.getStart());
        const end = sourceFile.getLineAndColumnAtPos(nameNode.getEnd());

        const range = new vscode.Range(
          new vscode.Position(start.line - 1, start.column - 1),
          new vscode.Position(end.line - 1, end.column - 1)
        );

        return new vscode.Location(uri, range);
      }

      // Fallback: use the entire class declaration
      const start = sourceFile.getLineAndColumnAtPos(classDeclaration.getStart());
      const end = sourceFile.getLineAndColumnAtPos(classDeclaration.getEnd());

      const range = new vscode.Range(
        new vscode.Position(start.line - 1, start.column - 1),
        new vscode.Position(end.line - 1, end.column - 1)
      );

      return new vscode.Location(uri, range);
    } catch (error) {
      logger.error(`[DefinitionProvider] Error getting element location:`, error as Error);
      return undefined;
    }
  }

  /**
   * Resolves the path for an external library element.
   *
   * @param importPath - The import path (e.g., "@angular/material/button")
   * @param projectRootPath - The project root path
   * @returns Absolute file path or undefined
   */
  private resolveExternalPath(importPath: string, projectRootPath: string): string | undefined {
    try {
      // Try to resolve via node_modules
      const nodeModulesPath = path.join(projectRootPath, "node_modules", importPath);

      // Check if it's a direct .ts file reference
      if (importPath.endsWith(".ts")) {
        return nodeModulesPath;
      }

      // Try common patterns for Angular libraries
      const patterns = [
        `${nodeModulesPath}.ts`,
        `${nodeModulesPath}/index.ts`,
        `${nodeModulesPath}/public-api.ts`,
        `${nodeModulesPath}/src/index.ts`,
      ];

      for (const pattern of patterns) {
        try {
          const indexer = this.context.projectIndexers.get(projectRootPath);
          if (indexer?.project.getSourceFile(pattern)) {
            return pattern;
          }
        } catch {
          // Continue to next pattern
        }
      }

      // Fallback: return the node_modules path
      return nodeModulesPath;
    } catch (error) {
      logger.error(`[DefinitionProvider] Error resolving external path ${importPath}:`, error as Error);
      return undefined;
    }
  }

  /**
   * Gets the project context for a document.
   *
   * @param document - The document to get context for
   * @returns Project context or null
   */
  private getProjectContextForDocument(document: vscode.TextDocument) {
    return getProjectContextForDocument(document, this.context.projectIndexers, this.context.projectTsConfigs);
  }
}
