import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { OpenDocuments, type SynchronizedDocument, type SynchronizedDocumentSource } from "../../lsp/open-documents";

type Listener = (event: { document: SynchronizedDocument }) => void;

/** A stand-in for `TextDocuments` that lets a test drive the lifecycle by hand. */
class FakeDocuments implements SynchronizedDocumentSource<SynchronizedDocument> {
  private readonly documents = new Map<string, SynchronizedDocument>();
  private readonly listeners: Record<"open" | "save" | "close", Listener[]> = { open: [], save: [], close: [] };

  get(uri: string): SynchronizedDocument | undefined {
    return this.documents.get(uri);
  }

  all(): SynchronizedDocument[] {
    return Array.from(this.documents.values());
  }

  onDidOpen(listener: Listener): unknown {
    this.listeners.open.push(listener);
    return undefined;
  }

  onDidSave(listener: Listener): unknown {
    this.listeners.save.push(listener);
    return undefined;
  }

  onDidClose(listener: Listener): unknown {
    this.listeners.close.push(listener);
    return undefined;
  }

  open(uri: string, text: string): void {
    const document = { uri, languageId: "typescript", version: 1, getText: () => text };
    this.documents.set(uri, document);
    this.emit("open", document);
  }

  edit(uri: string, text: string): void {
    const previous = this.documents.get(uri) as SynchronizedDocument;
    this.documents.set(uri, { ...previous, version: previous.version + 1, getText: () => text });
  }

  save(uri: string): void {
    this.emit("save", this.documents.get(uri) as SynchronizedDocument);
  }

  close(uri: string): void {
    const document = this.documents.get(uri) as SynchronizedDocument;
    this.documents.delete(uri);
    this.emit("close", document);
  }

  private emit(event: "open" | "save" | "close", document: SynchronizedDocument): void {
    for (const listener of this.listeners[event]) {
      listener({ document });
    }
  }
}

const filePath = path.join(path.sep === "\\" ? "C:\\work" : "/work", "app.component.ts");
const uri = pathToFileURL(filePath).toString();

describe("LSP open documents", () => {
  let documents: FakeDocuments;
  let open: OpenDocuments;

  beforeEach(() => {
    documents = new FakeDocuments();
    open = new OpenDocuments(documents);
    open.listen();
  });

  it("finds an open document by its filesystem path", () => {
    documents.open(uri, "export class AppComponent {}");

    assert.strictEqual(open.byPath(filePath)?.uri, uri);
  });

  it("adopts the documents that were already synchronized when it started listening", () => {
    const preexisting = new FakeDocuments();
    preexisting.open(uri, "export class AppComponent {}");

    const adopted = new OpenDocuments(preexisting);
    adopted.listen();

    assert.strictEqual(adopted.byPath(filePath)?.uri, uri);
  });

  it("forgets a document once it is closed", () => {
    documents.open(uri, "export class AppComponent {}");
    documents.close(uri);

    assert.strictEqual(open.byPath(filePath), undefined);
  });

  it("treats a file nobody opened as clean, because its text is what is on disk", () => {
    assert.strictEqual(open.isDirty(filePath), false);
  });

  it("treats a freshly opened document as clean", () => {
    documents.open(uri, "export class AppComponent {}");

    assert.strictEqual(open.isDirty(filePath), false);
  });

  it("reports an edited document as dirty until it is saved", () => {
    documents.open(uri, "export class AppComponent {}");
    documents.edit(uri, "export class AppComponent { changed = true; }");
    assert.strictEqual(open.isDirty(filePath), true);

    documents.save(uri);

    assert.strictEqual(open.isDirty(filePath), false);
  });

  it("reads an open document's unsaved text instead of the file on disk", () => {
    documents.open(uri, "saved");
    documents.edit(uri, "unsaved");

    const current = open.currentText(filePath, () => "from disk");

    assert.deepStrictEqual(current, { text: "unsaved", version: 2 });
  });

  it("reads a closed file from disk and reports no version to guard an edit with", () => {
    const current = open.currentText(filePath, () => "from disk");

    assert.deepStrictEqual(current, { text: "from disk", version: null });
  });

  it("ignores a document that is not on disk", () => {
    documents.open("untitled:Untitled-1", "");

    assert.strictEqual(open.byPath("untitled:Untitled-1"), undefined);
  });
});
