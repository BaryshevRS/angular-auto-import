/**
 *
 * Angular Auto-Import Diagnostic Provider
 *
 * @module
 */

import type { SourceFile } from "ts-morph";
import * as vscode from "vscode";
import { toDocumentView } from "../adapters/vscode/document";
import { toVsCodeDiagnosticSeverity, toVsCodeRange } from "../adapters/vscode/language-types";
import { type AngularCompilerApi, loadAngularCompiler } from "../core/angular-compiler";
import { ComponentImports } from "../core/component-imports";
import { findInlineTemplate } from "../core/inline-template";
import type { CoreDiagnosticSeverity } from "../core/language-types";
import type { MissingImportDiagnostic } from "../core/missing-imports";
import { syncSourceFile } from "../core/source-file-sync";
import { analyzeTemplate, TemplateAstCache, type TemplateSource } from "../core/template-diagnostics";
import { logger } from "../logger";
import { getTsDocument, isStandalone, switchFileType } from "../utils";
import { debounce } from "../utils/debounce";
import { findDeepestContainingProjectContext, getProjectContextForDocument } from "../utils/project-context";
import type { ProviderContext } from "./index";

/**
 * Provides diagnostics for Angular templates.
 */
export class DiagnosticProvider {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private disposables: vscode.Disposable[] = [];
  private readonly candidateDiagnostics: Map<string, vscode.Diagnostic[]> = new Map();
  private readonly templateCache = new TemplateAstCache();
  private compiler: AngularCompilerApi | null = null;
  /**
   * Cache for storing whether a specific Angular element (component, directive, pipe) is imported in a given TypeScript component file.
   * Key: path to the TypeScript component file.
   * Value: Map where key is the Angular element name (e.g., 'MyComponent') and value is a boolean indicating if it's imported.
   */
  private readonly componentImports = new ComponentImports({
    resolveIndex: (filePath) => findDeepestContainingProjectContext(filePath, this.context.projectIndexers),
    logger,
  });
  private isPublishing = false;

  constructor(private readonly context: ProviderContext) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection("angular-auto-import");
    this.loadCompiler();
  }

  /**
   * Activates the diagnostic provider.
   */
  activate(): void {
    // Update diagnostics when HTML or TypeScript documents change
    const documentChangeHandler = vscode.workspace.onDidChangeTextDocument(
      debounce(async (event: vscode.TextDocumentChangeEvent) => {
        try {
          if (event.document.languageId === "html") {
            await this.updateDiagnostics(event.document);
          } else if (event.document.languageId === "typescript") {
            await this.updateDiagnostics(event.document);
            await this.updateRelatedHtmlDiagnostics(event.document);
          }
        } catch (error) {
          logger.error("[DiagnosticProvider] Error handling document change:", error as Error);
        }
      }, 300)
    );
    this.disposables.push(documentChangeHandler);

    // Update diagnostics when documents are saved
    const saveHandler = vscode.workspace.onDidSaveTextDocument(async (document) => {
      try {
        if (document.languageId === "html") {
          await this.updateDiagnostics(document);
        } else if (document.languageId === "typescript") {
          await this.updateDiagnostics(document);
          await this.updateRelatedHtmlDiagnostics(document);
        }
      } catch (error) {
        logger.error("[DiagnosticProvider] Error handling document save:", error as Error);
      }
    });
    this.disposables.push(saveHandler);

    // Update diagnostics when a document is opened
    const diagnosticOpenHandler = vscode.workspace.onDidOpenTextDocument(async (document) => {
      try {
        if (document.languageId === "html" || document.languageId === "typescript") {
          await this.updateDiagnostics(document);
        }
      } catch (error) {
        logger.error("[DiagnosticProvider] Error handling document open:", error as Error);
      }
    });
    this.disposables.push(diagnosticOpenHandler);

    // Listen for changes in any diagnostic collection to handle deduplication
    const onDidChangeDiagnosticsHandler = vscode.languages.onDidChangeDiagnostics((e) => {
      if (this.isPublishing) {
        return;
      }
      for (const uri of e.uris) {
        this.publishFilteredDiagnostics(uri);
      }
    });
    this.disposables.push(onDidChangeDiagnosticsHandler);

    // Initialize diagnostics for all open HTML documents
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId === "html" || document.languageId === "typescript") {
        this.updateDiagnostics(document);
      }
    }
  }

  /**
   * Deactivates the diagnostic provider.
   */
  deactivate(): void {
    this.disposables.forEach((disposable) => {
      disposable.dispose();
    });
    this.disposables = [];
    this.candidateDiagnostics.clear();
    this.templateCache.clear();
    this.diagnosticCollection.dispose();
  }

  /**
   * Updates diagnostics for related HTML files when a TypeScript file changes.
   */
  private async updateRelatedHtmlDiagnostics(tsDocument: vscode.TextDocument): Promise<void> {
    try {
      const projCtx = this.getProjectContextForDocument(tsDocument);
      if (!projCtx) {
        return;
      }

      // Synchronize ts-morph sourceFile with current VSCode document content
      const sourceFile = this.getSourceFile(tsDocument);
      if (!sourceFile) {
        return;
      }

      const isComponent = sourceFile.getClasses().some((c) => c.getDecorator("Component"));
      if (!isComponent) {
        return;
      }

      // Find the related HTML file
      const htmlFilePath = switchFileType(tsDocument.fileName, ".html");
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(htmlFilePath));
      } catch {
        return;
      }

      // Clear cache for the related TS file as its changes might affect diagnostics
      this.componentImports.invalidate(tsDocument.fileName);

      // Open the HTML document and update diagnostics
      const htmlUri = vscode.Uri.file(htmlFilePath);
      try {
        const htmlDocument = await vscode.workspace.openTextDocument(htmlUri);
        await this.updateDiagnostics(htmlDocument);
        // Updated diagnostics for related HTML file
      } catch (error) {
        logger.error(`Error opening HTML document ${htmlFilePath}:`, error as Error);
      }
    } catch (error) {
      logger.error("[DiagnosticProvider] Error updating related HTML diagnostics:", error as Error);
    }
  }

  /**
   * Gets diagnostics for a document from internal storage.
   * This works in all modes including 'quickfix-only'.
   * @param uri The document URI
   * @returns Array of diagnostics for the document
   */
  public getDiagnosticsForDocument(uri: vscode.Uri): vscode.Diagnostic[] {
    return this.candidateDiagnostics.get(uri.toString()) || [];
  }

  /**
   * Re-runs diagnostics for all open HTML/TypeScript documents.
   *
   * Intended to be called after the external library index changes (e.g. when a
   * dependency is installed or upgraded). The cached import-resolution results
   * are dropped first so the refreshed index is taken into account, clearing any
   * stale "missing import" diagnostics without requiring the user to edit files.
   */
  public async refreshOpenDocuments(): Promise<void> {
    this.componentImports.clear();
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId === "html" || document.languageId === "typescript") {
        await this.updateDiagnostics(document);
      }
    }
  }

  /**
   * Public method to force-update diagnostics for a file.
   */
  public async forceUpdateDiagnosticsForFile(filePath: string): Promise<void> {
    try {
      // First try to find the document in active documents
      const activeDocument = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.scheme === "file" && doc.fileName === filePath
      );

      if (activeDocument) {
        // Force refresh ts-morph project with current document content
        const projCtx = this.getProjectContextForDocument(activeDocument);
        if (projCtx) {
          const { project } = projCtx.indexer;
          const currentContent = activeDocument.getText();

          // Force update ts-morph SourceFile with current content
          const sourceFile = project.getSourceFile(filePath);
          if (sourceFile) {
            sourceFile.replaceWithText(currentContent);
          } else {
            project.createSourceFile(filePath, currentContent, {
              overwrite: true,
            });
          }
        }

        // Use the active document directly
        await this.updateDiagnostics(activeDocument);
        // Force updated diagnostics for active document
      } else {
        // Fallback to opening the document
        const uri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        await this.updateDiagnostics(document);
        // Force updated diagnostics for document
      }
    } catch (error) {
      logger.error(`Error force updating diagnostics for ${filePath}:`, error as Error);
    }
  }

  /**
   * Updates diagnostics for a document.
   */
  private async updateDiagnostics(document: vscode.TextDocument): Promise<void> {
    const startTime = process.hrtime.bigint();

    // Source Control diff editors expose the historical side as a virtual
    // document (for example, with the `git` scheme). Diagnostics for those
    // immutable snapshots cannot be fixed and are keyed separately by VS Code,
    // so keeping them produces stale markers after the real file or index
    // changes. All other providers in this extension are file-only as well.
    if (document.uri.scheme !== "file") {
      this.clearDiagnostics(document);
      return;
    }

    const diagnosticsMode = this.context.extensionConfig.diagnosticsMode;
    if (diagnosticsMode === "disabled") {
      this.clearDiagnostics(document);
      return;
    }

    if (document.languageId === "html") {
      await this.processHtmlDocument(document);
    } else if (document.languageId === "typescript") {
      await this.processTypescriptDocument(document);
    }

    this.logOperationDuration("updateDiagnostics", document.fileName, startTime);
  }

  /**
   * Clears diagnostics for a document.
   */
  private clearDiagnostics(document: vscode.TextDocument): void {
    this.diagnosticCollection.delete(document.uri);
    this.candidateDiagnostics.delete(document.uri.toString());
  }

  /**
   * Gets source file and logs if not found.
   */
  private getSourceFileWithLogging(document: vscode.TextDocument): SourceFile | undefined {
    const sourceFile = this.getSourceFile(document);
    if (!sourceFile) {
      logger.debug(`[DiagnosticProvider] Could not get source file for ${document.fileName}`);
    }
    return sourceFile;
  }

  /**
   * Processes HTML document diagnostics.
   */
  private async processHtmlDocument(document: vscode.TextDocument): Promise<void> {
    const componentPath = switchFileType(document.fileName, ".ts");
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(componentPath));
    } catch {
      logger.debug(
        `[DiagnosticProvider] Skipping diagnostics for HTML file without a corresponding TS component: ${document.fileName}`
      );
      return;
    }

    const tsDocument = await getTsDocument(document, componentPath);
    if (!tsDocument) {
      return;
    }

    const sourceFile = this.getSourceFileWithLogging(tsDocument);
    if (!sourceFile) {
      return;
    }

    if (!this.shouldProcessDocument(sourceFile, document)) {
      return;
    }

    await this.runDiagnostics({ text: document.getText(), offset: 0 }, document, sourceFile);
  }

  /**
   * Processes TypeScript document diagnostics.
   */
  private async processTypescriptDocument(document: vscode.TextDocument): Promise<void> {
    const sourceFile = this.getSourceFileWithLogging(document);
    if (!sourceFile) {
      return;
    }

    if (!this.shouldProcessDocument(sourceFile, document)) {
      return;
    }

    const inlineTemplate = findInlineTemplate(sourceFile);
    if (inlineTemplate) {
      this.componentImports.invalidate(document.fileName);
      await this.runDiagnostics(inlineTemplate, document, sourceFile);
    } else {
      this.clearDiagnosticsForNoTemplate(document);
    }
  }

  /**
   * Checks if document should be processed for diagnostics.
   */
  private shouldProcessDocument(sourceFile: SourceFile, document: vscode.TextDocument): boolean {
    const classDeclaration = sourceFile.getClasses()[0];
    if (classDeclaration && !isStandalone(classDeclaration)) {
      this.candidateDiagnostics.delete(document.uri.toString());
      this.diagnosticCollection.delete(document.uri);
      return false;
    }
    return true;
  }

  /**
   * Clears diagnostics when no template is found.
   */
  private clearDiagnosticsForNoTemplate(document: vscode.TextDocument): void {
    this.candidateDiagnostics.delete(document.uri.toString());
    this.diagnosticCollection.delete(document.uri);
    this.componentImports.invalidate(document.fileName);
    logger.debug(
      `[DiagnosticProvider] No inline template found for TS file, clearing diagnostics: ${document.fileName}`
    );
  }

  /**
   * Logs the duration of an operation.
   */
  private logOperationDuration(operation: string, identifier: string, startTime: bigint): void {
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1_000_000;
    logger.debug(`[DiagnosticProvider] ${operation} for ${identifier} took ${duration.toFixed(2)} ms`);
  }

  /**
   * Runs the shared missing-import analysis and publishes what it found.
   * @param template The template text and where it starts in the document.
   * @param document The document being diagnosed.
   * @param sourceFile The component's source file, already holding the current text.
   */
  private async runDiagnostics(
    template: TemplateSource,
    document: vscode.TextDocument,
    sourceFile: SourceFile
  ): Promise<void> {
    const projCtx = this.getProjectContextForDocument(document);
    if (!projCtx) {
      logger.debug(`[DiagnosticProvider] No project context for document: ${document.fileName}`);
      return;
    }

    if (!this.compiler) {
      logger.warn("[DiagnosticProvider] @angular/compiler not loaded yet, skipping diagnostics.");
      return;
    }

    const startTime = process.hrtime.bigint();
    const missingImports = analyzeTemplate({
      document: toDocumentView(document),
      template,
      sourceFile,
      index: projCtx.indexer,
      componentImports: this.componentImports,
      compiler: this.compiler,
      severity: this.getSeverityFromConfig(this.context.extensionConfig.diagnosticsSeverity),
      cache: this.templateCache,
      logger,
    });
    this.logOperationDuration("analyzeTemplate", document.fileName, startTime);

    this.candidateDiagnostics.set(document.uri.toString(), missingImports.map(toVsCodeDiagnostic));
    this.publishFilteredDiagnostics(document.uri);
  }

  private getSourceFile(document: vscode.TextDocument): SourceFile | undefined {
    const projCtx = this.getProjectContextForDocument(document);
    if (!projCtx) {
      return undefined;
    }

    // Use the exact document being diagnosed. SCM diff editors can expose a
    // virtual document with the same fileName as the working-tree document;
    // looking up by fileName alone may otherwise substitute the historical
    // snapshot and poison the shared ts-morph SourceFile.
    return syncSourceFile(projCtx.indexer.project, document.fileName, document.getText());
  }

  private getProjectContextForDocument(document: vscode.TextDocument) {
    return getProjectContextForDocument(document, this.context.projectIndexers, this.context.projectTsConfigs);
  }

  private getSeverityFromConfig(severityLevel: string): CoreDiagnosticSeverity {
    switch (severityLevel.toLowerCase()) {
      case "error":
        return "error";
      case "warning":
        return "warning";
      case "info":
        return "information";
      default:
        return "warning";
    }
  }

  private publishFilteredDiagnostics(uri: vscode.Uri): void {
    if (uri.scheme !== "file") {
      this.candidateDiagnostics.delete(uri.toString());
      this.diagnosticCollection.delete(uri);
      return;
    }

    const rawCandidateDiags = this.candidateDiagnostics.get(uri.toString()) || [];

    const candidateDiags: vscode.Diagnostic[] = [];
    for (const diag of rawCandidateDiags) {
      const alreadyExists = candidateDiags.some((d) => d.message === diag.message && d.range.isEqual(diag.range));
      if (!alreadyExists) {
        candidateDiags.push(diag);
      }
    }

    // Only publish to collection in 'full' mode
    // In 'quickfix-only' mode, diagnostics are stored internally but not shown
    const diagnosticsMode = this.context.extensionConfig.diagnosticsMode;
    this.isPublishing = true;
    try {
      if (diagnosticsMode === "full") {
        this.diagnosticCollection.set(uri, candidateDiags);
      } else if (diagnosticsMode === "quickfix-only") {
        // Clear visible diagnostics but keep internal storage
        this.diagnosticCollection.set(uri, []);
      }
    } finally {
      this.isPublishing = false;
    }
  }

  private loadCompiler(): void {
    void loadAngularCompiler(logger)
      .then((compiler) => {
        this.compiler = compiler;
        logger.info("[DiagnosticProvider] Retrying open documents now that the compiler is available");
        for (const document of vscode.workspace.textDocuments) {
          if (document.languageId === "html" || document.languageId === "typescript") {
            void this.updateDiagnostics(document);
          }
        }
      })
      .catch(() => {
        // Already reported by the loader; diagnostics stay off until a later load succeeds.
      });
  }
}

/**
 * Maps a core diagnostic onto the VS Code diagnostic the editor publishes.
 */
function toVsCodeDiagnostic(diagnostic: MissingImportDiagnostic): vscode.Diagnostic {
  const published = new vscode.Diagnostic(
    toVsCodeRange(diagnostic.range),
    diagnostic.message,
    toVsCodeDiagnosticSeverity(diagnostic.severity)
  );

  published.code = diagnostic.code;
  published.source = diagnostic.source;
  return published;
}
