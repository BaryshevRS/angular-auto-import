/**
 * Decides which template elements are missing an import.
 *
 * Works from scanned template elements plus a context that answers questions about
 * the component file and the index, so the decision itself carries no editor or
 * TypeScript-AST dependency and returns plain diagnostic DTOs.
 * @module
 */

import { getStandardModuleExports } from "../config/standard-modules";
import type { AngularElementData } from "../types";
import { type CancellationSignal, neverCancelled } from "./cancellation";
import type { CoreDiagnosticSeverity, CoreRange } from "./language-types";
import type { ScannedTemplateElement } from "./template-scan";

/** The `source` every diagnostic this extension publishes is tagged with. */
export const DIAGNOSTIC_SOURCE = "angular-auto-import";

/** A missing import, located by a plain range. */
export interface MissingImportDiagnostic {
  range: CoreRange;
  message: string;
  /** `missing-<type>-import:<selector>`, read back by the quick fix. */
  code: string;
  source: typeof DIAGNOSTIC_SOURCE;
  severity: CoreDiagnosticSeverity;
  /**
   * Every element that would satisfy this token and is not imported.
   *
   * One token is one problem, however many elements answer to its selector, so the
   * diagnostics of a token are merged into one — but which of them the fix should import
   * is a separate question, and it can only be answered among these. Ranking over
   * everything the selector matches instead would include what the file already imports,
   * which is how a fix comes to offer an import that is already there.
   */
  elements: Array<{
    name: string;
    path: string;
    /**
     * What the selector this element matched under demands, canonically.
     *
     * Two elements share it exactly when they are two owners of one token, and a fix
     * that imports either settles it. Elements that differ in it are separate directives
     * that Angular applies together — `[foo]`, `button[foo]` and `[foo=check]` on one
     * `<button foo="check">` — so a fix-all has to import one of each, not one of all.
     */
    demands?: string;
  }>;
}

/** A CSS selector as the Angular compiler models it. */
interface CssSelectorLike {
  setElement(name: string): void;
  addAttribute(name: string, value: string): void;
  addClassName(name: string): void;
  toString(): string;
  /** The tag the selector requires, or null when it matches any. */
  element?: string | null;
  /** The attributes it requires, flattened as name, value, name, value. */
  attrs?: string[];
  /** The classes it requires, which a `.foo` is parsed into rather than into `attrs`. */
  classNames?: string[];
  /** The `:not(...)` parts, which narrow where it applies. */
  notSelectors?: CssSelectorLike[];
}

interface SelectorMatcherLike {
  addSelectables(selectors: CssSelectorLike[]): void;
  match(selector: CssSelectorLike, callback: (matched: CssSelectorLike) => void): void;
}

/**
 * The selector classes of the caller's dynamically imported Angular compiler, so
 * matching runs on the same implementation Angular itself uses.
 */
export interface AngularSelectorApi {
  cssSelector: {
    new (): CssSelectorLike;
    parse(selector: string): CssSelectorLike[];
  };
  selectorMatcher: new () => SelectorMatcherLike;
}

/** Everything the analysis needs to know about the component and the index. */
export interface MissingImportContext {
  /** Indexed elements that could satisfy a name used in the template. */
  findCandidates(name: string): AngularElementData[];
  /** Whether the component already imports the element, directly or through a module. */
  isImported(candidate: AngularElementData): boolean;
  /** Identifiers listed in the component's `imports: [...]`. */
  getComponentImportNames(): string[];
  /** Module specifiers of a top-level named import of `importName`. */
  getNamedImportSpecifiers(importName: string): string[];
  /** Exports of an NgModule the index knows about. */
  getExternalModuleExports(moduleName: string): Set<string> | undefined;
  selectors: AngularSelectorApi;
}

/**
 * Reports every scanned element that resolves to a known Angular element the
 * component does not import yet.
 * @param elements The elements found in the template.
 * @param severity The severity configured for missing imports.
 * @param context Answers about the component file and the index.
 * @param cancellation Checked between elements; a cancelled pass returns what it had.
 */
export function findMissingImports(
  elements: ScannedTemplateElement[],
  severity: CoreDiagnosticSeverity,
  context: MissingImportContext,
  cancellation: CancellationSignal = neverCancelled
): MissingImportDiagnostic[] {
  // One template construct can be scanned more than once — a property binding is also
  // an attribute, and a tag with attributes matches under several of an element's own
  // selectors — and saying the same sentence about the same text twice helps nobody.
  const found = new Map<string, MissingImportDiagnostic>();

  for (const element of elements) {
    // Every element runs Angular's selector matcher against the index, so a template
    // with hundreds of them is where an abandoned request costs the most.
    if (cancellation.isCancelled) {
      break;
    }

    for (const diagnostic of checkElement(element, severity, context)) {
      const key = identityOf(diagnostic);
      const kept = found.get(key);
      if (!kept) {
        found.set(key, diagnostic);
        continue;
      }

      // The same token, reported for another element that would also satisfy it. One
      // problem is one marker, but both elements stay on it: the fix chooses between them.
      const winner = isMoreSpecific(diagnostic, kept, element.name, context) ? diagnostic : kept;
      found.set(key, { ...winner, elements: mergeElements(kept.elements, diagnostic.elements) });
    }
  }

  return Array.from(found.values());
}

/**
 * Which of two findings about the same text to keep.
 *
 * `table[jupiter-table]` and `table[jupiter-table][bigRows]` are the same element matched
 * under two of its selectors, and the second says more about why it matched. Choosing by
 * specificity rather than by arrival order also makes the answer stable: what the index
 * happened to return first is not something a user should be able to notice.
 *
 * Two things decide it, in this order. A directive whose selector is *exactly* this
 * attribute is what the attribute is for, and speaks for it: `[nz-dropdown]` on a token
 * `nz-dropdown`, whatever else also matches there. Failing that, the one that demands the
 * most: on a token `nz-button`, `[nz-button][nz-dropdown]` is the directive a user has to
 * import to make that button a dropdown, while
 * `button[nz-button]:not([nzType="link"]):not([nzType="text"])` is a ripple that comes
 * along with the button — and is only the longer string, which is why length alone
 * decides nothing.
 * @internal
 */
function isMoreSpecific(
  candidate: MissingImportDiagnostic,
  incumbent: MissingImportDiagnostic,
  token: string,
  context: MissingImportContext
): boolean {
  const challenger = rankOf(selectorOf(candidate), token, context);
  const holder = rankOf(selectorOf(incumbent), token, context);

  if (challenger.isTheAttributeItself !== holder.isTheAttributeItself) {
    return challenger.isTheAttributeItself;
  }
  if (challenger.demands !== holder.demands) {
    return challenger.demands > holder.demands;
  }
  if (challenger.length !== holder.length) {
    return challenger.length > holder.length;
  }

  // Nothing left to prefer one by. The order is arbitrary but it has to be *an* order:
  // otherwise the marker is whichever the index happened to return first, which is not
  // something a user should be able to notice.
  return selectorOf(candidate) < selectorOf(incumbent);
}

/**
 * How well a selector answers for one token, as the compiler parses it.
 * @internal
 */
function rankOf(
  selector: string,
  token: string,
  context: MissingImportContext
): { isTheAttributeItself: boolean; demands: number; length: number } {
  const [parsed] = context.selectors.cssSelector.parse(selector);
  const attributes = parsed ? [...attributesOf(parsed)] : [];
  const classes = parsed?.classNames ?? [];
  const [name, value] = attributes[0] ?? ["", ""];
  return {
    // `[foo]` and nothing else: no tag, no value, no class, no condition. Each of those
    // makes it a directive for some of the attribute's uses rather than for the
    // attribute — `[foo].a` no less than `[foo]:not([disabled])`, and letting it hold the
    // marker puts `.a[foo]` in the diagnostic, which is what a quick fix then looks
    // elements up by.
    isTheAttributeItself:
      !parsed?.element &&
      (parsed?.notSelectors?.length ?? 0) === 0 &&
      classes.length === 0 &&
      attributes.length === 1 &&
      name === token &&
      !value,
    demands: attributes.length + classes.length,
    length: selector.length,
  };
}

/** The selector half of a `missing-<type>-import:<selector>` code. @internal */
function selectorOf(diagnostic: MissingImportDiagnostic): string {
  return diagnostic.code.slice(diagnostic.code.indexOf(":") + 1);
}

/**
 * What makes two diagnostics the same finding: the same message about the same text.
 *
 * The code is deliberately not part of it. One element matched under two of its own
 * selectors produces two codes for one problem, and the user would see the identical
 * sentence twice; both codes resolve to the same element, so either fixes it.
 * @internal
 */
/**
 * The elements of two reports of one token, in the order they were found and without
 * repeats.
 * @internal
 */
function mergeElements(
  kept: MissingImportDiagnostic["elements"],
  incoming: MissingImportDiagnostic["elements"]
): MissingImportDiagnostic["elements"] {
  const merged = [...kept];
  for (const element of incoming) {
    if (!merged.some((existing) => existing.name === element.name && existing.path === element.path)) {
      merged.push(element);
    }
  }
  return merged;
}

function identityOf(diagnostic: MissingImportDiagnostic): string {
  const { start, end } = diagnostic.range;
  return `${start.line}:${start.character}-${end.line}:${end.character}|${diagnostic.message}`;
}

/**
 * Reports the missing imports for one template element.
 * @internal
 */
function checkElement(
  element: ScannedTemplateElement,
  severity: CoreDiagnosticSeverity,
  context: MissingImportContext
): MissingImportDiagnostic[] {
  const diagnostics: MissingImportDiagnostic[] = [];
  const processedCandidatesThisCall = new Set<string>();

  const candidates = context.findCandidates(element.name);
  if (element.type === "pipe" && hasPipeSelectorMatchingImportedModule(element.name, candidates, context)) {
    return diagnostics;
  }

  for (const candidate of candidates) {
    if (!candidate || processedCandidatesThisCall.has(candidate.name)) {
      continue;
    }

    const diagnostic = processCandidateElement(element, candidate, severity, processedCandidatesThisCall, context);
    if (!diagnostic) {
      continue;
    }

    // Whether the missing class happens to be named after the token has no bearing on
    // it: Angular matches selectors, and two elements answering to the same selector
    // behave the same however they are called.
    if (candidate.type !== "pipe" && hasImportedAlternativeMatch(element, candidate, context)) {
      continue;
    }

    if (candidate.type === "pipe" && hasImportedPipeAlternativeMatch(element, candidate, context)) {
      continue;
    }

    diagnostics.push(diagnostic);
  }

  return diagnostics;
}

/**
 * Processes a single candidate element.
 * @internal
 */
function processCandidateElement(
  element: ScannedTemplateElement,
  candidate: AngularElementData,
  severity: CoreDiagnosticSeverity,
  processedCandidates: Set<string>,
  context: MissingImportContext
): MissingImportDiagnostic | null {
  if (candidate.type === "pipe") {
    // Only process pipe candidates if the element is actually a pipe usage (not a property binding)
    // This prevents false positives when an @Input() and a @Pipe() share the same name
    if (element.type !== "pipe") {
      return null;
    }

    processedCandidates.add(candidate.name);
    return context.isImported(candidate)
      ? null
      : createMissingImportDiagnostic(element, candidate, element.name, severity, context);
  }

  const matchedSelectors = getMatchedSelectors(element, candidate, context);
  if (matchedSelectors.length === 0) {
    return null;
  }

  // The last matched selector is considered the most specific one by Angular's engine.
  const specificSelector = matchedSelectors[matchedSelectors.length - 1];
  processedCandidates.add(candidate.name);

  return context.isImported(candidate)
    ? null
    : createMissingImportDiagnostic(element, candidate, specificSelector, severity, context);
}

/**
 * Suppresses false positives when one template token matches multiple Angular elements
 * but at least one of those matches is already imported.
 *
 * What the alternative is *called* has no part in it. A selector is not owned by the
 * class named after it: `[tuiSlot]` belongs at once to a block-status directive, an
 * app-bar directive and a badged-content directive, none of them named for it, and a
 * template that imports any of them has an owner for the attribute.
 *
 * What does have a part in it is what each selector *demands*. Suppression is limited to
 * selectors that demand exactly the same thing, because those are two owners of one
 * token and one of them being imported settles it. A selector that demands more, or
 * less, is a different directive that merely also matches here: an imported
 * `[nz-button][nz-dropdown]` leaves `[nz-dropdown]` missing, and an imported `[foo]` is
 * not the `button[foo]` a template is asking for.
 * @internal
 */
function hasImportedAlternativeMatch(
  element: ScannedTemplateElement,
  candidate: AngularElementData,
  context: MissingImportContext
): boolean {
  const candidateMatches = getMatchedSelectors(element, candidate, context);
  if (candidateMatches.length === 0) {
    return false;
  }

  for (const alternative of context.findCandidates(element.name)) {
    if (alternative.type === "pipe" || isSameElement(alternative, candidate)) {
      continue;
    }

    const alternativeMatches = getMatchedSelectors(element, alternative, context);
    if (alternativeMatches.length === 0 || !context.isImported(alternative)) {
      continue;
    }

    const answered = candidateMatches.some((candidateSelector) =>
      alternativeMatches.some((alternativeSelector) => demandsTheSame(candidateSelector, alternativeSelector, context))
    );
    if (answered) {
      return true;
    }
  }

  return false;
}

/**
 * Whether two selectors ask for the same thing, and are therefore two owners of it.
 *
 * Read from the compiler's own parse of both, so "asks for" means the tag, the attributes
 * and the attribute values Angular matches on. Equality, not coverage: a selector that
 * asks for *more* is a narrower directive that happens to match here too, and importing
 * it leaves the broader one missing. `[nz-dropdown]` is still needed when
 * `[nz-button][nz-dropdown]` is imported, and `button[foo]` is not answered by `[foo]`.
 *
 * Both are read through the compiler's parse and compared by what it holds — tag,
 * attributes with their values, and the `:not(...)` conditions, which are selectors
 * themselves and are read the same way. `[foo]` and `[foo]:not([disabled])` are
 * not one directive under two names: on an element that is not disabled Angular applies
 * both, so importing the conditional one leaves the plain one missing.
 * @internal
 */
function demandsTheSame(selector: string, other: string, context: MissingImportContext): boolean {
  const [one] = context.selectors.cssSelector.parse(selector);
  const [another] = context.selectors.cssSelector.parse(other);
  return (
    one !== undefined && another !== undefined && demandsKeyOf(demandsOf(one)) === demandsKeyOf(demandsOf(another))
  );
}

/**
 * Everything a parsed selector demands, in a shape two selectors share exactly when they
 * demand the same.
 *
 * A selector is a conjunction, so none of it is ordered: `:not([disabled][readonly])`
 * excludes exactly what `:not([readonly][disabled])` excludes. Every part is therefore
 * sorted, and the `:not(...)` parts are selectors in their own right, read the same way.
 *
 * Classes count, and have to: a `.foo` is parsed into `classNames` rather than into
 * `attrs`, so leaving them out made `[foo].a` and `[foo].b` one demand — and an imported
 * `[foo].b` then answered for a missing `[foo].a` on an element carrying both, which is
 * two directives Angular applies at once. Rare in libraries, where four of 1804 selectors
 * mention a class at all, but the matcher decides these cases now and the comparison has
 * to be told the same thing the matcher was.
 * @internal
 */
function demandsOf(selector: CssSelectorLike): SelectorDemands {
  const attributes = attributesOf(selector).sort(
    ([oneName, oneValue], [otherName, otherValue]) => compare(oneName, otherName) || compare(oneValue, otherValue)
  );
  const classes = [...(selector.classNames ?? [])].sort(compare);
  const conditions = (selector.notSelectors ?? []).map(demandsOf);
  conditions.sort((one, other) => compare(demandsKeyOf(one), demandsKeyOf(other)));

  return { element: selector.element ?? "", attributes, classes, conditions };
}

/** What a selector asks for, with nothing left implicit. @internal */
interface SelectorDemands {
  element: string;
  attributes: Array<[string, string]>;
  classes: string[];
  conditions: SelectorDemands[];
}

/**
 * The same demands as one string, for comparing and for ordering.
 *
 * Written by `JSON.stringify` rather than by joining with separators of our own: an
 * attribute value may contain any character, `[b="c,foo=a"]` among them, and a key built
 * by gluing parts together would read that as two attributes and call two different
 * selectors the same.
 * @internal
 */
function demandsKeyOf(demands: SelectorDemands): string {
  return JSON.stringify(demands);
}

/** @internal */
function compare(one: string, other: string): number {
  return one < other ? -1 : one > other ? 1 : 0;
}

/**
 * The attributes a parsed selector requires. Angular flattens them as name, value, name,
 * value.
 *
 * A list rather than a map by name: one name can be asked for twice, and
 * `[foo=a][foo=b]` is not `[foo=b]` — it is a selector that cannot match anything, but a
 * directive carrying it is still its own directive, and folding the two together would
 * let one answer for the other.
 * @internal
 */
function attributesOf(selector: CssSelectorLike): Array<[string, string]> {
  const attributes = selector.attrs ?? [];
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    pairs.push([attributes[index], attributes[index + 1]]);
  }
  return pairs;
}

/**
 * Suppresses pipe diagnostics when another pipe with the same selector is already available.
 * @internal
 */
function hasImportedPipeAlternativeMatch(
  element: ScannedTemplateElement,
  candidate: AngularElementData,
  context: MissingImportContext
): boolean {
  if (element.type !== "pipe") {
    return false;
  }

  for (const alternative of context.findCandidates(element.name)) {
    if (alternative.type !== "pipe" || isSameElement(alternative, candidate)) {
      continue;
    }

    if (context.isImported(alternative)) {
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
 * @internal
 */
function hasPipeSelectorMatchingImportedModule(
  pipeName: string,
  candidates: AngularElementData[],
  context: MissingImportContext
): boolean {
  const normalizedPipeName = normalizeSelectorForNameMatch(pipeName);
  if (!normalizedPipeName) {
    return false;
  }

  for (const importName of context.getComponentImportNames()) {
    if (!importName.endsWith("Module") || normalizeCandidateName(importName) !== normalizedPipeName) {
      continue;
    }

    if (getStandardModuleExports(importName) ?? context.getExternalModuleExports(importName)) {
      continue;
    }

    const moduleSpecifiers = context.getNamedImportSpecifiers(importName);
    if (moduleSpecifiers.length === 0) {
      continue;
    }

    if (candidates.some((candidate) => candidate.type === "pipe" && moduleSpecifiers.includes(candidate.path))) {
      return true;
    }
  }

  return false;
}

/**
 * Returns the candidate's selectors that match the element as written in the template.
 * @internal
 */
function getMatchedSelectors(
  element: ScannedTemplateElement,
  candidate: AngularElementData,
  context: MissingImportContext
): string[] {
  const { cssSelector, selectorMatcher } = context.selectors;

  const matcher = new selectorMatcher();
  matcher.addSelectables(cssSelector.parse(candidate.originalSelector));

  const templateCssSelector = new cssSelector();
  templateCssSelector.setElement(element.tagName);
  for (const attr of element.attributes) {
    templateCssSelector.addAttribute(attr.name, attr.value ?? "");
  }
  for (const className of element.classNames ?? []) {
    templateCssSelector.addClassName(className);
  }

  const matchedSelectors: string[] = [];
  matcher.match(templateCssSelector, (selector) => {
    matchedSelectors.push(selector.toString());
  });

  return matchedSelectors;
}

/**
 * Builds the diagnostic published for a missing import.
 * @internal
 */
function createMissingImportDiagnostic(
  element: ScannedTemplateElement,
  candidate: AngularElementData,
  specificSelector: string,
  severity: CoreDiagnosticSeverity,
  context: MissingImportContext
): MissingImportDiagnostic {
  return {
    range: element.range,
    message: `'${element.name}' is part of a known ${candidate.type}, but it is not imported.`,
    code: `missing-${candidate.type}-import:${specificSelector}`,
    source: DIAGNOSTIC_SOURCE,
    severity,
    elements: [{ name: candidate.name, path: candidate.path, demands: demandsKeyFor(specificSelector, context) }],
  };
}

/**
 * What one selector demands, as a key, or `undefined` when the compiler cannot parse it.
 * @internal
 */
function demandsKeyFor(selector: string, context: MissingImportContext): string | undefined {
  const [parsed] = context.selectors.cssSelector.parse(selector);
  return parsed === undefined ? undefined : demandsKeyOf(demandsOf(parsed));
}

/** @internal */
function normalizeSelectorForNameMatch(selectorName: string): string {
  return selectorName.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
}

/** @internal */
function normalizeCandidateName(candidateName: string): string {
  return candidateName
    .replace(/(Component|Directive|Pipe|Module)$/u, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase();
}

/** @internal */
function isSameElement(a: AngularElementData, b: AngularElementData): boolean {
  return a.name === b.name && a.path === b.path;
}
