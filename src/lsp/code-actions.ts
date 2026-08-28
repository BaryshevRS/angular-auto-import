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
import { getAngularElementAsync, getAngularElements, orderElementsForSelector } from "../utils/angular";
import type { DiagnosticsHandler } from "./diagnostics";
import { APPLY_IMPORT_COMMAND, type ApplyImportArguments } from "./import-command";
import type { ImportEditPlanner } from "./import-edit";
import type { ProjectRouter, RoutedDocument } from "./project-router";
import { FIX_ALL_KIND } from "./protocol";
import { siblingUri } from "./uri";

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
   * One fix per element a token could mean, deduplicated by it, most-specific first.
   * @internal
   */
  private async quickFixes(
    candidates: MissingImportDiagnostic[],
    routed: RoutedDocument,
    documentUri: string,
    cancellation: CancellationSignal
  ): Promise<CodeAction[]> {
    const actions = new Map<string, CodeAction>();

    for (const group of groupByToken(candidates)) {
      if (cancellation.isCancelled) {
        break;
      }
      // Every element the token could mean, not only the best of them: two directives
      // can share a selector, the template says nothing about which was intended, and
      // importing the wrong one leaves the file without a warning and without the
      // behaviour its author was after — Angular applies whichever is imported.
      const elements = await this.resolveElements(group, routed);
      for (const [rank, element] of elements.entries()) {
        const identity = angularElementIdentity(element);
        const offered = actions.get(identity);
        if (offered) {
          // Already offered as an alternative for another token, which this one prefers:
          // without this the token whose best fix that is would have no preferred action,
          // and the editor's own "fix this" would stop answering for it.
          offered.isPreferred ||= rank === 0;
          continue;
        }

        actions.set(
          identity,
          await this.buildAction({
            title: `⟐ Import ${element.name} from '${await this.specifierOf(element, routed)}'`,
            kind: CodeActionKind.QuickFix,
            elements: [element],
            routed,
            documentUri,
            diagnostics: group.map(toLspDiagnostic),
            // Only the most specific one, so an editor's "fix this" still has one answer
            // and the rest sit in the menu as the alternatives they are.
            isPreferred: rank === 0,
          })
        );
      }
    }

    return Array.from(actions.values());
  }

  /**
   * One action that imports every element the document is missing.
   *
   * It is offered from the first element on, not the second. The kind is a source
   * action, and an editor keeps those out of the quick-fix menu altogether, so a fix-all
   * that covers a single element sits beside nothing and duplicates nothing. Withholding
   * it cost the commonest file there is — the one missing a single import — every entry
   * point that asks for this kind by name: the palette command, the editor's own Fix
   * All, and `editor.codeActionsOnSave`.
   * @internal
   */
  private async fixAll(
    candidates: MissingImportDiagnostic[],
    routed: RoutedDocument,
    documentUri: string,
    cancellation: CancellationSignal
  ): Promise<CodeAction | undefined> {
    const selected = await this.selectFixAllElements(candidates, routed, cancellation);
    if (!selected || selected.length === 0) {
      return undefined;
    }

    return this.buildAction({
      title: `⟐ Import ${selected.length} missing Angular element${selected.length === 1 ? "" : "s"}`,
      kind: FIX_ALL_KIND,
      elements: selected,
      routed,
      documentUri,
      diagnostics: candidates.map(toLspDiagnostic),
    });
  }

  /**
   * Selects the elements a Fix All must import from compiler-backed diagnostics.
   *
   * Shared with workspace Fix All so both scopes make exactly the same decision about
   * alternatives (same demands) and independent directives (different demands).
   * A cancelled selection returns `undefined`; applying a partial Fix All is forbidden.
   */
  async selectFixAllElements(
    candidates: MissingImportDiagnostic[],
    routed: RoutedDocument,
    cancellation: CancellationSignal = neverCancelled
  ): Promise<AngularElementData[] | undefined> {
    const elements = new Map<string, AngularElementData>();
    for (const group of groupByToken(candidates)) {
      if (cancellation.isCancelled) {
        // A partial fix-all would silently import less than its title promises.
        return undefined;
      }
      // One per set of demands, not one per token. Two directives that demand the same
      // thing are alternatives and importing either settles the token, but `[foo]`,
      // `button[foo]` and `[foo=check]` are three directives Angular applies together:
      // importing only the first leaves the other two missing, and the diagnostics a
      // fix-all promised to clear come straight back.
      for (const element of await this.resolveIndependentElements(group, routed)) {
        elements.set(angularElementIdentity(element), element);
      }
    }

    const selected = Array.from(elements.values());
    return hasConflictingLocalNames(selected) ? undefined : selected;
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
   * The elements of one token that a fix has to import together.
   *
   * The elements the token could mean, less the ones that are alternatives of each
   * other: of those, the most specific stands for the rest, because importing it makes
   * the token owned and the others are then suppressed rather than reported again.
   *
   * An element whose diagnostic does not say what it demands — one restored from before
   * they carried it, or resolved from the selector alone — cannot be told apart from the
   * rest, so the token falls back to what it did before: its most specific element alone.
   * @internal
   */
  private async resolveIndependentElements(
    group: MissingImportDiagnostic[],
    routed: RoutedDocument
  ): Promise<AngularElementData[]> {
    const ranked = await this.resolveElements(group, routed);
    const demandsOf = new Map<string, string | undefined>();
    for (const candidate of group.flatMap((diagnostic) => diagnostic.elements ?? [])) {
      demandsOf.set(`${candidate.name}|${candidate.path}`, candidate.demands);
    }

    const chosen: AngularElementData[] = [];
    const covered = new Set<string>();
    for (const element of ranked) {
      const demands = demandsOf.get(`${element.name}|${element.path}`);
      if (demands === undefined) {
        if (chosen.length === 0) {
          chosen.push(element);
        }
        continue;
      }
      if (covered.has(demands)) {
        continue;
      }
      covered.add(demands);
      chosen.push(element);
    }

    return chosen;
  }

  /**
   * Every element one template token could mean, most specific first.
   *
   * The diagnostics of that token name the elements that are *missing*, and a fix has to
   * come from among them: re-deciding from the selector alone ranks every element that
   * answers to it, including the ones the file already imports — which is how a fix ends
   * up offering an import that is already there and doing nothing when applied. Among
   * the missing ones the ranking still decides, since a token several elements answer to
   * has no single right answer, only a most specific one — and a fix-all has to pick one
   * while a menu does not.
   *
   * Resolving from the selector remains the fallback, for diagnostics restored from
   * before they carried their element.
   * @internal
   */
  private async resolveElements(
    group: MissingImportDiagnostic[],
    routed: RoutedDocument
  ): Promise<AngularElementData[]> {
    const selector = selectorOf(group[0]);
    if (!selector) {
      return [];
    }

    try {
      const indexed = getAngularElements(selector, routed.runtime.indexer);
      const named = group
        .flatMap((candidate) => candidate.elements ?? [])
        .map((named) => indexed.find((element) => element.name === named.name && element.path === named.path))
        .filter((element): element is AngularElementData => element !== undefined);

      if (named.length > 0) {
        // Ranked, not filtered again: these already matched the template node, and the
        // selector in the code is only the one they were reported under.
        return orderElementsForSelector(selector, named);
      }

      const fallback = await getAngularElementAsync(selector, routed.runtime.indexer);
      return fallback ? [fallback] : [];
    } catch (error) {
      this.logger.error(`[CodeActions] Could not resolve ${selector}`, error as Error);
      return [];
    }
  }
}

function angularElementIdentity(element: AngularElementData): string {
  return [element.name, element.path, element.absolutePath ?? "", element.exportingModuleName ?? ""].join("\0");
}

/** The import planner does not invent aliases, so two exports with one local name cannot be fixed together safely. */
function hasConflictingLocalNames(elements: readonly AngularElementData[]): boolean {
  return new Set(elements.map((element) => element.name)).size !== elements.length;
}

/**
 * The diagnostics of one template token, grouped so a fix can be chosen among the
 * elements that token is missing rather than one diagnostic at a time.
 * @internal
 */
function groupByToken(candidates: MissingImportDiagnostic[]): MissingImportDiagnostic[][] {
  const groups = new Map<string, MissingImportDiagnostic[]>();

  for (const candidate of candidates) {
    const { start, end } = candidate.range;
    const key = `${candidate.code} ${start.line}:${start.character}-${end.line}:${end.character}`;
    const group = groups.get(key);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(key, [candidate]);
    }
  }

  return Array.from(groups.values());
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
