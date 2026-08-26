import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AngularCompilerApi, adoptAngularCompiler } from "../../core/angular-compiler";
import { createCancellationSource } from "../../core/cancellation";
import { DEFAULT_EXTENSION_CONFIG, type ExtensionConfig } from "../../core/settings";
import { DiagnosticsHandler } from "../../lsp/diagnostics";
import { OpenDocuments } from "../../lsp/open-documents";
import { ProjectRouter } from "../../lsp/project-router";
import { ProjectRuntime } from "../../lsp/project-runtime";
import { DiagnosticsReporter, type ReportProgress } from "../../lsp/report";

function noOpenDocuments(): OpenDocuments {
  const open = new OpenDocuments({
    get: () => undefined,
    all: () => [],
    onDidOpen: () => undefined,
    onDidSave: () => undefined,
    onDidClose: () => undefined,
  });
  open.listen();
  return open;
}

function component(name: string, selector: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    `@Component({ selector: "${selector}", standalone: true, template: "" })`,
    `export class ${name} {}`,
    "",
  ].join("\n");
}

/** A component whose template lives in a separate HTML file. */
function externalHost(className: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    `  selector: "${className.toLowerCase()}",`,
    "  standalone: true,",
    `  templateUrl: "./${className.toLowerCase()}.component.html",`,
    "  imports: [],",
    "})",
    `export class ${className} {}`,
    "",
  ].join("\n");
}

describe("LSP diagnostics report", function () {
  this.timeout(20000);

  let compiler: AngularCompilerApi;
  let sandbox: string;
  let root: string;
  let runtime: ProjectRuntime;
  let config: ExtensionConfig;
  let reporter: DiagnosticsReporter;

  before(async () => {
    compiler = adoptAngularCompiler(await import("@angular/compiler"));
  });

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-report-"));
    root = path.join(sandbox, "apps", "shop");
    config = structuredClone(DEFAULT_EXTENSION_CONFIG);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: "." } }), "utf8");
    await fs.writeFile(
      path.join(root, "src", "shop-card.component.ts"),
      component("ShopCardComponent", "shop-card"),
      "utf8"
    );
    runtime = new ProjectRuntime(root);
    await runtime.load();

    const documents = noOpenDocuments();
    const router = new ProjectRouter({
      rootForPath: (filePath) => (filePath.startsWith(root) ? root : undefined),
      runtimeForRoot: (rootPath) => (rootPath === root ? runtime : undefined),
    });
    const diagnostics = new DiagnosticsHandler({
      router,
      documents,
      config: () => config,
      compiler: () => compiler,
    });
    reporter = new DiagnosticsReporter({ diagnostics });
  });

  afterEach(async () => {
    runtime.dispose();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  /** Writes a component with an external template that is missing an import. */
  async function writeBrokenExternal(name: string): Promise<string> {
    const base = path.join(root, "src", `${name.toLowerCase()}.component`);
    await fs.writeFile(`${base}.ts`, externalHost(name), "utf8");
    await fs.writeFile(`${base}.html`, "<shop-card></shop-card>", "utf8");
    await runtime.reindex();
    return `${base}.html`;
  }

  it("finds a missing import in an external template", async () => {
    const templatePath = await writeBrokenExternal("Host");

    const report = await reporter.run([runtime]);

    assert.strictEqual(report.totalIssues, 1);
    assert.deepStrictEqual(
      report.files.map((file) => file.filePath),
      [templatePath]
    );
    assert.strictEqual(report.files[0].templateType, "external");
    assert.strictEqual(report.files[0].diagnostics[0].code, "missing-component-import:shop-card");
  });

  it("finds a missing import in an inline template", async () => {
    const inlinePath = path.join(root, "src", "inline.component.ts");
    await fs.writeFile(
      inlinePath,
      [
        'import { Component } from "@angular/core";',
        '@Component({ selector: "app-inline", standalone: true, template: "<shop-card></shop-card>" })',
        "export class InlineComponent {}",
        "",
      ].join("\n"),
      "utf8"
    );
    await runtime.reindex();

    const report = await reporter.run([runtime]);

    assert.deepStrictEqual(
      report.files.map((file) => file.filePath),
      [inlinePath]
    );
    assert.strictEqual(report.files[0].templateType, "inline");
  });

  it("lists only the files a reader has to act on", async () => {
    const report = await reporter.run([runtime]);

    assert.deepStrictEqual(report.files, []);
    assert.strictEqual(report.totalIssues, 0);
  });

  it("skips a template with no component beside it", async () => {
    await fs.writeFile(path.join(root, "src", "orphan.html"), "<shop-card></shop-card>", "utf8");
    await runtime.reindex();

    const report = await reporter.run([runtime]);

    assert.deepStrictEqual(report.files, []);
  });

  it("carries a timestamp that survives JSON-RPC", async () => {
    const report = await reporter.run([runtime]);

    assert.ok(!Number.isNaN(Date.parse(report.timestamp)), "The timestamp must be a parseable ISO string");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(report)), report, "Nothing in a report may be lost to JSON");
  });

  it("reports progress as it scans", async () => {
    await writeBrokenExternal("Host");
    const reported: Array<{ message: string; percentage: number }> = [];
    const progress: ReportProgress = { report: (message, percentage) => reported.push({ message, percentage }) };

    await reporter.run([runtime], progress);

    assert.ok(reported.length > 0, "A scan must say what it is doing");
    assert.ok(
      reported.every((entry) => entry.percentage >= 0 && entry.percentage <= 100),
      "Progress must stay within its own scale"
    );
  });

  it("stops when the request is cancelled", async () => {
    await writeBrokenExternal("Host");
    const cancellation = createCancellationSource();
    cancellation.cancel();

    const report = await reporter.run([runtime], undefined, cancellation.signal);

    assert.deepStrictEqual(report.files, []);
  });

  it("reports nothing for a project with no sources at all", async () => {
    const emptyRoot = path.join(sandbox, "apps", "empty");
    await fs.mkdir(emptyRoot, { recursive: true });
    const empty = new ProjectRuntime(emptyRoot);
    await empty.load();

    const report = await reporter.run([empty]);
    empty.dispose();

    assert.deepStrictEqual(report.files, []);
    assert.strictEqual(report.truncated, undefined);
  });

  it("survives a file it cannot read", async () => {
    await writeBrokenExternal("Host");
    const failing = new DiagnosticsReporter({
      diagnostics: new DiagnosticsHandler({
        router: new ProjectRouter({
          rootForPath: () => root,
          runtimeForRoot: () => runtime,
        }),
        documents: noOpenDocuments(),
        config: () => config,
        compiler: () => compiler,
      }),
      readFile: () => Promise.reject(new Error("permission denied")),
    });

    const report = await failing.run([runtime]);

    assert.deepStrictEqual(report.files, []);
  });
});
