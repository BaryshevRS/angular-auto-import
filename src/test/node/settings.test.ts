import * as assert from "node:assert";
import { DEFAULT_EXTENSION_CONFIG, resolveExtensionConfig } from "../../core/settings";

describe("Extension settings", () => {
  it("returns the defaults for anything that is not an object", () => {
    for (const input of [undefined, null, "settings", 42, []]) {
      assert.deepStrictEqual(resolveExtensionConfig(input), DEFAULT_EXTENSION_CONFIG, `input: ${String(input)}`);
    }
  });

  it("keeps the values a host supplied", () => {
    const config = resolveExtensionConfig({
      projectPath: "/workspace/app",
      indexRefreshInterval: 0,
      completion: { pipes: false, components: false, directives: false },
      diagnosticsMode: "quickfix-only",
      diagnosticsSeverity: "error",
      logging: {
        enabled: false,
        level: "DEBUG",
        fileLoggingEnabled: true,
        logDirectory: "/tmp/logs",
        rotationMaxSize: 10,
        rotationMaxFiles: 3,
        outputFormat: "json",
      },
    });

    assert.strictEqual(config.projectPath, "/workspace/app");
    assert.strictEqual(config.indexRefreshInterval, 0);
    assert.deepStrictEqual(config.completion, { pipes: false, components: false, directives: false });
    assert.strictEqual(config.diagnosticsMode, "quickfix-only");
    assert.strictEqual(config.logging.logDirectory, "/tmp/logs");
    assert.strictEqual(config.logging.rotationMaxFiles, 3);
  });

  it("fills in only the settings that are missing", () => {
    const config = resolveExtensionConfig({ diagnosticsMode: "disabled", logging: { level: "ERROR" } });

    assert.strictEqual(config.diagnosticsMode, "disabled");
    assert.strictEqual(config.logging.level, "ERROR");
    assert.strictEqual(config.logging.enabled, DEFAULT_EXTENSION_CONFIG.logging.enabled);
    assert.strictEqual(config.diagnosticsSeverity, DEFAULT_EXTENSION_CONFIG.diagnosticsSeverity);
  });

  it("rejects values of the wrong type instead of trusting the wire", () => {
    const config = resolveExtensionConfig({
      indexRefreshInterval: "60",
      completion: { pipes: "yes" },
      diagnosticsSeverity: 3,
      logging: { rotationMaxSize: Number.NaN, logDirectory: 7 },
    });

    assert.strictEqual(config.indexRefreshInterval, DEFAULT_EXTENSION_CONFIG.indexRefreshInterval);
    assert.strictEqual(config.completion.pipes, DEFAULT_EXTENSION_CONFIG.completion.pipes);
    assert.strictEqual(config.diagnosticsSeverity, DEFAULT_EXTENSION_CONFIG.diagnosticsSeverity);
    assert.strictEqual(config.logging.rotationMaxSize, DEFAULT_EXTENSION_CONFIG.logging.rotationMaxSize);
    assert.strictEqual(config.logging.logDirectory, DEFAULT_EXTENSION_CONFIG.logging.logDirectory);
  });

  it("keeps an explicit null for the settings that allow one", () => {
    const config = resolveExtensionConfig({ projectPath: null, logging: { logDirectory: null } });

    assert.strictEqual(config.projectPath, null);
    assert.strictEqual(config.logging.logDirectory, null);
  });

  it("does not let a caller mutate the shared defaults", () => {
    const config = resolveExtensionConfig({});
    config.completion.pipes = false;

    assert.strictEqual(DEFAULT_EXTENSION_CONFIG.completion.pipes, true);
  });
});
