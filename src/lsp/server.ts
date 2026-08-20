import { readFileSync } from "node:fs";
import {
  createConnection,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  DocumentDiagnosticReportKind,
  type InitializeParams,
  type InitializeResult,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toCancellationSignal } from "../adapters/lsp/cancellation";
import { toDocumentView } from "../adapters/lsp/document";
import { type AngularCompilerApi, loadAngularCompiler } from "../core/angular-compiler";
import { fileUriToPath } from "../core/document";
import { installSharedLogger } from "../core/logging";
import { DEFAULT_EXTENSION_CONFIG, resolveExtensionConfig } from "../core/settings";
import { CodeActionHandler } from "./code-actions";
import { CompletionHandler } from "./completion";
import { DefinitionHandler } from "./definition";
import { DiagnosticsHandler } from "./diagnostics";
import { APPLY_IMPORT_COMMAND, ImportCommandHandler } from "./import-command";
import { ImportEditPlanner } from "./import-edit";
import { OpenDocuments } from "./open-documents";
import { ServerOperations } from "./operations";
import { ProjectRouter } from "./project-router";
import { ProjectRuntimeHost } from "./project-runtime-host";
import {
  ClearCacheRequest,
  DiagnosticsReportRequest,
  PerformanceMetricsRequest,
  ReindexRequest,
  SPIKE_CRASH_NOTIFICATION,
} from "./protocol";
import { DiagnosticsReporter } from "./report";
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
/** How long refresh triggers are coalesced before the client is asked to re-pull. */
const DIAGNOSTIC_REFRESH_DELAY_MS = 50;

const connection = createConnection();
const documents = new TextDocuments(TextDocument);
let runtimeDependenciesLoaded = false;
let compiler: AngularCompilerApi | undefined;
/** Whether a diagnostic refresh is already scheduled for the next tick. */
let refreshPending = false;
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

const diagnostics = new DiagnosticsHandler({
  router,
  documents: openDocuments,
  config: () => environment?.config ?? DEFAULT_EXTENSION_CONFIG,
  compiler: () => compiler,
  logger: serverLogger,
});

const definitions = new DefinitionHandler({ router, diagnostics, logger: serverLogger });

const reporter = new DiagnosticsReporter({ diagnostics, logger: serverLogger });

const operations = new ServerOperations({
  router,
  runtimes: () => runtimes?.all() ?? [],
  logger: serverLogger,
});

const importCommand = new ImportCommandHandler({
  router,
  documents: openDocuments,
  applyEdit: async (edit) => (await connection.workspace.applyEdit(edit)).applied,
  logger: serverLogger,
});

const codeActions = new CodeActionHandler({
  router,
  diagnostics,
  planner: new ImportEditPlanner({
    router,
    documents: openDocuments,
    readFile: (filePath) => readFileSync(filePath, "utf-8"),
    logger: serverLogger,
  }),
  resolvesActions: () => environment?.client.codeActionResolve === true,
  logger: serverLogger,
});

async function loadRuntimeDependencies(): Promise<void> {
  const [, tsMorph] = await Promise.all([loadCompiler(), import("ts-morph")]);
  if (typeof tsMorph.Project !== "function") {
    throw new Error("ts-morph did not expose the expected runtime API");
  }
  runtimeDependenciesLoaded = true;
}

/**
 * Loads the Angular compiler the analysis needs, and re-pulls once it arrives.
 *
 * Diagnostics requested before this resolves report nothing, so the client has to be
 * told to ask again rather than being left with the empty answer.
 */
async function loadCompiler(): Promise<void> {
  if (compiler) {
    return;
  }
  compiler = await loadAngularCompiler(serverLogger);
  requestDiagnosticRefresh();
}

/**
 * Asks the client to re-pull diagnostics for everything it has open.
 *
 * Coalesced onto the next tick: a burst of keystrokes, a finished index, and a batch of
 * watched-file changes all mean the same single thing to the client.
 */
function requestDiagnosticRefresh(): void {
  if (!environment?.client.diagnosticRefresh || refreshPending) {
    return;
  }
  refreshPending = true;
  setTimeout(() => {
    refreshPending = false;
    void connection.languages.diagnostics.refresh().catch((error) => {
      serverLogger.debug(`Diagnostic refresh failed: ${String(error)}`);
    });
  }, DIAGNOSTIC_REFRESH_DELAY_MS).unref?.();
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
    onDidChangeIndex: () => {
      // An element that just appeared or disappeared can change any open document's
      // report, and every cached "already imported" answer was decided against the
      // index that no longer exists.
      diagnostics.invalidateAll();
      requestDiagnosticRefresh();
    },
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

  void loadCompiler().catch(() => {
    // Already reported by the loader; diagnostics stay empty until a later load succeeds.
  });
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

connection.onCompletion((params, token) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return { isIncomplete: true, items: [] };
  }

  const view = toDocumentView(document);
  const completionList = completions.provide(view, params.position, toCancellationSignal(token));
  if (completionList.items.length > 0) {
    return completionList;
  }

  return { ...completionList, items: probeCompletion(view, params.position, runtimeDependenciesLoaded) };
});

connection.languages.diagnostics.on((params, token) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return { kind: DocumentDiagnosticReportKind.Full, items: [] };
  }
  return diagnostics.provide(toDocumentView(document), toCancellationSignal(token));
});

// A closed document keeps no report and no parsed template; the client stops asking.
documents.onDidClose(({ document }) => diagnostics.forget(document.uri));

connection.onDefinition((params, token) => {
  const document = documents.get(params.textDocument.uri);
  return document ? definitions.provide(toDocumentView(document), params.position, toCancellationSignal(token)) : [];
});

connection.onCodeAction((params, token) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  return codeActions.provide(toDocumentView(document), params.range, params.context.only, toCancellationSignal(token));
});

connection.onCodeActionResolve((action) => codeActions.resolve(action));

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
    const filePath = fileUriToPath(document.uri);
    completions.invalidate(filePath);
    diagnostics.invalidate(filePath);
  } catch {
    // Not a file on disk; nothing was cached for it.
  }
});

// A component's own edits decide what its external template is missing, so that
// template's report has to be pulled again even though the client saw no change to it.
documents.onDidChangeContent(({ document }) => {
  try {
    diagnostics.invalidate(fileUriToPath(document.uri));
  } catch {
    // Not a file on disk; nothing was cached for it.
  }
  requestDiagnosticRefresh();
});

connection.onRequest(ReindexRequest, async (scope) => {
  const result = await operations.reindex(scope);
  // The index the client's open documents were analyzed against is gone either way.
  diagnostics.invalidateAll();
  requestDiagnosticRefresh();
  return result;
});

connection.onRequest(ClearCacheRequest, async (scope) => {
  const result = await operations.clearCache(scope);
  diagnostics.invalidateAll();
  requestDiagnosticRefresh();
  return result;
});

connection.onRequest(PerformanceMetricsRequest, () => operations.metrics());

connection.onRequest(DiagnosticsReportRequest, (scope, token) => {
  const progress = scope.workDoneToken ? connection.window.attachWorkDoneProgress(scope.workDoneToken) : undefined;
  progress?.begin("Angular Auto Import: Generating Diagnostics Report", 0, undefined, true);

  return reporter
    .run(
      operations.resolveScope(scope),
      progress && {
        report: (message, percentage) => progress.report(percentage, message),
      },
      toCancellationSignal(token)
    )
    .finally(() => progress?.done());
});

connection.onNotification(SPIKE_CRASH_NOTIFICATION, () => {
  process.exit(86);
});

openDocuments.listen();
documents.listen(connection);
connection.listen();
