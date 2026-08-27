import type { DiagnosticsReport } from "../lsp/protocol";

/** Formats the notification shown after the audit panel opens. */
export function formatAuditCompletionMessage(report: DiagnosticsReport): string {
  const outcome = report.complete ? "complete" : "incomplete";
  return `Missing import audit ${outcome}: ${report.totalIssues} issue(s) across ${report.templatesScanned} scanned template(s).`;
}
