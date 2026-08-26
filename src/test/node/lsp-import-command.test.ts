import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  APPLY_IMPORT_COMMAND,
  type ApplyImportArguments,
  ImportCommandHandler,
  type VersionedWorkspaceEdit,
} from "../../lsp/import-command";
import { OpenDocuments, type SynchronizedDocument } from "../../lsp/open-documents";
import { ProjectRouter } from "../../lsp/project-router";
import { ProjectRuntime } from "../../lsp/project-runtime";
import { applyTextEdits } from "./harness/text";

/** Presents whatever documents a test declares as synchronized. */
function documentSource(documents: SynchronizedDocument[]): OpenDocuments {
  const open = new OpenDocuments({
    get: (uri) => documents.find((document) => document.uri === uri),
    all: () => documents,
    onDidOpen: () => undefined,
    onDidSave: () => undefined,
    onDidClose: () => undefined,
  });
  open.listen();
  return open;
}

async function writeProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@shop/*": ["src/*"] } } }),
    "utf8"
  );
}

const HOST_SOURCE = [
  'import { Component } from "@angular/core";',
  "",
  "@Component({",
  '  selector: "app-host",',
  "  standalone: true,",
  '  template: "<shop-card></shop-card>",',
  "  imports: [],",
  "})",
  "export class HostComponent {}",
  "",
].join("\n");

describe("LSP import command", function () {
  this.timeout(15000);

  let sandbox: string;
  let root: string;
  let runtime: ProjectRuntime;
  let hostPath: string;
  let hostUri: string;
  let applied: VersionedWorkspaceEdit[];

  function handlerFor(documents: SynchronizedDocument[] = [], accept = true): ImportCommandHandler {
    const router = new ProjectRouter({
      rootForPath: (filePath) => (filePath.startsWith(root) ? root : undefined),
      runtimeForRoot: (rootPath) => (rootPath === root ? runtime : undefined),
    });
    return new ImportCommandHandler({
      router,
      documents: documentSource(documents),
      applyEdit: async (edit) => {
        applied.push(edit);
        return accept;
      },
    });
  }

  function importCardInto(uri = hostUri): ApplyImportArguments {
    const [element] = runtime.indexer.getElements("shop-card");
    assert.ok(element, "The fixture component must be indexed before it can be imported");
    return { uri, elements: [element] };
  }

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-import-command-"));
    root = path.join(sandbox, "apps", "shop");
    applied = [];
    await writeProject(root);
    await fs.writeFile(
      path.join(root, "src", "shop-card.component.ts"),
      [
        'import { Component } from "@angular/core";',
        "",
        '@Component({ selector: "shop-card", standalone: true, template: "" })',
        "export class ShopCardComponent {}",
        "",
      ].join("\n"),
      "utf8"
    );
    hostPath = path.join(root, "src", "host.component.ts");
    hostUri = pathToFileURL(hostPath).toString();
    await fs.writeFile(hostPath, HOST_SOURCE, "utf8");
    runtime = new ProjectRuntime(root);
    await runtime.load();
  });

  afterEach(async () => {
    runtime.dispose();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("sends the client an edit that imports the element through the project's alias", async () => {
    const result = await handlerFor().execute([importCardInto()]);

    assert.deepStrictEqual(result, { applied: true, addedImports: ["ShopCardComponent"] });
    assert.strictEqual(applied.length, 1);
    const [change] = applied[0].documentChanges;
    assert.strictEqual(change.textDocument.uri, hostUri);
    const edited = applyTextEdits(HOST_SOURCE, change.edits);
    assert.match(edited, /import \{ ShopCardComponent } from "@shop\/shop-card\.component";/);
    assert.match(edited, /imports: \[ShopCardComponent]/);
  });

  it("never writes the file itself, so the edit stays the client's to undo", async () => {
    await handlerFor().execute([importCardInto()]);

    assert.strictEqual(await fs.readFile(hostPath, "utf8"), HOST_SOURCE);
  });

  it("guards the edit with the open document's version", async () => {
    const document: SynchronizedDocument = {
      uri: hostUri,
      languageId: "typescript",
      version: 7,
      getText: () => HOST_SOURCE,
    };

    await handlerFor([document]).execute([importCardInto()]);

    assert.strictEqual(applied[0].documentChanges[0].textDocument.version, 7);
  });

  it("leaves the version open for a file nobody has open", async () => {
    await handlerFor().execute([importCardInto()]);

    assert.strictEqual(applied[0].documentChanges[0].textDocument.version, null);
  });

  it("plans against an open document's unsaved text rather than the file on disk", async () => {
    const unsaved = HOST_SOURCE.replace("export class HostComponent {}", "export class RenamedComponent {}");
    const document: SynchronizedDocument = {
      uri: hostUri,
      languageId: "typescript",
      version: 2,
      getText: () => unsaved,
    };

    await handlerFor([document]).execute([importCardInto()]);

    assert.match(applyTextEdits(unsaved, applied[0].documentChanges[0].edits), /export class RenamedComponent/);
  });

  it("changes nothing when the element is already imported", async () => {
    await handlerFor().execute([importCardInto()]);
    const alreadyImported = applyTextEdits(HOST_SOURCE, applied[0].documentChanges[0].edits);
    await fs.writeFile(hostPath, alreadyImported, "utf8");
    applied = [];

    const result = await handlerFor().execute([importCardInto()]);

    assert.deepStrictEqual(result, { applied: true, addedImports: [] });
    assert.deepStrictEqual(applied, []);
  });

  it("reports a client that refused the edit instead of claiming success", async () => {
    const result = await handlerFor([], false).execute([importCardInto()]);

    assert.deepStrictEqual(result, { applied: false, addedImports: [], reason: "rejected" });
  });

  it("refuses a file no discovered project owns", async () => {
    const outside = pathToFileURL(path.join(sandbox, "elsewhere", "host.component.ts")).toString();

    const result = await handlerFor().execute([importCardInto(outside)]);

    assert.strictEqual(result.reason, "unroutable");
    assert.deepStrictEqual(applied, []);
  });

  it("refuses an argument that does not describe an element", async () => {
    for (const args of [undefined, [{}], [{ uri: hostUri }], [{ uri: hostUri, elements: [{ name: "X" }] }]]) {
      const result = await handlerFor().execute(args);
      assert.strictEqual(result.reason, "unroutable", `Expected ${JSON.stringify(args)} to be refused`);
    }
    assert.deepStrictEqual(applied, []);
  });

  it("reports a file it cannot read instead of planning against nothing", async () => {
    await fs.rm(hostPath);

    const result = await handlerFor().execute([importCardInto()]);

    assert.strictEqual(result.reason, "unreadable");
  });

  it("names the command the completion items point at", () => {
    assert.strictEqual(APPLY_IMPORT_COMMAND, "angular-auto-import.lsp.applyImport");
  });
});
