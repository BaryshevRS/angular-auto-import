/**
 *
 * Utilities for working with Angular elements and selectors.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ClassDeclaration, Decorator } from "ts-morph";
import { SyntaxKind } from "ts-morph";
import { STANDARD_ANGULAR_ELEMENTS } from "../config/angular-elements";
import type { ElementLookup } from "../core/element-lookup";
import { sharedLogger } from "../core/logging";
import type { AngularIndexer } from "../services";
import { AngularElementData } from "../types";

/**
 * Converts a string from kebab-case or camelCase to PascalCase.
 * @param str The input string.
 * @returns The PascalCase string.
 * @internal
 */
function toPascalCase(str: string): string {
  if (!str) {
    return "";
  }
  // Sanitize selector from brackets or asterisks before converting
  const cleanSelector = str.replace(/[[\]*]/g, "");
  if (cleanSelector.includes("-")) {
    // Handle kebab-case
    return cleanSelector
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("");
  }
  // Handle camelCase
  return cleanSelector.charAt(0).toUpperCase() + cleanSelector.slice(1);
}

/**
 * Checks if an Angular component, directive, or pipe class is standalone.
 * Applies Angular v19+ default: if `standalone` flag is omitted, treats as standalone for Angular >= 19,
 * and as non-standalone for Angular < 19.
 * @param classDeclaration The ts-morph ClassDeclaration to check.
 * @returns `true` if the class is standalone, `false` otherwise.
 */
export function isStandalone(classDeclaration: ClassDeclaration): boolean {
  // 1) Explicit flag in decorator wins
  const explicitStandalone = getExplicitStandaloneFlag(classDeclaration);
  if (explicitStandalone !== undefined) {
    return explicitStandalone;
  }

  // 2) No explicit flag found - apply version-based defaults
  return getVersionBasedStandaloneDefault(classDeclaration);
}

/**
 * Gets the explicit standalone flag from Angular decorator.
 */
function getExplicitStandaloneFlag(classDeclaration: ClassDeclaration): boolean | undefined {
  for (const decorator of classDeclaration.getDecorators()) {
    const decoratorName = decorator.getName();
    if (decoratorName === "Component" || decoratorName === "Directive" || decoratorName === "Pipe") {
      const standaloneValue = extractStandaloneFlagFromDecorator(decorator, classDeclaration);
      if (standaloneValue !== undefined) {
        return standaloneValue;
      }
    }
  }
  return undefined;
}

/**
 * Extracts standalone flag from a single decorator.
 */
function extractStandaloneFlagFromDecorator(
  decorator: Decorator,
  classDeclaration: ClassDeclaration
): boolean | undefined {
  try {
    const args = decorator.getArguments();
    if (args.length === 0 || !args[0].isKind(SyntaxKind.ObjectLiteralExpression)) {
      return undefined;
    }

    const objectLiteral = args[0].asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const standaloneProperty = objectLiteral.getProperty("standalone");

    if (!standaloneProperty?.isKind(SyntaxKind.PropertyAssignment)) {
      return undefined;
    }

    const initializer = standaloneProperty.getInitializer();
    if (initializer?.isKind(SyntaxKind.TrueKeyword)) {
      return true;
    }
    if (initializer?.isKind(SyntaxKind.FalseKeyword)) {
      return false;
    }

    return undefined;
  } catch (error) {
    sharedLogger().error(
      `Error checking standalone flag for ${classDeclaration.getName() ?? "unknown class"}:`,
      error as Error
    );
    return undefined;
  }
}

/**
 * Gets version-based standalone default value.
 */
function getVersionBasedStandaloneDefault(classDeclaration: ClassDeclaration): boolean {
  try {
    const filePath = classDeclaration.getSourceFile().getFilePath();
    const major = readAngularCoreMajorFromFilePath(filePath);
    if (typeof major === "number") {
      // Angular >= 19: standalone by default
      return major >= 19;
    }
  } catch (_err) {
    // noop (fallback below)
  }

  // Fallback: non-standalone if version cannot be determined
  return false;
}

/**
 * Parses a complex Angular selector and returns an array of individual selectors.
 * This function uses the Angular compiler's `CssSelector.parse` for reliable parsing.
 *
 * @param selectorString The complex selector string to parse.
 * @returns A promise that resolves to an array of individual selectors.
 * @example
 * ```typescript
 * const selectors = await parseAngularSelector('my-component[some-attribute], .another-class');
 * console.log(selectors); // ['my-component[some-attribute]', '.another-class']
 * ```
 */
export async function parseAngularSelector(selectorString: string): Promise<string[]> {
  if (!selectorString) {
    return [];
  }

  // Parsing selector

  // We are now confident in the primary async parser.
  return parseAngularSelectorSync(selectorString);
}

/**
 * Synchronous part of the selector parsing logic.
 * @param selectorString The selector string to parse.
 * @returns A promise that resolves to an array of selectors.
 * @internal
 */
async function parseAngularSelectorSync(selectorString: string): Promise<string[]> {
  // Using dynamic import() which works better with ES modules
  const compiler = await import("@angular/compiler");
  const { CssSelector } = compiler;

  // Using CssSelector.parse for reliable selector parsing
  const cssSelectors = CssSelector.parse(selectorString);
  const parsedSelectors: string[] = [];

  for (const cssSelector of cssSelectors) {
    processCssSelector(cssSelector as unknown as CssSelectorForParsing, parsedSelectors);
  }

  const uniqueSelectors = [...new Set(parsedSelectors.filter((s) => s && s.length > 0))];
  // Final unique selectors processed

  return uniqueSelectors;
}

/**
 * Defines an interface for the CssSelector object for type safety.
 * @internal
 */
interface CssSelectorForParsing {
  element: string | null;
  classNames: string[];
  attrs: string[];
  notSelectors: CssSelectorForParsing[];
  toString(): string;
}

/**
 * Recursively processes a CssSelector and its notSelectors.
 * @param cssSelector The CSS selector to process.
 * @param collection The array to store the processed selectors.
 * @internal
 */
function processCssSelector(cssSelector: CssSelectorForParsing, collection: string[]): void {
  // Add the full original selector
  const fullSelector = cssSelector.toString();
  if (fullSelector) {
    collection.push(fullSelector);
  }

  // Add the base tag only if there are no required attributes.
  // This prevents indexing input[tuiInputPin] under the key "input"
  if (cssSelector.element) {
    const hasRequiredAttributes = cssSelector.attrs.length > 0;
    if (!hasRequiredAttributes) {
      collection.push(cssSelector.element);
    }
  }

  // Add attribute selectors with and without square brackets
  for (let i = 0; i < cssSelector.attrs.length; i += 2) {
    const attrName = cssSelector.attrs[i];
    if (attrName) {
      collection.push(attrName); // e.g., 'tuiTabs'
      collection.push(`[${attrName}]`); // e.g., '[tuiTabs]'
    }
  }

  // For selectors with :not(), also add a version without :not()
  if (fullSelector?.includes(":not")) {
    const simplified = fullSelector.replace(/:not\([^)]+\)/g, "").trim();
    if (simplified && simplified !== fullSelector) {
      collection.push(simplified);
    }
  }
}

/**
 * Retrieves Angular elements that match a given selector.
 *
 * @param selector The selector to search for.
 * @param indexer An instance of the AngularIndexer to search for elements.
 * @returns An array of `AngularElementData` that match the selector.
 */
export function getAngularElements(selector: string, indexer: ElementLookup): AngularElementData[] {
  // Basic validation
  if (!selector || typeof selector !== "string" || !indexer) {
    return [];
  }

  const originalSelector = selector.trim();
  if (!originalSelector) {
    return [];
  }

  // Generate selector variants
  const uniqueSelectors = generateSelectorVariants(originalSelector);

  // Find elements for all selectors
  return findElementsForSelectors(uniqueSelectors, indexer);
}

function generateSelectorVariants(originalSelector: string): string[] {
  const selectorsToTry: string[] = [originalSelector];

  // Generate base form and variants
  const base = extractBaseSelector(originalSelector);
  selectorsToTry.push(base, `*${base}`, `[${base}]`);

  // Special handling for ngFor <-> ngForOf mapping
  addNgForVariants(base, selectorsToTry);

  return [...new Set(selectorsToTry)];
}

function extractBaseSelector(selector: string): string {
  let base = selector;

  if (base.startsWith("*")) {
    base = base.slice(1);
  } else if (base.startsWith("[") && base.endsWith("]")) {
    base = base.slice(1, -1);
  } else {
    // Handle complex selectors like "button[tuiButton]", "a[routerLink]", etc.
    const complexMatch = base.match(/^[a-zA-Z-]+\[([^\]]+)\]$/);
    if (complexMatch) {
      base = complexMatch[1]; // Extract the attribute name
    }
  }

  return base;
}

function addNgForVariants(base: string, selectorsToTry: string[]): void {
  if (base === "ngFor" || base === "ngForOf") {
    selectorsToTry.push("ngForOf", "[ngForOf]");
  }
}

function findElementsForSelectors(uniqueSelectors: string[], indexer: ElementLookup): AngularElementData[] {
  const foundElements: AngularElementData[] = [];
  const seenElements = new Set<string>(); // path:name to avoid duplicates

  for (const sel of uniqueSelectors) {
    // 1. Standard Angular elements first
    const standardElement = findStandardElement(sel, seenElements);
    if (standardElement) {
      foundElements.push(standardElement);
      continue; // Skip indexed elements for this selector since standard takes precedence
    }

    // 2. Then try project index
    const indexedElements = findIndexedElements(sel, indexer, seenElements);
    foundElements.push(...indexedElements);
  }

  return foundElements;
}

function findStandardElement(selector: string, seenElements: Set<string>): AngularElementData | null {
  const std = STANDARD_ANGULAR_ELEMENTS[selector];
  if (!std) {
    return null;
  }

  const key = `${std.importPath}:${std.name}`;
  if (seenElements.has(key)) {
    return null;
  }

  const element = new AngularElementData({
    path: std.importPath ?? "",
    name: std.name,
    type: std.type,
    originalSelector: std.originalSelector,
    selectors: std.selectors,
    isStandalone: !std.name.endsWith("Module"), // Heuristic for standard elements
    isExternal: true, // isExternal - standard Angular elements are always external
  });
  seenElements.add(key);
  return element;
}

function findIndexedElements(
  selector: string,
  indexer: ElementLookup,
  seenElements: Set<string>
): AngularElementData[] {
  try {
    const foundInIndex = indexer.getElements(selector);
    const uniqueElements: AngularElementData[] = [];

    for (const element of foundInIndex) {
      const key = `${element.path}:${element.name}`;
      if (!seenElements.has(key)) {
        uniqueElements.push(element);
        seenElements.add(key);
      }
    }

    return uniqueElements;
  } catch (error) {
    sharedLogger().warn(`Error getting element from indexer for selector '${selector}': ${(error as Error).message}`);
    return [];
  }
}

/**
 * Asynchronously gets the best matching Angular element for a given selector.
 * This function uses the Angular `SelectorMatcher` for precise matching.
 *
 * @param selector The selector to find the best match for.
 * @param indexer An instance of the AngularIndexer to search for elements.
 * @returns A promise that resolves to the best matching `AngularElementData` or `undefined` if no match is found.
 */
export async function getAngularElementAsync(
  selector: string,
  indexer: AngularIndexer
): Promise<AngularElementData | undefined> {
  const elements = getAngularElements(selector, indexer);

  if (elements.length === 0) {
    return undefined;
  }

  if (elements.length === 1) {
    return elements[0];
  }

  // Uses Angular SelectorMatcher for precise matching
  return (await getMatchesUsingAngularMatcher(selector, elements))[0];
}

/**
 * Score element type priority (lower is better)
 */
function getElementTypeScore(el: AngularElementData): number {
  switch (el.type) {
    case "component":
      return 0;
    case "directive":
      return 1;
    case "pipe":
      return 2;
    default:
      return 3;
  }
}

/**
 * Compare PascalCase name matching (lower is better match)
 */
function comparePascalCaseMatch(a: AngularElementData, b: AngularElementData, selector: string): number {
  const pascalCaseSelector = toPascalCase(selector);
  if (!pascalCaseSelector) {
    return 0;
  }

  const aIsNameMatch = a.name === pascalCaseSelector;
  const bIsNameMatch = b.name === pascalCaseSelector;

  if (aIsNameMatch && !bIsNameMatch) {
    return -1;
  }
  if (!aIsNameMatch && bIsNameMatch) {
    return 1;
  }
  return 0;
}

/**
 * Comparator function for sorting Angular elements by priority
 * @param selector - The selector to match against (for PascalCase matching)
 * @returns A comparator function for use with Array.sort
 */
export function createElementComparator(selector?: string): (a: AngularElementData, b: AngularElementData) => number {
  return (a, b) => {
    // 1. Heuristic: Prefer class name that matches PascalCase selector
    if (selector) {
      const nameMatchDiff = comparePascalCaseMatch(a, b, selector);
      if (nameMatchDiff !== 0) {
        return nameMatchDiff;
      }
    }

    // 2. Sort by type priority
    const typeDiff = getElementTypeScore(a) - getElementTypeScore(b);
    if (typeDiff !== 0) {
      return typeDiff;
    }

    // 3. Prefer less complex (shorter) original selectors
    const lenDiff = a.originalSelector.length - b.originalSelector.length;
    if (lenDiff !== 0) {
      return lenDiff;
    }

    // 4. Alphabetical by name
    return a.name.localeCompare(b.name);
  };
}

/**
 * Orders elements already known to match, most specific first.
 *
 * Not the same question as `getAngularElementAsync`, which also decides *whether* each
 * candidate matches — and can only do that against the selector it is given. A
 * diagnostic's elements were matched against the template node itself, tag, attributes
 * and values included, while its code carries just the one selector one of them matched
 * under: re-running the matcher against that string drops `button[foo]` from a `[foo]`
 * token, and `[foo=check]`, and everything else that demands more than the token names.
 * @param selector The selector as the template writes it, used only to rank.
 * @param elements The elements to order.
 */
export function orderElementsForSelector(selector: string, elements: AngularElementData[]): AngularElementData[] {
  return [...elements].sort(createElementComparator(selector));
}

async function getMatchesUsingAngularMatcher(
  selector: string,
  candidates: AngularElementData[]
): Promise<AngularElementData[]> {
  try {
    const { CssSelector, SelectorMatcher } = await import("@angular/compiler");

    // Parse the incoming selector using Angular compiler
    const templateCssSelectors = CssSelector.parse(selector);
    if (templateCssSelectors.length === 0) {
      sharedLogger().warn(`Could not parse selector: "${selector}"`);
      return candidates.slice(0, 1);
    }

    // Use the first parsed selector as the template selector
    const templateCssSelector = templateCssSelectors[0];
    const bestMatches: AngularElementData[] = [];

    for (const candidate of candidates) {
      // Skip pipes, they are matched by name directly
      if (candidate.type === "pipe") {
        if (candidate.originalSelector.toLowerCase() === selector.toLowerCase()) {
          bestMatches.push(candidate);
        }
        continue;
      }

      // Create a SelectorMatcher for this candidate
      const matcher = new SelectorMatcher();
      const individualSelectors = CssSelector.parse(candidate.originalSelector);

      // Add each individual selector to the matcher
      // This is crucial for complex selectors like "a[tuiButton],button[tuiButton]"
      matcher.addSelectables(individualSelectors);

      const matchedSelectors: string[] = [];

      // Check if the template selector matches any of the candidate's selectors
      matcher.match(templateCssSelector, (matchedSelector) => {
        matchedSelectors.push(matchedSelector.toString());
      });

      if (matchedSelectors.length > 0) {
        bestMatches.push(candidate);
      }
    }

    if (bestMatches.length === 0) {
      return [];
    }

    // Sort by type, selector specificity, and name to find the best match
    bestMatches.sort(createElementComparator(selector));

    return bestMatches;
  } catch (error) {
    sharedLogger().error("Error using Angular SelectorMatcher:", error as Error);
    return candidates.slice(0, 1);
  }
}

function readAngularCoreMajorFromFilePath(filePath: string): number | null {
  try {
    return walkUpDirectoryTree(path.dirname(filePath));
  } catch {
    return null;
  }
}

/**
 * Walks up the directory tree to find Angular core version.
 */
function walkUpDirectoryTree(startDir: string): number | null {
  let currentDir: string | null = startDir;
  const visited = new Set<string>();

  while (currentDir && !visited.has(currentDir)) {
    visited.add(currentDir);

    const version = findAngularVersionInDirectory(currentDir);
    if (version !== null) {
      return version;
    }

    currentDir = getParentDirectory(currentDir);
  }

  return null;
}

/**
 * Finds Angular version in a specific directory.
 */
function findAngularVersionInDirectory(dir: string): number | null {
  // First check node_modules/@angular/core/package.json
  const coreVersion = readAngularCorePackageVersion(dir);
  if (coreVersion !== null) {
    return coreVersion;
  }

  // Then check local package.json dependencies
  return readAngularVersionFromPackageJson(dir);
}

/**
 * Reads Angular core version from node_modules.
 */
function readAngularCorePackageVersion(dir: string): number | null {
  const corePkgPath = path.join(dir, "node_modules", "@angular", "core", "package.json");
  if (!fs.existsSync(corePkgPath)) {
    return null;
  }

  try {
    const json = JSON.parse(fs.readFileSync(corePkgPath, "utf-8")) as { version?: string };
    return parseSemverMajor(json.version ?? "");
  } catch {
    return null;
  }
}

/**
 * Reads Angular version from package.json dependencies.
 */
function readAngularVersionFromPackageJson(dir: string): number | null {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return null;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const ver = pkg.dependencies?.["@angular/core"] || pkg.devDependencies?.["@angular/core"] || "";
    return parseSemverMajor(ver);
  } catch {
    return null;
  }
}

/**
 * Gets the parent directory, or null if at root.
 */
function getParentDirectory(currentDir: string): string | null {
  const parent = path.dirname(currentDir);
  return parent && parent !== currentDir ? parent : null;
}

function parseSemverMajor(version: string): number | null {
  // Examples: ^19.0.0, ~19.1.2, 19.2.3, 19, ">=19.0.0", "19.0.0-next.0"
  if (!version) {
    return null;
  }
  const match = version.match(/(\d{1,3})/);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}
