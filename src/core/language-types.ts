import type { DocumentPosition } from "./document";

export interface CoreRange {
  start: DocumentPosition;
  end: DocumentPosition;
}

/** Completion kinds currently emitted by Angular Auto Import analysis. */
export type CoreCompletionKind = "class" | "function" | "keyword" | "property";

export type CoreDiagnosticSeverity = "error" | "warning" | "information" | "hint";
