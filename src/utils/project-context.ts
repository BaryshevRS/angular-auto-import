/**
 * Utility functions for managing project context and document-to-project mapping.
 *
 * @module
 */

import type * as vscode from "vscode";
import { findDeepestContainingEntry } from "../core/project-registry";
import { logger } from "../logger";
import type { AngularIndexer } from "../services/indexer";
import type { ProjectContext } from "../types/angular";
import type { ProcessedTsConfig } from "../types/tsconfig";

export { findDeepestContainingProjectContext } from "../core/project-registry";

/**
 * Finds the project context (indexer and tsConfig) for a given document.
 * First tries to find by workspace folder, then falls back to checking all known project roots.
 *
 * @param document The document to find the project context for.
 * @param projectIndexers Map of project root paths to their indexers.
 * @param projectTsConfigs Map of project root paths to their tsConfigs.
 * @returns The project context or undefined if not found.
 */
export function getProjectContextForDocument(
  document: vscode.TextDocument,
  projectIndexers: Map<string, AngularIndexer>,
  projectTsConfigs: Map<string, ProcessedTsConfig | null>
): ProjectContext | undefined {
  const entry = findDeepestContainingEntry(document.uri.fsPath, projectIndexers);
  if (!entry) {
    return undefined;
  }

  const [projectRootPath, indexer] = entry;
  const tsConfig = projectTsConfigs.get(projectRootPath) ?? null;
  return { projectRootPath, indexer, tsConfig };
}

/**
 * Gets project context for a document and logs a warning if not found.
 *
 * @param document The document to find the project context for.
 * @param projectIndexers Map of project root paths to their indexers.
 * @param projectTsConfigs Map of project root paths to their tsConfigs.
 * @returns The project context or undefined if not found.
 */
export function getProjectContextForDocumentWithLogging(
  document: vscode.TextDocument,
  projectIndexers: Map<string, AngularIndexer>,
  projectTsConfigs: Map<string, ProcessedTsConfig | null>
): ProjectContext | undefined {
  const context = getProjectContextForDocument(document, projectIndexers, projectTsConfigs);

  if (!context) {
    logger.warn(`Document ${document.uri.fsPath} does not belong to any known workspace folder or project root`);
  }

  return context;
}
