import * as assert from "node:assert";
import {
  MCP_WORKSPACE_ROOT_ARGUMENT,
  workspaceRootArguments,
  workspaceRootsFromArguments,
} from "../../core/mcp-workspace-roots";

describe("MCP workspace roots", () => {
  it("passes every workspace folder to one server process", () => {
    assert.deepStrictEqual(workspaceRootArguments(["/workspace/app", "/workspace/admin"]), [
      MCP_WORKSPACE_ROOT_ARGUMENT,
      "/workspace/app",
      MCP_WORKSPACE_ROOT_ARGUMENT,
      "/workspace/admin",
    ]);
  });

  it("reads repeated workspace roots without confusing other arguments for paths", () => {
    assert.deepStrictEqual(
      workspaceRootsFromArguments(
        [
          "mcp",
          MCP_WORKSPACE_ROOT_ARGUMENT,
          "/workspace/app",
          "--other",
          MCP_WORKSPACE_ROOT_ARGUMENT,
          "/workspace/admin",
        ],
        "/fallback"
      ),
      ["/workspace/app", "/workspace/admin"]
    );
  });

  it("deduplicates roots the editor reports more than once", () => {
    assert.deepStrictEqual(
      workspaceRootsFromArguments(
        [MCP_WORKSPACE_ROOT_ARGUMENT, "/workspace/app", MCP_WORKSPACE_ROOT_ARGUMENT, "/workspace/app"],
        "/fallback"
      ),
      ["/workspace/app"]
    );
  });

  it("uses the launching client's cwd when no roots were provided", () => {
    assert.deepStrictEqual(workspaceRootsFromArguments(["mcp"], "/workspace/from-client"), ["/workspace/from-client"]);
  });
});
