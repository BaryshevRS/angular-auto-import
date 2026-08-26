import * as vscode from "vscode";
import type { LogEntry, LoggerConfig, Transport } from "./types";

export class ChannelTransport implements Transport {
  private readonly outputChannel: vscode.LogOutputChannel;
  private readonly config: LoggerConfig;

  constructor(config: LoggerConfig) {
    this.config = config;
    // A log channel rather than a plain one, so the language client can share it: the
    // client insists on a LogOutputChannel, and `appendLine` on one appends raw, leaving
    // this transport's own formatting intact.
    this.outputChannel = vscode.window.createOutputChannel("Angular Auto Import", { log: true });
  }

  /**
   * The channel itself, so the language client can write the server's logs into the
   * same place the client writes its own. Two channels for one extension would leave
   * the user guessing which half of it they were reading.
   */
  public get channel(): vscode.LogOutputChannel {
    return this.outputChannel;
  }

  public log(entry: LogEntry): void {
    const message = this.format(entry);
    this.outputChannel.appendLine(message);

    if (entry.level === "ERROR" || entry.level === "FATAL") {
      this.outputChannel.show(true); // Preserve focus on the editor
    }
  }

  private format(entry: LogEntry): string {
    if (this.config.outputFormat === "json") {
      return JSON.stringify(entry, null, 2);
    }

    const { timestamp, level, message, context } = entry;
    let formattedMessage = `[${timestamp}][${level}] ${message}`;

    if (context) {
      try {
        const contextString = JSON.stringify(context, null, 2);
        // Indent context for better readability
        const indentedContext = contextString
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n");
        formattedMessage += `\n${indentedContext}`;
      } catch (error) {
        // Handle circular references in context
        formattedMessage += `\n  Context: [Could not stringify context: ${error}]`;
      }
    }

    return formattedMessage;
  }

  public show(): void {
    this.outputChannel.show(false);
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }
}
