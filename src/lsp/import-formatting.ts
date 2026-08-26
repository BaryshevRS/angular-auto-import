/**
 * Reads the part of a project's formatting configuration that affects generated Angular
 * imports: four values, out of whichever of Prettier's config files and EditorConfig the
 * project happens to have.
 *
 * Prettier itself is not a dependency, and reading these four values never needed it to
 * be one. The import planner does the formatting with ts-morph — the whole file is never
 * handed to a formatter, so all that was ever wanted here is the numbers. Requiring the
 * package to get them meant shipping its parsers, which this module never opens.
 *
 * Only the declarative formats are read. A project configuring Prettier from JavaScript,
 * TypeScript, YAML or TOML still counts as having a config — that is what selects
 * Prettier's defaults over the planner's own — but its values are not read: running the
 * file would execute project code inside the server, and a project that configures
 * Prettier at all has already opted into its 80 columns for the options it leaves alone.
 * @module
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { DEFAULT_IMPORT_FORMATTING, type ImportFormattingOptions } from "../core/import-planner";
import { type CoreLogger, silentLogger } from "../core/logging";

/** Prettier's effective defaults once a project has opted into its configuration. */
const PRETTIER_IMPORT_FORMATTING: Required<ImportFormattingOptions> = {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  singleQuote: false,
};

/**
 * Prettier's config files, in the order it looks for them within one directory. The ones
 * this module cannot read are listed too: finding one still says the project has a
 * config, which is the part that decides which defaults apply.
 */
const PRETTIER_CONFIG_FILES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.json5",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  ".prettierrc.toml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
];

/** Those of the above whose contents are JSON, and so can be read rather than run. */
const JSON_CONFIG_FILES = new Set([".prettierrc", ".prettierrc.json", ".prettierrc.json5"]);

/** The four values, as far as one source could supply them. */
type PartialFormatting = Partial<Required<ImportFormattingOptions>>;

/** What one `.editorconfig` file says about the component being formatted. */
interface EditorConfigFile {
  /** `root = true`, which stops the search at this directory. */
  root: boolean;
  values: PartialFormatting;
}

/** Resolves Prettier and EditorConfig settings for one component file. */
export async function resolveImportFormatting(
  filePath: string,
  logger: CoreLogger = silentLogger
): Promise<ImportFormattingOptions> {
  try {
    const absolutePath = path.resolve(filePath);
    const { prettier, editorConfig, found } = await readConfiguration(absolutePath);
    if (!found) {
      return DEFAULT_IMPORT_FORMATTING;
    }

    return { ...PRETTIER_IMPORT_FORMATTING, ...editorConfig, ...prettier };
  } catch (error) {
    logger.warn(`[ImportFormatting] Could not resolve formatting for ${filePath}: ${String(error)}`);
    return DEFAULT_IMPORT_FORMATTING;
  }
}

/**
 * Walks up from the component's directory, collecting both kinds of configuration.
 *
 * The two searches end differently, which is why they share one walk rather than one
 * stopping rule: Prettier's stops at the first config file it meets, EditorConfig's
 * continues until a file declares itself `root` or the filesystem runs out.
 * @internal
 */
async function readConfiguration(filePath: string): Promise<{
  prettier: PartialFormatting;
  editorConfig: PartialFormatting;
  found: boolean;
}> {
  const prettier: PartialFormatting = {};
  const editorConfig: PartialFormatting = {};
  let prettierFound = false;
  let editorConfigFound = false;
  let editorConfigDone = false;
  let directory = path.dirname(filePath);

  while (!(prettierFound && editorConfigDone)) {
    const entries = await directoryEntries(directory);

    if (!prettierFound) {
      const values = await readPrettierConfig(directory, entries);
      if (values) {
        Object.assign(prettier, values);
        prettierFound = true;
      }
    }

    if (!editorConfigDone && entries.has(".editorconfig")) {
      const file = await readEditorConfig(directory, filePath);
      editorConfigFound = mergeDistant(editorConfig, file?.values) || editorConfigFound;
      editorConfigDone = file?.root ?? false;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  return { prettier, editorConfig, found: prettierFound || editorConfigFound };
}

/**
 * Merges what a further-away config said into what a closer one already settled, and
 * reports whether it had anything to say at all — an `.editorconfig` stating nothing
 * this module reads must not count as the project having a configuration.
 * @internal
 */
function mergeDistant(into: PartialFormatting, values: PartialFormatting | undefined): boolean {
  let contributed = false;
  for (const [key, value] of Object.entries(values ?? {})) {
    contributed = true;
    if (!(key in into)) {
      Object.assign(into, { [key]: value });
    }
  }
  return contributed;
}

/**
 * The Prettier configuration declared in one directory, or `undefined` when it declares
 * none. An empty object means a config this module does not read — present, but silent.
 * @internal
 */
async function readPrettierConfig(directory: string, entries: Set<string>): Promise<PartialFormatting | undefined> {
  if (entries.has("package.json")) {
    const manifest = await readJsonFile(path.join(directory, "package.json"));
    if (manifest && "prettier" in manifest) {
      const section = manifest.prettier;
      return typeof section === "object" && section !== null ? pickFormatting(section as Record<string, unknown>) : {};
    }
  }

  for (const name of PRETTIER_CONFIG_FILES) {
    if (!entries.has(name)) {
      continue;
    }
    if (!JSON_CONFIG_FILES.has(name)) {
      return {};
    }
    const parsed = await readJsonFile(path.join(directory, name));
    return parsed ? pickFormatting(parsed) : {};
  }

  return undefined;
}

/** Reads the `.editorconfig` in one directory as it applies to one file. @internal */
async function readEditorConfig(directory: string, filePath: string): Promise<EditorConfigFile | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(directory, ".editorconfig"), "utf8");
  } catch {
    return undefined;
  }

  const { root, sections } = parseEditorConfig(text);
  const settings = new Map<string, string>();
  for (const section of sections) {
    if (!sectionMatches(section.pattern, directory, filePath)) {
      continue;
    }
    // A later matching section overrides an earlier one, which is EditorConfig's own rule.
    for (const [key, value] of section.settings) {
      settings.set(key, value);
    }
  }

  return { root, values: editorConfigFormatting(settings) };
}

/** One `[pattern]` block and what it sets. @internal */
interface EditorConfigSection {
  pattern: string;
  settings: Map<string, string>;
}

/** Splits an `.editorconfig` into its preamble and its sections, without interpreting either. @internal */
function parseEditorConfig(text: string): { root: boolean; sections: EditorConfigSection[] } {
  const sections: EditorConfigSection[] = [];
  let root = false;
  let current: EditorConfigSection | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      current = { pattern: line.slice(1, -1), settings: new Map() };
      sections.push(current);
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .toLowerCase();

    if (current) {
      current.settings.set(key, value);
    } else if (key === "root") {
      root = value === "true";
    }
  }

  return { root, sections };
}

/** The three EditorConfig settings that say anything about a generated import. @internal */
function editorConfigFormatting(settings: Map<string, string>): PartialFormatting {
  const values: PartialFormatting = {};

  const indentStyle = settings.get("indent_style");
  if (indentStyle === "tab" || indentStyle === "space") {
    values.useTabs = indentStyle === "tab";
  }

  const maxLineLength = settings.get("max_line_length");
  const printWidth = maxLineLength === "off" ? undefined : positiveInteger(maxLineLength);
  if (printWidth !== undefined) {
    values.printWidth = printWidth;
  }

  // `indent_size = tab` defers to `tab_width`; otherwise it is the width itself.
  const indentSize = settings.get("indent_size");
  const declaredWidth = positiveInteger(settings.get("tab_width"));
  const tabWidth = indentSize === "tab" ? declaredWidth : (positiveInteger(indentSize) ?? declaredWidth);
  if (tabWidth !== undefined) {
    values.tabWidth = tabWidth;
  }

  return values;
}

/**
 * Whether one `.editorconfig` section header applies to the file being formatted.
 *
 * A pattern holding no `/` matches the name anywhere below the config, which is what
 * makes the near-universal `[*]` and `[*.ts]` work; one that holds a `/` is relative to
 * the directory the config sits in.
 * @internal
 */
function sectionMatches(pattern: string, directory: string, filePath: string): boolean {
  const relative = path.relative(directory, filePath).split(path.sep).join("/");
  if (relative === "" || relative.startsWith("..")) {
    return false;
  }

  const normalized = pattern.includes("/") ? pattern.replace(/^\//, "") : `**/${pattern}`;
  try {
    return new RegExp(`^${globToRegExp(normalized)}$`).test(relative);
  } catch {
    return false;
  }
}

/**
 * The pieces a section header breaks into: the wildcards, a braced alternation, a
 * character class, and runs of literal text. Anything left over is one literal character,
 * which is what an unbalanced `{` or `[` becomes.
 */
const GLOB_TOKEN = /\*\*\/|\*\*|\*|\?|\{[^}]*\}|\[[^\]]*\]|[^*?{[]+|[\s\S]/g;

/** Translates the glob syntax EditorConfig section headers use into a regular expression. @internal */
function globToRegExp(pattern: string): string {
  return (pattern.match(GLOB_TOKEN) ?? []).map(globTokenToRegExp).join("");
}

/** @internal */
function globTokenToRegExp(token: string): string {
  switch (token) {
    // A leading `**/` has to match nothing at all, so that `**/*.ts` covers `a.ts`.
    case "**/":
      return "(?:.*/)?";
    case "**":
      return ".*";
    case "*":
      return "[^/]*";
    case "?":
      return "[^/]";
    default:
      break;
  }

  if (token.startsWith("{") && token.endsWith("}")) {
    return `(?:${token.slice(1, -1).split(",").map(globToRegExp).join("|")})`;
  }
  if (token.startsWith("[") && token.endsWith("]")) {
    const body = token.slice(1, -1);
    return `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
  }
  return token.replace(/[.+^$|()\\[\]{}]/g, "\\$&");
}

/** Every name in a directory, or none when it cannot be read. @internal */
async function directoryEntries(directory: string): Promise<Set<string>> {
  try {
    return new Set(await fs.readdir(directory));
  } catch {
    return new Set();
  }
}

/** Reads a JSON file, treating anything unparseable as absent. @internal */
async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The four values a Prettier config can supply, ignoring anything it states badly. @internal */
function pickFormatting(config: Record<string, unknown>): PartialFormatting {
  const values: PartialFormatting = {};
  if (isPositiveInteger(config.printWidth)) {
    values.printWidth = config.printWidth;
  }
  if (isPositiveInteger(config.tabWidth)) {
    values.tabWidth = config.tabWidth;
  }
  if (typeof config.useTabs === "boolean") {
    values.useTabs = config.useTabs;
  }
  if (typeof config.singleQuote === "boolean") {
    values.singleQuote = config.singleQuote;
  }
  return values;
}

/** @internal */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @internal */
function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
