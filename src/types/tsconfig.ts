/**
 * Defines types related to TypeScript configuration and path mappings.
 * @module
 */

/** One `paths` entry, resolved to where its files actually live. */
export interface AliasTarget {
  /** The alias with its wildcard removed, e.g. `@scope/ui-common` or `@app`. */
  alias: string;
  /** Whether the entry ended in `*`, so the rest of a specifier is appended to it. */
  isWildcard: boolean;
  /** Absolute path the entry resolves to; a wildcard entry keeps its `*`. */
  physicalPath: string;
}

/**
 * Represents a processed TypeScript configuration with resolved paths.
 */
export interface ProcessedTsConfig {
  /**
   * The absolute base URL for module resolution.
   */
  absoluteBaseUrl: string;
  /**
   * Path aliases from the tsconfig.json file, as written.
   */
  paths: Record<string, string[]>;
  /**
   * The same aliases, resolved to absolute paths.
   *
   * Separate from {@link ProcessedTsConfig.paths} because an entry is not simply
   * relative to {@link ProcessedTsConfig.absoluteBaseUrl}: a config that inherits
   * `paths` through `extends` without declaring `baseUrl` resolves them against the
   * ancestor that declared them.
   */
  aliasTargets: AliasTarget[];
  /**
   * The directories {@link ProcessedTsConfig.aliasTargets} live in, deduplicated.
   *
   * This is the code the project can import but that need not sit inside it — in a
   * monorepo, the libraries beside it.
   */
  aliasRoots: string[];
  /**
   * The path to the source tsconfig.json file.
   */
  sourceFilePath: string;
}
