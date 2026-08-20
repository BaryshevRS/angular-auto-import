/**
 * Template completion in the language server.
 *
 * The ranking itself lives in core and is shared with the Extension Host; this module
 * only decides whether a request should be answered at all — the document is in a
 * project, the cursor is in a template, the component accepts imports — and maps the
 * ranked suggestions onto LSP items.
 *
 * Accepting an item has to add an import, and for an external template that import
 * belongs in a different file than the one being edited. Both cases therefore attach a
 * server command rather than an edit, so one code path applies the import wherever it
 * belongs.
 * @module
 */

import type { CompletionItem, CompletionList } from "vscode-languageserver/node";
import { toLspCompletionKind } from "../adapters/lsp/language-types";
import { type CancellationSignal, neverCancelled } from "../core/cancellation";
import { type CompletionContextData, detectCompletionContext } from "../core/completion-context";
import { buildCompletionSuggestions, type CompletionSuggestion } from "../core/completion-suggestions";
import type { DocumentPosition, DocumentView } from "../core/document";
import { type CoreLogger, silentLogger } from "../core/logging";
import type { ExtensionConfig } from "../core/settings";
// Imported from their own modules, not the barrel: the barrel re-exports the
// Extension Host's edit application, which would pull `vscode` into the server bundle.
import { isStandalone } from "../utils/angular";
import { LruCache } from "../utils/cache";
import { isInsideTemplateString } from "../utils/template-detection";
import { APPLY_IMPORT_COMMAND, type ApplyImportArguments } from "./import-command";
import type { OpenDocuments } from "./open-documents";
import type { ProjectRouter, RoutedDocument } from "./project-router";
import { siblingUri } from "./uri";

/** How many components' standalone state is remembered between requests. */
const STANDALONE_CACHE_SIZE = 50;

/** An empty, incomplete list: nothing to offer here, but ask again on the next keystroke. */
const NOTHING: CompletionList = { isIncomplete: true, items: [] };

export interface CompletionHandlerOptions {
  router: ProjectRouter;
  documents: OpenDocuments;
  /** The settings as they stand now; re-read per request because they change at runtime. */
  config(): ExtensionConfig;
  logger?: CoreLogger;
}

/** Answers `textDocument/completion` for Angular templates. */
export class CompletionHandler {
  private readonly standaloneCache = new LruCache<string, boolean>(STANDALONE_CACHE_SIZE);
  private readonly logger: CoreLogger;

  constructor(private readonly options: CompletionHandlerOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * Ranks the elements the cursor could be completing.
   *
   * Synchronous on purpose: nothing may be awaited between reading the index and
   * returning, so a result can never describe an index the project no longer has.
   * @param document The document the request arrived for.
   * @param position The cursor position.
   * @param cancellation Checked once, before the work starts; there is no later
   * checkpoint because nothing here yields for the token to flip in.
   */
  provide(
    document: DocumentView,
    position: DocumentPosition,
    cancellation: CancellationSignal = neverCancelled
  ): CompletionList {
    const routed = this.options.router.resolve(document.uri);
    if (!routed || cancellation.isCancelled) {
      return NOTHING;
    }

    if (!routed.externalTemplate && !isInsideTemplateString(document, position, routed.runtime.indexer.project)) {
      return NOTHING;
    }

    if (!this.acceptsImports(routed)) {
      return NOTHING;
    }

    const context = detectCompletionContext(document, position);
    if (context.context === "none" || !this.isEnabled(context)) {
      return NOTHING;
    }

    const suggestions = buildCompletionSuggestions(routed.runtime.indexer, context);
    const componentUri = routed.externalTemplate ? siblingUri(document.uri, ".ts") : document.uri;

    return {
      isIncomplete: true,
      items: suggestions.map((suggestion) => toCompletionItem(suggestion, context, componentUri)),
    };
  }

  /**
   * Forgets what was known about a component, so the next request re-reads it.
   * @param filePath Absolute path of the file that changed on disk.
   */
  invalidate(filePath: string): void {
    this.standaloneCache.delete(filePath);
  }

  /**
   * Whether adding to the component's `imports` array would do anything.
   *
   * A component with unsaved changes is answered optimistically: the file on disk is
   * not what the user is looking at, and refusing completions there is worse than
   * offering one the component cannot use.
   * @internal
   */
  private acceptsImports(routed: RoutedDocument): boolean {
    if (this.options.documents.isDirty(routed.componentFilePath)) {
      return true;
    }

    const cached = this.standaloneCache.get(routed.componentFilePath);
    if (cached !== undefined) {
      return cached;
    }

    const standalone = this.readStandalone(routed);
    this.standaloneCache.set(routed.componentFilePath, standalone);
    return standalone;
  }

  /**
   * Reads the component's standalone flag from the project's last-known source file.
   * Anything undeterminable counts as standalone, so an unreadable file never silently
   * disables completion.
   * @internal
   */
  private readStandalone(routed: RoutedDocument): boolean {
    try {
      const { project } = routed.runtime.indexer;
      const sourceFile =
        project.getSourceFile(routed.componentFilePath) ??
        project.addSourceFileAtPathIfExists(routed.componentFilePath);
      const classDeclaration = sourceFile?.getClasses()[0];
      return classDeclaration ? isStandalone(classDeclaration) : true;
    } catch (error) {
      this.logger.debug(`[CompletionHandler] Could not read ${routed.componentFilePath}: ${String(error)}`);
      return true;
    }
  }

  /** @internal */
  private isEnabled(context: CompletionContextData): boolean {
    const { completion } = this.options.config();
    if (context.hasPipeContext) {
      return completion.pipes;
    }
    if (context.hasTagContext) {
      return completion.components;
    }
    if (context.hasAttributeContext) {
      return completion.directives;
    }
    return true;
  }
}

/**
 * Maps one ranked suggestion onto an LSP item, attaching the command that imports the
 * element into the component once the user accepts it.
 * @internal
 */
function toCompletionItem(
  suggestion: CompletionSuggestion,
  context: CompletionContextData,
  componentUri: string
): CompletionItem {
  const item: CompletionItem = {
    label: suggestion.label,
    kind: toLspCompletionKind(suggestion.kind),
    filterText: suggestion.filterText,
    detail: suggestion.detail,
    documentation: { kind: "markdown", value: suggestion.documentation },
    sortText: suggestion.sortText,
    command: {
      title: `Import ${suggestion.element.name}`,
      command: APPLY_IMPORT_COMMAND,
      arguments: [{ uri: componentUri, elements: [{ ...suggestion.element }] } satisfies ApplyImportArguments],
    },
  };

  if (context.replacementRange) {
    item.textEdit = { range: context.replacementRange, newText: suggestion.insertText };
  } else {
    item.insertText = suggestion.insertText;
  }

  return item;
}
