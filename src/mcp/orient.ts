/**
 * What kind of Angular project this is, in one answer.
 *
 * The failure this is for is the one that costs a whole file rather than one binding: a
 * model writes Angular Material in a workspace built on ng-zorro, or NgModules in a
 * workspace that has none, or relative paths where every file uses an alias. Each is
 * correct Angular and wrong here, and none of it can be known from training — it is a
 * fact about this repository and nothing else.
 *
 * Meant to be asked once, before the first file is written.
 * @module
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ts } from "ts-morph";
import type { AngularElementData } from "../types";
import type { TemplateProject } from "./verify-template";

/** How many libraries one answer names. */
const LIBRARY_LIMIT = 8;

/** How many path aliases it names. A monorepo can declare a hundred; a model needs the shape. */
const ALIAS_LIMIT = 12;

/** One library, and how much of this workspace actually reaches for it. */
export interface LibraryUse {
  /** The package, not the entry point: `ng-zorro-antd`, not `ng-zorro-antd/table`. */
  name: string;
  /** How many of the project's own files import from it. What "used" means here. */
  importedBy: number;
  /** How many indexed elements it offers, which is availability rather than use. */
  elements: number;
}

/** What `orient` answers. */
export interface Orientation {
  root: string;
  /** The installed `@angular/core`, or what the manifest asks for when it is not installed. */
  angular?: string;
  /** The project's own elements, split by whether they can carry `imports` of their own. */
  own: { standalone: number; nonStandalone: number };
  /** Elements reachable from installed libraries. */
  fromLibraries: number;
  /** Most used first; a library nothing imports is still listed, with zero. */
  libraries: LibraryUse[];
  /** Further libraries beyond the ones named. */
  moreLibraries: number;
  /** `compilerOptions.paths`, which is how imports are written where it has entries. */
  aliases: Record<string, string[]>;
  /** Further aliases beyond the ones named. */
  moreAliases: number;
}

export interface OrientRequest {
  runtime: TemplateProject & {
    listSourceFiles(): Promise<string[]>;
    tsConfig: { paths: Record<string, string[]> } | null;
  };
}

/**
 * Describes the project a file belongs to.
 * @param request The project to describe.
 */
export async function orient(request: OrientRequest): Promise<Orientation> {
  const { runtime } = request;
  const elements = unique(runtime.indexer.searchWithSelectors(""));

  const own = { standalone: 0, nonStandalone: 0 };
  const offered = new Map<string, number>();
  for (const element of elements) {
    if (element.isExternal) {
      offered.set(packageOf(element.path), (offered.get(packageOf(element.path)) ?? 0) + 1);
      continue;
    }
    if (element.isStandalone) {
      own.standalone += 1;
    } else {
      own.nonStandalone += 1;
    }
  }

  const importedBy = await countImporters(runtime, new Set(offered.keys()));
  const libraries = [...offered.entries()]
    .map(([name, count]) => ({ name, importedBy: importedBy.get(name) ?? 0, elements: count }))
    .sort((one, other) => other.importedBy - one.importedBy || other.elements - one.elements);

  return {
    root: runtime.rootPath,
    angular: await angularVersion(runtime.rootPath),
    own,
    fromLibraries: elements.length - own.standalone - own.nonStandalone,
    libraries: libraries.slice(0, LIBRARY_LIMIT),
    moreLibraries: Math.max(0, libraries.length - LIBRARY_LIMIT),
    ...someAliases(runtime.tsConfig?.paths ?? {}),
  };
}

/**
 * Enough aliases to show how imports are written here, and a count of the rest.
 *
 * The shape is the answer — that `@lib/*` maps into `libs/` — not the enumeration. A
 * workspace declaring a hundred of them would otherwise spend the whole reply on paths
 * the agent will never write.
 * @internal
 */
function someAliases(paths: Record<string, string[]>): { aliases: Record<string, string[]>; moreAliases: number } {
  const entries = Object.entries(paths);
  return {
    aliases: Object.fromEntries(entries.slice(0, ALIAS_LIMIT)),
    moreAliases: Math.max(0, entries.length - ALIAS_LIMIT),
  };
}

/**
 * How many of the project's own files import from each package.
 *
 * Read with `ts.preProcessFile`, the compiler's own scanner for a file's imports: it
 * finds every module specifier without parsing the file, which is what makes asking it
 * of a whole workspace affordable. Counting availability instead would say a workspace
 * with both Material and ng-zorro installed uses both, which is exactly the question a
 * model needs answered and the one availability cannot answer.
 * @internal
 */
async function countImporters(
  runtime: OrientRequest["runtime"],
  packages: ReadonlySet<string>
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const files = await runtime.listSourceFiles();

  await Promise.all(
    files.map(async (filePath) => {
      let text: string;
      try {
        text = await fs.readFile(filePath, "utf8");
      } catch {
        return;
      }

      const reached = new Set<string>();
      for (const imported of ts.preProcessFile(text, true, false).importedFiles) {
        const name = packageOf(imported.fileName);
        if (packages.has(name)) {
          reached.add(name);
        }
      }
      // Per file, not per statement: a file importing four entry points of one library
      // is one file that uses it.
      for (const name of reached) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    })
  );

  return counts;
}

/**
 * The package a specifier belongs to.
 *
 * `@angular/material/button` is `@angular/material` and `ng-zorro-antd/table` is
 * `ng-zorro-antd`: a scope counts as part of the name, and everything past it is an
 * entry point of the same library.
 * @internal
 */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** @internal */
function unique(indexed: Array<{ element: AngularElementData }>): AngularElementData[] {
  const seen = new Map<string, AngularElementData>();
  for (const { element } of indexed) {
    seen.set(`${element.name} ${element.path}`, element);
  }
  return [...seen.values()];
}

/**
 * The Angular the project actually runs on.
 *
 * The installed version rather than the range the manifest asks for, because a range is
 * a wish and `^20.0.0` in a workspace holding 22 tells a model the wrong decade of
 * syntax. The manifest is the fallback for a workspace with nothing installed.
 * @internal
 */
async function angularVersion(root: string): Promise<string | undefined> {
  const installed = await readJson(path.join(root, "node_modules", "@angular", "core", "package.json"));
  if (typeof installed?.version === "string") {
    return installed.version;
  }

  const manifest = await readJson(path.join(root, "package.json"));
  const dependencies = { ...(manifest?.dependencies as object), ...(manifest?.devDependencies as object) } as Record<
    string,
    string
  >;
  return dependencies["@angular/core"];
}

/** @internal */
async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
