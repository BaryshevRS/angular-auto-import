/**
 *
 * Angular Auto-Import Diagnostic Provider
 *
 * @module
 */

import {
  type ArrayLiteralExpression,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type Node,
  type NoSubstitutionTemplateLiteral,
  type ObjectLiteralExpression,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from "ts-morph";
import * as vscode from "vscode";
import { getStandardModuleExports } from "../config/standard-modules";
import { knownTags } from "../consts";
import { logger } from "../logger";
import type { AngularIndexer } from "../services";
import type {
  AngularElementData,
  ControlFlowNode,
  ParsedHtmlElement,
  TemplateAstNode,
  TmplAstBoundAttribute,
  TmplAstBoundEvent,
  TmplAstBoundText,
  TmplAstElement,
  TmplAstReference,
  TmplAstTemplate,
} from "../types";
import { getAngularElements, getTsDocument, isStandalone, switchFileType } from "../utils";
import { debounce } from "../utils/debounce";
import { findDeepestContainingProjectContext, getProjectContextForDocument } from "../utils/project-context";
import type { ProviderContext } from "./index";

/**
 * Context for template document parsing
 */
interface TemplateDocumentContext {
  /** VS Code document being parsed */
  document: vscode.TextDocument;
  /** Offset in the document */
  offset: number;
  /** Text content */
  text: string;
}

/**
 * Angular AST node constructors
 */
interface AstConstructors {
  /** Element node constructor */
  tmplAstElement: new (
    ...args: unknown[]
  ) => TmplAstElement;
  /** Template node constructor */
  tmplAstTemplate: new (
    ...args: unknown[]
  ) => TmplAstTemplate;
  /** Bound event node constructor */
  tmplAstBoundEvent: new (
    ...args: unknown[]
  ) => TmplAstBoundEvent;
  /** Reference node constructor */
  tmplAstReference: new (
    ...args: unknown[]
  ) => TmplAstReference;
  /** Bound attribute node constructor */
  tmplAstBoundAttribute: new (
    ...args: unknown[]
  ) => TmplAstBoundAttribute;
  /** Bound text node constructor */
  tmplAstBoundText: new (
    ...args: unknown[]
  ) => TmplAstBoundText;
}

/**
 * Processing context for template parsing
 */
interface ProcessingContext {
  /** Array to collect parsed elements */
  elements: ParsedHtmlElement[];
  /** Angular indexer instance */
  indexer: AngularIndexer;
  /** Visit callback for traversing AST */
  visit: (nodesList: TemplateAstNode[]) => void;
  /** Extract pipes from expression callback */
  extractPipesFromExpression: (expression: unknown, nodeOffset?: number) => void;
}

/**
 * Provides diagnostics for Angular templates.
 */
export class DiagnosticProvider {
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private disposables: vscode.Disposable[] = [];
  private readonly candidateDiagnostics: Map<string, vscode.Diagnostic[]> = new Map();
  private readonly templateCache = new Map<string, { version: number; nodes: unknown[] }>();
  // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
  private compiler: any | null = null;
  /**
   * Cache for storing whether a specific Angular element (component, directive, pipe) is imported in a given TypeScript component file.
   * Key: path to the TypeScript component file.
   * Value: Map where key is the Angular element name (e.g., 'MyComponent') and value is a boolean indicating if it's imported.
   */
  private readonly importedElementsCache = new Map<string, Map<string, boolean>>();
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
      this.importedElementsCache.delete(tsDocument.fileName);

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
    this.importedElementsCache.clear();
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

    await this.runDiagnostics(document.getText(), document, 0, sourceFile);
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

    const componentInfo = this.extractInlineTemplate(document, sourceFile);
    if (componentInfo) {
      this.importedElementsCache.delete(document.fileName);
      await this.runDiagnostics(componentInfo.template, document, componentInfo.templateOffset, sourceFile);
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
    this.importedElementsCache.delete(document.fileName);
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

  private async runDiagnostics(
    templateText: string,
    document: vscode.TextDocument,
    offset: number,
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

    const { CssSelector, SelectorMatcher } = this.compiler;

    const { indexer } = projCtx;
    const diagnostics: vscode.Diagnostic[] = [];
    const severity = this.getSeverityFromConfig(this.context.extensionConfig.diagnosticsSeverity);

    // Parse the template to get all elements and their full context
    const parsedElements = this.parseCompleteTemplate(templateText, document, offset, indexer);

    for (const element of parsedElements) {
      const elementDiagnostics = await this.checkElement(
        element,
        indexer,
        severity,
        sourceFile,
        CssSelector,
        SelectorMatcher
      );
      if (elementDiagnostics.length > 0) {
        diagnostics.push(...elementDiagnostics);
      }
    }

    this.candidateDiagnostics.set(document.uri.toString(), diagnostics);
    this.publishFilteredDiagnostics(document.uri);
  }

  private parseCompleteTemplate(
    text: string,
    document: vscode.TextDocument,
    offset: number,
    indexer: AngularIndexer
  ): ParsedHtmlFullElement[] {
    const parseTemplateStartTime = process.hrtime.bigint();
    const elements: ParsedHtmlFullElement[] = [];
    try {
      if (!this.compiler) {
        logger.warn("[DiagnosticProvider] @angular/compiler not loaded yet, skipping template parsing.");
        return elements;
      }
      const {
        parseTemplate,
        TmplAstBoundAttribute,
        TmplAstBoundEvent,
        TmplAstElement,
        TmplAstReference,
        TmplAstTemplate,
        TmplAstBoundText,
      } = this.compiler;
      type ParseResult = ReturnType<typeof parseTemplate>;
      type TemplateNode = ParseResult["nodes"][0];

      const currentVersion = document.version;
      const cacheKey = document.uri.toString();
      const cached = this.templateCache.get(cacheKey);
      let nodes: TemplateNode[];

      if (cached && cached.version === currentVersion) {
        logger.debug(`[DiagnosticProvider] Template cache HIT for ${document.fileName}`);
        nodes = cached.nodes as TemplateNode[];
      } else {
        logger.debug(`[DiagnosticProvider] Template cache MISS for ${document.fileName}`);
        try {
          // Use alwaysAttemptHtmlToR3AstConversion to parse templates with syntax errors
          // This option ensures we get partial AST even if template HTML is invalid
          const parsed = parseTemplate(text, document.uri.fsPath, {
            alwaysAttemptHtmlToR3AstConversion: true,
            collectCommentNodes: true,
          });

          nodes = parsed.nodes;

          // Log parse errors if they exist, but continue with partial AST
          if (parsed.errors && parsed.errors.length > 0) {
            logger.debug(
              `[DiagnosticProvider] Template has parse errors for ${document.fileName}, but continuing with partial AST:`,
              parsed.errors
            );
          }
        } catch (parseError) {
          // Fallback for unexpected parsing exceptions
          logger.error(
            `[DiagnosticProvider] Unexpected error parsing template ${document.fileName}:`,
            parseError as Error
          );
          nodes = [];
        }

        this.templateCache.set(cacheKey, { version: currentVersion, nodes });
      }

      const extractPipesFromExpression = (expression: unknown, nodeOffset: number = 0) => {
        if (!expression || typeof expression !== "object" || !("sourceSpan" in expression) || !expression.sourceSpan) {
          return;
        }

        try {
          const expr = expression as { sourceSpan: { start: number; end: number } };
          const expressionText = text.slice(expr.sourceSpan.start, expr.sourceSpan.end);
          const pipes = this._findPipesInExpression(
            expressionText,
            document,
            offset + nodeOffset,
            expr.sourceSpan.start
          );
          for (const pipe of pipes) {
            elements.push({ ...pipe, isAttribute: false, attributes: [] });
          }
        } catch (e) {
          logger.error("[DiagnosticProvider] Error extracting pipes from expression:", e as Error);
        }
      };

      const visit = (nodesList: TemplateNode[]) => {
        for (const node of nodesList) {
          this.processTemplateNode(
            node,
            { elements, indexer, visit, extractPipesFromExpression },
            { document, offset, text },
            {
              tmplAstElement: TmplAstElement,
              tmplAstTemplate: TmplAstTemplate,
              tmplAstBoundEvent: TmplAstBoundEvent,
              tmplAstReference: TmplAstReference,
              tmplAstBoundAttribute: TmplAstBoundAttribute,
              tmplAstBoundText: TmplAstBoundText,
            }
          );
        }
      };

      visit(nodes);
      // Log duration for parsing template
      const parseTemplateEndTime = process.hrtime.bigint();
      const parseTemplateDuration = Number(parseTemplateEndTime - parseTemplateStartTime) / 1_000_000;
      logger.debug(
        `[DiagnosticProvider] parseCompleteTemplate for ${document.fileName} took ${parseTemplateDuration.toFixed(2)} ms`
      );
    } catch (e) {
      logger.error(`[DiagnosticProvider] Failed to parse template: ${document.uri.fsPath}`, e as Error);
    }
    return elements;
  }

  private async checkElement(
    element: ParsedHtmlFullElement,
    indexer: AngularIndexer,
    severity: vscode.DiagnosticSeverity,
    sourceFile: SourceFile,
    // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
    CssSelector: any,
    // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
    SelectorMatcher: any
  ): Promise<vscode.Diagnostic[]> {
    const checkElementStartTime = process.hrtime.bigint();
    const diagnostics: vscode.Diagnostic[] = [];
    const processedCandidatesThisCall = new Set<string>();

    const candidates = getAngularElements(element.name, indexer);
    if (
      element.type === "pipe" &&
      this.hasPipeSelectorMatchingImportedModule(element.name, candidates, indexer, sourceFile)
    ) {
      this.logOperationDuration("checkElement", element.name, checkElementStartTime);
      return diagnostics;
    }

    for (const candidate of candidates) {
      if (!this.shouldProcessCandidate(candidate, processedCandidatesThisCall)) {
        continue;
      }

      const diagnostic = await this.processCandidateElement(
        element,
        candidate,
        severity,
        sourceFile,
        processedCandidatesThisCall,
        CssSelector,
        SelectorMatcher
      );

      if (
        diagnostic &&
        candidate.type !== "pipe" &&
        !this.candidateNameMatchesSelector(element.name, candidate.name) &&
        this.hasImportedAlternativeMatch(element, candidate, indexer, sourceFile, CssSelector, SelectorMatcher)
      ) {
        continue;
      }

      if (
        diagnostic &&
        candidate.type === "pipe" &&
        this.hasImportedPipeAlternativeMatch(element, candidate, indexer, sourceFile)
      ) {
        continue;
      }

      if (diagnostic) {
        diagnostics.push(diagnostic);
      }
    }

    this.logOperationDuration("checkElement", element.name, checkElementStartTime);
    return diagnostics;
  }

  /**
   * Checks if a candidate should be processed.
   */
  private shouldProcessCandidate(
    candidate: AngularElementData | null,
    processedCandidates: Set<string>
  ): candidate is AngularElementData {
    return Boolean(candidate && !processedCandidates.has(candidate.name));
  }

  /**
   * Processes a single candidate element.
   */
  private async processCandidateElement(
    element: ParsedHtmlFullElement,
    candidate: AngularElementData,
    severity: vscode.DiagnosticSeverity,
    sourceFile: SourceFile,
    processedCandidates: Set<string>,
    // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
    CssSelector: any,
    // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
    SelectorMatcher: any
  ): Promise<vscode.Diagnostic | null> {
    if (candidate.type === "pipe") {
      // Only process pipe candidates if the element is actually a pipe usage (not a property binding)
      // This prevents false positives when an @Input() and a @Pipe() share the same name
      if (element.type === "pipe") {
        return this.processPipeCandidate(element, candidate, severity, sourceFile, processedCandidates);
      }
      // Skip pipe candidates for non-pipe elements (like property bindings)
      return null;
    }

    return this.processNonPipeCandidate(
      element,
      candidate,
      severity,
      sourceFile,
      processedCandidates,
      CssSelector,
      SelectorMatcher
    );
  }

  /**
   * Processes a pipe candidate.
   */
  private processPipeCandidate(
    element: ParsedHtmlFullElement,
    candidate: AngularElementData,
    severity: vscode.DiagnosticSeverity,
    sourceFile: SourceFile,
    processedCandidates: Set<string>
  ): vscode.Diagnostic | null {
    processedCandidates.add(candidate.name);
    if (!this.isElementImported(sourceFile, candidate)) {
      return this.createMissingImportDiagnostic(element, candidate, element.name, severity);
    }
    return null;
  }

  /**
   * Processes a non-pipe candidate (component/directive).
   */
  private processNonPipeCandidate(
    element: ParsedHtmlFullElement,
    candidate: AngularElementData,
    severity: vscode.DiagnosticSeverity,
    sourceFile: SourceFile,
    processedCandidates: Set<string>,
    // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
    CssSelector: any,
    // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
    SelectorMatcher: any
  ): vscode.Diagnostic | null {
    const matchedSelectors = this.getMatchedSelectors(element, candidate, CssSelector, SelectorMatcher);

    if (matchedSelectors.length === 0) {
      return null;
    }

    // The last matched selector is considered the most specific one by Angular's engine.
    const specificSelector = matchedSelectors[matchedSelectors.length - 1];
    processedCandidates.add(candidate.name);

    if (!this.isElementImported(sourceFile, candidate)) {
      return this.createMissingImportDiagnostic(element, candidate, specificSelector, severity);
    }
    return null;
  }

  /**
   * Suppresses false positives when one template token matches multiple Angular elements
   * but at least one of those matches is already imported.
   */
  private hasImportedAlternativeMatch(
    element: ParsedHtmlFullElement,
    candidate: AngularElementData,
    indexer: AngularIndexer,
    sourceFile: SourceFile,
    // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
    CssSelector: any,
    // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
    SelectorMatcher: any
  ): boolean {
    const alternatives = getAngularElements(element.name, indexer);

    for (const alternative of alternatives) {
      if (alternative.type === "pipe" || (alternative.name === candidate.name && alternative.path === candidate.path)) {
        continue;
      }

      if (!this.candidateNameMatchesSelector(element.name, alternative.name)) {
        continue;
      }

      const matchedSelectors = this.getMatchedSelectors(element, alternative, CssSelector, SelectorMatcher);
      if (matchedSelectors.length === 0) {
        continue;
      }

      if (this.isElementImported(sourceFile, alternative)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Suppresses pipe diagnostics when another pipe with the same selector is already available.
   */
  private hasImportedPipeAlternativeMatch(
    element: ParsedHtmlFullElement,
    candidate: AngularElementData,
    indexer: AngularIndexer,
    sourceFile: SourceFile
  ): boolean {
    if (element.type !== "pipe") {
      return false;
    }

    const alternatives = getAngularElements(element.name, indexer);
    for (const alternative of alternatives) {
      if (alternative.type !== "pipe") {
        continue;
      }

      if (alternative.name === candidate.name && alternative.path === candidate.path) {
        continue;
      }

      if (this.isElementImported(sourceFile, alternative)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Fallback for external libraries whose NgModule exports were not indexed.
   * Angular makes NgModule exports available through standalone component imports,
   * so a `TranslateModule` imported from the same package as a `translate` pipe is
   * treated as sufficient only when no explicit export data exists to verify it.
   */
  private hasPipeSelectorMatchingImportedModule(
    pipeName: string,
    candidates: AngularElementData[],
    indexer: AngularIndexer,
    sourceFile: SourceFile
  ): boolean {
    const normalizedPipeName = this.normalizeSelectorForNameMatch(pipeName);
    if (!normalizedPipeName) {
      return false;
    }

    for (const importName of this.getComponentImportNames(sourceFile)) {
      if (!importName.endsWith("Module") || this.normalizeCandidateName(importName) !== normalizedPipeName) {
        continue;
      }

      if (getStandardModuleExports(importName) ?? indexer.getExternalModuleExports(importName)) {
        continue;
      }

      const moduleSpecifiers = this.getNamedImportModuleSpecifiers(sourceFile, importName);
      if (moduleSpecifiers.length === 0) {
        continue;
      }

      if (candidates.some((candidate) => candidate.type === "pipe" && moduleSpecifiers.includes(candidate.path))) {
        return true;
      }
    }

    return false;
  }

  private getNamedImportModuleSpecifiers(sourceFile: SourceFile, importName: string): string[] {
    const moduleSpecifiers: string[] = [];

    for (const declaration of sourceFile.getImportDeclarations()) {
      if (!declaration.getNamedImports().some((namedImport) => namedImport.getName() === importName)) {
        continue;
      }

      moduleSpecifiers.push(declaration.getModuleSpecifierValue());
    }

    return moduleSpecifiers;
  }

  private getComponentImportNames(sourceFile: SourceFile): string[] {
    const importNames = new Set<string>();

    for (const classDeclaration of sourceFile.getClasses()) {
      const importsArray = this.getComponentImportsArray(classDeclaration);
      if (!importsArray) {
        continue;
      }

      for (const element of importsArray.getElements()) {
        if (element.isKind(SyntaxKind.Identifier)) {
          importNames.add(element.getText().trim());
        }
      }
    }

    return [...importNames];
  }

  private candidateNameMatchesSelector(selectorName: string, candidateName: string): boolean {
    const normalizedSelector = this.normalizeSelectorForNameMatch(selectorName);
    const normalizedCandidate = this.normalizeCandidateName(candidateName);

    if (!normalizedSelector || !normalizedCandidate) {
      return false;
    }

    return normalizedCandidate.startsWith(normalizedSelector);
  }

  private normalizeSelectorForNameMatch(selectorName: string): string {
    return selectorName.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
  }

  private normalizeCandidateName(candidateName: string): string {
    return candidateName
      .replace(/(Component|Directive|Pipe|Module)$/u, "")
      .replace(/[^a-zA-Z0-9]+/g, "")
      .toLowerCase();
  }

  /**
   * Gets matched selectors for an element and candidate.
   */
  private getMatchedSelectors(
    element: ParsedHtmlFullElement,
    candidate: AngularElementData,
    // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
    CssSelector: any,
    // biome-ignore lint/suspicious/noExplicitAny: The Angular compiler is dynamically imported and has a complex, undocumented type surface.
    SelectorMatcher: any
  ): string[] {
    const matcher = new SelectorMatcher();
    const individualSelectors = CssSelector.parse(candidate.originalSelector);
    matcher.addSelectables(individualSelectors);

    const templateCssSelector = new CssSelector();
    templateCssSelector.setElement(element.tagName);
    for (const attr of element.attributes) {
      templateCssSelector.addAttribute(attr.name, attr.value ?? "");
    }

    const matchedSelectors: string[] = [];
    matcher.match(templateCssSelector, (selector: string) => {
      matchedSelectors.push(selector.toString());
    });

    return matchedSelectors;
  }

  private createMissingImportDiagnostic(
    element: ParsedHtmlFullElement,
    candidate: AngularElementData,
    specificSelector: string,
    severity: vscode.DiagnosticSeverity
  ): vscode.Diagnostic {
    const message = `'${element.name}' is part of a known ${candidate.type}, but it is not imported.`;
    const diagnostic = new vscode.Diagnostic(element.range, message, severity);

    diagnostic.code = `missing-${candidate.type}-import:${specificSelector}`;
    diagnostic.source = "angular-auto-import";
    return diagnostic;
  }

  private getSourceFile(document: vscode.TextDocument): SourceFile | undefined {
    const projCtx = this.getProjectContextForDocument(document);
    if (!projCtx) {
      return undefined;
    }

    const { project } = projCtx.indexer;

    // Use the exact document being diagnosed. SCM diff editors can expose a
    // virtual document with the same fileName as the working-tree document;
    // looking up by fileName alone may otherwise substitute the historical
    // snapshot and poison the shared ts-morph SourceFile.
    const currentContent = document.getText();

    let sourceFile = project.getSourceFile(document.fileName);

    if (sourceFile) {
      if (sourceFile.getFullText() !== currentContent) {
        sourceFile.replaceWithText(currentContent);
      }
    } else {
      sourceFile = project.createSourceFile(document.fileName, currentContent, {
        overwrite: true,
      });
    }

    return sourceFile;
  }

  private extractInlineTemplate(
    _document: vscode.TextDocument,
    sourceFile: SourceFile
  ): { template: string; templateOffset: number } | null {
    for (const classDeclaration of sourceFile.getClasses()) {
      const result = this.extractTemplateFromClass(classDeclaration);
      if (result) {
        return result;
      }
    }
    return null;
  }

  /**
   * Extracts template from a class declaration.
   */
  private extractTemplateFromClass(
    classDeclaration: ClassDeclaration
  ): { template: string; templateOffset: number } | null {
    const componentDecorator = classDeclaration.getDecorator("Component");
    if (!componentDecorator) {
      return null;
    }

    const objectLiteral = this.getComponentDecoratorObjectLiteral(componentDecorator);
    if (!objectLiteral) {
      return null;
    }

    return this.extractTemplateFromObjectLiteral(objectLiteral);
  }

  /**
   * Gets the object literal from a Component decorator.
   */
  private getComponentDecoratorObjectLiteral(componentDecorator: Decorator): ObjectLiteralExpression | null {
    const decoratorArgs = componentDecorator.getArguments();
    if (decoratorArgs.length === 0) {
      return null;
    }

    const firstArg = decoratorArgs[0];
    if (!firstArg.isKind(SyntaxKind.ObjectLiteralExpression)) {
      return null;
    }

    return firstArg as ObjectLiteralExpression;
  }

  /**
   * Extracts template from an object literal expression.
   */
  private extractTemplateFromObjectLiteral(
    objectLiteral: ObjectLiteralExpression
  ): { template: string; templateOffset: number } | null {
    const templateProperty = objectLiteral.getProperty("template");
    if (!templateProperty?.isKind(SyntaxKind.PropertyAssignment)) {
      return null;
    }

    const initializer = templateProperty.getInitializer();
    if (!this.isValidTemplateInitializer(initializer)) {
      return null;
    }

    const templateString = initializer.getLiteralText();
    const templateOffset = initializer.getStart() + 1;
    return { template: templateString, templateOffset };
  }

  /**
   * Checks if an initializer is a valid template initializer.
   */
  private isValidTemplateInitializer(
    initializer: Node | undefined
  ): initializer is StringLiteral | NoSubstitutionTemplateLiteral {
    return Boolean(
      initializer &&
        (initializer.isKind(SyntaxKind.StringLiteral) || initializer.isKind(SyntaxKind.NoSubstitutionTemplateLiteral))
    );
  }

  private _findPipesInExpression(
    expressionText: string,
    document: vscode.TextDocument,
    baseOffset: number,
    valueOffset: number
  ): ParsedHtmlElement[] {
    const pipeElements: ParsedHtmlElement[] = [];
    const pipeRegex = /\|\s*([a-zA-Z][a-zA-Z0-9_-]*)/g;
    let match: RegExpExecArray | null;

    while ((match = pipeRegex.exec(expressionText))) {
      const pipeName = match[1];
      const pipeOffsetInExpression = match.index + match[0].indexOf(pipeName);
      const start = document.positionAt(baseOffset + valueOffset + pipeOffsetInExpression);
      const end = document.positionAt(baseOffset + valueOffset + pipeOffsetInExpression + pipeName.length);
      pipeElements.push({ type: "pipe", name: pipeName, range: new vscode.Range(start, end), tagName: "pipe" });
    }
    return pipeElements;
  }

  private getProjectContextForDocument(document: vscode.TextDocument) {
    return getProjectContextForDocument(document, this.context.projectIndexers, this.context.projectTsConfigs);
  }

  private isElementImported(sourceFile: SourceFile, element: AngularElementData): boolean {
    try {
      if (!sourceFile) {
        return false;
      }

      const cacheKey = sourceFile.getFilePath();
      const cached = this.getImportFromCache(cacheKey, element.name);
      if (cached !== undefined) {
        return cached;
      }

      let isImported = this.checkDirectElementImport(sourceFile, element);
      if (!isImported) {
        isImported = this.checkExternalModuleImports(sourceFile, element);
      }

      this.updateImportCache(cacheKey, element.name, isImported);
      return isImported;
    } catch (error) {
      logger.error("[DiagnosticProvider] Error checking element import with ts-morph:", error as Error);
      return false;
    }
  }

  /**
   * Gets import status from cache.
   */
  private getImportFromCache(cacheKey: string, elementName: string): boolean | undefined {
    const fileCache = this.importedElementsCache.get(cacheKey);
    return fileCache?.get(elementName);
  }

  /**
   * Updates import cache with result.
   */
  private updateImportCache(cacheKey: string, elementName: string, isImported: boolean): void {
    let fileCache = this.importedElementsCache.get(cacheKey);
    if (!fileCache) {
      fileCache = new Map();
      this.importedElementsCache.set(cacheKey, fileCache);
    }
    fileCache.set(elementName, isImported);
  }

  /**
   * Gets the imports array from a Component decorator.
   */
  private getComponentImportsArray(classDeclaration: ClassDeclaration): ArrayLiteralExpression | undefined {
    const componentDecorator = classDeclaration.getDecorator("Component");
    if (!componentDecorator) {
      return undefined;
    }

    const decoratorArgs = componentDecorator.getArguments();
    if (decoratorArgs.length === 0 || !decoratorArgs[0].isKind(SyntaxKind.ObjectLiteralExpression)) {
      return undefined;
    }

    const objectLiteral = decoratorArgs[0] as ObjectLiteralExpression;
    const importsProperty = objectLiteral.getProperty("imports");

    if (!importsProperty?.isKind(SyntaxKind.PropertyAssignment)) {
      return undefined;
    }

    const initializer = importsProperty.getInitializer();
    return initializer?.isKind(SyntaxKind.ArrayLiteralExpression) ? (initializer as ArrayLiteralExpression) : undefined;
  }

  /**
   * Checks if element is directly imported in the Component imports array.
   */
  private checkDirectElementImport(sourceFile: SourceFile, element: AngularElementData): boolean {
    for (const classDeclaration of sourceFile.getClasses()) {
      const importsArray = this.getComponentImportsArray(classDeclaration);
      if (!importsArray) {
        continue;
      }

      for (const importName of this.getImportNamesForElement(element)) {
        const isInImportsArray = importsArray
          .getElements()
          .some((el: Expression) => el.getText().trim() === importName);

        if (isInImportsArray) {
          const hasTopLevelImport = sourceFile.getImportDeclarations().some((imp) => {
            return imp.getNamedImports().some((named) => named.getName() === importName);
          });
          if (hasTopLevelImport) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private getImportNamesForElement(element: AngularElementData): string[] {
    const names = [element.name];
    if (element.exportingModuleName && element.exportingModuleName !== element.name) {
      names.push(element.exportingModuleName);
    }
    return names;
  }

  /**
   * Checks if element is imported via external modules.
   */
  private checkExternalModuleImports(sourceFile: SourceFile, element: AngularElementData): boolean {
    const indexer = this.getIndexerForSourceFile(sourceFile);
    if (!indexer) {
      return false;
    }

    for (const classDeclaration of sourceFile.getClasses()) {
      if (this.checkClassImportsForElement(classDeclaration, element, indexer)) {
        return true;
      }
    }
    logger.debug(`[DiagnosticProvider] Element '${element.name}' not found in any imported modules`);
    return false;
  }

  /**
   * Gets the indexer for a source file's workspace.
   */
  private getIndexerForSourceFile(sourceFile: SourceFile) {
    return findDeepestContainingProjectContext(sourceFile.getFilePath(), this.context.projectIndexers);
  }

  /**
   * Checks if a class declaration imports an element via its module imports.
   */
  private checkClassImportsForElement(
    classDeclaration: ClassDeclaration,
    element: AngularElementData,
    indexer: AngularIndexer
  ): boolean {
    const importsArray = this.getComponentImportsArray(classDeclaration);
    if (!importsArray) {
      return false;
    }

    const importedModules = importsArray.getElements().map((el: Expression) => el.getText().trim());
    logger.debug(
      `[DiagnosticProvider] Checking element '${element.name}' against ${importedModules.length} imported modules: [${importedModules.join(", ")}]`
    );

    for (const moduleName of importedModules) {
      if (this.checkModuleExportsForElement(moduleName, element, indexer)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks if a module exports a specific element.
   */
  private checkModuleExportsForElement(
    moduleName: string,
    element: AngularElementData,
    indexer: AngularIndexer
  ): boolean {
    // First check if it's a standard Angular module (CommonModule, FormsModule, etc.)
    const standardModuleExports = getStandardModuleExports(moduleName);
    if (standardModuleExports?.has(element.name)) {
      logger.debug(`[DiagnosticProvider] Element '${element.name}' found in standard Angular module '${moduleName}'`);
      return true;
    }

    // Then check indexer for custom modules
    const moduleExports = indexer.getExternalModuleExports(moduleName);
    if (moduleExports) {
      logger.debug(
        `[DiagnosticProvider] Module '${moduleName}' exports ${moduleExports.size} items: [${Array.from(moduleExports).slice(0, 10).join(", ")}${moduleExports.size > 10 ? ", ..." : ""}]`
      );
      if (moduleExports.has(element.name)) {
        logger.debug(`[DiagnosticProvider] Element '${element.name}' found in external module '${moduleName}' exports`);
        return true;
      }
    } else {
      logger.debug(
        `[DiagnosticProvider] Module '${moduleName}' not found in indexer. This module may not be indexed yet.`
      );
    }
    return false;
  }

  /**
   * Processes a template AST node
   * @param node The template node to process
   * @param processingCtx Processing context with callbacks and data structures
   * @param docCtx Document context for parsing
   * @param astCtors AST node constructors
   */
  private processTemplateNode(
    node: TemplateAstNode,
    processingCtx: ProcessingContext,
    docCtx: TemplateDocumentContext,
    astCtors: AstConstructors
  ): void {
    // Handle all types of control flow expressions
    if (this.isControlFlowNode(node)) {
      this.processControlFlowNode(node, processingCtx.visit, processingCtx.extractPipesFromExpression);
      return;
    }

    if (node instanceof astCtors.tmplAstElement || node instanceof astCtors.tmplAstTemplate) {
      this.processElementOrTemplateNode(node, processingCtx, docCtx, astCtors);
    }

    if (node instanceof astCtors.tmplAstBoundText) {
      this.processBoundTextNode(node, processingCtx.elements, docCtx.document, docCtx.offset, docCtx.text);
    }

    // Handle regular children for non-control-flow nodes
    if (this.hasChildren(node) && !this.isControlFlowNode(node)) {
      // @ts-expect-error: Complex Angular template AST node types from ts-morph
      processingCtx.visit(node.children);
    }
  }

  /**
   * Detects control flow nodes using duck typing instead of constructor name matching.
   * This is more robust than `node.constructor.name` which can break when bundled with esbuild.
   */
  private isControlFlowNode(node: TemplateAstNode): boolean {
    const n = node as Record<string, unknown>;
    // IfBlock/SwitchBlock: has `branches` array
    if (Array.isArray(n.branches)) {
      return true;
    }
    // ForLoopBlock: has `trackBy` and `contextVariables`
    if (n.trackBy !== undefined && n.contextVariables !== undefined) {
      return true;
    }
    // SwitchBlock in Angular 20/21 used `cases`; Angular 22 exposes `groups`.
    if (Array.isArray(n.cases)) {
      return true;
    }
    if (Array.isArray(n.groups)) {
      return true;
    }
    // DeferredBlock: has `placeholder`, `loading`, or `error` sub-blocks
    if (n.placeholder !== undefined || n.loading !== undefined || n.error !== undefined) {
      return true;
    }
    return false;
  }

  private processControlFlowNode(
    controlFlowNode: ControlFlowNode,
    visit: (nodesList: TemplateAstNode[]) => void,
    extractPipesFromExpression: (expression: unknown, nodeOffset?: number) => void
  ): void {
    // Check for pipes in main expression (condition/iterator)
    if (controlFlowNode.expression) {
      extractPipesFromExpression(controlFlowNode.expression);
    }

    // Handle branches and cases
    this.processControlFlowBranchesAndCases(controlFlowNode, visit, extractPipesFromExpression);

    // Handle main children
    if (controlFlowNode.children && Array.isArray(controlFlowNode.children)) {
      visit(controlFlowNode.children);
    }

    // Handle special blocks
    this.processControlFlowSpecialBlocks(controlFlowNode, visit);
  }

  private processControlFlowBranchesAndCases(
    controlFlowNode: ControlFlowNode,
    visit: (nodesList: TemplateAstNode[]) => void,
    extractPipesFromExpression: (expression: unknown, nodeOffset?: number) => void
  ): void {
    // Handle branches (@if/@else/@else if)
    this.processBranchesArray(controlFlowNode.branches, visit, extractPipesFromExpression);

    // Handle cases (@switch)
    this.processCasesArray(controlFlowNode.cases, visit, extractPipesFromExpression);

    // Handle grouped switch cases (@switch in Angular 22+)
    this.processGroupsArray(controlFlowNode.groups, visit, extractPipesFromExpression);
  }

  private processBranchesArray(
    branches: unknown,
    visit: (nodesList: TemplateAstNode[]) => void,
    extractPipesFromExpression: (expression: unknown, nodeOffset?: number) => void
  ): void {
    if (!branches || !Array.isArray(branches)) {
      return;
    }

    for (const branch of branches) {
      this.processBranchOrCase(branch, visit, extractPipesFromExpression);
    }
  }

  private processCasesArray(
    cases: unknown,
    visit: (nodesList: TemplateAstNode[]) => void,
    extractPipesFromExpression: (expression: unknown, nodeOffset?: number) => void
  ): void {
    if (!cases || !Array.isArray(cases)) {
      return;
    }

    for (const caseBlock of cases) {
      this.processBranchOrCase(caseBlock, visit, extractPipesFromExpression);
    }
  }

  private processGroupsArray(
    groups: unknown,
    visit: (nodesList: TemplateAstNode[]) => void,
    extractPipesFromExpression: (expression: unknown, nodeOffset?: number) => void
  ): void {
    if (!groups || !Array.isArray(groups)) {
      return;
    }

    for (const group of groups) {
      const switchGroup = group as { cases?: Array<{ expression?: unknown }>; children?: TemplateAstNode[] };
      if (Array.isArray(switchGroup.cases)) {
        for (const caseBlock of switchGroup.cases) {
          if (caseBlock.expression) {
            extractPipesFromExpression(caseBlock.expression);
          }
        }
      }
      if (Array.isArray(switchGroup.children)) {
        visit(switchGroup.children);
      }
    }
  }

  private processBranchOrCase(
    item: { expression?: unknown; children?: TemplateAstNode[] },
    visit: (nodesList: TemplateAstNode[]) => void,
    extractPipesFromExpression: (expression: unknown, nodeOffset?: number) => void
  ): void {
    if (item.expression) {
      extractPipesFromExpression(item.expression);
    }
    if (item.children && Array.isArray(item.children)) {
      visit(item.children);
    }
  }

  private processControlFlowSpecialBlocks(
    controlFlowNode: ControlFlowNode,
    visit: (nodesList: TemplateAstNode[]) => void
  ): void {
    // Handle @for empty block
    const emptyBlock = controlFlowNode.empty as { children?: TemplateAstNode[] };
    if (emptyBlock?.children && Array.isArray(emptyBlock.children)) {
      visit(emptyBlock.children);
    }

    // Handle @defer sub-blocks (placeholder, loading, error)
    ["placeholder", "loading", "error"].forEach((blockType) => {
      const block = (controlFlowNode as Record<string, unknown>)[blockType] as { children?: TemplateAstNode[] };
      if (block?.children) {
        visit(block.children);
      }
    });
  }

  /**
   * Processes element or template nodes
   * @param node The element or template node
   * @param processingCtx Processing context
   * @param docCtx Document context
   * @param astCtors AST constructors
   */
  private processElementOrTemplateNode(
    node: TmplAstElement | TmplAstTemplate,
    processingCtx: ProcessingContext,
    docCtx: TemplateDocumentContext,
    astCtors: AstConstructors
  ): void {
    const isTemplate = node instanceof astCtors.tmplAstTemplate;

    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    const regularAttrs = [...node.attributes, ...node.inputs, ...node.outputs, ...node.references];

    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    const templateAttrs = isTemplate ? [...node.templateAttrs] : [];
    const allAttrsList = [...regularAttrs, ...templateAttrs];

    const attributes = allAttrsList.map((attr: unknown) => ({
      // @ts-expect-error: Complex Angular template AST node types from ts-morph
      name: attr.name,
      // @ts-expect-error: Complex Angular template AST node types from ts-morph
      value: "value" in attr && attr.value ? String(attr.value) : "",
    }));

    const nodeName = isTemplate ? "ng-template" : node.name;
    const foundElements = processingCtx.indexer.getElements(nodeName);

    if (!isKnownHtmlTag(nodeName)) {
      this.addAngularElementsToList(
        node,
        nodeName,
        foundElements,
        processingCtx.elements,
        docCtx.document,
        docCtx.offset,
        attributes
      );
    } else {
      // For known HTML tags (like button, input, a), check if they have Angular directives
      // by searching for compound selectors like "button[mat-button]", "input[matInput]"
      this.checkKnownHtmlTagWithAttributes(node, nodeName, regularAttrs, attributes, processingCtx, docCtx);
    }

    // Process attributes
    this.processAttributes(regularAttrs, templateAttrs, nodeName, attributes, processingCtx, docCtx, astCtors);
  }

  /**
   * Checks if a known HTML tag (like button, input, a) has Angular directives
   * by searching for compound selectors like "button[mat-button]", "input[matInput]".
   *
   * Note: This method is specifically for directives that use compound selectors
   * (e.g., "button[mat-button]"). Regular attribute directives are handled by
   * processAttributes() which already creates diagnostics with correct attribute positions.
   */
  private checkKnownHtmlTagWithAttributes(
    _node: TmplAstElement | TmplAstTemplate,
    nodeName: string,
    regularAttrs: unknown[],
    attributes: Array<{ name: string; value: string }>,
    processingCtx: ProcessingContext,
    docCtx: TemplateDocumentContext
  ): void {
    // A single element can have multiple directives, but we should not add the same directive instance twice.
    const processedDirectives = new Set<unknown>();

    // For each attribute, check if there's a directive with a compound selector like "button[mat-button]"
    for (let i = 0; i < attributes.length; i++) {
      const attr = attributes[i];
      const attrAstNode = regularAttrs[i];

      const compoundSelector = `${nodeName}[${attr.name}]`;
      const foundCandidates = processingCtx.indexer.getElements(compoundSelector);

      // Only process if we actually found a directive with this compound selector
      if (foundCandidates.length === 0) {
        continue;
      }

      // @ts-expect-error: Complex Angular template AST node types from ts-morph
      const keySpan = attrAstNode?.keySpan ?? attrAstNode?.sourceSpan;
      if (!keySpan) {
        // Fallback to tag range if attribute position not available
        continue;
      }

      // Create range for the attribute only, not the entire tag
      const attributeRange = new vscode.Range(
        docCtx.document.positionAt(docCtx.offset + keySpan.start.offset),
        docCtx.document.positionAt(docCtx.offset + keySpan.end.offset)
      );

      for (const candidate of foundCandidates) {
        const isAngularElement = candidate.type === "component" || candidate.type === "directive";

        if (isAngularElement && !processedDirectives.has(candidate)) {
          processedDirectives.add(candidate);

          processingCtx.elements.push({
            name: attr.name, // Use attribute name, not compound selector, for config matching
            // @ts-expect-error: Complex Angular template AST node types from ts-morph
            type: candidate.type,
            isAttribute: true, // Mark as attribute since we're highlighting the attribute
            range: attributeRange, // Use attribute position, not entire tag
            tagName: nodeName,
            attributes,
          });
        }
      }
    }
  }

  private addAngularElementsToList(
    node: TmplAstElement | TmplAstTemplate,
    nodeName: string,
    foundElements: AngularElementData[],
    elements: ParsedHtmlElement[],
    document: vscode.TextDocument,
    offset: number,
    attributes: Array<{ name: string; value: string }>
  ): void {
    for (const candidate of foundElements) {
      const isKnownAngularElement = candidate.type === "component" || candidate.type === "directive";

      if (isKnownAngularElement) {
        elements.push({
          name: nodeName,
          // @ts-expect-error: Complex Angular template AST node types from ts-morph
          type: candidate.type,
          isAttribute: false,
          range: new vscode.Range(
            // @ts-expect-error: Complex Angular template AST node types from ts-morph
            document.positionAt(offset + node.startSourceSpan.start.offset),
            // @ts-expect-error: Complex Angular template AST node types from ts-morph
            document.positionAt(offset + node.startSourceSpan.end.offset)
          ),
          tagName: nodeName,
          attributes,
        });
      }
    }
  }

  /**
   * Processes attributes from element or template nodes
   * @param regularAttrs Regular attributes array
   * @param templateAttrs Template attributes array
   * @param nodeName Name of the node
   * @param attributes Parsed attributes array
   * @param processingCtx Processing context
   * @param docCtx Document context
   * @param astCtors AST constructors
   */
  private processAttributes(
    regularAttrs: unknown[],
    templateAttrs: unknown[],
    nodeName: string,
    attributes: Array<{ name: string; value: string }>,
    processingCtx: ProcessingContext,
    docCtx: TemplateDocumentContext,
    astCtors: AstConstructors
  ): void {
    const processAttribute = (attr: unknown, isTemplateAttr: boolean) => {
      this.processSingleAttribute(attr, isTemplateAttr, nodeName, attributes, processingCtx, docCtx, astCtors);
    };

    for (const attr of regularAttrs) {
      processAttribute(attr, false);
    }
    for (const attr of templateAttrs) {
      processAttribute(attr, true);
    }
  }

  /**
   * Processes a single attribute
   * @param attr The attribute to process
   * @param isTemplateAttr Whether this is a template attribute
   * @param nodeName Name of the node
   * @param attributes Parsed attributes array
   * @param processingCtx Processing context
   * @param docCtx Document context
   * @param astCtors AST constructors
   */
  private processSingleAttribute(
    attr: unknown,
    isTemplateAttr: boolean,
    nodeName: string,
    attributes: Array<{ name: string; value: string }>,
    processingCtx: ProcessingContext,
    docCtx: TemplateDocumentContext,
    astCtors: AstConstructors
  ): void {
    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    const keySpan = attr.keySpan ?? attr.sourceSpan;
    if (!keySpan) {
      return;
    }

    // Skip event bindings, as they are not importable directives.
    if (attr instanceof astCtors.tmplAstBoundEvent) {
      return;
    }

    let type = "attribute";
    if (attr instanceof astCtors.tmplAstReference) {
      type = "template-reference";
      // @ts-expect-error: Complex Angular template AST node types from ts-morph
    } else if (isTemplateAttr || attr.name.startsWith("*")) {
      type = "structural-directive";
    } else if (attr instanceof astCtors.tmplAstBoundAttribute) {
      type = "property-binding";
    }

    processingCtx.elements.push({
      // @ts-expect-error: Complex Angular template AST node types from ts-morph
      name: attr.name,
      // @ts-expect-error: Complex Angular template AST node types from ts-morph
      type: type,
      isAttribute: true,
      range: new vscode.Range(
        docCtx.document.positionAt(docCtx.offset + keySpan.start.offset),
        docCtx.document.positionAt(docCtx.offset + keySpan.end.offset)
      ),
      tagName: nodeName,
      attributes,
    });

    // Check for pipes in bound attribute values (like *ngIf="expression | pipe")
    if (attr instanceof astCtors.tmplAstBoundAttribute && attr.value) {
      // @ts-expect-error: Complex Angular template AST node types from ts-morph
      const valueSpan = attr.valueSpan || attr.sourceSpan;
      if (valueSpan) {
        const expressionText = docCtx.text.slice(valueSpan.start.offset, valueSpan.end.offset);
        const pipes = this._findPipesInExpression(
          expressionText,
          docCtx.document,
          docCtx.offset,
          valueSpan.start.offset
        );
        for (const pipe of pipes) {
          // @ts-expect-error: Complex Angular template AST node types from ts-morph
          processingCtx.elements.push({ ...pipe, isAttribute: false, attributes: [] });
        }
      }
    }
  }

  private processBoundTextNode(
    node: TmplAstBoundText,
    elements: ParsedHtmlElement[],
    document: vscode.TextDocument,
    offset: number,
    text: string
  ): void {
    const pipes = this._findPipesInExpression(
      // @ts-expect-error: Complex Angular template AST node types from ts-morph
      text.slice(node.sourceSpan.start.offset, node.sourceSpan.end.offset),
      document,
      offset,
      // @ts-expect-error: Complex Angular template AST node types from ts-morph
      node.sourceSpan.start.offset
    );
    for (const pipe of pipes) {
      // @ts-expect-error: Complex Angular template AST node types from ts-morph
      elements.push({ ...pipe, isAttribute: false, attributes: [] });
    }
  }

  private hasChildren(node: unknown): boolean {
    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    return node && typeof node === "object" && "children" in node && Array.isArray(node.children);
  }

  private getSeverityFromConfig(severityLevel: string): vscode.DiagnosticSeverity {
    switch (severityLevel.toLowerCase()) {
      case "error":
        return vscode.DiagnosticSeverity.Error;
      case "warning":
        return vscode.DiagnosticSeverity.Warning;
      case "info":
        return vscode.DiagnosticSeverity.Information;
      default:
        return vscode.DiagnosticSeverity.Warning;
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
    void import("@angular/compiler")
      .then((compiler) => {
        this.compiler = compiler;
        logger.info("[DiagnosticProvider] @angular/compiler loaded, retrying open documents...");
        for (const document of vscode.workspace.textDocuments) {
          if (document.languageId === "html" || document.languageId === "typescript") {
            void this.updateDiagnostics(document);
          }
        }
      })
      .catch((error) => {
        logger.error("[DiagnosticProvider] Failed to pre-load @angular/compiler:", error as Error);
      });
  }
}

function isKnownHtmlTag(tag: string): boolean {
  return knownTags.has(tag.toLowerCase());
}

interface ParsedHtmlFullElement extends ParsedHtmlElement {
  type: "component" | "pipe" | "attribute" | "structural-directive" | "property-binding" | "template-reference";
  isAttribute: boolean;
  attributes: { name: string; value: string }[];
}
