/**
 * Walks a parsed Angular template AST and collects every element, attribute, and
 * pipe that could require an import, with plain document ranges.
 *
 * Parsing itself stays with the caller: this module receives the nodes the Angular
 * compiler produced, so the Extension Host and the language server can share the
 * walk without agreeing on how the template was obtained.
 * @module
 */

import { knownTags } from "../consts";
import type {
  ControlFlowNode,
  TemplateAstNode,
  TmplAstBoundAttribute,
  TmplAstBoundEvent,
  TmplAstBoundText,
  TmplAstElement,
  TmplAstReference,
  TmplAstTemplate,
} from "../types";
import type { DocumentView } from "./document";
import type { ElementLookup } from "./element-lookup";
import type { CoreRange } from "./language-types";

/** An attribute as written on a template element. */
export interface TemplateElementAttribute {
  name: string;
  value: string;
}

/** What kind of template construct an element was found as. */
export type TemplateElementType =
  | "component"
  | "pipe"
  | "attribute"
  | "structural-directive"
  | "property-binding"
  | "template-reference";

/** One import candidate found in a template, located by a plain range. */
export interface ScannedTemplateElement {
  type: TemplateElementType;
  name: string;
  range: CoreRange;
  tagName: string;
  isAttribute: boolean;
  attributes: TemplateElementAttribute[];
  /**
   * The classes the element carries statically, which is what a `.foo` in a selector is
   * matched against.
   *
   * Separate from {@link ScannedTemplateElement.attributes} because a bound `[class]`
   * must contribute none: Angular decides which directives apply before any expression
   * has a value, so a class that is only ever computed selects nothing. The compiler
   * says the same by giving every bound attribute an empty value in
   * `getAttrsForDirectiveMatching`.
   */
  classNames: string[];
}

/** The slice of the element index the walk needs. */
export type TemplateElementLookup = ElementLookup;

/**
 * Angular AST node constructors, taken from the caller's dynamically imported compiler
 * so that `instanceof` checks run against the very classes that produced the nodes.
 */
export interface TemplateAstConstructors {
  tmplAstElement: TemplateAstClass<TmplAstElement>;
  tmplAstTemplate: TemplateAstClass<TmplAstTemplate>;
  tmplAstBoundEvent: TemplateAstClass<TmplAstBoundEvent>;
  tmplAstReference: TemplateAstClass<TmplAstReference>;
  tmplAstBoundAttribute: TemplateAstClass<TmplAstBoundAttribute>;
  tmplAstBoundText: TemplateAstClass<TmplAstBoundText>;
  /**
   * A `name="value"` written out in the template.
   *
   * Needed by name rather than by elimination: a `#class="ref"` is a reference whose
   * name and value are both plain strings, and nothing but the node's kind tells it
   * apart from the `class` attribute it is spelled like.
   */
  tmplAstTextAttribute: TemplateAstClass<{ name: string; value: string }>;
  /**
   * Which kinds of binding overwrite an attribute of the same name.
   *
   * `[class]` is a property binding named `class` and wipes a static `class="a"`;
   * `[class.a]` is a class binding named `a` and leaves it alone. Only the kind tells
   * them apart, since `[class.class]` would be a class binding named `class`.
   *
   * The compiler's own `BindingType`, taken whole rather than as named members, so the
   * members keep the names the compiler gives them at the point of use.
   */
  bindingType: Readonly<Record<string, number>>;
  /**
   * The compiler's expression-AST walker, subclassed to find pipe nodes.
   *
   * Pipes used to be read with a regular expression over the expression's source text,
   * which cannot tell a pipe from the second `|` of a logical OR, or from a `|` inside
   * a string literal. The parser already knows the difference.
   */
  recursiveAstVisitor: ExpressionVisitorClass;
}

/** The shape of `RecursiveAstVisitor` this uses: a class whose `visitPipe` is overridden. */
type ExpressionVisitorClass = new () => {
  visitPipe(pipe: BindingPipeNode, context: unknown): void;
};

/**
 * The `BindingPipe` fields this reads.
 *
 * `nameSpan` is an offset into the template as written, which holds because the parser
 * is asked to preserve whitespace — see `PARSE_OPTIONS` in `core/angular-compiler`.
 */
type BindingPipeNode = {
  name: string;
  nameSpan: { start: number };
};

/** An expression node the compiler can walk. */
type VisitableExpression = {
  visit(visitor: { visitPipe(pipe: BindingPipeNode, context: unknown): void }, context?: unknown): void;
};

/** An AST node class, used only as the right-hand side of `instanceof`. */
type TemplateAstClass<T> = abstract new (...args: never[]) => T;

/** Everything one template walk needs. */
export interface TemplateScanRequest {
  /** Root nodes of the parsed template. */
  nodes: TemplateAstNode[];
  /** The document the template lives in, used to turn offsets into positions. */
  document: DocumentView;
  /** Where the template starts in that document; non-zero for inline templates. */
  offset: number;
  /** The template text the nodes were parsed from. */
  text: string;
  /** Index used to decide whether a tag or attribute is a known Angular element. */
  lookup: TemplateElementLookup;
  constructors: TemplateAstConstructors;
  /** Reports a recoverable walk failure; the walk continues without it. */
  onError?: (message: string, error: Error) => void;
}

type ScanContext = {
  elements: ScannedTemplateElement[];
  document: DocumentView;
  offset: number;
  text: string;
  lookup: TemplateElementLookup;
  constructors: TemplateAstConstructors;
  onError: (message: string, error: Error) => void;
  visit: (nodes: TemplateAstNode[]) => void;
  extractPipesFromExpression: (expression: unknown) => void;
};

/**
 * Collects every import candidate in a parsed template.
 * @param request The nodes to walk and the context to resolve them against.
 * @returns Candidates in document order, each with a plain range.
 */
export function scanTemplate(request: TemplateScanRequest): ScannedTemplateElement[] {
  const elements: ScannedTemplateElement[] = [];
  const context: ScanContext = {
    elements,
    document: request.document,
    offset: request.offset,
    text: request.text,
    lookup: request.lookup,
    constructors: request.constructors,
    onError: request.onError ?? (() => undefined),
    visit: (nodes) => {
      for (const node of nodes) {
        processTemplateNode(node, context);
      }
    },
    extractPipesFromExpression: (expression) => {
      extractPipesFromExpression(context, expression);
    },
  };

  context.visit(request.nodes);

  // The walk reaches things in the order the code happens to visit them: a chain of
  // pipes outwards, a `@defer` block's parts by name rather than by where they were
  // written. Callers are promised document order, so it is established here once
  // rather than depended on in every branch above.
  elements.sort(byDocumentPosition);
  return elements;
}

/**
 * Collects pipes used inside an expression node, relative to the node's own offset.
 * @internal
 */
function extractPipesFromExpression(context: ScanContext, expression: unknown): void {
  if (!expression || typeof expression !== "object" || !("sourceSpan" in expression) || !expression.sourceSpan) {
    return;
  }

  pushPipes(context, expression);
}

/**
 * Processes a template AST node.
 * @internal
 */
function processTemplateNode(node: TemplateAstNode, context: ScanContext): void {
  // Handle all types of control flow expressions
  if (isControlFlowNode(node)) {
    processControlFlowNode(node, context);
    return;
  }

  if (node instanceof context.constructors.tmplAstElement || node instanceof context.constructors.tmplAstTemplate) {
    processElementOrTemplateNode(node, context);
  }

  if (node instanceof context.constructors.tmplAstBoundText) {
    processBoundTextNode(node, context);
  }

  // Handle regular children for non-control-flow nodes
  if (hasChildren(node) && !isControlFlowNode(node)) {
    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    context.visit(node.children);
  }
}

/**
 * Detects control flow nodes using duck typing instead of constructor name matching.
 * This is more robust than `node.constructor.name` which can break when bundled with esbuild.
 * @internal
 */
function isControlFlowNode(node: TemplateAstNode): boolean {
  const n = node as Record<string, unknown>;
  // IfBlock/SwitchBlock: has `branches` array
  if (Array.isArray(n.branches)) {
    return true;
  }
  // ForLoopBlock: has `trackBy` and `contextVariables`
  if (n.trackBy !== undefined && n.contextVariables !== undefined) {
    return true;
  }
  // SwitchBlock in Angular 20/21 used `cases`; Angular 22 exposes `groups`.
  if (Array.isArray(n.cases)) {
    return true;
  }
  if (Array.isArray(n.groups)) {
    return true;
  }
  // DeferredBlock: has `placeholder`, `loading`, or `error` sub-blocks
  if (n.placeholder !== undefined || n.loading !== undefined || n.error !== undefined) {
    return true;
  }
  return false;
}

/**
 * Walks a control flow block: its own expression, its branches, and its children.
 * @internal
 */
function processControlFlowNode(controlFlowNode: ControlFlowNode, context: ScanContext): void {
  // Check for pipes in main expression (condition/iterator)
  if (controlFlowNode.expression) {
    context.extractPipesFromExpression(controlFlowNode.expression);
  }

  // Handle branches and cases
  processBranchLikeArray(controlFlowNode.branches, context);
  processBranchLikeArray(controlFlowNode.cases, context);
  processGroupsArray(controlFlowNode.groups, context);

  // Handle main children
  if (controlFlowNode.children && Array.isArray(controlFlowNode.children)) {
    context.visit(controlFlowNode.children);
  }

  // Handle special blocks
  processControlFlowSpecialBlocks(controlFlowNode, context);
}

/**
 * Walks `@if` branches or `@switch` cases, which carry an expression and children alike.
 * @internal
 */
function processBranchLikeArray(items: unknown, context: ScanContext): void {
  if (!items || !Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    processBranchOrCase(item, context);
  }
}

/**
 * Walks the grouped switch cases Angular 22 emits.
 * @internal
 */
function processGroupsArray(groups: unknown, context: ScanContext): void {
  if (!groups || !Array.isArray(groups)) {
    return;
  }

  for (const group of groups) {
    const switchGroup = group as { cases?: Array<{ expression?: unknown }>; children?: TemplateAstNode[] };
    if (Array.isArray(switchGroup.cases)) {
      for (const caseBlock of switchGroup.cases) {
        if (caseBlock.expression) {
          context.extractPipesFromExpression(caseBlock.expression);
        }
      }
    }
    if (Array.isArray(switchGroup.children)) {
      context.visit(switchGroup.children);
    }
  }
}

/**
 * Walks one branch or case of a control flow block.
 * @internal
 */
function processBranchOrCase(item: { expression?: unknown; children?: TemplateAstNode[] }, context: ScanContext): void {
  if (item.expression) {
    context.extractPipesFromExpression(item.expression);
  }
  if (item.children && Array.isArray(item.children)) {
    context.visit(item.children);
  }
}

/**
 * Walks the blocks that hang off a control flow node rather than its children.
 * @internal
 */
function processControlFlowSpecialBlocks(controlFlowNode: ControlFlowNode, context: ScanContext): void {
  visitDeferTriggers(controlFlowNode as unknown as Record<string, unknown>, context);

  // Handle @for empty block
  const emptyBlock = controlFlowNode.empty as { children?: TemplateAstNode[] };
  if (emptyBlock?.children && Array.isArray(emptyBlock.children)) {
    context.visit(emptyBlock.children);
  }

  // Handle @defer sub-blocks (placeholder, loading, error)
  for (const blockType of ["placeholder", "loading", "error"]) {
    const block = (controlFlowNode as Record<string, unknown>)[blockType] as { children?: TemplateAstNode[] };
    if (block?.children) {
      context.visit(block.children);
    }
  }
}

/**
 * Visits the expressions of a `@defer` block's triggers.
 *
 * `@defer (when items | ready)` holds an expression like any other, and it is the only
 * one that lives beside a block rather than inside it.
 * @internal
 */
function visitDeferTriggers(node: Record<string, unknown>, context: ScanContext): void {
  for (const triggerSet of ["triggers", "prefetchTriggers", "hydrateTriggers"]) {
    const triggers = node[triggerSet] as Record<string, { value?: unknown }> | undefined;
    if (!triggers) {
      continue;
    }
    for (const trigger of Object.values(triggers)) {
      if (trigger?.value) {
        context.extractPipesFromExpression(trigger.value);
      }
    }
  }
}

/**
 * Processes element or template nodes.
 * @internal
 */
function processElementOrTemplateNode(node: TmplAstElement | TmplAstTemplate, context: ScanContext): void {
  const isTemplate = node instanceof context.constructors.tmplAstTemplate;

  // @ts-expect-error: Complex Angular template AST node types from ts-morph
  const regularAttrs = [...node.attributes, ...node.inputs, ...node.outputs, ...node.references];

  // @ts-expect-error: Complex Angular template AST node types from ts-morph
  const templateAttrs = isTemplate ? [...node.templateAttrs] : [];

  const attributes = [...regularAttrs, ...templateAttrs].map((attr: unknown) => ({
    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    name: attr.name,
    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    value: "value" in attr && attr.value ? String(attr.value) : "",
  }));

  const classNames = staticClassNames(node, isTemplate, context);

  const nodeName = isTemplate ? "ng-template" : node.name;

  if (isKnownHtmlTag(nodeName)) {
    // For known HTML tags (like button, input, a), check if they have Angular directives
    // by searching for compound selectors like "button[mat-button]", "input[matInput]"
    addCompoundSelectorMatches(nodeName, regularAttrs, attributes, classNames, context);
  } else {
    addAngularElementsToList(node, nodeName, attributes, classNames, context);
  }

  // Process attributes
  for (const attr of regularAttrs) {
    processSingleAttribute(attr, false, nodeName, attributes, classNames, context);
  }
  for (const attr of templateAttrs) {
    processSingleAttribute(attr, true, nodeName, attributes, classNames, context);
  }
}

/**
 * Checks if a known HTML tag (like button, input, a) has Angular directives
 * by searching for compound selectors like "button[mat-button]", "input[matInput]".
 *
 * Note: This function is specifically for directives that use compound selectors
 * (e.g., "button[mat-button]"). Regular attribute directives are handled by
 * `processSingleAttribute`, which already records the correct attribute positions.
 * @internal
 */
function addCompoundSelectorMatches(
  nodeName: string,
  regularAttrs: unknown[],
  attributes: TemplateElementAttribute[],
  classNames: string[],
  context: ScanContext
): void {
  // A single element can have multiple directives, but we should not add the same directive instance twice.
  const processedDirectives = new Set<unknown>();

  // For each attribute, check if there's a directive with a compound selector like "button[mat-button]"
  for (let i = 0; i < attributes.length; i++) {
    const attr = attributes[i];
    const attrAstNode = regularAttrs[i];

    const compoundSelector = `${nodeName}[${attr.name}]`;
    const foundCandidates = context.lookup.getElements(compoundSelector);

    // Only process if we actually found a directive with this compound selector
    if (foundCandidates.length === 0) {
      continue;
    }

    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    const keySpan = attrAstNode?.keySpan ?? attrAstNode?.sourceSpan;
    if (!keySpan) {
      // Fallback to tag range if attribute position not available
      continue;
    }

    // Create range for the attribute only, not the entire tag
    const attributeRange = spanToRange(context, keySpan.start.offset, keySpan.end.offset);

    for (const candidate of foundCandidates) {
      const isAngularElement = candidate.type === "component" || candidate.type === "directive";

      if (isAngularElement && !processedDirectives.has(candidate)) {
        processedDirectives.add(candidate);

        context.elements.push({
          name: attr.name, // Use attribute name, not compound selector, for config matching
          type: candidate.type as TemplateElementType,
          isAttribute: true, // Mark as attribute since we're highlighting the attribute
          range: attributeRange, // Use attribute position, not entire tag
          tagName: nodeName,
          attributes,
          classNames,
        });
      }
    }
  }
}

/**
 * The classes written out on the element, as the matcher wants them.
 *
 * Only a static `class="a b"` counts, and only where Angular counts it — which is not
 * the same as wherever one is written. `getAttrsForDirectiveMatching` folds the node into
 * one map, attributes first and then property, two-way and event bindings, and the last
 * writer wins with an empty value. So `<div class="a" [class]="computed">` has no classes
 * at all for matching: the binding overwrote the attribute, and directives are matched
 * before any binding has a value. A `[class.a]` is a class binding named `a`, overwrites
 * nothing, and leaves the static classes standing.
 *
 * A `#class="ref"` contributes nothing either, being a reference that merely shares the
 * spelling. That falls out of reading the node's own attributes rather than the flattened
 * list the rest of the scan works from, which holds references beside them; the kind
 * check then says which of those attributes count, so that neither the reading nor the
 * check is the only thing standing between a reference and a class.
 *
 * A `<div *foo class="x">` parses into a synthetic template that keeps the element's own
 * attributes, and those are not the template's: Angular matches such a node against its
 * `templateAttrs` alone. A written-out `<ng-template class="x">` is the other case, and
 * there the class does count — the compiler tells them apart by `tagName`, and so does
 * this.
 *
 * The split of the value is the compiler's too: the name is compared case-insensitively
 * and the value is broken on whitespace.
 * @internal
 */
function staticClassNames(node: TmplAstElement | TmplAstTemplate, isTemplate: boolean, context: ScanContext): string[] {
  // @ts-expect-error: Complex Angular template AST node types from ts-morph
  if (isTemplate && node.tagName !== "ng-template") {
    return [];
  }

  const classes: string[] = [];
  for (const [name, value] of directiveMatchingAttributes(node, context)) {
    if (name.toLowerCase() !== "class") {
      continue;
    }
    for (const className of value.split(/\s+/)) {
      if (className !== "") {
        classes.push(className);
      }
    }
  }
  return classes;
}

/**
 * The node folded into one map the way `getAttrsForDirectiveMatching` folds it: written
 * attributes first, then the bindings that overwrite one of the same name with nothing.
 * @internal
 */
function directiveMatchingAttributes(
  node: TmplAstElement | TmplAstTemplate,
  context: ScanContext
): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const attr of node.attributes ?? []) {
    if (attr instanceof context.constructors.tmplAstTextAttribute) {
      attributes.set(attr.name, attr.value);
    }
  }

  const { Property, TwoWay } = context.constructors.bindingType;
  for (const binding of node.inputs ?? []) {
    const { name, type } = binding as unknown as { name: string; type: number };
    if (type === Property || type === TwoWay) {
      attributes.set(name, "");
    }
  }

  for (const binding of node.outputs ?? []) {
    attributes.set((binding as unknown as { name: string }).name, "");
  }

  return attributes;
}

/**
 * Records a tag that resolves to an indexed component or directive.
 * @internal
 */
function addAngularElementsToList(
  node: TmplAstElement | TmplAstTemplate,
  nodeName: string,
  attributes: TemplateElementAttribute[],
  classNames: string[],
  context: ScanContext
): void {
  for (const candidate of context.lookup.getElements(nodeName)) {
    const isKnownAngularElement = candidate.type === "component" || candidate.type === "directive";

    if (isKnownAngularElement) {
      context.elements.push({
        name: nodeName,
        type: candidate.type as TemplateElementType,
        isAttribute: false,
        // @ts-expect-error: Complex Angular template AST node types from ts-morph
        range: spanToRange(context, node.startSourceSpan.start.offset, node.startSourceSpan.end.offset),
        tagName: nodeName,
        attributes,
        classNames,
      });
    }
  }
}

/**
 * Records a single attribute, plus any pipes used in its bound value.
 * @internal
 */
function processSingleAttribute(
  attr: unknown,
  isTemplateAttr: boolean,
  nodeName: string,
  attributes: TemplateElementAttribute[],
  classNames: string[],
  context: ScanContext
): void {
  // @ts-expect-error: Complex Angular template AST node types from ts-morph
  const keySpan = attr.keySpan ?? attr.sourceSpan;
  if (!keySpan) {
    return;
  }

  // Skip event bindings, as they are not importable directives.
  if (attr instanceof context.constructors.tmplAstBoundEvent) {
    return;
  }

  let type: TemplateElementType = "attribute";
  if (attr instanceof context.constructors.tmplAstReference) {
    type = "template-reference";
    // @ts-expect-error: Complex Angular template AST node types from ts-morph
  } else if (isTemplateAttr || attr.name.startsWith("*")) {
    type = "structural-directive";
  } else if (attr instanceof context.constructors.tmplAstBoundAttribute) {
    type = "property-binding";
  }

  context.elements.push({
    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    name: attr.name,
    type,
    isAttribute: true,
    range: spanToRange(context, keySpan.start.offset, keySpan.end.offset),
    tagName: nodeName,
    attributes,
    classNames,
  });

  // Check for pipes in bound attribute values (like *ngIf="expression | pipe")
  if (attr instanceof context.constructors.tmplAstBoundAttribute && attr.value) {
    pushPipes(context, attr.value);
  }
}

/**
 * Records pipes used in an interpolation.
 * @internal
 */
function processBoundTextNode(node: TmplAstBoundText, context: ScanContext): void {
  pushPipes(context, node.value);
}

/**
 * Records every pipe the parser found in one expression, at its position in the
 * template.
 *
 * Both halves come from the parser, which is the only thing that knows them. A bar is
 * a pipe operator only outside string, template and regular-expression literals, and
 * only when it is not `||` — and inside a template literal it is an operator again in
 * the `${…}` holes. Reading that from the text means reimplementing the expression
 * grammar; the parser has already done it.
 * @internal
 */
function pushPipes(context: ScanContext, expression: unknown): void {
  if (!isVisitableExpression(expression)) {
    return;
  }

  const pipes: BindingPipeNode[] = [];
  const visitor = new context.constructors.recursiveAstVisitor();
  const walkChildren = visitor.visitPipe.bind(visitor);
  visitor.visitPipe = (pipe, visitContext) => {
    pipes.push(pipe);
    // Keep descending: a pipe's own argument may hold another one.
    walkChildren(pipe, visitContext);
  };

  try {
    expression.visit(visitor, null);
  } catch (e) {
    context.onError("Error walking a template expression for pipes:", e as Error);
    return;
  }

  for (const pipe of pipes) {
    const start = context.offset + pipe.nameSpan.start;
    context.elements.push({
      type: "pipe",
      name: pipe.name,
      range: {
        start: context.document.positionAt(start),
        end: context.document.positionAt(start + pipe.name.length),
      },
      tagName: "pipe",
      isAttribute: false,
      attributes: [],
      classNames: [],
    });
  }
}

/** @internal */
function isVisitableExpression(expression: unknown): expression is VisitableExpression {
  return (
    typeof expression === "object" &&
    expression !== null &&
    typeof (expression as VisitableExpression).visit === "function"
  );
}

/**
 * Turns a template-relative source span into a document range.
 * @internal
 */
function spanToRange(context: ScanContext, startOffset: number, endOffset: number): CoreRange {
  return {
    start: context.document.positionAt(context.offset + startOffset),
    end: context.document.positionAt(context.offset + endOffset),
  };
}

/**
 * Checks whether a node has child nodes worth walking.
 * @internal
 */
function hasChildren(node: unknown): boolean {
  // @ts-expect-error: Complex Angular template AST node types from ts-morph
  return node && typeof node === "object" && "children" in node && Array.isArray(node.children);
}

/**
 * Checks whether a tag is a plain HTML tag rather than an Angular element.
 * @internal
 */
function isKnownHtmlTag(tag: string): boolean {
  return knownTags.has(tag.toLowerCase());
}

/**
 * Orders two candidates by where they start in the document.
 * @internal
 */
function byDocumentPosition(left: ScannedTemplateElement, right: ScannedTemplateElement): number {
  if (left.range.start.line !== right.range.start.line) {
    return left.range.start.line - right.range.start.line;
  }
  return left.range.start.character - right.range.start.character;
}
