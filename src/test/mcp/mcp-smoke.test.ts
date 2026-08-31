/** A protocol smoke test whose Angular project needs no separately installed dependencies. */
import * as assert from "node:assert";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const SERVER = path.join(REPOSITORY_ROOT, "packages", "mcp", "dist", "mcp.js");
const FIXTURE = path.join(REPOSITORY_ROOT, "src", "test", "fixtures", "mcp-project");
const COMPONENT = path.join(FIXTURE, "src", "app", "app.component.ts");

describe("The MCP server smoke project", function () {
  this.timeout(120000);

  let client: Client;

  before(async () => {
    client = new Client({ name: "angular-auto-import-smoke", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER, "--workspace-root", FIXTURE],
        cwd: os.tmpdir(),
        stderr: "ignore",
      })
    );
  });

  after(async () => {
    await client.close();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    const [first] = result.content;
    assert.strictEqual(result.isError, undefined, first?.text);
    assert.strictEqual(first?.type, "text");
    return JSON.parse(first.text) as Record<string, unknown>;
  }

  it("serves all four tools from a root passed independently of cwd", async () => {
    const listed = await client.listTools();
    assert.deepStrictEqual(listed.tools.map((tool) => tool.name).sort(), [
      "angular_element_api",
      "angular_find_element",
      "angular_project_overview",
      "verify_angular_template",
    ]);

    const overview = (await call("angular_project_overview", { fromFile: COMPONENT })) as {
      angular: string;
      own: { standalone: number };
    };
    assert.strictEqual(overview.angular, "^22.0.0");
    assert.strictEqual(overview.own.standalone, 2);

    const api = (await call("angular_element_api", { fromFile: COMPONENT, query: "workspace-card" })) as {
      matches: Array<{ name: string; inputs: Array<{ name: string; required?: true }>; outputs: string[] }>;
    };
    assert.strictEqual(api.matches[0]?.name, "WorkspaceCardComponent");
    assert.deepStrictEqual(api.matches[0]?.inputs, [{ name: "cardTitle", required: true, signal: true }]);
    assert.deepStrictEqual(api.matches[0]?.outputs, ["dismissed"]);

    const verdict = (await call("verify_angular_template", {
      component: COMPONENT,
      template: '<workspace-card cardTitle="Hello"><button actions>Close</button></workspace-card>',
    })) as { addedImports: string[]; updatedComponent?: string };
    assert.deepStrictEqual(verdict.addedImports, ["WorkspaceCardComponent"]);
    assert.match(verdict.updatedComponent ?? "", /from "@app\/workspace-card\.component"/);
  });
});
