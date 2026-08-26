/**
 * Bundles: the arrays a library ships instead of a class.
 *
 * `imports: [TuiComboBox]` names no directive — `TuiComboBox` is
 * `readonly [typeof TuiComboBoxDirective, typeof TuiLabel, …]`, and Angular takes it as if
 * its members had been written out. Reading one is the same question in two places, so it
 * is answered once here: the indexer records what a library's bundles hold, and the
 * component analysis reads a workspace's own the same way.
 * @module
 */

import {
  type ExportedDeclarations,
  type Identifier,
  type Node,
  SyntaxKind,
  type TypeNode,
  type VariableDeclaration,
} from "ts-morph";

/**
 * One class a bundle holds.
 *
 * The name alone does not identify it: two libraries may each ship a `SharedDirective`,
 * and a bundle holding one of them says nothing about the other. Where the class is
 * declared does identify it, and is recorded whenever the compiler can say.
 */
export interface BundleMember {
  name: string;
  /** Absolute path of the file the class is declared in, when it could be resolved. */
  absolutePath?: string;
}

/**
 * The classes a bundle declaration holds, or nothing when it is not a bundle.
 *
 * Two forms say the same thing, and both appear in the wild: the compiled
 * `readonly [typeof A, typeof B]` of a published library, and the `[A, B] as const` a
 * workspace library writes in source. Anything else — a class, a plain value — holds
 * nothing and is answered with an empty list rather than a guess.
 * @param declared The declaration the name resolves to.
 */
export function bundleMembersOf(declared: ExportedDeclarations): BundleMember[] {
  if (!declared.isKind(SyntaxKind.VariableDeclaration)) {
    return [];
  }

  const fromType = membersOfTupleType((declared as VariableDeclaration).getTypeNode());
  if (fromType.length > 0) {
    return fromType;
  }

  const initializer = (declared as VariableDeclaration).getInitializer();
  const array = initializer?.isKind(SyntaxKind.AsExpression) ? initializer.getExpression() : initializer;
  if (!array?.isKind(SyntaxKind.ArrayLiteralExpression)) {
    return [];
  }

  return array.getElements().map((entry) => ({
    name: entry.getText().trim(),
    absolutePath: entry.isKind(SyntaxKind.Identifier) ? declaringFileOf(entry) : undefined,
  }));
}

/**
 * The classes named in a `readonly [typeof A, typeof B]`, or nothing when the type is not
 * one.
 * @internal
 */
function membersOfTupleType(typeNode: TypeNode | undefined): BundleMember[] {
  const inner = typeNode?.isKind(SyntaxKind.TypeOperator) ? typeNode.getTypeNode() : typeNode;
  if (!inner?.isKind(SyntaxKind.TupleType)) {
    return [];
  }

  const members: BundleMember[] = [];
  for (const member of inner.getElements()) {
    if (!member.isKind(SyntaxKind.TypeQuery)) {
      continue;
    }

    const entity = member.getExprName();
    const named = entity.isKind(SyntaxKind.QualifiedName) ? entity.getRight() : entity;
    members.push({
      name: named.getText(),
      absolutePath: named.isKind(SyntaxKind.Identifier) ? declaringFileOf(named) : undefined,
    });
  }
  return members;
}

/**
 * The file a name is declared in, as the compiler resolves it — through the import that
 * brought it into the bundle's file, and through whatever that import re-exports.
 * @internal
 */
function declaringFileOf(named: Identifier): string | undefined {
  try {
    const declarations: Node[] = named.getDefinitionNodes();
    return declarations[0]?.getSourceFile().getFilePath();
  } catch {
    // A name the project cannot resolve identifies nothing, and the class name is all
    // there is to go on.
    return undefined;
  }
}
