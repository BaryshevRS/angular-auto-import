/**
 * How the client renders what the analysis produced.
 *
 * Presentation belongs to the client whatever computed the numbers, so every renderer
 * here takes a plain DTO and knows nothing about where it came from — the Extension
 * Host's own indexers, or a language server reporting on its own process.
 * @module
 */

import * as vscode from "vscode";
import type { CoreDiagnosticSeverity } from "../core/language-types";
import type { DiagnosticsReport, FileDiagnosticsReport, PerformanceMetrics, ReportedDiagnostic } from "../lsp/protocol";

/** Bytes to whole megabytes, which is the only precision these numbers deserve. */
function megabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

/**
 * Lays out the metrics as the text {@link renderPerformanceMetricsHtml} turns into HTML.
 *
 * Shared so the Extension Host and the language server report the same thing the same
 * way; only `subject` differs, because it matters a great deal to the reader whether
 * these are the editor's numbers or a separate process's.
 * @param metrics The measured process and its projects.
 * @param subject What the numbers describe, named for the reader.
 */
export function formatPerformanceMetrics(metrics: PerformanceMetrics, subject: string): string {
  const projectDetails = metrics.projects
    .map((project) => `\n• ${basename(project.rootPath)}: ${project.elementCount} elements`)
    .join("");
  const totalElements = metrics.projects.reduce((total, project) => total + project.elementCount, 0);

  return `🔍 **Angular Auto Import - Performance Metrics**

📊 **Memory Usage** (${subject})**:**
• Heap Used: ${megabytes(metrics.memory.heapUsed)} MB
• Heap Total: ${megabytes(metrics.memory.heapTotal)} MB
• RSS: ${megabytes(metrics.memory.rss)} MB
• External: ${megabytes(metrics.memory.external)} MB

⚡ **CPU Usage:**
• User: ${Math.round(metrics.cpu.user / 1000)} ms
• System: ${Math.round(metrics.cpu.system / 1000)} ms

🗂️ **Indexing Stats:**
• Angular compiler: ${metrics.analysisReady ? "loaded" : "still loading — diagnostics report nothing until it lands"}
• Projects: ${metrics.projects.length}
• Total Elements: ${totalElements}${projectDetails}

💡 **Tips:**
• If memory usage is high (>100MB), try clearing cache
• Check logs for performance timers of slow operations
• Large projects may need more memory for indexing`;
}

/**
 * The last segment of a path, without pulling `node:path` into a rendering module.
 * @internal
 */
function basename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

/**
 * Generates common HTML document header.
 * @param title - Document title
 * @returns HTML header string
 */
export function getHtmlDocumentHeader(title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <title>${title}</title>`;
}

/**
 * Returns warning box styling for validation messages.
 * @returns CSS string for warning styled elements
 */
function getWarningBoxStyles(): string {
  return `
          margin-bottom: 20px;
          background: var(--vscode-inputValidation-warningBackground);
          border: 1px solid var(--vscode-inputValidation-warningBorder);
          border-radius: 3px;`;
}

/**
 * Returns common CSS styles for webview panels.
 * Centralizes shared styles to avoid duplication.
 *
 * @returns Common CSS styles string
 */
export function getCommonWebviewStyles(): string {
  return `
    body {
      font-family: var(--vscode-font-family), 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: var(--vscode-font-size, 13px);
      padding: 20px;
      line-height: 1.6;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      margin: 0;
    }
    h1 {
      font-size: 1.5em;
      font-weight: 600;
      border-bottom: 1px solid var(--vscode-separator-foreground);
      padding-bottom: 8px;
      margin: 0 0 20px 0;
    }
    h2 {
      font-size: 1.2em;
      font-weight: 600;
      margin-top: 25px;
      margin-bottom: 10px;
    }
    .summary {
      display: flex;
      gap: 20px;
      margin-bottom: 25px;
      padding: 15px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 3px;
      border-left: 3px solid var(--vscode-textBlockQuote-border);
    }
    .summary-item {
      display: flex;
      flex-direction: column;
    }
    .summary-label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .summary-value {
      font-size: 1.2em;
      font-weight: 600;
    }
  `;
}

/**
 * Generates files HTML section.
 */
function generateFilesHtml(report: DiagnosticsReport): string {
  if (report.files.length === 0) {
    return '<div class="no-issues">✅ No diagnostic issues found in any templates!</div>';
  }

  return report.files
    .map((fileReport: FileDiagnosticsReport) => {
      const relativePath = vscode.workspace.asRelativePath(fileReport.filePath);
      const templateTypeLabel = fileReport.templateType === "inline" ? "Inline Template" : "External Template";
      const diagnosticsHtml = fileReport.diagnostics
        .map((diagnostic: ReportedDiagnostic) => {
          const severityClass = getSeverityClass(diagnostic.severity);
          const severityLabel = getSeverityLabel(diagnostic.severity);
          const line = diagnostic.range.start.line + 1;
          const column = diagnostic.range.start.character + 1;

          return `
        <div class="diagnostic ${severityClass}">
          <div class="diagnostic-header">
            <span class="severity-badge">${severityLabel}</span>
            <span class="location">Line ${line}, Col ${column}</span>
          </div>
          <div class="diagnostic-message">${escapeHtml(diagnostic.message)}</div>
          ${diagnostic.code ? `<div class="diagnostic-code">Code: ${escapeHtml(String(diagnostic.code))}</div>` : ""}
        </div>
      `;
        })
        .join("");

      return `
      <div class="file-report">
        <div class="file-header">
          <h3 class="file-path">${escapeHtml(relativePath)}</h3>
          <span class="template-type">${templateTypeLabel}</span>
          <span class="issue-count">${fileReport.diagnostics.length} issue(s)</span>
        </div>
        <div class="diagnostics-list">
          ${diagnosticsHtml}
        </div>
      </div>
    `;
    })
    .join("");
}

/**
 * Generates truncation warning HTML.
 */
function generateTruncationWarning(report: DiagnosticsReport): string {
  if (!report.truncated) {
    return "";
  }

  return `
    <div class="truncation-warning">
      <div class="truncation-warning-title">⚠️ Report Truncated</div>
      <div class="truncation-warning-message">${escapeHtml(report.truncationReason || "Report was limited to prevent memory overflow")}</div>
    </div>
  `;
}

/**
 * Generates summary HTML section.
 */
function generateSummaryHtml(report: DiagnosticsReport, formatTimestamp: string): string {
  const plusSign = report.truncated ? "+" : "";

  return `
    <div class="summary">
      <div class="summary-item">
        <span class="summary-label">Total Issues</span>
        <span class="summary-value">${report.totalIssues}${plusSign}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Files with Issues</span>
        <span class="summary-value">${report.files.length}${plusSign}</span>
      </div>
      <div class="summary-item">
        <span class="summary-label">Generated</span>
        <span class="summary-value" style="font-size: 0.9em;">${escapeHtml(formatTimestamp)}</span>
      </div>
    </div>
  `;
}

/**
 * Generates HTML content for the diagnostics report webview.
 *
 * @param report - The diagnostics report data
 * @returns HTML string for the webview
 */
export function renderDiagnosticsReportHtml(report: DiagnosticsReport): string {
  const formatTimestamp = new Date(report.timestamp).toLocaleString();
  const filesHtml = generateFilesHtml(report);
  const truncationWarning = generateTruncationWarning(report);
  const summaryHtml = generateSummaryHtml(report, formatTimestamp);

  return `${getHtmlDocumentHeader("Diagnostics Report")}
    <style>
        ${getCommonWebviewStyles()}
        .no-issues {
          padding: 20px;
          text-align: center;
          background: var(--vscode-inputValidation-infoBackground);
          border: 1px solid var(--vscode-inputValidation-infoBorder);
          border-radius: 3px;
          font-size: 1.1em;
        }
        .truncation-warning {
          padding: 15px;${getWarningBoxStyles()}
          border-left: 4px solid var(--vscode-inputValidation-warningBorder);
        }
        .truncation-warning-title {
          font-weight: 600;
          margin-bottom: 8px;
        }
        .truncation-warning-message {
          font-size: 0.95em;
        }
        .file-report {
          margin-bottom: 30px;
          border: 1px solid var(--vscode-separator-foreground);
          border-radius: 3px;
          overflow: hidden;
        }
        .file-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 15px;
          background: var(--vscode-sideBar-background);
          border-bottom: 1px solid var(--vscode-separator-foreground);
        }
        .file-path {
          margin: 0;
          font-size: 1em;
          font-weight: 600;
          flex: 1;
          word-break: break-all;
        }
        .template-type {
          font-size: 0.85em;
          padding: 3px 8px;
          background: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground);
          border-radius: 3px;
        }
        .issue-count {
          font-size: 0.85em;
          padding: 3px 8px;${getWarningBoxStyles()}
        }
        .diagnostics-list {
          padding: 10px 15px;
        }
        .diagnostic {
          padding: 10px;
          margin-bottom: 10px;
          border-left: 3px solid;
          background: var(--vscode-editor-background);
          border-radius: 3px;
        }
        .diagnostic.error {
          border-left-color: var(--vscode-inputValidation-errorBorder);
          background: var(--vscode-inputValidation-errorBackground);
        }
        .diagnostic.warning {
          border-left-color: var(--vscode-inputValidation-warningBorder);
          background: var(--vscode-inputValidation-warningBackground);
        }
        .diagnostic.info {
          border-left-color: var(--vscode-inputValidation-infoBorder);
          background: var(--vscode-inputValidation-infoBackground);
        }
        .diagnostic-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 6px;
        }
        .severity-badge {
          font-size: 0.75em;
          font-weight: 600;
          padding: 2px 6px;
          border-radius: 3px;
          text-transform: uppercase;
        }
        .diagnostic.error .severity-badge {
          background: var(--vscode-inputValidation-errorBorder);
          color: var(--vscode-editor-background);
        }
        .diagnostic.warning .severity-badge {
          background: var(--vscode-inputValidation-warningBorder);
          color: var(--vscode-editor-background);
        }
        .diagnostic.info .severity-badge {
          background: var(--vscode-inputValidation-infoBorder);
          color: var(--vscode-editor-background);
        }
        .location {
          font-size: 0.85em;
          color: var(--vscode-descriptionForeground);
        }
        .diagnostic-message {
          font-size: 0.95em;
          margin-bottom: 4px;
        }
        .diagnostic-code {
          font-size: 0.85em;
          color: var(--vscode-descriptionForeground);
          font-family: var(--vscode-editor-font-family);
        }
    </style>
</head>
<body>
    <h1>🔍 Angular Auto Import - Diagnostics Report</h1>
    ${truncationWarning}
    ${summaryHtml}
    ${filesHtml}
</body>
</html>`;
}

/**
 * Gets CSS class for diagnostic severity.
 */
function getSeverityClass(severity: CoreDiagnosticSeverity): string {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    default:
      return "info";
  }
}

/**
 * Gets label for diagnostic severity.
 */
function getSeverityLabel(severity: CoreDiagnosticSeverity): string {
  switch (severity) {
    case "error":
      return "Error";
    case "warning":
      return "Warning";
    default:
      return "Info";
  }
}

/**
 * Escapes HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Generates secure and rich HTML content for the performance metrics webview.
 * It transforms a markdown-like report string into a styled HTML document.
 *
 * @param metricsReport - The formatted metrics report string
 * @returns HTML string for the webview
 */
export function renderPerformanceMetricsHtml(metricsReport: string): string {
  // Sanitize to prevent any accidental HTML injection from metric values
  const sanitizedReport = metricsReport.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Convert markdown-like syntax to HTML
  let htmlContent = sanitizedReport
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>") // Bold text
    .replace(/^🔍 (.*)$/gm, "<h1>$1</h1>") // Main title
    .replace(/^(📊|⚡|🗂️|💡) (.*)$/gm, "<h2>$1 $2</h2>") // Section headers
    .replace(/^• (.*)$/gm, "<li>$1</li>"); // List items

  // Wrap consecutive list items in a <ul> tag
  htmlContent = htmlContent.replace(/(<li>(.|\n)*?<\/li>)/gs, "<ul>$1</ul>").replace(/<\/ul>\s*<ul>/gs, "");

  return `${getHtmlDocumentHeader("Performance Metrics")}
    <style>
        ${getCommonWebviewStyles()}
        ul {
          list-style-type: none;
          padding-left: 5px;
          margin: 0;
        }
        li {
          position: relative;
          padding-left: 15px;
          margin-bottom: 5px;
        }
        li::before {
          content: '•';
          position: absolute;
          left: 0;
          color: var(--vscode-focusBorder);
        }
        .refresh-info {
            margin-top: 25px;
            padding: 10px;
            background: var(--vscode-textBlockQuote-background);
            border-radius: 3px;
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    ${htmlContent}
    <div class="refresh-info">
        💡 To refresh metrics, run the command again from the Command Palette (Ctrl/Cmd + Shift + P)
    </div>
</body>
</html>`;
}
