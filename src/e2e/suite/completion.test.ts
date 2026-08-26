/**
 * What the editor offers while a template is being typed.
 *
 * Completion had no end-to-end coverage at all: the core ranking is unit-tested and the
 * server handler is tested over the protocol, but nothing checked that a real editor,
 * against a real indexed project, offers the right item in each context a user types
 * in. That gap is what this closes.
 *
 * Each case rewrites one fixture template, asks VS Code for completions at the end of
 * the written text, and asserts on what came back. The fixture is restored afterwards,
 * so a failing run leaves the working tree as it found it.
 * @module
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { replaceFileContent, waitForExtensionActivation } from "../helpers/file-helper";

/** Where the fixture this suite drives lives, relative to the workspace. */
const FIXTURE = "apps/angular-demo/src/app/completion/completion-host.component.html";

/** How long to keep asking before deciding the extension is not going to offer anything. */
const COMPLETION_TIMEOUT_MS = 20000;

/**
 * What the fixture holds when no case is running.
 *
 * Written out here rather than snapshotted from disk on the way in. A run that dies
 * before its restore leaves the fixture mid-case, and a suite that snapshots what it
 * finds would then adopt that as the state to restore to — quietly, and for good.
 */
const FIXTURE_AT_REST = [
  "<!--",
  "  The completion suite rewrites this file for each case and restores it afterwards.",
  "  What is here is only what the file looks like at rest.",
  "-->",
  "<p>completion fixture</p>",
  "",
].join("\n");

/** One case: a template, and what completing at its end must offer. */
interface CompletionCase {
  /** What the case is about, used as the test name. */
  name: string;
  /**
   * The template as the user has typed it so far. The cursor is at the very end, which
   * is where a real one is while typing.
   */
  template: string;
  /** Labels that must be offered. */
  offers: string[];
  /** Labels that must not be offered. */
  withholds?: string[];
  /** The label that must rank first among {@link CompletionCase.offers}. */
  ranksFirst?: string;
  /** The text accepting `ranksFirst` must insert, when it matters. */
  inserts?: string;
}

const CASES: CompletionCase[] = [
  {
    name: "a component, by the tag being typed",
    template: "<lib-ui-mo",
    offers: ["lib-ui-moon"],
    withholds: ["ngIf"],
  },
  {
    name: "an attribute directive, without the brackets it is declared with",
    template: "<div libDoub",
    offers: ["libDoubleWay"],
  },
  {
    // The `*` is already in the document, so the item completes the name after it.
    name: "a structural directive, after the star",
    template: "<div *libUiDemoShow",
    offers: ["libUiDemoShowIf"],
  },
  {
    name: "a pipe, and only in a pipe expression",
    template: "<p>{{ value | byt",
    offers: ["bytes"],
    withholds: ["lib-ui-moon", "libDoubleWay"],
  },
  {
    name: "a built-in Angular directive, which no project index has to hold",
    template: "<div *ngI",
    offers: ["ngIf"],
  },
  {
    name: "a property binding written in brackets",
    template: "<div [ngCl",
    offers: ["ngClass"],
  },
  {
    // Regression, two of them. A directive whose every selector is tag-scoped was not
    // offered at all — its bare variant reads like a tag name, so it was only ever
    // considered in tag context — and when it was offered, it came as the whole
    // selector, so accepting it wrote `<ng-template ng-template[jupiterTemplateRow]`.
    name: "a directive whose only selector is scoped to a tag",
    template: "<ng-template jupiterTem",
    offers: ["jupiterTemplateRow"],
    ranksFirst: "jupiterTemplateRow",
    inserts: "jupiterTemplateRow",
  },
  {
    name: "one scoped to several tags at once",
    template: "<button jupiterIcon",
    offers: ["jupiterIconButton"],
    inserts: "jupiterIconButton",
    ranksFirst: "jupiterIconButton",
  },
  {
    name: "an element selector, which is still only offered as a tag",
    template: "<jupiter-tab",
    offers: ["jupiter-table:JupiterTableDirective"],
  },
  {
    // Regression: a bracket inside an earlier attribute value used to end the tag as far
    // as the search was concerned, and completion went dead for the rest of it.
    name: "still inside a tag whose earlier attribute value holds a comparison",
    template: '<div *ngIf="count > 5" libDoub',
    offers: ["libDoubleWay"],
  },
  {
    name: "still inside a tag whose earlier attribute value holds an arrow function",
    template: '<div (click)="log(($event as any) => 1)" libDoub',
    offers: ["libDoubleWay"],
  },
  {
    // Regression: a quote only delimits inside a tag. Reading an apostrophe in prose as
    // the start of an attribute value swallowed every `<` after it.
    name: "a component after text holding an apostrophe",
    template: "<p>Don't</p><lib-ui-mo",
    offers: ["lib-ui-moon"],
  },
  {
    // Regression: the value opens on one line and closes on another, so the `>` between
    // them is inside it. Scanning each line from scratch called that the end of the tag.
    name: "still inside a tag whose attribute value spans lines",
    template: '<div [title]="count\n > 5"\n libDoub',
    offers: ["libDoubleWay"],
  },
  {
    // Regression: `<!--` reads like a tag named `!--`, and an apostrophe in the prose
    // inside it then opened an attribute value that never closed.
    name: "a component after a comment holding an apostrophe",
    template: "<!-- don't use the old markup --><lib-ui-mo",
    offers: ["lib-ui-moon"],
  },
  {
    // Regression: whether the `<` on the middle line opens a tag depends on everything
    // before it, which a search running backwards one line at a time cannot know.
    name: "still inside a tag whose value spans a line holding a bracket",
    template: '<div [title]="first\n  a < b\n  > second"\n  libDoub',
    offers: ["libDoubleWay"],
  },
  {
    // Regression: a pipe was decided from the current line before anything knew about
    // comments, so commented-out markup went on being completed.
    name: "nothing inside a comment, pipes included",
    template: "<!-- {{ value | byt",
    offers: [],
    withholds: ["bytes"],
  },
  {
    name: "nothing at all in plain template text",
    template: "<p>plain text",
    offers: [],
    withholds: ["lib-ui-moon", "ngIf", "bytes"],
  },
];

describe("Completion", function () {
  this.timeout(120000);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  const fixtureUri = vscode.Uri.file(path.join(workspaceRoot, FIXTURE));

  // Not every fixture project carries this suite's template — `v22-nx` is there for its
  // layout and holds nothing else — and `after` runs even when `before` skipped.
  let hasFixture = false;

  before(async function () {
    this.timeout(120000);
    hasFixture = fs.existsSync(fixtureUri.fsPath);
    if (!hasFixture) {
      this.skip();
      return;
    }
    // Start from the known state, whatever a previous run left behind.
    await replaceFileContent(fixtureUri, FIXTURE_AT_REST);
    await waitForExtensionActivation();
  });

  after(async () => {
    if (hasFixture) {
      await replaceFileContent(fixtureUri, FIXTURE_AT_REST);
    }
  });

  /**
   * Writes a template and asks what completing at its end offers.
   *
   * The index reaches the server asynchronously, so an empty answer is retried rather
   * than believed: a case that legitimately offers nothing is proven by the labels it
   * must withhold, never by an empty list that arrived too early.
   */
  async function completionsFor(template: string, expectAny: boolean): Promise<vscode.CompletionItem[]> {
    await replaceFileContent(fixtureUri, template);
    const document = await vscode.workspace.openTextDocument(fixtureUri);
    await vscode.window.showTextDocument(document, { preview: false });

    const position = document.positionAt(template.length);
    const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
    let items: vscode.CompletionItem[] = [];

    for (;;) {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        "vscode.executeCompletionItemProvider",
        fixtureUri,
        position
      );
      items = list?.items ?? [];
      if (!expectAny || items.length > 0 || Date.now() > deadline) {
        return items;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** The label of an item, as a string whichever shape VS Code used. */
  function labelOf(item: vscode.CompletionItem): string {
    return typeof item.label === "string" ? item.label : item.label.label;
  }

  /** What an item would insert, as a string whichever shape VS Code used. */
  function insertTextOf(item: vscode.CompletionItem): string {
    if (typeof item.insertText === "string") {
      return item.insertText;
    }
    if (item.insertText) {
      return item.insertText.value;
    }
    return labelOf(item);
  }

  for (const testCase of CASES) {
    it(`offers ${testCase.name}`, async () => {
      const items = await completionsFor(testCase.template, testCase.offers.length > 0);
      const ours = items.filter((item) => item.detail?.startsWith("Angular Auto-Import"));
      const labels = ours.map(labelOf);

      for (const wanted of testCase.offers) {
        assert.ok(labels.includes(wanted), `expected ${wanted} among ${labels.join(", ") || "nothing"}`);
      }
      for (const unwanted of testCase.withholds ?? []) {
        assert.ok(!labels.includes(unwanted), `${unwanted} must not be offered here`);
      }

      if (testCase.ranksFirst) {
        const ranked = [...ours].sort((left, right) => {
          const leftKey = String(left.sortText ?? labelOf(left));
          const rightKey = String(right.sortText ?? labelOf(right));
          if (leftKey === rightKey) {
            return 0;
          }
          return leftKey < rightKey ? -1 : 1;
        });
        assert.strictEqual(
          labelOf(ranked[0]),
          testCase.ranksFirst,
          `expected ${testCase.ranksFirst} to rank first among ${ranked.map(labelOf).join(", ")}`
        );
      }

      if (testCase.inserts) {
        const item = ours.find((candidate) => labelOf(candidate) === testCase.ranksFirst);
        assert.ok(item, `no item labelled ${testCase.ranksFirst}`);
        assert.strictEqual(insertTextOf(item), testCase.inserts);
      }
    });
  }
});
