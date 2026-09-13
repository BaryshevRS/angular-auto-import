/**
 * The four agent questions, asked of the running server.
 *
 * What makes these worth driving end to end rather than unit-testing the handler: an
 * agent names a file the editor never opened, so discovery has to run for a path that
 * arrived in a request payload rather than in a `didOpen`. That routing is the only new
 * thing here — the answers themselves are the MCP server's, already covered where they
 * are computed.
 * @module
 */

import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentDescribeElementRequest,
  AgentDescribeProjectRequest,
  AgentFindElementRequest,
  AgentVerifyTemplateRequest,
} from "../../lsp/protocol";
import { type Harness, startHarness } from "./harness/lsp-harness";

/** A standalone component with one required input, so its surface is worth reporting. */
const BADGE = [
  'import { Component, Input } from "@angular/core";',
  "",
  '@Component({ selector: "ui-badge", standalone: true, template: "" })',
  "export class UiBadgeComponent {",
  "  @Input({ required: true }) label!: string;",
  "}",
  "",
].join("\n");

/** A component that imports nothing, so a template using the badge is missing one. */
const HOST = [
  'import { Component } from "@angular/core";',
  "",
  "@Component({",
  '  selector: "app-host",',
  "  standalone: true,",
  '  template: "",',
  "  imports: [],",
  "})",
  "export class HostComponent {}",
  "",
].join("\n");

describe("LSP agent tools", function () {
  this.timeout(30000);

  let sandbox: string;
  let root: string;
  let badgePath: string;
  let hostPath: string;
  let live: Harness;

  before(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-agent-"));
    root = path.join(sandbox, "app");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "@angular/core": "^20.0.0" } }),
      "utf8"
    );
    await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }), "utf8");

    badgePath = path.join(root, "src", "badge.component.ts");
    hostPath = path.join(root, "src", "host.component.ts");
    await fs.writeFile(badgePath, BADGE, "utf8");
    await fs.writeFile(hostPath, HOST, "utf8");

    live = await startHarness({ workspaceRoots: [root] });
    await live.waitForProjects(1);
  });

  after(async () => {
    await live?.dispose();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("describes the project a named file belongs to, without it being opened", async () => {
    const answer = await live.client.sendRequest(AgentDescribeProjectRequest, { fromFile: hostPath });

    assert.strictEqual(answer.answered, true);
    if (!answer.answered) {
      return;
    }
    assert.strictEqual(answer.answer.root, root);
    assert.ok(answer.answer.own.standalone >= 2, "both components are standalone");
  });

  it("finds an element by what it is for", async () => {
    const answer = await live.client.sendRequest(AgentFindElementRequest, { fromFile: hostPath, query: "badge" });

    assert.strictEqual(answer.answered, true);
    if (!answer.answered) {
      return;
    }
    const names = answer.answer.hits.map((hit) => hit.name);
    assert.ok(names.includes("UiBadgeComponent"), `expected UiBadgeComponent among ${names.join(", ")}`);
  });

  it("reports an element's real surface and where to import it from", async () => {
    const answer = await live.client.sendRequest(AgentDescribeElementRequest, {
      fromFile: hostPath,
      query: "ui-badge",
    });

    assert.strictEqual(answer.answered, true);
    if (!answer.answered) {
      return;
    }
    const [badge] = answer.answer.matches;
    assert.strictEqual(badge?.name, "UiBadgeComponent");
    assert.strictEqual(badge.selector, "ui-badge");
    assert.strictEqual(badge.importFrom, "./badge.component");
    assert.deepStrictEqual(badge.inputs, [{ name: "label", required: true }]);
  });

  it("verifies a template the component does not import yet, and rewrites the component", async () => {
    const answer = await live.client.sendRequest(AgentVerifyTemplateRequest, {
      component: hostPath,
      template: '<ui-badge label="new"></ui-badge>',
    });

    assert.strictEqual(answer.answered, true);
    if (!answer.answered) {
      return;
    }
    assert.deepStrictEqual(
      answer.answer.problems.map((problem) => problem.token),
      ["ui-badge"]
    );
    assert.deepStrictEqual(answer.answer.addedImports, ["UiBadgeComponent"]);
    assert.match(String(answer.answer.updatedComponent), /imports: \[UiBadgeComponent\]/);
    assert.match(String(answer.answer.updatedComponent), /from "\.\/badge\.component"/);
  });

  it("says so when a path belongs to no Angular project", async () => {
    const outside = path.join(sandbox, "elsewhere", "file.ts");
    const answer = await live.client.sendRequest(AgentDescribeProjectRequest, { fromFile: outside });

    assert.strictEqual(answer.answered, false);
    if (answer.answered) {
      return;
    }
    assert.match(answer.problem, /No Angular project contains/);
  });
});
