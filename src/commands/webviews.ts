/**
 * VS Code adapter for the project-wide missing-import audit webview.
 * @module
 */

import * as vscode from "vscode";
import type { DiagnosticsReport } from "../lsp/protocol";
import { renderMissingImportAuditHtml } from "./report-webview";

/** Renders the audit DTO using workspace-relative labels and a caller-owned CSP nonce. */
export function renderDiagnosticsReportHtml(report: DiagnosticsReport, nonce: string, loading = false): string {
  return renderMissingImportAuditHtml(report, {
    nonce,
    relativePath: (filePath) => vscode.workspace.asRelativePath(filePath),
    loading,
  });
}
