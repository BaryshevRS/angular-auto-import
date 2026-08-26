import * as assert from "node:assert";
import { DEFAULT_EXTENSION_CONFIG } from "../../core/settings";
import { type LogSink, ServerLogging } from "../../lsp/server-logging";

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      log: (message) => lines.push(`log|${message}`),
      info: (message) => lines.push(`info|${message}`),
      warn: (message) => lines.push(`warn|${message}`),
      error: (message) => lines.push(`error|${message}`),
    },
  };
}

function loggingConfig(overrides: Partial<(typeof DEFAULT_EXTENSION_CONFIG)["logging"]> = {}) {
  return { ...DEFAULT_EXTENSION_CONFIG.logging, ...overrides };
}

describe("LSP server logging", () => {
  it("sends each level to the matching client channel", () => {
    const { sink, lines } = recordingSink();
    const logger = new ServerLogging(sink, loggingConfig({ level: "DEBUG" })).logger;

    logger.debug("scanning");
    logger.info("indexed");
    logger.warn("stale cache");
    logger.error("failed", new Error("boom"));

    assert.deepStrictEqual(
      lines.map((line) => line.split("|")[0]),
      ["log", "info", "warn", "error"]
    );
  });

  it("filters out everything below the configured level", () => {
    const { sink, lines } = recordingSink();
    const logger = new ServerLogging(sink, loggingConfig({ level: "WARN" })).logger;

    logger.debug("scanning");
    logger.info("indexed");
    logger.warn("stale cache");

    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /stale cache/);
  });

  it("says nothing at all when logging is disabled", () => {
    const { sink, lines } = recordingSink();
    const logger = new ServerLogging(sink, loggingConfig({ enabled: false, level: "DEBUG" })).logger;

    logger.error("failed", new Error("boom"));

    assert.deepStrictEqual(lines, []);
  });

  it("follows a settings change without being rebuilt", () => {
    const { sink, lines } = recordingSink();
    const logging = new ServerLogging(sink, loggingConfig({ level: "ERROR" }));
    const logger = logging.logger;

    logger.info("before");
    logging.configure(loggingConfig({ level: "INFO" }));
    logger.info("after");

    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /after/);
  });

  it("formats a plain line with a timestamp, level, and source", () => {
    const { sink, lines } = recordingSink();
    new ServerLogging(sink, loggingConfig()).logger.info("indexed 12 elements");

    assert.match(lines[0], /^info\|\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]\[INFO\]\[server\] indexed 12 elements$/);
  });

  it("includes the error and the context in a plain line", () => {
    const { sink, lines } = recordingSink();
    new ServerLogging(sink, loggingConfig()).logger.error("index failed", new Error("boom"), { root: "/workspace" });

    assert.match(lines[0], /index failed/);
    assert.match(lines[0], /boom/);
    assert.match(lines[0], /"root":"\/workspace"/);
  });

  it("emits one JSON object per entry when the user asked for json", () => {
    const { sink, lines } = recordingSink();
    new ServerLogging(sink, loggingConfig({ outputFormat: "json" })).logger.warn("stale cache", { root: "/workspace" });

    const entry = JSON.parse(lines[0].slice("warn|".length));
    assert.strictEqual(entry.level, "WARN");
    assert.strictEqual(entry.source, "server");
    assert.strictEqual(entry.message, "stale cache");
    assert.deepStrictEqual(entry.context, { root: "/workspace" });
  });

  it("treats the host-only FATAL level as ERROR and an unknown level as the default", () => {
    const { sink, lines } = recordingSink();
    const logging = new ServerLogging(sink, loggingConfig({ level: "FATAL" }));
    const logger = logging.logger;

    logger.warn("dropped");
    logger.error("kept");
    logging.configure(loggingConfig({ level: "LOUD" }));
    logger.info("kept too");

    assert.deepStrictEqual(
      lines.map((line) => line.split("] ")[1]),
      ["kept", "kept too"]
    );
  });

  it("still reports timings through the configured level", () => {
    const { sink, lines } = recordingSink();
    const logger = new ServerLogging(sink, loggingConfig()).logger;

    logger.startTimer("full index");
    logger.stopTimer("full index");

    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /Execution time for 'full index'/);
  });
});
