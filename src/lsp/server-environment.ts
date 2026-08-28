/**
 * Resolves what the server learned from `initialize`.
 *
 * The handshake is the only place the server hears about workspace roots, storage,
 * settings, and what the client can do. Parsing it is kept pure so the answers can be
 * asserted without a live JSON-RPC connection.
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { InitializeParams, InitializeResult, ServerCapabilities } from "vscode-languageserver/node";
import { CodeActionKind, TextDocumentSyncKind } from "vscode-languageserver/node";
import { fileUriToPath } from "../core/document";
import { type ExtensionConfig, resolveExtensionConfig } from "../core/settings";
import { APPLY_IMPORT_COMMAND } from "./import-command";
import { FIX_ALL_KIND } from "./protocol";

/** Completion trigger characters, kept identical to the direct provider's. */
export const COMPLETION_TRIGGER_CHARACTERS = ["<", "|", " ", "[", "*"];

/** What the client told us it supports, limited to the parts the server acts on. */
export interface ClientSupport {
  /** The client answers `workspace/configuration` pull requests. */
  configuration: boolean;
  /** The client reports workspace folders and their changes. */
  workspaceFolders: boolean;
  /** The client can register file watchers on the server's behalf. */
  didChangeWatchedFiles: boolean;
  /** The client can be asked to re-pull diagnostics for everything it has open. */
  diagnosticRefresh: boolean;
  /** The client fills in a code action's edit through `codeAction/resolve`. */
  codeActionResolve: boolean;
  /** The client promises one multi-document text edit is all-or-nothing. */
  transactionalWorkspaceEdit: boolean;
}

/** Everything one server instance needs from the handshake. */
export interface ServerEnvironment {
  /**
   * The folders the client advertised, in the order it sent them.
   *
   * Kept apart from {@link ServerEnvironment.workspaceRoots} because `projectPath` can
   * be set, unset, and corrected while the server runs: the folders are the fact, the
   * roots are what the setting currently makes of them, and re-deriving one from the
   * other needs both to still be around.
   */
  advertisedRoots: string[];
  /** Absolute filesystem paths of the roots actually served, after `projectPath`. */
  workspaceRoots: string[];
  /** Directory the client set aside for this workspace's caches, when it provided one. */
  storagePath: string | undefined;
  config: ExtensionConfig;
  client: ClientSupport;
}

/** Options the client passes at `initialize`. */
export interface ServerInitializationOptions {
  settings?: unknown;
  storagePath?: string;
}

/**
 * Reads the handshake into the server's own view of the world.
 * @param params The `initialize` request parameters.
 */
export function resolveServerEnvironment(params: InitializeParams): ServerEnvironment {
  const options = (params.initializationOptions ?? {}) as ServerInitializationOptions;
  const workspace = params.capabilities.workspace;
  const config = resolveExtensionConfig(options.settings);
  const advertisedRoots = advertisedWorkspaceRoots(params);

  return {
    advertisedRoots,
    workspaceRoots: resolveWorkspaceRoots(advertisedRoots, config),
    storagePath: typeof options.storagePath === "string" ? options.storagePath : undefined,
    config,
    client: {
      configuration: workspace?.configuration === true,
      workspaceFolders: workspace?.workspaceFolders === true,
      didChangeWatchedFiles: workspace?.didChangeWatchedFiles?.dynamicRegistration === true,
      diagnosticRefresh: workspace?.diagnostics?.refreshSupport === true,
      codeActionResolve: params.capabilities.textDocument?.codeAction?.resolveSupport !== undefined,
      transactionalWorkspaceEdit:
        workspace?.workspaceEdit?.failureHandling === "transactional" ||
        workspace?.workspaceEdit?.failureHandling === "textOnlyTransactional",
    },
  };
}

/**
 * Decides which roots this server serves.
 *
 * A configured `projectPath` wins outright: the user naming one directory means they do
 * not want the rest of the workspace indexed. Otherwise the folders the client
 * advertised.
 *
 * Exported because it is asked again whenever the setting changes. Deciding this once
 * at the handshake meant a user following the status bar's advice — set `projectPath`
 * to the application — changed the setting and watched nothing happen until they
 * reloaded the window.
 * @param advertisedRoots The folders the client advertised.
 * @param config The settings in force now.
 */
export function resolveWorkspaceRoots(advertisedRoots: readonly string[], config: ExtensionConfig): string[] {
  const configured = config.projectPath?.trim();
  if (configured) {
    const resolved = path.resolve(configured);
    // A configured path that is not a directory yields no roots at all, rather than
    // quietly falling back to the workspace: the user named one place, and indexing
    // somewhere else instead would be a surprise they never asked for.
    return isDirectory(resolved) ? [resolved] : [];
  }

  return [...advertisedRoots];
}

/**
 * The folders the client advertised, including the deprecated single-root fields older
 * clients still send instead.
 * @internal
 */
function advertisedWorkspaceRoots(params: InitializeParams): string[] {
  const folders = params.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders.map((folder) => toPath(folder.uri)).filter((path): path is string => path !== undefined);
  }

  const rootFromUri = params.rootUri ? toPath(params.rootUri) : undefined;
  if (rootFromUri) {
    return [rootFromUri];
  }

  return params.rootPath ? [params.rootPath] : [];
}

/** @internal */
function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Converts a workspace URI to a filesystem path, skipping anything not on disk.
 * @internal
 */
function toPath(uri: string): string | undefined {
  try {
    return fileUriToPath(uri);
  } catch {
    return undefined;
  }
}

/**
 * Builds the capabilities the server answers `initialize` with.
 * @param environment The resolved handshake, which decides the workspace-folder support.
 */
export function buildServerCapabilities(environment: ServerEnvironment): ServerCapabilities {
  const capabilities: ServerCapabilities = {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: {
      triggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
      // An accepted item's import is planned on resolution, not for every item offered.
      resolveProvider: true,
    },
    executeCommandProvider: {
      commands: [APPLY_IMPORT_COMMAND],
    },
    codeActionProvider: {
      codeActionKinds: [CodeActionKind.QuickFix, FIX_ALL_KIND],
      // The edit means rewriting the component with ts-morph, which is far too
      // expensive for actions the editor only lists.
      resolveProvider: environment.client.codeActionResolve,
    },
    definitionProvider: true,
    diagnosticProvider: {
      // A component's TypeScript file decides its external template's diagnostics, and
      // an index change can decide any open document's, so no document's report can be
      // computed from that document alone.
      interFileDependencies: true,
      workspaceDiagnostics: false,
    },
  };

  if (environment.client.workspaceFolders) {
    capabilities.workspace = {
      workspaceFolders: {
        supported: true,
        changeNotifications: true,
      },
    };
  }

  return capabilities;
}

/**
 * Applies a workspace-folder change to the roots the server tracks, keeping the order
 * stable and ignoring folders that are not on disk.
 * @param roots The roots known so far.
 * @param change The added and removed folder URIs.
 */
export function applyWorkspaceFolderChange(
  roots: string[],
  change: { added: readonly { uri: string }[]; removed: readonly { uri: string }[] }
): string[] {
  const removed = new Set(change.removed.map((folder) => toPath(folder.uri)));
  const kept = roots.filter((root) => !removed.has(root));

  for (const folder of change.added) {
    const path = toPath(folder.uri);
    if (path && !kept.includes(path)) {
      kept.push(path);
    }
  }

  return kept;
}

/**
 * Builds the `initialize` response.
 * @param environment The resolved handshake.
 * @param name The server name reported to the client.
 */
export function buildInitializeResult(environment: ServerEnvironment, name: string): InitializeResult {
  return {
    capabilities: buildServerCapabilities(environment),
    serverInfo: { name },
  };
}
