import * as vscode from "vscode";
import type { Disposable } from "../../core/events";
import type { FileWatcherFactory, FileWatchQuery } from "../../core/file-watching";

/**
 * Adapts VS Code's workspace watchers to the editor-agnostic watching boundary.
 *
 * The watcher, and the three handlers registered on it, are disposed together so a
 * caller only has to keep the returned subscription.
 */
export function createVsCodeFileWatcherFactory(): FileWatcherFactory {
  return {
    watch({ root, include }: FileWatchQuery, onChange): Disposable {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, include));
      const subscriptions = [
        watcher,
        watcher.onDidCreate((uri) => onChange({ filePath: uri.fsPath, kind: "create" })),
        watcher.onDidChange((uri) => onChange({ filePath: uri.fsPath, kind: "change" })),
        watcher.onDidDelete((uri) => onChange({ filePath: uri.fsPath, kind: "delete" })),
      ];

      return {
        dispose: () => {
          for (const subscription of subscriptions) {
            subscription.dispose();
          }
        },
      };
    },
  };
}
