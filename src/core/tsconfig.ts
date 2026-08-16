/**
 * Reads a project's `tsconfig.json` and turns absolute module paths back into the
 * import specifiers a developer would have written.
 *
 * Each project root gets its own resolver, so a runtime holding several roots never
 * resolves one project's aliases against another's configuration.
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type getTsconfig, parseTsconfig } from "get-tsconfig";
import type { ProcessedTsConfig } from "../types/tsconfig";
import { getRelativeFilePath, normalizePath, switchFileType } from "../utils/path";
import { type CoreLogger, silentLogger } from "./logging";

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
 * @internal
 */
class PathAliasTrie {
  private readonly root: TrieNode = new TrieNode();
  private readonly logger: CoreLogger;

  constructor(tsconfig: ProcessedTsConfig, logger: CoreLogger) {
    this.logger = logger;
    this.buildTrie(tsconfig);
  }

  /**
   * Builds the Trie based on `paths` from `tsconfig.json`.
   * @param tsconfig The processed tsconfig.
   */
  private buildTrie(tsconfig: ProcessedTsConfig): void {
    const { absoluteBaseUrl, paths } = tsconfig;
    const projectRoot = this.findProjectRoot(absoluteBaseUrl);

    for (const [alias, pathArray] of Object.entries(paths)) {
      this.processAliasEntry(alias, pathArray, absoluteBaseUrl, projectRoot);
    }
  }

  /**
   * Finds the project root by going up from baseUrl.
   */
  private findProjectRoot(absoluteBaseUrl: string): string {
    let projectRoot = absoluteBaseUrl;
    while (projectRoot !== path.dirname(projectRoot)) {
      if (this.isProjectRootDirectory(projectRoot)) {
        break;
      }
      projectRoot = path.dirname(projectRoot);
    }
    return projectRoot;
  }

  /**
   * Checks if a directory is likely to be a project root.
   */
  private isProjectRootDirectory(dirPath: string): boolean {
    return (
      fs.existsSync(path.join(dirPath, "src")) ||
      fs.existsSync(path.join(dirPath, "package.json")) ||
      fs.existsSync(path.join(dirPath, "tsconfig.json"))
    );
  }

  /**
   * Processes a single alias entry and adds it to the trie.
   */
  private processAliasEntry(alias: string, pathArray: unknown, absoluteBaseUrl: string, projectRoot: string): void {
    const pathArraySafe = Array.isArray(pathArray) ? (pathArray as string[]) : [];

    if (pathArraySafe.length === 0) {
      this.logger.warn(`[PathAliasTrie] Skipped alias '${alias}': empty path array`);
      return;
    }

    const originalPath = pathArraySafe[0];
    const physicalPath = path.resolve(absoluteBaseUrl, originalPath);
    const isWildcard = alias.endsWith("/*") || alias.endsWith("*");

    const cleanAlias = alias.replace(/\/?\*?$/, "");
    const cleanPath = this.getCleanPath(physicalPath, isWildcard);

    this.addPathToTrie(cleanPath, projectRoot, cleanAlias, isWildcard);
  }

  /**
   * Gets the clean path based on wildcard status and path type.
   */
  private getCleanPath(physicalPath: string, isWildcard: boolean): string {
    if (isWildcard) {
      return physicalPath.replace(/\/?\*?$/, "");
    }

    if (path.basename(physicalPath) === "index.ts") {
      return path.dirname(physicalPath);
    }

    return switchFileType(physicalPath, "");
  }

  /**
   * Adds a path to the trie structure.
   */
  private addPathToTrie(cleanPath: string, projectRoot: string, cleanAlias: string, isWildcard: boolean): void {
    const relativePath = path.relative(projectRoot, cleanPath);
    const pathSegments = normalizePath(relativePath)
      .toLowerCase()
      .split("/")
      .filter((p) => p.length > 0);

    let currentNode = this.root;
    for (const segment of pathSegments) {
      if (!currentNode.children.has(segment)) {
        currentNode.children.set(segment, new TrieNode());
      }
      const nextNode = currentNode.children.get(segment);
      if (!nextNode) {
        throw new Error("Unexpected missing node in alias trie insertion");
      }
      currentNode = nextNode;
    }
    currentNode.alias = cleanAlias;
    currentNode.isBarrel = !isWildcard;
  }

  /**
   * Finds the longest prefix match for a given path in the Trie.
   * @param absoluteTargetPath The absolute path to the module (without extension).
   * @param projectRoot The project root directory for calculating the relative path.
   * @returns An object with the final import path or null.
   */
  public findLongestPrefixMatch(
    absoluteTargetPath: string,
    projectRoot?: string
  ): { importPath: string; isBarrel?: boolean; matchedRootPath: string } | null {
    const targetPath = this.getTargetPath(absoluteTargetPath, projectRoot);
    const pathSegments = this.getPathSegments(targetPath);
    const longestMatch = this.findLongestMatchInTrie(pathSegments.lower, pathSegments.original);

    if (!longestMatch) {
      return null;
    }

    const importPath = this.buildImportPath(longestMatch, pathSegments.original);
    const matchedRootPath = pathSegments.original.slice(0, longestMatch.depth).join("/");
    return { importPath, isBarrel: longestMatch.isBarrel, matchedRootPath };
  }

  /**
   * Gets the target path, converting to relative if project root is provided.
   */
  private getTargetPath(absoluteTargetPath: string, projectRoot?: string): string {
    let targetPath = normalizePath(absoluteTargetPath);

    if (projectRoot && absoluteTargetPath.startsWith(projectRoot)) {
      targetPath = normalizePath(path.relative(projectRoot, absoluteTargetPath));
    }

    return targetPath;
  }

  /**
   * Gets path segments in both original case and lowercase.
   */
  private getPathSegments(targetPath: string): { original: string[]; lower: string[] } {
    const original = targetPath.split("/").filter((p) => p.length > 0);
    const lower = targetPath
      .toLowerCase()
      .split("/")
      .filter((p) => p.length > 0);

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
      if (tsconfigResult && !tsconfigResult.path.startsWith(projectRoot)) {
        this.logger.warn(`[TsConfigHelper] Found tsconfig outside project root: ${tsconfigResult.path}`);
        tsconfigResult = null;
      }

      // Ensure the found tsconfig is the expected one
      if (tsconfigResult && actualTsconfigPath && tsconfigResult.path !== actualTsconfigPath) {
        this.logger.warn(
          `[TsConfigHelper] get-tsconfig returned different path than expected: ${tsconfigResult.path} vs ${actualTsconfigPath}`
        );
        // Only allow if it's still within our project directory
        if (!tsconfigResult.path.startsWith(projectRoot)) {
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

      const processedConfig: ProcessedTsConfig = {
        absoluteBaseUrl,
        paths,
        sourceFilePath: tsconfigResult.path,
      };
      this.tsConfigCache.set(cacheKey, processedConfig);

      // Create and cache a Trie for resolving aliases
      const trie = new PathAliasTrie(processedConfig, this.logger);
      this.trieCache.set(cacheKey, trie);

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
    projectRoot: string
  ): Promise<string> {
    // Handle empty target path
    if (!absoluteTargetModulePathNoExt || absoluteTargetModulePathNoExt.trim() === "") {
      return ".";
    }

    // Validate paths are within project boundaries
    const pathValidation = this.validateProjectPaths(
      absoluteTargetModulePathNoExt,
      absoluteCurrentFilePath,
      projectRoot
    );
    if (pathValidation.shouldReturn) {
      return pathValidation.path;
    }

    // Get or create path alias trie
    const trie = await this.getOrCreateTrie(projectRoot);

    // Calculate relative path
    const relativePath = getRelativeFilePath(absoluteCurrentFilePath, absoluteTargetModulePathNoExt);

    // Try to find alias match
    const aliasMatch = this.findAliasMatch(
      trie,
      absoluteTargetModulePathNoExt,
      absoluteCurrentFilePath,
      projectRoot,
      relativePath
    );
    if (aliasMatch) {
      return aliasMatch;
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

  /** @internal */
  private validateProjectPaths(
    absoluteTargetModulePathNoExt: string,
    absoluteCurrentFilePath: string,
    projectRoot: string
  ): { shouldReturn: boolean; path: string } {
    // Check that target file is within the project boundaries
    if (!absoluteTargetModulePathNoExt.startsWith(projectRoot)) {
      this.logger.warn(`[TsConfigHelper] Target file is outside project root, using absolute path`);
      return { shouldReturn: true, path: absoluteTargetModulePathNoExt };
    }

    // Check that current file is within the project boundaries
    if (!absoluteCurrentFilePath.startsWith(projectRoot)) {
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
      const newTrie = new PathAliasTrie(tsconfig, this.logger);
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
    projectRoot: string,
    relativePath: string
  ): string | null {
    if (!trie) {
      return null;
    }

    const match = trie.findLongestPrefixMatch(absoluteTargetModulePathNoExt, projectRoot);
    if (!match) {
      return null;
    }

    // Always prefer barrel imports over relative paths
    if (match.isBarrel) {
      if (isInsideMatchedAliasRoot(absoluteCurrentFilePath, match.matchedRootPath, projectRoot)) {
        return relativePath;
      }

      // A directory barrel (an `index.ts`) only covers what it actually re-exports.
      // If the target is not reachable through the barrel, fall back to a relative
      // path instead of producing a broken import. Exact-file aliases (no `index.ts`
      // at the matched root, e.g. `@deep-alias`) are always used as-is.
      const absoluteMatchedRoot = path.resolve(projectRoot, match.matchedRootPath);
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

/** @internal */
function isInsideMatchedAliasRoot(
  absoluteCurrentFilePath: string,
  matchedRootPath: string,
  projectRoot: string
): boolean {
  const absoluteMatchedRoot = path.resolve(projectRoot, matchedRootPath);
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
