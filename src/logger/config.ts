import * as vscode from "vscode";
import type { LoggerConfig, LogLevel, LogOutputFormat } from "./types";

export function getLoggerConfig(): LoggerConfig {
  const config = vscode.workspace.getConfiguration("angular-auto-import.logging");

  return {
    enabled: config.get<boolean>("enabled", true),
    level: config.get<LogLevel>("level", "INFO"),
    outputFormat: config.get<LogOutputFormat>("outputFormat", "plain"),
  };
}
