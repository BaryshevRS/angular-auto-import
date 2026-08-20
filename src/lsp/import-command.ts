/**
 * Applying an import from the server.
 *
 * Accepting a completion in an external template has to edit a different file than the
 * one the user is typing in, which no completion edit can express. The server therefore
 * asks the client to run this command, computes the edit against the file as the user
 * currently sees it, and sends it back as a versioned workspace edit — so the client
 * applies it as one undoable operation and rejects it outright if the file moved on.
 *
 * Nothing here writes to disk and nothing saves: the edit is the client's to apply.
 * @module
 */

import * as fs from "node:fs";
import { planImports } from "../core/import-planner";
import { resolveElementImportPath } from "../core/import-resolution";
import type { CoreRange } from "../core/language-types";
import { type CoreLogger, silentLogger } from "../core/logging";
import { AngularElementData } from "../types";
import type { OpenDocuments } from "./open-documents";
import type { ProjectRouter } from "./project-router";

/** The command a completion item asks the client to run once it is accepted. */
export const APPLY_IMPORT_COMMAND = "angular-auto-import.lsp.applyImport";

/** The single argument the command carries; must stay JSON-serializable. */
export interface ApplyImportArguments {
  /** URI of the TypeScript file the imports belong in. */
  uri: string;
  /** The elements to make importable, as plain data. */
  elements: AngularElementData[];
}

/** Why an import could not be applied, for the log. */
export type ApplyImportFailure = "unroutable" | "unreadable" | "stale" | "rejected";

/** What happened, so callers and tests can assert on it without inspecting the edit. */
export interface ApplyImportResult {
  applied: boolean;
  /** Identifiers added to the component's `imports: [...]`; empty when nothing changed. */
  addedImports: string[];
  reason?: ApplyImportFailure;
}

/** A workspace edit as this handler emits it: one versioned document change. */
export interface VersionedWorkspaceEdit {
  documentChanges: Array<{
    textDocument: { uri: string; version: number | null };
    edits: Array<{ range: CoreRange; newText: string }>;
  }>;
}

export interface ImportCommandHandlerOptions {
  router: ProjectRouter;
  documents: OpenDocuments;
  /** Sends the edit to the client; `applied` is the client's answer. */
  applyEdit(edit: VersionedWorkspaceEdit): Promise<boolean>;
  /** Reads a file that is not open; injected so the handler can be tested without disk. */
  readFile?(filePath: string): string;
  logger?: CoreLogger;
}

/** Executes {@link APPLY_IMPORT_COMMAND}. */
export class ImportCommandHandler {
  private readonly logger: CoreLogger;
  private readonly readFile: (filePath: string) => string;

  constructor(private readonly options: ImportCommandHandlerOptions) {
    this.logger = options.logger ?? silentLogger;
    this.readFile = options.readFile ?? ((filePath) => fs.readFileSync(filePath, "utf-8"));
  }

  /**
   * Plans and applies the imports one completion or code action asked for.
   * @param args The command's argument, as it arrived over the protocol.
   */
  async execute(args: unknown): Promise<ApplyImportResult> {
    const request = parseArguments(args);
    if (!request) {
      return this.fail("unroutable", "Received an import command without a usable argument");
    }

    const routed = this.options.router.resolve(request.uri);
    if (!routed) {
      return this.fail("unroutable", `No Angular project owns ${request.uri}`);
    }

    let text: string;
    let version: number | null;
    try {
      ({ text, version } = this.options.documents.currentText(routed.filePath, this.readFile));
    } catch (error) {
      return this.fail("unreadable", `Could not read ${routed.filePath}: ${String(error)}`);
    }

    const { runtime } = routed;
    const generation = runtime.indexGeneration;
    const plan = await planImports({
      filePath: routed.filePath,
      text,
      version: version ?? 0,
      elements: request.elements,
      project: runtime.indexer.project,
      resolveImportPath: (element) =>
        resolveElementImportPath(element, routed.filePath, runtime.rootPath, (modulePath, fromFile) =>
          runtime.resolveImportPath(modulePath, fromFile)
        ),
      logger: this.logger,
    });

    const [edit] = plan.edits;
    if (!edit) {
      return { applied: true, addedImports: plan.addedImports };
    }

    // Resolving the import path awaited the project; if the file or the index moved
    // while it did, the planned text describes a file that no longer exists.
    if (this.hasMovedOn(routed.filePath, version, runtime.indexGeneration, generation)) {
      return this.fail("stale", `Discarded a stale import plan for ${routed.filePath}`);
    }

    const applied = await this.options.applyEdit({
      documentChanges: [
        {
          textDocument: { uri: request.uri, version },
          edits: [{ range: edit.range, newText: edit.newText }],
        },
      ],
    });

    if (!applied) {
      return this.fail("rejected", `The client rejected the import edit for ${routed.filePath}`);
    }

    return { applied: true, addedImports: plan.addedImports };
  }

  /**
   * Whether the document or the project index changed while the plan was being computed.
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
  private fail(reason: ApplyImportFailure, message: string): ApplyImportResult {
    this.logger.warn(`[ImportCommand] ${message}`);
    return { applied: false, addedImports: [], reason };
  }
}

/**
 * Reads the command's argument back into the elements the planner expects.
 *
 * The argument crossed JSON-RPC, so the elements arrive as plain objects and have to be
 * rebuilt; anything that does not describe an element is dropped rather than planned.
 * @internal
 */
function parseArguments(args: unknown): ApplyImportArguments | undefined {
  const candidate = Array.isArray(args) ? args[0] : args;
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }

  const { uri, elements } = candidate as { uri?: unknown; elements?: unknown };
  if (typeof uri !== "string" || !Array.isArray(elements)) {
    return undefined;
  }

  const parsed = elements.filter(isElementData).map((element) => new AngularElementData(element));
  return parsed.length > 0 ? { uri, elements: parsed } : undefined;
}

/** @internal */
function isElementData(value: unknown): value is ConstructorParameters<typeof AngularElementData>[0] {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { name, path, type } = value as Record<string, unknown>;
  return typeof name === "string" && typeof path === "string" && typeof type === "string";
}
