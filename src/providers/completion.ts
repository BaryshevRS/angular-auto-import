/**
 *
 * Angular Auto-Import Completion Provider
 *
 * @module
 */

import type { SourceFile } from "ts-morph";
import * as vscode from "vscode";
import { toDocumentView } from "../adapters/vscode/document";
import { toVsCodeCompletionKind, toVsCodeRange } from "../adapters/vscode/language-types";
import { type CompletionContextData, detectCompletionContext } from "../core/completion-context";
import { buildCompletionSuggestions, type CompletionSuggestion } from "../core/completion-suggestions";
import { getTsDocument, isStandalone, LruCache, switchFileType } from "../utils";
import { getProjectContextForDocument } from "../utils/project-context";
import { isInsideTemplateString } from "../utils/template-detection";
import type { ProviderContext } from "./index";

/**
 * Provides autocompletion for Angular elements.
 * This implementation relies solely on regular expressions for context detection to ensure
 * high performance and prevent crashes from invalid template syntax during typing.
 */
export class CompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  private readonly standaloneCache = new LruCache<string, boolean>(50);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: ProviderContext) {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.standaloneCache.delete(document.fileName);
      })
    );
  }

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /**
   * Provides completion items for the given document and position.
   * @param document The document to provide completions for.
   * @param position The position at which to provide completions.
   * @param _token A cancellation token.
   * @param _context The context of the completion request.
   * @returns A list of completion items.
   */
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionList> {
    const projCtx = this.getProjectContextForDocument(document);
    if (!projCtx) {
      return new vscode.CompletionList([], true);
    }

    // For TypeScript files, ensure we are inside a template string
    // Pass the ts-morph project for robust AST-based detection
    if (
      document.languageId === "typescript" &&
      !isInsideTemplateString(toDocumentView(document), position, projCtx.indexer.project)
    ) {
      return new vscode.CompletionList([], true);
    }

    const isStandaloneComponent = await this.isStandaloneComponent(document);
    if (!isStandaloneComponent) {
      return new vscode.CompletionList([], true);
    }

    const contextData = detectCompletionContext(toDocumentView(document), position);
    if (contextData.context === "none") {
      return new vscode.CompletionList([], true);
    }

    // Check if completion is enabled for the current context
    const config = this.context.extensionConfig.completion;
    if (contextData.hasPipeContext && !config.pipes) {
      return new vscode.CompletionList([], true);
    }
    if (contextData.hasTagContext && !config.components) {
      return new vscode.CompletionList([], true);
    }
    if (contextData.hasAttributeContext && !config.directives) {
      return new vscode.CompletionList([], true);
    }

    const suggestions = buildCompletionSuggestions(projCtx.indexer, contextData);

    return new vscode.CompletionList(this.toCompletionItems(suggestions, contextData), true);
  }

  private async isStandaloneComponent(document: vscode.TextDocument): Promise<boolean> {
    const componentPath = document.languageId === "html" ? switchFileType(document.fileName, ".ts") : document.fileName;

    // For open, unsaved files, we are optimistic and allow completions.
    // We don't cache this result because the 'dirty' state is temporary.
    const activeDocument = vscode.workspace.textDocuments.find((doc) => doc.fileName === componentPath);
    if (activeDocument?.isDirty) {
      return true;
    }

    const cachedStatus = this.standaloneCache.get(componentPath);
    if (cachedStatus !== undefined) {
      return cachedStatus;
    }

    const componentFile = await this.getComponentSourceFile(document);
    if (componentFile) {
      const classDeclaration = componentFile.getClasses()[0];
      if (classDeclaration) {
        const isStandaloneComponent = isStandalone(classDeclaration);
        this.standaloneCache.set(componentPath, isStandaloneComponent);
        return isStandaloneComponent;
      }
    }
    // Default to true if we can't determine, to avoid blocking completions.
    this.standaloneCache.set(componentPath, true);
    return true;
  }

  private async getComponentSourceFile(document: vscode.TextDocument): Promise<SourceFile | undefined> {
    const projCtx = this.getProjectContextForDocument(document);
    if (!projCtx) {
      return undefined;
    }

    let componentPath = document.fileName;
    if (document.languageId === "html") {
      componentPath = switchFileType(document.fileName, ".ts");
    }

    const tsDocument = await getTsDocument(document, componentPath);
    if (!tsDocument) {
      return undefined;
    }

    return this.getSourceFile(tsDocument);
  }

  private getSourceFile(document: vscode.TextDocument): SourceFile | undefined {
    const projCtx = this.getProjectContextForDocument(document);
    if (!projCtx) {
      return undefined;
    }

    const { project } = projCtx.indexer;
    let sourceFile = project.getSourceFile(document.fileName);

    // For completions, we work with the last saved version of the file
    // that ts-morph knows about. We avoid updating it with unsaved content
    // because that's a very slow operation (re-parsing).
    // The cache is invalidated on save, which will trigger a re-read.
    sourceFile ??= project.createSourceFile(document.fileName, document.getText(), {
      overwrite: true,
    });

    return sourceFile;
  }

  /**
   * Maps ranked core suggestions onto VS Code completion items.
   */
  private toCompletionItems(
    suggestions: CompletionSuggestion[],
    contextData: CompletionContextData
  ): vscode.CompletionItem[] {
    return suggestions.map((suggestion) => this.toCompletionItem(suggestion, contextData));
  }

  /**
   * Maps a single core suggestion onto a VS Code completion item.
   */
  private toCompletionItem(
    suggestion: CompletionSuggestion,
    contextData: CompletionContextData
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(suggestion.label, toVsCodeCompletionKind(suggestion.kind));

    item.insertText = suggestion.insertText;
    item.filterText = suggestion.filterText;
    item.detail = suggestion.detail;
    item.documentation = new vscode.MarkdownString(suggestion.documentation);
    item.sortText = suggestion.sortText;

    if (contextData.replacementRange) {
      item.range = toVsCodeRange(contextData.replacementRange);
    }

    item.command = {
      title: `Import ${suggestion.element.name}`,
      command: "angular-auto-import.importElement",
      arguments: [suggestion.element],
    };

    return item;
  }

  /**
   * Gets the project context for a given document.
   * @param document The document to get the context for.
   * @returns The project context or `undefined` if not found.
   * @internal
   */
  private getProjectContextForDocument(document: vscode.TextDocument) {
    return getProjectContextForDocument(document, this.context.projectIndexers, this.context.projectTsConfigs);
  }
}
