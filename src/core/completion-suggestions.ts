/**
 * Selector matching and ranking for template completion.
 *
 * Turns a resolved completion context plus the indexed elements into plain
 * suggestion DTOs, ordered exactly as the editor should show them. Editor
 * layers only map these onto their own completion item type.
 * @module
 */

import { STANDARD_ANGULAR_ELEMENTS } from "../config/angular-elements";
import { AngularElementData, type Element } from "../types";
import type { CompletionContextData } from "./completion-context";
import type { CoreCompletionKind, CoreRange } from "./language-types";

/** How many index hits are ranked; anything past this never reaches the user. */
const MAX_INDEX_RESULTS = 10;

/** One ranked completion, carrying everything an editor item needs and nothing editor-specific. */
export interface CompletionSuggestion {
  label: string;
  kind: CoreCompletionKind;
  insertText: string;
  filterText: string;
  detail: string;
  /** Markdown source; editors wrap it in their own rich-text type. */
  documentation: string;
  sortText: string;
  replacementRange: CoreRange | undefined;
  /** The element to import when this suggestion is accepted. */
  element: AngularElementData;
}

/** The slice of the element index that ranking needs. */
export interface CompletionElementSource {
  searchWithSelectors(prefix: string): Array<{ selector: string; element: AngularElementData }>;
}

type SelectorMatch = { relevance: number; insertText: string; itemKind: CoreCompletionKind };

type ElementEntry = { element: AngularElementData; selectors: string[] };

type PotentialSuggestion = {
  insertText: string;
  element: AngularElementData;
  relevance: number;
  kind: CoreCompletionKind;
  originalBestSelector: string;
};

/**
 * Ranks indexed and built-in Angular elements against the completion context.
 * @param source The element index to search.
 * @param context The resolved completion context.
 * @returns Deduplicated suggestions in display order.
 */
export function buildCompletionSuggestions(
  source: CompletionElementSource,
  context: CompletionContextData
): CompletionSuggestion[] {
  const seenElements = new Set<string>();
  const suggestions = [
    ...buildIndexedSuggestions(source, context, seenElements),
    ...buildStandardSuggestions(context, seenElements),
  ];

  return deduplicateAndSort(suggestions);
}

/**
 * Ranks elements coming from the project index.
 * @internal
 */
function buildIndexedSuggestions(
  source: CompletionElementSource,
  context: CompletionContextData,
  seenElements: Set<string>
): CompletionSuggestion[] {
  let searchResults = source.searchWithSelectors(context.filterText);

  // Filter by element type BEFORE applying limit to avoid mixing pipes with components/directives
  if (context.hasPipeContext) {
    searchResults = searchResults.filter((result) => result.element.type === "pipe");
  }

  // Apply limit after filtering to get top results of the correct type
  const limitedResults = searchResults.slice(0, MAX_INDEX_RESULTS);

  const elementEntries = sortElementEntriesIfNeeded(groupSearchResultsByElement(limitedResults), context);
  const potentialSuggestions = createPotentialSuggestions(elementEntries, context);

  return toSuggestions(potentialSuggestions, context, seenElements);
}

/**
 * Groups search results by element to avoid duplicates.
 * @internal
 */
function groupSearchResultsByElement(
  searchResults: Array<{ selector: string; element: AngularElementData }>
): ElementEntry[] {
  const elementsToProcess = new Map<string, ElementEntry>();

  for (const { selector, element } of searchResults) {
    const elementKey = `${element.path}:${element.name}`;
    if (!elementsToProcess.has(elementKey)) {
      elementsToProcess.set(elementKey, { element, selectors: [] });
    }
    elementsToProcess.get(elementKey)?.selectors.push(selector);
  }

  return Array.from(elementsToProcess.values());
}

/**
 * In tag context, floats the element whose class name matches the typed selector.
 * @internal
 */
function sortElementEntriesIfNeeded(elementEntries: ElementEntry[], context: CompletionContextData): ElementEntry[] {
  if (context.hasTagContext && context.filterText) {
    const expectedName = toPascalCase(context.filterText);

    return elementEntries.sort((a, b) => {
      if (a.element.name === expectedName && b.element.name !== expectedName) {
        return -1;
      }
      if (b.element.name === expectedName && a.element.name !== expectedName) {
        return 1;
      }
      return 0;
    });
  }
  return elementEntries;
}

/**
 * Keeps only the elements with a matching selector, at their best selector.
 * @internal
 */
function createPotentialSuggestions(
  elementEntries: ElementEntry[],
  context: CompletionContextData
): PotentialSuggestion[] {
  const potentialSuggestions: PotentialSuggestion[] = [];

  for (const { element, selectors } of elementEntries) {
    const bestMatch = findBestSelectorMatch(element, selectors, context);
    if (bestMatch.relevance > 0) {
      potentialSuggestions.push({
        insertText: bestMatch.insertText,
        element,
        relevance: bestMatch.relevance,
        kind: bestMatch.itemKind,
        originalBestSelector: bestMatch.selector,
      });
    }
  }

  return potentialSuggestions;
}

/**
 * Finds the best selector match for an element.
 * @internal
 */
function findBestSelectorMatch(
  element: AngularElementData,
  selectors: string[],
  context: CompletionContextData
): { relevance: number; selector: string; insertText: string; itemKind: CoreCompletionKind } {
  let bestRelevance = 0;
  let bestSelector = "";
  let bestInsertText = "";
  let bestItemKind: CoreCompletionKind = "class";

  for (const elementSelector of selectors) {
    const match = evaluateSelectorMatch(element, elementSelector, context);
    if (match.relevance > bestRelevance) {
      bestRelevance = match.relevance;
      bestSelector = elementSelector;
      bestInsertText = match.insertText;
      bestItemKind = match.itemKind;
    }
  }

  return {
    relevance: bestRelevance,
    selector: bestSelector,
    insertText: bestInsertText,
    itemKind: bestItemKind,
  };
}

/**
 * Evaluates a single selector match.
 * @internal
 */
function evaluateSelectorMatch(
  element: AngularElementData,
  elementSelector: string,
  context: CompletionContextData
): SelectorMatch {
  const matchesAsElement = variantIsTagName(element, elementSelector);

  if (element.type === "pipe" && context.hasPipeContext) {
    return evaluatePipeMatch(elementSelector, context);
  }

  if (element.type === "component" || element.type === "directive") {
    return evaluateElementOrAttributeMatch(element, elementSelector, context, matchesAsElement);
  }

  return { relevance: 0, insertText: elementSelector, itemKind: "class" };
}

/**
 * Evaluates a pipe match.
 * @internal
 */
function evaluatePipeMatch(elementSelector: string, context: CompletionContextData): SelectorMatch {
  if (startsWithFilter(elementSelector, context)) {
    return {
      relevance: 2,
      insertText: elementSelector,
      itemKind: "function",
    };
  }
  return { relevance: 0, insertText: elementSelector, itemKind: "function" };
}

/**
 * Common logic for evaluating element or attribute selector matches (components and directives).
 * @internal
 */
function evaluateElementOrAttributeMatch(
  element: AngularElementData,
  elementSelector: string,
  context: CompletionContextData,
  matchesAsElement: boolean
): SelectorMatch {
  if (matchesAsElement && context.hasTagContext) {
    if (startsWithFilter(elementSelector, context)) {
      return {
        relevance: 2,
        insertText: elementSelector,
        itemKind: "class",
      };
    }
  } else if (!matchesAsElement && context.hasAttributeContext) {
    return evaluateAttributeMatch(element, elementSelector, context);
  }

  return { relevance: 0, insertText: elementSelector, itemKind: "class" };
}

/**
 * Whether one variant of an element's selector names a tag rather than an attribute.
 *
 * The index registers a directive under several variants: `ng-template[jupiterTemplateRow]`
 * is stored under the whole selector, under `[jupiterTemplateRow]`, and under the bare
 * `jupiterTemplateRow`. Read on its own that last one is indistinguishable from a tag
 * name, so it has to be read against the selector it came from: it names a tag only if
 * some part of that selector actually leads with it.
 *
 * Getting this wrong is not a ranking detail. A variant classified as a tag is only ever
 * offered in tag context, so a directive whose every selector is tag-scoped — which is
 * how Material and most component libraries write theirs — was never offered at all,
 * while the diagnostic for the very same directive worked.
 * @param element The element the variant belongs to.
 * @param elementSelector The variant being evaluated.
 * @internal
 */
function variantIsTagName(element: AngularElementData, elementSelector: string): boolean {
  if (!isElementSelector(elementSelector)) {
    return false;
  }

  return element.originalSelector
    .split(",")
    .map((part) => part.trim())
    .some(
      (part) =>
        part === elementSelector || part.startsWith(`${elementSelector}[`) || part.startsWith(`${elementSelector}:`)
    );
}

/**
 * Determines if a selector is an element selector (for tag context).
 * Element selectors are used in tag context (e.g., <app-header>, <router-outlet>).
 * Attribute selectors are used in attribute context (e.g., [ngModel], button[mat-button]).
 *
 * Examples:
 * - "button[mat-button]" → false (attribute directive for button elements)
 * - "custom-input:not([disabled])" → true (element directive, attributes inside :not() don't count)
 * - "[ngModel]" → false (pure attribute directive)
 * - "app-header" → true (pure element directive/component)
 * @param selector The selector to check.
 * @returns true if it's an element selector, false if it's an attribute selector.
 * @internal
 */
function isElementSelector(selector: string): boolean {
  // Pure attribute selectors start with "["
  if (selector.startsWith("[")) {
    return false;
  }

  // Remove :not() pseudo-classes to check the main selector
  // e.g., "custom-input:not([disabled]):not([readonly])" → "custom-input"
  const withoutNotPseudoClass = selector.replace(/:not\([^)]+\)/g, "");

  // If there are still "[" outside :not(), it's an attribute selector
  // e.g., "button[mat-button]" → "button[mat-button]" (still has [)
  if (withoutNotPseudoClass.includes("[")) {
    return false;
  }

  // Element selectors start with a tag name
  return /^[a-zA-Z]/.test(selector);
}

/**
 * Evaluates attribute-specific matches.
 * @internal
 */
function evaluateAttributeMatch(
  element: AngularElementData,
  elementSelector: string,
  context: CompletionContextData
): SelectorMatch {
  const attrName = extractAttributeName(elementSelector);

  if (!startsWithFilter(attrName, context)) {
    return { relevance: 0, insertText: elementSelector, itemKind: "class" };
  }

  const insertText = formatAttributeInsertText(attrName, context);
  const itemKind: CoreCompletionKind = context.context === "structural-directive" ? "keyword" : "property";

  let relevance = 2;
  relevance += calculateClassNameRelevance(element.name, attrName);
  relevance += calculateTagMatchRelevance(element, attrName, context.tagName);

  return { relevance, insertText, itemKind };
}

/**
 * A selector scoped to one tag, such as `button[matButton]` or `img[ngSrc]`.
 * @internal
 */
const TAG_SCOPED_ATTRIBUTE = /^[a-zA-Z][a-zA-Z0-9-]*\[([^\]]+)\]$/;

/**
 * Extracts clean attribute name from selector.
 *
 * A tag-scoped selector names both the tag it applies to and the attribute it is; only
 * the attribute is typed. Returning the whole selector meant accepting the suggestion
 * wrote the tag name a second time — `<button button[matButton]`.
 * @internal
 */
function extractAttributeName(elementSelector: string): string {
  if (elementSelector.startsWith("[")) {
    return elementSelector.slice(1, -1);
  }
  if (elementSelector.startsWith("*")) {
    return elementSelector.slice(1);
  }
  const tagScoped = TAG_SCOPED_ATTRIBUTE.exec(elementSelector);
  if (tagScoped) {
    return tagScoped[1];
  }
  return elementSelector;
}

/**
 * Formats insert text for attributes.
 * @internal
 */
function formatAttributeInsertText(attrName: string, context: CompletionContextData): string {
  if (context.context === "structural-directive" && !context.triggerChar) {
    return `*${attrName}`;
  }
  return attrName;
}

/**
 * Calculates relevance based on class name match.
 * @internal
 */
function calculateClassNameRelevance(className: string, attrName: string): number {
  return className.startsWith(toPascalCase(attrName)) ? 2 : 0;
}

/**
 * Boosts an attribute that the element declares specifically for the tag being typed.
 *
 * Asked of the element rather than of the one selector being evaluated. The index
 * registers such a directive under several selectors — `button[matButton]`, `matButton`,
 * `[matButton]` — and only the first is recognizably tag-scoped. Testing that one meant
 * the boost applied only while the filter was empty and vanished the moment the user
 * typed `m`, which is exactly when ranking starts to matter.
 *
 * The tag comes from the context, which read it while deciding there was a tag at all.
 * Re-deriving it from the line meant finding the `<` again, and a bracket inside an
 * earlier attribute value answered that wrongly — dropping the boost exactly where the
 * user is furthest into typing the attribute.
 * @param element The element the attribute belongs to.
 * @param attrName The attribute as it would be typed.
 * @param tagName The tag the cursor is inside, when it is inside one.
 * @internal
 */
function calculateTagMatchRelevance(
  element: AngularElementData,
  attrName: string,
  tagName: string | undefined
): number {
  if (!tagName) {
    return 0;
  }

  const scoped = `${tagName}[${attrName}]`;
  const declared = [...element.selectors, ...element.originalSelector.split(",").map((part) => part.trim())];
  return declared.includes(scoped) ? 5 : 0;
}

/** Relevance is subtracted from this, so a higher relevance sorts first. */
const SORT_TEXT_CEILING = 1000;

/**
 * Turns ranked matches into suggestions, labelling elements that share an insert text.
 * @internal
 */
function toSuggestions(
  potentialSuggestions: PotentialSuggestion[],
  context: CompletionContextData,
  seenElements: Set<string>
): CompletionSuggestion[] {
  const groupedByInsertText = groupSuggestionsByInsertText(potentialSuggestions);
  const suggestions: CompletionSuggestion[] = [];

  for (const group of groupedByInsertText.values()) {
    for (const suggestion of group) {
      const elementKey = `${suggestion.element.path}:${suggestion.element.name}`;
      if (seenElements.has(elementKey)) {
        continue;
      }
      seenElements.add(elementKey);

      suggestions.push(toSuggestion(suggestion, group.length > 1, context));
    }
  }

  return suggestions;
}

/**
 * Groups suggestions by insert text.
 * @internal
 */
function groupSuggestionsByInsertText(potentialSuggestions: PotentialSuggestion[]): Map<string, PotentialSuggestion[]> {
  const grouped = new Map<string, PotentialSuggestion[]>();

  for (const suggestion of potentialSuggestions) {
    if (!suggestion.insertText) {
      continue;
    }

    const existing = grouped.get(suggestion.insertText);
    if (existing) {
      existing.push(suggestion);
    } else {
      grouped.set(suggestion.insertText, [suggestion]);
    }
  }

  return grouped;
}

/**
 * Builds a single indexed-element suggestion.
 * @internal
 */
function toSuggestion(
  suggestion: PotentialSuggestion,
  isSharedSelector: boolean,
  context: CompletionContextData
): CompletionSuggestion {
  const { element, kind, relevance, originalBestSelector, insertText } = suggestion;

  return {
    label: isSharedSelector ? `${insertText}:${element.name}` : insertText,
    kind,
    insertText,
    filterText: extractAttributeName(originalBestSelector),
    detail: describeElement(element),
    documentation: documentElement(element, originalBestSelector),
    sortText: relevanceSortText(relevance, insertText),
    replacementRange: context.replacementRange,
    element,
  };
}

/**
 * Describes where an element comes from, shown next to the suggestion label.
 * @internal
 */
function describeElement(element: AngularElementData): string {
  if (element.isStandalone) {
    return `Angular Auto-Import: standalone ${element.type}`;
  }
  if (element.exportingModuleName) {
    return `Angular Auto-Import: from ${element.exportingModuleName}`;
  }
  return `Angular Auto-Import: ${element.type}`;
}

/**
 * Builds the markdown shown when a suggestion is expanded.
 * @internal
 */
function documentElement(element: AngularElementData, originalBestSelector: string): string {
  const selectorLine = `\n\nSelector: \`${originalBestSelector}\``;

  if (element.isStandalone) {
    return `✅ Import standalone \`${element.name}\` (${element.type}) from \`${element.path}\`.${selectorLine}`;
  }
  if (element.exportingModuleName) {
    return `⚠️ Import \`${element.name}\` via \`${element.exportingModuleName}\` module from \`${element.path}\`.${selectorLine}`;
  }
  return `Import \`${element.name}\` (${element.type}) from \`${element.path}\`.${selectorLine}`;
}

/**
 * Ranks the built-in Angular elements that ship with the extension.
 * @internal
 */
function buildStandardSuggestions(context: CompletionContextData, seenElements: Set<string>): CompletionSuggestion[] {
  const suggestions: CompletionSuggestion[] = [];

  for (const [stdSelector, stdElement] of Object.entries(STANDARD_ANGULAR_ELEMENTS)) {
    if (context.filterText && !stdSelector.toLowerCase().includes(context.filterText.toLowerCase())) {
      continue;
    }

    const match = evaluateStandardElementMatch(stdSelector, stdElement, context);
    if (!match) {
      continue;
    }

    const elementKey = `${stdElement.importPath}:${stdElement.name}`;
    if (seenElements.has(elementKey)) {
      continue;
    }
    seenElements.add(elementKey);

    suggestions.push(toStandardSuggestion(stdSelector, stdElement, match, context));
  }

  return suggestions;
}

/**
 * Evaluates a built-in element, returning its match or `undefined` when it does not apply.
 * @internal
 */
function evaluateStandardElementMatch(
  stdSelector: string,
  stdElement: Element,
  context: CompletionContextData
): SelectorMatch | undefined {
  if (stdElement.type === "directive" && context.hasAttributeContext) {
    const attrName = extractAttributeName(stdSelector);
    if (startsWithFilter(attrName, context)) {
      return {
        relevance: 3,
        insertText: formatAttributeInsertText(attrName, context),
        itemKind: context.context === "structural-directive" ? "keyword" : "property",
      };
    }
  }

  if (stdElement.type === "pipe" && context.hasPipeContext && startsWithFilter(stdSelector, context)) {
    return { relevance: 2, insertText: stdSelector, itemKind: "function" };
  }

  return undefined;
}

/**
 * Builds a suggestion for a built-in Angular element, which is always standalone and external.
 * @internal
 */
function toStandardSuggestion(
  stdSelector: string,
  stdElement: Element,
  match: SelectorMatch,
  context: CompletionContextData
): CompletionSuggestion {
  return {
    label: stdSelector,
    kind: match.itemKind,
    insertText: match.insertText,
    filterText: extractAttributeName(stdSelector),
    detail: `Angular Auto-Import: ${stdElement.type} (standalone)`,
    documentation: `Import from \`${stdElement.importPath}\`.`,
    sortText: relevanceSortText(match.relevance, stdSelector),
    replacementRange: context.replacementRange,
    element: new AngularElementData({
      path: stdElement.importPath ?? "",
      name: stdElement.name,
      type: stdElement.type,
      originalSelector: stdSelector,
      selectors: stdElement.selectors ?? [stdSelector],
      isStandalone: true,
      isExternal: true,
      exportingModuleName: undefined,
    }),
  };
}

/**
 * Orders two suggestions the way an editor will.
 *
 * Ordinal, not by locale: `sortText` is a key, not prose, and an editor compares it
 * ordinally. Equal keys compare equal — two elements can share a selector and so share
 * a key, and a comparator that claims both `a > b` and `b > a` for the same pair is not
 * one. What a sort makes of that is undefined: today's V8 happens to leave such a pair
 * alone, which is luck rather than a guarantee.
 *
 * Exported because it is this module's answer to what order a list goes in, and a
 * caller merging these with suggestions of its own needs the same answer.
 * @param left One suggestion.
 * @param right The other.
 */
export function byCompletionOrder(left: CompletionSuggestion, right: CompletionSuggestion): number {
  if (left.sortText === right.sortText) {
    return 0;
  }
  return left.sortText < right.sortText ? -1 : 1;
}

/**
 * Encodes relevance as the sort key an editor orders the list by.
 *
 * One scale for everything in the list. Indexed elements and the built-in Angular ones
 * are ranked by the same numbers and land in the same list, but used to be encoded from
 * different bases — so an indexed element at relevance 4 and a built-in at 3 produced
 * the identical key and were ordered by nothing at all.
 *
 * Zero-padded decimal rather than arithmetic on character codes: the digits sort the
 * same under every comparison, which is what makes the order the editor shows and the
 * order this module reasons about the same order.
 * @param relevance Higher is better.
 * @param insertText Breaks ties alphabetically.
 * @internal
 */
function relevanceSortText(relevance: number, insertText: string): string {
  return `${String(SORT_TEXT_CEILING - relevance).padStart(4, "0")}${insertText}`;
}

/**
 * Drops suggestions that would import the very same element and orders the rest.
 * @internal
 */
function deduplicateAndSort(suggestions: CompletionSuggestion[]): CompletionSuggestion[] {
  const deduped = new Map<string, CompletionSuggestion>();

  for (const suggestion of suggestions) {
    const key = JSON.stringify(suggestion.element);
    if (!deduped.has(key)) {
      deduped.set(key, suggestion);
    }
  }

  return Array.from(deduped.values()).sort(byCompletionOrder);
}

/**
 * Checks a candidate against the typed filter, case-insensitively.
 * @internal
 */
function startsWithFilter(candidate: string, context: CompletionContextData): boolean {
  return candidate.toLowerCase().startsWith(context.filterText.toLowerCase());
}

/**
 * Converts a dashed selector or attribute name into the class name it would have.
 * @internal
 */
function toPascalCase(dashed: string): string {
  return dashed
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
