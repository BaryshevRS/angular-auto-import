/**
 * The language server, assembled onto a connection.
 *
 * Everything the server owns is built here rather than at module load, so a test can
 * put a server on an in-memory transport and drive it through the real protocol. The
 * process entry point in `server-main` does nothing but supply a real connection.
 *
 * The registrations are grouped by what they are for — lifecycle, document tracking,
 * language features, the extension's own operations — because that is how they change:
 * a new language feature touches one group and none of the others.
 * @module
 */

import { readFileSync } from "node:fs";
import {
  type Connection,
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
import { AngularProjectDiscovery } from "../core/project-discovery";
import { DEFAULT_EXTENSION_CONFIG, resolveExtensionConfig } from "../core/settings";
import { clearTemplateCache } from "../utils/template-detection";
import { CodeActionHandler } from "./code-actions";
import { CompletionHandler } from "./completion";
import { DefinitionHandler } from "./definition";
import { DiagnosticsHandler } from "./diagnostics";
import { APPLY_IMPORT_COMMAND, ImportCommandHandler } from "./import-command";
import { ImportEditPlanner } from "./import-edit";
import { resolveImportFormatting } from "./import-formatting";
import { OpenDocuments } from "./open-documents";
import { ServerOperations } from "./operations";
import { ProjectRouter } from "./project-router";
import { ProjectRuntimeHost } from "./project-runtime-host";
import { describeProjectsStatus } from "./projects-status";
import {
  CRASH_NOTIFICATION,
  DiagnosticsReportRequest,
  PerformanceMetricsRequest,
  ProjectsStatusNotification,
  ReindexRequest,
} from "./protocol";
import { DiagnosticsReporter } from "./report";
import {
  applyWorkspaceFolderChange,
  buildInitializeResult,
  resolveServerEnvironment,
  resolveWorkspaceRoots,
  type ServerEnvironment,
} from "./server-environment";
import { ServerLogging } from "./server-logging";
import { ServerProjects } from "./server-projects";
import { WatchedFiles } from "./watched-files";

const SERVER_NAME = "Angular Auto Import LSP Spike";
const CONFIGURATION_SECTION = "angular-auto-import";
/** How long refresh triggers are coalesced before the client is asked to re-pull. */
const DIAGNOSTIC_REFRESH_DELAY_MS = 50;
/** How long projects-status reports are coalesced before the client is told. */
const PROJECTS_STATUS_DELAY_MS = 250;

/** How a caller may vary the server it builds. */
export interface ServerOptions {
  /**
   * Whether the test-only crash notification really kills the process. A harness running
   * the server inside its own process must say no, or the test run dies with it.
   */
  exitOnCrashNotification?: boolean;
}

/**
 * What one server instance holds, and what every registration reads.
 * @internal
 */
interface ServerContext {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  openDocuments: OpenDocuments;
  logging: ServerLogging;
  handlers: ServerHandlers;
  /** Everything the handshake and discovery produce. */
  state: ServerState;
  /** Asks the client to re-pull diagnostics, coalescing bursts into one request. */
  requestDiagnosticRefresh(): void;
  /** Tells the client what discovery came to, coalescing bursts into one notification. */
  requestProjectsStatusReport(): void;
  /** Loads the Angular compiler, then asks the client to re-pull. */
  loadCompiler(): Promise<void>;
}

/**
 * The parts that only exist after the handshake.
 *
 * Mutable on purpose: a request arriving before discovery has run, or after shutdown
 * released everything, must find nothing rather than something stale.
 * @internal
 */
interface ServerState {
  environment?: ServerEnvironment;
  projects?: ServerProjects;
  runtimes?: ProjectRuntimeHost;
  watchedFiles?: WatchedFiles;
  compiler?: AngularCompilerApi;
  /** The scheduled diagnostic refresh, if one is pending. */
  refreshTimer?: NodeJS.Timeout;
  /** The scheduled projects-status report, if one is pending. */
  statusTimer?: NodeJS.Timeout;
  /** Discovery, kept so a changed `projectPath` can change what it trusts. */
  discovery?: AngularProjectDiscovery;
}

/** @internal */
interface ServerHandlers {
  completions: CompletionHandler;
  diagnostics: DiagnosticsHandler;
  definitions: DefinitionHandler;
  codeActions: CodeActionHandler;
  importCommand: ImportCommandHandler;
  operations: ServerOperations;
  reporter: DiagnosticsReporter;
}

/**
 * Wires one server onto a connection. The caller starts the connection when it is ready
 * to receive.
 * @param connection The connection to serve on.
 * @param options How to vary the server.
 */
export function createServer(connection: Connection, options: ServerOptions = {}): void {
  const context = createContext(connection);

  registerLifecycle(context);
  registerDocumentTracking(context);
  registerLanguageFeatures(context, options);
  registerOperations(context);

  context.openDocuments.listen();
  context.documents.listen(connection);
}

/**
 * Builds everything one server holds, in dependency order.
 * @internal
 */
function createContext(connection: Connection): ServerContext {
  const documents = new TextDocuments(TextDocument);
  const openDocuments = new OpenDocuments(documents);
  const logging = new ServerLogging(connection.console);
  const logger = logging.logger;
  const state: ServerState = {};

  const router = new ProjectRouter({
    rootForPath: (filePath) => state.projects?.rootForPath(filePath),
    runtimeForRoot: (rootPath) => state.runtimes?.get(rootPath),
  });
  // Re-read per request: the user can change these while the server runs.
  const config = () => state.environment?.config ?? DEFAULT_EXTENSION_CONFIG;

  const diagnostics = new DiagnosticsHandler({
    router,
    documents: openDocuments,
    config,
    compiler: () => state.compiler,
    logger,
  });

  // One planner: an accepted completion, a quick fix, and fix-all all produce the same
  // edit, and there is no reason for them to compute it three different ways.
  const planner = new ImportEditPlanner({
    router,
    documents: openDocuments,
    readFile: (filePath) => readFileSync(filePath, "utf-8"),
    resolveFormatting: (filePath) => resolveImportFormatting(filePath, logger),
    logger,
  });

  const context: ServerContext = {
    connection,
    documents,
    openDocuments,
    logging,
    state,
    handlers: {
      diagnostics,
      completions: new CompletionHandler({ router, documents: openDocuments, config, planner, logger }),
      definitions: new DefinitionHandler({ router, diagnostics, logger }),
      reporter: new DiagnosticsReporter({ diagnostics, logger }),
      operations: new ServerOperations({
        router,
        runtimes: () => state.runtimes?.all() ?? [],
        analysisReady: () => state.compiler !== undefined,
        logger,
      }),
      importCommand: new ImportCommandHandler({
        router,
        documents: openDocuments,
        applyEdit: async (edit) => (await connection.workspace.applyEdit(edit)).applied,
        resolveFormatting: (filePath) => resolveImportFormatting(filePath, logger),
        logger,
      }),
      codeActions: new CodeActionHandler({
        router,
        diagnostics,
        planner,
        resolvesActions: () => state.environment?.client.codeActionResolve === true,
        logger,
      }),
    },
    requestDiagnosticRefresh: () => requestDiagnosticRefresh(context),
    requestProjectsStatusReport: () => requestProjectsStatusReport(context),
    loadCompiler: () => loadCompiler(context),
  };

  return context;
}

/**
 * Registers the handshake, discovery, configuration, and shutdown.
 * @internal
 */
function registerLifecycle(context: ServerContext): void {
  const { connection, logging, state } = context;
  const logger = logging.logger;

  connection.onInitialize((params: InitializeParams): InitializeResult => {
    installSharedLogger(logger);
    const environment = resolveServerEnvironment(params);
    state.environment = environment;
    logging.configure(environment.config.logging);

    logger.info(
      `Initialized for ${environment.workspaceRoots.length} workspace root(s); storage: ${environment.storagePath ?? "none"}`
    );

    return buildInitializeResult(environment, SERVER_NAME);
  });

  connection.onInitialized(async () => {
    const environment = state.environment;
    if (!environment) {
      return;
    }

    if (environment.client.configuration) {
      await connection.client.register(DidChangeConfigurationNotification.type, { section: CONFIGURATION_SECTION });
      await pullConfiguration(context);
    }

    followWorkspaceFolders(context, environment);
    await startProjects(context, environment);

    void context.loadCompiler().catch(() => {
      // Already reported by the loader; diagnostics stay empty until a later load succeeds.
    });
  });

  connection.onDidChangeWatchedFiles((params) => {
    state.watchedFiles?.dispatch(params.changes);
  });

  registerConfiguration(context);

  connection.onShutdown(() => {
    // Anything still on the clock would fire against a connection that is gone.
    clearTimeout(state.refreshTimer);
    state.refreshTimer = undefined;
    clearTimeout(state.statusTimer);
    state.statusTimer = undefined;
    state.discovery = undefined;
    state.projects?.dispose();
    state.projects = undefined;
    state.runtimes?.disposeAll();
    state.runtimes = undefined;
    state.watchedFiles?.dispose();
    state.watchedFiles = undefined;
  });
}

/**
 * Keeps the tracked roots following the folders the client reports.
 *
 * A client that does not report them is left alone: its workspace cannot change under
 * us, so there is nothing to follow.
 * @internal
 */
function followWorkspaceFolders(context: ServerContext, environment: ServerEnvironment): void {
  if (!environment.client.workspaceFolders) {
    return;
  }

  const { connection, state } = context;
  connection.workspace.onDidChangeWorkspaceFolders((event) => {
    if (!state.environment) {
      return;
    }
    const environment = state.environment;
    environment.advertisedRoots = applyWorkspaceFolderChange(environment.advertisedRoots, event);
    context.logging.logger.info(`Workspace folders now: ${environment.advertisedRoots.length}`);
    void applyResolvedRoots(context, environment);
  });
}

/**
 * Keeps the settings current, from whichever direction the client supplies them.
 * @internal
 */
function registerConfiguration(context: ServerContext): void {
  const { connection, state } = context;

  connection.onDidChangeConfiguration(async (params) => {
    const environment = state.environment;
    if (!environment) {
      return;
    }

    // A client that answers configuration requests is the authority on its own settings;
    // what it pushed with the notification may be less than the whole section.
    if (environment.client.configuration) {
      await pullConfiguration(context);
      return;
    }

    const pushed = (params.settings as Record<string, unknown> | null)?.[CONFIGURATION_SECTION];
    await applyConfiguration(context, environment, pushed);
  });
}

/**
 * Re-derives the roots served from the folders advertised and the settings in force,
 * and moves the server onto them if anything about them changed.
 *
 * `projectPath` decides two separate things: which roots exist, and which of them are
 * believed without a manifest. They move independently, and the second one is the easy
 * one to miss — naming the folder that is already open leaves the list of roots
 * identical while turning it from "not a project" into one. So both are asked, and
 * either is reason enough to run discovery again.
 *
 * Trust is updated first: discovery must already believe a root by the time it is asked
 * about one.
 * @internal
 */
async function applyResolvedRoots(context: ServerContext, environment: ServerEnvironment): Promise<void> {
  const resolved = resolveWorkspaceRoots(environment.advertisedRoots, environment.config);
  const configured = environment.config.projectPath?.trim();
  const trustChanged = context.state.discovery?.setTrustedRoots(configured ? resolved : []) ?? false;
  const rootsChanged = !sameRoots(resolved, environment.workspaceRoots);

  if (!rootsChanged && !trustChanged) {
    return;
  }

  environment.workspaceRoots = resolved;
  context.logging.logger.info(
    `Serving ${resolved.length} workspace root(s): ${resolved.join(", ") || "none"}` +
      (trustChanged ? ` (${configured ? "believed as configured" : "no longer believed without a manifest"})` : "")
  );
  await context.state.projects?.setWorkspaceRoots(resolved);
  context.requestProjectsStatusReport();
}

/** @internal */
function sameRoots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((root, index) => root === right[index]);
}

/**
 * Starts watching, the project runtimes, and lazy discovery.
 * @internal
 */
async function startProjects(context: ServerContext, environment: ServerEnvironment): Promise<void> {
  const { connection, state, handlers } = context;
  const logger = context.logging.logger;

  const watchedFiles = new WatchedFiles({
    logger,
    register: environment.client.didChangeWatchedFiles
      ? (watchers) => connection.client.register(DidChangeWatchedFilesNotification.type, { watchers })
      : undefined,
  });
  state.watchedFiles = watchedFiles;

  // One discovery for both: what it calls a project root is what a project's scan
  // stops at, so a nested package cannot be a root for routing and a subdirectory for
  // indexing at the same time. Sharing it also shares the manifest cache, which
  // `invalidateManifest` then clears for both at once.
  // A configured `projectPath` is the one root that needs no manifest to be believed.
  const discovery = new AngularProjectDiscovery({
    logger,
    trustedRoots: environment.config.projectPath?.trim() ? environment.workspaceRoots : [],
  });
  state.discovery = discovery;

  const runtimeHost = new ProjectRuntimeHost({
    logger,
    storagePath: environment.storagePath,
    fileWatchers: watchedFiles,
    boundaries: discovery,
    importModuleSpecifierPreference: () => environment.config.importModuleSpecifier,
    onDidChangeIndex: () => {
      // An element that just appeared or disappeared can change any open document's
      // report, and every cached "already imported" answer was decided against the
      // index that no longer exists.
      handlers.diagnostics.invalidateAll();
      context.requestDiagnosticRefresh();
      // The element count the client is showing was counted against that index.
      context.requestProjectsStatusReport();
    },
  });
  state.runtimes = runtimeHost;

  const projects = new ServerProjects({
    workspaceRoots: environment.workspaceRoots,
    logger,
    discovery,
    initializeRoot: (rootPath) => runtimeHost.create(rootPath),
    disposeRoot: (rootPath) => runtimeHost.dispose(rootPath),
    onDidChangeRoots: () => context.requestProjectsStatusReport(),
  });
  state.projects = projects;

  await projects.start(context.documents);
  reportProjectsStatus(context);
}

/**
 * Reports what discovery came to, coalescing bursts into one notification.
 *
 * Indexing fires per watched change, and a status the client renders on every one of
 * them would cost more than the count is worth.
 * @internal
 */
function requestProjectsStatusReport(context: ServerContext): void {
  const { state } = context;
  if (state.statusTimer) {
    return;
  }

  state.statusTimer = setTimeout(() => {
    state.statusTimer = undefined;
    reportProjectsStatus(context);
  }, PROJECTS_STATUS_DELAY_MS);
  state.statusTimer.unref?.();
}

/**
 * Tells the client, and the log, what discovery came to.
 *
 * Both ends get the same sentence: the log is where a user who suspects something is
 * wrong looks, and the status bar is what tells them to suspect it in the first place.
 * @internal
 */
function reportProjectsStatus(context: ServerContext): void {
  const { state, connection } = context;
  const environment = state.environment;
  if (!environment) {
    return;
  }
  const logger = context.logging.logger;

  const status = describeProjectsStatus({
    workspaceRoots: environment.workspaceRoots,
    projects: (state.projects?.knownRoots() ?? []).map((rootPath) => ({
      rootPath,
      elementCount: state.runtimes?.get(rootPath)?.elementCount ?? 0,
    })),
    config: environment.config,
  });

  try {
    if (status.problem) {
      logger.warn(`Angular Auto-Import has nothing to work on. ${status.problem}`);
    } else {
      logger.info(`Discovered ${status.projects.length} Angular project root(s)`);
    }
    void connection.sendNotification(ProjectsStatusNotification, status);
  } catch {
    // The status is coalesced, so it can come due after the connection is gone. There
    // is nobody left to tell, and nothing about that is worth failing over.
  }
}

/**
 * Registers what the server does when a document changes, rather than when it is asked
 * a question about one.
 * @internal
 */
function registerDocumentTracking(context: ServerContext): void {
  const { documents, handlers } = context;

  // A closed document keeps nothing: no report, no parsed template AST, and no cached
  // template-string ranges. The client will not ask about it again.
  documents.onDidClose(({ document }) => {
    handlers.diagnostics.forget(document.uri);
    clearTemplateCache(document.uri);
  });

  // A saved file is on disk again, so anything cached about its last-saved state is stale.
  documents.onDidSave(({ document }) => {
    withFilePath(document.uri, (filePath) => {
      handlers.completions.invalidate(filePath);
      handlers.diagnostics.invalidate(filePath);
    });
  });

  // A component's own edits decide what its external template is missing, so that
  // template's report has to be pulled again even though the client saw no change to it.
  documents.onDidChangeContent(({ document }) => {
    withFilePath(document.uri, (filePath) => handlers.diagnostics.invalidate(filePath));
    context.requestDiagnosticRefresh();
  });
}

/**
 * Registers completion, diagnostics, definitions, code actions, and the import command.
 * @internal
 */
function registerLanguageFeatures(context: ServerContext, options: ServerOptions): void {
  const { connection, documents, handlers } = context;

  connection.onCompletion((params, token) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return { isIncomplete: true, items: [] };
    }

    return handlers.completions.provide(toDocumentView(document), params.position, toCancellationSignal(token));
  });

  connection.onCompletionResolve((item) => handlers.completions.resolve(item));

  connection.languages.diagnostics.on((params, token) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return { kind: DocumentDiagnosticReportKind.Full, items: [] };
    }
    return handlers.diagnostics.provide(toDocumentView(document), toCancellationSignal(token));
  });

  connection.onDefinition((params, token) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return [];
    }
    return handlers.definitions.provide(toDocumentView(document), params.position, toCancellationSignal(token));
  });

  connection.onCodeAction((params, token) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
      return [];
    }
    return handlers.codeActions.provide(
      toDocumentView(document),
      params.range,
      params.context.only,
      toCancellationSignal(token)
    );
  });

  connection.onCodeActionResolve((action) => handlers.codeActions.resolve(action));

  connection.onExecuteCommand(async (params) => {
    if (params.command !== APPLY_IMPORT_COMMAND) {
      return undefined;
    }
    await handlers.importCommand.execute(params.arguments);
    return undefined;
  });

  if (options.exitOnCrashNotification !== false) {
    connection.onNotification(CRASH_NOTIFICATION, () => {
      process.exit(86);
    });
  }
}

/**
 * Registers the extension's own requests, which are not language features.
 * @internal
 */
function registerOperations(context: ServerContext): void {
  const { connection, handlers } = context;

  connection.onRequest(ReindexRequest, async (scope) => {
    const result = await handlers.operations.reindex(scope);
    // The index the client's open documents were analyzed against is gone either way.
    handlers.diagnostics.invalidateAll();
    context.requestDiagnosticRefresh();
    return result;
  });

  connection.onRequest(PerformanceMetricsRequest, () => handlers.operations.metrics());

  connection.onRequest(DiagnosticsReportRequest, (scope, token) => {
    const progress = scope.workDoneToken ? connection.window.attachWorkDoneProgress(scope.workDoneToken) : undefined;
    progress?.begin("Angular Auto Import: Generating Diagnostics Report", 0, undefined, true);

    return handlers.reporter
      .run(
        handlers.operations.resolveScope(scope),
        progress && { report: (message, percentage) => progress.report(percentage, message) },
        toCancellationSignal(token)
      )
      .finally(() => progress?.done());
  });
}

/**
 * Reads the authoritative settings from a client that answers configuration requests.
 * @internal
 */
async function pullConfiguration(context: ServerContext): Promise<void> {
  const environment = context.state.environment;
  if (!environment) {
    return;
  }

  const [settings] = await context.connection.workspace.getConfiguration([{ section: CONFIGURATION_SECTION }]);
  await applyConfiguration(context, environment, settings);
}

/**
 * Puts a freshly supplied configuration into effect.
 *
 * The diagnostics the client is holding were decided by the settings that just changed
 * — the mode that would now hide them, the severity they would now carry — and nothing
 * else will make it look again: a client that pulls only pulls when it is asked to.
 * @param settings The settings section, in whatever the client supplied it.
 * @internal
 */
async function applyConfiguration(
  context: ServerContext,
  environment: ServerEnvironment,
  settings: unknown
): Promise<void> {
  environment.config = resolveExtensionConfig(settings);
  context.logging.configure(environment.config.logging);
  context.handlers.diagnostics.invalidateAll();
  context.requestDiagnosticRefresh();
  await applyResolvedRoots(context, environment);
}

/**
 * Loads the Angular compiler the analysis needs, and re-pulls once it arrives.
 *
 * Diagnostics requested before this resolves report nothing, so the client has to be
 * told to ask again rather than being left with the empty answer.
 * @internal
 */
async function loadCompiler(context: ServerContext): Promise<void> {
  if (context.state.compiler) {
    return;
  }
  context.state.compiler = await loadAngularCompiler(context.logging.logger);
  context.requestDiagnosticRefresh();
}

/**
 * Asks the client to re-pull diagnostics for everything it has open.
 *
 * Coalesced onto a later tick: a burst of keystrokes, a finished index, and a batch of
 * watched-file changes all mean the same single thing to the client.
 * @internal
 */
function requestDiagnosticRefresh(context: ServerContext): void {
  const { state } = context;
  if (!state.environment?.client.diagnosticRefresh || state.refreshTimer) {
    return;
  }

  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = undefined;
    try {
      void context.connection.languages.diagnostics.refresh().catch((error) => {
        context.logging.logger.debug(`Diagnostic refresh failed: ${String(error)}`);
      });
    } catch (error) {
      // A connection disposed while this was on the clock throws rather than rejecting.
      context.logging.logger.debug(`Diagnostic refresh skipped: ${String(error)}`);
    }
  }, DIAGNOSTIC_REFRESH_DELAY_MS);
  state.refreshTimer.unref?.();
}

/**
 * Runs an action for a document that is a file on disk, and skips the ones that are not.
 * @internal
 */
function withFilePath(uri: string, action: (filePath: string) => void): void {
  try {
    action(fileUriToPath(uri));
  } catch {
    // Not a file on disk; nothing was cached for it.
  }
}
