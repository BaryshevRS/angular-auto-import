/**
 * The MCP server as a client meets it: a built bundle, a real process, a real project.
 *
 * Everything else about these tools is tested against pieces held in memory. This drives
 * `dist/server.js` over stdio with the protocol's own client, against the v22 fixture and
 * its installed node_modules, and asserts on what actually comes back over the wire. It
 * is the only test here that would catch a bundle that does not start, a tool whose
 * schema a client rejects, or an answer that is right in a unit test and empty against a
 * real workspace.
 *
 * Separate from `test:node` for the same reason `test:fixtures` is: it indexes a real
 * `node_modules`, which is seconds rather than milliseconds.
 * @module
 */

import * as assert from "node:assert";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const SERVER = path.join(REPOSITORY_ROOT, "dist", "server.js");
const FIXTURE = path.join(REPOSITORY_ROOT, "src", "e2e", "projects", "v22");
const COMPONENT = path.join(FIXTURE, "apps", "ng-zorro-demo", "src", "app", "app.component.ts");

let client: Client;

/** One tool call, with its JSON answer parsed back out of the text content. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const [first] = result.content;
  assert.strictEqual(first?.type, "text", `${name} answered with something other than text`);
  return result.isError ? { error: first.text } : (JSON.parse(first.text) as Record<string, unknown>);
}

describe("The MCP server, end to end", function () {
  // The first call indexes the fixture's node_modules, which is seconds.
  this.timeout(120000);

  before(async function () {
    if (!existsSync(SERVER)) {
      throw new Error(`${SERVER} is missing. Run "pnpm run compile" before this suite.`);
    }
    if (!existsSync(path.join(FIXTURE, "node_modules"))) {
      // The fixture is installed by the e2e setup; without it there is nothing to index.
      this.skip();
    }

    client = new Client({ name: "angular-auto-import-e2e", version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [SERVER, "mcp", "--workspace-root", FIXTURE],
        cwd: os.tmpdir(),
        stderr: "ignore",
      })
    );
  });

  after(async () => {
    await client?.close();
  });

  it("offers its tools to a client that knows nothing about it", async () => {
    const { tools } = await client.listTools();

    assert.deepStrictEqual(
      tools.map((tool) => tool.name).sort(),
      ["describe_element", "describe_project", "find_element", "verify_template"],
      "the names a model reads before deciding to call one"
    );
    for (const tool of tools) {
      assert.ok((tool.description?.length ?? 0) > 80, `${tool.name} has to say when it is worth calling`);
      assert.ok(tool.inputSchema, `${tool.name} has to describe its arguments`);
    }
  });

  it("says what kind of workspace this is", async () => {
    const overview = (await call("describe_project", { fromFile: COMPONENT })) as {
      angular: string;
      own: { standalone: number; nonStandalone: number };
      libraries: Array<{ name: string; importedBy: number; elements: number }>;
    };

    assert.match(overview.angular, /^22\./, "the installed version, not the range a manifest asks for");
    assert.ok(overview.own.standalone > overview.own.nonStandalone, "and that this workspace is standalone");

    const byName = new Map(overview.libraries.map((library) => [library.name, library]));
    const material = byName.get("@angular/material");
    const zorro = byName.get("ng-zorro-antd");
    assert.ok(material && zorro, "both installed UI libraries are named");
    assert.ok(
      material.importedBy > zorro.importedBy,
      "and use is counted rather than availability: ng-zorro offers more elements and fewer files reach for it"
    );
  });

  it("finds an element by what it is for, ranked by what the workspace writes", async () => {
    // `translate` is a pipe twice over here: the workspace declares one and
    // `@ngx-translate/core` ships another. Alphabetically the library's comes first, so
    // this fails the moment ranking stops being about use — which a Material-against-
    // ng-zorro case would not catch, `Mat` sorting before `Nz` either way.
    const found = (await call("find_element", {
      fromFile: COMPONENT,
      query: "translate",
      type: "pipe",
    })) as { hits: Array<{ name: string; library?: string; usedByProject?: number }> };

    assert.deepStrictEqual(
      found.hits.map((hit) => hit.name),
      ["WorkspaceTranslatePipe", "TranslatePipe"],
      "the workspace's own outranks the library's, though the library's sorts first by name"
    );

    const used = found.hits.map((hit) => hit.usedByProject ?? Number.POSITIVE_INFINITY);
    assert.deepStrictEqual(
      [...used].sort((one, other) => other - one),
      used,
      "and library hits fall by use"
    );
  });

  it("describes an element's real surface, aliases and all", async () => {
    const described = (await call("describe_element", { fromFile: COMPONENT, query: "nz-check-list" })) as {
      matches: Array<{
        name: string;
        importFrom: string;
        inputs?: Array<{ name: string; signal?: true }>;
        outputs?: string[];
      }>;
    };

    assert.strictEqual(described.matches.length, 1, "an exact hit is the answer, not one candidate of five");
    const [element] = described.matches;
    assert.strictEqual(element.name, "NzCheckListComponent");
    assert.strictEqual(element.importFrom, "ng-zorro-antd/check-list");
    assert.ok(
      element.inputs?.some((input) => input.name === "nzItems" && input.signal),
      "its inputs are read out of the declaration, signals marked as such"
    );
    assert.deepStrictEqual(element.outputs, ["nzHide"]);
  });

  it("checks a template and hands back the component that would compile", async () => {
    const verdict = (await call("verify_template", {
      component: COMPONENT,
      template: "<nz-check-list></nz-check-list>\n<button nz-button>ok</button>\n<router-outlet></router-outlet>",
    })) as {
      problems: Array<{ line: number; token: string; fixes: Array<{ name: string; from: string }> }>;
      addedImports: string[];
      updatedComponent?: string;
    };

    assert.deepStrictEqual(
      verdict.problems.map((problem) => problem.line).sort(),
      [1, 2, 2],
      "both missing tokens, and the button twice: the ripple is reported beside the button"
    );
    assert.ok(
      verdict.problems.every((problem) => problem.fixes.length > 0),
      "every problem names what would fix it, which a build log never does"
    );
    assert.deepStrictEqual(verdict.addedImports, ["NzCheckListComponent", "NzButtonComponent", "NzWaveDirective"]);

    const updated = verdict.updatedComponent ?? "";
    assert.ok(updated.includes('from "ng-zorro-antd/check-list"'), "the component comes back with the imports in it");
    assert.ok(updated.includes("imports: [RouterOutlet, NzCheckListComponent"), "beside the one it already had");
  });

  it("says nothing about a template whose elements are all imported", async () => {
    const verdict = (await call("verify_template", {
      component: COMPONENT,
      template: "<router-outlet></router-outlet>",
    })) as { problems: unknown[]; addedImports: string[]; updatedComponent?: string };

    assert.deepStrictEqual(verdict.problems, []);
    assert.deepStrictEqual(verdict.addedImports, []);
    assert.strictEqual(verdict.updatedComponent, undefined, "nothing to change means nothing to write");
  });

  it("fails a request that names no project without pretending otherwise", async () => {
    const answer = await call("describe_project", { fromFile: path.join(REPOSITORY_ROOT, "README.md") });

    assert.match(String(answer.error), /No Angular project/, "and says what a project is");
  });

  it("answers again without paying for the index a second time", async () => {
    const started = Date.now();
    await call("describe_element", { fromFile: COMPONENT, query: "nz-table" });
    const elapsed = Date.now() - started;

    // The first call in this suite indexed the fixture; every one after it reads memory.
    // Generous because a loaded machine is not a broken cache — the point is the order of
    // magnitude, not the number.
    assert.ok(elapsed < 1000, `a warm call took ${elapsed} ms, which means the project was indexed again`);
  });
});
