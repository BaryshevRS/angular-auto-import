/**
 * Reading the settings section.
 *
 * Every case here supplies what the editor supplies: the section nested by the dots in
 * the setting names, with a lone boolean under an `enabled` of its own. Written any
 * other way these pass while the extension ignores everything a user changes, which is
 * exactly what happened for as long as they were.
 * @module
 */

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
      importModuleSpecifier: "relative",
      completion: {
        pipes: { enabled: false },
        components: { enabled: false },
        directives: { enabled: false },
      },
      diagnostics: { mode: "quickfix-only", severity: "error" },
      logging: { enabled: false, level: "DEBUG", outputFormat: "json" },
    });

    assert.strictEqual(config.projectPath, "/workspace/app");
    assert.strictEqual(config.importModuleSpecifier, "relative");
    assert.deepStrictEqual(config.completion, { pipes: false, components: false, directives: false });
    assert.strictEqual(config.diagnosticsMode, "quickfix-only");
    assert.strictEqual(config.diagnosticsSeverity, "error");
    assert.deepStrictEqual(config.logging, { enabled: false, level: "DEBUG", outputFormat: "json" });
  });

  it("fills in only the settings that are missing", () => {
    const config = resolveExtensionConfig({ diagnostics: { mode: "disabled" }, logging: { level: "ERROR" } });

    assert.strictEqual(config.diagnosticsMode, "disabled");
    assert.strictEqual(config.logging.level, "ERROR");
    assert.strictEqual(config.logging.enabled, DEFAULT_EXTENSION_CONFIG.logging.enabled);
    assert.strictEqual(config.diagnosticsSeverity, DEFAULT_EXTENSION_CONFIG.diagnosticsSeverity);
  });

  it("rejects values of the wrong type instead of trusting the wire", () => {
    const config = resolveExtensionConfig({
      // A bare boolean is the shape this parser used to expect, and the one the editor
      // never sends: it belongs among the values that are refused, not honoured.
      completion: { pipes: true, components: { enabled: "yes" } },
      diagnostics: { mode: 1, severity: 3 },
      logging: { enabled: "yes", level: 7 },
      importModuleSpecifier: "absolute",
    });

    assert.strictEqual(config.completion.pipes, DEFAULT_EXTENSION_CONFIG.completion.pipes);
    assert.strictEqual(config.completion.components, DEFAULT_EXTENSION_CONFIG.completion.components);
    assert.strictEqual(config.diagnosticsMode, DEFAULT_EXTENSION_CONFIG.diagnosticsMode);
    assert.strictEqual(config.diagnosticsSeverity, DEFAULT_EXTENSION_CONFIG.diagnosticsSeverity);
    assert.strictEqual(config.logging.enabled, DEFAULT_EXTENSION_CONFIG.logging.enabled);
    assert.strictEqual(config.logging.level, DEFAULT_EXTENSION_CONFIG.logging.level);
    assert.strictEqual(config.importModuleSpecifier, DEFAULT_EXTENSION_CONFIG.importModuleSpecifier);
  });

  it("keeps an explicit null for the one setting that allows it", () => {
    const config = resolveExtensionConfig({ projectPath: null });

    assert.strictEqual(config.projectPath, null);
  });

  it("does not let a caller mutate the shared defaults", () => {
    const config = resolveExtensionConfig({});
    config.completion.pipes = false;

    assert.strictEqual(DEFAULT_EXTENSION_CONFIG.completion.pipes, true);
  });
});
