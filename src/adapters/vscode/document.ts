import * as vscode from "vscode";
import type { DocumentView } from "../../core/document";

/** Adapts a VS Code document to the editor-agnostic core document boundary. */
export function toDocumentView(document: vscode.TextDocument): DocumentView {
  return {
    uri: document.uri.toString(),
    languageId: document.languageId,
    version: document.version,
    getText: () => document.getText(),
    offsetAt: (position) => document.offsetAt(new vscode.Position(position.line, position.character)),
    positionAt: (offset) => document.positionAt(offset),
  };
}
