/**
 * What a compiled Angular declaration says a template may write on an element.
 *
 * `ɵɵDirectiveDeclaration` and `ɵɵComponentDeclaration` carry an element's whole public
 * surface as type arguments, in the order the compiler emits them:
 *
 * ```ts
 * ɵɵDirectiveDeclaration<T, Selector, ExportAs, InputMap, OutputMap,
 *                        QueryFields, NgContentSelectors, IsStandalone,
 *                        HostDirectives, IsSignal>
 * ```
 *
 * The indexer already reads two of them — the selector and whether the element is
 * standalone. This reads three more, and does it the same way: over the type nodes as
 * written, never through the type checker. Resolving these types would mean loading the
 * declaration files indexing deliberately releases, for an answer the emit already spells
 * out.
 *
 * What it reads is only what the class *itself* declares. Angular does not fold an
 * inherited input into a subclass's emit — `MatTable extends CdkTable` has an empty
 * `InputMap` while `CdkTable` holds `trackBy` and the rest — so an element's full surface
 * is the union along its `extends` chain, which costs a declaration file per link and is
 * a separate decision from this one.
 * @module
 */

import { type Node, SyntaxKind, type TypeNode } from "ts-morph";
import type { ElementInput, ElementOutput } from "../types";

/** Where each part of the surface sits in the declaration's type arguments. */
const INPUT_MAP = 3;
const OUTPUT_MAP = 4;
const NG_CONTENT_SELECTORS = 6;

/** The part of an element's public surface this module reads. */
export interface ElementApi {
  inputs: ElementInput[];
  outputs: ElementOutput[];
  /** The `ng-content` selectors a component projects into, in declaration order. */
  contentSelectors: string[];
}

/** Nothing declared, which is what most directives emit and what a bad read falls back to. */
export const EMPTY_ELEMENT_API: ElementApi = { inputs: [], outputs: [], contentSelectors: [] };

/**
 * Reads the surface out of one declaration's type arguments.
 * @param typeArguments The arguments of a `ɵɵDirectiveDeclaration` or `ɵɵComponentDeclaration`.
 * @returns What the declaration says; empty parts for what it does not say.
 */
export function readElementApi(typeArguments: TypeNode[]): ElementApi {
  return {
    inputs: readInputs(typeArguments[INPUT_MAP]),
    outputs: readOutputs(typeArguments[OUTPUT_MAP]),
    contentSelectors: readStringTuple(typeArguments[NG_CONTENT_SELECTORS]),
  };
}

/**
 * The inputs, whose entries come in two shapes.
 *
 * A plain `"plain": "plain"` is the old emit and says only the public name. The object
 * form carries the alias — `null` when the property name is the public one — along with
 * whether the binding is required and whether it is a signal.
 * @internal
 */
function readInputs(typeNode: TypeNode | undefined): ElementInput[] {
  const inputs: ElementInput[] = [];

  for (const { name, type } of members(typeNode)) {
    const literal = stringLiteralOf(type);
    if (literal !== undefined) {
      inputs.push({ name: literal, propertyName: propertyNameFor(name, literal), required: false, isSignal: false });
      continue;
    }

    const fields = new Map(members(type).map((member) => [member.name, member.type]));
    const alias = stringLiteralOf(fields.get("alias")) ?? name;
    inputs.push({
      name: alias,
      propertyName: propertyNameFor(name, alias),
      required: booleanOf(fields.get("required")) ?? false,
      isSignal: booleanOf(fields.get("isSignal")) ?? false,
    });
  }

  return inputs;
}

/** The outputs, whose entries are always `"property": "public name"`. @internal */
function readOutputs(typeNode: TypeNode | undefined): ElementOutput[] {
  const outputs: ElementOutput[] = [];

  for (const { name, type } of members(typeNode)) {
    const alias = stringLiteralOf(type) ?? name;
    outputs.push({ name: alias, propertyName: propertyNameFor(name, alias) });
  }

  return outputs;
}

/** Kept only when it differs, since carrying the same string twice tells a reader nothing. @internal */
function propertyNameFor(name: string, publicName: string): string | undefined {
  return name === publicName ? undefined : name;
}

/**
 * A tuple of string literals, or nothing.
 *
 * A directive emits `never` here and a component with no `ng-content` emits an empty
 * tuple, and neither is a list of selectors.
 * @internal
 */
function readStringTuple(typeNode: TypeNode | undefined): string[] {
  if (!typeNode?.isKind(SyntaxKind.TupleType)) {
    return [];
  }

  const selectors: string[] = [];
  for (const element of typeNode.getElements()) {
    const literal = stringLiteralOf(element);
    if (literal !== undefined) {
      selectors.push(literal);
    }
  }
  return selectors;
}

/**
 * The properties of a type literal, with their names unquoted.
 *
 * The compiler writes these names as string literals — `{ "trackBy": … }` — so the name
 * a `PropertySignature` reports still carries its quotes, and a name read from the node
 * is the one the emit meant.
 * @internal
 */
function members(typeNode: Node | undefined): Array<{ name: string; type: TypeNode | undefined }> {
  if (!typeNode?.isKind(SyntaxKind.TypeLiteral)) {
    return [];
  }

  const found: Array<{ name: string; type: TypeNode | undefined }> = [];
  for (const property of typeNode.getProperties()) {
    const nameNode = property.getNameNode();
    const name = nameNode.isKind(SyntaxKind.StringLiteral) ? nameNode.getLiteralText() : nameNode.getText();
    found.push({ name, type: property.getTypeNode() });
  }
  return found;
}

/** @internal */
function stringLiteralOf(typeNode: Node | undefined): string | undefined {
  if (!typeNode?.isKind(SyntaxKind.LiteralType)) {
    return undefined;
  }
  const literal = typeNode.getLiteral();
  return literal.isKind(SyntaxKind.StringLiteral) ? literal.getLiteralText() : undefined;
}

/** @internal */
function booleanOf(typeNode: Node | undefined): boolean | undefined {
  if (!typeNode?.isKind(SyntaxKind.LiteralType)) {
    return undefined;
  }
  const literal = typeNode.getLiteral();
  if (literal.isKind(SyntaxKind.TrueKeyword)) {
    return true;
  }
  return literal.isKind(SyntaxKind.FalseKeyword) ? false : undefined;
}
