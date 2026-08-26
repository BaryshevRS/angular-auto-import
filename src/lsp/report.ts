/**
 * The workspace-wide diagnostics report.
 *
 * A debugging tool, and by far the most expensive thing the server does: it analyzes
 * every template in the scoped projects, most of which nobody has open. It therefore
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
import { switchFileType } from "../utils/path";
import type { DiagnosticsHandler } from "./diagnostics";
import type { ProjectRuntime } from "./project-runtime";
import type { DiagnosticsReport, FileDiagnosticsReport, ReportedDiagnostic } from "./protocol";

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
  /** Reads a file's text; injected so the reporter can be tested without disk. */
  readFile?(filePath: string): Promise<string>;
  logger?: CoreLogger;
}

/** Scans whole projects for missing imports. */
export class DiagnosticsReporter {
  private readonly readFile: (filePath: string) => Promise<string>;
  private readonly logger: CoreLogger;

  constructor(private readonly options: DiagnosticsReporterOptions) {
    this.readFile = options.readFile ?? ((filePath) => fs.readFile(filePath, "utf-8"));
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
    cancellation: CancellationSignal = neverCancelled
  ): Promise<DiagnosticsReport> {
    const report: DiagnosticsReport = { totalIssues: 0, files: [], timestamp: new Date().toISOString() };
    const candidates = await this.collectTemplates(runtimes);
    this.logger.info(`[Report] Scanning ${candidates.length} template(s) across ${runtimes.length} project(s)`);

    for (const [index, filePath] of candidates.entries()) {
      if (cancellation.isCancelled) {
        break;
      }

      if (this.applyLimits(report)) {
        break;
      }

      progress?.report(shortName(filePath), Math.round((index / Math.max(candidates.length, 1)) * 100));
      const fileReport = await this.analyzeFile(filePath);
      if (fileReport) {
        report.files.push(fileReport);
        report.totalIssues += fileReport.diagnostics.length;
      }

      // Yield between batches: the connection has to keep answering while this runs.
      if ((index + 1) % BATCH_SIZE === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return report;
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
      return true;
    }
    if (report.files.length >= MAX_FILES) {
      report.truncated = true;
      report.truncationReason = TRUNCATED_BY_FILES;
      return true;
    }
    return false;
  }

  /**
   * Analyzes one file, returning nothing for a file with no findings, so the report
   * lists only what a reader has to act on.
   * @internal
   */
  private async analyzeFile(filePath: string): Promise<FileDiagnosticsReport | undefined> {
    let text: string;
    try {
      text = await this.readFile(filePath);
    } catch (error) {
      this.logger.debug(`[Report] Could not read ${filePath}: ${String(error)}`);
      return undefined;
    }

    const external = filePath.endsWith(".html");
    const result = this.options.diagnostics.analyze(diskDocument(filePath, text, external));
    if (!result || result.candidates.length === 0) {
      return undefined;
    }

    return {
      filePath,
      templateType: external ? "external" : "inline",
      diagnostics: result.candidates.slice(0, MAX_DIAGNOSTICS_PER_FILE).map(toReportedDiagnostic),
    };
  }

  /**
   * The files worth analyzing: every external template that has a component beside it,
   * and every TypeScript file, since only the analysis can tell which of them carry an
   * inline template.
   * @internal
   */
  private async collectTemplates(runtimes: readonly ProjectRuntime[]): Promise<string[]> {
    const files: string[] = [];

    for (const runtime of runtimes) {
      const [typescript, templates] = await Promise.all([runtime.listSourceFiles(), runtime.listTemplateFiles()]);
      const components = new Set(typescript);

      files.push(
        // A template with no component beside it has no imports array to be missing from.
        ...templates.filter((filePath) => components.has(switchFileType(filePath, ".ts"))),
        ...typescript
      );
    }

    return files;
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
