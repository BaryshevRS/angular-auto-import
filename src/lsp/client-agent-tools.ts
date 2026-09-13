/**
 * The same four answers, offered to the editor's own chat instead of over MCP.
 *
 * A tool contributed here needs no server process, no `mcp.json`, and no step the user
 * has to take: agent mode picks it up because the extension is installed. It also costs
 * nothing to run, because every question is forwarded to the language server, which has
 * this workspace indexed already for the editor's own features.
 *
 * The MCP server stays for everything outside this window — Claude Code, Cursor, a
 * terminal — where there is no language server to ask. Inside one it is offered only
 * when these are refused, because both answer the same four questions: listing them
 * twice spends a model's attention on the choice, and the wrong choice starts a second
 * index of a workspace this window has already indexed.
 * @module
 */

import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { logger } from "../logger";
import {
  AgentDescribeElementRequest,
  AgentDescribeProjectRequest,
  type AgentFileQuery,
  AgentFindElementRequest,
  AgentVerifyTemplateRequest,
} from "./protocol";

/** What the model supplies for a tool that works inside one project. */
interface FileScopedInput {
  /** Optional: the model may know a file, and may not. */
  fromFile?: string;
}

interface FindElementInput extends FileScopedInput {
  query: string;
  type?: "component" | "directive" | "pipe";
}

interface DescribeElementInput extends FileScopedInput {
  query: string;
}

interface VerifyTemplateInput {
  component: string;
  template: string;
}

/**
 * Registers the language-model tools this extension contributes.
 * @param context The extension context, which owns the registrations.
 * @param client The running language client, which holds the indexed projects.
 * @returns Whether the editor accepted them; `false` asks the caller for the MCP server
 * instead. Editors built on this API surface do not all implement it, and one that
 * publishes `registerTool` may still ignore the manifest that declares what to register
 * — so this reports what actually happened rather than what the API suggests.
 */
export function registerAgentTools(context: vscode.ExtensionContext, client: LanguageClient): boolean {
  if (typeof vscode.lm?.registerTool !== "function") {
    return false;
  }

  // Registered one at a time and collected as they land, so a refusal partway through
  // leaves nothing half-offered: the ones already taken are given back before the caller
  // is told to fall back.
  const registered: vscode.Disposable[] = [];
  try {
    registered.push(
      tool<FileScopedInput>("angular-auto-import_describeProject", (input) =>
        client.sendRequest(AgentDescribeProjectRequest, scope(input))
      )
    );
    registered.push(
      tool<FindElementInput>("angular-auto-import_findElement", (input) =>
        client.sendRequest(AgentFindElementRequest, { ...scope(input), query: input.query, type: input.type })
      )
    );
    registered.push(
      tool<DescribeElementInput>("angular-auto-import_describeElement", (input) =>
        client.sendRequest(AgentDescribeElementRequest, { ...scope(input), query: input.query })
      )
    );
    registered.push(
      tool<VerifyTemplateInput>("angular-auto-import_verifyTemplate", (input) =>
        client.sendRequest(AgentVerifyTemplateRequest, { component: input.component, template: input.template })
      )
    );
  } catch (error) {
    for (const disposable of registered) {
      disposable.dispose();
    }
    logger.warn(`Angular Auto-Import: this editor refused the chat tools (${String(error)}); offering MCP instead.`);
    return false;
  }

  context.subscriptions.push(...registered);
  return true;
}

/**
 * Wraps one answer as a tool the editor can invoke.
 * @internal
 */
function tool<I>(name: string, answer: (input: I) => Promise<unknown>): vscode.Disposable {
  return vscode.lm.registerTool<I>(name, {
    invoke: async (options) => {
      const result = await answer(options.input);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))]);
    },
  });
}

/**
 * Which project the question is about.
 *
 * The model is asked for a file and often has one, but a chat turn that opens with
 * "what does this project use" has none to give. The editor does: the file in front of
 * the user, or failing that the folder the window was opened on — an answer about the
 * wrong project being far worse than an answer that says it found none.
 * @internal
 */
function scope(input: { fromFile?: string }): AgentFileQuery {
  const named = input.fromFile?.trim();
  if (named) {
    return { fromFile: named };
  }

  const active = vscode.window.activeTextEditor?.document;
  if (active?.uri.scheme === "file") {
    return { fromFile: active.uri.fsPath };
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  return { fromFile: folder?.uri.fsPath ?? "" };
}
