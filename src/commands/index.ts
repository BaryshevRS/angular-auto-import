/**
 *
 * VSCode Commands Registration
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { toProgressReporter } from "../adapters/vscode/progress";
import type { ExtensionConfig } from "../config";
import type { ProgressReporter } from "../core/progress";
import { logger } from "../logger";
import type { DiagnosticProvider } from "../providers/diagnostics";
import type { AngularIndexer } from "../services";
import { type DiagnosticsReport, generateFullDiagnosticsReport } from "../services/diagnostics-reporter";
import * as TsConfigHelper from "../services/tsconfig";
import type { AngularElementData, ProcessedTsConfig } from "../types";
import { importElementsToFile, switchFileType } from "../utils";
import { getAngularElementAsync } from "../utils/angular";
import { getProjectContextForDocumentWithLogging as getProjectContextUtil } from "../utils/project-context";

/**
 * Context object containing shared state and dependencies for extension commands.
 *
 * @interface CommandContext
 * @example
 * ```typescript
 * const commandContext: CommandContext = {
 *   projectIndexers: new Map(),
 *   projectTsConfigs: new Map(),
 *   extensionConfig: getConfiguration()
 * };
 * ```
 */
export interface CommandContext {
  /** Map of project root paths to their corresponding Angular indexers */
  projectIndexers: Map<string, AngularIndexer>;
  /** Map of project root paths to their parsed TypeScript configurations */
  projectTsConfigs: Map<string, ProcessedTsConfig | null>;
  /** Current extension configuration settings */
  extensionConfig: ExtensionConfig;
  diagnosticProvider?: DiagnosticProvider;
}

/**
 * Registers all extension commands with the VS Code command registry.
 *
 * This function sets up the following commands:
 * - `angular-auto-import.reindex`: Re-indexes Angular elements for the current or all projects
 * - `angular-auto-import.importElement`: Imports a specific Angular element into the current file
 * - `angular-auto-import.clearCache`: Clears the cached index data for all projects
 *
 * @param context - The VS Code extension context for managing disposables
 * @param commandContext - Shared state and dependencies for commands
 *
 * @example
 * ```typescript
 * export function activate(context: vscode.ExtensionContext) {
 *   const commandContext = createCommandContext();
 *   registerCommands(context, commandContext);
 * }
 * ```
 */
export function registerCommands(context: vscode.ExtensionContext, commandContext: CommandContext): void {
  // Re-index command
  const reindexCommand = vscode.commands.registerCommand("angular-auto-import.reindex", async () => {
    logger.info("Reindex command invoked by user");
    const projectsToReindex = getProjectsToReindex(commandContext);

    if (projectsToReindex.length === 0) {
      vscode.window.showInformationMessage("Angular Auto-Import: No project found to reindex.");
      return;
    }

    await reindexProjects(projectsToReindex, commandContext, context);
  });
  context.subscriptions.push(reindexCommand);

  // Import element command
  const importCmd = vscode.commands.registerCommand(
    "angular-auto-import.importElement",
    async (element: AngularElementData) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        vscode.window.showErrorMessage("No active editor. Cannot determine project context for import.");
        return;
      }
      const projCtx = getProjectContextForDocument(activeEditor.document, commandContext);
      if (!projCtx) {
        vscode.window.showErrorMessage("Could not determine project context for the active file.");
        return;
      }
      const { indexer, projectRootPath, tsConfig } = projCtx;
      await importElementCommandLogic(element, projectRootPath, tsConfig, indexer);
    }
  );
  context.subscriptions.push(importCmd);

  // Clear cache command
  const clearCacheCommand = vscode.commands.registerCommand("angular-auto-import.clearCache", async () => {
    logger.info("Clear cache command invoked by user");
    const { projectIndexers } = commandContext;
    const projectCount = projectIndexers.size;

    if (projectCount === 0) {
      vscode.window.showInformationMessage("Angular Auto-Import: No active project to clear cache for.");
      return;
    }

    for (const [, indexer] of projectIndexers) {
      await indexer.clearCache();
    }

    if (projectCount === 1) {
      const [projectRootPath] = projectIndexers.keys();
      vscode.window.showInformationMessage(
        `✅ Angular Auto-Import: Cache cleared for project ${path.basename(projectRootPath)}.`
      );
    } else {
      vscode.window.showInformationMessage(`✅ Angular Auto-Import: Cache cleared for all ${projectCount} projects.`);
    }
  });
  context.subscriptions.push(clearCacheCommand);

  // Show logs command
  const showLogsCommand = vscode.commands.registerCommand("angular-auto-import.showLogs", () => {
    logger.showChannel();
  });
  context.subscriptions.push(showLogsCommand);

  // Show performance metrics command
  const showMetricsCommand = vscode.commands.registerCommand("angular-auto-import.showPerformanceMetrics", async () => {
    logger.info("Show performance metrics command invoked by user");

    try {
      const metrics = logger.getPerformanceMetrics();
      const heapUsedMb = Math.round(metrics.memoryUsage.heapUsed / 1024 / 1024);
      const heapTotalMb = Math.round(metrics.memoryUsage.heapTotal / 1024 / 1024);
      const rssMb = Math.round(metrics.memoryUsage.rss / 1024 / 1024);
      const externalMb = Math.round(metrics.memoryUsage.external / 1024 / 1024);

      // Count indexed elements across all projects
      let totalElements = 0;
      let totalProjects = 0;
      let projectDetails = "";

      for (const [projectPath, indexer] of commandContext.projectIndexers.entries()) {
        const elements = indexer.getAllSelectors().length;
        totalElements += elements;
        totalProjects++;
        projectDetails += `\n• ${path.basename(projectPath)}: ${elements} elements`;
      }

      const metricsReport = `🔍 **Angular Auto Import - Performance Metrics**

📊 **Memory Usage:**
• Heap Used: ${heapUsedMb} MB
• Heap Total: ${heapTotalMb} MB  
• RSS: ${rssMb} MB
• External: ${externalMb} MB

⚡ **CPU Usage:**
• User: ${Math.round(metrics.cpuUsage.user / 1000)} ms
• System: ${Math.round(metrics.cpuUsage.system / 1000)} ms

🗂️ **Indexing Stats:**
• Projects: ${totalProjects}
• Total Elements: ${totalElements}${projectDetails}

💡 **Tips:**
• If memory usage is high (>100MB), try clearing cache
• Check logs for performance timers of slow operations
• Large projects may need more memory for indexing`;

      const panel = vscode.window.createWebviewPanel(
        "angularAutoImportMetrics",
        "Angular Auto Import - Performance Metrics",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          localResourceRoots: [],
        }
      );

      // Add disposal handler
      context.subscriptions.push(panel);

      panel.webview.html = getWebviewContent(metricsReport);
    } catch (error) {
      logger.error("Error in showPerformanceMetrics command:", error as Error);
      vscode.window.showErrorMessage("Failed to show performance metrics. Check the extension output for details.");
    }
  });
  context.subscriptions.push(showMetricsCommand);

  // Fix all diagnostics command
  const fixAllCommand = vscode.commands.registerCommand("angular-auto-import.fix-all", async () => {
    logger.info("Fix all command invoked by user");
    const fixAllResult = await processFixAllCommand(commandContext);

    if (!fixAllResult.success) {
      vscode.window.showInformationMessage(fixAllResult.message || "Unknown error occurred.");
      return;
    }

    const { elementsToImport, projectRootPath, tsConfig, indexer } = fixAllResult;

    if (elementsToImport && projectRootPath && tsConfig && indexer) {
      await importElementsCommandLogic(Array.from(elementsToImport.values()), projectRootPath, tsConfig, indexer);
    }
  });
  context.subscriptions.push(fixAllCommand);

  // Generate diagnostics report command (debugging/development tool)
  const generateDiagnosticsReportCommand = vscode.commands.registerCommand(
    "angular-auto-import.generateDiagnosticsReport",
    async () => {
      logger.info("Generate diagnostics report command invoked by user");

      const diagnosticProvider = commandContext.diagnosticProvider;
      if (!diagnosticProvider) {
        vscode.window.showErrorMessage("Diagnostic provider is not available.");
        return;
      }

      try {
        const report = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Angular Auto Import: Generating Diagnostics Report",
            cancellable: true,
          },
          async (progress, token) => {
            return await generateFullDiagnosticsReport(diagnosticProvider, progress, token);
          }
        );

        // Display the report in a webview
        const panel = vscode.window.createWebviewPanel(
          "angularDiagnosticsReport",
          "Angular Auto Import - Diagnostics Report",
          vscode.ViewColumn.One,
          {
            enableScripts: true,
            retainContextWhenHidden: false,
            localResourceRoots: [],
          }
        );

        context.subscriptions.push(panel);
        panel.webview.html = getDiagnosticsReportHtml(report);

        vscode.window.showInformationMessage(
          `✅ Diagnostics report generated: ${report.totalIssues} issue(s) found across ${report.fileReports.length} file(s)`
        );
      } catch (error) {
        logger.error("Error generating diagnostics report:", error as Error);
        vscode.window.showErrorMessage(
          "Failed to generate diagnostics report. Check the extension output for details."
        );
      }
    }
  );
  context.subscriptions.push(generateDiagnosticsReportCommand);
}

/**
 * Generates common HTML document header.
 * @param title - Document title
 * @returns HTML header string
 */
function getHtmlDocumentHeader(title: string): string {
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
function getCommonWebviewStyles(): string {
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
  if (report.fileReports.length === 0) {
    return '<div class="no-issues">✅ No diagnostic issues found in any templates!</div>';
  }

  return report.fileReports
    .map((fileReport) => {
      const relativePath = vscode.workspace.asRelativePath(fileReport.filePath);
      const templateTypeLabel = fileReport.templateType === "inline" ? "Inline Template" : "External Template";
      const diagnosticsHtml = fileReport.diagnostics
        .map((diagnostic) => {
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
        <span class="summary-value">${report.fileReports.length}${plusSign}</span>
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
function getDiagnosticsReportHtml(report: DiagnosticsReport): string {
  const formatTimestamp = report.timestamp.toLocaleString();
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
function getSeverityClass(severity: vscode.DiagnosticSeverity | undefined): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "info";
  }
}

/**
 * Gets label for diagnostic severity.
 */
function getSeverityLabel(severity: vscode.DiagnosticSeverity | undefined): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "Error";
    case vscode.DiagnosticSeverity.Warning:
      return "Warning";
    case vscode.DiagnosticSeverity.Information:
      return "Info";
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
function getWebviewContent(metricsReport: string): string {
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

/**
 * Generates or regenerates the Angular element index for a specific project.
 *
 * This function performs a full index generation, including:
 * - Setting up cache keys if not already configured
 * - Scanning for Angular components, directives, and pipes
 * - Initializing file watchers for incremental updates
 *
 * @param projectRootPath - Absolute path to the project root directory
 * @param indexer - The Angular indexer instance for this project
 * @param context - VS Code extension context for cache management
 * @param progress - Optional progress reporter for the index generation
 *
 * @throws Will log warnings if cache keys are not properly configured
 *
 * @example
 * ```typescript
 * await generateIndexForProject('/path/to/project', indexer, context);
 * ```
 */
/**
 * Gets the list of projects to reindex based on current context.
 */
function getProjectsToReindex(commandContext: CommandContext): string[] {
  const projectsToReindex: string[] = [];
  const activeEditor = vscode.window.activeTextEditor;

  if (activeEditor) {
    const projCtx = getProjectContextForDocument(activeEditor.document, commandContext);
    if (projCtx) {
      projectsToReindex.push(projCtx.projectRootPath);
    }
  }

  if (projectsToReindex.length === 0) {
    // If no active editor or not in a known project, reindex all
    commandContext.projectIndexers.forEach((_, projectRootPath) => {
      projectsToReindex.push(projectRootPath);
    });
  }

  return projectsToReindex;
}

/**
 * Reindexes the specified projects and shows appropriate feedback.
 */
async function reindexProjects(
  projectsToReindex: string[],
  commandContext: CommandContext,
  context: vscode.ExtensionContext
): Promise<void> {
  for (const projectRootPath of projectsToReindex) {
    const result = await reindexSingleProject(projectRootPath, commandContext, context);
    showReindexResult(projectRootPath, result);
  }
}

/**
 * Reindexes a single project and returns the result.
 */
async function reindexSingleProject(
  projectRootPath: string,
  commandContext: CommandContext,
  context: vscode.ExtensionContext
): Promise<{ newSize: number; success: boolean }> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Angular Auto-Import: Reindexing ${path.basename(projectRootPath)}`,
      cancellable: false,
    },
    async (progress) => {
      const indexer = commandContext.projectIndexers.get(projectRootPath);
      if (indexer) {
        TsConfigHelper.clearCache(projectRootPath);
        const newTsConfig = await TsConfigHelper.findAndParseTsConfig(projectRootPath);
        commandContext.projectTsConfigs.set(projectRootPath, newTsConfig);
        await generateIndexForProject(projectRootPath, indexer, context, toProgressReporter(progress));
        const newSize = Array.from(indexer.getAllSelectors()).length;
        return { newSize, success: true };
      }
      return { newSize: 0, success: false };
    }
  );
}

/**
 * Shows appropriate feedback message for reindex result.
 */
function showReindexResult(projectRootPath: string, result: { newSize: number; success: boolean }): void {
  if (result.success) {
    vscode.window.showInformationMessage(
      `✅ Reindex of ${path.basename(projectRootPath)} successful. Found ${result.newSize} elements.`
    );
  } else {
    vscode.window.showWarningMessage(
      `Indexer not found for project ${path.basename(projectRootPath)}. Cannot reindex.`
    );
  }
}

/**
 * Processes the fix-all command and returns the result.
 */
async function processFixAllCommand(commandContext: CommandContext): Promise<{
  success: boolean;
  message?: string;
  elementsToImport?: Map<string, AngularElementData>;
  projectRootPath?: string;
  tsConfig?: ProcessedTsConfig | null;
  indexer?: AngularIndexer;
}> {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    return { success: false, message: "No active editor to fix diagnostics for." };
  }

  const document = activeEditor.document;
  if (commandContext.diagnosticProvider) {
    await commandContext.diagnosticProvider.forceUpdateDiagnosticsForFile(document.fileName);
  }
  const diagnostics = getRelevantDiagnostics(document, commandContext);

  if (diagnostics.length === 0) {
    return { success: false, message: "No auto-import diagnostics to fix." };
  }

  const projCtx = getProjectContextForDocument(document, commandContext);
  if (!projCtx) {
    return { success: false, message: "Could not determine project context for the active file." };
  }

  const elementsToImport = await resolveElementsFromDiagnostics(diagnostics, projCtx.indexer);

  if (elementsToImport.size === 0) {
    return { success: false, message: "Could not resolve any elements to import." };
  }

  return {
    success: true,
    elementsToImport,
    projectRootPath: projCtx.projectRootPath,
    tsConfig: projCtx.tsConfig,
    indexer: projCtx.indexer,
  };
}

/**
 * Gets relevant auto-import diagnostics from a document.
 * Uses internal diagnostic storage to work in all modes including 'quickfix-only'.
 */
function getRelevantDiagnostics(document: vscode.TextDocument, commandContext: CommandContext): vscode.Diagnostic[] {
  const vscodeDiagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .filter((d) => d.source === "angular-auto-import");

  // Also get from internal storage (works in 'quickfix-only' mode)
  const internalDiagnostics = commandContext.diagnosticProvider?.getDiagnosticsForDocument(document.uri) || [];

  // Merge and deduplicate
  const allDiagnostics = [...vscodeDiagnostics];
  for (const diag of internalDiagnostics) {
    const exists = allDiagnostics.some(
      (d) => d.message === diag.message && d.range.isEqual(diag.range) && d.source === diag.source
    );
    if (!exists) {
      allDiagnostics.push(diag);
    }
  }

  return allDiagnostics;
}

/**
 * Resolves Angular elements from diagnostics.
 */
async function resolveElementsFromDiagnostics(
  diagnostics: vscode.Diagnostic[],
  indexer: AngularIndexer
): Promise<Map<string, AngularElementData>> {
  const elementsToImport = new Map<string, AngularElementData>();

  for (const diagnostic of diagnostics) {
    const selectorToSearch = extractSelectorFromDiagnostic(diagnostic);

    if (selectorToSearch) {
      const elementData = await getAngularElementAsync(selectorToSearch, indexer);
      if (elementData && !elementsToImport.has(elementData.name)) {
        elementsToImport.set(elementData.name, elementData);
      }
    }
  }

  return elementsToImport;
}

/**
 * Extracts selector from diagnostic code.
 */
function extractSelectorFromDiagnostic(diagnostic: vscode.Diagnostic): string | null {
  if (typeof diagnostic.code !== "string" || !diagnostic.code.includes(":")) {
    return null;
  }

  const diagnosticCodeParts = (diagnostic.code as string).split(":");
  return diagnosticCodeParts[1] || null;
}

async function generateIndexForProject(
  projectRootPath: string,
  indexer: AngularIndexer,
  context: vscode.ExtensionContext,
  progress?: ProgressReporter
): Promise<void> {
  // Generating index for project
  indexer.ensureCacheKeys(projectRootPath);
  await indexer.generateFullIndex(progress);

  if (!indexer.fileWatcher) {
    // Watcher was not active, initializing
    indexer.initializeWatcher(context);
  }
}

/**
 * Resolves the project context (indexer, root path, and TypeScript config) for a given document.
 *
 * This function attempts to find the appropriate project context by:
 * 1. First checking if the document belongs to a workspace folder
 * 2. If not found, searching through known project roots for a match
 * 3. Returns undefined if no matching project context is found
 *
 * @param document - The VS Code text document to resolve context for
 * @param commandContext - Shared command context containing project mappings
 *
 * @returns Project context object with indexer, root path, and TypeScript config, or undefined if not found
 *
 * @example
 * ```typescript
 * const activeEditor = vscode.window.activeTextEditor;
 * if (activeEditor) {
 *   const projectContext = getProjectContextForDocument(activeEditor.document, commandContext);
 *   if (projectContext) {
 *     // Use projectContext.indexer, projectContext.projectRootPath, etc.
 *   }
 * }
 * ```
 */
function getProjectContextForDocument(
  document: vscode.TextDocument,
  commandContext: CommandContext
):
  | {
      indexer: AngularIndexer;
      projectRootPath: string;
      tsConfig: ProcessedTsConfig | null;
    }
  | undefined {
  return getProjectContextUtil(document, commandContext.projectIndexers, commandContext.projectTsConfigs);
}

/**
 * Executes the core logic for importing one or more Angular elements into the current file.
 *
 * @param elements - An array of Angular elements to import.
 * @param projectRootPath - Absolute path to the project root.
 * @param tsConfig - Parsed TypeScript configuration for path resolution.
 * @param indexer - Angular indexer containing the ts-morph project instance.
 * @returns Promise that resolves to true if the import was successful, false otherwise.
 */
async function importElementsCommandLogic(
  elements: AngularElementData[],
  projectRootPath: string,
  tsConfig: ProcessedTsConfig | null,
  indexer: AngularIndexer
): Promise<boolean> {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    vscode.window.showErrorMessage("No active file found.");
    return false;
  }
  const currentFileAbs = activeEditor.document.fileName;

  let activeComponentFileAbs = currentFileAbs;
  if (currentFileAbs.endsWith(".html")) {
    activeComponentFileAbs = switchFileType(currentFileAbs, ".ts");
  }

  if (!fs.existsSync(activeComponentFileAbs)) {
    vscode.window.showErrorMessage(
      `Component file not found for ${path.basename(currentFileAbs)}. Expected ${path.basename(
        activeComponentFileAbs
      )} or current file is not a .ts file.`
    );
    return false;
  }

  const success = await importElementsToFile(
    elements,
    activeComponentFileAbs,
    projectRootPath,
    indexer.project, // ts-morph Project instance
    tsConfig
  );

  if (success) {
    if (elements.length === 1) {
      const elementData = elements[0];
      vscode.window.showInformationMessage(
        `${elementData.type} '${elementData.name}' processed for ${path.basename(activeComponentFileAbs)}.`
      );
    } else {
      vscode.window.showInformationMessage(
        `Successfully processed ${elements.length} elements for ${path.basename(activeComponentFileAbs)}.`
      );
    }
  }
  return success;
}

/**
 * Executes the core logic for importing an Angular element into the current file.
 *
 * This function handles the complete import workflow:
 * 1. Validates that the element exists in the index
 * 2. Determines the target TypeScript file (switches from .html to .ts if needed)
 * 3. Verifies the target file exists
 * 4. Performs the actual import operation using ts-morph
 * 5. Shows appropriate user feedback
 *
 * @param elementData - The Angular element data to import (component, directive, or pipe)
 * @param projectRootPath - Absolute path to the project root
 * @param tsConfig - Parsed TypeScript configuration for path resolution
 * @param indexer - Angular indexer containing the ts-morph project instance
 *
 * @returns Promise that resolves to true if import was successful, false otherwise
 *
 * @example
 * ```typescript
 * const success = await importElementCommandLogic(
 *   elementData,
 *   '/path/to/project',
 *   tsConfig,
 *   indexer
 * );
 * if (success) {
 *   logger.info('Import completed successfully');
 * }
 * ```
 */
async function importElementCommandLogic(
  elementData: AngularElementData | undefined,
  projectRootPath: string,
  tsConfig: ProcessedTsConfig | null,
  indexer: AngularIndexer
): Promise<boolean> {
  if (!elementData) {
    vscode.window.showInformationMessage(
      "Angular element not found in index. Please check selector, reindex, and try again."
    );
    return false;
  }
  return importElementsCommandLogic([elementData], projectRootPath, tsConfig, indexer);
}
