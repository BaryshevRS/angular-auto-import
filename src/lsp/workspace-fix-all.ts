/**
 * Two-phase workspace Fix All orchestration.
 *
 * Preparation performs a fresh compiler-backed audit, selects elements with the same
 * rules as document Fix All, and plans every owning component through the shared import
 * planner. The resulting versioned workspace edit stays server-side behind an opaque
 * transaction id. Application submits that exact edit once and never replans it.
 * @module
 */

import { randomUUID } from "node:crypto";
import type { CancellationSignal } from "../core/cancellation";
import { neverCancelled } from "../core/cancellation";
import type { CoreLogger } from "../core/logging";
import { silentLogger } from "../core/logging";
import type { MissingImportDiagnostic } from "../core/missing-imports";
import type { AngularElementData } from "../types";
import type { CodeActionHandler } from "./code-actions";
import type { ImportEditPlanner, ImportEditSnapshot, VersionedWorkspaceEdit } from "./import-edit";
import type { RoutedDocument } from "./project-router";
import type { ProjectRuntime } from "./project-runtime";
import type { AppliedWorkspaceFixAll, FixAllSummary, PreparedWorkspaceFixAll } from "./protocol";
import type { DiagnosticsReporter } from "./report";

interface PreparedTransaction {
  summary: FixAllSummary;
  edit?: VersionedWorkspaceEdit;
  snapshots: PreparedSnapshot[];
}

interface PreparedSnapshot {
  filePath: string;
  text: string;
  version: number | null;
  runtime: ProjectRuntime;
  runtimeGeneration: number;
}

interface FixAllOwner {
  routed: RoutedDocument;
  candidates: MissingImportDiagnostic[];
}

interface PlannedWorkspaceFixAll {
  edit: VersionedWorkspaceEdit;
  importsAdded: number;
}

export interface WorkspaceFixAllOptions {
  reporter: DiagnosticsReporter;
  runtimes(): readonly ProjectRuntime[];
  codeActions: CodeActionHandler;
  planner: ImportEditPlanner;
  currentDocument(filePath: string): { text: string; version: number | null };
  canApplyAtomically(): boolean;
  applyEdit(edit: VersionedWorkspaceEdit): Promise<boolean>;
  logger?: CoreLogger;
}

/** Prepares and applies opaque, one-shot workspace Fix All transactions. */
export class WorkspaceFixAll {
  private readonly transactions = new Map<string, PreparedTransaction>();
  private readonly logger: CoreLogger;
  private prepareEpoch = 0;

  constructor(private readonly options: WorkspaceFixAllOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /** Audits and plans without asking the client to apply anything. */
  async prepare(
    runtimes: readonly ProjectRuntime[],
    scope: "project" | "workspace",
    cancellation: CancellationSignal = neverCancelled
  ): Promise<PreparedWorkspaceFixAll> {
    const epoch = this.beginPreparation();
    if (!this.options.canApplyAtomically()) {
      this.logger.warn("[WorkspaceFixAll] Client cannot guarantee an atomic multi-document text edit");
      return unfixable();
    }
    const audit = await this.options.reporter.audit(runtimes, undefined, cancellation, scope);

    if (!audit.report.complete || !this.isPreparationCurrent(epoch, cancellation)) {
      return unfixable();
    }

    const snapshots = normalizeSnapshots(
      audit.snapshots.map((snapshot) => ({
        filePath: snapshot.routed.filePath,
        text: snapshot.text,
        version: snapshot.version,
        runtime: snapshot.routed.runtime,
        runtimeGeneration: snapshot.runtimeGeneration,
      }))
    );
    if (!snapshots) {
      return unfixable();
    }

    const planned = await this.planOwners(groupByOwner(audit.files), snapshots, epoch, cancellation);
    if (!planned || !this.isPreparationCurrent(epoch, cancellation)) {
      return unfixable();
    }

    const summary: FixAllSummary = {
      totalIssues: audit.report.totalIssues,
      filesChanged: planned.edit.documentChanges.length,
      importsAdded: planned.importsAdded,
    };
    if (summary.filesChanged === 0 || summary.importsAdded === 0) {
      return unfixable();
    }
    return this.publish(epoch, summary, planned.edit, Array.from(snapshots.values()));
  }

  private beginPreparation(): number {
    this.transactions.clear();
    this.prepareEpoch += 1;
    return this.prepareEpoch;
  }

  private isPreparationCurrent(epoch: number, cancellation: CancellationSignal): boolean {
    return epoch === this.prepareEpoch && !cancellation.isCancelled;
  }

  private async planOwners(
    owners: ReadonlyMap<string, FixAllOwner>,
    snapshots: Map<string, PreparedSnapshot>,
    epoch: number,
    cancellation: CancellationSignal
  ): Promise<PlannedWorkspaceFixAll | undefined> {
    const edit: VersionedWorkspaceEdit = { documentChanges: [] };
    let importsAdded = 0;

    for (const [componentFilePath, owner] of owners) {
      const componentSnapshot = snapshots.get(componentFilePath);
      if (!componentSnapshot || !hasExactlyOneComponentDecorator(componentSnapshot.text)) {
        this.logger.warn(`[WorkspaceFixAll] Ambiguous component owner in ${componentFilePath}`);
        return undefined;
      }
      const planned = await this.planOwner(componentFilePath, owner, cancellation);
      if (!planned || !this.isPreparationCurrent(epoch, cancellation)) {
        return undefined;
      }
      if (planned.edit) {
        edit.documentChanges.push(...planned.edit.documentChanges);
        importsAdded += planned.addedImports.length;
      }
      if (planned.snapshot && !recordSnapshot(snapshots, toPreparedSnapshot(planned.snapshot))) {
        return undefined;
      }
    }

    return { edit, importsAdded };
  }

  private async planOwner(componentFilePath: string, owner: FixAllOwner, cancellation: CancellationSignal) {
    const selected = await this.options.codeActions.selectFixAllElements(owner.candidates, owner.routed, cancellation);
    if (!selected || cancellation.isCancelled) {
      return undefined;
    }

    const elements = uniqueElements(selected);
    const planned = await this.options.planner.planRouted(owner.routed, elements);
    if (planned.reason) {
      this.logger.warn(`[WorkspaceFixAll] Could not prepare ${componentFilePath}: ${planned.reason}`);
      return undefined;
    }
    if (!includesEveryImport(elements, planned.addedImports)) {
      this.logger.warn(`[WorkspaceFixAll] Could not add every decorator import to ${componentFilePath}`);
      return undefined;
    }
    return planned;
  }

  private publish(
    epoch: number,
    summary: FixAllSummary,
    edit: VersionedWorkspaceEdit,
    snapshots: PreparedSnapshot[]
  ): PreparedWorkspaceFixAll {
    if (epoch !== this.prepareEpoch) {
      return unfixable();
    }
    const transactionId = randomUUID();
    this.transactions.set(transactionId, {
      summary,
      edit: edit.documentChanges.length > 0 ? edit : undefined,
      snapshots,
    });
    return { ready: true, transactionId, ...summary };
  }

  /** Applies one prepared transaction exactly once through one workspace edit request. */
  async apply(transactionId: string): Promise<AppliedWorkspaceFixAll> {
    const transaction = this.transactions.get(transactionId);
    this.transactions.delete(transactionId);
    if (!transaction) {
      return { applied: false, reason: "consumed", totalIssues: 0, filesChanged: 0, importsAdded: 0 };
    }
    if (!transaction.edit) {
      return { applied: false, ...transaction.summary };
    }
    if (this.isStale(transaction.snapshots)) {
      return { applied: false, reason: "stale", ...transaction.summary };
    }

    try {
      const applied = await this.options.applyEdit(transaction.edit);
      return { applied, ...(!applied && { reason: "rejected" as const }), ...transaction.summary };
    } catch (error) {
      this.logger.warn(`[WorkspaceFixAll] Client rejected the prepared edit: ${String(error)}`);
      return { applied: false, reason: "rejected", ...transaction.summary };
    }
  }

  /** Releases any confirmations that have not been used. */
  dispose(): void {
    this.prepareEpoch += 1;
    this.transactions.clear();
  }

  /** Every prepared input must still be byte-for-byte and generation-for-generation identical. */
  private isStale(snapshots: readonly PreparedSnapshot[]): boolean {
    const currentRuntimes = new Set(this.options.runtimes());
    return snapshots.some((snapshot) => {
      if (!currentRuntimes.has(snapshot.runtime) || snapshot.runtime.indexGeneration !== snapshot.runtimeGeneration) {
        return true;
      }
      try {
        const current = this.options.currentDocument(snapshot.filePath);
        return current.text !== snapshot.text || current.version !== snapshot.version;
      } catch {
        return true;
      }
    });
  }
}

function groupByOwner(
  files: readonly { routed: RoutedDocument; candidates: MissingImportDiagnostic[] }[]
): Map<string, FixAllOwner> {
  const byOwner = new Map<string, FixAllOwner>();
  for (const file of files) {
    const owner = byOwner.get(file.routed.componentFilePath);
    if (owner) {
      owner.candidates.push(...file.candidates);
    } else {
      byOwner.set(file.routed.componentFilePath, { routed: file.routed, candidates: [...file.candidates] });
    }
  }
  return byOwner;
}

function normalizeSnapshots(snapshots: readonly PreparedSnapshot[]): Map<string, PreparedSnapshot> | undefined {
  const normalized = new Map<string, PreparedSnapshot>();
  for (const snapshot of snapshots) {
    if (!recordSnapshot(normalized, snapshot)) {
      return undefined;
    }
  }
  return normalized;
}

function recordSnapshot(snapshots: Map<string, PreparedSnapshot>, snapshot: PreparedSnapshot): boolean {
  const existing = snapshots.get(snapshot.filePath);
  if (!existing) {
    snapshots.set(snapshot.filePath, snapshot);
    return true;
  }
  return (
    existing.text === snapshot.text &&
    existing.version === snapshot.version &&
    existing.runtime === snapshot.runtime &&
    existing.runtimeGeneration === snapshot.runtimeGeneration
  );
}

function toPreparedSnapshot(snapshot: ImportEditSnapshot): PreparedSnapshot {
  return {
    filePath: snapshot.filePath,
    text: snapshot.text,
    version: snapshot.version,
    runtime: snapshot.runtime,
    runtimeGeneration: snapshot.runtimeGeneration,
  };
}

/** Keeps distinct exports distinct even when libraries reuse the same class name. */
function uniqueElements(elements: readonly AngularElementData[]): AngularElementData[] {
  return Array.from(new Map(elements.map((element) => [elementIdentity(element), element])).values());
}

function elementIdentity(element: AngularElementData): string {
  return [element.name, element.path, element.absolutePath ?? "", element.exportingModuleName ?? ""].join("\0");
}

function includesEveryImport(elements: readonly AngularElementData[], addedImports: readonly string[]): boolean {
  const added = new Set(addedImports);
  return elements.every((element) => added.has(element.exportingModuleName || element.name));
}

/** The shared planner targets one decorator; refuse files where that owner is ambiguous. */
function hasExactlyOneComponentDecorator(text: string): boolean {
  return (text.match(/@Component\s*\(/g) ?? []).length === 1;
}

function unfixable(): PreparedWorkspaceFixAll {
  return { ready: false, reason: "unfixable" };
}
