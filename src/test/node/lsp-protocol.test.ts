import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CodeActionRequest,
  CodeActionResolveRequest,
  CompletionRequest,
  DefinitionRequest,
  DocumentDiagnosticRequest,
  ExecuteCommandRequest,
} from "vscode-languageserver-protocol";
import type { CoreRange } from "../../core/language-types";
import { APPLY_IMPORT_COMMAND } from "../../lsp/import-command";
import { DiagnosticsReportRequest, FIX_ALL_KIND, PerformanceMetricsRequest, ReindexRequest } from "../../lsp/protocol";
import { FULL_CLIENT_CAPABILITIES, type Harness, startHarness } from "./harness/lsp-harness";
import { applyTextEdits } from "./harness/text";

const WHOLE_DOCUMENT = { start: { line: 0, character: 0 }, end: { line: 40, character: 0 } };

function component(name: string, selector: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    `@Component({ selector: "${selector}", standalone: true, template: "" })`,
    `export class ${name} {}`,
    "",
  ].join("\n");
}

const HOST = [
  'import { Component } from "@angular/core";',
  "",
  "@Component({",
  '  selector: "app-host",',
  "  standalone: true,",
  '  templateUrl: "./host.component.html",',
  "  imports: [],",
  "})",
  "export class HostComponent {}",
  "",
].join("\n");

describe("LSP protocol", function () {
  this.timeout(30000);

  let sandbox: string;
  let root: string;
  let templatePath: string;
  let hostPath: string;
  let harness: Harness;

  /** A workspace that looks like an Angular project to discovery. */
  async function writeWorkspace(): Promise<void> {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "shop", dependencies: { "@angular/core": "^19.0.0" } }),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } } }),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "src", "shop-card.component.ts"),
      component("ShopCardComponent", "shop-card"),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "src", "shop-badge.component.ts"),
      component("ShopBadgeComponent", "shop-badge"),
      "utf8"
    );
    hostPath = path.join(root, "src", "host.component.ts");
    templatePath = path.join(root, "src", "host.component.html");
    await fs.writeFile(hostPath, HOST, "utf8");
    await fs.writeFile(templatePath, "", "utf8");
  }

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-protocol-"));
    root = path.join(sandbox, "shop");
    await writeWorkspace();
    harness = await startHarness({ workspaceRoots: [root], storagePath: path.join(sandbox, "storage") });
    await harness.waitForProjects();
  });

  afterEach(async () => {
    await harness.dispose();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("advertises the features the client can then use", () => {
      const { capabilities } = harness;

      assert.deepStrictEqual(capabilities.completionProvider?.triggerCharacters, ["<", "|", " ", "[", "*"]);
      assert.deepStrictEqual(capabilities.executeCommandProvider?.commands, [APPLY_IMPORT_COMMAND]);
      assert.strictEqual(capabilities.definitionProvider, true);
      assert.deepStrictEqual(capabilities.diagnosticProvider, {
        interFileDependencies: true,
        workspaceDiagnostics: false,
      });
      assert.deepStrictEqual(
        typeof capabilities.codeActionProvider === "object" ? capabilities.codeActionProvider.codeActionKinds : [],
        ["quickfix", FIX_ALL_KIND]
      );
    });

    it("does not promise resolution to a client that cannot resolve", async () => {
      const plain = await startHarness({
        workspaceRoots: [root],
        capabilities: { ...FULL_CLIENT_CAPABILITIES, textDocument: { synchronization: {} } },
      });

      const provider = plain.capabilities.codeActionProvider;
      assert.strictEqual(typeof provider === "object" && provider.resolveProvider, false);
      await plain.dispose();
    });
  });

  describe("document synchronization", () => {
    it("completes an element the open template does not import", async () => {
      await harness.open(templatePath, "<shop-c", "html");

      const completions = (await harness.client.sendRequest(CompletionRequest.type, {
        textDocument: { uri: harness.uri(templatePath) },
        position: { line: 0, character: 7 },
      })) as { items: Array<{ label: string }> } | null;

      assert.deepStrictEqual(
        completions?.items.map((item) => item.label),
        ["shop-card"]
      );
    });

    it("re-ranks against the text the client last sent", async () => {
      await harness.open(templatePath, "<shop-c", "html");
      await harness.change(templatePath, "<shop-b");

      const completions = (await harness.client.sendRequest(CompletionRequest.type, {
        textDocument: { uri: harness.uri(templatePath) },
        position: { line: 0, character: 7 },
      })) as { items: Array<{ label: string }> } | null;

      assert.deepStrictEqual(
        completions?.items.map((item) => item.label),
        ["shop-badge"]
      );
    });

    it("stops answering for a document the client closed", async () => {
      await harness.open(templatePath, "<shop-card></shop-card>", "html");
      await harness.close(templatePath);

      const report = (await harness.client.sendRequest(DocumentDiagnosticRequest.type, {
        textDocument: { uri: harness.uri(templatePath) },
      })) as { items: unknown[] };

      assert.deepStrictEqual(report.items, []);
    });
  });

  describe("diagnostics", () => {
    it("reports a missing import over the wire", async () => {
      await harness.open(templatePath, "<shop-card></shop-card>", "html");

      const report = (await harness.client.sendRequest(DocumentDiagnosticRequest.type, {
        textDocument: { uri: harness.uri(templatePath) },
      })) as { kind: string; items: Array<{ code: string; source: string }> };

      assert.strictEqual(report.kind, "full");
      assert.strictEqual(report.items.length, 1);
      assert.strictEqual(report.items[0].code, "missing-component-import:shop-card");
      assert.strictEqual(report.items[0].source, "angular-auto-import");
    });

    it("clears once the component's unsaved text imports the element", async () => {
      await harness.open(templatePath, "<shop-card></shop-card>", "html");
      await harness.open(hostPath, HOST, "typescript");
      await harness.change(
        hostPath,
        HOST.replace("imports: []", "imports: [ShopCardComponent]").replace(
          'import { Component } from "@angular/core";',
          'import { Component } from "@angular/core";\nimport { ShopCardComponent } from "./shop-card.component";'
        )
      );

      const report = (await harness.client.sendRequest(DocumentDiagnosticRequest.type, {
        textDocument: { uri: harness.uri(templatePath) },
      })) as { items: unknown[] };

      assert.deepStrictEqual(report.items, [], "An import the user typed but never saved must already count");
    });

    it("asks the client to re-pull after a TypeScript document changes", async () => {
      await harness.open(hostPath, HOST, "typescript");
      const before = harness.diagnosticRefreshes();

      await harness.change(hostPath, `${HOST}\n// edited`);
      await new Promise((resolve) => setTimeout(resolve, 200));

      assert.ok(
        harness.diagnosticRefreshes() > before,
        "An external template's report depends on its component, which the client cannot know"
      );
    });
  });

  describe("code actions", () => {
    it("changes module-specifier style without rebuilding the project", async () => {
      await harness.open(templatePath, "<shop-card></shop-card>", "html");

      const quickFixTitle = async (): Promise<string> => {
        await harness.client.sendRequest(DocumentDiagnosticRequest.type, {
          textDocument: { uri: harness.uri(templatePath) },
        });
        const [action] = (await harness.client.sendRequest(CodeActionRequest.type, {
          textDocument: { uri: harness.uri(templatePath) },
          range: WHOLE_DOCUMENT,
          context: { diagnostics: [], only: ["quickfix"] },
        })) as Array<{ title: string }>;
        return action.title;
      };

      assert.match(await quickFixTitle(), /from '\.\/shop-card\.component'$/);

      await harness.changeSettings({ importModuleSpecifier: "non-relative" });

      assert.match(await quickFixTitle(), /from '~\/shop-card\.component'$/);
    });

    it("offers a quick fix whose edit arrives on resolution", async () => {
      await harness.open(templatePath, "<shop-card></shop-card>", "html");

      const [action] = (await harness.client.sendRequest(CodeActionRequest.type, {
        textDocument: { uri: harness.uri(templatePath) },
        range: WHOLE_DOCUMENT,
        context: { diagnostics: [] },
      })) as Array<Record<string, unknown>>;
      assert.strictEqual(action.edit, undefined, "The edit is too expensive to send before it is wanted");

      const resolved = (await harness.client.sendRequest(CodeActionResolveRequest.type, action as never)) as {
        edit?: {
          documentChanges: Array<{
            textDocument: { uri: string };
            edits: Array<{ range: CoreRange; newText: string }>;
          }>;
        };
      };

      const change = resolved.edit?.documentChanges[0];
      assert.strictEqual(change?.textDocument.uri, harness.uri(hostPath), "The import belongs in the component");
      assert.match(applyTextEdits(HOST, change.edits), /imports: \[ShopCardComponent]/);
    });

    it("offers a fix-all for a template missing several elements", async () => {
      await harness.open(templatePath, "<shop-card></shop-card><shop-badge></shop-badge>", "html");

      const actions = (await harness.client.sendRequest(CodeActionRequest.type, {
        textDocument: { uri: harness.uri(templatePath) },
        range: WHOLE_DOCUMENT,
        context: { diagnostics: [], only: [FIX_ALL_KIND] },
      })) as Array<{ kind: string; title: string }>;

      assert.deepStrictEqual(
        actions.map((action) => action.kind),
        [FIX_ALL_KIND]
      );
      assert.match(actions[0].title, /2 missing Angular elements/);
    });
  });

  describe("workspace edits", () => {
    it("applies an accepted completion's import to the component file", async () => {
      await harness.open(templatePath, "<shop-c", "html");
      const completions = (await harness.client.sendRequest(CompletionRequest.type, {
        textDocument: { uri: harness.uri(templatePath) },
        position: { line: 0, character: 7 },
      })) as { items: Array<{ command: { command: string; arguments: unknown[] } }> };

      await harness.client.sendRequest(ExecuteCommandRequest.type, {
        command: completions.items[0].command.command,
        arguments: completions.items[0].command.arguments,
      });

      assert.strictEqual(harness.appliedEdits.length, 1);
      const edit = harness.appliedEdits[0] as {
        edit: { documentChanges: Array<{ textDocument: { uri: string; version: number | null } }> };
      };
      assert.strictEqual(edit.edit.documentChanges[0].textDocument.uri, harness.uri(hostPath));
      assert.strictEqual(
        edit.edit.documentChanges[0].textDocument.version,
        null,
        "Nobody has the component open, so there is no version to guard"
      );
    });

    it("leaves the file on disk untouched, since the edit is the client's to apply", async () => {
      await harness.open(templatePath, "<shop-c", "html");
      const completions = (await harness.client.sendRequest(CompletionRequest.type, {
        textDocument: { uri: harness.uri(templatePath) },
        position: { line: 0, character: 7 },
      })) as { items: Array<{ command: { command: string; arguments: unknown[] } }> };

      await harness.client.sendRequest(ExecuteCommandRequest.type, {
        command: completions.items[0].command.command,
        arguments: completions.items[0].command.arguments,
      });

      assert.strictEqual(await fs.readFile(hostPath, "utf8"), HOST);
    });
  });

  describe("definitions", () => {
    it("resolves an unimported element to its declaration", async () => {
      await harness.open(templatePath, "<shop-card></shop-card>", "html");

      const links = (await harness.client.sendRequest(DefinitionRequest.type, {
        textDocument: { uri: harness.uri(templatePath) },
        position: { line: 0, character: 5 },
      })) as Array<{ targetUri: string }>;

      assert.deepStrictEqual(
        links.map((link) => link.targetUri),
        [harness.uri(path.join(root, "src", "shop-card.component.ts"))]
      );
    });
  });

  describe("custom requests", () => {
    it("reindexes and reports what each project holds", async () => {
      await harness.open(templatePath, "", "html");

      const result = await harness.client.sendRequest(ReindexRequest, {});

      assert.deepStrictEqual(
        result.projects.map((project) => project.rootPath),
        [root]
      );
      // Three: the two elements the templates need, plus the host component itself.
      assert.strictEqual(result.projects[0].elementCount, 3);
    });

    it("reports the server process's own metrics", async () => {
      await harness.open(templatePath, "", "html");

      const metrics = await harness.client.sendRequest(PerformanceMetricsRequest);

      assert.ok(metrics.memory.rss > 0);
      assert.deepStrictEqual(
        metrics.projects.map((project) => project.rootPath),
        [root]
      );
    });

    it("scans the workspace for missing imports", async () => {
      await fs.writeFile(templatePath, "<shop-card></shop-card>", "utf8");
      await harness.open(templatePath, "<shop-card></shop-card>", "html");

      const report = await harness.client.sendRequest(DiagnosticsReportRequest, {});

      assert.strictEqual(report.totalIssues, 1);
      assert.deepStrictEqual(
        report.files.map((file) => file.filePath),
        [templatePath]
      );
      assert.ok(!Number.isNaN(Date.parse(report.timestamp)));
    });
  });
});
