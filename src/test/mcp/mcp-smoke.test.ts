/** A protocol smoke test whose Angular project needs no separately installed dependencies. */
import * as assert from "node:assert";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const SERVER = path.join(REPOSITORY_ROOT, "packages", "mcp", "dist", "mcp.js");
const FIXTURE = path.join(REPOSITORY_ROOT, "src", "test", "fixtures", "mcp-project");

describe("The MCP server smoke project", function () {
  this.timeout(120000);

  let client: Client;
  let fixture: string;
  let component: string;

  before(async () => {
    fixture = await mkdtemp(path.join(os.tmpdir(), "angular-auto-import-mcp-"));
    await cp(FIXTURE, fixture, { recursive: true });
    component = path.join(fixture, "src", "app", "app.component.ts");
    client = new Client({ name: "angular-auto-import-smoke", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER, "--workspace-root", fixture],
        cwd: os.tmpdir(),
        stderr: "ignore",
      })
    );
  });

  after(async () => {
    await client.close();
    await rm(fixture, { recursive: true, force: true });
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

    const overview = (await call("angular_project_overview", { fromFile: component })) as {
      angular: string;
      own: { standalone: number };
    };
    assert.strictEqual(overview.angular, "^22.0.0");
    assert.strictEqual(overview.own.standalone, 2);

    const api = (await call("angular_element_api", { fromFile: component, query: "workspace-card" })) as {
      matches: Array<{ name: string; inputs: Array<{ name: string; required?: true }>; outputs: string[] }>;
    };
    assert.strictEqual(api.matches[0]?.name, "WorkspaceCardComponent");
    assert.deepStrictEqual(api.matches[0]?.inputs, [{ name: "cardTitle", required: true, signal: true }]);
    assert.deepStrictEqual(api.matches[0]?.outputs, ["dismissed"]);

    const verdict = (await call("verify_angular_template", {
      component,
      template: '<workspace-card cardTitle="Hello"><button actions>Close</button></workspace-card>',
    })) as { addedImports: string[]; updatedComponent?: string };
    assert.deepStrictEqual(verdict.addedImports, ["WorkspaceCardComponent"]);
    assert.match(verdict.updatedComponent ?? "", /from "@app\/workspace-card\.component"/);
  });

  it("tracks a standalone component created, changed and deleted after indexing", async () => {
    const initialApi = (await call("angular_element_api", {
      fromFile: component,
      query: "workspace-card",
    })) as { matches: Array<{ name: string }> };
    assert.strictEqual(initialApi.matches[0]?.name, "WorkspaceCardComponent");

    const liveComponent = path.join(fixture, "src", "app", "live-status.component.ts");
    await writeFile(
      liveComponent,
      `import { Component } from "@angular/core";

@Component({
  selector: "live-status",
  standalone: true,
  template: "",
})
export class LiveStatusComponent {}
`
    );

    const response = (await call("angular_element_api", {
      fromFile: component,
      query: "live-status",
    })) as { matches: Array<{ name: string }> };
    assert.deepStrictEqual(
      response.matches.map(({ name }) => name),
      ["LiveStatusComponent"]
    );

    await writeFile(
      liveComponent,
      `import { Component } from "@angular/core";

@Component({
  selector: "live-health",
  standalone: true,
  template: "",
})
export class LiveHealthComponent {}
`
    );

    const staleResponse = (await call("angular_element_api", {
      fromFile: component,
      query: "live-status",
    })) as { matches: Array<{ name: string }> };
    assert.deepStrictEqual(
      staleResponse.matches.map(({ name }) => name),
      []
    );

    const renamedResponse = (await call("angular_element_api", {
      fromFile: component,
      query: "live-health",
    })) as { matches: Array<{ name: string }> };
    assert.deepStrictEqual(
      renamedResponse.matches.map(({ name }) => name),
      ["LiveHealthComponent"]
    );

    await rm(liveComponent);

    const deletedResponse = (await call("angular_element_api", {
      fromFile: component,
      query: "live-health",
    })) as { matches: Array<{ name: string }> };
    assert.deepStrictEqual(
      deletedResponse.matches.map(({ name }) => name),
      []
    );
  });
});
