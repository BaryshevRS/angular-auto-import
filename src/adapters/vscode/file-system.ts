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
    findFiles: async ({ root, include, exclude }: FileSearchQuery) => {
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, include), exclude);
      return uris.map((uri) => uri.fsPath);
    },
    readFile: async (filePath: string) => {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
      return Buffer.from(content).toString("utf-8");
    },
  };
}
