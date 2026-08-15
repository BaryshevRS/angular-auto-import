import {
  CompletionItemKind,
  createConnection,
  type InitializeParams,
  type InitializeResult,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { SPIKE_CRASH_NOTIFICATION } from "./protocol";

type SpikeInitializationOptions = {
  verifyRuntimeDependencies?: boolean;
};

const SPIKE_MARKER = "angular-auto-import-lsp-spike";

const connection = createConnection();
const documents = new TextDocuments(TextDocument);
let runtimeDependenciesLoaded = false;

async function loadRuntimeDependencies(): Promise<void> {
  const [compiler, tsMorph] = await Promise.all([import("@angular/compiler"), import("ts-morph")]);
  if (typeof compiler.parseTemplate !== "function" || typeof tsMorph.Project !== "function") {
    throw new Error("Angular compiler or ts-morph did not expose the expected runtime API");
  }
  runtimeDependenciesLoaded = true;
}

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  const initializationOptions = (params.initializationOptions ?? {}) as SpikeInitializationOptions;
  if (initializationOptions.verifyRuntimeDependencies) {
    await loadRuntimeDependencies();
  }

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: ["<", "|", " ", "[", "*"],
      },
    },
    serverInfo: {
      name: "Angular Auto Import LSP Spike",
    },
  };
});

connection.onCompletion((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document?.getText().includes(SPIKE_MARKER)) {
    return [];
  }

  const offset = document.offsetAt(params.position);
  if (!document.getText().slice(0, offset).endsWith("<sp")) {
    return [];
  }

  return [
    {
      label: "aai-lsp-spike",
      kind: CompletionItemKind.Class,
      insertText: "lsp-spike",
      detail: runtimeDependenciesLoaded
        ? "Angular Auto Import LSP spike (runtime dependencies loaded)"
        : "Angular Auto Import LSP spike",
    },
  ];
});

connection.onNotification(SPIKE_CRASH_NOTIFICATION, () => {
  process.exit(86);
});

documents.listen(connection);
connection.listen();
