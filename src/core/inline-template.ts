/**
 * The template written inside a component's decorator.
 *
 * Both hosts have to find the same thing in the same way: the `template` string of the
 * first component class in a file, and where it starts in that file, because every
 * range the analysis produces is relative to that offset.
 * @module
 */

import type {
  ClassDeclaration,
  Decorator,
  Node,
  NoSubstitutionTemplateLiteral,
  ObjectLiteralExpression,
  SourceFile,
  StringLiteral,
} from "ts-morph";
import { SyntaxKind } from "ts-morph";

/** A template and where it starts in the file that holds it. */
export interface InlineTemplate {
  text: string;
  /** Offset of the template's first character in the containing document. */
  offset: number;
}

/**
 * Finds the literal `templateUrl` of the first component that declares one.
 * @param sourceFile The component source file to inspect.
 */
export function findExternalTemplateUrl(sourceFile: SourceFile): string | null {
  for (const classDeclaration of sourceFile.getClasses()) {
    const componentDecorator = classDeclaration.getDecorator("Component");
    if (!componentDecorator) {
      continue;
    }

    const objectLiteral = decoratorMetadata(componentDecorator);
    const templateUrlProperty = objectLiteral?.getProperty("templateUrl");
    if (!templateUrlProperty?.isKind(SyntaxKind.PropertyAssignment)) {
      continue;
    }

    const initializer = templateUrlProperty.getInitializer();
    if (isLiteralTemplate(initializer)) {
      return initializer.getLiteralText();
    }
  }
  return null;
}

/**
 * Finds the first inline template in a component file.
 * @param sourceFile The file to look in.
 * @returns The template, or `null` for a file with none — including one whose template
 * lives in a separate HTML file, or is built from an interpolated string the analysis
 * cannot read statically.
 */
export function findInlineTemplate(sourceFile: SourceFile): InlineTemplate | null {
  for (const classDeclaration of sourceFile.getClasses()) {
    const template = templateOfClass(classDeclaration);
    if (template) {
      return template;
    }
  }
  return null;
}

/** @internal */
function templateOfClass(classDeclaration: ClassDeclaration): InlineTemplate | null {
  const componentDecorator = classDeclaration.getDecorator("Component");
  if (!componentDecorator) {
    return null;
  }

  const objectLiteral = decoratorMetadata(componentDecorator);
  return objectLiteral ? templateOfMetadata(objectLiteral) : null;
}

/** @internal */
function decoratorMetadata(decorator: Decorator): ObjectLiteralExpression | null {
  const [firstArgument] = decorator.getArguments();
  if (!firstArgument?.isKind(SyntaxKind.ObjectLiteralExpression)) {
    return null;
  }
  return firstArgument as ObjectLiteralExpression;
}

/** @internal */
function templateOfMetadata(objectLiteral: ObjectLiteralExpression): InlineTemplate | null {
  const templateProperty = objectLiteral.getProperty("template");
  if (!templateProperty?.isKind(SyntaxKind.PropertyAssignment)) {
    return null;
  }

  const initializer = templateProperty.getInitializer();
  if (!isLiteralTemplate(initializer)) {
    return null;
  }

  // Past the opening quote or backtick, which is where the template's own text begins.
  return { text: initializer.getLiteralText(), offset: initializer.getStart() + 1 };
}

/** @internal */
function isLiteralTemplate(
  initializer: Node | undefined
): initializer is StringLiteral | NoSubstitutionTemplateLiteral {
  return Boolean(
    initializer &&
      (initializer.isKind(SyntaxKind.StringLiteral) || initializer.isKind(SyntaxKind.NoSubstitutionTemplateLiteral))
  );
}
