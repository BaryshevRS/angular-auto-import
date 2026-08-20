/**
 * Diagnostics Report Generator
 *
 * A debugging/development tool that scans all Angular templates (both external .html and inline)
 * and collects all diagnostic issues into a comprehensive report.
 *
 * @module
 */

import * as fs from "node:fs";
import * as vscode from "vscode";
import type { CoreDiagnosticSeverity } from "../core/language-types";
import { logger } from "../logger";
import type {
  DiagnosticsReport as DiagnosticsReportDto,
  FileDiagnosticsReport,
  ReportedDiagnostic,
} from "../lsp/protocol";
import type { DiagnosticProvider } from "../providers/diagnostics";
import { getTsDocument, switchFileType } from "../utils";

/**
 * Report for a single file's diagnostics
 * @public Used as part of DiagnosticsReport
 */
export interface FileReport {
  /** Absolute path to the file */
  filePath: string;
  /** Type of template */
  templateType: "inline" | "external";
  /** Diagnostics found in this file */
  diagnostics: vscode.Diagnostic[];
}

/**
 * Complete diagnostics report for all templates
 */
export interface DiagnosticsReport {
  /** Total number of issues found */
  totalIssues: number;
  /** Reports grouped by file */
  fileReports: FileReport[];
  /** Timestamp when the report was generated */
  timestamp: Date;
  /** Whether the report was truncated due to limits */
  truncated?: boolean;
  /** Truncation details if applicable */
  truncationReason?: string;
}

const BATCH_SIZE = 20; // Process files in batches to manage memory
const GC_PAUSE_MS = 10; // Small pause between batches for garbage collection
const MAX_DIAGNOSTICS_PER_FILE = 100; // Limit diagnostics per file to prevent memory overflow
const MAX_TOTAL_DIAGNOSTICS = 2000; // Limit total diagnostics to prevent memory overflow
const MAX_FILES_IN_REPORT = 500; // Limit total files in report to prevent memory overflow

/**
 * Message shown when max diagnostics limit is reached.
 */
const TRUNCATION_MESSAGE_MAX_DIAGNOSTICS = `Report limited to ${MAX_TOTAL_DIAGNOSTICS} total diagnostics to prevent memory overflow`;

/**
 * Generates a comprehensive diagnostics report for all templates in the workspace.
 *
 * @param diagnosticProvider - The diagnostic provider instance
 * @param progress - Optional progress reporter
 * @param token - Optional cancellation token
 * @returns A structured report containing all diagnostic issues grouped by file
 */
export async function generateFullDiagnosticsReport(
  diagnosticProvider: DiagnosticProvider,
  progress?: vscode.Progress<{ message?: string; increment?: number }>,
  token?: vscode.CancellationToken
): Promise<DiagnosticsReport> {
  const report: DiagnosticsReport = {
    totalIssues: 0,
    fileReports: [],
    timestamp: new Date(),
  };

  // Find all TypeScript files that might be Angular components
  const tsFiles = await vscode.workspace.findFiles("**/*.ts", "**/node_modules/**");
  const htmlFiles = await vscode.workspace.findFiles("**/*.html", "**/node_modules/**");

  // Fast pre-filter TypeScript files to reduce memory usage
  const candidateTsFiles = await filterCandidateFiles(tsFiles, token);

  if (token?.isCancellationRequested) {
    throw new Error("Operation cancelled by user");
  }

  const totalFiles = candidateTsFiles.length + htmlFiles.length;

  logger.info(
    `[DiagnosticsReporter] Found ${candidateTsFiles.length} candidate TypeScript files and ${htmlFiles.length} HTML files`
  );

  // Process TypeScript files in batches (for inline templates)
  const tsContext = { processedFiles: 0, totalFiles };
  await processBatchedFiles(candidateTsFiles, "inline", diagnosticProvider, report, progress, token, tsContext);

  // Process HTML files in batches (external templates)
  await processBatchedFiles(htmlFiles, "external", diagnosticProvider, report, progress, token, tsContext);

  return report;
}

/**
 * Processes files in batches to manage memory usage.
 */
async function processBatchedFiles(
  files: vscode.Uri[],
  templateType: "inline" | "external",
  diagnosticProvider: DiagnosticProvider,
  report: DiagnosticsReport,
  progress: vscode.Progress<{ message?: string; increment?: number }> | undefined,
  token: vscode.CancellationToken | undefined,
  context: { processedFiles: number; totalFiles: number }
): Promise<void> {
  const fileTypeLabel = templateType === "inline" ? "TypeScript files" : "HTML templates";

  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    if (token?.isCancellationRequested) {
      throw new Error("Operation cancelled by user");
    }

    // Check if we've hit the limits
    if (checkReportLimits(report)) {
      return;
    }

    const batch = files.slice(i, i + BATCH_SIZE);
    await processSingleBatch(batch, templateType, fileTypeLabel, diagnosticProvider, report, progress, context);

    // Small pause between batches to allow garbage collection
    await new Promise((resolve) => setTimeout(resolve, GC_PAUSE_MS));
  }
}

/**
 * Marks report as truncated and logs warning.
 */
function markReportTruncated(report: DiagnosticsReport, reason: string, logMessage: string): void {
  report.truncated = true;
  report.truncationReason = reason;
  logger.warn(logMessage);
}

/**
 * Checks if report has reached memory limits.
 */
function checkReportLimits(report: DiagnosticsReport): boolean {
  if (report.fileReports.length >= MAX_FILES_IN_REPORT) {
    markReportTruncated(
      report,
      `Report limited to ${MAX_FILES_IN_REPORT} files to prevent memory overflow`,
      `[DiagnosticsReporter] Reached max files limit (${MAX_FILES_IN_REPORT}), stopping scan`
    );
    return true;
  }

  if (report.totalIssues >= MAX_TOTAL_DIAGNOSTICS) {
    markReportTruncated(
      report,
      TRUNCATION_MESSAGE_MAX_DIAGNOSTICS,
      `[DiagnosticsReporter] Reached max diagnostics limit (${MAX_TOTAL_DIAGNOSTICS}), stopping scan`
    );
    return true;
  }

  return false;
}

/**
 * Processes a single batch of files.
 */
async function processSingleBatch(
  batch: vscode.Uri[],
  templateType: "inline" | "external",
  fileTypeLabel: string,
  diagnosticProvider: DiagnosticProvider,
  report: DiagnosticsReport,
  progress: vscode.Progress<{ message?: string; increment?: number }> | undefined,
  context: { processedFiles: number; totalFiles: number }
): Promise<void> {
  for (const fileUri of batch) {
    context.processedFiles++;
    updateProgress(progress, fileTypeLabel, context);

    try {
      const document = await vscode.workspace.openTextDocument(fileUri);
      const fileReport = await generateFileReport(document, templateType, diagnosticProvider);

      if (fileReport.diagnostics.length > 0) {
        addFileReportWithLimits(fileReport, fileUri, report);

        // Early exit if we hit the total diagnostics limit
        if (report.totalIssues >= MAX_TOTAL_DIAGNOSTICS) {
          markReportTruncated(
            report,
            TRUNCATION_MESSAGE_MAX_DIAGNOSTICS,
            "[DiagnosticsReporter] Reached max diagnostics limit, stopping scan"
          );
          return;
        }
      }
    } catch (error) {
      logger.error(`[DiagnosticsReporter] Error processing ${fileUri.fsPath}:`, error as Error);
    }
  }
}

/**
 * Updates progress reporter.
 */
function updateProgress(
  progress: vscode.Progress<{ message?: string; increment?: number }> | undefined,
  fileTypeLabel: string,
  context: { processedFiles: number; totalFiles: number }
): void {
  if (progress) {
    progress.report({
      message: `Scanning ${fileTypeLabel} (${context.processedFiles}/${context.totalFiles})...`,
      increment: (1 / context.totalFiles) * 100,
    });
  }
}

/**
 * Adds file report with diagnostic limits.
 */
function addFileReportWithLimits(fileReport: FileReport, fileUri: vscode.Uri, report: DiagnosticsReport): void {
  // Limit diagnostics per file to prevent memory overflow
  if (fileReport.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
    fileReport.diagnostics = fileReport.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE);
    logger.warn(
      `[DiagnosticsReporter] Truncated diagnostics for ${fileUri.fsPath} to ${MAX_DIAGNOSTICS_PER_FILE} items`
    );
  }

  report.fileReports.push(fileReport);
  report.totalIssues += fileReport.diagnostics.length;
}

/**
 * Fast pre-filter TypeScript files to find Angular component candidates.
 * Uses fs.readFile for fast content check without opening VS Code documents.
 *
 * @param files - Array of file URIs to filter
 * @param token - Optional cancellation token
 * @returns Filtered array of candidate files
 */
async function filterCandidateFiles(files: vscode.Uri[], token?: vscode.CancellationToken): Promise<vscode.Uri[]> {
  const candidates: vscode.Uri[] = [];

  for (let i = 0; i < files.length; i++) {
    if (token?.isCancellationRequested) {
      break;
    }

    const file = files[i];

    try {
      // Fast check: read file content and look for @Component decorator
      const content = await fs.promises.readFile(file.fsPath, "utf-8");

      // Only include files that contain @Component decorator
      if (content.includes("@Component")) {
        candidates.push(file);
      }
    } catch (_error) {
      // Skip files that can't be read
      logger.debug(`[DiagnosticsReporter] Could not read file for filtering: ${file.fsPath}`);
    }
  }

  return candidates;
}

/**
 * Generates a diagnostics report for a single file.
 *
 * @param document - The document to analyze
 * @param templateType - Type of template (inline or external)
 * @param diagnosticProvider - The diagnostic provider instance
 * @returns A file report containing all diagnostics for this file
 */
async function generateFileReport(
  document: vscode.TextDocument,
  templateType: "inline" | "external",
  diagnosticProvider: DiagnosticProvider
): Promise<FileReport> {
  const fileReport: FileReport = {
    filePath: document.fileName,
    templateType,
    diagnostics: [],
  };

  try {
    // For TypeScript files, check if they have inline templates
    if (templateType === "inline") {
      // Check if it's a component file
      const content = document.getText();
      if (!content.includes("@Component")) {
        return fileReport;
      }
    }

    // For HTML files, check if corresponding .ts file exists and is a component
    if (templateType === "external") {
      const componentPath = switchFileType(document.fileName, ".ts");
      if (!fs.existsSync(componentPath)) {
        return fileReport;
      }

      const tsDocument = await getTsDocument(document, componentPath);
      if (!tsDocument) {
        return fileReport;
      }

      // Quick check if it's a component (without full parsing)
      const tsContent = tsDocument.getText();
      if (!tsContent.includes("@Component")) {
        return fileReport;
      }
    }

    // Get diagnostics from the diagnostic provider
    // We force update diagnostics for this specific file
    await diagnosticProvider.forceUpdateDiagnosticsForFile(document.fileName);

    // Get the diagnostics that were generated
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    const angularDiagnostics = diagnostics.filter((d) => d.source === "angular-auto-import");

    fileReport.diagnostics = angularDiagnostics;
  } catch (error) {
    logger.error(`[DiagnosticsReporter] Error generating file report for ${document.fileName}:`, error as Error);
  }

  return fileReport;
}

/**
 * Converts the Extension Host's report into the DTO the webview renders.
 *
 * The renderer is shared with the language-server path, so it reads plain data: a
 * `Date` and a `vscode.Diagnostic` mean nothing to a report that arrived over JSON-RPC.
 * @param report The report as the scan produced it.
 */
export function toDiagnosticsReportDto(report: DiagnosticsReport): DiagnosticsReportDto {
  return {
    totalIssues: report.totalIssues,
    timestamp: report.timestamp.toISOString(),
    truncated: report.truncated,
    truncationReason: report.truncationReason,
    files: report.fileReports.map(
      (file): FileDiagnosticsReport => ({
        filePath: file.filePath,
        templateType: file.templateType,
        diagnostics: file.diagnostics.map(toReportedDiagnostic),
      })
    ),
  };
}

/** @internal */
function toReportedDiagnostic(diagnostic: vscode.Diagnostic): ReportedDiagnostic {
  return {
    range: {
      start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
      end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
    },
    message: diagnostic.message,
    code: String(diagnostic.code ?? ""),
    severity: toCoreSeverity(diagnostic.severity),
  };
}

/** @internal */
function toCoreSeverity(severity: vscode.DiagnosticSeverity | undefined): CoreDiagnosticSeverity {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
    default:
      return "information";
  }
}
