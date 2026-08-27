/**
 * The same surface as `element-api`, read from a class the project writes rather than
 * from one a library ships.
 *
 * A published element arrives compiled, with its inputs and outputs normalized into type
 * arguments. A project's own element arrives as the source it was written in, where the
 * same facts are spread across four spellings: a decorator on a property, a decorator on
 * a setter, a signal function in an initializer, and an array on the class decorator.
 * They are read here so that both halves of an index answer the same questions.
 *
 * What is *not* read is anything that needs a value: an `input()` default, a
 * `transform`, an alias computed rather than written. A template does not care what a
 * default is, and a name this module cannot see is better absent than guessed.
 *
 * A signal declaration is recognized by where its function came from, not by what it is
 * spelled: a project's own `input()` helper is not Angular's, and Angular's survives
 * being imported as `ngInput` or called as `core.input`. The decorators are matched by
 * name instead, because a class already carrying `@Component` or `@Directive` and also
 * taking `@Input` from somewhere else is not a thing that happens.
 * @module
 */

import {
  type ClassDeclaration,
  type Decorator,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
  SyntaxKind,
} from "ts-morph";
import type { ElementInput, ElementOutput } from "../types";
import type { ElementApi } from "./element-api";

/**
 * The functions that declare a binding, what each declares, and where it keeps options.
 *
 * The position matters and is not guessable: `input(initialValue, opts?)` takes options
 * second, while `input.required(opts?)` takes them first, because a required input has no
 * initial value to take. Reading "the last object literal" instead makes
 * `settings = input({ theme: "dark" })` — an object *default* — look like an alias of
 * `theme`, and the input disappears from the index under a name nothing writes.
 */
const SIGNAL_DECLARATIONS = new Map<string, { kind: "input" | "output" | "model"; optionsAt: number }>([
  ["input", { kind: "input", optionsAt: 1 }],
  ["input.required", { kind: "input", optionsAt: 0 }],
  ["model", { kind: "model", optionsAt: 1 }],
  ["model.required", { kind: "model", optionsAt: 0 }],
  ["output", { kind: "output", optionsAt: 0 }],
  // `@angular/core/rxjs-interop`, which the compiler treats as an output like any other.
  ["outputFromObservable", { kind: "output", optionsAt: 1 }],
]);

/** The modules whose exports declare a binding. */
const DECLARING_MODULES = new Set(["@angular/core", "@angular/core/rxjs-interop"]);

/** What a `model()` adds beyond its input, so that a template can bind it both ways. */
const TWO_WAY_SUFFIX = "Change";

/**
 * Reads what a template may write on a class the project declares.
 * @param classDeclaration The decorated class, as written.
 * @returns Its own surface; what it extends is the caller's to merge.
 */
export function readElementApiFromSource(classDeclaration: ClassDeclaration): ElementApi {
  const inputs: ElementInput[] = [];
  const outputs: ElementOutput[] = [];

  readDecoratorArrays(classDeclaration, inputs, outputs);
  readMembers(classDeclaration, declaringImports(classDeclaration.getSourceFile()), inputs, outputs);

  return { inputs, outputs, contentSelectors: [], hostDirectives: [] };
}

/** What one file calls Angular's declaring functions. */
interface DeclaringImports {
  /** Local name to the export it stands for, so `input as ngInput` still resolves. */
  named: Map<string, string>;
  /** The namespaces a `import * as core` bound, so `core.input()` still resolves. */
  namespaces: Set<string>;
}

/**
 * Which local names in one file mean Angular's declaring functions.
 *
 * Read once per file and per class, because a class's own text says nothing about where
 * `input` came from — and that is the whole question. A file that never imports it has
 * no signal declarations, however many `input()` calls it makes.
 * @internal
 */
function declaringImports(sourceFile: SourceFile): DeclaringImports {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();

  for (const declaration of sourceFile.getImportDeclarations()) {
    if (!DECLARING_MODULES.has(declaration.getModuleSpecifierValue())) {
      continue;
    }
    for (const specifier of declaration.getNamedImports()) {
      named.set(specifier.getAliasNode()?.getText() ?? specifier.getName(), specifier.getName());
    }
    const namespace = declaration.getNamespaceImport();
    if (namespace) {
      namespaces.add(namespace.getText());
    }
  }

  return { named, namespaces };
}

/**
 * The `inputs` and `outputs` arrays on the class decorator itself.
 *
 * `@Directive({ inputs: ['size: appSize'] })` is the same declaration as `@Input('appSize')
 * size`, written where the class is configured rather than where the field is. Angular
 * reads both through `parseMappingString`, which splits on the first colon and treats
 * what follows as the name a template writes.
 * @internal
 */
function readDecoratorArrays(
  classDeclaration: ClassDeclaration,
  inputs: ElementInput[],
  outputs: ElementOutput[]
): void {
  const options = decoratorOptions(
    classDeclaration.getDecorator("Component") ?? classDeclaration.getDecorator("Directive")
  );
  if (!options) {
    return;
  }

  for (const declared of arrayElements(options, "inputs")) {
    const mapping = staticText(declared);
    if (mapping !== undefined) {
      const { name, propertyName } = splitMapping(mapping);
      inputs.push({ name, propertyName, required: false, isSignal: false });
      continue;
    }
    // The object form, which carries what a mapping string cannot say: `inputs: [{ name:
    // "id", alias: "account-id", required: true }]`.
    const declaration = asObjectLiteral(declared);
    const field = declaration ? stringProperty(declaration, "name") : undefined;
    if (declaration && field) {
      const alias = stringProperty(declaration, "alias");
      inputs.push({
        name: alias ?? field,
        propertyName: differing(field, alias),
        required: booleanProperty(declaration, "required"),
        isSignal: false,
      });
    }
  }
  // `outputs` takes strings and nothing else, which is why it is read as one.
  for (const declared of arrayElements(options, "outputs")) {
    const mapping = staticText(declared);
    if (mapping !== undefined) {
      const { name, propertyName } = splitMapping(mapping);
      outputs.push({ name, propertyName });
    }
  }
}

/**
 * The properties, setters and getters that declare a binding.
 *
 * A setter carries the decorator as readily as a property does — `@Input() set value(v)`
 * — and a signal declaration is an initializer rather than a decorator, so all three are
 * walked together.
 * @internal
 */
function readMembers(
  classDeclaration: ClassDeclaration,
  imports: DeclaringImports,
  inputs: ElementInput[],
  outputs: ElementOutput[]
): void {
  const members = [
    ...classDeclaration.getProperties(),
    ...classDeclaration.getSetAccessors(),
    ...classDeclaration.getGetAccessors(),
  ];

  for (const member of members) {
    const propertyName = member.getName();

    const input = member.getDecorator("Input");
    if (input) {
      const { alias, required } = decoratorBinding(input);
      inputs.push({
        name: alias ?? propertyName,
        propertyName: differing(propertyName, alias),
        required,
        isSignal: false,
      });
    }

    const output = member.getDecorator("Output");
    if (output) {
      const { alias } = decoratorBinding(output);
      outputs.push({ name: alias ?? propertyName, propertyName: differing(propertyName, alias) });
    }

    if (member.isKind(SyntaxKind.PropertyDeclaration)) {
      readSignalDeclaration(member.getInitializer(), propertyName, imports, inputs, outputs);
    }
  }
}

/**
 * An `input()`, `output()` or `model()` in a property's initializer.
 *
 * A `model()` is both at once: Angular gives it the input and an output named after it
 * with `Change` appended, which is what makes `[(value)]` work. The output belongs to the
 * same class property as the input — `value = model()` emits an output map of
 * `{ "value": "valueChange" }`, not a `valueChange` field that does not exist.
 * @internal
 */
function readSignalDeclaration(
  initializer: Node | undefined,
  propertyName: string,
  imports: DeclaringImports,
  inputs: ElementInput[],
  outputs: ElementOutput[]
): void {
  if (!initializer?.isKind(SyntaxKind.CallExpression)) {
    return;
  }

  const called = declaringFunction(initializer.getExpression(), imports);
  const declaration = called ? SIGNAL_DECLARATIONS.get(called) : undefined;
  if (!declaration) {
    return;
  }

  const options = asObjectLiteral(initializer.getArguments()[declaration.optionsAt]);
  const alias = options ? stringProperty(options, "alias") : undefined;
  const name = alias ?? propertyName;

  if (declaration.kind === "output") {
    outputs.push({ name, propertyName: differing(propertyName, alias) });
    return;
  }

  inputs.push({
    name,
    propertyName: differing(propertyName, alias),
    required: called?.endsWith(".required") ?? false,
    isSignal: true,
  });

  if (declaration.kind === "model") {
    const emitted = `${name}${TWO_WAY_SUFFIX}`;
    outputs.push({ name: emitted, propertyName: emitted === propertyName ? undefined : propertyName });
  }
}

/**
 * Which of Angular's declaring functions a call names, if any.
 *
 * `input`, `ngInput` where the file renamed it, `core.input` where it imported a
 * namespace, and each of those with `.required` after. A bare `input` the file never
 * imported names nothing, which is the point: a project's own helper of that name is not
 * a binding.
 * @internal
 */
function declaringFunction(expression: Node, imports: DeclaringImports): string | undefined {
  if (expression.isKind(SyntaxKind.Identifier)) {
    return imports.named.get(expression.getText());
  }

  if (!expression.isKind(SyntaxKind.PropertyAccessExpression)) {
    return undefined;
  }

  const property = expression.getName();
  const target = expression.getExpression();

  // `core.input`, where the namespace stands for the module itself.
  if (target.isKind(SyntaxKind.Identifier) && imports.namespaces.has(target.getText())) {
    return SIGNAL_DECLARATIONS.has(property) ? property : undefined;
  }

  // `input.required`, or `core.input.required` one level further out.
  if (property !== "required") {
    return undefined;
  }
  const base = declaringFunction(target, imports);
  return base ? `${base}.required` : undefined;
}

/**
 * What an `@Input(...)` or `@Output(...)` says, in either of its two forms.
 *
 * The string form is the alias alone. The object form is where `required` lives, and
 * where an alias may be absent while other options are present.
 * @internal
 */
function decoratorBinding(decorator: Decorator): { alias: string | undefined; required: boolean } {
  const [argument] = decorator.getArguments();
  if (!argument) {
    return { alias: undefined, required: false };
  }
  const written = staticText(argument);
  if (written !== undefined) {
    return { alias: written, required: false };
  }

  const options = asObjectLiteral(argument);
  return {
    alias: options ? stringProperty(options, "alias") : undefined,
    required: options ? booleanProperty(options, "required") : false,
  };
}

/**
 * `'size: appSize'`, as `parseMappingString` reads it: the field first, then the name a
 * template writes. Without a colon the two are the same.
 * @internal
 */
function splitMapping(declared: string): { name: string; propertyName: string | undefined } {
  const [field, binding] = declared.split(":", 2).map((part) => part.trim());
  return { name: binding || field, propertyName: differing(field, binding || undefined) };
}

/** @internal */
function differing(propertyName: string, alias: string | undefined): string | undefined {
  return alias === undefined || alias === propertyName ? undefined : propertyName;
}

/** @internal */
function decoratorOptions(decorator: Decorator | undefined): ObjectLiteralExpression | undefined {
  const [argument] = decorator?.getArguments() ?? [];
  return argument ? asObjectLiteral(argument) : undefined;
}

/**
 * The text of a statically written string, in either spelling.
 *
 * A backtick string with nothing interpolated is a string to Angular: ngtsc's evaluator
 * answers `isNoSubstitutionTemplateLiteral(node) → node.text` beside the quoted case, so
 * `input(0, { alias: \`appValue\` })` names the input `appValue` and reading only quoted
 * strings loses the alias and indexes the property name instead.
 *
 * A template that *does* interpolate is not read. ngtsc resolves those where every part
 * is statically known, which means evaluating expressions; a name this module cannot see
 * is better absent than guessed.
 *
 * Exported because the same question is asked of a selector and a pipe name, which are
 * read where a file is scanned rather than here. `core/inline-template` asks it too, of
 * an inline template, and answered it correctly first.
 * @param node The expression a decorator or an options object was given.
 * @returns Its text, or `undefined` when it is not a string written out.
 */
export function staticText(node: Node | undefined): string | undefined {
  if (node?.isKind(SyntaxKind.StringLiteral) || node?.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    return node.getLiteralText();
  }
  return undefined;
}

/** @internal */
function asObjectLiteral(node: Node | undefined): ObjectLiteralExpression | undefined {
  return node?.isKind(SyntaxKind.ObjectLiteralExpression) ? node : undefined;
}

/** @internal */
function arrayElements(options: ObjectLiteralExpression, name: string): Node[] {
  const initializer = propertyInitializer(options, name);
  return initializer?.isKind(SyntaxKind.ArrayLiteralExpression) ? initializer.getElements() : [];
}

/** @internal */
function stringProperty(options: ObjectLiteralExpression, name: string): string | undefined {
  return staticText(propertyInitializer(options, name));
}

/** @internal */
function booleanProperty(options: ObjectLiteralExpression, name: string): boolean {
  return propertyInitializer(options, name)?.isKind(SyntaxKind.TrueKeyword) ?? false;
}

/** @internal */
function propertyInitializer(options: ObjectLiteralExpression, name: string): Node | undefined {
  const property = options.getProperty(name);
  return property?.isKind(SyntaxKind.PropertyAssignment) ? property.getInitializer() : undefined;
}
