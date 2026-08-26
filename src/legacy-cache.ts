/**
 * Clearing what the previous implementation left in workspace state.
 *
 * Before the language server, the index was cached in VS Code's own per-workspace
 * storage. The server keeps its cache in files under the storage directory instead, so
 * those entries are read by nothing — but they do not disappear on their own, and for a
 * large monorepo they are megabytes of dead JSON that VS Code loads with the workspace.
 *
 * This is temporary by construction: once users have opened their workspaces once with a
 * version that includes it, it has nothing left to do and should be deleted.
 * @module
 */

import type * as vscode from "vscode";
import type { CoreLogger } from "./core/logging";

/**
 * The key prefixes the previous implementation wrote, each followed by a project hash.
 *
 * Prefixes rather than exact keys because the hash was derived from a project path this
 * code no longer knows — a workspace may have held several, and may since have moved.
 */
const LEGACY_KEY_PREFIXES = [
  "angularFileCache_",
  "angularSelectorToDataIndex_",
  "angularModulesCache_",
  "angularExternalModulesExports_",
] as const;

/** The slice of `Memento` this needs, which the real one satisfies. */
export interface WorkspaceState {
  keys(): readonly string[];
  update(key: string, value: undefined): Thenable<void>;
}

/**
 * Deletes every entry the previous implementation wrote, and reports how many.
 *
 * Never throws: a workspace whose state cannot be written is a workspace that keeps a
 * few stale keys, which is not a reason to fail activation.
 * @param state The workspace-scoped storage to clean.
 * @param logger Where the outcome is reported.
 */
export async function removeLegacyCache(state: WorkspaceState, logger: CoreLogger): Promise<number> {
  let removed = 0;

  try {
    const stale = state.keys().filter((key) => LEGACY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)));
    for (const key of stale) {
      await state.update(key, undefined);
      removed += 1;
    }
  } catch (error) {
    logger.warn(`Could not clear the previous index cache from workspace state: ${String(error)}`);
    return removed;
  }

  if (removed > 0) {
    logger.info(`Cleared ${removed} stale index cache entr${removed === 1 ? "y" : "ies"} from workspace state`);
  }
  return removed;
}

/**
 * Clears the previous cache without making activation wait for it or fail on it.
 * @param context The extension context whose workspace state is cleaned.
 * @param logger Where the outcome is reported.
 */
export function clearLegacyCacheInBackground(context: vscode.ExtensionContext, logger: CoreLogger): void {
  void removeLegacyCache(context.workspaceState, logger);
}
