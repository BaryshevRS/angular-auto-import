import { CompletionItemKind } from "vscode-languageserver/node";
import type { CoreCompletionKind } from "../../core/language-types";

const completionKinds: Record<CoreCompletionKind, CompletionItemKind> = {
  class: CompletionItemKind.Class,
  function: CompletionItemKind.Function,
  keyword: CompletionItemKind.Keyword,
  property: CompletionItemKind.Property,
};

export function toLspCompletionKind(kind: CoreCompletionKind): CompletionItemKind {
  return completionKinds[kind];
}
