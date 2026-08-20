/**
 * Planning the edit that makes elements importable, without applying it.
 *
 * A completion, a quick fix, and fix-all all need the same edit; they differ only in
 * how it reaches the user — as a workspace edit the server requests, or as one carried
 * by a code action the client applies. Planning is therefore separate from delivery,
 * and both callers get the same versioned result.
 *
 * Nothing here writes to disk and nothing saves.
 * @module
 */

import { planImports } from "../core/import-planner";
import { resolveElementImportPath } from "../core/import-resolution";
import type { CoreRange } from "../core/language-types";
import { type CoreLogger, silentLogger } from "../core/logging";
import type { AngularElementData } from "../types";
import type { OpenDocuments } from "./open-documents";
import type { ProjectRouter } from "./project-router";

/** Why an import could not be planned or applied. */
export type ImportEditFailure = "unroutable" | "unreadable" | "stale" | "rejected";

/** A workspace edit as this server emits it: one versioned document change. */
export interface VersionedWorkspaceEdit {
  documentChanges: Array<{
    textDocument: { uri: string; version: number | null };
    edits: Array<{ range: CoreRange; newText: string }>;
  }>;
}

/** The outcome of planning. An empty `edit` means the imports were already there. */
export interface PlannedImportEdit {
  edit?: VersionedWorkspaceEdit;
  /** Identifiers added to the component's `imports: [...]`. */
  addedImports: string[];
  reason?: ImportEditFailure;
}

export interface ImportEditPlannerOptions {
  router: ProjectRouter;
  documents: OpenDocuments;
  /** Reads a file that is not open; injected so callers can be tested without disk. */
  readFile(filePath: string): string;
  logger?: CoreLogger;
}

/** Plans the edits that add imports to a component file. */
export class ImportEditPlanner {
  private readonly logger: CoreLogger;

  constructor(private readonly options: ImportEditPlannerOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * Plans the edit that makes every element importable in one file.
   * @param uri URI of the TypeScript file the imports belong in.
   * @param elements The elements the template needs.
   */
  async plan(uri: string, elements: AngularElementData[]): Promise<PlannedImportEdit> {
    const routed = this.options.router.resolve(uri);
    if (!routed) {
      return this.fail("unroutable", `No Angular project owns ${uri}`);
    }

    let text: string;
    let version: number | null;
    try {
      ({ text, version } = this.options.documents.currentText(routed.filePath, this.options.readFile));
    } catch (error) {
      return this.fail("unreadable", `Could not read ${routed.filePath}: ${String(error)}`);
    }

    const { runtime } = routed;
    const generation = runtime.indexGeneration;
    const plan = await planImports({
      filePath: routed.filePath,
      text,
      version: version ?? 0,
      elements,
      project: runtime.indexer.project,
      resolveImportPath: (element) =>
        resolveElementImportPath(element, routed.filePath, runtime.rootPath, (modulePath, fromFile) =>
          runtime.resolveImportPath(modulePath, fromFile)
        ),
      logger: this.logger,
    });

    const [edit] = plan.edits;
    if (!edit) {
      return { addedImports: plan.addedImports };
    }

    // Resolving import paths awaited the project; if the file or the index moved while
    // it did, the planned text describes a file that no longer exists.
    if (this.hasMovedOn(routed.filePath, version, runtime.indexGeneration, generation)) {
      return this.fail("stale", `Discarded a stale import plan for ${routed.filePath}`);
    }

    return {
      addedImports: plan.addedImports,
      edit: {
        documentChanges: [
          {
            textDocument: { uri, version },
            edits: [{ range: edit.range, newText: edit.newText }],
          },
        ],
      },
    };
  }

  /**
   * Whether the document or the project index changed while the plan was computed.
   * @internal
   */
  private hasMovedOn(
    filePath: string,
    plannedVersion: number | null,
    currentGeneration: number,
    plannedGeneration: number
  ): boolean {
    if (currentGeneration !== plannedGeneration) {
      return true;
    }
    const open = this.options.documents.byPath(filePath);
    return open !== undefined && plannedVersion !== null && open.version !== plannedVersion;
  }

  /** @internal */
  private fail(reason: ImportEditFailure, message: string): PlannedImportEdit {
    this.logger.warn(`[ImportEdit] ${message}`);
    return { addedImports: [], reason };
  }
}
