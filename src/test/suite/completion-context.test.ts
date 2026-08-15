import * as assert from "node:assert";
import { TextDocument } from "vscode-languageserver-textdocument";
import { detectCompletionContext } from "../../core/completion-context";
import type { DocumentPosition, DocumentView } from "../../core/document";

/** Builds a document from text where `|` marks the cursor. */
function templateAt(markedText: string): { document: DocumentView; position: DocumentPosition } {
  const cursorOffset = markedText.indexOf("¦");
  assert.notStrictEqual(cursorOffset, -1, "Test template must mark the cursor with ¦");
  const text = markedText.replace("¦", "");
  const document = TextDocument.create("file:///project/src/app.component.html", "html", 1, text);

  return { document, position: document.positionAt(cursorOffset) };
}

function contextAt(markedText: string) {
  const { document, position } = templateAt(markedText);
  return detectCompletionContext(document, position);
}

describe("Completion context detection", () => {
  it("detects a tag being typed", () => {
    const context = contextAt("<app-car¦");

    assert.strictEqual(context.context, "tag");
    assert.strictEqual(context.filterText, "app-car");
    assert.strictEqual(context.hasTagContext, true);
    assert.strictEqual(context.hasAttributeContext, false);
  });

  it("detects a pipe after the pipe character", () => {
    const context = contextAt("<span>{{ value | dat¦ }}</span>");

    assert.strictEqual(context.context, "pipe");
    assert.strictEqual(context.filterText, "dat");
    assert.strictEqual(context.hasPipeContext, true);
  });

  it("detects a property binding and reports its trigger character", () => {
    const context = contextAt("<input [ngMod¦");

    assert.strictEqual(context.context, "attribute");
    assert.strictEqual(context.filterText, "ngMod");
    assert.strictEqual(context.triggerChar, "[");
  });

  it("detects a structural directive and reports its trigger character", () => {
    const context = contextAt("<div *ngI¦");

    assert.strictEqual(context.context, "structural-directive");
    assert.strictEqual(context.filterText, "ngI");
    assert.strictEqual(context.triggerChar, "*");
    assert.strictEqual(context.hasAttributeContext, true);
  });

  it("detects a bare attribute without a trigger character", () => {
    const context = contextAt("<button matBut¦");

    assert.strictEqual(context.context, "attribute");
    assert.strictEqual(context.filterText, "matBut");
    assert.strictEqual(context.triggerChar, undefined);
  });

  it("keeps attribute context across a tag that spans several lines", () => {
    const context = contextAt(["<app-card", '  [title]="title"', "  matTool¦"].join("\n"));

    assert.strictEqual(context.context, "attribute");
    assert.strictEqual(context.filterText, "matTool");
  });

  it("does not treat a closed multi-line tag as open", () => {
    const context = contextAt(["<app-card", '  [title]="title">', "  text¦"].join("\n"));

    assert.strictEqual(context.context, "none");
  });

  it("ignores a > that appears inside an attribute value of an open tag", () => {
    const context = contextAt(["<div", '  *ngIf="count > 5"', "  matTool¦"].join("\n"));

    assert.strictEqual(context.context, "attribute");
    assert.strictEqual(context.filterText, "matTool");
  });

  it("stops the backwards search at a line whose last > is quoted (existing limitation)", () => {
    // The backwards search for the opening tag compares raw `<`/`>` positions, so a
    // quoted `>` on the opening line hides the tag. Pinned to keep the LSP migration
    // behavior-preserving; changing it is an Angular behavior change, not a port.
    const context = contextAt(['<div *ngIf="count > 5"', "  matTool¦"].join("\n"));

    assert.strictEqual(context.context, "none");
  });

  it("reports no context in plain template text", () => {
    const context = contextAt("<span>plain text¦</span>");

    assert.strictEqual(context.context, "none");
    assert.strictEqual(context.hasTagContext, false);
    assert.strictEqual(context.hasPipeContext, false);
  });

  it("returns the word under the cursor as the replacement range", () => {
    const context = contextAt("<app-car¦d");

    assert.deepStrictEqual(context.replacementRange, {
      start: { line: 0, character: 1 },
      end: { line: 0, character: 9 },
    });
  });

  it("leaves the replacement range unset when the cursor is not on a word", () => {
    const context = contextAt("<app-card ¦");

    assert.strictEqual(context.replacementRange, undefined);
  });

  it("exposes the line prefix used for tag-aware ranking", () => {
    const context = contextAt(["<div>", "  <button matBut¦"].join("\n"));

    assert.strictEqual(context.linePrefix, "  <button matBut");
  });

  it("reads the cursor line correctly in a document with CRLF endings", () => {
    const text = "<div>\r\n  <app-car";
    const document = TextDocument.create("file:///project/src/app.component.html", "html", 1, text);

    const context = detectCompletionContext(document, { line: 1, character: 11 });

    assert.strictEqual(context.context, "tag");
    assert.strictEqual(context.filterText, "app-car");
  });
});
