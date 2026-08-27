/**
 * What a template may write on one element, answered for an agent that has a name.
 *
 * The failure this is for is the one developers report most about AI-written Angular:
 * a confidently wrong input. A model asked for a loading state writes `isLoading`
 * because that is the mean of everything it has read, while the component in front of it
 * takes `loadingState` — and nothing in the model's training could have told it
 * otherwise, because the answer is a fact about this workspace.
 *
 * The index has held that answer since inputs were read out of declarations and sources
 * alike. This puts it where the model can ask.
 * @module
 */

import { resolveElementImportPath } from "../core/import-resolution";
import type { AngularElementData, ElementInput } from "../types";
import type { TemplateProject } from "./verify-template";

/**
 * How many elements are described in full when nothing matched exactly.
 *
 * The rest are named rather than dropped: a surface is expensive to describe and cheap to
 * name, and a query that missed is better answered with everything it nearly hit than
 * with five of them and a number.
 */
const DETAILED = 5;

/** How many are named at all. Past this the query named most of the index. */
const NAMED = 100;

/** The score of a selector or a class name the query names outright. */
const EXACT = 4;

/** One element's public surface, trimmed of everything it does not declare. */
export interface ElementSummary {
  name: string;
  type: "component" | "directive" | "pipe";
  selector: string;
  /** The specifier to write in an `import` statement, resolved for the asking file. */
  importFrom: string;
  standalone: boolean;
  /** Absent when the element declares none; `required` and `signal` only where true. */
  inputs?: Array<{ name: string; required?: true; signal?: true }>;
  outputs?: string[];
  /** Where a component projects its children, in declaration order. */
  contentSelectors?: string[];
  /** Directives Angular applies with it, and what each exposes on the host. */
  hostDirectives?: Array<{ name: string; exposes?: string[] }>;
}

/** What `element_api` answers. */
export interface ElementApiAnswer {
  matches: ElementSummary[];
  /** Everything else the query named, as `name · selector`; ask again by one of these. */
  others?: string[];
  /** How many matched beyond even those named. */
  more: number;
}

export interface ElementApiRequest {
  runtime: TemplateProject;
  /** The file the agent is working in; import specifiers are resolved against it. */
  fromFile: string;
  /** A selector or a class name, as the agent happens to have it. */
  query: string;
}

/**
 * Describes the elements one query names.
 * @param request The project, the asking file, and what to look for.
 */
export async function describeElements(request: ElementApiRequest): Promise<ElementApiAnswer> {
  const query = request.query.trim();
  if (!query) {
    return { matches: [], more: 0 };
  }

  const ranked = rank(query, request.runtime.indexer.searchWithSelectors(""));
  const answering = shortlist(ranked);
  const matches = await Promise.all(answering.map(({ element }) => summarize(element, request)));
  const others = ranked.slice(answering.length, NAMED);

  return {
    matches,
    ...(others.length > 0 ? { others: others.map(({ element }) => name(element)) } : {}),
    more: Math.max(0, ranked.length - Math.max(answering.length, NAMED)),
  };
}

/**
 * The elements a query names, best first.
 *
 * An agent asks with whichever half it holds: the selector it read in a template, or the
 * class name it read in an import. Both are matched, and an exact hit of either outranks
 * a partial hit of the other — a query of `nz-table` must not be answered first by
 * `nz-table-cell` merely because that also begins with it.
 * @internal
 */
function rank(
  query: string,
  indexed: Array<{ selector: string; element: AngularElementData }>
): Array<{ element: AngularElementData; score: number }> {
  const needle = query.toLowerCase();
  const scored = new Map<string, { element: AngularElementData; score: number }>();

  for (const { selector, element } of indexed) {
    const score = scoreOf(needle, selector.toLowerCase(), element.name.toLowerCase());
    if (score === 0) {
      continue;
    }

    // One element sits under every selector it answers to, so it is scored by its best.
    const identity = `${element.name} ${element.path}`;
    const seen = scored.get(identity);
    if (!seen || seen.score < score) {
      scored.set(identity, { element, score });
    }
  }

  return [...scored.values()].sort(
    (one, other) => other.score - one.score || one.element.name.localeCompare(other.element.name)
  );
}

/**
 * How many of the ranked elements to answer with.
 *
 * An exact hit is an answer, not a candidate: asking for `nz-table` and being handed
 * `nz-table-cell` alongside it wastes tokens on something the agent did not ask about.
 * Where several elements match exactly — `[tuiSlot]` is three directives — all of them
 * are the answer. Only a query that hit nothing exactly returns a shortlist.
 * @internal
 */
function shortlist(ranked: Array<{ element: AngularElementData; score: number }>): Array<{
  element: AngularElementData;
  score: number;
}> {
  return ranked[0]?.score === EXACT ? ranked.filter(({ score }) => score === EXACT) : ranked.slice(0, DETAILED);
}

/** One line for an element the answer names but does not describe. @internal */
function name(element: AngularElementData): string {
  return `${element.name} · ${element.originalSelector.replace(/\s+/g, " ").trim()}`;
}

/** @internal */
function scoreOf(needle: string, selector: string, name: string): number {
  if (selector === needle || name === needle) {
    return EXACT;
  }
  if (name.startsWith(needle) || selector.startsWith(needle)) {
    return 3;
  }
  if (name.includes(needle) || selector.includes(needle)) {
    return 2;
  }
  return 0;
}

/** @internal */
async function summarize(element: AngularElementData, request: ElementApiRequest): Promise<ElementSummary> {
  const summary: ElementSummary = {
    name: element.name,
    type: element.type,
    // As written, less the whitespace a multi-line selector is emitted with: Material's
    // button spans ten lines in its declaration and means one thing.
    selector: element.originalSelector.replace(/\s+/g, " ").trim(),
    importFrom: await importSpecifier(element, request),
    standalone: element.isStandalone,
  };

  const inputs = (element.inputs ?? []).map(compactInput);
  if (inputs.length > 0) {
    summary.inputs = inputs;
  }

  const outputs = (element.outputs ?? []).map((output) => output.name);
  if (outputs.length > 0) {
    summary.outputs = outputs;
  }

  if (element.contentSelectors && element.contentSelectors.length > 0) {
    summary.contentSelectors = element.contentSelectors;
  }

  const hostDirectives = (element.hostDirectives ?? []).map((hostDirective) => {
    const exposes = [...hostDirective.inputs, ...hostDirective.outputs].map((binding) => binding.name);
    return exposes.length > 0 ? { name: hostDirective.name, exposes } : { name: hostDirective.name };
  });
  if (hostDirectives.length > 0) {
    summary.hostDirectives = hostDirectives;
  }

  return summary;
}

/**
 * An input with everything it does not say left out.
 *
 * `required: false` on every entry is noise an agent pays for by the token, and the
 * absence reads the same way.
 * @internal
 */
function compactInput(input: ElementInput): { name: string; required?: true; signal?: true } {
  const compact: { name: string; required?: true; signal?: true } = { name: input.name };
  if (input.required) {
    compact.required = true;
  }
  if (input.isSignal) {
    compact.signal = true;
  }
  return compact;
}

/**
 * Where to import it from, for the file that asked.
 *
 * A library element carries its specifier; a project element is stored relative to the
 * root and has to be resolved against the asking file, which is what makes the answer
 * usable rather than merely true.
 * @internal
 */
async function importSpecifier(element: AngularElementData, request: ElementApiRequest): Promise<string> {
  if (element.isExternal) {
    return element.path;
  }

  return resolveElementImportPath(element, request.fromFile, request.runtime.rootPath, (modulePath, fromFile) =>
    request.runtime.resolveImportPath(modulePath, fromFile)
  );
}
