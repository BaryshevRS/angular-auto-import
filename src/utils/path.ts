/**
 * Utilities for working with file paths.
 * @module
 */
import * as path from "node:path";

/**
 * Normalizes a path by replacing backslashes with forward slashes.
 *
 * @param p The path to normalize.
 * @returns The normalized path.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Replaces or removes the extension of a file path.
 *
 * @param filePath The original file path.
 * @param newExtensionWithDotOrEmpty The new extension (e.g., '.ts') or an empty string to remove the extension.
 * @returns The modified file path.
 */
export function switchFileType(filePath: string, newExtensionWithDotOrEmpty: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseWithoutExt = path.basename(filePath, ext);

  if (newExtensionWithDotOrEmpty === "") {
    return path.join(dir, baseWithoutExt);
  } else {
    const finalExtension = newExtensionWithDotOrEmpty.startsWith(".")
      ? newExtensionWithDotOrEmpty
      : `.${newExtensionWithDotOrEmpty}`;
    return path.join(dir, `${baseWithoutExt}${finalExtension}`);
  }
}

/**
 * Calculates the relative path from one file to another.
 *
 * @param fromFileAbs The absolute path of the source file.
 * @param toFileAbsNoExt The absolute path of the target file, without the extension.
 * @returns The relative path.
 */
export function getRelativeFilePath(fromFileAbs: string, toFileAbsNoExt: string): string {
  const relative = path.relative(path.dirname(fromFileAbs), toFileAbsNoExt);
  const normalized = normalizePath(relative);
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

/** Returns whether candidatePath is rootPath itself or one of its descendants. */
export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relativePath === "" ||
    (!path.isAbsolute(relativePath) && !relativePath.startsWith(`..${path.sep}`) && relativePath !== "..")
  );
}
