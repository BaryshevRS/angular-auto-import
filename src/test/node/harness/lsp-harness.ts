/**
 * A real client and a real server, connected in one process.
 *
 * Every handler test so far calls the handler directly, which proves the logic but not
 * the protocol: whether the capabilities are advertised, whether a payload survives
 * serialization, whether a request the client sends reaches the handler that answers it.
 * This harness closes that gap by running the actual `createServer` over an in-memory
 * duplex pair, so both sides speak JSON-RPC exactly as they would across a process
 * boundary — without the cost of starting one.
 *
 * The client half is deliberately not `LanguageClient`: that needs `vscode`. It is a
 * plain message connection, which is what `LanguageClient` is underneath anyway.
 * @module
 */

import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { type Connection, createConnection } from "vscode-languageserver/node";
import {
  type ClientCapabilities,
  createProtocolConnection,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  type InitializeResult,
  type ProtocolConnection,
  type ServerCapabilities,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node";
import { PerformanceMetricsRequest } from "../../../lsp/protocol";
import { createServer } from "../../../lsp/server";
import type { ServerInitializationOptions } from "../../../lsp/server-environment";

/** What a client would normally advertise; a test narrows it to prove the server adapts. */
export const FULL_CLIENT_CAPABILITIES: ClientCapabilities = {
  workspace: {
    configuration: true,
    workspaceFolders: true,
    applyEdit: true,
    didChangeWatchedFiles: { dynamicRegistration: true },
    diagnostics: { refreshSupport: true },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    completion: { completionItem: { snippetSupport: false } },
    codeAction: { resolveSupport: { properties: ["edit"] } },
    diagnostic: { dynamicRegistration: false },
  },
};

export interface HarnessOptions {
  /** Workspace folders the client advertises, as filesystem paths. */
  workspaceRoots?: string[];
  /** Settings sent at `initialize`, and answered with on `workspace/configuration`. */
  settings?: unknown;
  /** Where the server may persist caches. */
  storagePath?: string;
  /** What the client claims to support; the full set by default. */
  capabilities?: ClientCapabilities;
}

/** A live client/server pair, and what the test needs to drive it. */
export interface Harness {
  /** The client end, for sending requests and notifications. */
  client: ProtocolConnection;
  /** The capabilities the server answered `initialize` with. */
  capabilities: ServerCapabilities;
  /** Workspace edits the server asked the client to apply, in arrival order. */
  appliedEdits: unknown[];
  /** How many times the server asked the client to re-pull diagnostics. */
  diagnosticRefreshes(): number;
  /** Opens a document, as an editor would. */
  open(filePath: string, text: string, languageId: string): Promise<void>;
  /** Replaces an open document's text, advancing its version. */
  change(filePath: string, text: string): Promise<void>;
  /** Saves an open document. */
  save(filePath: string): Promise<void>;
  /** Closes an open document. */
  close(filePath: string): Promise<void>;
  /** The URI the client uses for a path, which is what every request is keyed by. */
  uri(filePath: string): string;
  /**
   * Waits until the server has discovered and indexed its projects.
   *
   * Discovery and indexing run after `initialized`, so a request sent immediately gets
   * an honest empty answer. A real client would simply be re-pulled once the index
   * lands; a test has to wait for the same moment before asserting on it.
   * @param count How many projects to expect.
   */
  waitForProjects(count?: number): Promise<void>;
  /** Shuts the server down and releases the transport. */
  dispose(): Promise<void>;
}

/**
 * Starts a client and server on a shared in-memory transport and completes the handshake.
 * @param options What the client advertises and asks for.
 */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();

  const serverConnection: Connection = createConnection(
    new StreamMessageReader(clientToServer),
    new StreamMessageWriter(serverToClient)
  );
  createServer(serverConnection, { exitOnCrashNotification: false });
  serverConnection.listen();

  const client = createProtocolConnection(
    new StreamMessageReader(serverToClient),
    new StreamMessageWriter(clientToServer)
  );

  const versions = new Map<string, number>();
  const appliedEdits: unknown[] = [];
  let refreshes = 0;

  client.onRequest("workspace/applyEdit", (params: unknown) => {
    appliedEdits.push(params);
    return { applied: true };
  });
  client.onRequest("workspace/diagnostic/refresh", () => {
    refreshes += 1;
    return null;
  });
  // A client that advertises `configuration` must answer for it, or the server's own
  // settings pull hangs the initialization it happens during.
  client.onRequest("workspace/configuration", (params: { items: unknown[] }) =>
    params.items.map(() => options.settings ?? {})
  );
  // The server registers watchers and progress against these; answering keeps it moving.
  client.onRequest("client/registerCapability", () => null);
  client.onRequest("window/workDoneProgress/create", () => null);
  client.listen();

  const workspaceRoots = options.workspaceRoots ?? [];
  const initialize = (await client.sendRequest(InitializeRequest.type, {
    // Null on purpose: a process id makes the server poll whether its parent is still
    // alive, forever, and this client is not a process the server could outlive.
    processId: null,
    rootUri: null,
    capabilities: options.capabilities ?? FULL_CLIENT_CAPABILITIES,
    workspaceFolders: workspaceRoots.map((root) => ({ uri: pathToFileURL(root).toString(), name: root })),
    initializationOptions: {
      settings: options.settings,
      storagePath: options.storagePath,
    } satisfies ServerInitializationOptions,
  })) as InitializeResult;

  await client.sendNotification(InitializedNotification.type, {});

  const uri = (filePath: string): string => pathToFileURL(filePath).toString();

  return {
    client,
    capabilities: initialize.capabilities,
    appliedEdits,
    diagnosticRefreshes: () => refreshes,
    uri,

    async waitForProjects(count = 1) {
      const deadline = Date.now() + 15000;
      for (;;) {
        const metrics = await client.sendRequest(PerformanceMetricsRequest);
        // The compiler matters as much as the index: without it every diagnostic
        // request answers with nothing, which reads exactly like a clean workspace.
        if (
          metrics.analysisReady &&
          metrics.projects.length >= count &&
          metrics.projects.every((project) => project.elementCount > 0)
        ) {
          return;
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for ${count} indexed project(s); saw ${JSON.stringify(metrics.projects)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },

    async open(filePath, text, languageId) {
      versions.set(filePath, 1);
      await client.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri: uri(filePath), languageId, version: 1, text },
      });
      await settle(client);
    },

    async change(filePath, text) {
      const version = (versions.get(filePath) ?? 1) + 1;
      versions.set(filePath, version);
      await client.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri: uri(filePath), version },
        contentChanges: [{ text }],
      });
      await settle(client);
    },

    async save(filePath) {
      await client.sendNotification(DidSaveTextDocumentNotification.type, {
        textDocument: { uri: uri(filePath) },
      });
      await settle(client);
    },

    async close(filePath) {
      versions.delete(filePath);
      await client.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri: uri(filePath) },
      });
      await settle(client);
    },

    async dispose() {
      try {
        await client.sendRequest(ShutdownRequest.type, undefined);
        await client.sendNotification(ExitNotification.type);
      } catch {
        // A server that already went away needs no shutdown.
      }
      client.dispose();
      serverConnection.dispose();
      clientToServer.destroy();
      serverToClient.destroy();
    },
  };
}

/**
 * Waits for the server to finish reacting to a notification.
 *
 * A notification has no reply, so there is nothing to await: the only way to know the
 * server has processed it is to send something it must answer and wait for that. An
 * unknown request is refused, and the refusal is exactly the round trip we need.
 * @internal
 */
async function settle(client: ProtocolConnection): Promise<void> {
  try {
    await client.sendRequest("angularAutoImport/noop", {});
  } catch {
    // Expected: the server has no such handler. Reaching the refusal is the point.
  }
}
