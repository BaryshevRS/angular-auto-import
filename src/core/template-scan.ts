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
}

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
  extractPipesFromExpression: (expression: unknown, nodeOffset?: number) => void;
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
    extractPipesFromExpression: (expression, nodeOffset = 0) => {
      extractPipesFromExpression(context, expression, nodeOffset);
    },
  };

  context.visit(request.nodes);
  return elements;
}

/**
 * Collects pipes used inside an expression node, relative to the node's own offset.
 * @internal
 */
function extractPipesFromExpression(context: ScanContext, expression: unknown, nodeOffset: number): void {
  if (!expression || typeof expression !== "object" || !("sourceSpan" in expression) || !expression.sourceSpan) {
    return;
  }

  try {
    const expr = expression as { sourceSpan: { start: number; end: number } };
    const expressionText = context.text.slice(expr.sourceSpan.start, expr.sourceSpan.end);
    pushPipes(context, expressionText, context.offset + nodeOffset, expr.sourceSpan.start);
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
      pushPipes(context, expressionText, context.offset, valueSpan.start.offset);
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
    node.sourceSpan.start.offset
  );
}

/**
 * Finds `| pipeName` usages in an expression and records each one.
 * @internal
 */
function pushPipes(context: ScanContext, expressionText: string, baseOffset: number, valueOffset: number): void {
  const pipeRegex = /\|\s*([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let match: RegExpExecArray | null;

  while ((match = pipeRegex.exec(expressionText))) {
    const pipeName = match[1];
    const pipeOffsetInExpression = match.index + match[0].indexOf(pipeName);
    const start = baseOffset + valueOffset + pipeOffsetInExpression;

    context.elements.push({
      type: "pipe",
      name: pipeName,
      range: {
        start: context.document.positionAt(start),
        end: context.document.positionAt(start + pipeName.length),
      },
      tagName: "pipe",
      isAttribute: false,
      attributes: [],
    });
  }
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
