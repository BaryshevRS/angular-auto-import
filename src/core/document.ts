import { fileURLToPath, pathToFileURL } from "node:url";

export interface DocumentPosition {
  line: number;
  character: number;
}

/** Minimal document surface shared by the Extension Host and language server. */
export interface DocumentView {
  uri: string;
  languageId: string;
  version: number;
  getText(): string;
  offsetAt(position: DocumentPosition): number;
  positionAt(offset: number): DocumentPosition;
}

/**
 * The `file:` URI naming a path, for the one direction this codebase used to lack.
 *
 * An agent names paths, not URIs, and everything downstream of discovery is addressed by
 * URI. Built with Node's own converter so it round-trips through {@link fileUriToPath}
 * on every platform, drive letters and spaces included.
 * @param filePath Absolute path to name.
 */
export function pathToFileUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

/** Converts an LSP-style file URI into the platform's native filesystem path. */
export function fileUriToPath(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== "file:") {
    throw new Error(`Expected a file URI, received: ${uri}`);
  }
  return fileURLToPath(parsed);
}
