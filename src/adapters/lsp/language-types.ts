import { CompletionItemKind, type Diagnostic, DiagnosticSeverity } from "vscode-languageserver/node";
import type { CoreCompletionKind, CoreDiagnosticSeverity } from "../../core/language-types";
import type { MissingImportDiagnostic } from "../../core/missing-imports";

const completionKinds: Record<CoreCompletionKind, CompletionItemKind> = {
  class: CompletionItemKind.Class,
  function: CompletionItemKind.Function,
  keyword: CompletionItemKind.Keyword,
  property: CompletionItemKind.Property,
};

const diagnosticSeverities: Record<CoreDiagnosticSeverity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  information: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

export function toLspCompletionKind(kind: CoreCompletionKind): CompletionItemKind {
  return completionKinds[kind];
}

export function toLspDiagnosticSeverity(severity: CoreDiagnosticSeverity): DiagnosticSeverity {
  return diagnosticSeverities[severity];
}

/** Maps a core diagnostic onto the one the client renders. */
export function toLspDiagnostic(diagnostic: MissingImportDiagnostic): Diagnostic {
  return {
    range: diagnostic.range,
    message: diagnostic.message,
    severity: toLspDiagnosticSeverity(diagnostic.severity),
    code: diagnostic.code,
    source: diagnostic.source,
  };
}
