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
}

/** A CSS selector as the Angular compiler models it. */
interface CssSelectorLike {
  setElement(name: string): void;
  addAttribute(name: string, value: string): void;
  toString(): string;
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
 */
export function findMissingImports(
  elements: ScannedTemplateElement[],
  severity: CoreDiagnosticSeverity,
  context: MissingImportContext
): MissingImportDiagnostic[] {
  const diagnostics: MissingImportDiagnostic[] = [];

  for (const element of elements) {
    diagnostics.push(...checkElement(element, severity, context));
  }

  return diagnostics;
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

    if (
      candidate.type !== "pipe" &&
      !candidateNameMatchesSelector(element.name, candidate.name) &&
      hasImportedAlternativeMatch(element, candidate, context)
    ) {
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
      : createMissingImportDiagnostic(element, candidate, element.name, severity);
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
    : createMissingImportDiagnostic(element, candidate, specificSelector, severity);
}

/**
 * Suppresses false positives when one template token matches multiple Angular elements
 * but at least one of those matches is already imported.
 * @internal
 */
function hasImportedAlternativeMatch(
  element: ScannedTemplateElement,
  candidate: AngularElementData,
  context: MissingImportContext
): boolean {
  for (const alternative of context.findCandidates(element.name)) {
    if (alternative.type === "pipe" || isSameElement(alternative, candidate)) {
      continue;
    }

    if (!candidateNameMatchesSelector(element.name, alternative.name)) {
      continue;
    }

    if (getMatchedSelectors(element, alternative, context).length === 0) {
      continue;
    }

    if (context.isImported(alternative)) {
      return true;
    }
  }

  return false;
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
  severity: CoreDiagnosticSeverity
): MissingImportDiagnostic {
  return {
    range: element.range,
    message: `'${element.name}' is part of a known ${candidate.type}, but it is not imported.`,
    code: `missing-${candidate.type}-import:${specificSelector}`,
    source: DIAGNOSTIC_SOURCE,
    severity,
  };
}

/**
 * Checks whether a class name looks like it belongs to a selector, ignoring
 * casing, separators, and the usual `Component`/`Directive`/`Pipe` suffixes.
 * @internal
 */
function candidateNameMatchesSelector(selectorName: string, candidateName: string): boolean {
  const normalizedSelector = normalizeSelectorForNameMatch(selectorName);
  const normalizedCandidate = normalizeCandidateName(candidateName);

  if (!normalizedSelector || !normalizedCandidate) {
    return false;
  }

  return normalizedCandidate.startsWith(normalizedSelector);
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
