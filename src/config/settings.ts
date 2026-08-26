/**
 * The settings the client hands the server at the handshake.
 *
 * Deliberately the editor's own section object, unmapped: the same section comes back
 * on every `workspace/configuration` answer once a user changes a setting, and a
 * handshake that sent some other shape would work only until the first such change —
 * after which every setting the two shapes disagreed about would quietly revert to its
 * default and stay there until the window was reloaded.
 * @module
 */
import * as vscode from "vscode";

/** The section name both this and the server's configuration requests use. */
export const CONFIGURATION_SECTION = "angular-auto-import";

/**
 * Reads the extension's settings section as the editor stores it.
 *
 * Read through the parent configuration rather than the section's own, which is what
 * makes the result the nested object the language client would send: keys split on
 * their dots, and a lone boolean under an `enabled` of its own.
 */
export function readSettingsSection(): unknown {
  return vscode.workspace.getConfiguration().get(CONFIGURATION_SECTION);
}
