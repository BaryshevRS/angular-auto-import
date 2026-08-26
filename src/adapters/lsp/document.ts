import type { TextDocument } from "vscode-languageserver-textdocument";
import type { DocumentView } from "../../core/document";

/** Adapts a synchronized LSP document to the editor-agnostic core document boundary. */
export function toDocumentView(document: TextDocument): DocumentView {
  return {
    uri: document.uri,
    languageId: document.languageId,
    version: document.version,
    getText: () => document.getText(),
    offsetAt: (position) => document.offsetAt(position),
    positionAt: (offset) => document.positionAt(offset),
  };
}
