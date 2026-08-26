import * as assert from "node:assert";
import { diffToEdits } from "../../core/text-edits";
import { applyTextEdits } from "./harness/text";

/** Applying what the diff produced must reproduce the target, whatever the input. */
function assertRoundTrip(before: string, after: string): ReturnType<typeof diffToEdits> {
  const edits = diffToEdits(before, after);
  assert.strictEqual(
    applyTextEdits(before, edits),
    after,
    `Edits did not reproduce the target for ${JSON.stringify(before)}`
  );
  return edits;
}

/** Every line an edit covers, so a test can assert on what it left alone. */
function coveredLines(edits: ReturnType<typeof diffToEdits>): number[] {
  const lines = new Set<number>();
  for (const edit of edits) {
    for (let line = edit.range.start.line; line <= edit.range.end.line; line += 1) {
      lines.add(line);
    }
  }
  return [...lines].sort((left, right) => left - right);
}

describe("Text edits from a rewrite", () => {
  it("reports nothing when nothing changed", () => {
    assert.deepStrictEqual(diffToEdits("same\ntext\n", "same\ntext\n"), []);
  });

  it("touches only the lines that changed, not the ones between them", () => {
    const before = [
      "import { Component } from '@angular/core';",
      "",
      "@Component({",
      "  template: '<x />',",
      "})",
      "class C {}",
      "",
    ].join("\n");
    const after = [
      "import { Component } from '@angular/core';",
      "import { X } from './x';",
      "",
      "@Component({",
      "  template: '<x />',",
      "  imports: [X],",
      "})",
      "class C {}",
      "",
    ].join("\n");

    const edits = assertRoundTrip(before, after);

    // The template line is what a completion would be editing at the same moment.
    assert.ok(!coveredLines(edits).includes(3), `Edits covered the template line: ${coveredLines(edits).join(", ")}`);
  });

  it("returns edits in document order that do not overlap", () => {
    const before = ["a", "b", "c", "d", "e", ""].join("\n");
    const after = ["a", "B", "c", "D", "e", ""].join("\n");

    const edits = assertRoundTrip(before, after);

    assert.strictEqual(edits.length, 2, "Two separated changes are two edits");
    assert.ok(edits[0].range.end.line <= edits[1].range.start.line);
  });

  it("handles an insertion at the very beginning", () => {
    assertRoundTrip("second\nthird\n", "first\nsecond\nthird\n");
  });

  it("handles an append to a file that ends without a newline", () => {
    const edits = assertRoundTrip("first\nlast", "first\nlast\nappended");

    assert.ok(edits.length > 0);
  });

  it("handles a file that gains its first trailing newline", () => {
    assertRoundTrip("only", "only\n");
  });

  it("handles deletions", () => {
    const edits = assertRoundTrip("a\nb\nc\n", "a\nc\n");

    assert.deepStrictEqual(edits[0].newText, "");
  });

  it("handles a file becoming empty, and an empty file gaining content", () => {
    assertRoundTrip("a\nb\n", "");
    assertRoundTrip("", "a\nb\n");
  });

  it("preserves carriage returns rather than rewriting untouched lines", () => {
    const before = "a\r\nb\r\nc\r\n";
    const after = "a\r\nB\r\nc\r\n";

    const edits = assertRoundTrip(before, after);

    assert.deepStrictEqual(coveredLines(edits), [1, 2], "Only the changed line's own range");
  });

  it("replaces wholesale rather than stalling on a file far larger than any component", () => {
    const before = Array.from({ length: 9000 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 4000", "changed");

    const edits = assertRoundTrip(before, after);

    assert.strictEqual(edits.length, 1, "Beyond the diff limit the whole changed span is one edit");
  });
});
