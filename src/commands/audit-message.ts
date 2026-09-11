import type { AppliedWorkspaceFixAll, DiagnosticsReport, PreparedWorkspaceFixAll } from "../lsp/protocol";

/** Formats the notification shown after the audit panel opens. */
export function formatAuditCompletionMessage(report: DiagnosticsReport): string {
  const outcome = report.complete ? "complete" : "incomplete";
  return `Missing import audit ${outcome}: ${count(report.totalIssues, "finding")} across ${count(report.templatesScanned, "scanned template")}.`;
}

/** Describes every terminal Fix All outcome without pretending a rejected edit succeeded. */
export function formatFixAllResultMessage(result: PreparedWorkspaceFixAll | AppliedWorkspaceFixAll): string {
  if ("ready" in result && !result.ready) {
    return "None of these findings could be fixed automatically; no files were changed.";
  }
  if (!("applied" in result) || result.applied) {
    const added = `Added ${count(result.importsAdded, "import")} to ${count(result.filesChanged, "file")}.`;
    // What was skipped is the half a reader cannot see: the panel refreshes to a shorter
    // list, and without this the leftovers read as a Fix All that quietly missed them.
    return result.skippedIssues > 0
      ? `${added} Left ${count(result.skippedIssues, "finding")} unfixed: the owning component could not be edited automatically.`
      : added;
  }
  if (result.reason === "stale") {
    return "The prepared Fix All is stale because project files changed. Run the audit again.";
  }
  if (result.reason === "consumed") {
    return "This Fix All was already used. Run the audit again.";
  }
  return "The project-wide Fix All was rejected by the editor; no files were changed.";
}

function count(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}
