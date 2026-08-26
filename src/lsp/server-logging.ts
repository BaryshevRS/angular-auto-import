/**
 * The server's log output.
 *
 * Server logs reach the user through `window/logMessage`, which the language client
 * appends to its output channel. Level filtering and formatting are the user's
 * existing `angular-auto-import.logging` settings, so one channel of logs does not
 * suddenly behave differently from the other.
 * @module
 */

import { type InstrumentedLogger, withInstrumentation } from "../core/logging";
import type { ExtensionConfig } from "../core/settings";

/** Where a formatted line goes; the subset of `connection.console` the server uses. */
export interface LogSink {
  log(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_ORDER = new Map<Level, number>([
  ["DEBUG", 0],
  ["INFO", 1],
  ["WARN", 2],
  ["ERROR", 3],
]);

/** @internal */
function levelValue(level: Level): number {
  return LEVEL_ORDER.get(level) ?? 1;
}

/** Filters and formats the server's logs, following the user's logging settings. */
export class ServerLogging {
  private readonly sink: LogSink;
  private enabled: boolean;
  private threshold: number;
  private asJson: boolean;

  constructor(sink: LogSink, config?: ExtensionConfig["logging"]) {
    this.sink = sink;
    this.enabled = true;
    this.threshold = levelValue("INFO");
    this.asJson = false;
    if (config) {
      this.configure(config);
    }
  }

  /**
   * Applies the user's logging settings, at startup and whenever they change.
   * @param config The `logging` section of the resolved configuration.
   */
  configure(config: ExtensionConfig["logging"]): void {
    this.enabled = config.enabled;
    this.threshold = levelValue(normalizeLevel(config.level));
    this.asJson = config.outputFormat === "json";
  }

  /** The logger the server and its runtimes report through. */
  get logger(): InstrumentedLogger {
    return withInstrumentation({
      debug: (message, context) => this.write("DEBUG", message, context),
      info: (message, context) => this.write("INFO", message, context),
      warn: (message, context) => this.write("WARN", message, context),
      error: (message, error, context) => this.write("ERROR", message, context, error),
    });
  }

  /**
   * Writes one entry, unless the user's settings filter it out.
   * @internal
   */
  private write(level: Level, message: string, context?: Record<string, unknown>, error?: Error): void {
    if (!this.enabled || levelValue(level) < this.threshold) {
      return;
    }

    const line = this.asJson ? this.formatJson(level, message, context, error) : format(level, message, context, error);
    if (level === "ERROR") {
      this.sink.error(line);
    } else if (level === "WARN") {
      this.sink.warn(line);
    } else if (level === "INFO") {
      this.sink.info(line);
    } else {
      this.sink.log(line);
    }
  }

  /** @internal */
  private formatJson(level: Level, message: string, context?: Record<string, unknown>, error?: Error): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      source: "server",
      message,
      context,
      error: error && { message: error.message, stack: error.stack },
    });
  }
}

/**
 * Formats one entry the way the Extension Host's output channel does.
 * @internal
 */
function format(level: Level, message: string, context?: Record<string, unknown>, error?: Error): string {
  const parts = [`[${new Date().toISOString()}][${level}][server] ${message}`];
  if (error) {
    parts.push(`  ${error.stack ?? error.message}`);
  }
  if (context && Object.keys(context).length > 0) {
    parts.push(`  Context: ${safeStringify(context)}`);
  }
  return parts.join("\n");
}

/** @internal */
function safeStringify(context: Record<string, unknown>): string {
  try {
    return JSON.stringify(context);
  } catch (error) {
    return `[could not stringify context: ${(error as Error).message}]`;
  }
}

/**
 * Accepts the levels the settings allow, mapping the host-only `FATAL` onto `ERROR`
 * and anything unrecognized onto the default.
 * @internal
 */
function normalizeLevel(level: string): Level {
  const upper = level.toUpperCase();
  if (upper === "FATAL") {
    return "ERROR";
  }
  return LEVEL_ORDER.has(upper as Level) ? (upper as Level) : "INFO";
}
