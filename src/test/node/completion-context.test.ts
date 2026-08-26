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

  it("keeps completing a tag whose earlier attribute value contains a bracket", () => {
    // A bracket inside an attribute value is text, not markup. Every shape below used
    // to end the tag as far as the search was concerned, and completion went dead for
    // the rest of it — including an arrow function, which any event handler may hold.
    const shapes: Array<[string, string]> = [
      ["a quoted > on the opening line", ['<div *ngIf="count > 5"', "  matTool¦"].join("\n")],
      ["a quoted > earlier on the same line", '<div *ngIf="count > 5" matTool¦'],
      ["a quoted < earlier on the same line", '<div *ngIf="count < 5" matTool¦'],
      ["an arrow function in a handler", '<div (click)="go(x => x.id)" matTool¦'],
      ["a bracket inside single quotes", `<div [x]="a['>']" matTool¦`],
    ];

    for (const [what, template] of shapes) {
      const context = contextAt(template);
      assert.strictEqual(context.context, "attribute", `for ${what}`);
      assert.strictEqual(context.filterText, "matTool", `for ${what}`);
    }
  });

  it("treats a quote in text content as text, not as an attribute value", () => {
    // A quote only delimits inside a tag. Reading an apostrophe in prose as the start
    // of an attribute value swallows every `<` after it, and completion dies for the
    // rest of the file.
    for (const template of ["<p>Don't</p><app-ca¦", "<p>it's fine</p><div mat¦", "<p>a'b'c</p><app-ca¦"]) {
      assert.notStrictEqual(contextAt(template).context, "none", `for ${JSON.stringify(template)}`);
    }
  });

  it("keeps an attribute value open across the lines it spans", () => {
    // The value opens on one line and closes on another, so the `>` between them is
    // inside it. Scanning each line from scratch called that the end of the tag.
    const context = contextAt(['<div [title]="count', '  > 5"', "  matTool¦"].join("\n"));

    assert.strictEqual(context.context, "attribute");
    assert.strictEqual(context.filterText, "matTool");
  });

  it("treats a comment as prose, not as a tag named !--", () => {
    // `<!--` reads like the start of a tag, and then an apostrophe in the prose inside
    // it opens an attribute value that never closes — the same failure as a quote in
    // text content, reached a different way.
    for (const template of [
      "<!-- don't use old markup --><app-ca¦",
      ["<!--", "  don't", "--><app-ca¦"].join("\n"),
      "<!-- <div class='x'> --><app-ca¦",
    ]) {
      const context = contextAt(template);
      assert.strictEqual(context.context, "tag", `for ${JSON.stringify(template)}`);
      assert.strictEqual(context.tagName, "app-ca", `for ${JSON.stringify(template)}`);
    }
  });

  it("offers nothing inside a comment, whatever it looks like", () => {
    // Every kind of context has to be gated on this, not just the tag search: a pipe
    // was decided from the current line before anything knew about comments, so
    // commented-out markup went on being completed.
    for (const template of [
      "<!-- app-ca¦",
      "<!-- <div matTool¦",
      "<!-- value | dat¦",
      "<!-- {{ value | dat¦ }} -->",
      ["<!--", "  value | dat¦", "-->"].join("\n"),
    ]) {
      assert.strictEqual(contextAt(template).context, "none", `for ${JSON.stringify(template)}`);
    }
  });

  it("starts completing again once the comment has closed", () => {
    assert.strictEqual(contextAt("<!-- old --><app-ca¦").context, "tag");
    assert.strictEqual(contextAt("<!-- old --> {{ v | dat¦").context, "pipe");
  });

  it("keeps an attribute value open across a line that holds a bracket of its own", () => {
    // The search used to run backwards, one line at a time, which cannot answer this:
    // whether the `<` on the middle line opens a tag depends on everything before it.
    const context = contextAt(['<div [title]="first', "  a < b", '  > second"', "  matTool¦"].join("\n"));

    assert.strictEqual(context.context, "attribute");
    assert.strictEqual(context.filterText, "matTool");
    assert.strictEqual(context.tagName, "div");
  });

  it("names the tag the cursor is inside", () => {
    assert.strictEqual(contextAt("<button mat¦").tagName, "button");
    assert.strictEqual(contextAt('<button [title]="a < b" mat¦').tagName, "button");
    assert.strictEqual(contextAt(["<button", '  [title]="x"', "  mat¦"].join("\n")).tagName, "button");
    assert.strictEqual(contextAt("<p>plain¦</p>").tagName, undefined);
  });

  it("still ends a tag at a bracket that is markup", () => {
    for (const template of ["<span>plain¦</span>", ["<app-card", '  [title]="t">', "  text¦"].join("\n")]) {
      assert.strictEqual(contextAt(template).context, "none", `for ${JSON.stringify(template)}`);
    }
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
