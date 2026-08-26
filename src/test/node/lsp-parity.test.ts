/**
 * The language server against the corpus the direct implementation is held to.
 *
 * `src/e2e/cases` records, per fixture, exactly which diagnostics the extension must
 * report and where, and which quick fixes must follow. Those descriptors were written
 * for the Extension Host; replaying them through the server is the parity check the
 * migration turns on, and it runs here rather than in the E2E harness because nothing
 * about it needs an editor.
 *
 * The suite skips itself when the fixture project has no `node_modules`, since a
 * fixture without its Angular dependencies is not a project the server would index.
 * @module
 */

import * as assert from "node:assert";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { CodeActionRequest, DocumentDiagnosticRequest } from "vscode-languageserver-protocol";
import { stripAngularImports, stripNgModuleImports } from "../../e2e/helpers/strip-imports";
import type { CodeActionData } from "../../lsp/code-actions";
import { FIX_ALL_KIND } from "../../lsp/protocol";
import { type Harness, startHarness } from "./harness/lsp-harness";

/** The Angular version whose fixture project the parity run uses. */
const FIXTURE_VERSION = "v22";

/**
 * The repository root, found by walking up from the compiled test.
 *
 * The fixtures are read from the source tree rather than from `out`: the E2E projects
 * are hundreds of megabytes of `node_modules` that no build step copies, and pointing
 * at a directory the build would have to produce is how this suite silently skips.
 */
const REPOSITORY_ROOT = findRepositoryRoot(__dirname);
const PROJECT_ROOT = path.join(REPOSITORY_ROOT, "src", "e2e", "projects", FIXTURE_VERSION);
const CASES_ROOT = path.join(REPOSITORY_ROOT, "src", "e2e", "cases", FIXTURE_VERSION);

/** @internal */
function findRepositoryRoot(from: string): string {
  let directory = from;
  while (!existsSync(path.join(directory, "package.json"))) {
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`No package.json above ${from}`);
    }
    directory = parent;
  }
  return directory;
}

/** One expected diagnostic, as a descriptor records it. */
interface ExpectedDiagnostic {
  code: string;
  severity: string;
  source: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** One expected quick fix, as a descriptor records it. */
interface ExpectedQuickfix {
  diagnosticCode: string;
  title: string;
  expectedImport?: { className: string; moduleSpecifier: string };
}

interface CaseDescriptor {
  case: string;
  componentPath: string;
  templatePath: string;
  modulePath?: string;
  /** Cases that measure an already-importing component keep their imports. */
  preserveImports?: boolean;
  diagnostics: ExpectedDiagnostic[];
  quickfixes: ExpectedQuickfix[];
}

/** A diagnostic reduced to what a descriptor pins down. */
function comparable(diagnostic: {
  code?: unknown;
  source?: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}) {
  return {
    code: String(diagnostic.code),
    source: diagnostic.source,
    startLine: diagnostic.range.start.line,
    startCharacter: diagnostic.range.start.character,
    endLine: diagnostic.range.end.line,
    endCharacter: diagnostic.range.end.character,
  };
}

/** The same reduction, from the descriptor's side. */
function expected(diagnostic: ExpectedDiagnostic) {
  return {
    code: diagnostic.code,
    source: diagnostic.source,
    startLine: diagnostic.startLine,
    startCharacter: diagnostic.startCharacter,
    endLine: diagnostic.endLine,
    endCharacter: diagnostic.endCharacter,
  };
}

const available = existsSync(path.join(PROJECT_ROOT, "node_modules")) && existsSync(CASES_ROOT);

(available ? describe : describe.skip)(`LSP parity with the ${FIXTURE_VERSION} corpus`, function () {
  this.timeout(180000);

  let harness: Harness;
  let descriptors: CaseDescriptor[];

  before(async () => {
    const names = (await fs.readdir(CASES_ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    descriptors = await Promise.all(
      names.map(async (name) => JSON.parse(await fs.readFile(path.join(CASES_ROOT, name, "descriptor.json"), "utf8")))
    );

    harness = await startHarness({ workspaceRoots: [PROJECT_ROOT] });
    await harness.waitForProjects();
  });

  after(async () => {
    await harness?.dispose();
  });

  /**
   * The document a case's diagnostics belong to. A case whose component and template
   * are the same file is an inline-template case, and the component is the document.
   */
  function documentOf(descriptor: CaseDescriptor): { filePath: string; languageId: string } {
    const inline = descriptor.componentPath === descriptor.templatePath;
    return inline
      ? { filePath: path.join(PROJECT_ROOT, descriptor.componentPath), languageId: "typescript" }
      : { filePath: path.join(PROJECT_ROOT, descriptor.templatePath), languageId: "html" };
  }

  /**
   * Puts a fixture back into the state its descriptor was recorded against: a component
   * that has not imported anything yet. The originals are restored afterwards, so a
   * failing run leaves the working tree as it found it.
   */
  async function withStrippedImports<T>(descriptor: CaseDescriptor, run: () => Promise<T>): Promise<T> {
    const componentPath = path.join(PROJECT_ROOT, descriptor.componentPath);
    const modulePath = descriptor.modulePath ? path.join(PROJECT_ROOT, descriptor.modulePath) : undefined;
    const originals = new Map<string, string>();

    async function stash(filePath: string, rewrite: (content: string) => string): Promise<void> {
      const original = await fs.readFile(filePath, "utf8");
      originals.set(filePath, original);
      await fs.writeFile(filePath, rewrite(original), "utf8");
    }

    try {
      if (!descriptor.preserveImports) {
        const templateFileName =
          descriptor.componentPath === descriptor.templatePath ? undefined : path.basename(descriptor.templatePath);
        await stash(componentPath, (content) => stripAngularImports(content, templateFileName));
      }
      if (modulePath) {
        await stash(modulePath, stripNgModuleImports);
      }
      return await run();
    } finally {
      for (const [filePath, original] of originals) {
        await fs.writeFile(filePath, original, "utf8");
      }
    }
  }

  it("reads at least one case to compare against", () => {
    assert.ok(descriptors.length > 0, `No descriptors under ${CASES_ROOT}`);
  });

  it("reports the same diagnostics, at the same ranges, as the recorded corpus", async () => {
    const mismatches: string[] = [];

    for (const descriptor of descriptors) {
      const { filePath, languageId } = documentOf(descriptor);
      if (!existsSync(filePath)) {
        mismatches.push(`${descriptor.case}: fixture file ${filePath} is missing`);
        continue;
      }

      const report = await withStrippedImports(descriptor, async () => {
        await harness.open(filePath, await fs.readFile(filePath, "utf8"), languageId);
        const pulled = (await harness.client.sendRequest(DocumentDiagnosticRequest.type, {
          textDocument: { uri: harness.uri(filePath) },
        })) as { items: Array<Parameters<typeof comparable>[0]> };
        await harness.close(filePath);
        return pulled;
      });

      const actual = report.items.map(comparable).sort(byCodeAndPosition);
      const wanted = descriptor.diagnostics.map(expected).sort(byCodeAndPosition);
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        mismatches.push(
          `${descriptor.case}:\n  expected ${JSON.stringify(wanted)}\n  actual   ${JSON.stringify(actual)}`
        );
      }
    }

    assert.deepStrictEqual(mismatches, [], `Diagnostics diverged from the corpus:\n${mismatches.join("\n")}`);
  });

  /** The quick fixes the server offers for a case, with its imports stripped. */
  async function quickFixesFor(descriptor: CaseDescriptor): Promise<QuickFix[]> {
    const { filePath, languageId } = documentOf(descriptor);

    const offered = await withStrippedImports(descriptor, async () => {
      const text = await fs.readFile(filePath, "utf8");
      await harness.open(filePath, text, languageId);
      const actions = (await harness.client.sendRequest(CodeActionRequest.type, {
        textDocument: { uri: harness.uri(filePath) },
        range: wholeDocument(text),
        context: { diagnostics: [] },
      })) as QuickFix[];
      await harness.close(filePath);
      return actions;
    });

    return offered.filter((action) => action.kind !== FIX_ALL_KIND);
  }

  /** What one recorded fix expects, checked against what the server offered. */
  function compareQuickfix(descriptor: CaseDescriptor, quickfix: ExpectedQuickfix, offered: QuickFix[]): string[] {
    const wanted = quickfix.expectedImport;
    if (!wanted) {
      return [];
    }

    const match = offered.find((action) => action.data?.elements.some((element) => element.name === wanted.className));
    if (!match) {
      return [`${descriptor.case}: no fix imports ${wanted.className}`];
    }
    if (match.title !== quickfix.title) {
      return [`${descriptor.case}: title ${JSON.stringify(match.title)} !== ${JSON.stringify(quickfix.title)}`];
    }
    return [];
  }

  it("offers a fix for every recorded diagnostic, importing the recorded symbol", async () => {
    const mismatches: string[] = [];

    for (const descriptor of descriptors) {
      if (descriptor.quickfixes.length === 0 || !existsSync(documentOf(descriptor).filePath)) {
        continue;
      }

      const offered = await quickFixesFor(descriptor);
      for (const quickfix of descriptor.quickfixes) {
        mismatches.push(...compareQuickfix(descriptor, quickfix, offered));
      }
    }

    assert.deepStrictEqual(mismatches, [], `Quick fixes diverged from the corpus:\n${mismatches.join("\n")}`);
  });
});

/** A code action as this comparison reads it. */
interface QuickFix {
  kind?: string;
  title: string;
  data?: CodeActionData;
}

/** A stable order, so two lists of the same findings compare equal. */
function byCodeAndPosition(
  left: { code: string; startLine: number; startCharacter: number },
  right: { code: string; startLine: number; startCharacter: number }
): number {
  return (
    left.startLine - right.startLine ||
    left.startCharacter - right.startCharacter ||
    left.code.localeCompare(right.code)
  );
}

/** @internal */
function wholeDocument(text: string) {
  const lines = text.split("\n");
  return {
    start: { line: 0, character: 0 },
    end: { line: lines.length - 1, character: (lines[lines.length - 1] ?? "").length },
  };
}
