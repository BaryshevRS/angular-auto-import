/**
 * Undoing a component's imports, so a fixture can be measured before they existed.
 *
 * The E2E corpus records what the extension must report for a component that is missing
 * its imports, which means every run has to put the fixture back into that state first.
 * The rewriting is pure ts-morph, so it lives apart from the editor helpers around it
 * and can be used by a plain Node harness as readily as by the Extension Host suite.
 * @module
 */

import * as path from "node:path";
import { type Decorator, Project, type SourceFile, SyntaxKind } from "ts-morph";

const inMemoryProject = new Project({ useInMemoryFileSystem: true });

/**
 * Parses content into a ts-morph SourceFile, reusing an in-memory virtual file.
 */
export function parseContent(content: string): SourceFile {
  const filePath = "/virtual/component.ts";
  const existing = inMemoryProject.getSourceFile(filePath);
  if (existing) {
    existing.replaceWithText(content);
    return existing;
  }
  return inMemoryProject.createSourceFile(filePath, content);
}

/**
 * Checks if a `@Component` decorator's `templateUrl` matches the given file name.
 */
function decoratorMatchesTemplate(decorator: Decorator, templateFileName: string): boolean {
  const args = decorator.getArguments();
  if (args.length === 0) {
    return false;
  }

  const objectLiteral = args[0].asKind(SyntaxKind.ObjectLiteralExpression);
  if (!objectLiteral) {
    return false;
  }

  const templateUrlProp = objectLiteral.getProperty("templateUrl");
  if (!templateUrlProp) {
    return false;
  }

  const initializer = templateUrlProp.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
  const templateUrlValue = initializer?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
  return templateUrlValue !== undefined && path.basename(templateUrlValue) === templateFileName;
}

/**
 * Finds the `@Component` decorator in the source file.
 * If `templateFileName` is provided, matches against `templateUrl` property.
 * Otherwise returns the first `@Component` decorator found.
 */
export function findComponentDecorator(sourceFile: SourceFile, templateFileName?: string): Decorator | undefined {
  for (const cls of sourceFile.getClasses()) {
    const decorator = cls.getDecorator("Component");
    if (!decorator) {
      continue;
    }

    if (!templateFileName) {
      return decorator;
    }

    if (decoratorMatchesTemplate(decorator, templateFileName)) {
      return decorator;
    }
  }
  return undefined;
}

/**
 * Gets the imports array elements from a `@Component` decorator.
 * Returns the property assignment and element names, or undefined if not found.
 */
export function getImportsArrayInfo(decorator: Decorator) {
  const args = decorator.getArguments();
  if (args.length === 0) {
    return undefined;
  }

  const objectLiteral = args[0].asKind(SyntaxKind.ObjectLiteralExpression);
  if (!objectLiteral) {
    return undefined;
  }

  const importsProperty = objectLiteral.getProperty("imports")?.asKind(SyntaxKind.PropertyAssignment);
  if (!importsProperty) {
    return undefined;
  }

  const arrayLiteral = importsProperty.getInitializer()?.asKind(SyntaxKind.ArrayLiteralExpression);
  if (!arrayLiteral) {
    return undefined;
  }

  const elementNames = arrayLiteral.getElements().map((el) => el.getText());
  return { importsProperty, elementNames };
}

/**
 * Gets the imports array elements from an `@NgModule` decorator.
 * Returns the property assignment and element names, or undefined if not found.
 */
function getNgModuleImportsArrayInfo(sourceFile: SourceFile) {
  for (const cls of sourceFile.getClasses()) {
    const decorator = cls.getDecorator("NgModule");
    if (!decorator) {
      continue;
    }

    const args = decorator.getArguments();
    if (args.length === 0) {
      return undefined;
    }

    const objectLiteral = args[0].asKind(SyntaxKind.ObjectLiteralExpression);
    if (!objectLiteral) {
      return undefined;
    }

    const importsProperty = objectLiteral.getProperty("imports")?.asKind(SyntaxKind.PropertyAssignment);
    if (!importsProperty) {
      return undefined;
    }

    const arrayLiteral = importsProperty.getInitializer()?.asKind(SyntaxKind.ArrayLiteralExpression);
    if (!arrayLiteral) {
      return undefined;
    }

    const elementNames = arrayLiteral.getElements().map((el) => el.getText());
    return { importsProperty, elementNames };
  }

  return undefined;
}

/**
 * Strips Angular imports from a component source file using ts-morph AST parsing.
 *
 * 1. Extracts class names from the `imports: [...]` array in `@Component`
 * 2. Removes those names from TypeScript `import { ... } from '...'` statements
 *    (removes entire statement if it becomes empty)
 * 3. Sets `imports: []` (empty array)
 * 4. Keeps non-template imports like `FormBuilder`, `Validators`, `Component`, `inject`
 *
 * @param content - The original component TypeScript source
 * @param templateFileName - Optional template file name to match against templateUrl
 * @returns The stripped content with Angular template imports removed
 */
export function stripAngularImports(content: string, templateFileName?: string): string {
  const sourceFile = parseContent(content);
  const decorator = findComponentDecorator(sourceFile, templateFileName);
  if (!decorator) {
    return content;
  }

  const info = getImportsArrayInfo(decorator);
  if (!info || info.elementNames.length === 0) {
    return content;
  }

  const namesToRemove = new Set(info.elementNames);

  // Clear the imports array
  info.importsProperty.setInitializer("[]");

  // Remove names from TypeScript import declarations
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const namedImports = importDecl.getNamedImports();
    const toRemove = namedImports.filter((ni) => namesToRemove.has(ni.getName()));

    if (toRemove.length === 0) {
      continue;
    }

    if (toRemove.length === namedImports.length) {
      // All named imports should be removed — remove entire statement
      importDecl.remove();
    } else {
      // Remove only matched named imports
      for (const ni of toRemove) {
        ni.remove();
      }
    }
  }

  return sourceFile.getFullText();
}

/**
 * Strips entries from an `@NgModule({ imports: [...] })` array and removes matching
 * TypeScript named imports. This is used by legacy-module e2e cases where diagnostics
 * must remain disabled even if module imports no longer satisfy the template.
 *
 * @param content - The original NgModule TypeScript source
 * @returns The stripped content with `imports: []`
 */
export function stripNgModuleImports(content: string): string {
  const sourceFile = parseContent(content);
  const info = getNgModuleImportsArrayInfo(sourceFile);
  if (!info || info.elementNames.length === 0) {
    return content;
  }

  const namesToRemove = new Set(info.elementNames);

  info.importsProperty.setInitializer("[]");

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const namedImports = importDecl.getNamedImports();
    const toRemove = namedImports.filter((ni) => namesToRemove.has(ni.getName()));

    if (toRemove.length === 0) {
      continue;
    }

    if (toRemove.length === namedImports.length) {
      importDecl.remove();
    } else {
      for (const ni of toRemove) {
        ni.remove();
      }
    }
  }

  return sourceFile.getFullText();
}
