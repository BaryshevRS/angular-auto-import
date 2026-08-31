/**
 * The MCP server as a process, spoken to over stdio.
 *
 * Nothing may be written to stdout: the transport owns it, and one stray line makes the
 * stream unparseable to the client. Diagnostics go to stderr, which every MCP host
 * collects and shows.
 * @module
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { workspaceRootsFromArguments } from "../core/mcp-workspace-roots";
import { createMcpServer } from "./server";
import { Workspace } from "./workspace";

async function main(): Promise<void> {
  const workspace = new Workspace(workspaceRootsFromArguments(process.argv.slice(2), process.cwd()));
  const server = createMcpServer(workspace);

  const stop = () => {
    workspace.dispose();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await server.connect(new StdioServerTransport());
  process.stderr.write("angular-auto-import MCP server ready on stdio\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`angular-auto-import MCP server failed to start: ${String(error)}\n`);
  process.exit(1);
});
