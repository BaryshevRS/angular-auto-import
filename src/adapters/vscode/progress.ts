import * as vscode from "vscode";
import type { ProgressHost, ProgressReporter } from "../../core/progress";

/** Adapts a VS Code progress handle to the editor-agnostic reporter boundary. */
export function toProgressReporter(
  progress: vscode.Progress<{ message?: string; increment?: number }>
): ProgressReporter {
  return {
    report: ({ message, increment }) => {
      progress.report({ message, increment });
    },
  };
}

/** Surfaces progress scopes as VS Code notification progress. */
export function createVsCodeProgressHost(): ProgressHost {
  return {
    withProgress: async (title, task) =>
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title,
          cancellable: false,
        },
        (progress) => task(toProgressReporter(progress))
      ),
  };
}
