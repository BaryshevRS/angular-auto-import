import * as vscode from "vscode";

/**
 * How many of the offered actions are resolved by default.
 *
 * Resolving one means rewriting a component with ts-morph, and a range rarely offers
 * more than a couple of fixes plus a fix-all. Asking for many more makes the request
 * slow enough that the editor cancels it when the next one arrives.
 */
const DEFAULT_RESOLVE_LIMIT = 5;

/**
 * Waits for diagnostics to stabilize (stop changing) for a given URI.
 * Uses event-based approach via `vscode.languages.onDidChangeDiagnostics`.
 *
 * @param uri - The document URI to monitor
 * @param source - Filter diagnostics by source (e.g. "angular-auto-import")
 * @param timeoutMs - Maximum wait time before rejecting
 * @param stableMs - How long diagnostics must remain unchanged to be considered stable
 * @returns The stabilized diagnostics array. On timeout, returns the current snapshot
 * so zero-diagnostic cases can still be asserted by the caller.
 */
export function waitForDiagnosticsToStabilize(
  uri: vscode.Uri,
  source: string,
  timeoutMs = 60000,
  stableMs = 3000
): Promise<vscode.Diagnostic[]> {
  return new Promise((resolve) => {
    let stableTimer: ReturnType<typeof setTimeout> | undefined;

    const getDiagnostics = () => vscode.languages.getDiagnostics(uri).filter((d) => d.source === source);

    // Build a comparable signature of our source's diagnostics so we can detect
    // real changes and ignore churn from other providers (Angular Language
    // Service, TypeScript) that keep emitting on the same open document.
    const getSignature = () =>
      getDiagnostics()
        .map(
          (d) =>
            `${String(d.code)}@${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}#${d.severity}`
        )
        .sort()
        .join("|");

    let lastSignature = getSignature();

    const resetStableTimer = () => {
      if (stableTimer) {
        clearTimeout(stableTimer);
      }
      stableTimer = setTimeout(() => {
        disposable.dispose();
        clearTimeout(timeout);
        resolve(getDiagnostics());
      }, stableMs);
    };

    const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
      const affected = e.uris.some((u) => u.toString() === uri.toString());
      if (!affected) {
        return;
      }

      // Only treat the document as "changing" when OUR diagnostics actually
      // change; otherwise unrelated churn would reset the quiet window forever.
      const signature = getSignature();
      if (signature !== lastSignature) {
        lastSignature = signature;
        resetStableTimer();
      }
    });

    const timeout = setTimeout(() => {
      if (stableTimer) {
        clearTimeout(stableTimer);
      }
      disposable.dispose();
      resolve(getDiagnostics());
    }, timeoutMs);

    // Start the initial stable timer in case diagnostics are already present
    resetStableTimer();
  });
}

/**
 * Collects quick fixes for each unique diagnostic code.
 *
 * @param uri - The document URI
 * @param diagnostics - Array of diagnostics to collect quick fixes for
 * @param commandFilter - Filter code actions by command ID
 * @returns Map of diagnostic code to array of CodeActions
 */
export async function collectQuickFixes(
  uri: vscode.Uri,
  diagnostics: vscode.Diagnostic[],
  resolveLimit = DEFAULT_RESOLVE_LIMIT
): Promise<Map<string, vscode.CodeAction[]>> {
  const result = new Map<string, vscode.CodeAction[]>();
  const seenCodes = new Set<string>();

  for (const diagnostic of diagnostics) {
    const code = String(diagnostic.code);
    if (seenCodes.has(code)) {
      continue;
    }
    seenCodes.add(code);

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      uri,
      diagnostic.range,
      vscode.CodeActionKind.QuickFix.value,
      // An action's edit is computed on demand, so without this every action arrives
      // with nothing to apply. Pass 0 when only the titles are wanted.
      resolveLimit
    );

    const quickFixes = (actions ?? []).filter((action) => action.kind?.contains(vscode.CodeActionKind.QuickFix));
    if (quickFixes.length > 0) {
      result.set(code, quickFixes);
    }
  }

  return result;
}

/**
 * Applies a code action the way the editor would: its edit first, then its command.
 *
 * The extension deliberately does not save what it edits — the edit belongs to the
 * user's undo stack and is theirs to keep or discard. So this saves afterwards, which is
 * what a user does, and what lets an assertion read the result off disk.
 * @param action The action to apply.
 * @param edited The file the action was expected to change.
 */
export async function applyCodeAction(action: vscode.CodeAction, edited: vscode.Uri): Promise<void> {
  if (!action.edit && !action.command) {
    throw new Error(`"${action.title}" carries neither an edit nor a command`);
  }

  if (action.edit) {
    const applied = await vscode.workspace.applyEdit(action.edit);
    if (!applied) {
      throw new Error(`The editor refused the edit of "${action.title}"`);
    }
  }
  if (action.command) {
    await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
  }

  const document = await vscode.workspace.openTextDocument(edited);
  if (document.isDirty) {
    await document.save();
  }
}
