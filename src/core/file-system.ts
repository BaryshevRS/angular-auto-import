/** Describes a recursive file search rooted at a single directory. */
export interface FileSearchQuery {
  /** Absolute path of the directory the search is rooted at. */
  root: string;
  /** Glob, relative to {@link root}, selecting the files to return. */
  include: string;
  /** Glob of paths to skip. Omitted leaves the host's own default exclusions in place. */
  exclude?: string;
}

/**
 * File access boundary shared by the Extension Host and language server runtimes.
 *
 * Paths are absolute file-system paths, not URIs: the analysis core reasons about
 * `ts-morph` paths, and each runtime converts to its own URI form at the edge.
 */
export interface FileSystem {
  /** Resolves absolute paths of the files matching `query`, in no guaranteed order. */
  findFiles(query: FileSearchQuery): Promise<string[]>;
  /** Reads a UTF-8 text file. Rejects when the file cannot be read. */
  readFile(filePath: string): Promise<string>;
}
