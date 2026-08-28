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
import {
  ApplyWorkspaceFixAllRequest,
  DiagnosticsReportRequest,
  FIX_ALL_KIND,
  PerformanceMetricsRequest,
  PrepareWorkspaceFixAllRequest,
  ReindexRequest,
} from "../../lsp/protocol";
import { FULL_CLIENT_CAPABILITIES, type Harness, startHarness } from "./harness/lsp-harness";
import { applyTextEdits } from "./harness/text";

const WHOLE_DOCUMENT = { start: { line: 0, character: 0 }, end: { line: 40, character: 0 } };

interface FixAllCounts {
  totalIssues: number;
  filesChanged: number;
  importsAdded: number;
}

type PreparedFixAllResult =
  | (FixAllCounts & { ready: true; transactionId: string })
  | { ready: false; reason: "unfixable" };

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

const BULK_ELEMENTS = [
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Epsilon",
  "Zeta",
  "Eta",
  "Theta",
  "Iota",
  "Kappa",
  "Lambda",
  "Mu",
  "Nu",
  "Xi",
  "Omicron",
  "Pi",
].map((label) => ({
  className: `Bulk${label}Component`,
  selector: `bulk-${label.toLowerCase()}`,
  moduleName: `bulk-${label.toLowerCase()}.component`,
}));

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

  async function openBulkFixAllScenario(): Promise<void> {
    await Promise.all(
      BULK_ELEMENTS.map(({ className, moduleName, selector }) =>
        fs.writeFile(path.join(root, "src", `${moduleName}.ts`), component(className, selector), "utf8")
      )
    );
    await harness.client.sendRequest(ReindexRequest, {});
    const template = Array.from({ length: 50 }, (_, index) => {
      const { selector } = BULK_ELEMENTS[index % BULK_ELEMENTS.length];
      return `<${selector}></${selector}>`;
    }).join("\n");
    await harness.open(hostPath, HOST, "typescript");
    await harness.open(templatePath, template, "html");
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
    it("applies 16 distinct imports for 50 findings in one owning component", async () => {
      await openBulkFixAllScenario();

      const prepared = (await harness.client.sendRequest(
        PrepareWorkspaceFixAllRequest,
        {}
      )) as unknown as PreparedFixAllResult;

      if (!prepared.ready) {
        assert.fail(`Expected all 50 findings to be fixable, got ${prepared.reason}`);
      }
      assert.strictEqual(prepared.totalIssues, 50);
      assert.strictEqual(prepared.importsAdded, 16);
      assert.strictEqual(prepared.filesChanged, 1);
      assert.strictEqual(harness.appliedEdits.length, 0);

      const result = await harness.client.sendRequest(ApplyWorkspaceFixAllRequest, {
        transactionId: prepared.transactionId,
      });

      assert.strictEqual(result.applied, true);
      assert.strictEqual(result.totalIssues, 50);
      assert.strictEqual(result.importsAdded, 16);
      assert.strictEqual(result.filesChanged, 1);
      assert.strictEqual(harness.appliedEdits.length, 1, "Apply must submit exactly one workspace/applyEdit request");

      const [{ edit }] = harness.appliedEdits as Array<{
        edit: {
          documentChanges: Array<{
            textDocument: { uri: string; version: number | null };
            edits: Array<{ range: CoreRange; newText: string }>;
          }>;
        };
      }>;
      assert.strictEqual(edit.documentChanges.length, 1);
      assert.strictEqual(edit.documentChanges[0].textDocument.uri, harness.uri(hostPath));
      const updatedOwner = applyTextEdits(HOST, edit.documentChanges[0].edits);
      const componentImports = updatedOwner.match(/imports:\s*\[([\s\S]*?)\]/)?.[1] ?? "";

      for (const { className, moduleName } of BULK_ELEMENTS) {
        assert.match(
          updatedOwner,
          new RegExp(`import\\s*\\{[^}]*\\b${className}\\b[^}]*\\}\\s*from\\s*["']\\./${moduleName}["']`)
        );
        assert.match(componentImports, new RegExp(`\\b${className}\\b`));
      }
    });

    it("does not expose a transaction that is already stale when index generation changes during preparation", async () => {
      await openBulkFixAllScenario();
      const before = await harness.client.sendRequest(PerformanceMetricsRequest);
      await fs.writeFile(
        path.join(root, "src", "generation-bump.component.ts"),
        component("GenerationBumpComponent", "generation-bump"),
        "utf8"
      );

      const preparation = harness.client.sendRequest(PrepareWorkspaceFixAllRequest, {});
      const reindexing = harness.client.sendRequest(ReindexRequest, {});
      const [preparedResult, reindexed] = await Promise.all([preparation, reindexing]);
      assert.ok(reindexed.projects[0].elementCount > before.projects[0].elementCount);

      const prepared = preparedResult as unknown as PreparedFixAllResult;
      if (!prepared.ready) {
        assert.deepStrictEqual(prepared, { ready: false, reason: "unfixable" });
        return;
      }

      const result = await harness.client.sendRequest(ApplyWorkspaceFixAllRequest, {
        transactionId: prepared.transactionId,
      });
      assert.strictEqual(result.applied, true, "A confirmation-ready transaction must apply against the current index");
      assert.notStrictEqual(result.reason, "stale", "Prepare must not return a transaction that is immediately stale");
    });

    it("prepares a fresh audit before applying one versioned fix-all edit across owning components", async () => {
      const offersPath = path.join(root, "src", "offers.component.ts");
      const offersTemplatePath = path.join(root, "src", "offers.component.html");
      const offers = HOST.replace('selector: "app-host"', 'selector: "app-offers"')
        .replace('templateUrl: "./host.component.html"', 'templateUrl: "./offers.component.html"')
        .replace("HostComponent", "OffersComponent");
      await fs.writeFile(offersPath, offers, "utf8");
      await fs.writeFile(offersTemplatePath, "", "utf8");
      await harness.client.sendRequest(ReindexRequest, {});

      await harness.open(hostPath, HOST, "typescript");
      await harness.open(offersPath, offers, "typescript");
      await harness.open(templatePath, "<shop-card></shop-card><shop-badge></shop-badge>", "html");
      await harness.open(offersTemplatePath, "<shop-card></shop-card>", "html");
      await harness.changeSettings({ importModuleSpecifier: "non-relative" });

      const prepared = (await harness.client.sendRequest(
        PrepareWorkspaceFixAllRequest,
        {}
      )) as unknown as PreparedFixAllResult;

      if (!prepared.ready) {
        assert.fail(`Expected a ready Fix All, got ${prepared.reason}`);
      }
      assert.strictEqual(prepared.ready, true);
      assert.ok(prepared.transactionId, "Preparation must return an opaque transaction to confirm");
      assert.strictEqual(prepared.totalIssues, 3);
      assert.strictEqual(prepared.filesChanged, 2);
      assert.strictEqual(prepared.importsAdded, 3);
      assert.strictEqual(harness.appliedEdits.length, 0, "Preparation only describes the edit awaiting confirmation");

      const result = await harness.client.sendRequest(ApplyWorkspaceFixAllRequest, {
        transactionId: prepared.transactionId,
      });

      assert.strictEqual(result.applied, true);
      assert.strictEqual(result.totalIssues, 3);
      assert.strictEqual(result.filesChanged, 2);
      assert.strictEqual(result.importsAdded, 3);
      assert.strictEqual(harness.appliedEdits.length, 1, "Fix All must be one atomic client operation");

      const [{ edit }] = harness.appliedEdits as Array<{
        edit: {
          documentChanges: Array<{
            textDocument: { uri: string; version: number | null };
            edits: Array<{ range: CoreRange; newText: string }>;
          }>;
        };
      }>;
      assert.strictEqual(edit.documentChanges.length, 2);
      assert.ok(
        edit.documentChanges.every((change) => change.textDocument.version === 1),
        "Every open owner must be guarded by the version that was audited"
      );

      const changesByUri = new Map(edit.documentChanges.map((change) => [change.textDocument.uri, change]));
      const updatedHost = applyTextEdits(HOST, changesByUri.get(harness.uri(hostPath))?.edits ?? []);
      const updatedOffers = applyTextEdits(offers, changesByUri.get(harness.uri(offersPath))?.edits ?? []);

      assert.match(updatedHost, /from ["']~\/shop-card\.component["']/);
      assert.match(updatedHost, /from ["']~\/shop-badge\.component["']/);
      assert.match(updatedHost, /imports: \[[^\]]*ShopCardComponent/);
      assert.match(updatedHost, /imports: \[[^\]]*ShopBadgeComponent/);
      assert.match(updatedOffers, /from ["']~\/shop-card\.component["']/);
      assert.match(updatedOffers, /imports: \[[^\]]*ShopCardComponent/);
    });

    it("applies an audited external template to its aliased owner outside the project root", async () => {
      const aliasRoot = path.join(sandbox, "aliased-owner");
      const aliasedHostPath = path.join(aliasRoot, "aliased-host.component.ts");
      const aliasedTemplatePath = path.join(aliasRoot, "aliased-host.component.html");
      const aliasedHost = HOST.replace('selector: "app-host"', 'selector: "app-aliased-host"')
        .replace('templateUrl: "./host.component.html"', 'templateUrl: "./aliased-host.component.html"')
        .replace("HostComponent", "AliasedHostComponent");
      await fs.mkdir(aliasRoot, { recursive: true });
      await fs.writeFile(aliasedHostPath, aliasedHost, "utf8");
      await fs.writeFile(aliasedTemplatePath, "<shop-card></shop-card>", "utf8");
      await fs.writeFile(
        path.join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "~/*": ["src/*"], "@aliased-owner/*": ["../aliased-owner/*"] },
          },
        }),
        "utf8"
      );
      await harness.client.sendRequest(ReindexRequest, {});
      await harness.open(aliasedHostPath, aliasedHost, "typescript");
      await harness.open(aliasedTemplatePath, "<shop-card></shop-card>", "html");

      const prepared = (await harness.client.sendRequest(
        PrepareWorkspaceFixAllRequest,
        {}
      )) as unknown as PreparedFixAllResult;

      if (!prepared.ready) {
        assert.fail(`Expected the aliased owner to be fixable, got ${prepared.reason}`);
      }
      assert.strictEqual(prepared.ready, true);
      assert.strictEqual(prepared.totalIssues, 1);
      assert.strictEqual(prepared.filesChanged, 1);
      assert.strictEqual(prepared.importsAdded, 1);

      const result = await harness.client.sendRequest(ApplyWorkspaceFixAllRequest, {
        transactionId: prepared.transactionId,
      });

      assert.strictEqual(result.applied, true);
      assert.strictEqual(harness.appliedEdits.length, 1);
      const [{ edit }] = harness.appliedEdits as Array<{
        edit: {
          documentChanges: Array<{
            textDocument: { uri: string; version: number | null };
            edits: Array<{ range: CoreRange; newText: string }>;
          }>;
        };
      }>;
      assert.strictEqual(edit.documentChanges.length, 1);
      assert.strictEqual(edit.documentChanges[0].textDocument.uri, harness.uri(aliasedHostPath));
      assert.strictEqual(edit.documentChanges[0].textDocument.version, 1);
      assert.match(applyTextEdits(aliasedHost, edit.documentChanges[0].edits), /imports: \[ShopCardComponent]/);
    });

    it("consumes a prepared fix-all without editing when its audited document changed", async () => {
      await harness.open(hostPath, HOST, "typescript");
      await harness.open(templatePath, "<shop-card></shop-card>", "html");
      const prepared = (await harness.client.sendRequest(
        PrepareWorkspaceFixAllRequest,
        {}
      )) as unknown as PreparedFixAllResult;
      if (!prepared.ready) {
        assert.fail(`Expected a ready Fix All, got ${prepared.reason}`);
      }
      assert.strictEqual(prepared.ready, true);

      await harness.change(templatePath, "<shop-badge></shop-badge>");

      const stale = (await harness.client.sendRequest(ApplyWorkspaceFixAllRequest, {
        transactionId: prepared.transactionId,
      })) as { applied: boolean; reason?: string };

      assert.strictEqual(stale.applied, false);
      assert.strictEqual(stale.reason, "stale");
      assert.strictEqual(harness.appliedEdits.length, 0, "A stale snapshot must never reach workspace/applyEdit");

      const consumed = await harness.client.sendRequest(ApplyWorkspaceFixAllRequest, {
        transactionId: prepared.transactionId,
      });

      assert.strictEqual(consumed.applied, false, "A stale transaction must be consumed by its first apply attempt");
      assert.strictEqual(harness.appliedEdits.length, 0);
    });

    it("refuses to prepare any fix-all when an owning component cannot be edited", async () => {
      const unfixableHost = HOST.replace(
        'import { Component } from "@angular/core";',
        'import { Component } from "@angular/core";\n\nconst CURRENT_IMPORTS: never[] = [];'
      ).replace("imports: []", "imports: CURRENT_IMPORTS");
      await harness.open(hostPath, unfixableHost, "typescript");
      await harness.open(templatePath, "<shop-card></shop-card>", "html");

      const prepared = (await harness.client.sendRequest(
        PrepareWorkspaceFixAllRequest,
        {}
      )) as unknown as PreparedFixAllResult;

      if (prepared.ready) {
        assert.fail("An unfixable plan must not expose a transaction");
      }
      assert.strictEqual(prepared.ready, false);
      assert.strictEqual(prepared.reason, "unfixable");
      assert.ok(!("transactionId" in prepared), "There must be no Apply step for a partial plan");
      assert.strictEqual(harness.appliedEdits.length, 0);
    });

    it("refuses a bulk edit when the client cannot apply text changes transactionally", async () => {
      const nonTransactional = await startHarness({
        workspaceRoots: [root],
        capabilities: {
          ...FULL_CLIENT_CAPABILITIES,
          workspace: { ...FULL_CLIENT_CAPABILITIES.workspace, workspaceEdit: undefined },
        },
      });
      try {
        await nonTransactional.waitForProjects();
        await nonTransactional.open(templatePath, "<shop-card></shop-card>", "html");

        const prepared = await nonTransactional.client.sendRequest(PrepareWorkspaceFixAllRequest, {});

        assert.deepStrictEqual(prepared, { ready: false, reason: "unfixable" });
        assert.strictEqual(nonTransactional.appliedEdits.length, 0);
      } finally {
        await nonTransactional.dispose();
      }
    });

    it("refuses an owner file with more than one component decorator", async () => {
      const ambiguous = `${HOST}\n${HOST.replace("HostComponent", "SecondHostComponent")}\n`;
      await harness.open(hostPath, ambiguous, "typescript");
      await harness.open(templatePath, "<shop-card></shop-card>", "html");

      const prepared = await harness.client.sendRequest(PrepareWorkspaceFixAllRequest, {});

      assert.deepStrictEqual(prepared, { ready: false, reason: "unfixable" });
      assert.strictEqual(harness.appliedEdits.length, 0);
    });

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
