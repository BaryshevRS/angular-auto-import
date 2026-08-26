/**
 * The command palette, in language-server mode.
 *
 * The command IDs are the ones users and keybindings already know; only what happens
 * behind them changes. Each command asks the server to do the work and then decides
 * what the user sees — notifications, webviews, and progress stay here, because the
 * client is the only side with a UI, and because a protocol error should never reach a
 * user as a protocol error.
 * @module
 */

import * as path from "node:path";
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { renderDiagnosticsReportHtml } from "../commands/webviews";
import { logger } from "../logger";
import {
  DiagnosticsReportRequest,
  FIX_ALL_KIND,
  type ProjectOperationResult,
  type ProjectScope,
  ReindexRequest,
} from "./protocol";

/**
 * How many of the offered actions the editor is asked to resolve before handing them over.
 *
 * An action arrives without its edit: computing one means rewriting the component with
 * ts-morph, far too expensive to do for every action a menu merely lists, so the server
 * leaves it for `codeAction/resolve`. `executeCodeActionProvider` resolves nothing
 * unless it is told a count, and an unresolved action applies nothing at all — which is
 * how this command came to be reported as doing nothing. The request names one kind and
 * the editor drops whatever does not match it, so a handful covers everything that can
 * come back.
 */
const RESOLVE_LIMIT = 5;

/** What the user is told when the server cannot answer, in place of the protocol error. */
const SERVER_UNAVAILABLE =
  "Angular Auto-Import: the language server is not responding. Check the Angular Auto Import output channel, or reload the window to restart it.";

/**
 * Registers the command-palette commands against a running client.
 * @param context The extension context that owns the registrations.
 * @param client The started language client.
 */
export function registerClientCommands(context: vscode.ExtensionContext, client: LanguageClient): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("angular-auto-import.reindex", () => reindex(client)),
    vscode.commands.registerCommand("angular-auto-import.showLogs", () => logger.showChannel()),
    vscode.commands.registerCommand("angular-auto-import.fix-all", () => fixAll()),
    vscode.commands.registerCommand("angular-auto-import.generateDiagnosticsReport", () =>
      generateDiagnosticsReport(context, client)
    )
  );
}

/**
 * Rebuilds the active project's index, or every project's when no editor is open.
 * @internal
 */
async function reindex(client: LanguageClient): Promise<void> {
  logger.info("Reindex command invoked by user");

  const result = await withProgress("Angular Auto-Import: Reindexing", (token) =>
    send(() => client.sendRequest(ReindexRequest, activeDocumentScope(), token), ReindexRequest.method, token)
  );
  if (!result) {
    return;
  }

  if (result.projects.length === 0) {
    vscode.window.showInformationMessage("Angular Auto-Import: No project found to reindex.");
    return;
  }

  reportOutcomes(
    result,
    (project) => `✅ Reindex of ${path.basename(project.rootPath)} successful. Found ${project.elementCount} elements.`
  );
}

/**
 * Scans every template in the workspace and shows what is missing an import.
 *
 * The scan runs in the server, which reports its progress against the token attached
 * here, so the notification tracks real work rather than a spinner.
 * @internal
 */
async function generateDiagnosticsReport(context: vscode.ExtensionContext, client: LanguageClient): Promise<void> {
  logger.info("Generate diagnostics report command invoked by user");

  const report = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Angular Auto Import: Generating Diagnostics Report",
      cancellable: true,
    },
    (_progress, token) =>
      send(
        () => client.sendRequest(DiagnosticsReportRequest, activeDocumentScope(), token),
        DiagnosticsReportRequest.method,
        token
      )
  );
  if (!report) {
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "angularDiagnosticsReport",
    "Angular Auto Import - Diagnostics Report",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] }
  );
  context.subscriptions.push(panel);
  panel.webview.html = renderDiagnosticsReportHtml(report);

  vscode.window.showInformationMessage(
    `✅ Diagnostics report generated: ${report.totalIssues} issue(s) found across ${report.files.length} file(s)`
  );
}

/**
 * Runs the standard fix-all action on the active editor.
 *
 * The palette command is a wrapper around the code action rather than a second
 * implementation, so the two can never diverge in what they import or how they order it.
 * @internal
 */
async function fixAll(): Promise<void> {
  logger.info("Fix all command invoked by user");

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("No active editor to fix diagnostics for.");
    return;
  }

  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    editor.document.uri,
    fullRangeOf(editor.document),
    FIX_ALL_KIND,
    RESOLVE_LIMIT
  );

  const fixAllAction = actions?.find((action) => action.kind?.value === FIX_ALL_KIND);
  if (!fixAllAction) {
    vscode.window.showInformationMessage("No auto-import diagnostics to fix.");
    return;
  }

  await applyCodeAction(fixAllAction);
}

/**
 * Applies a code action the way the editor would: its edit first, then its command.
 * @internal
 */
async function applyCodeAction(action: vscode.CodeAction): Promise<void> {
  if (!action.edit && !action.command) {
    // An action nobody resolved carries nothing, and applying nothing is indistinguishable
    // from a command that never ran. Say so rather than report success by staying quiet.
    logger.warn(`Fix all: "${action.title}" arrived with neither an edit nor a command`);
    vscode.window.showWarningMessage("Angular Auto-Import: the fix-all action arrived with nothing to apply.");
    return;
  }

  if (action.edit) {
    await vscode.workspace.applyEdit(action.edit);
  }
  if (action.command) {
    await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
  }
}

/**
 * Sends a request, turning a failure into something the user can act on.
 *
 * Returns `undefined` when the request failed, having already told the user, so callers
 * check for that rather than handling protocol errors of their own. A user who cancelled
 * is told nothing: they know what they did.
 * @internal
 */
async function send<R>(
  run: () => Promise<R>,
  method: string,
  token?: vscode.CancellationToken
): Promise<R | undefined> {
  try {
    return await run();
  } catch (error) {
    if (token?.isCancellationRequested) {
      return undefined;
    }
    logger.error(`Language server request ${method} failed`, error as Error);
    vscode.window.showErrorMessage(SERVER_UNAVAILABLE);
    return undefined;
  }
}

/**
 * Runs a request under a cancellable progress notification.
 * @internal
 */
function withProgress<R>(
  title: string,
  run: (token: vscode.CancellationToken) => Promise<R | undefined>
): Thenable<R | undefined> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    (_progress, token) => run(token)
  );
}

/**
 * Scopes an operation to the project owning the active editor's document. Without an
 * editor the scope is empty, which the server reads as "every project".
 * @internal
 */
function activeDocumentScope(): ProjectScope {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "file" ? { uri: uri.toString() } : {};
}

/**
 * Reports each project's outcome, so a workspace where one project failed does not
 * look like a workspace where everything did.
 * @internal
 */
function reportOutcomes(
  result: ProjectOperationResult,
  success: (project: ProjectOperationResult["projects"][number]) => string
): void {
  for (const project of result.projects) {
    if (!project.error) {
      vscode.window.showInformationMessage(success(project));
    }
  }
  reportFailures(result);
}

/** @internal */
function reportFailures(result: ProjectOperationResult): void {
  for (const project of result.projects) {
    if (project.error) {
      logger.error(`Operation failed for ${project.rootPath}: ${project.error}`);
      vscode.window.showWarningMessage(
        `Angular Auto-Import: ${path.basename(project.rootPath)} could not be processed. See the output channel for details.`
      );
    }
  }
}

/** @internal */
function fullRangeOf(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(0, 0, document.lineCount, 0);
}
