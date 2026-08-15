import * as assert from "node:assert";
import { TextDocument } from "vscode-languageserver-textdocument";
import { type DocumentView, fileUriToPath } from "../../core/document";
import { isInsideTemplateString } from "../../utils/template-detection";

function createDocument(text: string): DocumentView {
  return {
    uri: "file:///workspace/example.component.ts",
    languageId: "typescript",
    version: 4,
    getText: () => text,
    offsetAt(position) {
      const lines = text.split("\n");
      return lines.slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character;
    },
    positionAt(offset) {
      const prefix = text.slice(0, offset);
      const lines = prefix.split("\n");
      return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
    },
  };
}

describe("DocumentView core boundary", () => {
  it("runs inline-template detection without VS Code document objects", () => {
    const text = "@Component({ template: `<app-card></app-card>` })";
    const document = createDocument(text);

    assert.strictEqual(isInsideTemplateString(document, document.positionAt(text.indexOf("app-card"))), true);
    assert.strictEqual(isInsideTemplateString(document, document.positionAt(0)), false);
  });

  it("converts encoded file URIs into filesystem paths", () => {
    assert.strictEqual(
      fileUriToPath("file:///workspace/My%20App/app.component.ts"),
      "/workspace/My App/app.component.ts"
    );
  });

  it("accepts the language server TextDocument without an adapter", () => {
    const text = "@Component({ template: '<app-card />' })";
    const document: DocumentView = TextDocument.create("file:///workspace/card.ts", "typescript", 1, text);

    assert.strictEqual(isInsideTemplateString(document, document.positionAt(text.indexOf("app-card"))), true);
  });
});
