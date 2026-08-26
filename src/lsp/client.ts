/**
 * The VS Code half of the extension.
 *
 * It starts one language server per window and owns everything with a face — commands,
 * notifications, webviews, the output channel. Every language feature comes from the
 * server; nothing here analyzes anything.
 * @module
 */

import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  State,
  TransportKind,
} from "vscode-languageclient/node";
import { CONFIGURATION_SECTION, readSettingsSection } from "../config/settings";
import { logger } from "../logger";
import { registerClientCommands } from "./client-commands";
import { createProjectsStatusItem } from "./client-status";
import { CRASH_NOTIFICATION, ProjectsStatusNotification } from "./protocol";
import type { ServerInitializationOptions } from "./server-environment";

/**
 * Enables the command that kills the server on purpose.
 *
 * Recovering from a crashed server is behavior worth proving, and proving it means
 * causing one. That is a test's business and nobody else's, so the command exists only
 * when the test harness asks for it.
 */
const CRASH_COMMAND_ENV = "AAI_ENABLE_CRASH_COMMAND";

/** How many times the client restarts a server that keeps dying before giving up. */
const MAX_RESTARTS = 4;

let client: LanguageClient | undefined;

/**
 * Starts the language client and everything that depends on it.
 * @param context The extension context that owns the registrations.
 */
export async function startLanguageClient(context: vscode.ExtensionContext): Promise<void> {
  if (client) {
    return;
  }

  const serverModule = context.asAbsolutePath(path.join("dist", "server.js"));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ["--nolazy", "--inspect=6012"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "html" },
      { scheme: "file", language: "typescript" },
    ],
    initializationOptions: {
      settings: readSettingsSection(),
      // Per-workspace when the editor offers one, so two windows never share an index.
      storagePath: context.storageUri?.fsPath ?? context.globalStorageUri.fsPath,
    } satisfies ServerInitializationOptions,
    synchronize: { configurationSection: CONFIGURATION_SECTION },
    connectionOptions: { maxRestartCount: MAX_RESTARTS },
    // The server's logs join the extension's own channel; two channels for one
    // extension would leave the user guessing which half they were reading.
    outputChannel: logger.channel,
  };

  const started = new LanguageClient("angular-auto-import", "Angular Auto Import", serverOptions, clientOptions);
  client = started;

  try {
    await started.start();
  } catch (error) {
    client = undefined;
    throw error;
  }

  const showProjectsStatus = createProjectsStatusItem(context);
  context.subscriptions.push(started.onNotification(ProjectsStatusNotification, showProjectsStatus));

  registerClientCommands(context, started);
  if (process.env[CRASH_COMMAND_ENV] === "1") {
    context.subscriptions.push(
      vscode.commands.registerCommand("angular-auto-import.test.crashAndWaitForRestart", crashAndWaitForRestart)
    );
  }
}

/** Stops the language client and its server process. */
export async function stopLanguageClient(): Promise<void> {
  const running = client;
  client = undefined;
  if (running) {
    await running.stop();
  }
}

/**
 * Kills the server and waits for the client to bring a new one up.
 *
 * Test-only, and registered only when {@link CRASH_COMMAND_ENV} says so.
 * @internal
 */
async function crashAndWaitForRestart(): Promise<void> {
  const running = client;
  if (!running || running.state !== State.Running) {
    throw new Error("The client must be running before its server can be crashed");
  }

  let leftRunningState = false;
  let stateListener: vscode.Disposable | undefined;
  const restarted = new Promise<void>((resolve, reject) => {
    stateListener = running.onDidChangeState(({ newState }) => {
      if (newState === State.StartFailed) {
        stateListener?.dispose();
        reject(new Error("The client failed to restart after its server crashed"));
        return;
      }
      if (newState !== State.Running) {
        leftRunningState = true;
        return;
      }
      if (leftRunningState) {
        stateListener?.dispose();
        resolve();
      }
    });
  });

  try {
    await running.sendNotification(CRASH_NOTIFICATION);
    await restarted;
  } finally {
    stateListener?.dispose();
  }
}
