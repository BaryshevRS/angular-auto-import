# Angular Auto-Import MCP

Project-aware tools that let an AI agent inspect the Angular elements a workspace really
contains, verify templates, and produce the imports that make them compile.

Run the server from an Angular workspace root:

```json
{
  "mcpServers": {
    "angular-auto-import": {
      "command": "npx",
      "args": ["-y", "angular-auto-import-mcp"]
    }
  }
}
```

If the MCP host does not start commands in the workspace, pass one or more roots explicitly:

```json
{
  "command": "npx",
  "args": [
    "-y",
    "angular-auto-import-mcp",
    "--workspace-root",
    "/absolute/path/to/angular-workspace"
  ]
}
```

The server provides `describe_project`, `find_element`, `describe_element` and
`verify_template`.

VS Code users can install the Angular Auto Import extension instead. It registers this
same server with the editor automatically and passes every folder in a multi-root workspace.
