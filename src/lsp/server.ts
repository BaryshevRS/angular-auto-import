import {
  createConnection,
  DidChangeConfigurationNotification,
  type InitializeParams,
  type InitializeResult,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toLspCompletionKind } from "../adapters/lsp/language-types";
import { type InstrumentedLogger, installSharedLogger, withInstrumentation } from "../core/logging";
import { resolveExtensionConfig } from "../core/settings";
import { ProjectRuntimeHost } from "./project-runtime-host";
import { SPIKE_CRASH_NOTIFICATION } from "./protocol";
import {
  applyWorkspaceFolderChange,
  buildInitializeResult,
  resolveServerEnvironment,
  type ServerEnvironment,
  type ServerInitializationOptions,
} from "./server-environment";
import { ServerProjects } from "./server-projects";

const SPIKE_MARKER = "angular-auto-import-lsp-spike";
const SERVER_NAME = "Angular Auto Import LSP Spike";
const CONFIGURATION_SECTION = "angular-auto-import";

const connection = createConnection();
const documents = new TextDocuments(TextDocument);
let runtimeDependenciesLoaded = false;
let environment: ServerEnvironment | undefined;
let projects: ServerProjects | undefined;
let runtimes: ProjectRuntimeHost | undefined;

/** Routes core logs to the client's output channel until structured forwarding lands. */
const serverLogger: InstrumentedLogger = withInstrumentation({
  debug: (message) => connection.console.log(message),
  info: (message) => connection.console.info(message),
  warn: (message) => connection.console.warn(message),
  error: (message, error) => connection.console.error(error ? `${message}: ${error.message}` : message),
});

async function loadRuntimeDependencies(): Promise<void> {
  const [compiler, tsMorph] = await Promise.all([import("@angular/compiler"), import("ts-morph")]);
  if (typeof compiler.parseTemplate !== "function" || typeof tsMorph.Project !== "function") {
    throw new Error("Angular compiler or ts-morph did not expose the expected runtime API");
  }
  runtimeDependenciesLoaded = true;
}

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  installSharedLogger(serverLogger);
  environment = resolveServerEnvironment(params);
  const options = (params.initializationOptions ?? {}) as ServerInitializationOptions;
  if (options.verifyRuntimeDependencies) {
    await loadRuntimeDependencies();
  }

  connection.console.info(
    `[server] initialized for ${environment.workspaceRoots.length} workspace root(s); storage: ${environment.storagePath ?? "none"}`
  );

  return buildInitializeResult(environment, SERVER_NAME);
});

connection.onInitialized(async () => {
  if (!environment) {
    return;
  }

  if (environment.client.configuration) {
    await connection.client.register(DidChangeConfigurationNotification.type, { section: CONFIGURATION_SECTION });
    await pullConfiguration();
  }

  if (environment.client.workspaceFolders) {
    connection.workspace.onDidChangeWorkspaceFolders((event) => {
      if (!environment) {
        return;
      }
      environment.workspaceRoots = applyWorkspaceFolderChange(environment.workspaceRoots, event);
      connection.console.info(`[server] workspace roots now: ${environment.workspaceRoots.length}`);
      void projects?.setWorkspaceRoots(environment.workspaceRoots);
    });
  }

  const runtimeHost = new ProjectRuntimeHost({
    logger: serverLogger,
    storagePath: environment.storagePath,
  });
  runtimes = runtimeHost;
  projects = new ServerProjects({
    workspaceRoots: environment.workspaceRoots,
    logger: serverLogger,
    initializeRoot: (rootPath) => runtimeHost.create(rootPath),
    disposeRoot: (rootPath) => runtimeHost.dispose(rootPath),
  });
  await projects.start(documents);
  connection.console.info(`[server] discovered ${projects.knownRoots().length} Angular project root(s)`);
});

connection.onShutdown(() => {
  projects?.dispose();
  projects = undefined;
  runtimes?.disposeAll();
  runtimes = undefined;
});

connection.onDidChangeConfiguration(async (params) => {
  if (!environment) {
    return;
  }

  if (environment.client.configuration) {
    await pullConfiguration();
    return;
  }

  const pushed = (params.settings as Record<string, unknown> | null)?.[CONFIGURATION_SECTION];
  environment.config = resolveExtensionConfig(pushed);
});

/** Reads the authoritative settings from a client that answers configuration requests. */
async function pullConfiguration(): Promise<void> {
  if (!environment) {
    return;
  }
  const [settings] = await connection.workspace.getConfiguration([{ section: CONFIGURATION_SECTION }]);
  environment.config = resolveExtensionConfig(settings);
}

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
      kind: toLspCompletionKind("class"),
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
