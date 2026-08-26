/**
 * The extension's entry point.
 *
 * There is very little here, and that is the point: everything that reads a project,
 * parses a template, or decides what to import runs in the language server. This module
 * starts that server, gives it the logger the user can read, and stops it again.
 *
 * @module Main extension entry point for Angular Auto-Import
 */

import type * as vscode from "vscode";
import { installSharedLogger } from "./core/logging";
import { clearLegacyCacheInBackground } from "./legacy-cache";
import { logger } from "./logger";
import { startLanguageClient, stopLanguageClient } from "./lsp/client";

/**
 * Activates the extension.
 * @param context The extension context, which owns everything registered here.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logger.initialize(context);
  installSharedLogger(logger);

  // Nothing waits on this: it clears storage the extension no longer reads, and a
  // workspace that cannot be written is not a reason to refuse to start.
  clearLegacyCacheInBackground(context, logger);

  try {
    await startLanguageClient(context);
    logger.info("Angular Auto-Import: language server started.");
  } catch (error) {
    // A server that will not start leaves the extension with nothing to offer, so say
    // so plainly rather than failing silently on every request that follows.
    logger.error("Angular Auto-Import: the language server failed to start.", error as Error);
    throw error;
  }
}

/** Deactivates the extension, stopping the server it started. */
export async function deactivate(): Promise<void> {
  await stopLanguageClient();
  logger.info("Angular Auto-Import: language server stopped.");
  logger.dispose();
}
