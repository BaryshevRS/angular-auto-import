/**
 * The narrowest view of a project's element index.
 *
 * Selector resolution needs one question answered — what is indexed under this
 * selector — and asking for the whole indexer instead would drag its scanning,
 * watching, and persistence into every caller, including the ones that only have a
 * cached snapshot to offer.
 * @module
 */

import type { AngularElementData } from "../types";

/** Answers what a project has indexed under a selector. */
export interface ElementLookup {
  getElements(selector: string): AngularElementData[];
}
