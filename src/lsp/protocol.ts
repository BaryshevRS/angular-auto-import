/**
 * The custom requests the client and server agree on.
 *
 * Everything that is a language feature goes over standard LSP; what is left is the
 * extension's own UI and reporting, which LSP has no vocabulary for. Those live here,
 * as request types both sides import, so a change to one end fails to compile at the
 * other rather than at runtime.
 *
 * This module is deliberately dependency-light: only the protocol package, no `vscode`,
 * no `ts-morph`, no server internals. Every payload is a plain serializable DTO, since
 * everything here crosses a JSON-RPC boundary.
 * @module
 */

import { NotificationType, RequestType, RequestType0 } from "vscode-languageserver-protocol";
import type { CoreDiagnosticSeverity, CoreRange } from "../core/language-types";

/**
 * Kills the server, so a test can prove the client brings a new one up.
 *
 * The server only listens for it when its host says to; nothing a user runs can reach it.
 */
export const CRASH_NOTIFICATION = "angularAutoImport/testCrash";

/** The fix-all action this server contributes, as an LSP code-action kind. */
export const FIX_ALL_KIND = "source.fixAll.angular-auto-import";

/** What one project's index looks like from the outside. */
export interface ProjectSummary {
  /** Absolute path of the Angular project root. */
  rootPath: string;
  /** How many selectors the project has indexed. */
  elementCount: number;
}

/**
 * What the server found to work on, and why it found nothing when it found nothing.
 *
 * Discovery failing is indistinguishable, from the outside, from a workspace with no
 * missing imports: both are silence. This is what turns the first case into something
 * the user can see and act on.
 */
export interface ProjectsStatus {
  /** The roots the server was given to search, after `projectPath` was applied. */
  workspaceRoots: string[];
  /** The Angular projects discovered inside them. */
  projects: ProjectSummary[];
  /** Present only when {@link ProjectsStatus.projects} is empty: one sentence saying why. */
  problem?: string;
}

/** Pushed after discovery settles, and whenever what it found changes. */
export const ProjectsStatusNotification = new NotificationType<ProjectsStatus>("angularAutoImport/projectsStatus");

/** Which projects an operation should touch. */
export interface ProjectScope {
  /**
   * Restrict the operation to the project owning this document. Every discovered
   * project is used when it is absent, or when no project owns it.
   */
  uri?: string;
  /**
   * Progress token the client supplied for a long operation, as LSP's
   * `WorkDoneProgressParams` defines it. Without one the server reports no progress.
   */
  workDoneToken?: number | string;
}

/** One project's outcome, so the client can report partial success honestly. */
export interface ProjectOutcome extends ProjectSummary {
  /** Present when this project failed; the others in the same request may still have succeeded. */
  error?: string;
}

/** What a reindex did, per project. */
export interface ProjectOperationResult {
  projects: ProjectOutcome[];
}

/**
 * Rebuilds the index of the scoped projects, re-reading their TypeScript configuration
 * first so a changed `paths` mapping takes effect.
 */
export const ReindexRequest = new RequestType<ProjectScope, ProjectOperationResult, void>("angularAutoImport/reindex");

export interface PerformanceMetrics {
  /** Bytes, as `process.memoryUsage` reports them. */
  memory: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
  /** Microseconds, as `process.cpuUsage` reports them. */
  cpu: {
    user: number;
    system: number;
  };
  projects: ProjectSummary[];
  /**
   * Whether the Angular compiler has finished loading.
   *
   * It is imported lazily, and until it arrives the server answers every diagnostic
   * request with nothing — which looks exactly like a workspace with no problems.
   */
  analysisReady: boolean;
}

/**
 * Reads the server process's own memory, CPU, and index sizes. These describe the
 * server, not the Extension Host, which is the point of asking it.
 */
export const PerformanceMetricsRequest = new RequestType0<PerformanceMetrics, void>(
  "angularAutoImport/performanceMetrics"
);

/** A diagnostic as the report carries it, independent of any editor's type. */
export interface ReportedDiagnostic {
  range: CoreRange;
  message: string;
  code: string;
  severity: CoreDiagnosticSeverity;
}

/** One file's findings. */
export interface FileDiagnosticsReport {
  /** Absolute path of the file the template belongs to. */
  filePath: string;
  templateType: "inline" | "external";
  diagnostics: ReportedDiagnostic[];
}

/** Why an audit could not inspect its whole requested scope. */
export type AuditIncompleteReason =
  | "cancelled"
  | "analysis-not-ready"
  | "read-error"
  | "diagnostic-limit"
  | `diagnostic-limit:${string}`
  | "file-limit";

/** Everything a project or workspace audit found. */
export interface DiagnosticsReport {
  totalIssues: number;
  files: FileDiagnosticsReport[];
  /** ISO 8601; a `Date` does not survive JSON-RPC. */
  timestamp: string;
  scope: "project" | "workspace";
  projectsScanned: number;
  templatesScanned: number;
  complete: boolean;
  incompleteReasons: AuditIncompleteReason[];
  /** Whether limits stopped the scan before it had seen everything. */
  truncated?: boolean;
  truncationReason?: string;
}

/**
 * Scans every template in the scoped projects and reports what is missing an import.
 *
 * This is the most expensive public operation the server performs, so it honors the
 * request's cancellation token and reports work-done progress against the token the
 * client supplies in `workDoneToken`.
 */
export const DiagnosticsReportRequest = new RequestType<ProjectScope, DiagnosticsReport, void>(
  "angularAutoImport/diagnosticsReport"
);
