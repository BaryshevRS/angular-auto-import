/** The repeatable command-line option that scopes an MCP process to a workspace root. */
export const MCP_WORKSPACE_ROOT_ARGUMENT = "--workspace-root";

/**
 * Turns workspace roots into arguments understood by the MCP process.
 * @param roots Absolute workspace-folder paths.
 */
export function workspaceRootArguments(roots: Iterable<string>): string[] {
  return Array.from(roots, (root) => [MCP_WORKSPACE_ROOT_ARGUMENT, root]).flat();
}

/**
 * Reads workspace roots from an MCP process's arguments.
 * @param args Arguments after the executable name.
 * @param fallback Used by external clients that launch the server from a project root.
 */
export function workspaceRootsFromArguments(args: readonly string[], fallback: string): string[] {
  const roots: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== MCP_WORKSPACE_ROOT_ARGUMENT) {
      continue;
    }
    const root = args[index + 1];
    if (root) {
      roots.push(root);
      index += 1;
    }
  }

  return roots.length > 0 ? [...new Set(roots)] : [fallback];
}
