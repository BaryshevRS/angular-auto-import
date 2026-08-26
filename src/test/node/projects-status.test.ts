/**
 * The sentence the extension says when it has nothing to work on.
 *
 * It is the only thing standing between "your workspace is clean" and "nothing was
 * ever indexed", which look identical from the outside, so what it says is worth
 * pinning down rather than leaving to whatever reads well at the time.
 * @module
 */

import * as assert from "node:assert";
import { describeProjectsStatus } from "../../lsp/projects-status";

describe("Projects status", () => {
  it("reports no problem when a project was found", () => {
    const status = describeProjectsStatus({
      workspaceRoots: ["/workspace"],
      projects: [{ rootPath: "/workspace/apps/my-app", elementCount: 12 }],
      config: { projectPath: null },
    });

    assert.strictEqual(status.problem, undefined);
    assert.deepStrictEqual(status.projects, [{ rootPath: "/workspace/apps/my-app", elementCount: 12 }]);
  });

  it("names the rule that rejected the roots, and the setting that overrules it", () => {
    const status = describeProjectsStatus({
      workspaceRoots: ["/workspace"],
      projects: [],
      config: { projectPath: null },
    });

    assert.ok(status.problem?.includes("/workspace"), "the reason must name where it looked");
    assert.ok(status.problem?.includes("@angular/core"), "and the rule that rejected it");
    assert.ok(status.problem?.includes("angular-auto-import.projectPath"), "and what to do about it");
  });

  it("says a configured path is not a directory, rather than blaming the workspace", () => {
    const status = describeProjectsStatus({
      workspaceRoots: [],
      projects: [],
      config: { projectPath: "apps/typo" },
    });

    assert.ok(status.problem?.includes("apps/typo"), `the reason must quote the setting: ${status.problem}`);
    assert.ok(status.problem?.includes("not a directory"), status.problem);
  });

  it("says there is no folder open when there is none", () => {
    const status = describeProjectsStatus({ workspaceRoots: [], projects: [], config: { projectPath: null } });

    assert.ok(status.problem?.includes("No folder is open"), status.problem);
  });

  it("copies the roots and projects rather than aliasing the caller's arrays", () => {
    const workspaceRoots = ["/workspace"];
    const status = describeProjectsStatus({ workspaceRoots, projects: [], config: { projectPath: null } });

    workspaceRoots.push("/elsewhere");
    assert.deepStrictEqual(status.workspaceRoots, ["/workspace"]);
  });
});
