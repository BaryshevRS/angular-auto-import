import * as vscode from "vscode";
import type { CoreCompletionKind, CoreDiagnosticSeverity, CoreRange } from "../../core/language-types";

const completionKinds: Record<CoreCompletionKind, vscode.CompletionItemKind> = {
  class: vscode.CompletionItemKind.Class,
  function: vscode.CompletionItemKind.Function,
  keyword: vscode.CompletionItemKind.Keyword,
  property: vscode.CompletionItemKind.Property,
};

const diagnosticSeverities: Record<CoreDiagnosticSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

export function toVsCodeRange(range: CoreRange): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

export function toVsCodeCompletionKind(kind: CoreCompletionKind): vscode.CompletionItemKind {
  return completionKinds[kind];
}

export function toVsCodeDiagnosticSeverity(severity: CoreDiagnosticSeverity): vscode.DiagnosticSeverity {
  return diagnosticSeverities[severity];
}
