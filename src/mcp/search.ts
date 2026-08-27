/**
 * Finding an element by what it is for, rather than by what it is called.
 *
 * An agent holds an intent — a table with sorting, a date picker — and asks for a name.
 * Angular makes that easier than it sounds: selectors are descriptive by convention, and
 * so are the entry points a library splits itself into. `nz-date-picker`,
 * `@angular/material/progress-spinner` and `ng-zorro-antd/spin` each carry the concept in
 * plain words, so matching words against words answers most of it without a model.
 *
 * Matching is strict: every word of the query has to appear. A model that gets nothing
 * back asks again with another word, which is what it is good at; a model handed forty
 * weak matches takes the first, which is what it is bad at. So a precise "no" is the more
 * useful answer, and the synonym problem is left where it is already solved.
 * @module
 */

import { resolveElementImportPath } from "../core/import-resolution";
import type { AngularElementData } from "../types";
import { packageOf } from "./library-usage";
import type { TemplateProject } from "./verify-template";

/** How many elements one answer carries. */
const LIMIT = 5;

/** Beyond this many matches the query is too broad to be answered by its first five. */
const TOO_BROAD = 10;

/** One candidate, with enough to choose by and no more. */
export interface SearchHit {
  name: string;
  type: "component" | "directive" | "pipe";
  selector: string;
  /** The specifier to write in an `import` statement, resolved for the asking file. */
  importFrom: string;
  /** The package it belongs to, absent for the workspace's own elements. */
  library?: string;
  /** How many of the project's files import from that package. */
  usedByProject?: number;
  /**
   * Only the inputs a template must bind.
   *
   * What decides whether a component fits is what it demands; the twenty optional ones
   * are `angular_element_api`'s answer, and noise while choosing.
   */
  requiredInputs?: string[];
}

/** What `search` answers. */
export interface SearchAnswer {
  hits: SearchHit[];
  /** How many further elements matched and were not returned. */
  more: number;
  /** Present only when nothing matched, saying what to do instead. */
  advice?: string;
}

export interface SearchRequest {
  runtime: TemplateProject;
  /** The file the agent is working in; import specifiers are resolved against it. */
  fromFile: string;
  /** What the element is for, in words: "date picker", "table", "modal". */
  query: string;
  /** Narrow to one kind, when the intent already says which. */
  type?: "component" | "directive" | "pipe";
  /** How many files import from each package, for ranking by what the workspace writes. */
  libraryUsage: ReadonlyMap<string, number>;
}

/**
 * Finds the elements a description names.
 * @param request The project, the words, and what the workspace already uses.
 */
export async function searchElements(request: SearchRequest): Promise<SearchAnswer> {
  const wanted = words(request.query);
  if (wanted.length === 0) {
    return { hits: [], more: 0, advice: 'Say what the element is for, in words: "date picker", "table", "modal".' };
  }

  const matched = new Map<string, { element: AngularElementData; used: number }>();
  for (const { selector, element } of request.runtime.indexer.searchWithSelectors("")) {
    if (request.type && element.type !== request.type) {
      continue;
    }
    if (!describes(wanted, element, selector)) {
      continue;
    }
    matched.set(`${element.name} ${element.path}`, {
      element,
      used: element.isExternal ? (request.libraryUsage.get(packageOf(element.path)) ?? 0) : Number.POSITIVE_INFINITY,
    });
  }

  if (matched.size === 0) {
    return {
      hits: [],
      more: 0,
      advice:
        "Nothing matched every word. Try one word rather than several, or a different word for the same thing; " +
        "angular_project_overview names the libraries this workspace uses, which says where to look.",
    };
  }

  // What the workspace writes outranks what it merely has installed, and its own
  // elements outrank both: a project's own card component is the card here.
  const ranked = [...matched.values()].sort(
    (one, other) => other.used - one.used || one.element.name.localeCompare(other.element.name)
  );

  const more = Math.max(0, ranked.length - LIMIT);
  return {
    hits: await Promise.all(ranked.slice(0, LIMIT).map(({ element, used }) => describe(element, used, request))),
    more,
    // Five of seventy is five arbitrary ones. Said out loud, because a model reading a
    // list has no way to tell a shortlist from an answer.
    ...(more >= TOO_BROAD
      ? {
          advice:
            `${ranked.length} elements match, so these five are a sample rather than the answer. ` +
            "Narrow it: add a word, or set type to component, directive or pipe.",
        }
      : {}),
  };
}

/**
 * Whether an element answers to every word asked for.
 *
 * The words are looked for across the three places Angular puts meaning: the class name,
 * the selector, and the entry point the element is imported from — which is why "spinner"
 * finds `@angular/material/progress-spinner` and "spin" finds `ng-zorro-antd/spin`.
 * @internal
 */
function describes(wanted: readonly string[], element: AngularElementData, selector: string): boolean {
  const vocabulary = new Set([...words(element.name), ...words(selector), ...words(element.path)]);
  return wanted.every((word) => has(vocabulary, word));
}

/**
 * A word matches a vocabulary entry it begins, so that "pick" finds "picker".
 *
 * Prefixes only, never the middle: matching anywhere inside a word makes "on" find
 * everything, and a model that asked for "on" deserves an empty answer.
 * @internal
 */
function has(vocabulary: ReadonlySet<string>, word: string): boolean {
  for (const known of vocabulary) {
    if (known.startsWith(word)) {
      return true;
    }
  }
  return false;
}

/**
 * The words in a name, a selector or a path.
 *
 * `NzDatePickerComponent` is four words and `nz-date-picker` is three, so a query of
 * `date picker` has to reach both: case boundaries split as readily as punctuation does.
 * @internal
 */
function words(text: string): string[] {
  return text
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z\d]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0);
}

/** @internal */
async function describe(element: AngularElementData, used: number, request: SearchRequest): Promise<SearchHit> {
  const hit: SearchHit = {
    name: element.name,
    type: element.type,
    selector: element.originalSelector.replace(/\s+/g, " ").trim(),
    // The specifier rather than the indexed path: a project element is stored relative to
    // the root, and handing that over is handing over something that does not compile.
    importFrom: element.isExternal
      ? element.path
      : await resolveElementImportPath(element, request.fromFile, request.runtime.rootPath, (modulePath, fromFile) =>
          request.runtime.resolveImportPath(modulePath, fromFile)
        ),
  };

  if (element.isExternal) {
    hit.library = packageOf(element.path);
    hit.usedByProject = Number.isFinite(used) ? used : 0;
  }

  const required = (element.inputs ?? []).filter((input) => input.required).map((input) => input.name);
  if (required.length > 0) {
    hit.requiredInputs = required;
  }

  return hit;
}
