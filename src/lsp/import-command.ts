/**
 * Applying an import from the server.
 *
 * Accepting a completion in an external template has to edit a different file than the
 * one the user is typing in, which no completion edit can express. The server therefore
 * asks the client to run this command, and hands back the versioned workspace edit the
 * planner produced — so the client applies it as one undoable operation and rejects it
 * outright if the file moved on.
 * @module
 */

import * as fs from "node:fs";
import { type CoreLogger, silentLogger } from "../core/logging";
import { AngularElementData } from "../types";
import { type ImportEditFailure, ImportEditPlanner, type VersionedWorkspaceEdit } from "./import-edit";
import type { OpenDocuments } from "./open-documents";
import type { ProjectRouter } from "./project-router";

export type { VersionedWorkspaceEdit } from "./import-edit";

/** The command a completion item asks the client to run once it is accepted. */
export const APPLY_IMPORT_COMMAND = "angular-auto-import.lsp.applyImport";

/** The single argument the command carries; must stay JSON-serializable. */
export interface ApplyImportArguments {
  /** URI of the TypeScript file the imports belong in. */
  uri: string;
  /** The elements to make importable, as plain data. */
  elements: AngularElementData[];
}

/** What happened, so callers and tests can assert on it without inspecting the edit. */
export interface ApplyImportResult {
  applied: boolean;
  /** Identifiers added to the component's `imports: [...]`; empty when nothing changed. */
  addedImports: string[];
  reason?: ImportEditFailure;
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
  private readonly planner: ImportEditPlanner;

  constructor(private readonly options: ImportCommandHandlerOptions) {
    this.logger = options.logger ?? silentLogger;
    this.planner = new ImportEditPlanner({
      router: options.router,
      documents: options.documents,
      readFile: options.readFile ?? ((filePath) => fs.readFileSync(filePath, "utf-8")),
      logger: this.logger,
    });
  }

  /**
   * Plans and applies the imports one completion or code action asked for.
   * @param args The command's argument, as it arrived over the protocol.
   */
  async execute(args: unknown): Promise<ApplyImportResult> {
    const request = parseArguments(args);
    if (!request) {
      this.logger.warn("[ImportCommand] Received an import command without a usable argument");
      return { applied: false, addedImports: [], reason: "unroutable" };
    }

    const planned = await this.planner.plan(request.uri, request.elements);
    if (planned.reason) {
      return { applied: false, addedImports: [], reason: planned.reason };
    }

    if (!planned.edit) {
      return { applied: true, addedImports: planned.addedImports };
    }

    if (!(await this.options.applyEdit(planned.edit))) {
      this.logger.warn(`[ImportCommand] The client rejected the import edit for ${request.uri}`);
      return { applied: false, addedImports: [], reason: "rejected" };
    }

    return { applied: true, addedImports: planned.addedImports };
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
