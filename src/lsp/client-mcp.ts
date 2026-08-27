/**
 * Offering the agent-facing server to the editor, so that no one has to install it.
 *
 * The same tools are published on npm for Claude Code, Cursor and anything else that
 * reads an `mcp.json`. Inside the editor they need none of that: a registered provider
 * puts this server in the same place a user-configured one lands, which is the editor's
 * own registry rather than any one chat extension's. Whatever asks the editor for tools
 * sees these.
 *
 * The server is the bundle already shipped beside this file, started in its other shape.
 * @module
 */

import * as path from "node:path";
import * as vscode from "vscode";

/** The id the manifest's `mcpServerDefinitionProviders` entry declares. */
const PROVIDER_ID = "angular-auto-import.mcp";

/**
 * Publishes this extension's MCP server to the editor.
 * @param context The extension context, which owns the registration and locates the bundle.
 */
export function registerMcpServer(context: vscode.ExtensionContext): void {
  const server = context.asAbsolutePath(path.join("dist", "server.js"));

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
      provideMcpServerDefinitions: () => [
        // Started with the editor's own Node rather than whatever `node` a PATH resolves
        // to, since the bundle is built for the runtime the editor ships.
        new vscode.McpStdioServerDefinition("Angular Auto-Import", process.execPath, [server, "mcp"]),
      ],
    })
  );
}
