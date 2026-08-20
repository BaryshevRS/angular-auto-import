import * as os from "node:os";
import * as path from "node:path";
import * as process from "node:process";
import * as vscode from "vscode";
import { ChannelTransport } from "./channel-transport";
import { getLoggerConfig } from "./config";
import { FileTransport } from "./file-transport";
import type { LogEntry, LoggerConfig, LogLevel, LogPoint, PerformanceMetrics, Transport } from "./types";

export class Logger {
  private static instance: Logger;
  private config!: LoggerConfig;
  private transports: Transport[] = [];
  private readonly sessionId: string;
  private extensionVersion: string;
  private context: vscode.ExtensionContext | null = null;
  private readonly logPoints = new Map<string, LogPoint>();

  private getLogLevelValue(level: LogLevel): number {
    switch (level) {
      case "DEBUG":
        return 0;
      case "INFO":
        return 1;
      case "WARN":
        return 2;
      case "ERROR":
        return 3;
      case "FATAL":
        return 4;
      default:
        return 0;
    }
  }

  private constructor() {
    this.sessionId = vscode.env.sessionId;
    this.extensionVersion = "0.0.0"; // Placeholder, will be updated on initialize
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public initialize(context: vscode.ExtensionContext) {
    this.context = context;
    const extensionPackageJson = context.extension.packageJSON;
    this.extensionVersion = extensionPackageJson.version ?? "0.0.0";

    this.config = getLoggerConfig();
    this.setupTransports();

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("angular-auto-import.logging")) {
        this.updateConfig();
      }
    });
  }

  private updateConfig() {
    this.info("Logging configuration changed. Reloading...");
    this.config = getLoggerConfig();

    this.transports.forEach((transport) => {
      transport.dispose();
    });
    this.transports = [];

    this.setupTransports();
    this.info("Logger re-initialized with new configuration.");
  }

  private setupTransports() {
    if (!this.config.enabled) {
      this.transports.forEach((t) => {
        t.dispose();
      });
      this.transports = [];
      return;
    }

    if (this.context) {
      this.transports.push(new ChannelTransport(this.config));
      if (this.config.fileLoggingEnabled) {
        this.transports.push(new FileTransport(this.config, this.context));
      }
    }
  }

  public debug(message: string, context?: Record<string, unknown>) {
    this.log("DEBUG", message, context);
  }

  public info(message: string, context?: Record<string, unknown>) {
    this.log("INFO", message, context);
  }

  public warn(message: string, context?: Record<string, unknown>) {
    this.log("WARN", message, context);
  }

  private buildErrorContext(error: Error | undefined, context?: Record<string, unknown>): Record<string, unknown> {
    const errorContext = { ...context };
    if (error) {
      errorContext.error = {
        message: error.message,
        stack: error.stack,
      };
    }
    return errorContext;
  }

  public error(message: string, error?: Error, context?: Record<string, unknown>) {
    this.log("ERROR", message, this.buildErrorContext(error, context));
  }

  public fatal(message: string, error?: Error, context?: Record<string, unknown>) {
    this.log("FATAL", message, this.buildErrorContext(error, context));
    vscode.window.showErrorMessage(`A fatal error occurred in Angular Auto Import: ${message}. See logs for details.`);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>) {
    if (!this.config) {
      this.config = getLoggerConfig();
    }

    const isDev = this.context?.extensionMode === vscode.ExtensionMode.Development;
    const effectiveLevel = isDev ? "DEBUG" : this.config.level;

    if (!this.config.enabled || this.getLogLevelValue(level) < this.getLogLevelValue(effectiveLevel)) {
      return;
    }

    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
      metadata: this.getMetadata(isDev),
    };

    this.transports.forEach((transport) => {
      Promise.resolve()
        .then(() => transport.log(logEntry))
        .catch(console.error);
    });
  }

  private getMetadata(isDev: boolean): LogEntry["metadata"] {
    const metadata: LogEntry["metadata"] = {
      sessionId: this.sessionId,
      extensionVersion: this.extensionVersion,
      vscodeVersion: vscode.version,
      platform: os.platform(),
      nodeVersion: process.version,
    };

    if (isDev) {
      const { fileName, lineNumber } = this.getCallerLocation();
      metadata.fileName = fileName;
      metadata.lineNumber = lineNumber;
    }

    return metadata;
  }

  private getCallerLocation(): { fileName?: string; lineNumber?: number } {
    const error = new Error();
    const stack = error.stack?.split("\n");

    if (stack && stack.length > 4) {
      const callerLine = stack[4];
      if (callerLine) {
        const match = callerLine.match(/(?:at\s.*?\s)?\(?(.*?):(\d+):\d+\)?$/);
        if (match?.[1] && match[2]) {
          const filePath = this.anonymizeFilePath(match[1]);
          return { fileName: filePath, lineNumber: Number.parseInt(match[2], 10) };
        }
      }
    }
    return {};
  }

  private anonymizeFilePath(filePath: string): string {
    const homeDir = os.homedir();
    if (filePath.startsWith(homeDir)) {
      return filePath.replace(homeDir, "~");
    }
    if (this.context) {
      for (const folder of vscode.workspace.workspaceFolders || []) {
        const workspacePath = folder.uri.fsPath;
        if (filePath.startsWith(workspacePath)) {
          return path.join(`\${workspaceRoot}`, path.relative(workspacePath, filePath));
        }
      }
    }
    return filePath;
  }

  public startTimer(name: string) {
    if (!this.config.enabled) {
      return;
    }
    this.logPoints.set(name, { name, startTime: Date.now() });
  }

  public stopTimer(name: string) {
    if (!this.config.enabled) {
      return;
    }
    const logPoint = this.logPoints.get(name);
    if (logPoint) {
      const duration = Date.now() - logPoint.startTime;
      this.info(`Execution time for '${name}': ${duration}ms`);
      this.logPoints.delete(name);
    } else {
      this.warn(`Timer with name '${name}' was stopped but never started.`);
    }
  }

  public getPerformanceMetrics(): PerformanceMetrics {
    return {
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
    };
  }

  public logException(error: Error, context?: Record<string, unknown>) {
    this.fatal("An unhandled exception occurred", error, context);
  }

  /**
   * The extension's output channel, once logging has been initialized.
   *
   * The language client writes the server's forwarded logs here too, so everything the
   * extension has to say arrives in one place.
   */
  public get channel(): vscode.LogOutputChannel | undefined {
    return this.transports.find((t): t is ChannelTransport => t instanceof ChannelTransport)?.channel;
  }

  /** Shows the Output Channel panel and selects the Angular Auto Import channel. */
  public showChannel(): void {
    const channelTransport = this.transports.find((t): t is ChannelTransport => t instanceof ChannelTransport);
    channelTransport?.show();
  }

  public dispose() {
    this.transports.forEach((transport) => {
      transport.dispose();
    });
    this.transports = [];
    this.logPoints.clear();
  }
}
