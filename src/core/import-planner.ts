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
  Node,
  ObjectLiteralExpression,
  Project,
  PropertyAssignment,
  SourceFile,
} from "ts-morph";
import { SyntaxKind } from "ts-morph";
import type { AngularElementData } from "../types";
import type { CoreRange } from "./language-types";
import { type CoreLogger, silentLogger } from "./logging";

/** Import statements longer than this are rewritten across several lines. */
const MULTI_LINE_IMPORT_THRESHOLD = 120;

/** A replacement the caller applies to the planned file. */
export interface PlannedEdit {
  range: CoreRange;
  newText: string;
}

/** The edits that add the requested imports, tied to the text they were computed from. */
export interface ImportPlan {
  filePath: string;
  /** Version of the document the plan was computed from; stale plans must not be applied. */
  version: number;
  /** Empty when every element is already importable. */
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
  logger?: CoreLogger;
}

/**
 * Computes the edits that make every requested element importable.
 * @param request The file to plan for and the elements it needs.
 * @returns A plan whose `edits` are empty when nothing needs to change.
 */
export async function planImports(request: ImportPlanRequest): Promise<ImportPlan> {
  const logger = request.logger ?? silentLogger;
  const sourceFile = openSourceFile(request);
  const addedImports: string[] = [];
  let modified = false;

  for (const element of request.elements) {
    const importPath = await request.resolveImportPath(element);
    logger.debug(`[ImportPlanner] Final import path for ${element.type} '${element.name}': '${importPath}'`);

    const addedStatement = addImportStatementForElement(sourceFile, element, importPath);
    const annotationName = element.exportingModuleName || element.name;
    const addedToAnnotation = addImportToAnnotation(annotationName, sourceFile, logger);

    if (addedToAnnotation) {
      addedImports.push(annotationName);
    }
    modified = modified || addedStatement || addedToAnnotation;
  }

  // Format import statements after all elements are added
  if (modified) {
    formatOversizedImports(sourceFile);
  }

  const newText = sourceFile.getFullText();
  if (newText === request.text) {
    return { filePath: request.filePath, version: request.version, edits: [], addedImports };
  }

  return {
    filePath: request.filePath,
    version: request.version,
    edits: [{ range: fullRangeOf(request.text), newText }],
    addedImports,
  };
}

/**
 * Loads the file into the project at the text the plan is computed from.
 * @internal
 */
function openSourceFile(request: ImportPlanRequest): SourceFile {
  const sourceFile = request.project.getSourceFile(request.filePath);
  if (!sourceFile) {
    return request.project.createSourceFile(request.filePath, request.text, { overwrite: true });
  }

  if (sourceFile.getFullText() !== request.text) {
    sourceFile.replaceWithText(request.text);
  }
  return sourceFile;
}

/**
 * The range covering a whole document, so a plan can replace it wholesale.
 * @internal
 */
function fullRangeOf(text: string): CoreRange {
  const lines = text.split("\n");
  return {
    start: { line: 0, character: 0 },
    end: { line: lines.length - 1, character: lines[lines.length - 1].length },
  };
}

/**
 * Adds the `import { X } from "..."` statement for an element, if it is missing.
 * @internal
 */
function addImportStatementForElement(
  sourceFile: SourceFile,
  element: AngularElementData,
  importPathString: string
): boolean {
  const importDeclaration = sourceFile.getImportDeclaration(
    (d) =>
      d.getModuleSpecifierValue() === importPathString &&
      d.getNamedImports().some((ni) => ni.getName() === element.name)
  );

  if (importDeclaration) {
    return false; // Already imported
  }

  const existingImportFromSameModule = sourceFile.getImportDeclaration(
    (d) => d.getModuleSpecifierValue() === importPathString
  );

  if (existingImportFromSameModule) {
    const alreadyImported = existingImportFromSameModule.getNamedImports().some((ni) => ni.getName() === element.name);
    if (!alreadyImported) {
      existingImportFromSameModule.addNamedImport(element.name);
      return true;
    }
    return false;
  }

  const existingImportWithName = sourceFile
    .getImportDeclarations()
    .find((d) => d.getNamedImports().some((ni) => ni.getName() === element.name));

  if (!existingImportWithName) {
    sourceFile.addImportDeclaration({
      namedImports: [{ name: element.name }],
      moduleSpecifier: importPathString,
    });
    return true;
  }

  return false;
}

/**
 * Adds an import to the `imports` array of a `@Component` decorator.
 * @internal
 */
function addImportToAnnotation(importName: string, sourceFile: SourceFile, logger: CoreLogger): boolean {
  for (const classDeclaration of sourceFile.getClasses()) {
    const componentDecorator = classDeclaration.getDecorator("Component");
    if (componentDecorator) {
      return addImportToComponentDecorator(componentDecorator, importName, sourceFile, logger);
    }
  }
  return false;
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
): boolean {
  const decoratorArgs = componentDecorator.getArguments();
  if (decoratorArgs.length === 0 || !decoratorArgs[0].isKind(SyntaxKind.ObjectLiteralExpression)) {
    return false;
  }

  const objectLiteral = decoratorArgs[0] as ObjectLiteralExpression;
  const importsProperty = objectLiteral.getProperty("imports") as PropertyAssignment | undefined;

  if (importsProperty) {
    return addToExistingImportsArray(importsProperty, importName, sourceFile, logger);
  }

  objectLiteral.addPropertyAssignment({ name: "imports", initializer: `[${importName}]` });
  return true;
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
): boolean {
  const initializer = importsProperty.getInitializer();
  if (!initializer?.isKind(SyntaxKind.ArrayLiteralExpression)) {
    logger.warn(
      `@Component 'imports' property in ${sourceFile.getBaseName()} is not an array. Manual update needed for ${importName}.`
    );
    return false;
  }

  const importsArray = initializer as ArrayLiteralExpression;
  const existingImportNames = importsArray.getElements().map((el: Node) => el.getText().trim());

  if (existingImportNames.includes(importName)) {
    return false; // Already in imports array
  }

  importsArray.addElement(importName);
  return true;
}

/**
 * Wraps import statements that grew past the line-length threshold.
 * @internal
 */
function formatOversizedImports(sourceFile: SourceFile): void {
  for (const importDeclaration of sourceFile.getImportDeclarations()) {
    if (importDeclaration.getText().length <= MULTI_LINE_IMPORT_THRESHOLD) {
      continue;
    }

    const namedImports = importDeclaration.getNamedImports();
    if (namedImports.length === 0) {
      continue;
    }

    const moduleSpecifier = importDeclaration.getModuleSpecifierValue();
    const formattedImports = namedImports.map((ni) => ni.getName()).join(",\n  ");
    importDeclaration.replaceWithText(`import {\n  ${formattedImports}\n} from "${moduleSpecifier}";`);
  }
}
