/**
 * Template completion in the language server.
 *
 * The ranking itself lives in core and is shared with the Extension Host; this module
 * only decides whether a request should be answered at all — the document is in a
 * project, the cursor is in a template, the component accepts imports — and maps the
 * ranked suggestions onto LSP items.
 *
 * Accepting an item has to add an import. For an inline template that import lands in
 * the very document being completed, so the item can carry it as an ordinary edit —
 * applied with the completion itself, undone with it, and requiring no round trip. For
 * an external template the import belongs in a different file, which no completion edit
 * can express, so those items carry a server command instead.
 *
 * Either way the import is planned only when the client resolves the item it wants, not
 * for every item in the list: planning means rewriting the component with ts-morph.
 * @module
 */

import type { CompletionItem, CompletionList } from "vscode-languageserver/node";
import { toLspCompletionKind } from "../adapters/lsp/language-types";
import { type CancellationSignal, neverCancelled } from "../core/cancellation";
import { type CompletionContextData, detectCompletionContext } from "../core/completion-context";
import { buildCompletionSuggestions, type CompletionSuggestion } from "../core/completion-suggestions";
import type { DocumentPosition, DocumentView } from "../core/document";
import type { CoreRange } from "../core/language-types";
import { type CoreLogger, silentLogger } from "../core/logging";
import type { ExtensionConfig } from "../core/settings";
import type { AngularElementData } from "../types";
// Imported from their own modules, not the barrel: the barrel re-exports the
// Extension Host's edit application, which would pull `vscode` into the server bundle.
import { isStandalone } from "../utils/angular";
import { LruCache } from "../utils/cache";
import { isInsideTemplateString } from "../utils/template-detection";
import { APPLY_IMPORT_COMMAND, type ApplyImportArguments } from "./import-command";
import type { ImportEditPlanner } from "./import-edit";
import type { OpenDocuments } from "./open-documents";
import type { ProjectRouter, RoutedDocument } from "./project-router";
import { siblingUri } from "./uri";

/** How many components' standalone state is remembered between requests. */
const STANDALONE_CACHE_SIZE = 50;

/** An empty, incomplete list: nothing to offer here, but ask again on the next keystroke. */
const NOTHING: CompletionList = { isIncomplete: true, items: [] };

/** What an item needs to import its element once the user accepts it. */
export interface CompletionItemData {
  /** URI of the TypeScript file the import belongs in. */
  uri: string;
  elements: AngularElementData[];
  /** Whether that file is the one being completed, and can take the edit directly. */
  sameDocument: boolean;
}

export interface CompletionHandlerOptions {
  router: ProjectRouter;
  documents: OpenDocuments;
  /** The settings as they stand now; re-read per request because they change at runtime. */
  config(): ExtensionConfig;
  /** Plans the import an accepted item plans to make. */
  planner: ImportEditPlanner;
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
      items: suggestions.map((suggestion) =>
        toCompletionItem(suggestion, context, componentUri, !routed.externalTemplate)
      ),
    };
  }

  /**
   * Fills in how an accepted item will actually add its import.
   *
   * An inline template's import belongs in the document being completed, so it can ride
   * along as `additionalTextEdits`: applied in the same step as the completion, and
   * undone in the same step too. That is only safe where the import's edits do not
   * touch the text the completion itself is replacing — in a decorator written on one
   * line they would — and the command remains the fallback wherever it is not.
   * @param item The item as it was offered, carrying its {@link CompletionItemData}.
   */
  async resolve(item: CompletionItem): Promise<CompletionItem> {
    const data = item.data as CompletionItemData | undefined;
    if (!data?.sameDocument) {
      return item;
    }

    const planned = await this.options.planner.plan(data.uri, data.elements);
    if (!planned.edit || planned.reason) {
      // Nothing to add, or the file moved on: the command re-plans against whatever the
      // document is by then, which is the safer answer.
      return item;
    }

    const edits = planned.edit.documentChanges[0]?.edits ?? [];
    if (edits.length === 0 || edits.some((edit) => overlaps(edit.range, item.textEdit))) {
      return item;
    }

    // The edits carry the import; running the command too would import it twice.
    return { ...item, additionalTextEdits: edits, command: undefined };
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
  componentUri: string,
  sameDocument: boolean
): CompletionItem {
  const data: CompletionItemData = { uri: componentUri, elements: [{ ...suggestion.element }], sameDocument };
  const item: CompletionItem = {
    label: suggestion.label,
    kind: toLspCompletionKind(suggestion.kind),
    filterText: suggestion.filterText,
    detail: suggestion.detail,
    documentation: { kind: "markdown", value: suggestion.documentation },
    sortText: suggestion.sortText,
    data,
    // Kept for every item: resolution replaces it with edits only where those are safe,
    // and a client that never resolves still imports correctly.
    command: {
      title: `Import ${suggestion.element.name}`,
      command: APPLY_IMPORT_COMMAND,
      arguments: [{ uri: componentUri, elements: data.elements } satisfies ApplyImportArguments],
    },
  };

  if (context.replacementRange) {
    item.textEdit = { range: context.replacementRange, newText: suggestion.insertText };
  } else {
    item.insertText = suggestion.insertText;
  }

  return item;
}

/**
 * Whether an import edit would collide with the text the completion itself replaces.
 *
 * A decorator written across several lines never collides; one written on a single line
 * puts `imports: [...]` and the template in the same line, and there the two edits are
 * the same range — which no client may apply.
 * @internal
 */
function overlaps(edit: CoreRange, replaced: CompletionItem["textEdit"]): boolean {
  if (!replaced || !("range" in replaced)) {
    return false;
  }
  return !(isBefore(edit.end, replaced.range.start) || isBefore(replaced.range.end, edit.start));
}

/** Whether one position is at or before another. @internal */
function isBefore(left: CoreRange["start"], right: CoreRange["start"]): boolean {
  return left.line < right.line || (left.line === right.line && left.character <= right.character);
}
