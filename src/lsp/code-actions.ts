/**
 * Quick fixes and fix-all in the language server.
 *
 * The actions offered here are exactly the diagnostics the server retained for the
 * document, which is why `quickfix-only` mode works at all: the user is shown no
 * markers, but the fixes are still there. The edit itself belongs in the component's
 * TypeScript file, which for an external template is not the file the action was
 * requested in — so every action carries a cross-file workspace edit.
 *
 * Computing that edit means rewriting the component with ts-morph, which is far too
 * expensive to do for every action the editor merely lists. The edit is therefore left
 * out until the client resolves the action it actually wants, and only attached
 * up-front for a client that cannot resolve.
 * @module
 */

import { type CodeAction, CodeActionKind, type Range } from "vscode-languageserver/node";
import { toLspDiagnostic } from "../adapters/lsp/language-types";
import { type CancellationSignal, neverCancelled } from "../core/cancellation";
import type { DocumentView } from "../core/document";
import { resolveElementImportPath } from "../core/import-resolution";
import { type CoreLogger, silentLogger } from "../core/logging";
import type { MissingImportDiagnostic } from "../core/missing-imports";
import type { AngularElementData } from "../types";
import { getAngularElementAsync } from "../utils/angular";
import type { DiagnosticsHandler } from "./diagnostics";
import { APPLY_IMPORT_COMMAND, type ApplyImportArguments } from "./import-command";
import type { ImportEditPlanner } from "./import-edit";
import type { ProjectRouter, RoutedDocument } from "./project-router";
import { siblingUri } from "./uri";

/** The fix-all action this server contributes, as an LSP code-action kind. */
export const FIX_ALL_KIND = `${CodeActionKind.SourceFixAll}.angular-auto-import`;

/** What an action needs to compute its edit when the client resolves it. */
export interface CodeActionData {
  /** URI of the TypeScript file the imports belong in. */
  uri: string;
  elements: AngularElementData[];
}

export interface CodeActionHandlerOptions {
  router: ProjectRouter;
  diagnostics: DiagnosticsHandler;
  planner: ImportEditPlanner;
  /** Whether the client resolves code actions; a client that does not gets the edit up front. */
  resolvesActions(): boolean;
  logger?: CoreLogger;
}

/** Answers `textDocument/codeAction` and `codeAction/resolve`. */
export class CodeActionHandler {
  private readonly logger: CoreLogger;

  constructor(private readonly options: CodeActionHandlerOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * Offers a fix for every retained candidate the request's range touches, plus one
   * fix-all covering the whole document.
   * @param document The document the actions were requested for.
   * @param range The range the client asked about.
   * @param only The action kinds the client wants, or `undefined` for all of them.
   * @param cancellation Checked between the elements each action has to resolve.
   */
  async provide(
    document: DocumentView,
    range: Range,
    only?: readonly string[],
    cancellation: CancellationSignal = neverCancelled
  ): Promise<CodeAction[]> {
    const routed = this.options.router.resolve(document.uri);
    const candidates = this.options.diagnostics.candidatesFor(document);
    if (!routed || candidates.length === 0) {
      return [];
    }

    const inRange = candidates.filter((candidate) => intersects(candidate.range, range));
    const quickFixes = wants(only, CodeActionKind.QuickFix)
      ? await this.quickFixes(inRange, routed, document.uri, cancellation)
      : [];

    const fixAll = wants(only, FIX_ALL_KIND)
      ? await this.fixAll(candidates, routed, document.uri, cancellation)
      : undefined;

    if (cancellation.isCancelled) {
      return [];
    }

    return fixAll ? [...quickFixes, fixAll] : quickFixes;
  }

  /**
   * Fills in the edit of the action the client chose.
   * @param action The action as it was offered, carrying its {@link CodeActionData}.
   */
  async resolve(action: CodeAction): Promise<CodeAction> {
    const data = action.data as CodeActionData | undefined;
    if (!data || action.edit) {
      return action;
    }

    const planned = await this.options.planner.plan(data.uri, data.elements);
    if (planned.edit) {
      return { ...action, edit: planned.edit };
    }

    // Nothing to do, or the plan went stale: an action with neither edit nor command is
    // a no-op for the client, which is the honest answer to "this no longer applies".
    this.logger.debug(`[CodeActions] No edit for ${action.title}${planned.reason ? `: ${planned.reason}` : ""}`);
    return action;
  }

  /**
   * One fix per candidate, deduplicated by the element it imports, most-specific first.
   * @internal
   */
  private async quickFixes(
    candidates: MissingImportDiagnostic[],
    routed: RoutedDocument,
    documentUri: string,
    cancellation: CancellationSignal
  ): Promise<CodeAction[]> {
    const actions = new Map<string, CodeAction>();

    for (const candidate of candidates) {
      if (cancellation.isCancelled) {
        break;
      }
      const element = await this.resolveElement(candidate, routed);
      if (!element || actions.has(element.name)) {
        continue;
      }

      actions.set(
        element.name,
        await this.buildAction({
          title: `⟐ Import ${element.name} from '${await this.specifierOf(element, routed)}'`,
          kind: CodeActionKind.QuickFix,
          elements: [element],
          routed,
          documentUri,
          diagnostics: [toLspDiagnostic(candidate)],
          isPreferred: true,
        })
      );
    }

    return Array.from(actions.values());
  }

  /**
   * One action that imports every element the document is missing, or none when there
   * is at most one — a fix-all that fixes one thing is just the quick fix again.
   * @internal
   */
  private async fixAll(
    candidates: MissingImportDiagnostic[],
    routed: RoutedDocument,
    documentUri: string,
    cancellation: CancellationSignal
  ): Promise<CodeAction | undefined> {
    const elements = new Map<string, AngularElementData>();
    for (const candidate of candidates) {
      if (cancellation.isCancelled) {
        // A partial fix-all would silently import less than its title promises.
        return undefined;
      }
      const element = await this.resolveElement(candidate, routed);
      if (element) {
        elements.set(element.name, element);
      }
    }

    if (elements.size < 2) {
      return undefined;
    }

    return this.buildAction({
      title: `⟐ Import ${elements.size} missing Angular elements`,
      kind: FIX_ALL_KIND,
      elements: Array.from(elements.values()),
      routed,
      documentUri,
      diagnostics: candidates.map(toLspDiagnostic),
    });
  }

  /**
   * Builds one action, leaving its edit for `resolve` unless the client cannot ask.
   * @internal
   */
  private async buildAction(request: {
    title: string;
    kind: string;
    elements: AngularElementData[];
    routed: RoutedDocument;
    documentUri: string;
    diagnostics: ReturnType<typeof toLspDiagnostic>[];
    isPreferred?: boolean;
  }): Promise<CodeAction> {
    const componentUri = request.routed.externalTemplate ? siblingUri(request.documentUri, ".ts") : request.documentUri;
    const data: CodeActionData = { uri: componentUri, elements: request.elements };
    const action: CodeAction = {
      title: request.title,
      kind: request.kind,
      diagnostics: request.diagnostics,
      isPreferred: request.isPreferred,
      data,
    };

    if (this.options.resolvesActions()) {
      return action;
    }

    const planned = await this.options.planner.plan(componentUri, request.elements);
    if (planned.edit) {
      action.edit = planned.edit;
      return action;
    }

    // Without resolve support and without an edit, the command is the only way left to
    // carry the fix; the client runs it and the server applies the edit itself.
    action.command = {
      title: request.title,
      command: APPLY_IMPORT_COMMAND,
      arguments: [{ uri: componentUri, elements: request.elements } satisfies ApplyImportArguments],
    };
    return action;
  }

  /**
   * The module specifier the import will actually be written with.
   *
   * The title has to name what the user will see in their file, not the project-relative
   * path the element happens to be indexed under; for a project element behind a
   * tsconfig alias those are not remotely the same string.
   * @internal
   */
  private async specifierOf(element: AngularElementData, routed: RoutedDocument): Promise<string> {
    try {
      return await resolveElementImportPath(
        element,
        routed.componentFilePath,
        routed.runtime.rootPath,
        (modulePath, fromFile) => routed.runtime.resolveImportPath(modulePath, fromFile)
      );
    } catch (error) {
      this.logger.debug(`[CodeActions] Could not resolve an import path for ${element.name}: ${String(error)}`);
      return element.path;
    }
  }

  /**
   * Resolves the element a diagnostic's selector refers to, matching the way the quick
   * fix has always resolved it: the index first, then Angular's own selector matcher
   * when several elements answer to the same selector.
   * @internal
   */
  private async resolveElement(
    candidate: MissingImportDiagnostic,
    routed: RoutedDocument
  ): Promise<AngularElementData | undefined> {
    const selector = selectorOf(candidate);
    if (!selector) {
      return undefined;
    }

    try {
      return await getAngularElementAsync(selector, routed.runtime.indexer);
    } catch (error) {
      this.logger.error(`[CodeActions] Could not resolve ${selector}`, error as Error);
      return undefined;
    }
  }
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
 * Whether the client asked for this kind of action. A kind is requested when it or any
 * of its prefixes was named, which is how `source.fixAll` reaches our own fix-all.
 * @internal
 */
function wants(only: readonly string[] | undefined, kind: string): boolean {
  return only === undefined || only.some((requested) => kind === requested || kind.startsWith(`${requested}.`));
}

/**
 * Whether two ranges overlap at all, including the zero-width range a bare cursor is.
 * @internal
 */
function intersects(a: Range, b: Range): boolean {
  return !isBefore(a.end, b.start) && !isBefore(b.end, a.start);
}

/** @internal */
function isBefore(left: Range["start"], right: Range["start"]): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}
