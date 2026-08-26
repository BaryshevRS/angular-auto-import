/**
 * The status bar item that says whether the extension has anything to work on.
 *
 * There is one thing a user cannot find out for themselves: whether the extension
 * indexed their project. Silence means both "nothing is missing an import" and
 * "nothing was ever indexed", and the second one was previously only visible by
 * reading the source. The item shows the indexed element count when there is one, and
 * a warning naming the reason when there is not.
 * @module
 */

import * as vscode from "vscode";
import type { ProjectsStatus } from "./protocol";

/** Kept to the left of the language mode, where per-workspace state usually sits. */
const PRIORITY = 100;

/**
 * Creates the status bar item and returns how to update it.
 * @param context The extension context that owns the item.
 */
export function createProjectsStatusItem(context: vscode.ExtensionContext): (status: ProjectsStatus) => void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, PRIORITY);
  item.command = "angular-auto-import.showLogs";
  context.subscriptions.push(item);

  return (status: ProjectsStatus) => {
    render(item, status);
    item.show();
  };
}

/**
 * Puts one status onto the item.
 * @internal
 */
function render(item: vscode.StatusBarItem, status: ProjectsStatus): void {
  if (status.problem) {
    item.text = "$(warning) Angular Auto-Import";
    item.tooltip = status.problem;
    // A warning colour rather than an error one: an editor window with no Angular in
    // it is a normal thing to have open, and nothing is broken.
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    return;
  }

  const elements = status.projects.reduce((total, project) => total + project.elementCount, 0);
  item.text = `$(symbol-class) Angular Auto-Import: ${elements}`;
  item.tooltip = new vscode.MarkdownString(
    [
      `**${elements}** element${elements === 1 ? "" : "s"} indexed in ${status.projects.length} project${
        status.projects.length === 1 ? "" : "s"
      }:`,
      ...status.projects.map((project) => `- \`${project.rootPath}\` — ${project.elementCount}`),
    ].join("\n")
  );
  item.backgroundColor = undefined;
}
