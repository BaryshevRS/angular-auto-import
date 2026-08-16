/**
 * Manages extension settings and configuration.
 *
 * This module provides utilities for reading and monitoring VS Code extension settings,
 * specifically for the Angular Auto-Import extension configuration.
 *
 * @module
 */
import * as vscode from "vscode";
import { DEFAULT_EXTENSION_CONFIG, type ExtensionConfig } from "../core/settings";

export type { ExtensionConfig } from "../core/settings";

/**
 * Retrieves the current extension configuration from VS Code settings.
 *
 * Reads all Angular Auto-Import related settings from the VS Code configuration
 * and returns them as a structured configuration object with appropriate defaults.
 *
 * @returns The current extension configuration with all settings
 *
 * @example
 * ```typescript
 * const config = getConfiguration();
 * if (config.diagnosticsEnabled) {
 *   // Enable diagnostics features
 * }
 * ```
 */
export function getConfiguration(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration("angular-auto-import");
  const defaults = DEFAULT_EXTENSION_CONFIG;

  return {
    projectPath: config.get<string | null>("projectPath", defaults.projectPath),
    indexRefreshInterval: config.get<number>("index.refreshInterval", defaults.indexRefreshInterval),
    completion: {
      pipes: config.get<boolean>("completion.pipes.enabled", defaults.completion.pipes),
      components: config.get<boolean>("completion.components.enabled", defaults.completion.components),
      directives: config.get<boolean>("completion.directives.enabled", defaults.completion.directives),
    },
    diagnosticsMode: config.get<string>("diagnostics.mode", defaults.diagnosticsMode),
    diagnosticsSeverity: config.get<string>("diagnostics.severity", defaults.diagnosticsSeverity),
    logging: {
      enabled: config.get<boolean>("logging.enabled", defaults.logging.enabled),
      level: config.get<string>("logging.level", defaults.logging.level),
      fileLoggingEnabled: config.get<boolean>("logging.fileLoggingEnabled", defaults.logging.fileLoggingEnabled),
      logDirectory: config.get<string | null>("logging.logDirectory", defaults.logging.logDirectory),
      rotationMaxSize: config.get<number>("logging.rotationMaxSize", defaults.logging.rotationMaxSize),
      rotationMaxFiles: config.get<number>("logging.rotationMaxFiles", defaults.logging.rotationMaxFiles),
      outputFormat: config.get<string>("logging.outputFormat", defaults.logging.outputFormat),
    },
  };
}

/**
 * Registers a callback to be invoked when Angular Auto-Import configuration changes.
 *
 * This function sets up a configuration change listener that will call the provided
 * callback whenever any Angular Auto-Import settings are modified by the user.
 *
 * @param callback - Function to call when configuration changes, receives the new configuration
 * @returns A disposable that can be used to unregister the listener
 *
 * @example
 * ```typescript
 * const disposable = onConfigurationChanged((newConfig) => {
 *   console.log('Configuration updated:', newConfig);
 *   // Update extension behavior based on new config
 * });
 *
 * // Later, to stop listening:
 * disposable.dispose();
 * ```
 */
export function onConfigurationChanged(callback: (config: ExtensionConfig) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("angular-auto-import")) {
      callback(getConfiguration());
    }
  });
}
