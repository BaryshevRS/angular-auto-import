/** Describes a recursive file search rooted at a single directory. */
export interface FileSearchQuery {
  /** Absolute path of the directory the search is rooted at. */
  root: string;
  /** File extensions to return, including the leading dot. */
  extensions: readonly string[];
  /** Directory names skipped anywhere below {@link FileSearchQuery.root}. */
  excludedDirectories?: readonly string[];
  /** Whether to skip directories whose name starts with a dot. */
  excludeHiddenDirectories?: boolean;
  /** File-name endings to skip, such as `.spec.ts`. */
  excludedSuffixes?: readonly string[];
}

/**
 * File access boundary shared by the Extension Host and language server runtimes.
 *
 * Paths are absolute file-system paths, not URIs: the analysis core reasons about
 * `ts-morph` paths, and each runtime converts to its own URI form at the edge.
 *
 * Searches are described structurally rather than as glob strings, because the two
 * runtimes find files by different means — one asks the editor, the other walks the
 * disk — and only one of them speaks glob.
 */
export interface FileSystem {
  /** Resolves absolute paths of the files matching `query`, in no guaranteed order. */
  findFiles(query: FileSearchQuery): Promise<string[]>;
  /** Reads a UTF-8 text file. Rejects when the file cannot be read. */
  readFile(filePath: string): Promise<string>;
}
