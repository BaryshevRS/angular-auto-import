/**
 * A monorepo, where the code a template needs is not under the project that needs it.
 *
 * The layout this covers is the one issue #35 reports: a workspace whose own manifest
 * carries only build tooling, an application that declares `@angular/core`, and
 * libraries that have no manifest at all and are reachable only through
 * `compilerOptions.paths`. Every part of that is load-bearing, so the fixtures are
 * written out rather than shared: a library that accidentally gained a `package.json`
 * would be found by the manifest rule and prove nothing.
 * @module
 */

import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CodeActionRequest,
  CodeActionResolveRequest,
  DidChangeWatchedFilesNotification,
  DocumentDiagnosticRequest,
  FileChangeType,
} from "vscode-languageserver-protocol";
import type { CodeActionData } from "../../lsp/code-actions";
import { FIX_ALL_KIND, PerformanceMetricsRequest } from "../../lsp/protocol";
import { type Harness, startHarness } from "./harness/lsp-harness";

/** A standalone component, as a library would export one. */
function component(name: string, selector: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    `@Component({ selector: "${selector}", standalone: true, template: "" })`,
    `export class ${name} {}`,
    "",
  ].join("\n");
}

/** A component that imports nothing and renders an external template. */
function host(templateName: string): string {
  return [
    'import { Component } from "@angular/core";',
    "",
    "@Component({",
    '  selector: "app-host",',
    "  standalone: true,",
    `  templateUrl: "./${templateName}",`,
    "  imports: [],",
    "})",
    "export class HostComponent {}",
    "",
  ].join("\n");
}

interface MonorepoOptions {
  /**
   * Whether `tsconfig.base.json` declares `baseUrl`.
   *
   * Without it, TypeScript resolves `paths` against the config that declared them —
   * the base config, several directories above the application reading it. Both shapes
   * occur in the wild and they resolve to different places, so both are exercised.
   */
  baseUrl?: boolean;
}

/**
 * Writes an Nx-shaped workspace and returns the paths a test asserts against.
 * @param root Absolute path of the workspace directory to fill.
 * @param options Which shape of `tsconfig.base.json` to write.
 */
async function writeMonorepo(root: string, options: MonorepoOptions = {}) {
  const appRoot = path.join(root, "apps", "my-app");
  const libRoot = path.join(root, "libs", "ui-common");
  await fs.mkdir(path.join(appRoot, "src", "app"), { recursive: true });
  await fs.mkdir(path.join(libRoot, "src", "lib"), { recursive: true });

  // The workspace manifest carries tooling only: this is what makes the workspace root
  // fail the manifest rule, which is half of what the issue reports.
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "workspace", devDependencies: { nx: "19.0.0" } }),
    "utf8"
  );
  await fs.writeFile(path.join(root, "nx.json"), JSON.stringify({ npmScope: "scope" }), "utf8");

  const target = options.baseUrl ? "libs/ui-common/src/index.ts" : "./libs/ui-common/src/index.ts";
  await fs.writeFile(
    path.join(root, "tsconfig.base.json"),
    JSON.stringify({
      compilerOptions: {
        ...(options.baseUrl ? { baseUrl: "." } : {}),
        paths: { "@scope/ui-common": [target] },
      },
    }),
    "utf8"
  );

  await fs.writeFile(
    path.join(appRoot, "package.json"),
    JSON.stringify({ name: "my-app", dependencies: { "@angular/core": "^20.0.0" } }),
    "utf8"
  );
  await fs.writeFile(
    path.join(appRoot, "tsconfig.json"),
    JSON.stringify({ extends: "../../tsconfig.base.json" }),
    "utf8"
  );

  // No `package.json` anywhere under the library: it is not a package, it is a
  // directory the application's tsconfig maps into itself.
  await fs.writeFile(path.join(libRoot, "src", "index.ts"), 'export * from "./lib/badge.component";\n', "utf8");
  await fs.writeFile(
    path.join(libRoot, "src", "lib", "badge.component.ts"),
    component("UiBadgeComponent", "ui-badge"),
    "utf8"
  );

  const templatePath = path.join(appRoot, "src", "app", "host.component.html");
  await fs.writeFile(path.join(appRoot, "src", "app", "host.component.ts"), host("host.component.html"), "utf8");
  await fs.writeFile(templatePath, "<ui-badge></ui-badge>\n", "utf8");

  return { appRoot, libRoot, templatePath };
}

/** The code the missing-import diagnostic carries for the library's component. */
const MISSING_BADGE = "missing-component-import:ui-badge";

/** The roots the server currently has an index for. */
async function indexedRoots(live: Harness): Promise<string[]> {
  const metrics = await live.client.sendRequest(PerformanceMetricsRequest);
  return metrics.projects.map((project) => project.rootPath).sort();
}

/**
 * Polls until a condition holds, failing with what was being waited for.
 * @param condition What must become true.
 * @param whatFor The assertion message, phrased as the promise being kept.
 */
async function until(condition: () => Promise<boolean>, whatFor: string): Promise<void> {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > deadline) {
      assert.fail(whatFor);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** How many elements the latest projects-status the server pushed accounts for. */
function settledElementCount(live: Harness): Promise<number> {
  const statuses = live.projectsStatuses();
  const last = statuses[statuses.length - 1];
  return Promise.resolve((last?.projects ?? []).reduce((total, project) => total + project.elementCount, 0));
}

/** A code action as this suite reads it. */
interface QuickFix {
  kind?: string;
  title: string;
  data?: CodeActionData;
}

describe("Monorepo libraries reached through tsconfig path aliases", function () {
  this.timeout(60000);

  let sandbox: string;
  let harness: Harness | undefined;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "angular-auto-import-monorepo-"));
  });

  afterEach(async () => {
    await harness?.dispose();
    harness = undefined;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  /** The codes a document's report carries. */
  async function diagnosticCodes(live: Harness, filePath: string): Promise<string[]> {
    const report = (await live.client.sendRequest(DocumentDiagnosticRequest.type, {
      textDocument: { uri: live.uri(filePath) },
    })) as { items: Array<{ code?: unknown }> };
    return report.items.map((item) => String(item.code));
  }

  /** The quick fixes offered for a whole document, minus the fix-all action. */
  async function quickFixes(live: Harness, filePath: string, text: string): Promise<QuickFix[]> {
    const actions = (await live.client.sendRequest(CodeActionRequest.type, {
      textDocument: { uri: live.uri(filePath) },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: text.length } },
      context: { diagnostics: [] },
    })) as QuickFix[];
    return actions.filter((action) => action.kind !== FIX_ALL_KIND);
  }

  it("indexes an Angular package hoisted to the workspace node_modules", async () => {
    const { appRoot, templatePath } = await writeMonorepo(sandbox);
    const packageName = "@fixture/hoisted-ui";

    const appPackagePath = path.join(appRoot, "package.json");
    const appPackage = JSON.parse(await fs.readFile(appPackagePath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    appPackage.dependencies = {
      ...appPackage.dependencies,
      [packageName]: "0.0.0",
    };
    await fs.writeFile(appPackagePath, JSON.stringify(appPackage), "utf8");

    const packageRoot = path.join(sandbox, "node_modules", "@fixture", "hoisted-ui");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: packageName,
        version: "0.0.0",
        peerDependencies: { "@angular/core": "*" },
        exports: { ".": { types: "./index.d.ts" } },
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(packageRoot, "index.d.ts"),
      [
        'import * as i0 from "@angular/core";',
        "",
        "export declare class HoistedCardComponent {",
        "  static ɵcmp: i0.ɵɵComponentDeclaration<",
        "    HoistedCardComponent,",
        '    "hoisted-card",',
        "    never,",
        "    {},",
        "    {},",
        "    never,",
        "    never,",
        "    true,",
        "    never",
        "  >;",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    harness = await startHarness({ workspaceRoots: [sandbox] });
    await harness.open(
      path.join(appRoot, "src", "app", "host.component.ts"),
      host("host.component.html"),
      "typescript"
    );
    await harness.waitForProjects();

    const text = "<hoisted-card></hoisted-card>\n";
    await harness.open(templatePath, text, "html");

    assert.deepStrictEqual(
      await diagnosticCodes(harness, templatePath),
      ["missing-component-import:hoisted-card"],
      "the application must index an Angular dependency from the workspace ancestor's node_modules"
    );

    const offered = await quickFixes(harness, templatePath, text);
    const fix = offered.find((action) =>
      action.data?.elements.some((element) => element.name === "HoistedCardComponent")
    );
    assert.ok(
      fix,
      `no fix imports HoistedCardComponent; offered ${JSON.stringify(offered.map((action) => action.title))}`
    );

    const resolved = (await harness.client.sendRequest(CodeActionResolveRequest.type, fix as never)) as {
      edit?: { documentChanges?: Array<{ edits: Array<{ newText: string }> }> };
    };
    const inserted = (resolved.edit?.documentChanges ?? [])
      .flatMap((change) => change.edits)
      .map((edit) => edit.newText)
      .join("");

    assert.ok(
      inserted.includes(`from "${packageName}"`),
      `the import must use the hoisted package name, got ${JSON.stringify(inserted)}`
    );
  });

  for (const baseUrl of [true, false]) {
    it(`indexes a library the application maps in, ${baseUrl ? "with" : "without"} a baseUrl`, async () => {
      const { appRoot, templatePath } = await writeMonorepo(sandbox, { baseUrl });

      harness = await startHarness({ workspaceRoots: [sandbox] });
      // The application is discovered from a document inside it, not from the workspace
      // folder above it, whose manifest declares no Angular.
      await harness.open(
        path.join(appRoot, "src", "app", "host.component.ts"),
        host("host.component.html"),
        "typescript"
      );
      await harness.waitForProjects();

      const text = "<ui-badge></ui-badge>\n";
      await harness.open(templatePath, text, "html");

      assert.deepStrictEqual(
        await diagnosticCodes(harness, templatePath),
        [MISSING_BADGE],
        "the library's component must be known to the application that maps it in"
      );
    });
  }

  it("writes the alias, not a relative path that climbs out of the application", async () => {
    const { appRoot, templatePath } = await writeMonorepo(sandbox, { baseUrl: true });

    harness = await startHarness({ workspaceRoots: [sandbox] });
    const componentPath = path.join(appRoot, "src", "app", "host.component.ts");
    await harness.open(componentPath, host("host.component.html"), "typescript");
    await harness.waitForProjects();

    const text = "<ui-badge></ui-badge>\n";
    await harness.open(templatePath, text, "html");

    const offered = await quickFixes(harness, templatePath, text);
    const fix = offered.find((action) => action.data?.elements.some((element) => element.name === "UiBadgeComponent"));
    assert.ok(fix, `no fix imports UiBadgeComponent; offered ${JSON.stringify(offered.map((a) => a.title))}`);

    const resolved = (await harness.client.sendRequest(CodeActionResolveRequest.type, fix as never)) as {
      edit?: { documentChanges?: Array<{ edits: Array<{ newText: string }> }> };
    };
    const inserted = (resolved.edit?.documentChanges ?? [])
      .flatMap((change) => change.edits)
      .map((edit) => edit.newText)
      .join("");

    assert.ok(
      inserted.includes('from "@scope/ui-common"'),
      `the import must go through the alias, got ${JSON.stringify(inserted)}`
    );
  });

  it("follows a library edit made outside the editor", async () => {
    const { appRoot, libRoot, templatePath } = await writeMonorepo(sandbox, { baseUrl: true });

    harness = await startHarness({ workspaceRoots: [sandbox] });
    await harness.open(
      path.join(appRoot, "src", "app", "host.component.ts"),
      host("host.component.html"),
      "typescript"
    );
    await harness.waitForProjects();

    const text = "<ui-chip></ui-chip>\n";
    await harness.open(templatePath, text, "html");
    assert.deepStrictEqual(
      await diagnosticCodes(harness, templatePath),
      [],
      "a selector nothing declares must not be reported as a missing import"
    );

    const added = path.join(libRoot, "src", "lib", "chip.component.ts");
    await fs.writeFile(added, component("UiChipComponent", "ui-chip"), "utf8");
    await harness.client.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: pathToFileURL(added).toString(), type: FileChangeType.Created }],
    });

    const deadline = Date.now() + 15000;
    for (;;) {
      if ((await diagnosticCodes(harness, templatePath)).length > 0) {
        break;
      }
      if (Date.now() > deadline) {
        assert.fail("a component added to an aliased library never reached the index");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  it("indexes nothing outside the alias roots when the application maps none", async () => {
    const { appRoot, templatePath } = await writeMonorepo(sandbox, { baseUrl: true });
    // Take the mapping away: the library is then a directory nothing points at, and the
    // scan must stay inside the application.
    await fs.writeFile(path.join(sandbox, "tsconfig.base.json"), JSON.stringify({ compilerOptions: {} }), "utf8");
    await fs.writeFile(
      path.join(appRoot, "src", "app", "local.component.ts"),
      component("LocalComponent", "app-local"),
      "utf8"
    );

    harness = await startHarness({ workspaceRoots: [sandbox] });
    await harness.open(
      path.join(appRoot, "src", "app", "host.component.ts"),
      host("host.component.html"),
      "typescript"
    );
    await harness.waitForProjects();

    const text = "<ui-badge></ui-badge>\n";
    await harness.open(templatePath, text, "html");

    assert.deepStrictEqual(
      await diagnosticCodes(harness, templatePath),
      [],
      "a library no alias maps in belongs to no project here"
    );
  });

  it("believes a configured projectPath whose manifest declares no Angular", async () => {
    const { templatePath } = await writeMonorepo(sandbox, { baseUrl: true });

    // The workspace root: `nx.json` and build tooling, no `@angular/core`. The manifest
    // rule rejects it, and naming it explicitly is the user overruling that.
    harness = await startHarness({
      workspaceRoots: [sandbox],
      settings: { projectPath: sandbox },
    });
    await harness.waitForProjects();

    const text = "<ui-badge></ui-badge>\n";
    await harness.open(templatePath, text, "html");

    assert.deepStrictEqual(await diagnosticCodes(harness, templatePath), [MISSING_BADGE]);
  });

  it("moves onto a projectPath set after it started, without a restart", async () => {
    const { templatePath } = await writeMonorepo(sandbox, { baseUrl: true });
    const elsewhere = path.join(sandbox, "elsewhere");
    await fs.mkdir(elsewhere, { recursive: true });

    // Pointed somewhere with no Angular in it: the server serves that and nothing else.
    harness = await startHarness({ workspaceRoots: [sandbox], settings: { projectPath: elsewhere } });
    const live = harness;
    const text = "<ui-badge></ui-badge>\n";
    await live.open(templatePath, text, "html");
    assert.deepStrictEqual(await diagnosticCodes(live, templatePath), []);

    // The user follows the status bar's advice and corrects the setting.
    await live.changeSettings({ projectPath: sandbox });

    const deadline = Date.now() + 20000;
    for (;;) {
      if ((await diagnosticCodes(live, templatePath)).length > 0) {
        break;
      }
      if (Date.now() > deadline) {
        assert.fail("a corrected projectPath must take effect without reloading the window");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  it("applies a projectPath that names the folder already open", async () => {
    await writeMonorepo(sandbox, { baseUrl: true });

    // The workspace folder is the one the setting will name. Nothing changes about
    // *where* to look — only about whether that place counts as a project — so a
    // server that watches the list of roots for changes sees none. No document is
    // opened, or discovery would find the application on its own and the workspace
    // root would never be the thing under test.
    harness = await startHarness({ workspaceRoots: [sandbox] });
    const live = harness;
    await live.waitForStartup();
    assert.deepStrictEqual(await indexedRoots(live), [], "the workspace root declares no Angular yet");

    await live.changeSettings({ projectPath: sandbox });

    await until(
      async () => (await indexedRoots(live)).includes(sandbox),
      "naming the folder already open must still make it a project"
    );
  });

  it("gives up a root it only had because it was trusted", async () => {
    await writeMonorepo(sandbox, { baseUrl: true });

    harness = await startHarness({ workspaceRoots: [sandbox], settings: { projectPath: sandbox } });
    const live = harness;
    await live.waitForProjects();
    assert.deepStrictEqual(await indexedRoots(live), [sandbox]);

    await live.changeSettings({ projectPath: null });

    await until(
      async () => (await indexedRoots(live)).length === 0,
      "a root believed only because it was named must go when it is not named any more"
    );
  });

  it("keeps the element count it reports in step with the index", async () => {
    const { appRoot, libRoot } = await writeMonorepo(sandbox, { baseUrl: true });

    harness = await startHarness({ workspaceRoots: [sandbox] });
    const live = harness;
    await live.open(path.join(appRoot, "src", "app", "host.component.ts"), host("host.component.html"), "typescript");
    await live.waitForProjects();

    const countedAtFirst = await settledElementCount(live);
    assert.ok(countedAtFirst > 0, "the first report must carry what was indexed");

    const added = path.join(libRoot, "src", "lib", "chip.component.ts");
    await fs.writeFile(added, component("UiChipComponent", "ui-chip"), "utf8");
    await live.client.sendNotification(DidChangeWatchedFilesNotification.type, {
      changes: [{ uri: pathToFileURL(added).toString(), type: FileChangeType.Created }],
    });

    const deadline = Date.now() + 20000;
    for (;;) {
      if ((await settledElementCount(live)) > countedAtFirst) {
        return;
      }
      if (Date.now() > deadline) {
        assert.fail(`the count stayed at ${countedAtFirst} after the index grew`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  it("says why it has nothing to work on, rather than looking idle", async () => {
    const empty = path.join(sandbox, "no-angular-here");
    await fs.mkdir(empty, { recursive: true });
    await fs.writeFile(path.join(empty, "package.json"), JSON.stringify({ name: "plain" }), "utf8");

    harness = await startHarness({ workspaceRoots: [empty] });

    const live = harness;
    const deadline = Date.now() + 15000;
    while (live.projectsStatuses().length === 0) {
      if (Date.now() > deadline) {
        assert.fail("the server must report what discovery came to");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const statuses = live.projectsStatuses();
    const last = statuses[statuses.length - 1];
    assert.deepStrictEqual(last.projects, []);
    assert.ok(last.problem?.includes("@angular/core"), `unhelpful reason: ${last.problem}`);
    assert.ok(last.problem?.includes("projectPath"), `the reason must name the setting: ${last.problem}`);
  });
});
