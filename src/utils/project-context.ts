/**
 * Utility functions for managing project context and document-to-project mapping.
 *
 * @module
 */

import * as path from "node:path";
import type * as vscode from "vscode";
import { logger } from "../logger";
import type { AngularIndexer } from "../services/indexer";
import type { ProjectContext } from "../types/angular";
import type { ProcessedTsConfig } from "../types/tsconfig";

function findDeepestContainingEntry<T>(filePath: string, contexts: ReadonlyMap<string, T>): [string, T] | undefined {
  const normalizedFilePath = path.resolve(filePath);
  let deepestEntry: [string, T] | undefined;

  for (const [rootPath, context] of contexts) {
    const normalizedRoot = path.resolve(rootPath);
    const relativePath = path.relative(normalizedRoot, normalizedFilePath);
    const isInside =
      relativePath === "" ||
      (!path.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`));
    if (isInside && (!deepestEntry || normalizedRoot.length > deepestEntry[0].length)) {
      deepestEntry = [normalizedRoot, context];
    }
  }

  return deepestEntry;
}

/** Returns the value belonging to the deepest root that contains filePath. */
export function findDeepestContainingProjectContext<T>(
  filePath: string,
  contexts: ReadonlyMap<string, T>
): T | undefined {
  return findDeepestContainingEntry(filePath, contexts)?.[1];
}

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
