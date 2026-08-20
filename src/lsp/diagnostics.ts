/**
 * Missing-import diagnostics in the language server.
 *
 * The client pulls diagnostics for a document; this module decides what that document
 * is — an external template, an inline one, or neither — brings the component's source
 * file up to the text the user is actually looking at, and runs the shared analysis.
 *
 * Results are also kept for the code actions that follow, because `quickfix-only` mode
 * shows the user nothing while still offering the fix. What is shown and what is
 * retained are therefore two different questions, answered separately.
 * @module
 */

import * as fs from "node:fs";
import type { Diagnostic, DocumentDiagnosticReport } from "vscode-languageserver/node";
import { DocumentDiagnosticReportKind } from "vscode-languageserver/node";
import { toLspDiagnostic } from "../adapters/lsp/language-types";
import type { AngularCompilerApi } from "../core/angular-compiler";
import { type CancellationSignal, neverCancelled } from "../core/cancellation";
import { ComponentImports } from "../core/component-imports";
import type { DocumentView } from "../core/document";
import { findInlineTemplate } from "../core/inline-template";
import type { CoreDiagnosticSeverity } from "../core/language-types";
import { type CoreLogger, silentLogger } from "../core/logging";
import type { MissingImportDiagnostic } from "../core/missing-imports";
import type { ExtensionConfig } from "../core/settings";
import { syncSourceFile } from "../core/source-file-sync";
import { analyzeTemplate, TemplateAstCache, type TemplateSource } from "../core/template-diagnostics";
import { isStandalone } from "../utils/angular";
import type { OpenDocuments } from "./open-documents";
import type { ProjectRouter, RoutedDocument } from "./project-router";

/** An empty report, which is also how a document's diagnostics are cleared. */
const NOTHING: DocumentDiagnosticReport = { kind: DocumentDiagnosticReportKind.Full, items: [] };

/**
 * What was found for one document, and what it was computed against.
 *
 * The document version and index generation are what make a result refutable: a code
 * action built on candidates from a document the user has since edited would edit the
 * wrong range.
 */
export interface DiagnosticResult {
  uri: string;
  version: number;
  generation: number;
  candidates: MissingImportDiagnostic[];
}

export interface DiagnosticsHandlerOptions {
  router: ProjectRouter;
  documents: OpenDocuments;
  /** The settings as they stand now; diagnostics mode and severity change at runtime. */
  config(): ExtensionConfig;
  /** Resolves once the Angular compiler is available; until then nothing is reported. */
  compiler(): AngularCompilerApi | undefined;
  /** Reads a component file that is not open; injected so tests need no disk. */
  readFile?(filePath: string): string;
  logger?: CoreLogger;
}

/** Answers `textDocument/diagnostic` and retains the candidates code actions need. */
export class DiagnosticsHandler {
  private readonly templates = new TemplateAstCache();
  private readonly results = new Map<string, DiagnosticResult>();
  private readonly componentImports: ComponentImports;
  private readonly logger: CoreLogger;
  private readonly readFile: (filePath: string) => string;

  constructor(private readonly options: DiagnosticsHandlerOptions) {
    this.logger = options.logger ?? silentLogger;
    this.readFile = options.readFile ?? ((filePath) => fs.readFileSync(filePath, "utf-8"));
    this.componentImports = new ComponentImports({
      resolveIndex: (filePath) => this.options.router.resolvePath(filePath)?.runtime.indexer,
      logger: this.logger,
    });
  }

  /**
   * Computes the diagnostics for one document.
   * @param document The document the client pulled diagnostics for.
   * @param cancellation Checked during and after the analysis.
   * @returns The report to answer with, which is empty in every mode but `full`.
   */
  provide(document: DocumentView, cancellation: CancellationSignal = neverCancelled): DocumentDiagnosticReport {
    const { diagnosticsMode } = this.options.config();
    if (diagnosticsMode === "disabled") {
      this.forget(document.uri);
      return NOTHING;
    }

    const result = this.analyze(document, cancellation);
    if (!result) {
      this.forget(document.uri);
      return NOTHING;
    }

    // A cancelled pass returns whatever it had reached, which describes only part of
    // the template. Keeping it would leave code actions offering a subset of the fixes.
    if (cancellation.isCancelled) {
      return NOTHING;
    }

    this.results.set(document.uri, result);
    if (diagnosticsMode !== "full") {
      // `quickfix-only`: the candidates stay available to code actions, but the user
      // sees no markers, so an empty report is the correct answer rather than a failure.
      return NOTHING;
    }

    return {
      kind: DocumentDiagnosticReportKind.Full,
      items: result.candidates.map(toLspDiagnostic) satisfies Diagnostic[],
    };
  }

  /**
   * The candidates last computed for a document, whatever the diagnostics mode was.
   * @param uri The document to look up.
   */
  resultFor(uri: string): DiagnosticResult | undefined {
    return this.results.get(uri);
  }

  /**
   * The candidates that describe the document as it is now.
   *
   * A retained result computed against an older document version or an older index
   * would place its fixes at the wrong ranges, so it is recomputed rather than reused.
   * Code actions go through here so they keep working in `quickfix-only` mode, where
   * the client has been shown nothing to act on.
   * @param document The document the actions were requested for.
   */
  candidatesFor(document: DocumentView): MissingImportDiagnostic[] {
    const retained = this.results.get(document.uri);
    const generation = this.options.router.resolve(document.uri)?.runtime.indexGeneration;
    if (retained && retained.version === document.version && retained.generation === generation) {
      return retained.candidates;
    }

    return this.analyze(document)?.candidates ?? [];
  }

  /**
   * Drops what is remembered about a component file, so the next pull re-reads it.
   * @param filePath Absolute path of the file that changed.
   */
  invalidate(filePath: string): void {
    this.componentImports.invalidate(filePath);
  }

  /** Drops every cached import answer, for an index change that could affect any of them. */
  invalidateAll(): void {
    this.componentImports.clear();
  }

  /** Forgets a document entirely, for one that was closed. */
  forget(uri: string): void {
    this.results.delete(uri);
    this.templates.delete(uri);
  }

  /**
   * Runs the analysis, or returns `undefined` when this document has nothing to analyze:
   * no project, no compiler yet, no component file, or a component that cannot hold
   * imports of its own.
   * @internal
   */
  private analyze(
    document: DocumentView,
    cancellation: CancellationSignal = neverCancelled
  ): DiagnosticResult | undefined {
    const compiler = this.options.compiler();
    const routed = this.options.router.resolve(document.uri);
    if (!compiler || !routed) {
      return undefined;
    }

    const componentText = this.readComponent(routed);
    if (componentText === undefined) {
      return undefined;
    }

    const { runtime } = routed;
    const sourceFile = syncSourceFile(runtime.indexer.project, routed.componentFilePath, componentText);
    const classDeclaration = sourceFile.getClasses()[0];
    if (classDeclaration && !isStandalone(classDeclaration)) {
      return undefined;
    }

    const template = this.templateOf(document, routed, sourceFile);
    if (!template) {
      return undefined;
    }

    // The component's own text just changed under the cache in the inline case, and in
    // the external case may have changed since the last pull; either way its answers
    // about what is imported are no longer trustworthy.
    this.componentImports.invalidate(routed.componentFilePath);

    return {
      uri: document.uri,
      version: document.version,
      generation: runtime.indexGeneration,
      candidates: analyzeTemplate({
        document,
        template,
        sourceFile,
        index: runtime.indexer,
        componentImports: this.componentImports,
        compiler,
        severity: severityOf(this.options.config()),
        cache: this.templates,
        cancellation,
        logger: this.logger,
      }),
    };
  }

  /**
   * The template to analyze: the document itself for an external one, the decorator's
   * `template` for an inline one, and nothing for a component that has neither.
   * @internal
   */
  private templateOf(
    document: DocumentView,
    routed: RoutedDocument,
    sourceFile: import("ts-morph").SourceFile
  ): TemplateSource | undefined {
    if (routed.externalTemplate) {
      return { text: document.getText(), offset: 0 };
    }
    return findInlineTemplate(sourceFile) ?? undefined;
  }

  /**
   * Reads the component file as the user currently sees it, or `undefined` when the
   * template has no component beside it at all.
   * @internal
   */
  private readComponent(routed: RoutedDocument): string | undefined {
    try {
      return this.options.documents.currentText(routed.componentFilePath, this.readFile).text;
    } catch {
      this.logger.debug(`[Diagnostics] No component file beside ${routed.filePath}`);
      return undefined;
    }
  }
}

/**
 * Maps the configured severity name onto the severity the analysis emits.
 * @internal
 */
function severityOf(config: ExtensionConfig): CoreDiagnosticSeverity {
  switch (config.diagnosticsSeverity.toLowerCase()) {
    case "error":
      return "error";
    case "info":
      return "information";
    case "hint":
      return "hint";
    default:
      return "warning";
  }
}
