/**
 * Go-to-definition for elements the template uses but does not import.
 *
 * This server deliberately answers only where it has a diagnostic. An element the
 * component already imports is the Angular Language Service's to resolve, and answering
 * for it too would put two identical results behind one Ctrl+Click. The retained
 * candidates are therefore both the trigger and the filter.
 *
 * Every element that answers to the selector is returned, because a selector like
 * `[nzButton]` legitimately belongs to several declarations and picking one for the
 * user would hide the rest.
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { LocationLink, Position } from "vscode-languageserver/node";
import { type CancellationSignal, neverCancelled } from "../core/cancellation";
import type { DocumentView } from "../core/document";
import type { CoreRange } from "../core/language-types";
import { type CoreLogger, silentLogger } from "../core/logging";
import type { MissingImportDiagnostic } from "../core/missing-imports";
import type { AngularElementData } from "../types";
import { getAngularElements } from "../utils/angular";
import type { DiagnosticsHandler } from "./diagnostics";
import type { ProjectRouter, RoutedDocument } from "./project-router";

/** The start of a file, used when the class itself cannot be located inside it. */
const FILE_START: CoreRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

export interface DefinitionHandlerOptions {
  router: ProjectRouter;
  /** Supplies the candidates that decide where this server answers at all. */
  diagnostics: DiagnosticsHandler;
  /** Whether a path exists; injected so the handler can be tested without disk. */
  exists?(filePath: string): boolean;
  logger?: CoreLogger;
}

/** Answers `textDocument/definition` for unimported Angular elements. */
export class DefinitionHandler {
  private readonly logger: CoreLogger;
  private readonly exists: (filePath: string) => boolean;

  constructor(private readonly options: DefinitionHandlerOptions) {
    this.logger = options.logger ?? silentLogger;
    this.exists = options.exists ?? ((filePath) => fs.existsSync(filePath));
  }

  /**
   * Resolves the declarations behind the element at a position.
   * @param document The document the request arrived for.
   * @param position The cursor position.
   * @param cancellation Checked before the analysis the candidates come from.
   * @returns One link per matching declaration, or none where this server does not answer.
   */
  provide(
    document: DocumentView,
    position: Position,
    cancellation: CancellationSignal = neverCancelled
  ): LocationLink[] {
    const routed = this.options.router.resolve(document.uri);
    if (!routed || cancellation.isCancelled) {
      return [];
    }

    const candidate = this.options.diagnostics
      .candidatesFor(document)
      .find((diagnostic) => contains(diagnostic.range, position));
    const selector = candidate ? selectorOf(candidate) : undefined;
    if (!candidate || !selector) {
      return [];
    }

    const links: LocationLink[] = [];
    for (const element of getAngularElements(selector, routed.runtime.indexer)) {
      const link = this.locate(element, routed, candidate.range);
      if (link) {
        links.push(link);
      }
    }

    return links;
  }

  /**
   * Points one link at an element's class declaration, or at the top of its file when
   * the class cannot be found in it.
   * @internal
   */
  private locate(
    element: AngularElementData,
    routed: RoutedDocument,
    originRange: CoreRange
  ): LocationLink | undefined {
    const filePath = this.resolvePath(element, routed.runtime.rootPath);
    if (!filePath || !this.exists(filePath)) {
      this.logger.debug(`[Definition] No readable file for ${element.name}`);
      return undefined;
    }

    const targetRange = this.rangeOfClass(element, filePath, routed);
    return {
      originSelectionRange: originRange,
      targetUri: pathToFileURL(filePath).toString(),
      targetRange,
      targetSelectionRange: targetRange,
    };
  }

  /**
   * Where an element's declaration lives on disk.
   *
   * A project element's indexed path is relative to its root. An external one carries
   * the absolute path recorded while indexing it; without that its `path` is a module
   * specifier, which is not a file at all.
   * @internal
   */
  private resolvePath(element: AngularElementData, projectRootPath: string): string | undefined {
    if (!element.isExternal) {
      return path.join(projectRootPath, element.path);
    }
    return element.absolutePath;
  }

  /**
   * The range of the class's name, falling back to the whole declaration and then to the
   * start of the file. A file the project has not parsed is not parsed here either:
   * jumping to its first line is better than paying for a parse on a Ctrl+Click.
   * @internal
   */
  private rangeOfClass(element: AngularElementData, filePath: string, routed: RoutedDocument): CoreRange {
    try {
      const sourceFile = routed.runtime.indexer.project.getSourceFile(filePath);
      const classDeclaration = sourceFile?.getClass(element.name);
      if (!sourceFile || !classDeclaration) {
        return FILE_START;
      }

      const nameNode = classDeclaration.getNameNode() ?? classDeclaration;
      return {
        start: toPosition(sourceFile.getLineAndColumnAtPos(nameNode.getStart())),
        end: toPosition(sourceFile.getLineAndColumnAtPos(nameNode.getEnd())),
      };
    } catch (error) {
      this.logger.debug(`[Definition] Could not locate ${element.name} in ${filePath}: ${String(error)}`);
      return FILE_START;
    }
  }
}

/**
 * Converts ts-morph's one-based line and column into a zero-based document position.
 * @internal
 */
function toPosition(at: { line: number; column: number }): CoreRange["start"] {
  return { line: at.line - 1, character: at.column - 1 };
}

/**
 * Reads the selector out of a diagnostic code of the form `missing-<type>-import:<selector>`.
 * @internal
 */
function selectorOf(candidate: MissingImportDiagnostic): string | undefined {
  const [, selector] = candidate.code.split(":");
  return selector || undefined;
}

/**
 * Whether a range covers a position, counting both of its ends.
 * @internal
 */
function contains(range: CoreRange, position: Position): boolean {
  return !isBefore(position, range.start) && !isBefore(range.end, position);
}

/** @internal */
function isBefore(left: Position, right: Position): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}
