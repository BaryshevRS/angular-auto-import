/**
 * The extension's settings, as a shape both hosts agree on.
 *
 * The Extension Host reads these from `workspace.getConfiguration`; the language
 * server receives the same object over the protocol. Defaults and coercion live
 * here so a value that arrives over JSON-RPC is validated exactly like a value read
 * from VS Code.
 * @module
 */

/** Configuration for the Angular Auto-Import extension. */
export interface ExtensionConfig {
  /** Path to a specific Angular project; `null` auto-detects projects in the workspace. */
  projectPath: string | null;
  /** Minutes between automatic index refreshes; `0` disables it. */
  indexRefreshInterval: number;
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
    fileLoggingEnabled: boolean;
    logDirectory: string | null;
    rotationMaxSize: number;
    rotationMaxFiles: number;
    outputFormat: string;
  };
}

/** What every setting falls back to when it is absent or unusable. */
export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
  projectPath: null,
  indexRefreshInterval: 60,
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
    fileLoggingEnabled: false,
    logDirectory: null,
    rotationMaxSize: 5,
    rotationMaxFiles: 5,
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
  const logging = asRecord(source.logging);
  const defaults = DEFAULT_EXTENSION_CONFIG;

  return {
    projectPath: nullableString(source.projectPath, defaults.projectPath),
    indexRefreshInterval: number(source.indexRefreshInterval, defaults.indexRefreshInterval),
    completion: {
      pipes: boolean(completion.pipes, defaults.completion.pipes),
      components: boolean(completion.components, defaults.completion.components),
      directives: boolean(completion.directives, defaults.completion.directives),
    },
    diagnosticsMode: string(source.diagnosticsMode, defaults.diagnosticsMode),
    diagnosticsSeverity: string(source.diagnosticsSeverity, defaults.diagnosticsSeverity),
    logging: {
      enabled: boolean(logging.enabled, defaults.logging.enabled),
      level: string(logging.level, defaults.logging.level),
      fileLoggingEnabled: boolean(logging.fileLoggingEnabled, defaults.logging.fileLoggingEnabled),
      logDirectory: nullableString(logging.logDirectory, defaults.logging.logDirectory),
      rotationMaxSize: number(logging.rotationMaxSize, defaults.logging.rotationMaxSize),
      rotationMaxFiles: number(logging.rotationMaxFiles, defaults.logging.rotationMaxFiles),
      outputFormat: string(logging.outputFormat, defaults.logging.outputFormat),
    },
  };
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
function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** @internal */
function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
