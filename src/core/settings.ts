/**
 * The extension's settings, as a shape both hosts agree on.
 *
 * What arrives is the editor's configuration section, exactly as the editor hands it
 * out: nested by the dots in the setting names, with a lone boolean under an `enabled`
 * of its own. That is not a choice — it is what `workspace/configuration` answers with
 * whenever a user changes a setting, and it has to be what the handshake sends too, or
 * the two paths disagree and the second one silently wins with defaults.
 *
 * Defaults and coercion live here so a value that arrives over JSON-RPC is validated
 * exactly like a value read from VS Code.
 * @module
 */

/** How project-local module specifiers are selected. Mirrors TypeScript's preference names. */
export type ImportModuleSpecifierPreference = "shortest" | "relative" | "non-relative" | "project-relative";

/** Configuration for the Angular Auto-Import extension. */
export interface ExtensionConfig {
  /** Path to a specific Angular project; `null` auto-detects projects in the workspace. */
  projectPath: string | null;
  /** How imports of indexed project elements are written. */
  importModuleSpecifier: ImportModuleSpecifierPreference;
  completion: {
    pipes: boolean;
    components: boolean;
    directives: boolean;
  };
  /** `full`, `quickfix-only`, or `disabled`. */
  diagnosticsMode: string;
  /** `error`, `warning`, `information`, or `hint`. */
  diagnosticsSeverity: string;
  logging: {
    enabled: boolean;
    level: string;
    outputFormat: string;
  };
}

/** What every setting falls back to when it is absent or unusable. */
export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  projectPath: null,
  importModuleSpecifier: "shortest",
  completion: {
    pipes: true,
    components: true,
    directives: true,
  },
  diagnosticsMode: "full",
  diagnosticsSeverity: "warning",
  logging: {
    enabled: true,
    level: "INFO",
    outputFormat: "plain",
  },
};

/**
 * Builds a complete configuration from whatever a host supplied, filling in defaults
 * for anything missing or of the wrong type.
 * @param raw The settings object as received; any shape is tolerated.
 */
export function resolveExtensionConfig(raw: unknown): ExtensionConfig {
  const source = asRecord(raw);
  const completion = asRecord(source.completion);
  const diagnostics = asRecord(source.diagnostics);
  const logging = asRecord(source.logging);
  const defaults = DEFAULT_EXTENSION_CONFIG;

  return {
    projectPath: nullableString(source.projectPath, defaults.projectPath),
    importModuleSpecifier: importModuleSpecifier(source.importModuleSpecifier, defaults.importModuleSpecifier),
    completion: {
      pipes: enabled(completion.pipes, defaults.completion.pipes),
      components: enabled(completion.components, defaults.completion.components),
      directives: enabled(completion.directives, defaults.completion.directives),
    },
    diagnosticsMode: string(diagnostics.mode, defaults.diagnosticsMode),
    diagnosticsSeverity: string(diagnostics.severity, defaults.diagnosticsSeverity),
    logging: {
      enabled: boolean(logging.enabled, defaults.logging.enabled),
      level: string(logging.level, defaults.logging.level),
      outputFormat: string(logging.outputFormat, defaults.logging.outputFormat),
    },
  };
}

/** @internal */
function importModuleSpecifier(
  value: unknown,
  fallback: ImportModuleSpecifierPreference
): ImportModuleSpecifierPreference {
  return value === "shortest" || value === "relative" || value === "non-relative" || value === "project-relative"
    ? value
    : fallback;
}

/** @internal */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** @internal */
function string(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** @internal */
function nullableString(value: unknown, fallback: string | null): string | null {
  if (value === null || typeof value === "string") {
    return value;
  }
  return fallback;
}

/** @internal */
function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Reads a group whose only member is `enabled`, which is how a setting named
 * `completion.pipes.enabled` reaches us: as an object, never as a bare boolean.
 * @internal
 */
function enabled(value: unknown, fallback: boolean): boolean {
  return boolean(asRecord(value).enabled, fallback);
}
