import { fileURLToPath } from "node:url";

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

/** Converts an LSP-style file URI into the platform's native filesystem path. */
export function fileUriToPath(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== "file:") {
    throw new Error(`Expected a file URI, received: ${uri}`);
  }
  return fileURLToPath(parsed);
}
