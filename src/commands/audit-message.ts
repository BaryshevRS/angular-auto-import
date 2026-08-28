import type { AppliedWorkspaceFixAll, DiagnosticsReport, PreparedWorkspaceFixAll } from "../lsp/protocol";

/** Formats the notification shown after the audit panel opens. */
export function formatAuditCompletionMessage(report: DiagnosticsReport): string {
  const outcome = report.complete ? "complete" : "incomplete";
  return `Missing import audit ${outcome}: ${report.totalIssues} issue(s) across ${report.templatesScanned} scanned template(s).`;
}

/** Uses the server's prepared edit counts, which can differ from raw diagnostics. */
export function formatFixAllConfirmationMessage(prepared: Extract<PreparedWorkspaceFixAll, { ready: true }>): string {
  return `Apply ${prepared.importsAdded} missing imports across ${prepared.filesChanged} files?`;
}

/** Describes every terminal Fix All outcome without pretending a rejected edit succeeded. */
export function formatFixAllResultMessage(result: PreparedWorkspaceFixAll | AppliedWorkspaceFixAll): string {
  if ("ready" in result && !result.ready) {
    return "These findings could not be fixed safely. Run the audit again after resolving ambiguous owners.";
  }
  if (!("applied" in result) || result.applied) {
    return `Applied ${result.importsAdded} missing imports across ${result.filesChanged} files.`;
  }
  if (result.reason === "stale") {
    return "The prepared Fix All is stale because project files changed. Run the audit again.";
  }
  if (result.reason === "consumed") {
    return "This Fix All was already used. Run the audit again.";
  }
  return "The project-wide Fix All was rejected by the editor; no files were changed.";
}
