/**
 * Bringing a ts-morph source file up to the text being analyzed.
 *
 * The project's source files come from disk, but analysis runs against what the user
 * is looking at, which may never have been saved. Every caller therefore needs the same
 * three-way handling — absent, stale, already current — and getting it wrong means
 * analyzing a file the user has already changed.
 * @module
 */

import type { Project, SourceFile } from "ts-morph";

/**
 * Returns the project's source file for a path, holding exactly the given text.
 * @param project The ts-morph project to read and update.
 * @param filePath Absolute path of the file.
 * @param text The text to analyze against.
 */
export function syncSourceFile(project: Project, filePath: string, text: string): SourceFile {
  const sourceFile = project.getSourceFile(filePath);
  if (!sourceFile) {
    return project.createSourceFile(filePath, text, { overwrite: true });
  }

  if (sourceFile.getFullText() !== text) {
    sourceFile.replaceWithText(text);
  }
  return sourceFile;
}
