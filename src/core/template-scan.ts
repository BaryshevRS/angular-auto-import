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

/** The one `BindingPipe` field this reads: which pipe the parser saw. */
type BindingPipeNode = {
  name: string;
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

  try {
    const expr = expression as { sourceSpan: { start: number; end: number } };
    const expressionText = context.text.slice(expr.sourceSpan.start, expr.sourceSpan.end);
    pushPipes(context, expressionText, context.offset, expr.sourceSpan.start, expression);
  } catch (e) {
    context.onError("Error extracting pipes from expression:", e as Error);
  }
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

  const nodeName = isTemplate ? "ng-template" : node.name;

  if (isKnownHtmlTag(nodeName)) {
    // For known HTML tags (like button, input, a), check if they have Angular directives
    // by searching for compound selectors like "button[mat-button]", "input[matInput]"
    addCompoundSelectorMatches(nodeName, regularAttrs, attributes, context);
  } else {
    addAngularElementsToList(node, nodeName, attributes, context);
  }

  // Process attributes
  for (const attr of regularAttrs) {
    processSingleAttribute(attr, false, nodeName, attributes, context);
  }
  for (const attr of templateAttrs) {
    processSingleAttribute(attr, true, nodeName, attributes, context);
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
        });
      }
    }
  }
}

/**
 * Records a tag that resolves to an indexed component or directive.
 * @internal
 */
function addAngularElementsToList(
  node: TmplAstElement | TmplAstTemplate,
  nodeName: string,
  attributes: TemplateElementAttribute[],
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
  });

  // Check for pipes in bound attribute values (like *ngIf="expression | pipe")
  if (attr instanceof context.constructors.tmplAstBoundAttribute && attr.value) {
    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    const valueSpan = attr.valueSpan || attr.sourceSpan;
    if (valueSpan) {
      const expressionText = context.text.slice(valueSpan.start.offset, valueSpan.end.offset);
      pushPipes(context, expressionText, context.offset, valueSpan.start.offset, attr.value);
    }
  }
}

/**
 * Records pipes used in an interpolation.
 * @internal
 */
function processBoundTextNode(node: TmplAstBoundText, context: ScanContext): void {
  pushPipes(
    context,
    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    context.text.slice(node.sourceSpan.start.offset, node.sourceSpan.end.offset),
    context.offset,
    // @ts-expect-error: Complex Angular template AST node types from ts-morph
    node.sourceSpan.start.offset,
    node.value
  );
}

/**
 * Records the pipes used in one expression, at the position they occupy in the template.
 *
 * Each half of the answer comes from what can supply it. The parser knows *what* is a
 * pipe, so `a || b` contributes none. The template text knows *where*, because the
 * parser's own spans are measured against the source it was handed after whitespace
 * normalization, which is not the template and cannot be found in it.
 *
 * The scan over the text is therefore what produces ranges, and it skips two things a
 * bare pattern would not: the second bar of `||`, and anything inside a string literal.
 * The parser's answer then filters what is left. All three are needed — one expression
 * can hold `'x|name'` and `(v | name)` at once, where the names are equal and only the
 * quoting tells them apart.
 * @internal
 */
function pushPipes(
  context: ScanContext,
  expressionText: string,
  baseOffset: number,
  valueOffset: number,
  expression: unknown
): void {
  const parsedPipeNames = collectPipeNames(context, expression);
  if (parsedPipeNames.size === 0) {
    return;
  }

  for (const candidate of findPipeCandidates(expressionText)) {
    if (!parsedPipeNames.has(candidate.name)) {
      continue;
    }

    const start = baseOffset + valueOffset + candidate.offset;
    context.elements.push({
      type: "pipe",
      name: candidate.name,
      range: {
        start: context.document.positionAt(start),
        end: context.document.positionAt(start + candidate.name.length),
      },
      tagName: "pipe",
      isAttribute: false,
      attributes: [],
    });
  }
}

/** A `| name` the scan found outside any literal, with the name's offset in the text. */
type PipeCandidate = { name: string; offset: number };

const PIPE_NAME_PATTERN = /^\s*([a-zA-Z][a-zA-Z0-9_-]*)/;

/**
 * Characters that can end a value, and so make a following `/` a division.
 *
 * `}` is here for an object literal: `{a: 1} / y` divides. Everything else — an
 * operator, an opening bracket, the start of the expression — leaves a `/` to open a
 * regular expression instead.
 */
const ENDS_VALUE = /[\w$)\]}]/;

/**
 * Finds every `| name` in an expression that could be a pipe, with the name's offset.
 *
 * A bar means different things in different places, and only a scan that knows the
 * lexical structure can tell them apart: `a || b` is an operator, `'a|b'` and `/a|b/`
 * are text, and a template literal is text everywhere except its `${…}` holes, which
 * are expressions again and can hold real pipes at any depth.
 *
 * What this deliberately does *not* do is decide which candidates are pipes. That is
 * the parser's answer, and this only has to avoid hiding a real one from it or offering
 * it something that is not there.
 * @internal
 */
function* findPipeCandidates(text: string): Generator<PipeCandidate> {
  yield* scanRegion(text, 0, text.length, false);
}

/**
 * Scans one expression region, descending into the holes of template literals.
 * @param stopAtCloseBrace Whether a `}` at depth zero ends the region, which is what
 * terminates a `${…}` hole.
 * @returns Where the scan stopped: that `}`, or `end`.
 * @internal
 */
function* scanRegion(
  text: string,
  start: number,
  end: number,
  stopAtCloseBrace: boolean
): Generator<PipeCandidate, number> {
  // Whether the previous token can end a value. A `/` after one divides; a `/` anywhere
  // else opens a pattern. Tracking the token rather than the character is what keeps a
  // regular expression from making the next `/` look like the start of another.
  let afterValue = false;
  let braceDepth = 0;

  for (let index = start; index < end; index += 1) {
    const character = text[index];

    const literalEnd = yield* skipLiteral(text, index, end, afterValue);
    if (literalEnd >= 0) {
      index = literalEnd;
      afterValue = true;
    } else if (character === "}" && stopAtCloseBrace && braceDepth === 0) {
      return index;
    } else if (character === "|") {
      index = yield* scanBar(text, index, end);
      afterValue = false;
    } else if (!/\s/.test(character)) {
      braceDepth += braceDelta(character);
      afterValue = ENDS_VALUE.test(character);
    }
  }
  return end;
}

/**
 * Consumes whichever literal starts at `index`, yielding what its holes contain.
 * @param afterValue Whether the previous token can end a value, which is what makes a
 * `/` a division rather than the start of a pattern.
 * @returns The literal's last index, or `-1` when none starts here.
 * @internal
 */
function* skipLiteral(text: string, index: number, end: number, afterValue: boolean): Generator<PipeCandidate, number> {
  const character = text[index];

  if (character === "'" || character === '"') {
    return endOfStringLiteral(text, index);
  }
  if (character === "`") {
    return yield* scanTemplateLiteral(text, index, end);
  }
  if (character === "/" && !afterValue) {
    return endOfRegexLiteral(text, index);
  }
  return -1;
}

/** @internal */
function braceDelta(character: string): number {
  if (character === "{") {
    return 1;
  }
  return character === "}" ? -1 : 0;
}

/**
 * Handles one bar: a logical OR is stepped over, anything else offers a candidate.
 * @returns The index to continue from.
 * @internal
 */
function* scanBar(text: string, index: number, end: number): Generator<PipeCandidate, number> {
  if (text[index + 1] === "|") {
    // Step over both bars so the second cannot start a match either.
    return index + 1;
  }

  const match = PIPE_NAME_PATTERN.exec(text.slice(index + 1, end));
  if (match) {
    yield { name: match[1], offset: index + 1 + match[0].indexOf(match[1]) };
  }
  return index;
}

/**
 * Scans a template literal, yielding the candidates found in its `${…}` holes.
 *
 * The literal's own text is skipped; each hole is an expression and is scanned as one,
 * which is also what finds the brace that closes it — a `}` inside a string in there
 * closes nothing.
 * @returns The index of the closing backtick, or the last index when there is none.
 * @internal
 */
function* scanTemplateLiteral(text: string, open: number, end: number): Generator<PipeCandidate, number> {
  for (let index = open + 1; index < end; index += 1) {
    const character = text[index];

    if (character === "\\") {
      index += 1;
    } else if (character === "`") {
      return index;
    } else if (character === "$" && text[index + 1] === "{") {
      index = yield* scanRegion(text, index + 2, end, true);
    }
  }
  return end - 1;
}

/**
 * The index of a regular expression literal's closing slash, or the end of the text.
 *
 * A character class may contain an unescaped `/`, which does not close the literal.
 * @param openIndex Index of the opening slash.
 * @internal
 */
function endOfRegexLiteral(text: string, openIndex: number): number {
  let inClass = false;

  for (let index = openIndex + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
    } else if (character === "[") {
      inClass = true;
    } else if (character === "]") {
      inClass = false;
    } else if (character === "/" && !inClass) {
      return index;
    }
  }
  return text.length;
}

/**
 * The index of a string literal's closing quote, or the end of the text when it has
 * none — an unterminated string is what a template being typed usually holds.
 * @param text The expression text.
 * @param openIndex Index of the opening quote.
 * @internal
 */
function endOfStringLiteral(text: string, openIndex: number): number {
  const quote = text[openIndex];

  for (let index = openIndex + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text[index] === quote) {
      return index;
    }
  }
  return text.length;
}

/**
 * The names of the pipes the parser found in an expression.
 *
 * An expression it cannot walk yields nothing, which reports no pipes rather than
 * reporting wrong ones.
 * @internal
 */
function collectPipeNames(context: ScanContext, expression: unknown): Set<string> {
  const names = new Set<string>();
  if (!isVisitableExpression(expression)) {
    return names;
  }

  const visitor = new context.constructors.recursiveAstVisitor();
  const walkChildren = visitor.visitPipe.bind(visitor);
  visitor.visitPipe = (pipe, visitContext) => {
    names.add(pipe.name);
    // Keep descending: a pipe's own argument may hold another one.
    walkChildren(pipe, visitContext);
  };

  try {
    expression.visit(visitor, null);
  } catch (e) {
    context.onError("Error walking a template expression for pipes:", e as Error);
  }
  return names;
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
