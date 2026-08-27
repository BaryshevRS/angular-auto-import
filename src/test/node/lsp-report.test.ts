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
function externalHost(className: string, templateUrl = `./${className.toLowerCase()}.component.html`): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    `  selector: "${className.toLowerCase()}",`,
    "  standalone: true,",
    `  templateUrl: "${templateUrl}",`,
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
  let diagnostics: DiagnosticsHandler;
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
    diagnostics = new DiagnosticsHandler({
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

  it("resolves an external template to its owning component when paths and basenames differ", async () => {
    const componentPath = path.join(root, "src", "host-shell.component.ts");
    const templatePath = path.join(root, "src", "templates", "dashboard.html");
    await fs.mkdir(path.dirname(templatePath), { recursive: true });
    await fs.writeFile(
      componentPath,
      [
        'import { Component } from "@angular/core";',
        "",
        "@Component({",
        '  selector: "host-shell",',
        "  standalone: true,",
        '  templateUrl: "./templates/dashboard.html",',
        "  imports: [],",
        "})",
        "export class HostShellComponent {}",
        "",
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(templatePath, "<shop-card></shop-card>", "utf8");
    await runtime.reindex();

    const report = await reporter.run([runtime]);

    assert.deepStrictEqual(
      report.files.map((file) => file.filePath),
      [templatePath]
    );
    assert.strictEqual(report.files[0]?.templateType, "external");
    assert.strictEqual(report.files[0]?.diagnostics[0]?.code, "missing-component-import:shop-card");
  });

  it("analyzes an external template mapped outside the project through a tsconfig path alias", async () => {
    const aliasRoot = path.join(sandbox, "libs", "audit-target");
    const componentPath = path.join(aliasRoot, "aliased-host.component.ts");
    const templatePath = path.join(aliasRoot, "aliased-host.component.html");
    await fs.mkdir(aliasRoot, { recursive: true });
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@audit-target/*": ["../../libs/audit-target/*"] },
        },
      }),
      "utf8"
    );
    await fs.writeFile(componentPath, externalHost("AliasedHost", "./aliased-host.component.html"), "utf8");
    await fs.writeFile(templatePath, "<shop-card></shop-card>", "utf8");

    runtime.dispose();
    runtime = new ProjectRuntime(root);
    await runtime.load();

    const report = await reporter.run([runtime]);

    assert.strictEqual(
      report.templatesScanned,
      2,
      "The aliased external template must count alongside the app template"
    );
    assert.deepStrictEqual(
      report.files.map((file) => file.filePath),
      [templatePath],
      "A paths-mapped template remains owned by the app runtime even outside its root"
    );
    assert.strictEqual(report.files[0]?.diagnostics[0]?.code, "missing-component-import:shop-card");
  });

  it("excludes a stale same-basename template when templateUrl names a different file", async () => {
    const componentPath = path.join(root, "src", "foo.ts");
    const currentTemplatePath = path.join(root, "src", "current.html");
    const staleTemplatePath = path.join(root, "src", "foo.html");
    await fs.writeFile(componentPath, externalHost("Foo", "./current.html"), "utf8");
    await fs.writeFile(currentTemplatePath, "<shop-card></shop-card>", "utf8");
    await fs.writeFile(staleTemplatePath, "<shop-card></shop-card>", "utf8");
    await runtime.reindex();

    const report = await reporter.run([runtime]);

    assert.deepStrictEqual(
      report.files.map((file) => file.filePath),
      [currentTemplatePath]
    );
    assert.strictEqual(
      report.files.some((file) => file.filePath === staleTemplatePath),
      false
    );
    assert.strictEqual(report.templatesScanned, 2, "The stale HTML file must not count as a component template");
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

  it("reports completed project scan metadata with actual template counts", async () => {
    await fs.writeFile(path.join(root, "src", "utility.ts"), "export const value = 1;\n", "utf8");
    await writeBrokenExternal("Host");

    const report = await reporter.run([runtime]);

    assert.strictEqual(report.scope, "project");
    assert.strictEqual(report.projectsScanned, 1);
    assert.strictEqual(report.templatesScanned, 2);
    assert.strictEqual(report.complete, true);
    assert.deepStrictEqual(report.incompleteReasons, []);
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

  it("marks a scan cancelled before it starts as incomplete", async () => {
    const cancellation = createCancellationSource();
    cancellation.cancel();

    const report = await reporter.run([runtime], undefined, cancellation.signal, "workspace");

    assert.strictEqual(report.scope, "workspace");
    assert.strictEqual(report.projectsScanned, 0);
    assert.strictEqual(report.templatesScanned, 0);
    assert.strictEqual(report.complete, false);
    assert.deepStrictEqual(report.incompleteReasons, ["cancelled"]);
    assert.deepStrictEqual(report.files, []);
  });

  it("marks a scan incomplete when analysis is not ready", async () => {
    const unavailableReporter = new DiagnosticsReporter({
      diagnostics,
      analysisReady: () => false,
    });

    const report = await unavailableReporter.run([runtime]);

    assert.strictEqual(report.complete, false);
    assert.deepStrictEqual(report.incompleteReasons, ["analysis-not-ready"]);
    assert.strictEqual(report.templatesScanned, 0);
    assert.deepStrictEqual(report.files, []);
  });

  it("returns an explicitly cancelled partial report when cancellation arrives mid-audit", async () => {
    await writeBrokenExternal("Host");
    const cancellation = createCancellationSource();
    let reads = 0;
    const cancellingDiagnostics = {
      analyzeRouted: (...args: Parameters<DiagnosticsHandler["analyzeRouted"]>) => {
        const result = diagnostics.analyzeRouted(...args);
        cancellation.cancel();
        return result;
      },
      analyze: diagnostics.analyze.bind(diagnostics),
    } as DiagnosticsHandler;
    const cancellingReporter = new DiagnosticsReporter({
      diagnostics: cancellingDiagnostics,
      readFile: async (filePath) => {
        const contents = await fs.readFile(filePath, "utf8");
        reads += 1;
        return contents;
      },
    });

    const report = await cancellingReporter.run([runtime], undefined, cancellation.signal);

    assert.strictEqual(report.complete, false);
    assert.deepStrictEqual(report.incompleteReasons, ["cancelled"]);
    assert.strictEqual(reads, 1, "Cancellation must prevent reading the next candidate");
    assert.strictEqual(report.templatesScanned, 1);
    assert.strictEqual(report.projectsScanned, 1);
    assert.strictEqual(report.files.length, 1);
  });

  it("passes cancellation into analysis so one large template can stop with a partial report", async () => {
    const templatePath = path.join("/workspace", "large.component.ts");
    const cancellation = createCancellationSource();
    let observedSignal: unknown;
    const fakeRuntime = {
      listSourceFiles: async () => [templatePath],
      listTemplateFiles: async () => [],
    } as unknown as ProjectRuntime;
    const fakeDiagnostics = {
      analyze: (document: { uri: string; version: number }, signal: unknown) => {
        observedSignal = signal;
        cancellation.cancel();
        return {
          uri: document.uri,
          version: document.version,
          generation: 0,
          candidates: [],
        };
      },
    } as unknown as DiagnosticsHandler;
    const cancellingReporter = new DiagnosticsReporter({
      diagnostics: fakeDiagnostics,
      readFile: async () => `<shop-card></shop-card>`.repeat(10000),
    });

    const report = await cancellingReporter.run([fakeRuntime], undefined, cancellation.signal);

    assert.strictEqual(observedSignal, cancellation.signal, "Diagnostics analysis must receive the request signal");
    assert.strictEqual(report.complete, false);
    assert.deepStrictEqual(report.incompleteReasons, ["cancelled"]);
    assert.strictEqual(report.templatesScanned, 1);
  });

  it("marks the report incomplete when the file finding limit is reached", async () => {
    const fakeRuntime = {
      listSourceFiles: async () =>
        Array.from({ length: 501 }, (_, index) => path.join("/workspace", `component-${index}.ts`)),
      listTemplateFiles: async () => [],
    } as unknown as ProjectRuntime;
    const fakeDiagnostics = {
      analyze: (document: { uri: string; version: number }) => ({
        uri: document.uri,
        version: document.version,
        generation: 0,
        candidates: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            message: "Missing import",
            code: "missing-component-import:fake",
            source: "angular-auto-import",
            severity: "warning",
            elements: [],
          },
        ],
      }),
    } as unknown as DiagnosticsHandler;
    const limitedReporter = new DiagnosticsReporter({ diagnostics: fakeDiagnostics, readFile: async () => "" });

    const report = await limitedReporter.run([fakeRuntime]);

    assert.strictEqual(report.truncated, true);
    assert.deepStrictEqual(report.incompleteReasons, ["file-limit"]);
    assert.strictEqual(report.complete, false);
    assert.strictEqual(report.templatesScanned, 500);
    assert.strictEqual(report.files.length, 500);
  });

  it("marks a report incomplete when one template reaches the diagnostic limit", async () => {
    const declarationsPath = path.join(root, "src", "many-elements.ts");
    const templatePath = path.join(root, "src", "crowded.component.html");
    const declarations = [
      'import { Component } from "@angular/core";',
      ...Array.from(
        { length: 101 },
        (_, index) =>
          `@Component({ selector: "audit-item-${index}", standalone: true, template: "" })\nexport class AuditItem${index}Component {}`
      ),
      "",
    ].join("\n");
    await fs.writeFile(declarationsPath, declarations, "utf8");
    await fs.writeFile(
      path.join(root, "src", "crowded.component.ts"),
      externalHost("Crowded", "./crowded.component.html"),
      "utf8"
    );
    await fs.writeFile(
      templatePath,
      Array.from({ length: 101 }, (_, index) => `<audit-item-${index}></audit-item-${index}>`).join("\n"),
      "utf8"
    );
    await runtime.reindex();

    const report = await reporter.run([runtime]);

    assert.strictEqual(report.files[0]?.diagnostics.length, 100);
    assert.strictEqual(report.complete, false);
    assert.deepStrictEqual(report.incompleteReasons, [`diagnostic-limit:${templatePath}`]);
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

    assert.strictEqual(report.complete, false);
    assert.deepStrictEqual(report.incompleteReasons, ["read-error"]);
    assert.strictEqual(report.templatesScanned, 0);
    assert.deepStrictEqual(report.files, []);
  });
});
