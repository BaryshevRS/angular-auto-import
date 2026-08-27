/**
 * How much of a workspace actually reaches for each installed library.
 *
 * Availability is the wrong measure and the v22 fixture says so plainly: ng-zorro offers
 * 311 indexed elements there against Angular Material's 182, while three of the
 * workspace's files import ng-zorro and eight import Material. A model told what is
 * installed writes the wrong library with the bigger number; a model told what is used
 * writes what the repository writes.
 * @module
 */

import { promises as fs } from "node:fs";
import { ts } from "ts-morph";

/** What counting needs from the project, which is its files and nothing else. */
export interface ImportScannable {
  rootPath: string;
  listSourceFiles(): Promise<string[]>;
}

/**
 * How many of the project's own files import from each package.
 *
 * Read with `ts.preProcessFile`, the compiler's own scanner for a file's imports: it
 * finds every module specifier without parsing the file, which is what makes asking it
 * of a whole workspace affordable.
 * @param project The project whose files to read.
 * @param packages The packages worth counting; anything else is ignored.
 */
export async function countImporters(
  project: ImportScannable,
  packages: ReadonlySet<string>
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const files = await project.listSourceFiles();

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
 * @param specifier A module specifier, or the path an element is indexed under.
 */
export function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}
