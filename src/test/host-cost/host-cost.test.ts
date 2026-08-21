/**
 * What the extension costs the Extension Host.
 *
 * No benchmark outside the editor can take this measurement, so it is taken inside one.
 * It is what justified moving the analysis into a language server: the recorded
 * comparison against the previous in-process implementation is in `docs/architecture.md`,
 * and this suite is what keeps the number honest as the server changes.
 *
 * The assertions only check that the scenario really happened, because a benchmark that
 * silently measured nothing is worse than no benchmark. Set `AAI_HOST_COST_OUTPUT` to
 * also write the numbers to a file.
 * @module
 */

import * as assert from "node:assert";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { stripAngularImports } from "../../e2e/helpers/strip-imports";

/** The template whose diagnostics tell us the index is populated and being used. */
const SUBJECT = "apps/angular-demo/src/app/home/home.component.html";

/** How long to wait for an index that has to read a whole monorepo's dependencies. */
const READY_TIMEOUT_MS = 180000;

/** One scenario's cost to this process. */
interface Measurement {
  /** Milliseconds of CPU the Extension Host itself burned. */
  cpuMs: number;
  /** Wall-clock milliseconds, for context: CPU below wall means someone else did the work. */
  wallMs: number;
  /** Diagnostics visible at the end, proving the scenario actually produced something. */
  diagnostics: number;
}

const measurements: Record<string, Measurement> = {};

/** Runs an operation and reports what it cost this process. */
async function measure(name: string, uri: vscode.Uri, run: () => Promise<void>): Promise<Measurement> {
  const cpuBefore = process.cpuUsage();
  const wallBefore = process.hrtime.bigint();

  await run();

  const cpu = process.cpuUsage(cpuBefore);
  const result: Measurement = {
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    wallMs: Math.round(Number(process.hrtime.bigint() - wallBefore) / 1e6),
    diagnostics: ourDiagnostics(uri).length,
  };

  measurements[name] = result;
  console.log(`  ${name}: ${result.cpuMs} ms CPU over ${result.wallMs} ms wall, ${result.diagnostics} diagnostics`);
  return result;
}

/** The diagnostics this extension published, ignoring anyone else's. */
function ourDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((diagnostic) => diagnostic.source === "angular-auto-import");
}

/** Waits until the extension has something to say about the document. */
async function waitForDiagnostics(uri: vscode.Uri): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (ourDiagnostics(uri).length === 0) {
    if (Date.now() > deadline) {
      throw new Error(`No diagnostics for ${uri.fsPath} within ${READY_TIMEOUT_MS} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("Extension Host cost", function () {
  this.timeout(READY_TIMEOUT_MS + 60000);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let templateUri: vscode.Uri;
  let componentUri: vscode.Uri;
  let originalComponent: string;

  before(async () => {
    assert.ok(workspaceRoot, "This suite needs a fixture workspace");
    templateUri = vscode.Uri.file(path.join(workspaceRoot, SUBJECT));
    componentUri = vscode.Uri.file(path.join(workspaceRoot, SUBJECT.replace(/\.html$/, ".ts")));

    // The fixture imports everything its template uses; measured as it stands, the
    // scenario would end with nothing to report and prove nothing.
    originalComponent = Buffer.from(await vscode.workspace.fs.readFile(componentUri)).toString("utf8");
    const stripped = stripAngularImports(originalComponent, path.basename(SUBJECT));
    await vscode.workspace.fs.writeFile(componentUri, Buffer.from(stripped, "utf8"));
  });

  after(async () => {
    await vscode.workspace.fs.writeFile(componentUri, Buffer.from(originalComponent, "utf8"));

    const output = process.env.AAI_HOST_COST_OUTPUT;
    if (output) {
      writeFileSync(output, JSON.stringify({ workspaceRoot, measurements }, null, 2), "utf8");
    }
  });

  it("measures activating and indexing from cold", async () => {
    const extension = vscode.extensions.getExtension("baryshevrs.angular-auto-import");
    assert.ok(extension, "The extension under test must be installed");

    const result = await measure("coldIndex", templateUri, async () => {
      await extension.activate();
      const document = await vscode.workspace.openTextDocument(templateUri);
      await vscode.window.showTextDocument(document);
      await waitForDiagnostics(templateUri);
    });

    assert.ok(result.diagnostics > 0, "The scenario must end with diagnostics, or it measured nothing");
  });

  it("measures an explicit reindex, with activation already paid for", async () => {
    const result = await measure("reindex", templateUri, async () => {
      await vscode.commands.executeCommand("angular-auto-import.reindex");
      await waitForDiagnostics(templateUri);
    });

    assert.ok(result.wallMs > 0);
  });
});
