import type { CoreDiagnosticSeverity } from "../core/language-types";
import type { DiagnosticsReport, FileDiagnosticsReport, ReportedDiagnostic } from "../lsp/protocol";

export interface MissingImportAuditHtmlOptions {
  nonce: string;
  relativePath(filePath: string): string;
}

/** Renders the project-wide missing-import audit without depending on the VS Code host. */
export function renderMissingImportAuditHtml(
  report: DiagnosticsReport,
  options: MissingImportAuditHtmlOptions
): string {
  const nonce = escapeHtml(options.nonce);
  const files = report.files.length
    ? report.files.map((file) => renderFile(file, options)).join("")
    : report.complete
      ? '<div class="no-issues">No missing imports found in the scanned templates.</div>'
      : '<div class="no-issues">No findings to show. Scan did not complete.</div>';
  const status = report.complete
    ? '<div class="status complete">Complete scan</div>'
    : `<div class="status incomplete">Incomplete scan: ${escapeHtml(report.incompleteReasons.join(", "))}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Project-wide Missing Import Audit</title>
  <style>
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.5;
      margin: 0;
      padding: 24px;
    }
    h1 { font-size: 1.5rem; margin: 0 0 6px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
    .summary {
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      display: flex;
      flex-wrap: wrap;
      gap: 20px;
      margin-bottom: 16px;
      padding: 14px;
    }
    .summary-item { min-width: 110px; }
    .summary-label { color: var(--vscode-descriptionForeground); display: block; font-size: 0.85em; }
    .summary-value { display: block; font-size: 1.15em; font-weight: 600; }
    .status { border: 1px solid; margin-bottom: 20px; padding: 10px 12px; }
    .status.complete {
      background: transparent;
      border-color: var(--vscode-testing-iconPassed, var(--vscode-focusBorder));
    }
    .status.incomplete {
      background: var(--vscode-inputValidation-warningBackground);
      border-color: var(--vscode-inputValidation-warningBorder);
    }
    .file-report {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      margin-bottom: 20px;
      overflow: hidden;
    }
    .file-header {
      align-items: center;
      background: var(--vscode-sideBar-background);
      display: flex;
      gap: 10px;
      padding: 10px 12px;
    }
    .file-path { flex: 1; font-family: var(--vscode-editor-font-family); margin: 0; word-break: break-all; }
    .badge {
      background: var(--vscode-badge-background);
      border-radius: 10px;
      color: var(--vscode-badge-foreground);
      font-size: 0.8em;
      padding: 2px 8px;
    }
    .diagnostics { display: grid; gap: 8px; padding: 10px; }
    .diagnostic {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-left: 3px solid var(--vscode-inputValidation-infoBorder);
      color: inherit;
      cursor: pointer;
      display: block;
      font: inherit;
      padding: 10px;
      text-align: left;
      width: 100%;
    }
    .diagnostic.error { border-left-color: var(--vscode-inputValidation-errorBorder); }
    .diagnostic.warning { border-left-color: var(--vscode-inputValidation-warningBorder); }
    .diagnostic:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .diagnostic-header { display: flex; gap: 10px; margin-bottom: 4px; }
    .severity { font-size: 0.8em; font-weight: 600; text-transform: uppercase; }
    .location, .code { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .message, .code { display: block; }
    .no-issues { border: 1px solid var(--vscode-panel-border); padding: 18px; text-align: center; }
  </style>
</head>
<body>
  <h1>Project-wide Missing Import Audit</h1>
  <p class="subtitle">Selectors indexed from this project and its dependencies.</p>
  <div class="summary">
    ${summaryItem("Scope", report.scope === "workspace" ? "Workspace" : "Active project")}
    ${summaryItem("Projects scanned", String(report.projectsScanned))}
    ${summaryItem("Templates scanned", String(report.templatesScanned))}
    ${summaryItem("Missing imports", String(report.totalIssues) + (report.truncated ? "+" : ""))}
    ${summaryItem("Generated", new Date(report.timestamp).toLocaleString())}
  </div>
  ${status}
  ${files}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest("button[data-location]");
      if (!(button instanceof HTMLButtonElement)) return;
      const encoded = button.dataset.location;
      if (!encoded) return;
      try {
        const location = JSON.parse(encoded);
        vscode.postMessage({ type: "openLocation", filePath: location.filePath, range: location.range });
      } catch {
        return;
      }
    });
  </script>
</body>
</html>`;
}

function summaryItem(label: string, value: string): string {
  return `<div class="summary-item"><span class="summary-label">${escapeHtml(label)}</span><span class="summary-value">${escapeHtml(value)}</span></div>`;
}

function renderFile(file: FileDiagnosticsReport, options: MissingImportAuditHtmlOptions): string {
  const relativePath = options.relativePath(file.filePath);
  const diagnostics = file.diagnostics
    .map((diagnostic) => renderDiagnostic(diagnostic, file.filePath, relativePath))
    .join("");
  const templateType = file.templateType === "inline" ? "Inline" : "External";
  return `<section class="file-report">
    <header class="file-header">
      <h2 class="file-path">${escapeHtml(relativePath)}</h2>
      <span class="badge">${templateType}</span>
      <span class="badge">${file.diagnostics.length} issue(s)</span>
    </header>
    <div class="diagnostics">${diagnostics}</div>
  </section>`;
}

function renderDiagnostic(diagnostic: ReportedDiagnostic, filePath: string, relativePath: string): string {
  const line = diagnostic.range.start.line + 1;
  const column = diagnostic.range.start.character + 1;
  const label = `Open ${severityLabel(diagnostic.severity)} ${diagnostic.message} (${diagnostic.code}) in ${relativePath} at line ${line}, column ${column}`;
  const location = JSON.stringify({ filePath, range: diagnostic.range });
  return `<button type="button" class="diagnostic ${severityClass(diagnostic.severity)}" aria-label="${escapeHtml(
    label
  )}" data-location="${escapeHtml(location)}">
    <span class="diagnostic-header"><span class="severity">${severityLabel(
      diagnostic.severity
    )}</span><span class="location">Line ${line}, Col ${column}</span></span>
    <span class="message">${escapeHtml(diagnostic.message)}</span>
    <span class="code">${escapeHtml(diagnostic.code)}</span>
  </button>`;
}

function severityClass(severity: CoreDiagnosticSeverity): string {
  return severity === "error" ? "error" : severity === "warning" ? "warning" : "info";
}

function severityLabel(severity: CoreDiagnosticSeverity): string {
  return severity === "information" ? "Info" : severity[0].toUpperCase() + severity.slice(1);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
