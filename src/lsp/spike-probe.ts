/**
 * The development-only completion probe the lifecycle suite drives.
 *
 * It answers only for documents carrying the spike marker, which no real project file
 * does, so it can prove that a document is synchronized and that the connection
 * survived a crash without needing an indexed Angular project in the fixture. It is
 * removed together with the direct-provider fallback in the rollout phase.
 * @module
 */

import type { CompletionItem } from "vscode-languageserver/node";
import { toLspCompletionKind } from "../adapters/lsp/language-types";
import type { DocumentPosition, DocumentView } from "../core/document";

const SPIKE_MARKER = "angular-auto-import-lsp-spike";
const SPIKE_TRIGGER = "<sp";

/**
 * Answers the marker document's completion request, or nothing at all.
 * @param document The document the request arrived for.
 * @param position The cursor position.
 * @param runtimeDependenciesLoaded Whether the heavy dependencies loaded in this process.
 */
export function probeCompletion(
  document: DocumentView,
  position: DocumentPosition,
  runtimeDependenciesLoaded: boolean
): CompletionItem[] {
  const text = document.getText();
  if (!text.includes(SPIKE_MARKER) || !text.slice(0, document.offsetAt(position)).endsWith(SPIKE_TRIGGER)) {
    return [];
  }

  return [
    {
      label: "aai-lsp-spike",
      kind: toLspCompletionKind("class"),
      insertText: "lsp-spike",
      detail: runtimeDependenciesLoaded
        ? "Angular Auto Import LSP spike (runtime dependencies loaded)"
        : "Angular Auto Import LSP spike",
    },
  ];
}
