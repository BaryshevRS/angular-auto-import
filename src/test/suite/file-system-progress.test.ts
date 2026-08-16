import * as assert from "node:assert";
import * as path from "node:path";
import * as vscode from "vscode";
import { createVsCodeFileSystem } from "../../adapters/vscode/file-system";
import { createVsCodeProgressHost, toProgressReporter } from "../../adapters/vscode/progress";
import type { ProgressUpdate } from "../../core/progress";
import { silentProgressHost, silentProgressReporter } from "../../core/progress";

describe("VS Code file system", () => {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

  it("returns absolute paths for the requested extensions", async () => {
    const fileSystem = createVsCodeFileSystem();

    const found = await fileSystem.findFiles({ root: workspaceRoot, extensions: [".ts"] });

    assert.ok(found.length > 0, "Fixture core services should be discovered");
    assert.ok(
      found.every((filePath) => path.isAbsolute(filePath)),
      "Discovered files should be absolute paths"
    );
    assert.ok(
      found.some((filePath) => filePath.endsWith(`${path.sep}auth.service.ts`)),
      "auth.service.ts should be part of the result"
    );
  });

  it("skips the excluded directories, hidden directories, and suffixes", async () => {
    const fileSystem = createVsCodeFileSystem();

    const found = await fileSystem.findFiles({
      root: workspaceRoot,
      extensions: [".ts"],
      excludedDirectories: ["node_modules", "core"],
      excludeHiddenDirectories: true,
      excludedSuffixes: [".spec.ts"],
    });

    assert.ok(found.length > 0, "Only the excluded paths should be filtered out");
    assert.ok(
      found.every((filePath) => !filePath.includes(`${path.sep}core${path.sep}`)),
      "Files in an excluded directory should not be returned"
    );
    assert.ok(
      found.every((filePath) => !filePath.endsWith(".spec.ts")),
      "Files with an excluded suffix should not be returned"
    );
  });

  it("reads file contents as UTF-8 text", async () => {
    const fileSystem = createVsCodeFileSystem();

    const content = await fileSystem.readFile(path.join(workspaceRoot, "src", "app", "core", "index.ts"));

    assert.strictEqual(typeof content, "string");
    assert.ok(content.includes('export * from "./auth.service"'), "Fixture barrel content should be returned as text");
  });

  it("rejects when a file cannot be read", async () => {
    const fileSystem = createVsCodeFileSystem();

    await assert.rejects(() => fileSystem.readFile(path.join(workspaceRoot, "does-not-exist.ts")));
  });
});

describe("VS Code progress host", () => {
  it("forwards updates from the core reporter to the VS Code handle", () => {
    const updates: ProgressUpdate[] = [];
    const reporter = toProgressReporter({
      report: (update) => {
        updates.push(update);
      },
    });

    reporter.report({ message: "Indexing...", increment: 25 });

    assert.deepStrictEqual(updates, [{ message: "Indexing...", increment: 25 }]);
  });

  it("runs the task inside a progress scope and returns its result", async () => {
    const host = createVsCodeProgressHost();

    const result = await host.withProgress("Angular Auto-Import: test scope", async (reporter) => {
      reporter.report({ message: "step" });
      return 42;
    });

    assert.strictEqual(result, 42);
  });

  it("propagates task failures out of the progress scope", async () => {
    const host = createVsCodeProgressHost();

    await assert.rejects(
      () =>
        host.withProgress("Angular Auto-Import: failing scope", async () => {
          throw new Error("indexing failed");
        }),
      /indexing failed/
    );
  });
});

describe("Silent progress", () => {
  it("discards reported updates", () => {
    assert.doesNotThrow(() => {
      silentProgressReporter.report({ message: "ignored", increment: 10 });
    });
  });

  it("still runs the task and returns its result", async () => {
    const result = await silentProgressHost.withProgress("headless", async (reporter) => {
      reporter.report({ message: "ignored" });
      return "done";
    });

    assert.strictEqual(result, "done");
  });
});
