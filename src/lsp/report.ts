/**
 * The project-wide missing-import audit.
 *
 * It analyzes every template in the scoped projects, most of which nobody has open. It therefore
 * works in batches, yields between them so the connection stays responsive, stops at
 * hard limits rather than growing without bound, and reports progress and honors
 * cancellation throughout.
 *
 * Each file goes through the same analysis a pull request does, so the report cannot
 * disagree with what the editor shows.
 * @module
 */

import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { type CancellationSignal, neverCancelled } from "../core/cancellation";
import type { DocumentView } from "../core/document";
import { type CoreLogger, silentLogger } from "../core/logging";
import type { MissingImportDiagnostic } from "../core/missing-imports";
import type { DiagnosticsHandler } from "./diagnostics";
import type { RoutedDocument } from "./project-router";
import type { ProjectRuntime } from "./project-runtime";
import type { AuditIncompleteReason, DiagnosticsReport, FileDiagnosticsReport, ReportedDiagnostic } from "./protocol";

/** Files analyzed before yielding, so a long report never blocks the connection. */
const BATCH_SIZE = 20;
/** Diagnostics kept for one file; a single broken template must not fill the report. */
const MAX_DIAGNOSTICS_PER_FILE = 100;
/** Diagnostics kept in total, past which the report is truncated. */
const MAX_TOTAL_DIAGNOSTICS = 2000;
/** Files listed in the report, past which it is truncated. */
const MAX_FILES = 500;

const TRUNCATED_BY_DIAGNOSTICS = `Report limited to ${MAX_TOTAL_DIAGNOSTICS} total diagnostics to prevent memory overflow`;
const TRUNCATED_BY_FILES = `Report limited to ${MAX_FILES} files to prevent memory overflow`;

type AuditCandidate = RoutedDocument;

interface AnalyzedFile {
  report: FileDiagnosticsReport;
  diagnosticLimitReached: boolean;
  /** Compiler-backed findings retained for callers that need to act on the audit. */
  candidates: MissingImportDiagnostic[];
  routed: RoutedDocument;
  snapshots: AuditedDocumentSnapshot[];
}

type FileAnalysisResult = AnalyzedFile | "read-error" | undefined;

/** The report DTO together with the semantic findings that produced it. */
export interface DiagnosticsAudit {
  report: DiagnosticsReport;
  files: AnalyzedFile[];
  /** Every template input the audit successfully analyzed, including clean templates. */
  snapshots: AuditedDocumentSnapshot[];
}

/** Exact input used to analyze one template. */
export interface AuditedDocumentSnapshot {
  routed: RoutedDocument;
  text: string;
  version: number | null;
  runtimeGeneration: number;
}

function markIncomplete(report: DiagnosticsReport, reason: AuditIncompleteReason): void {
  report.complete = false;
  if (!report.incompleteReasons.includes(reason)) {
    report.incompleteReasons.push(reason);
  }
}

function emptyAudit(scope: "project" | "workspace", projectsScanned: number): DiagnosticsAudit {
  return {
    report: {
      totalIssues: 0,
      files: [],
      timestamp: new Date().toISOString(),
      scope,
      projectsScanned,
      templatesScanned: 0,
      complete: true,
      incompleteReasons: [],
    },
    files: [],
    snapshots: [],
  };
}

function stopForCancellation(report: DiagnosticsReport, cancellation: CancellationSignal): boolean {
  if (!cancellation.isCancelled) {
    return false;
  }
  markIncomplete(report, "cancelled");
  return true;
}

async function yieldAfterBatch(index: number): Promise<void> {
  if ((index + 1) % BATCH_SIZE === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** How the caller learns how far along the scan is. */
export interface ReportProgress {
  /**
   * @param message What is being scanned now.
   * @param percentage How much of the scan is done, 0 to 100.
   */
  report(message: string, percentage: number): void;
}

export interface DiagnosticsReporterOptions {
  diagnostics: DiagnosticsHandler;
  /** Whether the compiler-backed analysis can produce trustworthy results yet. */
  analysisReady?(): boolean;
  /** Reads a file's text; injected so the reporter can be tested without disk. */
  readFile?(filePath: string): Promise<string>;
  /** Reads the editor-visible text and version when the document is open. */
  readDocument?(filePath: string): Promise<{ text: string; version: number | null }>;
  logger?: CoreLogger;
}

/** Scans whole projects for missing imports. */
export class DiagnosticsReporter {
  private readonly readDocument: (filePath: string) => Promise<{ text: string; version: number | null }>;
  private readonly logger: CoreLogger;

  constructor(private readonly options: DiagnosticsReporterOptions) {
    const readFile = options.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf-8"));
    this.readDocument =
      options.readDocument ?? (async (filePath) => ({ text: await readFile(filePath), version: null }));
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * Analyzes every template in the given projects.
   * @param runtimes The projects to scan.
   * @param progress Where the scan reports how far it has come.
   * @param cancellation Checked between files; a cancelled scan returns what it had.
   */
  async run(
    runtimes: readonly ProjectRuntime[],
    progress?: ReportProgress,
    cancellation: CancellationSignal = neverCancelled,
    scope: "project" | "workspace" = runtimes.length === 1 ? "project" : "workspace"
  ): Promise<DiagnosticsReport> {
    return (await this.audit(runtimes, progress, cancellation, scope)).report;
  }

  /**
   * Runs the same audit while retaining its compiler-backed findings for server-side
   * operations such as workspace Fix All. The semantic data never crosses JSON-RPC.
   */
  async audit(
    runtimes: readonly ProjectRuntime[],
    progress?: ReportProgress,
    cancellation: CancellationSignal = neverCancelled,
    scope: "project" | "workspace" = runtimes.length === 1 ? "project" : "workspace"
  ): Promise<DiagnosticsAudit> {
    const audit = emptyAudit(scope, runtimes.length);

    if (cancellation.isCancelled) {
      audit.report.projectsScanned = 0;
      markIncomplete(audit.report, "cancelled");
      return audit;
    }

    if (this.options.analysisReady?.() === false) {
      markIncomplete(audit.report, "analysis-not-ready");
      return audit;
    }

    const candidates = await this.collectTemplates(runtimes);
    this.logger.info(`[Report] Scanning ${candidates.length} template(s) across ${runtimes.length} project(s)`);
    await this.scanCandidates(candidates, audit, progress, cancellation);
    return audit;
  }

  private async scanCandidates(
    candidates: readonly AuditCandidate[],
    audit: DiagnosticsAudit,
    progress: ReportProgress | undefined,
    cancellation: CancellationSignal
  ): Promise<void> {
    for (const [index, candidate] of candidates.entries()) {
      if (stopForCancellation(audit.report, cancellation) || this.applyLimits(audit.report)) {
        break;
      }

      progress?.report(shortName(candidate.filePath), Math.round((index / Math.max(candidates.length, 1)) * 100));
      const analysis = await this.analyzeFile(candidate, cancellation);
      this.recordAuditResult(audit, analysis);
      if (stopForCancellation(audit.report, cancellation)) {
        break;
      }

      await yieldAfterBatch(index);
    }
  }

  private recordAuditResult(audit: DiagnosticsAudit, analysis: FileAnalysisResult): void {
    this.recordAnalysis(audit.report, analysis);
    if (!analysis || analysis === "read-error") {
      return;
    }
    audit.snapshots.push(...analysis.snapshots);
    if (analysis.report.diagnostics.length > 0) {
      audit.files.push(analysis);
    }
  }

  /** Incorporates one candidate's outcome into the report. */
  private recordAnalysis(report: DiagnosticsReport, fileReport: FileAnalysisResult): void {
    if (fileReport === "read-error") {
      markIncomplete(report, "read-error");
      return;
    }
    if (!fileReport) {
      return;
    }

    report.templatesScanned += 1;
    if (fileReport.diagnosticLimitReached) {
      report.truncated = true;
      report.truncationReason = `Template limited to ${MAX_DIAGNOSTICS_PER_FILE} diagnostics`;
      markIncomplete(report, `diagnostic-limit:${fileReport.report.filePath}`);
    }
    if (fileReport.report.diagnostics.length > 0) {
      report.files.push(fileReport.report);
      report.totalIssues += fileReport.report.diagnostics.length;
    }
  }

  /**
   * Marks the report truncated once a limit is reached, and says which one.
   * @returns Whether the scan should stop.
   * @internal
   */
  private applyLimits(report: DiagnosticsReport): boolean {
    if (report.totalIssues >= MAX_TOTAL_DIAGNOSTICS) {
      report.truncated = true;
      report.truncationReason = TRUNCATED_BY_DIAGNOSTICS;
      markIncomplete(report, "diagnostic-limit");
      return true;
    }
    if (report.files.length >= MAX_FILES) {
      report.truncated = true;
      report.truncationReason = TRUNCATED_BY_FILES;
      markIncomplete(report, "file-limit");
      return true;
    }
    return false;
  }

  /**
   * Analyzes one file, returning nothing when the file has no analyzable template.
   * A template with no findings returns an empty file report so the caller can count it
   * without listing it among the files a reader has to act on.
   * @internal
   */
  private async analyzeFile(candidate: AuditCandidate, cancellation: CancellationSignal): Promise<FileAnalysisResult> {
    const { filePath } = candidate;
    let text: string;
    let version: number | null;
    try {
      ({ text, version } = await this.readDocument(filePath));
    } catch (error) {
      this.logger.debug(`[Report] Could not read ${filePath}: ${String(error)}`);
      return "read-error";
    }

    const external = filePath.endsWith(".html");
    const document = diskDocument(filePath, text, external);
    const routedAnalysis = this.options.diagnostics.analyzeRouted;
    const runtimeGeneration = candidate.runtime.indexGeneration;
    const result = routedAnalysis
      ? routedAnalysis.call(this.options.diagnostics, document, candidate, cancellation)
      : this.options.diagnostics.analyze(document, cancellation);
    if (!result) {
      return undefined;
    }

    let owner: { text: string; version: number | null } | undefined;
    if (external && !cancellation.isCancelled) {
      try {
        owner = await this.readDocument(candidate.componentFilePath);
      } catch (error) {
        this.logger.debug(`[Report] Could not read ${candidate.componentFilePath}: ${String(error)}`);
        return "read-error";
      }
    }

    const candidates = result.candidates.slice(0, MAX_DIAGNOSTICS_PER_FILE);
    return {
      diagnosticLimitReached: result.candidates.length > MAX_DIAGNOSTICS_PER_FILE,
      candidates,
      routed: candidate,
      snapshots: [
        { routed: candidate, text, version, runtimeGeneration },
        ...(owner
          ? [
              {
                routed: { ...candidate, filePath: candidate.componentFilePath, externalTemplate: false },
                text: owner.text,
                version: owner.version,
                runtimeGeneration,
              },
            ]
          : []),
      ],
      report: {
        filePath,
        templateType: external ? "external" : "inline",
        diagnostics: candidates.map(toReportedDiagnostic),
      },
    };
  }

  /**
   * The files worth analyzing: every external template that has a component beside it,
   * and every TypeScript file, since only the analysis can tell which of them carry an
   * inline template.
   * @internal
   */
  private async collectTemplates(runtimes: readonly ProjectRuntime[]): Promise<AuditCandidate[]> {
    const candidates: AuditCandidate[] = [];

    for (const runtime of runtimes) {
      const [typescript, templates] = await Promise.all([runtime.listSourceFiles(), runtime.listTemplateFiles()]);
      const components = new Set(typescript);

      for (const filePath of templates) {
        const componentFilePath = runtime.indexedComponentFileForTemplate(filePath);
        if (componentFilePath && components.has(componentFilePath)) {
          candidates.push({ filePath, componentFilePath, externalTemplate: true, runtime });
        }
      }
      for (const filePath of typescript) {
        candidates.push({ filePath, componentFilePath: filePath, externalTemplate: false, runtime });
      }
    }

    return candidates;
  }
}

/**
 * Presents a file read from disk as a document the analysis can work on.
 *
 * Version zero throughout: nothing here was ever edited, so there is no version to be
 * behind, and no result is retained that a later edit could make stale.
 * @internal
 */
function diskDocument(filePath: string, text: string, external: boolean): DocumentView {
  const lineStarts = computeLineStarts(text);

  return {
    uri: pathToFileURL(filePath).toString(),
    languageId: external ? "html" : "typescript",
    version: 0,
    getText: () => text,
    offsetAt: (position) => (lineStarts[position.line] ?? text.length) + position.character,
    positionAt: (offset) => {
      const line = lineOf(lineStarts, offset);
      return { line, character: offset - lineStarts[line] };
    },
  };
}

/** @internal */
function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

/**
 * The line an offset falls on, by binary search over the line starts.
 * @internal
 */
function lineOf(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** @internal */
function toReportedDiagnostic(diagnostic: MissingImportDiagnostic): ReportedDiagnostic {
  return {
    range: diagnostic.range,
    message: diagnostic.message,
    code: diagnostic.code,
    severity: diagnostic.severity,
  };
}

/** The last two path segments, which is enough to recognize a file in a progress line. */
function shortName(filePath: string): string {
  return filePath.split(/[\\/]/).slice(-2).join("/");
}
