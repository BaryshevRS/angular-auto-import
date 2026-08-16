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
import { toDocumentView } from "../adapters/vscode/document";
import { toVsCodeDiagnosticSeverity, toVsCodeRange } from "../adapters/vscode/language-types";
import { getStandardModuleExports } from "../config/standard-modules";
import type { CoreDiagnosticSeverity } from "../core/language-types";
import { findMissingImports, type MissingImportContext, type MissingImportDiagnostic } from "../core/missing-imports";
import { type ScannedTemplateElement, scanTemplate } from "../core/template-scan";
import { logger } from "../logger";
import type { AngularIndexer } from "../services";
import type { AngularElementData, TemplateAstNode } from "../types";
import { getAngularElements, getTsDocument, isStandalone, switchFileType } from "../utils";
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

    const { indexer } = projCtx;
    const severity = this.getSeverityFromConfig(this.context.extensionConfig.diagnosticsSeverity);

    // Parse the template to get all elements and their full context
    const parsedElements = this.parseCompleteTemplate(templateText, document, offset, indexer);
    const missingImports = findMissingImports(
      parsedElements,
      severity,
      this.createMissingImportContext(indexer, sourceFile)
    );

    this.candidateDiagnostics.set(document.uri.toString(), missingImports.map(toVsCodeDiagnostic));
    this.publishFilteredDiagnostics(document.uri);
  }

  /**
   * Wires the missing-import analysis to this project's index and the component's source file.
   */
  private createMissingImportContext(indexer: AngularIndexer, sourceFile: SourceFile): MissingImportContext {
    const { CssSelector, SelectorMatcher } = this.compiler;

    return {
      findCandidates: (name) => getAngularElements(name, indexer),
      isImported: (candidate) => this.isElementImported(sourceFile, candidate),
      getComponentImportNames: () => this.getComponentImportNames(sourceFile),
      getNamedImportSpecifiers: (importName) => this.getNamedImportModuleSpecifiers(sourceFile, importName),
      getExternalModuleExports: (moduleName) => indexer.getExternalModuleExports(moduleName),
      selectors: { cssSelector: CssSelector, selectorMatcher: SelectorMatcher },
    };
  }

  private parseCompleteTemplate(
    text: string,
    document: vscode.TextDocument,
    offset: number,
    indexer: AngularIndexer
  ): ScannedTemplateElement[] {
    const parseTemplateStartTime = process.hrtime.bigint();
    try {
      if (!this.compiler) {
        logger.warn("[DiagnosticProvider] @angular/compiler not loaded yet, skipping template parsing.");
        return [];
      }
      const {
        TmplAstBoundAttribute,
        TmplAstBoundEvent,
        TmplAstElement,
        TmplAstReference,
        TmplAstTemplate,
        TmplAstBoundText,
      } = this.compiler;

      const elements = scanTemplate({
        nodes: this.getTemplateNodes(text, document),
        document: toDocumentView(document),
        offset,
        text,
        lookup: indexer,
        constructors: {
          tmplAstElement: TmplAstElement,
          tmplAstTemplate: TmplAstTemplate,
          tmplAstBoundEvent: TmplAstBoundEvent,
          tmplAstReference: TmplAstReference,
          tmplAstBoundAttribute: TmplAstBoundAttribute,
          tmplAstBoundText: TmplAstBoundText,
        },
        onError: (message, error) => logger.error(`[DiagnosticProvider] ${message}`, error),
      });

      this.logOperationDuration("parseCompleteTemplate", document.fileName, parseTemplateStartTime);
      return elements;
    } catch (e) {
      logger.error(`[DiagnosticProvider] Failed to parse template: ${document.uri.fsPath}`, e as Error);
      return [];
    }
  }

  /**
   * Parses the template, reusing the cached AST while the document version is unchanged.
   */
  private getTemplateNodes(text: string, document: vscode.TextDocument): TemplateAstNode[] {
    const currentVersion = document.version;
    const cacheKey = document.uri.toString();
    const cached = this.templateCache.get(cacheKey);

    if (cached && cached.version === currentVersion) {
      logger.debug(`[DiagnosticProvider] Template cache HIT for ${document.fileName}`);
      return cached.nodes as TemplateAstNode[];
    }

    logger.debug(`[DiagnosticProvider] Template cache MISS for ${document.fileName}`);
    let nodes: TemplateAstNode[];
    try {
      // Use alwaysAttemptHtmlToR3AstConversion to parse templates with syntax errors
      // This option ensures we get partial AST even if template HTML is invalid
      const parsed = this.compiler.parseTemplate(text, document.uri.fsPath, {
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
      logger.error(`[DiagnosticProvider] Unexpected error parsing template ${document.fileName}:`, parseError as Error);
      nodes = [];
    }

    this.templateCache.set(cacheKey, { version: currentVersion, nodes });
    return nodes;
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

  private getProjectContextForDocument(document: vscode.TextDocument) {
    return getProjectContextForDocument(document, this.context.projectIndexers, this.context.projectTsConfigs);
  }

  /**
   * Returns the module specifiers of every top-level named import of `importName`.
   */
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

  /**
   * Returns every identifier listed in a `@Component({ imports: [...] })` in this file.
   */
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
