/**
 * Missing-import analysis for one template.
 *
 * Ties the pieces together — parse the template, walk it, decide what is missing —
 * so both hosts run one implementation rather than two that drift. Parsing results
 * are cached per document version, because a template is re-analyzed far more often
 * than it changes.
 * @module
 */

import type { SourceFile } from "ts-morph";
import type { TemplateAstNode } from "../types";
import { getAngularElements } from "../utils/angular";
import type { AngularCompilerApi } from "./angular-compiler";
import { type CancellationSignal, neverCancelled } from "./cancellation";
import type { ComponentImports, ModuleExportsIndex } from "./component-imports";
import type { DocumentView } from "./document";
import type { ElementLookup } from "./element-lookup";
import type { CoreDiagnosticSeverity } from "./language-types";
import { type CoreLogger, silentLogger } from "./logging";
import { findMissingImports, type MissingImportContext, type MissingImportDiagnostic } from "./missing-imports";
import { type ScannedTemplateElement, scanTemplate } from "./template-scan";

/** A template and where it starts in the document being diagnosed. */
export interface TemplateSource {
  text: string;
  /** Zero for an external template; the decorator's template offset for an inline one. */
  offset: number;
}

/** The slice of a project's element index the analysis reads. */
export interface DiagnosticIndex extends ElementLookup, ModuleExportsIndex {}

/** Everything one template's analysis needs. */
export interface TemplateDiagnosticsRequest {
  /** The document the template lives in; its ranges are what the diagnostics carry. */
  document: DocumentView;
  template: TemplateSource;
  /** The component's source file, already holding the text to analyze against. */
  sourceFile: SourceFile;
  index: DiagnosticIndex;
  /** Answers what the component already imports, and caches those answers. */
  componentImports: ComponentImports;
  compiler: AngularCompilerApi;
  severity: CoreDiagnosticSeverity;
  /** Parsed templates to reuse; omit to parse every time. */
  cache?: TemplateAstCache;
  /** Checked before parsing and between elements; a cancelled pass returns early. */
  cancellation?: CancellationSignal;
  logger?: CoreLogger;
}

/**
 * Parsed template ASTs, keyed by document and version.
 *
 * One entry per document: a new version replaces the old one rather than growing the
 * cache, and closing a document drops it.
 */
export class TemplateAstCache {
  private readonly entries = new Map<string, { version: number; nodes: TemplateAstNode[] }>();

  /**
   * Returns the cached AST for this exact document version, or parses and stores one.
   * @param document The document being analyzed.
   * @param parse Produces the AST on a miss.
   */
  get(document: DocumentView, parse: () => TemplateAstNode[]): TemplateAstNode[] {
    const cached = this.entries.get(document.uri);
    if (cached?.version === document.version) {
      return cached.nodes;
    }

    const nodes = parse();
    this.entries.set(document.uri, { version: document.version, nodes });
    return nodes;
  }

  /** Forgets one document's AST. */
  delete(uri: string): void {
    this.entries.delete(uri);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Reports every element the template uses that the component does not import.
 * @param request The template, the component, and the index to analyze against.
 * @returns Diagnostics in document coordinates; empty when nothing is missing.
 */
export function analyzeTemplate(request: TemplateDiagnosticsRequest): MissingImportDiagnostic[] {
  const cancellation = request.cancellation ?? neverCancelled;
  if (cancellation.isCancelled) {
    return [];
  }

  const elements = scanParsedTemplate(request);
  if (elements.length === 0) {
    return [];
  }

  return findMissingImports(elements, request.severity, createMissingImportContext(request), cancellation);
}

/** What the analysis needs to know about one component and the index it belongs to. */
export interface MissingImportContextRequest {
  index: DiagnosticIndex;
  componentImports: ComponentImports;
  /** The component's source file, already holding the text to analyze against. */
  sourceFile: SourceFile;
  compiler: AngularCompilerApi;
}

/**
 * Wires the missing-import decision to one component and one project index.
 * @param request The component and index to answer from.
 */
export function createMissingImportContext(request: MissingImportContextRequest): MissingImportContext {
  const { componentImports, index, sourceFile, compiler } = request;

  return {
    findCandidates: (name) => getAngularElements(name, index),
    isImported: (candidate) => componentImports.isImported(sourceFile, candidate),
    getComponentImportNames: () => componentImports.getImportNames(sourceFile),
    getNamedImportSpecifiers: (importName) => componentImports.getNamedImportSpecifiers(sourceFile, importName),
    getExternalModuleExports: (moduleName) => index.getExternalModuleExports(moduleName),
    selectors: compiler.selectors,
  };
}

/**
 * Parses the template and walks it into import candidates.
 *
 * A template that cannot be parsed at all yields no candidates rather than failing the
 * request: the user is most likely mid-edit.
 * @internal
 */
function scanParsedTemplate(request: TemplateDiagnosticsRequest): ScannedTemplateElement[] {
  const logger = request.logger ?? silentLogger;
  const parse = () => parseTemplate(request, logger);

  try {
    return scanTemplate({
      nodes: request.cache ? request.cache.get(request.document, parse) : parse(),
      document: request.document,
      offset: request.template.offset,
      text: request.template.text,
      lookup: request.index,
      constructors: request.compiler.ast,
      onError: (message, error) => logger.error(`[TemplateDiagnostics] ${message}`, error),
    });
  } catch (error) {
    logger.error(`[TemplateDiagnostics] Failed to walk the template of ${request.document.uri}`, error as Error);
    return [];
  }
}

/** @internal */
function parseTemplate(request: TemplateDiagnosticsRequest, logger: CoreLogger): TemplateAstNode[] {
  try {
    const parsed = request.compiler.parseTemplate(request.template.text, request.document.uri);
    if (parsed.errors && parsed.errors.length > 0) {
      logger.debug(
        `[TemplateDiagnostics] ${request.document.uri} has template syntax errors; analyzing the partial AST`
      );
    }
    return parsed.nodes;
  } catch (error) {
    logger.error(`[TemplateDiagnostics] Unexpected error parsing ${request.document.uri}`, error as Error);
    return [];
  }
}
