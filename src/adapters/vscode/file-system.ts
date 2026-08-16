import * as vscode from "vscode";
import type { FileSearchQuery, FileSystem } from "../../core/file-system";

/**
 * Adapts the VS Code workspace file system to the editor-agnostic file boundary.
 *
 * Search goes through `workspace.findFiles`, so it stays limited to the open
 * workspace folders and honours the user's `files.exclude`/`search.exclude`
 * settings, exactly as the indexer did before the boundary existed.
 */
export function createVsCodeFileSystem(): FileSystem {
  return {
    findFiles: async (query: FileSearchQuery) => {
      const pattern = new vscode.RelativePattern(query.root, toIncludeGlob(query));
      const uris = await vscode.workspace.findFiles(pattern, toExcludeGlob(query));
      return uris.map((uri) => uri.fsPath);
    },
    readFile: async (filePath: string) => {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return Buffer.from(content).toString("utf-8");
    },
  };
}

/** @internal */
function toIncludeGlob({ extensions }: FileSearchQuery): string {
  return `**/*{${extensions.join(",")}}`;
}

/**
 * Builds the exclude glob as a flat brace list: VS Code's glob parser does not
 * reliably expand nested braces, and a mis-parsed exclude would silently pull all of
 * `node_modules` back in.
 * @internal
 */
function toExcludeGlob(query: FileSearchQuery): string | undefined {
  const patterns = [
    ...(query.excludedDirectories ?? []).map((directory) => `**/${directory}/**`),
    ...(query.excludeHiddenDirectories ? ["**/.*/**"] : []),
    ...(query.excludedSuffixes ?? []).map((suffix) => `**/*${suffix}`),
  ];

  return patterns.length > 0 ? `{${patterns.join(",")}}` : undefined;
}
