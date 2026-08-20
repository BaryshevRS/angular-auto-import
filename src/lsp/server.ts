import {
  createConnection,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  type InitializeParams,
  type InitializeResult,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toDocumentView } from "../adapters/lsp/document";
import { fileUriToPath } from "../core/document";
import { installSharedLogger } from "../core/logging";
import { DEFAULT_EXTENSION_CONFIG, resolveExtensionConfig } from "../core/settings";
import { CompletionHandler } from "./completion";
import { APPLY_IMPORT_COMMAND, ImportCommandHandler } from "./import-command";
import { OpenDocuments } from "./open-documents";
import { ProjectRouter } from "./project-router";
import { ProjectRuntimeHost } from "./project-runtime-host";
import { SPIKE_CRASH_NOTIFICATION } from "./protocol";
import {
  applyWorkspaceFolderChange,
  buildInitializeResult,
  resolveServerEnvironment,
  type ServerEnvironment,
  type ServerInitializationOptions,
} from "./server-environment";
import { ServerLogging } from "./server-logging";
import { ServerProjects } from "./server-projects";
import { probeCompletion } from "./spike-probe";
import { WatchedFiles } from "./watched-files";

const SERVER_NAME = "Angular Auto Import LSP Spike";
const CONFIGURATION_SECTION = "angular-auto-import";

const connection = createConnection();
const documents = new TextDocuments(TextDocument);
let runtimeDependenciesLoaded = false;
let environment: ServerEnvironment | undefined;
let projects: ServerProjects | undefined;
let runtimes: ProjectRuntimeHost | undefined;
let watchedFiles: WatchedFiles | undefined;

/** Routes the server's logs to the client's output channel, filtered by the user's settings. */
const logging = new ServerLogging(connection.console);
const serverLogger = logging.logger;

/** Path-keyed access to the synchronized documents, shared by every language feature. */
const openDocuments = new OpenDocuments(documents);

/**
 * Routes a URI to the project runtime that answers for it. Both lookups go through the
 * mutable module state on purpose: a request that arrives before discovery has run, or
 * after shutdown released everything, must resolve to nothing rather than to a stale runtime.
 */
const router = new ProjectRouter({
  rootForPath: (filePath) => projects?.rootForPath(filePath),
  runtimeForRoot: (rootPath) => runtimes?.get(rootPath),
});

const completions = new CompletionHandler({
  router,
  documents: openDocuments,
  // Re-read per request: the user can change these while the server runs.
  config: () => environment?.config ?? DEFAULT_EXTENSION_CONFIG,
  logger: serverLogger,
});

const importCommand = new ImportCommandHandler({
  router,
  documents: openDocuments,
  applyEdit: async (edit) => (await connection.workspace.applyEdit(edit)).applied,
  logger: serverLogger,
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
  logging.configure(environment.config.logging);
  const options = (params.initializationOptions ?? {}) as ServerInitializationOptions;
  if (options.verifyRuntimeDependencies) {
    await loadRuntimeDependencies();
  }

  serverLogger.info(
    `Initialized for ${environment.workspaceRoots.length} workspace root(s); storage: ${environment.storagePath ?? "none"}`
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
      serverLogger.info(`Workspace roots now: ${environment.workspaceRoots.length}`);
      void projects?.setWorkspaceRoots(environment.workspaceRoots);
    });
  }

  watchedFiles = new WatchedFiles({
    logger: serverLogger,
    register: environment.client.didChangeWatchedFiles
      ? (watchers) => connection.client.register(DidChangeWatchedFilesNotification.type, { watchers })
      : undefined,
  });
  const runtimeHost = new ProjectRuntimeHost({
    logger: serverLogger,
    storagePath: environment.storagePath,
    fileWatchers: watchedFiles,
    reindexIntervalMinutes: environment.config.indexRefreshInterval,
  });
  runtimes = runtimeHost;
  projects = new ServerProjects({
    workspaceRoots: environment.workspaceRoots,
    logger: serverLogger,
    initializeRoot: (rootPath) => runtimeHost.create(rootPath),
    disposeRoot: (rootPath) => runtimeHost.dispose(rootPath),
  });
  await projects.start(documents);
  serverLogger.info(`Discovered ${projects.knownRoots().length} Angular project root(s)`);
});

connection.onDidChangeWatchedFiles((params) => {
  watchedFiles?.dispatch(params.changes);
});

connection.onShutdown(() => {
  projects?.dispose();
  projects = undefined;
  runtimes?.disposeAll();
  runtimes = undefined;
  watchedFiles?.dispose();
  watchedFiles = undefined;
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
  logging.configure(environment.config.logging);
});

/** Reads the authoritative settings from a client that answers configuration requests. */
async function pullConfiguration(): Promise<void> {
  if (!environment) {
    return;
  }
  const [settings] = await connection.workspace.getConfiguration([{ section: CONFIGURATION_SECTION }]);
  environment.config = resolveExtensionConfig(settings);
  logging.configure(environment.config.logging);
}

connection.onCompletion((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return { isIncomplete: true, items: [] };
  }

  const view = toDocumentView(document);
  const completionList = completions.provide(view, params.position);
  if (completionList.items.length > 0) {
    return completionList;
  }

  return { ...completionList, items: probeCompletion(view, params.position, runtimeDependenciesLoaded) };
});

connection.onExecuteCommand(async (params) => {
  if (params.command !== APPLY_IMPORT_COMMAND) {
    return undefined;
  }
  await importCommand.execute(params.arguments);
  return undefined;
});

// A saved file is on disk again, so anything cached about its last-saved state is stale.
documents.onDidSave(({ document }) => {
  try {
    completions.invalidate(fileUriToPath(document.uri));
  } catch {
    // Not a file on disk; nothing was cached for it.
  }
});

connection.onNotification(SPIKE_CRASH_NOTIFICATION, () => {
  process.exit(86);
});

openDocuments.listen();
documents.listen(connection);
connection.listen();
