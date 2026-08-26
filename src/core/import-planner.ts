/**
 * Plans the edits that make Angular elements importable in a component file.
 *
 * Planning is separate from applying: this module takes the file's current text and
 * the elements the user wants, and returns the resulting edits plus the version the
 * plan was computed from. Nothing is written, saved, or published here, so the same
 * plan serves an editor's workspace edit and a language server's `applyEdit`.
 * @module
 */

import type {
  ArrayLiteralExpression,
  Decorator,
  ImportDeclaration,
  Node,
  ObjectLiteralExpression,
  Project,
  PropertyAssignment,
  SourceFile,
} from "ts-morph";
import { SyntaxKind } from "ts-morph";
import type { AngularElementData } from "../types";
import { type CoreLogger, silentLogger } from "./logging";
import { syncSourceFile } from "./source-file-sync";
import type { TextEdit } from "./text-edits";
import { diffToEdits } from "./text-edits";

/** Import statements longer than this are rewritten across several lines. */
const MULTI_LINE_IMPORT_THRESHOLD = 120;

/** The subset of Prettier's style that affects edits produced by the import planner. */
export interface ImportFormattingOptions {
  printWidth: number;
  tabWidth: number;
  useTabs: boolean;
  /** Absent when no formatter config exists, so existing quotes remain untouched. */
  singleQuote?: boolean;
}

/** The planner's historical output, used when a project has no formatting config. */
export const DEFAULT_IMPORT_FORMATTING: ImportFormattingOptions = {
  printWidth: MULTI_LINE_IMPORT_THRESHOLD,
  tabWidth: 2,
  useTabs: false,
};

/** A replacement the caller applies to the planned file. */
export type PlannedEdit = TextEdit;

/** The edits that add the requested imports, tied to the text they were computed from. */
export interface ImportPlan {
  filePath: string;
  /** Version of the document the plan was computed from; stale plans must not be applied. */
  version: number;
  /** Non-overlapping and in document order; empty when every element is already importable. */
  edits: PlannedEdit[];
  /** Identifiers added to the component's `imports: [...]`. */
  addedImports: string[];
}

export interface ImportPlanRequest {
  /** Absolute path of the component file. */
  filePath: string;
  /** The file's current text, which the plan is computed against. */
  text: string;
  /** Version of the document that text came from. */
  version: number;
  /** The elements the template needs. */
  elements: AngularElementData[];
  /** ts-morph project used to parse and rewrite the file. */
  project: Project;
  /** Resolves the module specifier an element should be imported from. */
  resolveImportPath(element: AngularElementData): Promise<string>;
  /** Formatting resolved for this component file. */
  formatting?: ImportFormattingOptions;
  logger?: CoreLogger;
}

/**
 * Computes the edits that make every requested element importable.
 * @param request The file to plan for and the elements it needs.
 * @returns A plan whose `edits` are empty when nothing needs to change.
 */
export async function planImports(request: ImportPlanRequest): Promise<ImportPlan> {
  const logger = request.logger ?? silentLogger;
  const formatting = request.formatting ?? DEFAULT_IMPORT_FORMATTING;
  const sourceFile = openSourceFile(request);
  const addedImports: string[] = [];
  const changedImportDeclarations = new Set<ImportDeclaration>();
  const changedComponentImports = new Set<PropertyAssignment>();
  let modified = false;

  for (const element of request.elements) {
    const importPath = await request.resolveImportPath(element);
    logger.debug(`[ImportPlanner] Final import path for ${element.type} '${element.name}': '${importPath}'`);

    const changedImport = addImportStatementForElement(sourceFile, element, importPath);
    if (changedImport) {
      changedImportDeclarations.add(changedImport);
    }
    const annotationName = element.exportingModuleName || element.name;
    const changedComponentImport = addImportToAnnotation(annotationName, sourceFile, logger);

    if (changedComponentImport) {
      changedComponentImports.add(changedComponentImport);
      addedImports.push(annotationName);
    }
    modified = modified || changedImport !== undefined || changedComponentImport !== undefined;
  }

  // Format the declarations the plan changed after all elements are added.
  if (modified) {
    formatChangedImports(changedImportDeclarations, formatting);
    formatChangedComponentImports(changedComponentImports, formatting);
  }

  const newText = sourceFile.getFullText();
  if (newText === request.text) {
    return { filePath: request.filePath, version: request.version, edits: [], addedImports };
  }

  return {
    filePath: request.filePath,
    version: request.version,
    // The smallest set of replacements that produce the rewrite, not the rewrite
    // itself: see `core/text-edits` for why a whole-file replacement is not usable.
    edits: diffToEdits(request.text, newText),
    addedImports,
  };
}

/**
 * Loads the file into the project at the text the plan is computed from.
 * @internal
 */
function openSourceFile(request: ImportPlanRequest): SourceFile {
  return syncSourceFile(request.project, request.filePath, request.text);
}

/**
 * Adds the `import { X } from "..."` statement for an element, if it is missing.
 * @internal
 */
function addImportStatementForElement(
  sourceFile: SourceFile,
  element: AngularElementData,
  importPathString: string
): ImportDeclaration | undefined {
  const importDeclaration = sourceFile.getImportDeclaration(
    (d) =>
      d.getModuleSpecifierValue() === importPathString &&
      d.getNamedImports().some((ni) => ni.getName() === element.name)
  );

  if (importDeclaration) {
    return undefined; // Already imported
  }

  const existingImportFromSameModule = sourceFile.getImportDeclaration(
    (d) => d.getModuleSpecifierValue() === importPathString
  );

  if (existingImportFromSameModule) {
    const alreadyImported = existingImportFromSameModule.getNamedImports().some((ni) => ni.getName() === element.name);
    if (!alreadyImported) {
      existingImportFromSameModule.addNamedImport(element.name);
      return existingImportFromSameModule;
    }
    return undefined;
  }

  const existingImportWithName = sourceFile
    .getImportDeclarations()
    .find((d) => d.getNamedImports().some((ni) => ni.getName() === element.name));

  if (!existingImportWithName) {
    return sourceFile.addImportDeclaration({
      namedImports: [{ name: element.name }],
      moduleSpecifier: importPathString,
    });
  }

  return undefined;
}

/**
 * Adds an import to the `imports` array of a `@Component` decorator.
 * @internal
 */
function addImportToAnnotation(
  importName: string,
  sourceFile: SourceFile,
  logger: CoreLogger
): PropertyAssignment | undefined {
  for (const classDeclaration of sourceFile.getClasses()) {
    const componentDecorator = classDeclaration.getDecorator("Component");
    if (componentDecorator) {
      return addImportToComponentDecorator(componentDecorator, importName, sourceFile, logger);
    }
  }
  return undefined;
}

/**
 * Adds import to Component decorator's imports array.
 * @internal
 */
function addImportToComponentDecorator(
  componentDecorator: Decorator,
  importName: string,
  sourceFile: SourceFile,
  logger: CoreLogger
): PropertyAssignment | undefined {
  const decoratorArgs = componentDecorator.getArguments();
  if (decoratorArgs.length === 0 || !decoratorArgs[0].isKind(SyntaxKind.ObjectLiteralExpression)) {
    return undefined;
  }

  const objectLiteral = decoratorArgs[0] as ObjectLiteralExpression;
  const importsProperty = objectLiteral.getProperty("imports") as PropertyAssignment | undefined;

  if (importsProperty) {
    return addToExistingImportsArray(importsProperty, importName, sourceFile, logger);
  }

  return objectLiteral.addPropertyAssignment({ name: "imports", initializer: `[${importName}]` });
}

/**
 * Adds import to existing imports array.
 * @internal
 */
function addToExistingImportsArray(
  importsProperty: PropertyAssignment,
  importName: string,
  sourceFile: SourceFile,
  logger: CoreLogger
): PropertyAssignment | undefined {
  const initializer = importsProperty.getInitializer();
  if (!initializer?.isKind(SyntaxKind.ArrayLiteralExpression)) {
    logger.warn(
      `@Component 'imports' property in ${sourceFile.getBaseName()} is not an array. Manual update needed for ${importName}.`
    );
    return undefined;
  }

  const importsArray = initializer as ArrayLiteralExpression;
  const existingImportNames = importsArray.getElements().map((el: Node) => el.getText().trim());

  if (existingImportNames.includes(importName)) {
    return undefined; // Already in imports array
  }

  importsArray.addElement(importName);
  return importsProperty;
}

/** Wraps a changed `@Component imports` array without formatting the rest of the decorator. @internal */
function formatChangedComponentImports(
  importsProperties: ReadonlySet<PropertyAssignment>,
  formatting: ImportFormattingOptions
): void {
  const indentation = formatting.useTabs ? "\t" : " ".repeat(formatting.tabWidth);

  for (const importsProperty of importsProperties) {
    formatChangedComponentImport(importsProperty, formatting.printWidth, indentation);
  }
}

/** Formats one changed `imports` property when it no longer fits on its line. @internal */
function formatChangedComponentImport(
  importsProperty: PropertyAssignment,
  printWidth: number,
  indentation: string
): void {
  const importsArray = importsProperty.getInitializerIfKind(SyntaxKind.ArrayLiteralExpression);
  if (!importsArray) {
    return;
  }

  const sourceFile = importsProperty.getSourceFile();
  const sourceText = sourceFile.getFullText();
  const lineStart = importsProperty.getStartLinePos();
  const lineEnd = sourceText.indexOf("\n", importsProperty.getEnd());
  const lineText = sourceText.slice(lineStart, lineEnd < 0 ? sourceText.length : lineEnd).replace(/\r$/, "");
  if (!importsArray.getText().includes("\n") && lineText.length <= printWidth) {
    return;
  }

  const arrayText = importsArray.getText();
  if (arrayText.includes("//") || arrayText.includes("/*")) {
    return;
  }

  const objectLiteral = importsProperty.getParentIfKind(SyntaxKind.ObjectLiteralExpression);
  if (!objectLiteral) {
    return;
  }

  const objectLineStart = objectLiteral.getStartLinePos();
  const objectLinePrefix = sourceText.slice(objectLineStart, objectLiteral.getStart());
  const baseIndentation = objectLinePrefix.match(/^[\t ]*/)?.[0] ?? "";
  const propertyIndentation = `${baseIndentation}${indentation}`;
  const elementIndentation = `${propertyIndentation}${indentation}`;
  const elements = importsArray.getElements().map((element) => element.getText());
  const trailingComma = /,\s*]$/.test(arrayText) ? "," : "";
  const formattedArray = `[\n${elementIndentation}${elements.join(`,\n${elementIndentation}`)}${trailingComma}\n${propertyIndentation}]`;

  const propertyPrefix = sourceText.slice(lineStart, importsProperty.getStart());
  if (/^[\t ]*$/.test(propertyPrefix)) {
    const propertyTextBeforeArray = sourceText.slice(importsProperty.getStart(), importsArray.getStart());
    sourceFile.replaceText(
      [lineStart, importsArray.getEnd()],
      `${propertyIndentation}${propertyTextBeforeArray}${formattedArray}`
    );
    return;
  }

  importsArray.replaceWithText(formattedArray);
}

/**
 * Wraps import statements that grew past the line-length threshold.
 * @internal
 */
function formatChangedImports(
  importDeclarations: ReadonlySet<ImportDeclaration>,
  formatting: ImportFormattingOptions
): void {
  for (const importDeclaration of importDeclarations) {
    const singleQuote = formatting.singleQuote ?? importDeclaration.getModuleSpecifier().getText().startsWith("'");
    if (formatting.singleQuote !== undefined) {
      const moduleSpecifier = importDeclaration.getModuleSpecifierValue();
      importDeclaration.getModuleSpecifier().replaceWithText(quoteModuleSpecifier(moduleSpecifier, singleQuote));
    }

    if (importDeclaration.getText().length <= formatting.printWidth) {
      continue;
    }

    const namedImports = importDeclaration.getNamedImports();
    if (namedImports.length === 0) {
      continue;
    }

    const moduleSpecifier = importDeclaration.getModuleSpecifierValue();
    const indentation = formatting.useTabs ? "\t" : " ".repeat(formatting.tabWidth);
    const formattedImports = namedImports.map((namedImport) => namedImport.getText()).join(`,\n${indentation}`);
    const quotedModule = quoteModuleSpecifier(moduleSpecifier, singleQuote);
    importDeclaration.replaceWithText(`import {\n${indentation}${formattedImports}\n} from ${quotedModule};`);
  }
}

/** Quotes a module specifier without changing its value. @internal */
function quoteModuleSpecifier(value: string, singleQuote: boolean): string {
  const json = JSON.stringify(value);
  if (!singleQuote) {
    return json;
  }

  const content = json.slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'");
  return `'${content}'`;
}
