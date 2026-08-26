import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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
    // A round trip rather than a fixed string: `file:///workspace/...` is not a valid
    // file URL on Windows, where an absolute path carries a drive. What must hold on
    // every platform is that a path survives the trip, encoded space and all.
    const filePath = path.resolve(path.sep, "workspace", "My App", "app.component.ts");
    const uri = pathToFileURL(filePath).toString();

    assert.ok(uri.includes("My%20App"), `Expected the space to be encoded in ${uri}`);
    assert.strictEqual(fileUriToPath(uri), filePath);
  });

  it("accepts the language server TextDocument without an adapter", () => {
    const text = "@Component({ template: '<app-card />' })";
    const document: DocumentView = TextDocument.create("file:///workspace/card.ts", "typescript", 1, text);

    assert.strictEqual(isInsideTemplateString(document, document.positionAt(text.indexOf("app-card"))), true);
  });
});
