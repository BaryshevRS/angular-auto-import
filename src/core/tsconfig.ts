/**
 * Reads a project's `tsconfig.json` and turns absolute module paths back into the
 * import specifiers a developer would have written.
 *
 * Each project root gets its own resolver, so a runtime holding several roots never
 * resolves one project's aliases against another's configuration.
 *
 * Where a `paths` entry points is `get-tsconfig`'s answer, not ours. The rule is not
 * "resolve against `baseUrl`": when `baseUrl` is absent TypeScript resolves the entry
 * against the directory of the config file that *declared* it, which in a monorepo is
 * the shared base config several directories above the one being read. Getting that
 * wrong points every alias at a directory that does not exist, silently. `get-tsconfig`
 * tracks the declaring file through `extends`, so {@link resolveAliasTargets} asks it
 * rather than recomputing the rule here.
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createPathsMatcher, type getTsconfig, parseTsconfig } from "get-tsconfig";
import type { AliasTarget, ProcessedTsConfig } from "../types/tsconfig";
import { getRelativeFilePath, isPathInside, normalizePath, switchFileType } from "../utils/path";
import { type CoreLogger, silentLogger } from "./logging";
import type { ImportModuleSpecifierPreference } from "./settings";

/**
 * Stands in for a `*` while an alias is put through the paths matcher.
 *
 * The matcher answers for module specifiers, not for patterns, so a wildcard entry is
 * asked about one concrete specifier and the answer is turned back into a pattern. The
 * placeholder only has to be something no path contains.
 * @internal
 */
const WILDCARD_PLACEHOLDER = "__angular_auto_import_wildcard__";

/**
 * Represents a node in a Trie data structure for storing path aliases.
 * @internal
 */
class TrieNode {
  public children: Map<string, TrieNode> = new Map();
  /** The alias corresponding to the path to this node (e.g., '@app'). */
  public alias?: string;
  /** True if the alias is "barrel-style" (non-wildcard) and should not have the rest of the path appended. */
  public isBarrel?: boolean;
}

/**
 * A prefix tree for efficiently finding the longest path prefix,
 * which allows finding the most specific (and shortest) alias.
 *
 * The keys are absolute paths. An alias and the file it covers need not belong to the
 * same project: in a monorepo the `paths` entry is declared at the workspace root and
 * points at a sibling of the project doing the importing. Anchoring both the entries
 * and the lookups at the file system root is what lets that match at all, and removes
 * the question of which of the two directories everything is relative to.
 * @internal
 */
class PathAliasTrie {
  private readonly root: TrieNode = new TrieNode();

  constructor(targets: readonly AliasTarget[]) {
    for (const target of targets) {
      this.addTarget(target);
    }
  }

  /**
   * Files one alias under the absolute directory (or module) it resolves to.
   *
   * An entry whose `*` sits in the middle of the path is not added. Such an entry maps
   * a name into the path rather than appending to it, so the trie — which can only put
   * back what it did not consume — would answer with a specifier that does not resolve.
   * Those files are still indexed; they are imported by a relative path instead.
   * @internal
   */
  private addTarget(target: AliasTarget): void {
    const modulePath = aliasModuleRoot(target);
    if (modulePath.includes("*")) {
      return;
    }

    let currentNode = this.root;
    for (const segment of pathKeySegments(modulePath)) {
      if (!currentNode.children.has(segment)) {
        currentNode.children.set(segment, new TrieNode());
      }
      const nextNode = currentNode.children.get(segment);
      if (!nextNode) {
        throw new Error("Unexpected missing node in alias trie insertion");
      }
      currentNode = nextNode;
    }
    currentNode.alias = target.alias;
    currentNode.isBarrel = !target.isWildcard;
  }

  /**
   * Finds the longest prefix match for a given path in the Trie.
   * @param absoluteTargetPath The absolute path to the module (without extension).
   * @returns An object with the final import path or null. `matchedRootPath` is absolute.
   */
  public findLongestPrefixMatch(
    absoluteTargetPath: string
  ): { importPath: string; isBarrel?: boolean; matchedRootPath: string } | null {
    const pathSegments = this.getPathSegments(normalizePath(absoluteTargetPath));
    const longestMatch = this.findLongestMatchInTrie(pathSegments.lower, pathSegments.original);

    if (!longestMatch) {
      return null;
    }

    const importPath = this.buildImportPath(longestMatch, pathSegments.original);
    const matchedRootPath = ancestorAtDepth(absoluteTargetPath, longestMatch.depth);
    return { importPath, isBarrel: longestMatch.isBarrel, matchedRootPath };
  }

  /**
   * Gets path segments in both original case and lowercase.
   */
  private getPathSegments(targetPath: string): { original: string[]; lower: string[] } {
    const original = targetPath.split("/").filter((p) => p.length > 0);
    const lower = original.map((segment) => segment.toLowerCase());

    return { original, lower };
  }

  /**
   * Finds the longest match in the trie structure.
   */
  private findLongestMatchInTrie(
    lowerPathSegments: string[],
    _originalPathSegments: string[]
  ): { alias: string; depth: number; isBarrel?: boolean } | null {
    let currentNode = this.root;
    let longestMatch = this.getInitialMatch();

    for (let i = 0; i < lowerPathSegments.length; i++) {
      const segment = lowerPathSegments[i];

      if (!this.hasChildNode(currentNode, segment)) {
        break;
      }

      currentNode = currentNode.children.get(segment) as TrieNode;

      if (currentNode.alias) {
        longestMatch = {
          alias: currentNode.alias,
          depth: i + 1,
          isBarrel: currentNode.isBarrel,
        };
      }
    }

    return longestMatch;
  }

  /**
   * Gets the initial match if the root has an alias.
   */
  private getInitialMatch(): { alias: string; depth: number; isBarrel?: boolean } | null {
    if (this.root.alias) {
      return {
        alias: this.root.alias,
        depth: 0,
        isBarrel: this.root.isBarrel,
      };
    }
    return null;
  }

  /**
   * Checks if a node has a child with the given segment.
   */
  private hasChildNode(node: TrieNode, segment: string): boolean {
    return node.children.has(segment) && node.children.get(segment) !== undefined;
  }

  /**
   * Builds the final import path from the longest match.
   */
  private buildImportPath(
    longestMatch: { alias: string; depth: number; isBarrel?: boolean },
    originalPathSegments: string[]
  ): string {
    if (longestMatch.isBarrel) {
      return longestMatch.alias;
    }

    const remainingSegments = originalPathSegments.slice(longestMatch.depth);
    const remainingPath = remainingSegments.join("/");
    return normalizePath(path.posix.join(longestMatch.alias, remainingPath));
  }
}

/**
 * Resolves every `paths` entry of a parsed config to where its files actually live.
 *
 * The resolution is `get-tsconfig`'s. Its paths matcher documents the three things this
 * depends on: a config that declares `paths` without a `baseUrl` treats its own
 * directory as the implicit base — which through `extends` is the ancestor that
 * declared them, not the file being read; every substitution of an entry is returned,
 * not just the first; and the answers are absolute. It answers for module specifiers
 * rather than for patterns, so a wildcard entry is asked about one specifier built with
 * {@link WILDCARD_PLACEHOLDER} and the `*` is put back into the answer.
 * @param tsconfigPath Absolute path of the config the entries were read from.
 * @param config The config as `parseTsconfig` returned it, `extends` already resolved.
 * @param logger Reports entries the matcher rejected.
 */
export function resolveAliasTargets(
  tsconfigPath: string,
  config: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } },
  logger: CoreLogger = silentLogger
): AliasTarget[] {
  let matchPath: ((specifier: string) => string[]) | null;
  try {
    matchPath = createPathsMatcher({ path: tsconfigPath, config } as Parameters<typeof createPathsMatcher>[0]);
  } catch (error) {
    // The matcher rejects the whole config when one entry is malformed: a non-relative
    // substitution with no `baseUrl` is the documented case, and TypeScript rejects it
    // too. Losing every alias is bad enough without also losing the index.
    logger.warn(`[TsConfigHelper] Cannot resolve path aliases in ${tsconfigPath}: ${(error as Error).message}`);
    return [];
  }
  if (!matchPath) {
    return [];
  }

  const targets: AliasTarget[] = [];
  for (const alias of Object.keys(config.compilerOptions?.paths ?? {})) {
    const isWildcard = alias.includes("*");
    // Every substitution, not just the first: an entry may list several places the same
    // name resolves from, and each of them is code this project can reach.
    const resolved = matchPath(isWildcard ? alias.replace("*", WILDCARD_PLACEHOLDER) : alias);
    if (resolved.length === 0) {
      logger.warn(`[TsConfigHelper] Skipped alias '${alias}': it resolves to nothing`);
      continue;
    }
    for (const physicalPath of resolved) {
      targets.push({
        alias: alias.replace(/\/?\*$/, ""),
        isWildcard,
        physicalPath: isWildcard ? physicalPath.replace(WILDCARD_PLACEHOLDER, "*") : physicalPath,
      });
    }
  }
  return targets;
}

/**
 * The directories an alias entry's files live in, which is what a scan has to reach.
 *
 * Everything up to the first `*` is a real directory; past it the entry describes
 * names rather than places. A non-wildcard entry names one module, so its directory is
 * the one holding it.
 * @param targets The resolved entries.
 */
export function aliasRootDirectories(targets: readonly AliasTarget[]): string[] {
  const directories = new Set<string>();
  for (const target of targets) {
    const wildcardIndex = target.physicalPath.indexOf("*");
    const upToWildcard =
      wildcardIndex === -1 ? target.physicalPath : normalizePath(target.physicalPath).slice(0, wildcardIndex);
    const trimmed = upToWildcard.replace(/[\\/]+$/, "");
    if (trimmed === "") {
      continue;
    }
    directories.add(path.resolve(path.extname(trimmed) === "" ? trimmed : path.dirname(trimmed)));
  }
  return Array.from(directories);
}

/**
 * The path an alias stands for, as the trie keys it: a barrel's directory, a module
 * without its extension, or a wildcard entry's fixed prefix.
 * @internal
 */
function aliasModuleRoot(target: AliasTarget): string {
  if (target.isWildcard) {
    return normalizePath(target.physicalPath).replace(/\/?\*$/, "");
  }
  if (path.basename(target.physicalPath) === "index.ts") {
    return path.dirname(target.physicalPath);
  }
  return switchFileType(target.physicalPath, "");
}

/**
 * The case-insensitive segments a path is keyed and looked up by.
 * @internal
 */
function pathKeySegments(absolutePath: string): string[] {
  return normalizePath(absolutePath)
    .toLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0);
}

/**
 * The ancestor of a path that is `depth` segments deep, keeping it absolute.
 * @internal
 */
function ancestorAtDepth(absolutePath: string, depth: number): string {
  const normalized = normalizePath(absolutePath);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return (normalized.startsWith("/") ? "/" : "") + segments.slice(0, depth).join("/");
}

/**
 * Resolves and caches one project's TypeScript configuration and path aliases.
 *
 * The caches are per instance: a host that owns several project roots keeps one
 * resolver per root, and disposing that root drops only its entries.
 */
export class TsConfigResolver {
  private readonly tsConfigCache: Map<string, ProcessedTsConfig | null> = new Map();
  private readonly trieCache: Map<string, PathAliasTrie | null> = new Map();
  private readonly logger: CoreLogger;

  constructor(options: { logger?: CoreLogger } = {}) {
    this.logger = options.logger ?? silentLogger;
  }

  /**
   * Clears the tsconfig and trie caches.
   * @param projectRoot If provided, only clears the cache for that project.
   */
  clearCache(projectRoot?: string): void {
    if (projectRoot) {
      this.tsConfigCache.delete(projectRoot);
      this.trieCache.delete(projectRoot);
      this.logger.info(`TsConfigHelper cache cleared for ${projectRoot}.`);
    } else {
      this.tsConfigCache.clear();
      this.trieCache.clear();
      this.logger.info("TsConfigHelper cache fully cleared.");
    }
  }

  /**
   * Finds and parses the `tsconfig.json` or `tsconfig.base.json` file for a given project.
   * @param projectRoot The root directory of the project.
   * @returns A processed tsconfig object or `null` if not found.
   */
  async findAndParseTsConfig(projectRoot: string): Promise<ProcessedTsConfig | null> {
    const cacheKey = projectRoot;

    if (this.tsConfigCache.has(cacheKey)) {
      const cached = this.tsConfigCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    try {
      // Look for tsconfig.json or tsconfig.base.json in the project root
      const tsconfigPath = path.join(projectRoot, "tsconfig.json");
      const tsconfigBasePath = path.join(projectRoot, "tsconfig.base.json");

      let tsconfigResult: ReturnType<typeof getTsconfig> = null;
      let actualTsconfigPath: string | null = null;

      // Check for existing files and try to parse them
      if (fs.existsSync(tsconfigPath)) {
        tsconfigResult = this.parseConfigFile(tsconfigPath);
        actualTsconfigPath = tsconfigPath;
      } else if (fs.existsSync(tsconfigBasePath)) {
        tsconfigResult = this.parseConfigFile(tsconfigBasePath);
        actualTsconfigPath = tsconfigBasePath;
      }

      // Validate that the found tsconfig is actually within our project directory
      if (tsconfigResult && !isPathInside(projectRoot, tsconfigResult.path)) {
        this.logger.warn(`[TsConfigHelper] Found tsconfig outside project root: ${tsconfigResult.path}`);
        tsconfigResult = null;
      }

      // Ensure the found tsconfig is the expected one
      if (tsconfigResult && actualTsconfigPath && tsconfigResult.path !== actualTsconfigPath) {
        this.logger.warn(
          `[TsConfigHelper] get-tsconfig returned different path than expected: ${tsconfigResult.path} vs ${actualTsconfigPath}`
        );
        // Only allow if it's still within our project directory
        if (!isPathInside(projectRoot, tsconfigResult.path)) {
          tsconfigResult = null;
        }
      }

      if (!tsconfigResult) {
        this.logger.warn(`[TsConfigHelper] No valid tsconfig found for ${projectRoot}`);
        this.tsConfigCache.set(cacheKey, null);
        this.trieCache.set(cacheKey, null);
        return null;
      }

      const config = tsconfigResult.config;
      const absoluteBaseUrl = path.resolve(path.dirname(tsconfigResult.path), config.compilerOptions?.baseUrl || ".");
      const paths = config.compilerOptions?.paths || {};
      const aliasTargets = resolveAliasTargets(tsconfigResult.path, config, this.logger);

      const processedConfig: ProcessedTsConfig = {
        absoluteBaseUrl,
        paths,
        aliasTargets,
        aliasRoots: aliasRootDirectories(aliasTargets),
        sourceFilePath: tsconfigResult.path,
      };
      this.tsConfigCache.set(cacheKey, processedConfig);

      // Create and cache a Trie for resolving aliases
      this.trieCache.set(cacheKey, new PathAliasTrie(aliasTargets));

      return processedConfig;
    } catch (e) {
      this.logger.error(`[TsConfigHelper] Error parsing tsconfig for ${projectRoot}:`, e as Error);
      this.tsConfigCache.set(cacheKey, null);
      this.trieCache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Resolves an absolute module path to an import path, using a
   * tsconfig alias (via the Trie) or falling back to a relative path.
   * @param absoluteTargetModulePathNoExt Absolute path to the file to be imported, without extension.
   * @param absoluteCurrentFilePath Absolute path to the file where the import will be added.
   * @param projectRoot The root directory of the current project.
   * @returns A string for the import statement (e.g., '@app/components/my-comp' or '../../my-comp').
   */
  async resolveImportPath(
    absoluteTargetModulePathNoExt: string,
    absoluteCurrentFilePath: string,
    projectRoot: string,
    preference: ImportModuleSpecifierPreference = "non-relative"
  ): Promise<string> {
    // Handle empty target path
    if (!absoluteTargetModulePathNoExt || absoluteTargetModulePathNoExt.trim() === "") {
      return ".";
    }

    const trie = await this.getOrCreateTrie(projectRoot);
    const relativePath = getRelativeFilePath(absoluteCurrentFilePath, absoluteTargetModulePathNoExt);

    if (preference === "relative") {
      return relativePath;
    }

    // The aliases are asked first, and about targets outside the project root as well.
    // A `paths` entry pointing outside is not an accident to be guarded against: it is
    // how a monorepo says a library belongs to this project's compilation, and the
    // specifier it gives is the only correct way to import across that boundary.
    const aliasMatch = this.findAliasMatch(trie, absoluteTargetModulePathNoExt, absoluteCurrentFilePath, relativePath);
    if (aliasMatch) {
      return selectImportPath(
        aliasMatch,
        relativePath,
        preference,
        absoluteTargetModulePathNoExt,
        absoluteCurrentFilePath,
        projectRoot
      );
    }

    // No alias covers it, so the paths have to be within reach of one another — unless
    // the target is somewhere this project's own aliases put in scope. An entry whose
    // `*` sits mid-path maps a library in without giving the trie a specifier it can
    // rebuild, and a file reached that way is inside the compilation but outside the
    // root: the one thing it must not get is an absolute path, which is not an import
    // any TypeScript file can carry.
    if (await this.isInAliasScope(absoluteTargetModulePathNoExt, projectRoot)) {
      return relativePath;
    }

    const pathValidation = this.validateProjectPaths(
      absoluteTargetModulePathNoExt,
      absoluteCurrentFilePath,
      projectRoot
    );
    if (pathValidation.shouldReturn) {
      return pathValidation.path;
    }

    // Fallback: calculate relative path
    return relativePath;
  }

  /**
   * Parses a tsconfig file and handles potential errors.
   * @param filePath The full path to the tsconfig file.
   * @returns The parsed tsconfig object or null if an error occurs.
   * @internal
   */
  private parseConfigFile(filePath: string): ReturnType<typeof getTsconfig> {
    try {
      const parseResult = parseTsconfig(filePath);
      return parseResult ? { path: filePath, config: parseResult } : null;
    } catch (parseError) {
      this.logger.warn(`[TsConfigHelper] Failed to parse ${filePath}: ${(parseError as Error).message}`);
      return null;
    }
  }

  /**
   * Whether a path is inside one of the directories this project's `paths` map in.
   * @internal
   */
  private async isInAliasScope(absoluteTargetPath: string, projectRoot: string): Promise<boolean> {
    const tsconfig = await this.loadTsConfig(projectRoot);
    return (tsconfig?.aliasRoots ?? []).some((aliasRoot) => isPathInside(aliasRoot, absoluteTargetPath));
  }

  /** @internal */
  private validateProjectPaths(
    absoluteTargetModulePathNoExt: string,
    absoluteCurrentFilePath: string,
    projectRoot: string
  ): { shouldReturn: boolean; path: string } {
    // Check that target file is within the project boundaries
    if (!isPathInside(projectRoot, absoluteTargetModulePathNoExt)) {
      this.logger.warn(`[TsConfigHelper] Target file is outside project root, using absolute path`);
      return { shouldReturn: true, path: absoluteTargetModulePathNoExt };
    }

    // Check that current file is within the project boundaries
    if (!isPathInside(projectRoot, absoluteCurrentFilePath)) {
      this.logger.warn(`[TsConfigHelper] Current file is outside project root, using relative path fallback`);
      const relativePath = getRelativeFilePath(absoluteCurrentFilePath, absoluteTargetModulePathNoExt);
      return { shouldReturn: true, path: relativePath };
    }

    return { shouldReturn: false, path: "" };
  }

  /** @internal */
  private async getOrCreateTrie(projectRoot: string): Promise<PathAliasTrie | null> {
    const trie = this.trieCache.get(projectRoot);

    if (trie) {
      return trie;
    }

    // Attempt to load tsconfig and create the trie
    const tsconfig = await this.loadTsConfig(projectRoot);
    if (!tsconfig) {
      return null;
    }

    try {
      const newTrie = new PathAliasTrie(tsconfig.aliasTargets);
      this.trieCache.set(projectRoot, newTrie);
      return newTrie;
    } catch (error) {
      this.logger.error(`[TsConfigHelper] Error creating new trie:`, error as Error);
      return null;
    }
  }

  /** @internal */
  private async loadTsConfig(projectRoot: string): Promise<ProcessedTsConfig | null> {
    const tsconfig = this.tsConfigCache.get(projectRoot);

    if (tsconfig) {
      return tsconfig;
    }

    try {
      return await this.findAndParseTsConfig(projectRoot);
    } catch (error) {
      this.logger.error(`[TsConfigHelper] Error loading tsconfig from disk:`, error as Error);
      return null;
    }
  }

  /** @internal */
  private findAliasMatch(
    trie: PathAliasTrie | null,
    absoluteTargetModulePathNoExt: string,
    absoluteCurrentFilePath: string,
    relativePath: string
  ): string | null {
    if (!trie) {
      return null;
    }

    const match = trie.findLongestPrefixMatch(absoluteTargetModulePathNoExt);
    if (!match) {
      return null;
    }

    // Always prefer barrel imports over relative paths
    if (match.isBarrel) {
      if (isInsideMatchedAliasRoot(absoluteCurrentFilePath, match.matchedRootPath)) {
        return relativePath;
      }

      // A directory barrel (an `index.ts`) only covers what it actually re-exports.
      // If the target is not reachable through the barrel, fall back to a relative
      // path instead of producing a broken import. Exact-file aliases (no `index.ts`
      // at the matched root, e.g. `@deep-alias`) are always used as-is.
      const absoluteMatchedRoot = match.matchedRootPath;
      const hasBarrelIndex = fs.existsSync(path.join(absoluteMatchedRoot, "index.ts"));
      if (hasBarrelIndex && !this.barrelReExportsTarget(absoluteMatchedRoot, absoluteTargetModulePathNoExt)) {
        return relativePath;
      }

      return match.importPath;
    }

    // For non-barrel (wildcard) aliases, always prefer aliases over relative paths
    // according to the configured priority which expects clean imports
    return match.importPath;
  }

  /**
   * Determines whether the barrel `index.ts` at `barrelDir` actually re-exports
   * the target module, following nested directory re-exports recursively.
   * @param barrelDir Absolute path to the directory containing the barrel `index.ts`.
   * @param absoluteTargetModulePathNoExt Absolute path to the target module, without extension.
   * @param visited Set of already-inspected barrels, guarding against import cycles.
   * @param depth Current recursion depth, bounded to avoid runaway traversals.
   * @internal
   */
  private barrelReExportsTarget(
    barrelDir: string,
    absoluteTargetModulePathNoExt: string,
    visited: Set<string> = new Set(),
    depth = 0
  ): boolean {
    if (depth > 10) {
      return false;
    }

    const indexFile = path.join(barrelDir, "index.ts");
    if (visited.has(indexFile) || !fs.existsSync(indexFile)) {
      return false;
    }
    visited.add(indexFile);

    // The barrel module itself is reachable through its own alias.
    if (isBarrelModuleTarget(barrelDir, absoluteTargetModulePathNoExt)) {
      return true;
    }

    let content: string;
    try {
      content = fs.readFileSync(indexFile, "utf-8");
    } catch (error) {
      this.logger.warn(`[TsConfigHelper] Failed to read barrel '${indexFile}': ${(error as Error).message}`);
      return false;
    }

    for (const specifier of extractReExportSpecifiers(content)) {
      // Only relative re-exports can point back to a file inside the project.
      if (!specifier.startsWith(".")) {
        continue;
      }

      const resolved = path.resolve(barrelDir, specifier);
      if (pathsEqual(resolved, absoluteTargetModulePathNoExt)) {
        return true;
      }

      // Directory re-export (e.g. `export * from './pipes'`): recurse into its barrel.
      if (fs.existsSync(path.join(resolved, "index.ts"))) {
        if (this.barrelReExportsTarget(resolved, absoluteTargetModulePathNoExt, visited, depth + 1)) {
          return true;
        }
      }
    }

    return false;
  }
}

/**
 * Chooses between a valid tsconfig alias and a relative specifier using TypeScript's
 * import-module-specifier preference semantics.
 * @internal
 */
function selectImportPath(
  aliasPath: string,
  relativePath: string,
  preference: ImportModuleSpecifierPreference,
  absoluteTargetModulePathNoExt: string,
  absoluteCurrentFilePath: string,
  projectRoot: string
): string {
  if (aliasPath.startsWith(".")) {
    return aliasPath;
  }
  if (preference === "non-relative") {
    return aliasPath;
  }
  if (preference === "project-relative") {
    return crossesProjectBoundary(absoluteTargetModulePathNoExt, absoluteCurrentFilePath, projectRoot)
      ? aliasPath
      : relativePath;
  }

  return countPathComponents(relativePath) < countPathComponents(aliasPath) ? relativePath : aliasPath;
}

/** Matches TypeScript's comparison: `./` is not a component, every slash after it is. @internal */
function countPathComponents(moduleSpecifier: string): number {
  const start = moduleSpecifier.startsWith("./") ? 2 : 0;
  let count = 0;
  for (let index = start; index < moduleSpecifier.length; index++) {
    if (moduleSpecifier[index] === "/") {
      count++;
    }
  }
  return count;
}

/** Whether a relative import crosses the tsconfig project or a package boundary. @internal */
function crossesProjectBoundary(
  absoluteTargetModulePathNoExt: string,
  absoluteCurrentFilePath: string,
  projectRoot: string
): boolean {
  const sourceIsInternal = isPathInside(projectRoot, absoluteCurrentFilePath);
  const targetIsInternal = isPathInside(projectRoot, absoluteTargetModulePathNoExt);
  if (sourceIsInternal !== targetIsInternal) {
    return true;
  }

  return !pathsEqual(
    nearestPackageDirectory(path.dirname(absoluteCurrentFilePath)),
    nearestPackageDirectory(path.dirname(absoluteTargetModulePathNoExt))
  );
}

/** Finds the closest package boundary, if this path belongs to one. @internal */
function nearestPackageDirectory(startDirectory: string): string {
  let directory = path.resolve(startDirectory);
  for (;;) {
    if (fs.existsSync(path.join(directory, "package.json"))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return "";
    }
    directory = parent;
  }
}

/** @internal */
function isInsideMatchedAliasRoot(absoluteCurrentFilePath: string, absoluteMatchedRoot: string): boolean {
  const relativeToMatchedRoot = path.relative(absoluteMatchedRoot, absoluteCurrentFilePath);

  return (
    relativeToMatchedRoot === "" || (!relativeToMatchedRoot.startsWith("..") && !path.isAbsolute(relativeToMatchedRoot))
  );
}

/**
 * Compares two filesystem paths for equality, ignoring separator style and case.
 * @internal
 */
function pathsEqual(a: string, b: string): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

/**
 * Extracts the module specifiers of every `export ... from '...'` re-export
 * statement found in a barrel's source (covers `export *`, `export * as ns`,
 * and named/`type` re-exports).
 * @internal
 */
function extractReExportSpecifiers(content: string): string[] {
  const reExportPattern =
    /export\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z0-9_$]+)?|\{[\s\S]*?\})\s+from\s*['"]([^'"]+)['"]/g;
  const specifiers: string[] = [];

  for (let match = reExportPattern.exec(content); match !== null; match = reExportPattern.exec(content)) {
    specifiers.push(match[1]);
  }

  return specifiers;
}

/** @internal */
function isBarrelModuleTarget(barrelDir: string, absoluteTargetModulePathNoExt: string): boolean {
  return (
    pathsEqual(barrelDir, absoluteTargetModulePathNoExt) ||
    pathsEqual(path.join(barrelDir, "index"), absoluteTargetModulePathNoExt)
  );
}
