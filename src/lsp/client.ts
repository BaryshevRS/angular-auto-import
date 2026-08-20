import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  State,
  TransportKind,
} from "vscode-languageclient/node";
import { getConfiguration } from "../config/settings";
import { registerClientCommands } from "./client-commands";
import { SPIKE_CRASH_NOTIFICATION } from "./protocol";
import type { ServerInitializationOptions } from "./server-environment";

const LSP_SPIKE_ENV = "AAI_LSP_SPIKE";

let client: LanguageClient | undefined;

/** Returns whether the isolated development-only LSP spike is enabled. */
export function isLspSpikeEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[LSP_SPIKE_ENV] === "1";
}

/** Starts the development-only language client. Direct providers must not be registered in this mode. */
export async function startLspSpike(context: vscode.ExtensionContext): Promise<void> {
  if (client) {
    return;
  }

  const serverModule = context.asAbsolutePath(path.join("dist", "server.js"));
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ["--nolazy", "--inspect=6012"],
      },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "html" },
      { scheme: "file", language: "typescript" },
    ],
    initializationOptions: {
      settings: getConfiguration(),
      storagePath: context.storageUri?.fsPath ?? context.globalStorageUri.fsPath,
      verifyRuntimeDependencies: true,
    } satisfies ServerInitializationOptions,
    synchronize: {
      configurationSection: "angular-auto-import",
    },
    connectionOptions: {
      maxRestartCount: 2,
    },
    outputChannelName: "Angular Auto Import LSP (Spike)",
  };

  const nextClient = new LanguageClient(
    "angular-auto-import-lsp-spike",
    "Angular Auto Import LSP (Spike)",
    serverOptions,
    clientOptions
  );
  client = nextClient;

  try {
    await nextClient.start();
    registerClientCommands(context, nextClient);
    context.subscriptions.push(
      vscode.commands.registerCommand("angular-auto-import.lsp-spike.stop", stopLspSpike),
      vscode.commands.registerCommand(
        "angular-auto-import.lsp-spike.crash-and-wait-for-restart",
        crashAndWaitForRestart
      )
    );
  } catch (error) {
    client = undefined;
    throw error;
  }
}

async function crashAndWaitForRestart(): Promise<void> {
  const activeClient = client;
  if (!activeClient || activeClient.state !== State.Running) {
    throw new Error("The LSP spike client must be running before its server can be crashed");
  }

  let leftRunningState = false;
  let stateListener: vscode.Disposable | undefined;
  const restarted = new Promise<void>((resolve, reject) => {
    stateListener = activeClient.onDidChangeState(({ newState }) => {
      if (newState === State.StartFailed) {
        stateListener?.dispose();
        reject(new Error("The LSP spike client failed to restart after its server crashed"));
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
    await activeClient.sendNotification(SPIKE_CRASH_NOTIFICATION);
    await restarted;
  } finally {
    stateListener?.dispose();
  }
}

/** Stops the development-only language client and its server process. */
export async function stopLspSpike(): Promise<void> {
  const activeClient = client;
  client = undefined;
  if (activeClient) {
    await activeClient.stop();
  }
}
